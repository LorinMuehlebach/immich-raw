"""Looks for new uploads every few minutes and culls them once a batch has finished uploading.

An Immich workflow with a Webhook step can wake it early; polling stays the safety net.
"""

from __future__ import annotations

import logging
import threading
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Any

from culler.config import WatcherConfig
from culler.immich import ImmichClient, ImmichError
from culler.models import parse_time
from culler.runner import BASE_FILTER
from culler.store import Store

log = logging.getLogger(__name__)

CHECKPOINT = "watch.since"


class Watcher:
    def __init__(
        self,
        cfg: WatcherConfig,
        client: ImmichClient,
        store: Store,
        submit: Callable[[dict[str, Any], bool], str],
        now: Callable[[], datetime] = lambda: datetime.now(UTC),
    ):
        self.cfg = cfg
        self.client = client
        self.store = store
        self.submit = submit
        self.now = now
        self._wake = threading.Event()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self.last_check: str | None = None
        self.last_error: str | None = None

    @property
    def enabled(self) -> bool:
        stored = self.store.get("watch.enabled")
        return self.cfg.enabled if stored is None else stored == "1"

    @property
    def auto_apply(self) -> bool:
        stored = self.store.get("watch.autoApply")
        return self.cfg.auto_apply if stored is None else stored == "1"

    def set(self, enabled: bool | None = None, auto_apply: bool | None = None) -> None:
        if enabled is not None:
            self.store.set("watch.enabled", "1" if enabled else "0")
        if auto_apply is not None:
            self.store.set("watch.autoApply", "1" if auto_apply else "0")
        self.wake()

    def state(self) -> dict[str, Any]:
        return {
            "enabled": self.enabled,
            "autoApply": self.auto_apply,
            "intervalSeconds": self.cfg.interval_s,
            "quietSeconds": self.cfg.quiet_s,
            "since": self.store.get(CHECKPOINT),
            "lastCheck": self.last_check,
            "lastError": self.last_error,
        }

    def start(self) -> None:
        if self.store.get(CHECKPOINT) is None:
            # First start: only photos uploaded from now on. Older ones can be culled on demand.
            self.store.set(CHECKPOINT, _iso(self.now()))
        self._thread = threading.Thread(target=self._loop, name="watcher", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._wake.set()
        if self._thread and self._thread is not threading.current_thread():
            self._thread.join(timeout=30)

    def wake(self) -> None:
        self._wake.set()

    def _loop(self) -> None:
        while not self._stop.is_set():
            if self.enabled:
                try:
                    self.check()
                    self.last_error = None
                except ImmichError as e:
                    self.last_error = str(e)
                    log.warning("watcher: %s", e)
                except Exception as e:  # keep watching whatever happens
                    self.last_error = str(e)
                    log.exception("watcher failed")
            self._wake.wait(self.cfg.interval_s)
            self._wake.clear()

    def check(self) -> str | None:
        """Starts a run for a finished upload batch; returns its id."""
        self.last_check = _iso(self.now())
        since = self.store.get(CHECKPOINT) or _iso(self.now())
        new = list(self.client.search({**BASE_FILTER, "createdAt": {"gt": since}}, with_exif=False))
        if not new:
            return None
        latest = max(parse_time(a["createdAt"]) for a in new)
        quiet = self.now() - latest
        if quiet < timedelta(seconds=self.cfg.quiet_s):
            return None  # still uploading
        until = _iso(latest)
        photos = [a for a in new if not a["originalFileName"].lower().endswith(".edit.jpg")]  # not editor renders
        if not photos:
            self.store.set(CHECKPOINT, until)
            return None
        waiting = [a for a in photos if not a.get("thumbhash")]
        if waiting and quiet < timedelta(seconds=self.cfg.preview_timeout_s):
            return None  # Immich is still making previews
        run_id = self.submit({"kind": "uploads", "since": since, "until": until}, not self.auto_apply)
        self.store.set(CHECKPOINT, until)
        log.info("watcher: %d new photos, run %s", len(photos), run_id)
        return run_id


def _iso(t: datetime) -> str:
    return t.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")
