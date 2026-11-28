"""SQLite state in the data volume: feature cache, runs, what was applied, and undo snapshots."""

from __future__ import annotations

import json
import sqlite3
import threading
from collections.abc import Iterable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import numpy as np

from culler.models import Features, PickInfo
from culler.planner import AppliedGroup, AssetState

MIGRATIONS = [
    """
    CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE features (
        asset_id TEXT PRIMARY KEY, cache_key TEXT NOT NULL, thumbhash TEXT, json TEXT NOT NULL, embedding BLOB);
    CREATE TABLE runs (
        id TEXT PRIMARY KEY, origin TEXT NOT NULL, scope TEXT NOT NULL, options TEXT, dry_run INTEGER NOT NULL,
        status TEXT NOT NULL, phase TEXT, done INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL DEFAULT 0,
        summary TEXT, report TEXT, error TEXT, created_at TEXT NOT NULL, finished_at TEXT, undone_at TEXT,
        undo_report TEXT, source_run TEXT);
    CREATE TABLE groups (
        id TEXT PRIMARY KEY, frame_ids TEXT NOT NULL, best_frame TEXT NOT NULL, primary_id TEXT NOT NULL,
        stacked INTEGER NOT NULL, state TEXT NOT NULL, run_id TEXT, updated_at TEXT NOT NULL);
    CREATE TABLE frames (
        id TEXT PRIMARY KEY, asset_ids TEXT NOT NULL, group_id TEXT, pinned INTEGER NOT NULL DEFAULT 0, excluded TEXT);
    CREATE INDEX frames_group ON frames(group_id);
    CREATE TABLE assets (id TEXT PRIMARY KEY, group_id TEXT NOT NULL, state TEXT NOT NULL);
    CREATE INDEX assets_group ON assets(group_id);
    CREATE TABLE snapshots (
        run_id TEXT PRIMARY KEY, before TEXT NOT NULL, after TEXT NOT NULL, group_primary TEXT NOT NULL,
        asset_ids TEXT NOT NULL);
    """,
    # Runs that also regroup stacks the user took apart: applying such a preview does the same.
    "ALTER TABLE runs ADD COLUMN force INTEGER NOT NULL DEFAULT 0",
    # The user's own edits of the stacks: shots taken out of a stack, shots added to one (the frame
    # ids of that stack when they were added), stored on the run (so applying a preview does them
    # too) and in the undo snapshot.
    """
    ALTER TABLE runs ADD COLUMN edits TEXT;
    ALTER TABLE frames ADD COLUMN joined TEXT;
    ALTER TABLE snapshots ADD COLUMN frames TEXT
    """,
    # The groups as they were before a run changed them, so undo puts back a stack's shots too.
    "ALTER TABLE snapshots ADD COLUMN groups TEXT",
    # Groups where the user chose another best than the culler would have (see models.PickInfo).
    """
    CREATE TABLE picks (
        group_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, at TEXT NOT NULL, json TEXT NOT NULL)
    """,
]

GROUP_COLUMNS = ("frame_ids", "best_frame", "primary_id", "stacked", "state", "run_id")

FrameFlags = tuple[str | None, list[str] | None]  # (excluded reason, joined stack frame ids)


def utcnow() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


def _chunks(items: list[str], n: int = 500) -> Iterable[list[str]]:
    for i in range(0, len(items), n):
        yield items[i : i + n]


class Store:
    def __init__(self, path: Path | str):
        if str(path) != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(str(path), check_same_thread=False, isolation_level=None)
        self._db.row_factory = sqlite3.Row
        self._lock = threading.RLock()
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.execute("PRAGMA busy_timeout=5000")
        self._migrate()

    def _migrate(self) -> None:
        with self._lock:
            version = self._db.execute("PRAGMA user_version").fetchone()[0]
            for i, sql in enumerate(MIGRATIONS[version:], start=version + 1):
                self._db.executescript(f"BEGIN; {sql}; PRAGMA user_version={i}; COMMIT;")

    def close(self) -> None:
        with self._lock:  # never under a query running on another thread
            self._db.close()

    def _q(self, sql: str, args: tuple | list = ()) -> list[sqlite3.Row]:
        with self._lock:
            return self._db.execute(sql, args).fetchall()

    def _x(self, sql: str, args: tuple | list = ()) -> None:
        with self._lock:
            self._db.execute(sql, args)

    def transaction(self):
        store = self

        class _Tx:
            def __enter__(self):
                store._lock.acquire()
                store._db.execute("BEGIN")

            def __exit__(self, exc_type, *_):
                store._db.execute("ROLLBACK" if exc_type else "COMMIT")
                store._lock.release()

        return _Tx()

    # --- key/value ----------------------------------------------------------------------------------
    def get(self, key: str, default: str | None = None) -> str | None:
        rows = self._q("SELECT value FROM kv WHERE key = ?", (key,))
        return rows[0]["value"] if rows else default

    def set(self, key: str, value: str) -> None:
        self._x(
            "INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, value),
        )

    # --- feature cache --------------------------------------------------------------------------------
    def features(self, asset_id: str, cache_key: str, thumbhash: str | None) -> Features | None:
        rows = self._q("SELECT * FROM features WHERE asset_id = ?", (asset_id,))
        if not rows or rows[0]["cache_key"] != cache_key or rows[0]["thumbhash"] != thumbhash:
            return None
        blob = rows[0]["embedding"]
        emb = np.frombuffer(blob, dtype=np.float32).copy() if blob else None
        return Features.from_json(json.loads(rows[0]["json"]), emb)

    def put_features(self, f: Features, cache_key: str, thumbhash: str | None) -> None:
        blob = f.embedding.astype(np.float32).tobytes() if f.embedding is not None else None
        self._x(
            "INSERT OR REPLACE INTO features(asset_id, cache_key, thumbhash, json, embedding) VALUES(?, ?, ?, ?, ?)",
            (f.asset_id, cache_key, thumbhash, json.dumps(f.to_json()), blob),
        )

    # --- runs -------------------------------------------------------------------------------------------
    def create_run(
        self,
        run_id: str,
        origin: str,
        scope: dict,
        options: dict | None,
        dry_run: bool,
        source_run: str | None = None,
        force: bool = False,
        edits: dict | None = None,
    ) -> None:
        self._x(
            "INSERT INTO runs(id, origin, scope, options, dry_run, status, created_at, source_run, force, edits) "
            "VALUES(?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)",
            (
                run_id,
                origin,
                json.dumps(scope),
                json.dumps(options) if options else None,
                int(dry_run),
                utcnow(),
                source_run,
                int(force),
                json.dumps(edits) if edits else None,
            ),
        )

    def update_run(self, run_id: str, **fields: Any) -> None:
        cols, vals = [], []
        for k, v in fields.items():
            cols.append(f"{k} = ?")
            vals.append(json.dumps(v) if isinstance(v, (dict, list)) else v)
        self._x(f"UPDATE runs SET {', '.join(cols)} WHERE id = ?", (*vals, run_id))

    def run(self, run_id: str) -> dict | None:
        rows = self._q("SELECT * FROM runs WHERE id = ?", (run_id,))
        return _run_row(rows[0]) if rows else None

    def runs(self, limit: int = 20) -> list[dict]:
        rows = self._q("SELECT * FROM runs ORDER BY created_at DESC, rowid DESC LIMIT ?", (limit,))
        return [_run_row(r, with_report=False) for r in rows]

    def fail_unfinished_runs(self) -> None:
        """Runs that were going when the service stopped can't resume."""
        self._x(
            "UPDATE runs SET status = 'failed', error = 'the service restarted' WHERE status IN ('queued', 'running')"
        )

    # --- applied state ------------------------------------------------------------------------------------
    def asset_states(self, ids: Iterable[str]) -> dict[str, AssetState]:
        out: dict[str, AssetState] = {}
        for chunk in _chunks(list(ids)):
            marks = ",".join("?" * len(chunk))
            for r in self._q(f"SELECT id, state FROM assets WHERE id IN ({marks})", chunk):
                out[r["id"]] = AssetState.from_json(json.loads(r["state"]))
        return out

    def asset_ids_of_groups(self, group_ids: Iterable[str]) -> set[str]:
        out: set[str] = set()
        for chunk in _chunks(list(group_ids)):
            marks = ",".join("?" * len(chunk))
            out.update(r["id"] for r in self._q(f"SELECT id FROM assets WHERE group_id IN ({marks})", chunk))
        return out

    def set_asset_states(self, states: dict[str, AssetState | None]) -> None:
        for a, s in states.items():
            if s is None:
                self._x("DELETE FROM assets WHERE id = ?", (a,))
            else:
                self._x(
                    "INSERT OR REPLACE INTO assets(id, group_id, state) VALUES(?, ?, ?)",
                    (a, s.group_id, json.dumps(s.to_json())),
                )

    def frame_rows(self, frame_ids: Iterable[str]) -> dict[str, sqlite3.Row]:
        out = {}
        for chunk in _chunks(list(frame_ids)):
            marks = ",".join("?" * len(chunk))
            out.update({r["id"]: r for r in self._q(f"SELECT * FROM frames WHERE id IN ({marks})", chunk)})
        return out

    def frame_assets(self, frame_ids: Iterable[str]) -> dict[str, tuple[str, ...]]:
        return {fid: tuple(json.loads(r["asset_ids"])) for fid, r in self.frame_rows(frame_ids).items()}

    def save_frame(self, frame_id: str, asset_ids: tuple[str, ...], group_id: str | None) -> None:
        self._x(
            "INSERT INTO frames(id, asset_ids, group_id) VALUES(?, ?, ?) "
            "ON CONFLICT(id) DO UPDATE SET asset_ids = excluded.asset_ids, group_id = excluded.group_id",
            (frame_id, json.dumps(list(asset_ids)), group_id),
        )

    def set_pin(self, group_id: str, frame_id: str | None) -> None:
        self._x("UPDATE frames SET pinned = 0 WHERE group_id = ?", (group_id,))
        if frame_id:
            self._x("UPDATE frames SET pinned = 1, group_id = ? WHERE id = ?", (group_id, frame_id))

    def set_excluded(self, frame_ids: Iterable[str], reason: str | None) -> None:
        """Leave these shots alone from now on (`reason`), or not any more (None). Taking a shot out
        of a stack also ends where the user had added it, and its pin."""
        extra = ", joined = NULL, pinned = 0" if reason is not None else ""
        for fid in frame_ids:
            self._x(
                "INSERT INTO frames(id, asset_ids, excluded) VALUES(?, '[]', ?) "
                f"ON CONFLICT(id) DO UPDATE SET excluded = ?{extra}",
                (fid, reason, reason),
            )

    def set_joined(self, frame_id: str, stack_frame_ids: list[str]) -> None:
        """The user added this shot to the stack of these shots: it stays there."""
        self._x(
            "INSERT INTO frames(id, asset_ids, joined) VALUES(?, '[]', ?) "
            "ON CONFLICT(id) DO UPDATE SET joined = ?, excluded = NULL, pinned = 0",
            (frame_id, json.dumps(stack_frame_ids), json.dumps(stack_frame_ids)),
        )

    def frame_flags(self, frame_ids: Iterable[str]) -> dict[str, FrameFlags]:
        """Excluded reason and joined stack of these shots (None, None when the store has no row)."""
        rows = self.frame_rows(frame_ids)
        return {
            fid: (r["excluded"], json.loads(r["joined"]) if r["joined"] else None)
            if (r := rows.get(fid))
            else (None, None)
            for fid in frame_ids
        }

    def set_frame_flags(self, flags: dict[str, FrameFlags]) -> None:
        """Sets both flags as given (a shot taken out of a stack, or added to one, loses its pin)."""
        for fid, (excluded, joined) in flags.items():
            joined_json = json.dumps(joined) if joined else None
            unpin = ", pinned = 0" if excluded is not None or joined else ""
            self._x(
                "INSERT INTO frames(id, asset_ids, excluded, joined) VALUES(?, '[]', ?, ?) "
                f"ON CONFLICT(id) DO UPDATE SET excluded = ?, joined = ?{unpin}",
                (fid, excluded, joined_json, excluded, joined_json),
            )

    def groups_by_ids(self, group_ids: Iterable[str]) -> dict[str, sqlite3.Row]:
        out = {}
        for chunk in _chunks(list(group_ids)):
            marks = ",".join("?" * len(chunk))
            out.update({r["id"]: r for r in self._q(f"SELECT * FROM groups WHERE id IN ({marks})", chunk)})
        return out

    def applied_groups(self, group_ids: Iterable[str]) -> list[AppliedGroup]:
        return [
            AppliedGroup(
                r["id"], tuple(json.loads(r["frame_ids"])), r["best_frame"], r["primary_id"], bool(r["stacked"])
            )
            for r in self.groups_by_ids(group_ids).values()
            if r["state"] == "active"
        ]

    def save_group(
        self, gid: str, frame_ids: list[str], best: str, primary: str, run_id: str, state: str = "active"
    ) -> None:
        self._x(
            "INSERT OR REPLACE INTO groups(id, frame_ids, best_frame, primary_id, stacked, state, run_id, updated_at) "
            "VALUES(?, ?, ?, ?, 1, ?, ?, ?)",
            (gid, json.dumps(frame_ids), best, primary, state, run_id, utcnow()),
        )

    def set_group_state(self, gid: str, state: str) -> None:
        self._x("UPDATE groups SET state = ?, updated_at = ? WHERE id = ?", (state, utcnow(), gid))

    def group_rows(self, group_ids: Iterable[str]) -> dict[str, dict | None]:
        """The groups as stored (None: not stored yet), for the undo snapshot."""
        ids = list(group_ids)
        rows = self.groups_by_ids(ids)
        return {gid: {k: rows[gid][k] for k in GROUP_COLUMNS} if gid in rows else None for gid in ids}

    def restore_groups(self, groups: dict[str, dict | None]) -> None:
        """Puts back groups from `group_rows`; one that wasn't stored before is undone."""
        for gid, g in groups.items():
            if g is None:
                self.set_group_state(gid, "undone")
                continue
            self._x(
                "INSERT OR REPLACE INTO groups"
                "(id, frame_ids, best_frame, primary_id, stacked, state, run_id, updated_at) "
                "VALUES(?, ?, ?, ?, ?, ?, ?, ?)",
                (gid, *(g[k] for k in GROUP_COLUMNS), utcnow()),
            )

    # --- the user's picks ------------------------------------------------------------------------------
    def save_pick(self, group_id: str, run_id: str, pick: PickInfo) -> None:
        self._x(
            "INSERT OR REPLACE INTO picks(group_id, run_id, at, json) VALUES(?, ?, ?, ?)",
            (group_id, run_id, utcnow(), json.dumps(pick.to_json())),
        )

    def delete_picks(self, group_ids: Iterable[str]) -> None:
        for chunk in _chunks(list(group_ids)):
            self._x(f"DELETE FROM picks WHERE group_id IN ({','.join('?' * len(chunk))})", chunk)

    def delete_picks_of_run(self, run_id: str) -> None:
        self._x("DELETE FROM picks WHERE run_id = ?", (run_id,))

    def picks(self) -> list[dict]:
        """The user's picks in groups still stacked, newest first."""
        rows = self._q(
            "SELECT p.group_id, p.run_id, p.at, p.json FROM picks p JOIN groups g ON g.id = p.group_id "
            "WHERE g.state = 'active' ORDER BY p.at DESC"
        )
        return [{"groupId": r["group_id"], "runId": r["run_id"], "at": r["at"], **json.loads(r["json"])} for r in rows]

    def active_group_count(self) -> int:
        return self._q("SELECT COUNT(*) AS n FROM groups WHERE state = 'active'")[0]["n"]

    # --- snapshots (undo) -------------------------------------------------------------------------------
    def save_snapshot(
        self,
        run_id: str,
        before: dict,
        after: dict,
        group_primary: dict,
        asset_ids: list[str],
        frames: dict[str, FrameFlags] | None = None,
        groups: dict[str, dict | None] | None = None,
    ) -> None:
        """`frames`: the shots' flags before the run changed them (excluded, joined). `groups`: the
        groups it changed, as they were (`group_rows`)."""
        self._x(
            "INSERT OR REPLACE INTO snapshots(run_id, before, after, group_primary, asset_ids, frames, groups) "
            "VALUES(?, ?, ?, ?, ?, ?, ?)",
            (
                run_id,
                json.dumps(before),
                json.dumps(after),
                json.dumps(group_primary),
                json.dumps(sorted(asset_ids)),
                json.dumps(frames) if frames else None,
                json.dumps(groups) if groups is not None else None,
            ),
        )

    def snapshot(self, run_id: str) -> dict | None:
        rows = self._q("SELECT * FROM snapshots WHERE run_id = ?", (run_id,))
        if not rows:
            return None
        r = rows[0]
        return {
            "before": json.loads(r["before"]),
            "after": json.loads(r["after"]),
            "group_primary": json.loads(r["group_primary"]),
            "asset_ids": json.loads(r["asset_ids"]),
            "frames": {fid: (v[0], v[1]) for fid, v in json.loads(r["frames"]).items()} if r["frames"] else {},
            "groups": json.loads(r["groups"]) if r["groups"] is not None else None,  # None: an older snapshot
        }

    def later_runs_touching(self, run_id: str, asset_ids: set[str]) -> list[str]:
        """Applied, not undone runs after `run_id` that changed any of these photos."""
        created = self._q("SELECT created_at, rowid FROM runs WHERE id = ?", (run_id,))
        if not created:
            return []
        rows = self._q(
            "SELECT r.id, s.asset_ids FROM runs r JOIN snapshots s ON s.run_id = r.id "
            "WHERE r.undone_at IS NULL AND r.dry_run = 0 AND r.status = 'done' "
            "AND (r.created_at > ? OR (r.created_at = ? AND r.rowid > ?))",
            (created[0]["created_at"], created[0]["created_at"], created[0]["rowid"]),
        )
        return [r["id"] for r in rows if asset_ids & set(json.loads(r["asset_ids"]))]


def _run_row(r: sqlite3.Row, with_report: bool = True) -> dict:
    out = {
        "id": r["id"],
        "origin": r["origin"],
        "scope": json.loads(r["scope"]),
        "options": json.loads(r["options"]) if r["options"] else None,
        "dryRun": bool(r["dry_run"]),
        "force": bool(r["force"]),
        "edits": json.loads(r["edits"]) if r["edits"] else None,
        "status": r["status"],
        "phase": r["phase"],
        "done": r["done"],
        "total": r["total"],
        "summary": json.loads(r["summary"]) if r["summary"] else None,
        "error": r["error"],
        "createdAt": r["created_at"],
        "finishedAt": r["finished_at"],
        "undoneAt": r["undone_at"],
        "sourceRun": r["source_run"],
    }
    if with_report:
        out["report"] = json.loads(r["report"]) if r["report"] else None
        out["undoReport"] = json.loads(r["undo_report"]) if r["undo_report"] else None
    return out
