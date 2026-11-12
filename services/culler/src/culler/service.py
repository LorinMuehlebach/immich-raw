"""The running service: one worker thread does the runs one after another (the models are not
shared between threads), the watcher feeds it new uploads, the API only queues and reads."""

from __future__ import annotations

import logging
import queue
import threading
from collections.abc import Callable
from typing import Any

from culler.config import Config, run_overrides
from culler.features import Analyzer
from culler.immich import ImmichClient
from culler.runner import RunError, Runner, Scope, new_run_id
from culler.store import Store, utcnow
from culler.watcher import Watcher

log = logging.getLogger(__name__)


class Service:
    def __init__(
        self,
        cfg: Config,
        client: ImmichClient | None = None,
        store: Store | None = None,
        analyzer: Callable[[Config], Analyzer] | None = None,
    ):
        self.cfg = cfg
        self.client = client or ImmichClient(cfg.immich_url, cfg.api_key)
        self.store = store or Store(cfg.data_dir / "culler.sqlite")
        self.runner = Runner(cfg, self.client, self.store, analyzer or (lambda c: Analyzer(c)))
        self.owner_id: str | None = None
        self.owner_email: str | None = None
        self._jobs: queue.Queue = queue.Queue()
        self._worker = threading.Thread(target=self._work, name="worker", daemon=True)
        self.watcher = Watcher(
            cfg.watcher, self.client, self.store, lambda scope, dry: self.submit_run(scope, dry, None, "watcher")
        )

    def start(self, watch: bool = True) -> None:
        me = self.client.me()
        self.owner_id, self.owner_email = me["id"], me.get("email")
        known = self.store.get("owner")
        if known and known != self.owner_id:
            raise RuntimeError("the data volume belongs to another Immich user: use a new one for this API key")
        self.store.set("owner", self.owner_id)
        self.store.fail_unfinished_runs()
        self._worker.start()
        if watch:
            self.watcher.start()

    def stop(self) -> None:
        self.watcher.stop()
        self._jobs.put(None)

    # --- queueing -----------------------------------------------------------------------------------
    def submit_run(
        self,
        scope: dict[str, Any],
        dry_run: bool,
        options: dict | None,
        origin: str,
        force: bool = False,
        release: bool = False,
        source_run: str | None = None,
        before: Callable[[], None] | None = None,
        after: Callable[[], None] | None = None,
    ) -> str:
        parsed = Scope.from_json(scope)
        run_overrides(self.cfg, options)  # validate now, so the caller hears about bad options
        rid = new_run_id()
        self.store.create_run(rid, origin, parsed.to_json(), options, dry_run, source_run, force=force)
        self._jobs.put(("run", rid, parsed, dry_run, options, force, release, before, after))
        return rid

    def submit_apply(self, run_id: str) -> str:
        run = self._run_or_fail(run_id)
        if not run["dryRun"]:
            raise RunError("this run was already applied")
        return self.submit_run(run["scope"], False, run["options"], "apply", force=run["force"], source_run=run_id)

    def submit_undo(self, run_id: str) -> str:
        run = self._run_or_fail(run_id)
        if run["dryRun"] or run["status"] != "done":
            raise RunError("only finished, applied runs can be undone")
        if run["undoneAt"]:
            raise RunError("this run was already undone")
        rid = new_run_id()
        self.store.create_run(rid, "undo", run["scope"], None, False, source_run=run_id)
        self._jobs.put(("undo", rid, run_id))
        return rid

    def submit_best(self, group_id: str, asset_id: str) -> str:
        ids = self.runner.group_assets(group_id)
        if asset_id not in ids:
            raise RunError("that photo is not in this stack")
        return self.submit_run(
            {"kind": "assets", "ids": ids}, False, None, "pick", before=lambda: self.runner.pin(group_id, asset_id)
        )

    def submit_recull(self, group_id: str) -> str:
        return self.submit_run(
            {"kind": "assets", "ids": self.runner.group_assets(group_id)}, False, None, "recull", force=True
        )

    def submit_ungroup(self, group_id: str) -> str:
        ids = self.runner.group_assets(group_id)
        frames = {s.frame_id for s in self.store.asset_states(ids).values()}
        return self.submit_run(
            {"kind": "assets", "ids": ids},
            False,
            None,
            "ungroup",
            release=True,
            after=lambda: self.store.set_excluded(frames, "ungrouped"),
        )

    def _run_or_fail(self, run_id: str) -> dict:
        run = self.store.run(run_id)
        if not run:
            raise RunError("unknown run")
        return run

    # --- the worker ---------------------------------------------------------------------------------
    def _work(self) -> None:
        while True:
            job = self._jobs.get()
            if job is None:
                return
            rid = job[1]
            self.store.update_run(rid, status="running", phase="starting")

            def progress(phase: str, done: int, total: int, rid: str = rid) -> None:
                self.store.update_run(rid, phase=phase, done=done, total=total)

            try:
                if job[0] == "run":
                    _, _, scope, dry_run, options, force, release, before, after = job
                    if before:
                        before()
                    report = self.runner.run(
                        rid, scope, dry_run, options, force=force, release=release, progress=progress
                    )
                    if after:
                        after()
                else:
                    report = self.runner.undo(job[2])
                self.store.update_run(
                    rid, status="done", phase=None, report=report, summary=run_summary(report), finished_at=utcnow()
                )
            except Exception as e:
                log.exception("run %s failed", rid)
                self.store.update_run(rid, status="failed", phase=None, error=str(e), finished_at=utcnow())

    # --- reading --------------------------------------------------------------------------------------
    def lookup(self, ids: list[str]) -> dict[str, Any]:
        """What the filmstrip shows for each photo: its stack, role, reason and measurements."""
        out: dict[str, Any] = {}
        for aid, s in self.store.asset_states(ids).items():
            m = s.meta or {}
            out[aid] = {
                "groupId": s.group_id,
                "frameId": s.frame_id,
                "role": m.get("role"),
                "reason": m.get("reason"),
                "rank": m.get("rank"),
                "groupSize": m.get("groupSize"),
                "pinned": m.get("pinned", False),
                "metrics": m.get("metrics", {}),
                "runId": m.get("runId"),
            }
        return out

    def health(self) -> dict[str, Any]:
        return {
            "ok": self.owner_id is not None,
            "version": "0.1.0",
            "eyes": self.runner.eyes_available(),
            "people": self.runner.people_available(),
            "tagRoot": self.cfg.tags.root,
        }


def run_summary(report: dict[str, Any]) -> dict[str, Any]:
    if "counts" in report:
        return {**report["counts"], "errors": len(report.get("errors", []))}
    return {
        "changes": len(report.get("changes", [])),
        "errors": len(report.get("errors", [])),
        "notes": report.get("notes", []),
    }
