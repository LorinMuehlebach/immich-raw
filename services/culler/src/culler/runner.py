"""One run: find the photos in scope, measure them, group, rank, plan and (unless it's a dry run) apply.
Also undo of an applied run, and the user's "make this one the best"."""

from __future__ import annotations

import json
import logging
import os
import tempfile
import uuid
from collections import Counter, deque
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field, replace
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any

from culler.brackets import find_brackets
from culler.config import Config, run_overrides
from culler.executor import TAG_CHECKS, ExecResult, describe, execute, settle_tags, tag_assets_of
from culler.features import Analyzer
from culler.frames import build_frames
from culler.grouping import apply_joins, group_frames, split_chains
from culler.immich import ImmichClient, ImmichError
from culler.models import RENDER_KEY, Asset, Features, Frame, Stack, extension, parse_time
from culler.planner import (
    AssetState,
    Before,
    CreateStack,
    DesiredGroup,
    Live,
    PutMeta,
    SetRating,
    UpdatePrimary,
    culler_tags,
    detect_overrides,
    op_to_json,
    plan_changes,
    plan_undo,
    snapshot_before,
)
from culler.ranking import rank_brackets, rank_group
from culler.store import FrameFlags, Store, utcnow

log = logging.getLogger(__name__)

BASE_FILTER: dict[str, Any] = {
    "type": {"eq": "IMAGE"},
    "trashedAt": {"eq": None},
    "visibility": {"notIn": ["locked", "hidden"]},
}
DAY_MARGIN = timedelta(hours=14)  # local dates can be up to 14 h away from UTC
DOWNLOAD_AHEAD = 6

Progress = Callable[[str, int, int], None]


class RunError(Exception):
    pass


MAX_EDITS = 2000


@dataclass(frozen=True)
class Edits:
    """The user's own changes to the stacks (the auto-stack page): shots taken out of their stack,
    and shots added to the stack of other shots (by those shots' frame ids, which outlive a
    preview's fresh group ids)."""

    remove: frozenset[str] = frozenset()
    join: dict[str, tuple[str, ...]] = field(default_factory=dict)

    def __bool__(self) -> bool:
        return bool(self.remove or self.join)

    @classmethod
    def from_json(cls, d: Any) -> Edits:
        if d is None:
            return cls()
        if not isinstance(d, dict):
            raise ValueError("edits: expected an object")
        remove, join = d.get("remove", []), d.get("join", {})
        if not isinstance(remove, list) or len(remove) > MAX_EDITS or not all(isinstance(x, str) for x in remove):
            raise ValueError(f"edits.remove: expected up to {MAX_EDITS} frame ids")
        if (
            not isinstance(join, dict)
            or len(join) > MAX_EDITS
            or not all(
                isinstance(v, list) and 0 < len(v) <= MAX_EDITS and all(isinstance(x, str) for x in v)
                for v in join.values()
            )
        ):
            raise ValueError("edits.join: expected {frame id: [frame ids of the stack it joins]}")
        if set(remove) & set(join):
            raise ValueError("edits: a shot can't be taken out of a stack and added to one at once")
        if any(k in v for k, v in join.items()):
            raise ValueError("edits.join: a shot can't join a stack of itself")
        return cls(frozenset(remove), {k: tuple(dict.fromkeys(v)) for k, v in join.items()})

    def to_json(self) -> dict[str, Any] | None:
        if not self:
            return None
        return {"remove": sorted(self.remove), "join": {k: list(v) for k, v in sorted(self.join.items())}}


@dataclass(frozen=True)
class Scope:
    kind: str  # day | range | album | assets | uploads
    date: str | None = None
    start: str | None = None
    end: str | None = None
    album_id: str | None = None
    ids: tuple[str, ...] = ()
    since: str | None = None
    until: str | None = None

    @classmethod
    def from_json(cls, d: dict[str, Any]) -> Scope:
        if not isinstance(d, dict):
            raise ValueError("scope: expected an object")
        kind = d.get("kind")
        if kind == "day":
            date.fromisoformat(str(d.get("date")))
            return cls("day", date=str(d["date"]))
        if kind == "range":
            if not (parse_time(d.get("from")) and parse_time(d.get("to"))):
                raise ValueError("scope: range needs 'from' and 'to' timestamps")
            return cls("range", start=d["from"], end=d["to"])
        if kind == "album":
            if not isinstance(d.get("id"), str):
                raise ValueError("scope: album needs an 'id'")
            return cls("album", album_id=d["id"])
        if kind == "assets":
            ids = d.get("ids")
            if not isinstance(ids, list) or not ids or not all(isinstance(i, str) for i in ids):
                raise ValueError("scope: assets needs a list of 'ids'")
            return cls("assets", ids=tuple(ids))
        if kind == "uploads":
            if not parse_time(d.get("since")):
                raise ValueError("scope: uploads needs 'since'")
            return cls("uploads", since=d["since"], until=d.get("until"))
        raise ValueError("scope: kind must be day, range, album, assets or uploads")

    def to_json(self) -> dict[str, Any]:
        match self.kind:
            case "day":
                return {"kind": "day", "date": self.date}
            case "range":
                return {"kind": "range", "from": self.start, "to": self.end}
            case "album":
                return {"kind": "album", "id": self.album_id}
            case "assets":
                return {"kind": "assets", "ids": list(self.ids)}
            case _:
                return {"kind": "uploads", "since": self.since, "until": self.until}


def _iso(t: datetime) -> str:
    return t.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


@dataclass
class Loaded:
    live: Live
    render_sources: dict[str, str]
    scope_ids: set[str] = field(default_factory=set)


class Runner:
    tag_checks: tuple[float, ...] = TAG_CHECKS  # see executor.settle_tags

    def __init__(self, cfg: Config, client: ImmichClient, store: Store, analyzer: Callable[[Config], Analyzer]):
        self.cfg = cfg
        self.client = client
        self.store = store
        self._analyzer_factory = analyzer
        self._analyzers: dict[str, Analyzer] = {}

    def close(self) -> None:
        for a in self._analyzers.values():
            a.close()
        self._analyzers.clear()

    def eyes_available(self) -> bool | None:
        """None until the first run has loaded the models."""
        a = self._analyzers.get(repr(self.cfg.analysis_dict()))
        return a.eyes_available if a else None

    def people_available(self) -> bool | None:
        """None until the first run has loaded the models."""
        a = self._analyzers.get(repr(self.cfg.analysis_dict()))
        return a.people_available if a else None

    def analyzer(self, cfg: Config) -> Analyzer:
        key = repr(cfg.analysis_dict())
        if key not in self._analyzers:
            self._analyzers[key] = self._analyzer_factory(cfg)
        return self._analyzers[key]

    # --- finding photos -----------------------------------------------------------------------------------
    def _search(self, extra: dict[str, Any]) -> list[dict]:
        return list(self.client.search({**BASE_FILTER, **extra}))

    def collect(self, scope: Scope, cfg: Config) -> list[str]:
        match scope.kind:
            case "day":
                d = datetime.combine(date.fromisoformat(scope.date), datetime.min.time(), UTC)
                found = self._search(
                    {"takenAt": {"gte": _iso(d - DAY_MARGIN), "lte": _iso(d + timedelta(days=1) + DAY_MARGIN)}}
                )
                return [a["id"] for a in found if (a.get("localDateTime") or "")[:10] == scope.date]
            case "range":
                return [a["id"] for a in self._search({"takenAt": {"gte": scope.start, "lte": scope.end}})]
            case "album":
                return [a["id"] for a in self._search({"albumIds": {"any": [scope.album_id]}})]
            case "assets":
                return list(scope.ids)
            case "uploads":
                f: dict[str, Any] = {"gt": scope.since}
                if scope.until:
                    f["lte"] = scope.until
                uploaded = self._search({"createdAt": f})
                return sorted({a["id"] for a in uploaded} | self._neighbours(uploaded, cfg))
        raise RunError(f"unknown scope {scope.kind}")

    def _neighbours(self, uploaded: list[dict], cfg: Config) -> set[str]:
        """Photos taken around the new uploads, so a burst uploaded in parts is seen whole."""
        times = sorted(t for a in uploaded if (t := parse_time(a.get("fileCreatedAt"))))
        gap = timedelta(seconds=cfg.grouping.max_gap_s)
        windows: list[list[datetime]] = []
        for t in times:
            if windows and t - windows[-1][1] <= gap:
                windows[-1][1] = t
            else:
                windows.append([t, t])
        out: set[str] = set()
        for start, end in windows:
            out.update(a["id"] for a in self._search({"takenAt": {"gte": _iso(start - gap), "lte": _iso(end + gap)}}))
        return out

    def load(self, ids: set[str], tag_root: str) -> Loaded:
        """Full info for the photos, every member of their stacks, and where renders came from."""
        infos = self.client.assets(sorted(ids))
        stacks: dict[str, Stack] = {}
        pending = {d["stack"]["id"] for d in infos.values() if d.get("stack")}
        while pending:
            sid = pending.pop()
            try:
                s = self.client.stack(sid)
            except ImmichError:
                continue
            members = tuple(a["id"] for a in s["assets"] if not a.get("isTrashed"))
            stacks[sid] = Stack(sid, s["primaryAssetId"], members)
            missing = [m for m in members if m not in infos]
            if missing:
                more = self.client.assets(missing)
                infos.update(more)
                pending |= {d["stack"]["id"] for d in more.values() if d.get("stack")} - stacks.keys()
        assets = {}
        for d in infos.values():
            a = Asset.from_api(d)
            if a.type == "IMAGE" and not a.is_trashed and a.visibility not in ("locked", "hidden"):
                assets[a.id] = a
        render_sources = {}
        for a in assets.values():
            if a.is_render_name:
                src = (self.client.metadata(a.id).get(RENDER_KEY) or {}).get("sourceAssetId")
                if isinstance(src, str):
                    render_sources[a.id] = src
        stacks = {sid: replace(s, asset_ids=tuple(m for m in s.asset_ids if m in assets)) for sid, s in stacks.items()}
        return Loaded(Live(assets, stacks), render_sources, ids & assets.keys())

    # --- measuring ------------------------------------------------------------------------------------------
    def measure(
        self,
        frames: list[Frame],
        live: Live,
        cfg: Config,
        progress: Progress | None,
        linked: frozenset[str] | set[str] = frozenset(),
    ) -> tuple[dict[str, Features], list[str]]:
        """Features for frames that have a neighbour in time (others can't be stacked), and for the
        frames in `linked` (the user added them to a stack, or such a stack is theirs). Returns
        (features by frame id, frame ids still waiting for Immich's preview)."""
        analyzer = self.analyzer(cfg)
        jobs: list[tuple[Frame, Asset, str]] = []
        for chain in split_chains(frames, cfg.grouping):
            if len(chain) < 2 and not any(f.id in linked for f in chain):
                continue
            # The same kind of preview for every frame of a chain, so they compare fairly.
            if all(f.raw_id for f in chain):
                kind = "raw"
            elif all(f.jpeg_id for f in chain):
                kind = "jpeg"
            else:
                kind = "mixed"
            for f in chain:
                aid = (
                    f.raw_id
                    if kind == "raw"
                    else f.jpeg_id
                    if kind == "jpeg"
                    else (f.jpeg_id or f.raw_id or f.render_ids[0])
                )
                source = "raw" if aid == f.raw_id else "jpeg" if aid == f.jpeg_id else "render"
                jobs.append((f, live.assets[aid], source))

        out: dict[str, Features] = {}
        pending: list[str] = []
        # The frame, the photo measured, its kind, and an older measurement to bring up to date.
        todo: list[tuple[Frame, Asset, str, Features | None]] = []
        for f, a, source in jobs:
            if not a.thumbhash:
                pending.append(f.id)
                continue
            cached = self.store.features(a.id, analyzer.cache_key, a.thumbhash)
            if cached is not None:
                out[f.id] = cached
            else:
                todo.append((f, a, source, self.store.features(a.id, analyzer.upgradable_key, a.thumbhash)))

        raw_from_file = cfg.lighting.raw_source == "file"

        def fetch(a: Asset, source: str, preview_only: bool) -> tuple[bytes | None, Path | None]:
            """Immich's preview, and for RAW frames the RAW file (a temp file the caller deletes)."""
            try:
                data = self.client.thumbnail(a.id, "preview")
            except ImmichError as e:
                log.warning("preview of %s: %s", a.name, e)
                return None, None
            if source != "raw" or not raw_from_file or preview_only:
                return data, None
            fd, name = tempfile.mkstemp(prefix="culler-", suffix=extension(a.name))
            os.close(fd)
            path = Path(name)
            try:
                self.client.original(a.id, path)
            except ImmichError as e:
                log.warning("RAW file of %s: %s; measuring its preview", a.name, e)
                path.unlink(missing_ok=True)
                return data, None
            return data, path

        done = len(out)
        total = len(jobs) - len(pending)
        if progress:
            progress("measuring", done, total)
        with ThreadPoolExecutor(max_workers=4) as pool:
            queue: deque = deque()
            it = iter(todo)
            for job in it:
                queue.append((job, pool.submit(fetch, job[1], job[2], job[3] is not None)))
                if len(queue) >= DOWNLOAD_AHEAD:
                    break
            while queue:
                (f, a, source, old), fut = queue.popleft()
                nxt = next(it, None)
                if nxt:
                    queue.append((nxt, pool.submit(fetch, nxt[1], nxt[2], nxt[3] is not None)))
                data, raw_path = fut.result()
                try:
                    if data is not None and old is not None:
                        feats = analyzer.add_animals(old, data)
                        self.store.put_features(feats, analyzer.cache_key, a.thumbhash)
                        out[f.id] = feats
                    elif data is not None:
                        feats = analyzer.analyse(data, a.id, source, raw_path)
                        self.store.put_features(feats, analyzer.cache_key, a.thumbhash)
                        out[f.id] = feats
                except Exception:
                    log.exception("could not analyse %s", a.name)
                finally:
                    if raw_path:
                        raw_path.unlink(missing_ok=True)
                done += 1
                if progress:
                    progress("measuring", done, total)
        return out, pending

    # --- a run --------------------------------------------------------------------------------------------
    def run(
        self,
        run_id: str,
        scope: Scope,
        dry_run: bool,
        options: dict | None = None,
        force: bool = False,
        release: bool = False,
        progress: Progress | None = None,
        edits: Edits | None = None,
    ) -> dict[str, Any]:
        edits = edits or Edits()
        cfg = run_overrides(self.cfg, options)
        root = cfg.tags.root
        if progress:
            progress("finding photos", 0, 0)
        scope_ids = set(self.collect(scope, cfg))
        prev_scope = self.store.asset_states(scope_ids)
        # Whole groups: photos grouped before with any photo in scope come along.
        ids = scope_ids | self.store.asset_ids_of_groups({s.group_id for s in prev_scope.values()})
        loaded = self.load(ids, root)
        live = loaded.live
        prev = self.store.asset_states(live.assets)
        culler_stacks = {
            sid
            for sid, st in live.stacks.items()
            if any(m in prev or culler_tags(live.assets[m], root) for m in st.asset_ids)
        }
        fs = build_frames(list(live.assets.values()), live.stacks, loaded.render_sources, culler_stacks)
        frames_by_id = {f.id: f for f in fs.frames}

        # What the user changed in Immich since the last run.
        rows = self.store.frame_rows(frames_by_id)
        prev_group_ids = {r["group_id"] for r in rows.values() if r["group_id"]}
        applied = self.store.applied_groups(prev_group_ids)
        frame_assets = self.store.frame_assets({fid for g in applied for fid in g.frame_ids})
        overrides = detect_overrides(applied, frame_assets, live)
        for gid, fid in overrides.pins.items():
            self.store.set_pin(gid, fid)
        self.store.set_excluded(overrides.removed, "removed from the stack")
        for gid in overrides.dissolved:
            self.store.set_group_state(gid, "dissolved")
            group = self.store.groups_by_ids([gid]).get(gid)
            if group:
                self.store.set_excluded(json.loads(group["frame_ids"]), "stack deleted")
        rows = self.store.frame_rows(frames_by_id)
        stored_excluded = {fid for fid, r in rows.items() if r["excluded"]}
        # The user's own edits (the auto-stack page): shots taken out of their stack in this run, and
        # shots added to a stack, before (stored) or now (this run's win).
        removed = {fid for fid in edits.remove if fid in frames_by_id}
        joins: dict[str, tuple[str, ...]] = {}
        if not release:
            joins = {fid: tuple(json.loads(r["joined"])) for fid, r in rows.items() if r["joined"]}
            joins.update({fid: ts for fid, ts in edits.join.items() if fid in frames_by_id})
            for fid in removed:
                joins.pop(fid, None)
        ignored = [
            {"frameId": fid, "edit": kind, "why": "not among these photos"}
            for kind, fids in (("remove", edits.remove), ("join", edits.join.keys()))
            for fid in sorted(fids)
            if fid not in frames_by_id
        ]
        # Force includes the shots the user took apart (only applying it forgets that they did);
        # a shot the user added to a stack is never left alone, one taken out of it always is.
        taken_apart = set() if force else stored_excluded - joins.keys()
        excluded = taken_apart | removed
        active = [f for f in fs.frames if f.id not in excluded]

        placed: set[str] = set()
        brackets: list[set[str]] = []
        if release:
            groups: list[list[str]] = [[f.id] for f in active]
            features: dict[str, Features] = {}
            pending: list[str] = []
        else:
            linked = set(joins) | {t for ts in joins.values() for t in ts}
            features, pending = self.measure(active, live, cfg, progress, linked)
            measured = [f for f in active if f.id in features]
            emb = {fid: f.embedding for fid, f in features.items() if f.embedding is not None}
            # Exposure brackets are stacks of their own, kept out of the scenes' grouping.
            brackets = [set(s) for s in find_brackets(measured, features, cfg.brackets)]
            in_bracket = set().union(*brackets)
            groups = group_frames([f for f in measured if f.id not in in_bracket], emb, cfg.grouping)
            groups += [sorted(s, key=lambda fid: (frames_by_id[fid].taken, fid)) for s in brackets]
            groups.sort(key=lambda g: (frames_by_id[g[0]].taken, frames_by_id[g[0]].name))
            groups += [[f.id] for f in active if f.id not in features]
            groups, placed, unplaced = apply_joins(groups, joins, set(features))
            ignored += [
                {"frameId": fid, "edit": "join", "why": why}
                for fid, why in sorted(unplaced.items())
                if fid in edits.join
            ]

        if progress:
            progress("ranking", 0, 0)
        desired: list[DesiredGroup] = []
        used: set[str] = set()
        # Old groups whose shots now sit in more than one group (split into moments): a shot the
        # user put in front keeps its place in whichever of them it lands.
        spread = Counter(
            old for g in groups if len(g) > 1 for old in {rows[f]["group_id"] for f in g if f in rows} if old
        )
        for g in groups:
            if len(g) < 2:
                continue
            # Shots the user added don't vote: they may still carry the id of the stack they came from.
            counts = Counter(rows[f]["group_id"] for f in g if f in rows and rows[f]["group_id"] and f not in placed)
            gid = next((x for x, _ in counts.most_common() if x not in used), None) or str(uuid.uuid4())
            used.add(gid)
            pinned = next(
                (
                    f
                    for f in g
                    if f in rows
                    and rows[f]["pinned"]
                    and (rows[f]["group_id"] == gid or (f not in placed and spread[rows[f]["group_id"]] > 1))
                ),
                None,
            )
            group_frames_ = [frames_by_id[f] for f in g]
            # A group holding a bracket set stays a bracket, also with shots the user added to it.
            if any(s <= set(g) for s in brackets):
                result = rank_brackets(group_frames_, features, cfg, pinned=pinned)
            else:
                result = rank_group(group_frames_, features, cfg, pinned=pinned)
            desired.append(DesiredGroup(gid, [frames_by_id[f] for f in result.frame_ids], result))

        grouped = {f.id for g in desired for f in g.frames}
        # Shots taken out of their stack in this run leave it, like shots no longer in a group.
        released = [
            f
            for f in [*active, *(frames_by_id[fid] for fid in sorted(removed))]
            if f.id not in grouped and any(a in prev or culler_tags(live.assets[a], root) for a in f.asset_ids)
        ]
        plan = plan_changes(desired, released, live, prev, culler_stacks, root, run_id, utcnow())

        report = self._report(scope, dry_run, desired, released, fs, excluded, pending, features, plan, frames_by_id)
        report["counts"]["takenApart"] = len(taken_apart)
        for g in report["groups"]:
            for fr in g["frames"]:
                fr["joined"] = fr["frameId"] in placed
        pending_ids = set(pending)
        report["singles"] = [
            {
                "frameId": f.id,
                "name": f.name,
                "assetIds": list(f.asset_ids),
                "faceId": f.face_id,
                "taken": _iso(f.taken),
                "leftAlone": "removed from the stack"
                if f.id in removed
                else (rows[f.id]["excluded"] if f.id in taken_apart else None),
                "pending": f.id in pending_ids,
            }
            for f in sorted(fs.frames, key=lambda f: (f.taken, f.name))
            if f.id not in grouped
        ]
        report["edits"] = {"ignored": ignored}
        if dry_run:
            return report

        # The shots' own flags this run changes: force forgets what the user took apart, the edits
        # remember what they changed. Kept with the undo snapshot.
        new_flags: dict[str, FrameFlags] = {}
        if force:
            for fid in stored_excluded:
                new_flags[fid] = (None, json.loads(rows[fid]["joined"]) if rows[fid]["joined"] else None)
        for fid in removed:
            new_flags[fid] = ("removed from the stack", None)
        for fid, ts in edits.join.items():
            if fid in frames_by_id:
                new_flags[fid] = (None, list(ts))
        old_flags = self.store.frame_flags(new_flags)
        flags_before = {fid: old_flags[fid] for fid, v in new_flags.items() if old_flags[fid] != v}
        if not plan.ops and not plan.states and not flags_before:
            return report

        # Undo needs the photos this run changes, and every photo of a group whose stack it makes.
        stack_groups = {op.group_id for op in plan.ops if isinstance(op, (CreateStack, UpdatePrimary)) and op.group_id}
        touched = {a for op in plan.ops for a in _op_assets(op)}
        touched |= {a for g in desired if g.id in stack_groups for a in g.members}
        before = snapshot_before(touched, live, prev, root)
        on_progress = (lambda d, t: progress("applying", d, t)) if progress else None
        res = execute(self.client, plan.ops, progress=on_progress) if plan.ops else ExecResult()
        states = self._fix_failed(plan, res, prev)
        notes: list[str] = []
        if tagged := tag_assets_of(plan.ops):
            if progress:
                progress("checking tags", 0, 0)
            want = {a: set(s.tags) if (s := states.get(a)) else set() for a in tagged}
            notes = settle_tags(self.client, want, root, self.tag_checks)
        group_primary = dict(plan.group_primary)
        flag_assets = {a for fid in flags_before for a in frames_by_id[fid].asset_ids}
        gone = prev_group_ids - used
        saved = {g.id: ([f.id for f in g.frames], g.result.best, group_primary[g.id]) for g in desired}
        groups_before = {
            gid: row
            for gid, row in self.store.group_rows(set(saved) | gone).items()
            if row is None
            or row["state"] != ("gone" if gid in gone else "active")
            or (gid in saved and (json.loads(row["frame_ids"]), row["best_frame"], row["primary_id"]) != saved[gid])
        }
        with self.store.transaction():
            self.store.set_frame_flags({fid: new_flags[fid] for fid in flags_before})
            self.store.set_asset_states(states)
            for g in desired:
                self.store.save_group(g.id, [f.id for f in g.frames], g.result.best, group_primary[g.id], run_id)
                for f in g.frames:
                    self.store.save_frame(f.id, f.asset_ids, g.id)
                if g.result.pick:
                    self.store.save_pick(g.id, run_id, g.result.pick)
            self.store.delete_picks([g.id for g in desired if not g.result.pick] + sorted(gone))
            for f in released:
                self.store.save_frame(f.id, f.asset_ids, None)
            for gid in gone:
                self.store.set_group_state(gid, "gone")
            if touched or flags_before:  # a run that changed nothing has nothing to undo
                self.store.save_snapshot(
                    run_id,
                    {a: b.to_json() for a, b in before.items()},
                    {a: (states[a].to_json() if states.get(a) else None) for a in touched if a in states},
                    {gid: group_primary[gid] for gid in stack_groups},
                    sorted(touched | flag_assets),
                    flags_before,
                    groups_before,
                )
        report["errors"] = res.errors
        report["applied"] = res.done
        report["notes"] = notes
        return report

    @staticmethod
    def _fix_failed(plan, res, prev: dict[str, AssetState]) -> dict[str, AssetState | None]:
        """States as they really ended up when some operations failed, so the next run retries them."""
        states = dict(plan.states)
        failed = set(res.errors)
        if not failed:
            return states
        for op in plan.ops:
            if not any(e.startswith(describe(op)) for e in failed):
                continue
            if isinstance(op, SetRating) and op.rating == -1:
                for a in op.asset_ids:
                    if states.get(a):
                        states[a] = replace(states[a], rating_set=False)
            if isinstance(op, PutMeta):
                for a, _ in op.items:
                    if states.get(a):
                        old = prev.get(a)
                        states[a] = replace(states[a], meta=old.meta if old else None)
        return states

    def _report(self, scope, dry_run, desired, released, fs, excluded, pending, features, plan, frames_by_id) -> dict:
        rejected: Counter = Counter()
        runner_ups = 0
        groups = []
        for g in desired:
            frames = []
            for f in g.frames:
                r = g.result.results[f.id]
                if r.role == "rejected":
                    rejected[r.reason] += 1
                elif r.role == "runner-up":
                    runner_ups += 1
                feats = features.get(f.id)
                frames.append(
                    {
                        "frameId": f.id,
                        "name": f.name,
                        "assetIds": list(f.asset_ids),
                        "faceId": f.face_id,
                        "taken": _iso(f.taken),
                        "role": r.role,
                        "reason": r.reason,
                        "rank": r.rank,
                        "score": r.score,
                        "pinned": r.pinned,
                        "metrics": r.metrics,
                        "analysedAssetId": feats.asset_id if feats else None,
                        "exposureFrom": feats.exposure_source if feats else None,
                    }
                )
            groups.append(
                {
                    "id": g.id,
                    "primaryId": plan.group_primary.get(g.id),
                    "kind": g.result.kind,
                    "closeCall": g.result.close_call,
                    "frames": frames,
                }
            )
        ops = [op_to_json(op) for op in plan.ops]
        return {
            "scope": scope.to_json(),
            "dryRun": dry_run,
            "counts": {
                "photos": len(fs.frame_of),
                "frames": len(fs.frames),
                "groups": len(desired),
                "best": sum(1 for g in desired if g.result.kind == "burst"),
                "brackets": sum(1 for g in desired if g.result.kind == "bracket"),
                "closeCalls": sum(1 for g in desired if g.result.close_call),
                "runnerUps": runner_ups,
                "rejected": {k: rejected.get(k, 0) for k in ("lighting", "blur", "eyes")},
                "released": len(released),
                "pending": len(pending),
                "excluded": len(excluded) + len({fs.frame_of.get(a, a) for a in fs.excluded}),
                # Of those: shots whose stack the user took apart (a run with force includes them).
                "takenApart": len(excluded),
                "changes": len(ops),
            },
            "groups": groups,
            "pending": [frames_by_id[f].name for f in pending if f in frames_by_id],
            "changes": ops,
            "errors": [],
        }

    # --- undo -----------------------------------------------------------------------------------------------
    def undo(self, run_id: str) -> dict[str, Any]:
        run = self.store.run(run_id)
        snap = self.store.snapshot(run_id)
        if not run or run["dryRun"] or not snap:
            raise RunError("only applied runs can be undone")
        if run["undoneAt"]:
            raise RunError("this run was already undone")
        later = self.store.later_runs_touching(run_id, set(snap["asset_ids"]))
        if later:
            raise RunError(f"undo the later runs that changed the same photos first: {', '.join(later)}")
        root = self.cfg.tags.root
        before = {a: Before.from_json(v) for a, v in snap["before"].items()}
        after = {a: AssetState.from_json(v) if v else None for a, v in snap["after"].items()}
        ids = set(before) | set(after) | set(snap["group_primary"].values())
        live = self.load(ids, root).live
        ops, notes = plan_undo(before, after, snap["group_primary"], live, root)
        res = execute(self.client, ops)
        if tagged := tag_assets_of(ops):
            want = {a: set(b.tags) if (b := before.get(a)) else set() for a in tagged}
            notes += settle_tags(self.client, want, root, self.tag_checks)
        with self.store.transaction():
            self.store.set_frame_flags(snap["frames"])
            self.store.set_asset_states({a: b.state for a, b in before.items()})
            self.store.delete_picks_of_run(run_id)  # the next run finds them again
            for a, s in after.items():
                b = before.get(a)
                if s:
                    frame_assets = self.store.frame_assets([s.frame_id]).get(s.frame_id, ())
                    self.store.save_frame(s.frame_id, frame_assets, b.state.group_id if b and b.state else None)
            if snap["groups"] is not None:
                self.store.restore_groups(snap["groups"])
            else:  # an older snapshot, without the groups
                still_used = self.store.asset_ids_of_groups(snap["group_primary"])
                for gid in snap["group_primary"]:
                    members = {a for a, s in after.items() if s and s.group_id == gid}
                    if not (members & still_used):
                        self.store.set_group_state(gid, "undone")
        report = {"changes": [op_to_json(op) for op in ops], "applied": res.done, "errors": res.errors, "notes": notes}
        self.store.update_run(run_id, undone_at=utcnow(), undo_report=report)
        return report

    # --- the user's choice ------------------------------------------------------------------------------------
    def group_assets(self, group_id: str) -> list[str]:
        ids = sorted(self.store.asset_ids_of_groups([group_id]))
        if not ids:
            raise RunError("unknown group")
        return ids

    def pin(self, group_id: str, asset_id: str) -> None:
        ids = self.group_assets(group_id)
        if asset_id not in ids:
            raise RunError("that photo is not in this group")
        frame_id = self.store.asset_states([asset_id])[asset_id].frame_id
        self.store.set_pin(group_id, frame_id)


def _op_assets(op) -> list[str]:
    if hasattr(op, "asset_ids"):
        return list(op.asset_ids)
    if hasattr(op, "items"):
        return [a for a, _ in op.items]
    if hasattr(op, "primary_id"):
        return [op.primary_id]
    return []


def new_run_id() -> str:
    return datetime.now(UTC).strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:6]
