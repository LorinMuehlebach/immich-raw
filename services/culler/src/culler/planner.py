"""Turns ranked groups into Immich changes, and works out how to undo them. Pure, so it can be tested.

Immich facts this relies on (spikes/immich-api/cull-check.mjs, docs/spike-results.md):
- createStack(ids) makes ids[0] the primary and absorbs every stack whose *primary* is in ids. A
  non-primary passed without its stack's primary is moved and leaves its old stack behind, so
  only primaries of existing stacks are ever passed.
- A stack's primary can't be removed from it, and a stack left with one photo is not deleted.
  Groups that change shape therefore have their old stack deleted and a new one created.
- updateStack only accepts a primary that is already in the stack.

A re-run with nothing changed plans nothing.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field, replace
from typing import Any

from culler.models import APP_ID, Asset, Frame, GroupResult, Stack, manual_reject_tag

TAG_SUFFIX = {
    ("best", None): "Best",
    ("runner-up", None): "Runner-up",
    ("rejected", "lighting"): "Rejected/Lighting",
    ("rejected", "blur"): "Rejected/Blur",
    ("rejected", "eyes"): "Rejected/Eyes closed",
    ("bracket", None): "Bracket",
}
CLOSE_CALL = "Close call"  # on the best shot, next to its role's tag


def tag_value(root: str, role: str, reason: str | None) -> str:
    return f"{root}/{TAG_SUFFIX[(role, reason)]}"


def close_call_tag(root: str) -> str:
    return f"{root}/{CLOSE_CALL}"


def all_tag_values(root: str) -> list[str]:
    return [*(f"{root}/{s}" for s in TAG_SUFFIX.values()), close_call_tag(root)]


def wanted_tags(root: str, role: str, reason: str | None, close_call: bool) -> tuple[str, ...]:
    """The culler tags one photo should carry: its role's, and Close call on the best of a near-tie."""
    tags = [tag_value(root, role, reason)]
    if close_call and role == "best":
        tags.append(close_call_tag(root))
    return tuple(sorted(tags))


# --- operations ---------------------------------------------------------------------------------


@dataclass(frozen=True)
class DeleteStack:
    stack_id: str
    asset_ids: tuple[str, ...]


@dataclass(frozen=True)
class CreateStack:
    asset_ids: tuple[str, ...]  # first = primary
    group_id: str | None = None  # None: putting a single capture (RAW + JPEG) back together


@dataclass(frozen=True)
class UpdatePrimary:
    stack_id: str
    primary_id: str
    group_id: str


@dataclass(frozen=True)
class AddTag:
    value: str
    asset_ids: tuple[str, ...]


@dataclass(frozen=True)
class RemoveTag:
    value: str
    asset_ids: tuple[str, ...]


@dataclass(frozen=True)
class SetRating:
    rating: int | None
    asset_ids: tuple[str, ...]


@dataclass(frozen=True)
class PutMeta:
    items: tuple[tuple[str, Any], ...]


@dataclass(frozen=True)
class DeleteMeta:
    asset_ids: tuple[str, ...]


Op = DeleteStack | CreateStack | UpdatePrimary | AddTag | RemoveTag | SetRating | PutMeta | DeleteMeta
OP_ORDER = (DeleteStack, CreateStack, UpdatePrimary, RemoveTag, AddTag, SetRating, PutMeta, DeleteMeta)


def op_to_json(op: Op) -> dict[str, Any]:
    d: dict[str, Any] = {"op": type(op).__name__}
    for k, v in op.__dict__.items():
        d[k] = [list(x) if isinstance(x, tuple) else x for x in v] if isinstance(v, tuple) else v
    return d


def op_from_json(d: dict[str, Any]) -> Op:
    cls = {c.__name__: c for c in OP_ORDER}[d["op"]]
    kw = {k: v for k, v in d.items() if k != "op"}
    for k, v in kw.items():
        if isinstance(v, list):
            kw[k] = tuple(tuple(x) if isinstance(x, list) else x for x in v)
    return cls(**kw)


# --- state --------------------------------------------------------------------------------------


@dataclass(frozen=True)
class AssetState:
    """What this service last applied to one photo (kept in the store)."""

    group_id: str
    frame_id: str
    tags: tuple[str, ...]  # the culler tags it should carry
    rating_set: bool  # the -1 on this photo was set by this service
    rating_blocked: bool  # the user changed a -1 this service set: never set it again
    meta: dict[str, Any] | None
    capture_stacked: bool = False  # its RAW + JPEG were stacked before this service grouped them
    reject_blocked: bool = False  # the user took a reject tag of this service off: never reject it again

    def to_json(self) -> dict[str, Any]:
        d = dict(self.__dict__)
        d["tags"] = list(self.tags)
        return d

    @classmethod
    def from_json(cls, d: dict[str, Any]) -> AssetState:
        d = dict(d)
        if "tag" in d:  # stored before a photo could carry more than one culler tag
            tag = d.pop("tag")
            d.setdefault("tags", [tag] if tag else [])
        d["tags"] = tuple(d.get("tags") or ())
        return cls(**d)


@dataclass
class Live:
    assets: dict[str, Asset]
    stacks: dict[str, Stack]

    def stack_of(self, asset_id: str) -> Stack | None:
        a = self.assets.get(asset_id)
        return self.stacks.get(a.stack.id) if a and a.stack else None


@dataclass
class DesiredGroup:
    id: str
    frames: list[Frame]
    result: GroupResult

    @property
    def best_frame(self) -> Frame:
        return next(f for f in self.frames if f.id == self.result.best)

    @property
    def members(self) -> set[str]:
        return {a for f in self.frames for a in f.asset_ids}


@dataclass
class Plan:
    ops: list[Op]
    states: dict[str, AssetState | None]  # per photo after applying; None = no longer managed
    group_primary: dict[str, str] = field(default_factory=dict)

    @property
    def empty(self) -> bool:
        return not self.ops


def _comparable(meta: dict[str, Any] | None) -> dict[str, Any] | None:
    return {k: v for k, v in meta.items() if k not in ("runId", "at")} if meta else None


def culler_tags(a: Asset, root: str) -> set[str]:
    """The tags this service manages on a photo: those under the root, except the user's own reject."""
    prefix = root + "/"
    own = manual_reject_tag(root)
    return {t.value for t in a.tags if t.value.startswith(prefix) and t.value != own}


def reject_taken_off(p: AssetState | None, asset: Asset | None, root: str) -> bool:
    """The user took a reject tag this service had put on the photo off (in Immich, or with U in the editor)."""
    if p is None or asset is None:
        return False
    if p.reject_blocked:
        return True
    have = culler_tags(asset, root)
    prefix = f"{root}/Rejected/"
    return any(t.startswith(prefix) and t not in have for t in p.tags)


def plan_changes(
    desired: list[DesiredGroup],
    released: list[Frame],
    live: Live,
    prev: dict[str, AssetState],
    culler_stack_ids: set[str],
    tag_root: str,
    run_id: str,
    now: str,
) -> Plan:
    """`desired`: groups of two or more frames. `released`: frames this service managed before that
    are no longer in a group. `prev`: what was applied before, per photo."""
    deletes: dict[str, DeleteStack] = {}
    restores: list[CreateStack] = []
    group_ops: list[Op] = []
    group_primary: dict[str, str] = {}

    def dissolve(st: Stack) -> None:
        deletes.setdefault(st.id, DeleteStack(st.id, st.asset_ids))

    # 1. Stacks for the groups.
    for g in desired:
        members = g.members
        best = g.best_frame
        primary = best.face_id
        touched = {live.stack_of(a).id: live.stack_of(a) for a in members if live.stack_of(a)}
        if len(touched) == 1:
            (t,) = touched.values()
            if set(t.asset_ids) == members:
                keep = t.primary_id in best.asset_ids  # e.g. the user put the RAW of the best frame in front
                if not keep:
                    group_ops.append(UpdatePrimary(t.id, primary, g.id))
                group_primary[g.id] = t.primary_id if keep else primary
                continue
        ids = [primary]
        for st in touched.values():
            if set(st.asset_ids) <= members:
                ids.append(st.primary_id)
            elif st.id in culler_stack_ids:
                dissolve(st)
                ids.extend(a for a in st.asset_ids if a in members)
            # Any other stack can't reach here: frames.py leaves the user's own stacks out.
        ids.extend(sorted(a for a in members if live.stack_of(a) is None))
        group_ops.append(CreateStack(tuple(dict.fromkeys(ids)), g.id))
        group_primary[g.id] = primary

    # 2. Released frames: take their culler stack apart, put RAW + JPEG back together.
    for f in released:
        for a in f.asset_ids:
            st = live.stack_of(a)
            if st and st.id in culler_stack_ids:
                dissolve(st)  # also when only this frame is left in it (the others were trashed)
    for f in released:
        if len(f.asset_ids) < 2 or not any(prev.get(a) and prev[a].capture_stacked for a in f.asset_ids):
            continue
        stacks = {live.stack_of(a).id if live.stack_of(a) else None for a in f.asset_ids}
        now_loose = all(s is None or s in deletes for s in stacks)
        if now_loose:
            restores.append(CreateStack((f.face_id, *sorted(a for a in f.asset_ids if a != f.face_id))))

    # 3. Tags, reject flags and metadata.
    add: dict[str, list[str]] = defaultdict(list)
    remove: dict[str, list[str]] = defaultdict(list)
    ratings: dict[int | None, list[str]] = defaultdict(list)
    put_meta: list[tuple[str, Any]] = []
    delete_meta: list[str] = []
    states: dict[str, AssetState | None] = {}

    for g in desired:
        size = len(g.frames)
        for f in g.frames:
            own = live.stack_of(f.asset_ids[0])
            was_capture = bool(own and own.id not in culler_stack_ids and set(own.asset_ids) <= set(f.asset_ids))
            r = g.result.results[f.id]
            # A reject the user took off stays off: the shot counts as a runner-up from then on.
            unrejected = any(reject_taken_off(prev.get(a), live.assets.get(a), tag_root) for a in f.asset_ids)
            if unrejected and r.role == "rejected":
                r = replace(r, role="runner-up", reason=None)
            want = wanted_tags(tag_root, r.role, r.reason, g.result.close_call)
            meta = {
                "v": 1,
                "app": APP_ID,
                "runId": run_id,
                "groupId": g.id,
                "frameId": f.id,
                "role": r.role,
                "reason": r.reason,
                "rank": r.rank,
                "groupSize": size,
                "pinned": r.pinned,
                "closeCall": g.result.close_call,
                "margin": g.result.margin,
                "metrics": r.metrics,
                "at": now,
            }
            for a in f.asset_ids:
                asset = live.assets[a]
                have = culler_tags(asset, tag_root)
                for v in sorted(have - set(want)):
                    remove[v].append(a)
                for v in sorted(set(want) - have):
                    add[v].append(a)

                p = prev.get(a)
                rating_set = bool(p and p.rating_set)
                blocked = bool(p and p.rating_blocked)
                # Immich 3.4 empties a -1 again when it re-reads the photo's metadata (it only
                # accepts ratings 1-5 there). An emptied flag is not retried; stars are the user's.
                dropped = rating_set and asset.rating is None
                if rating_set and asset.rating not in (None, -1):
                    rating_set, blocked = False, True
                if r.role == "rejected":
                    if asset.rating is None and not (
                        dropped or blocked or f.favorite or f.starred or asset.is_favorite
                    ):
                        ratings[-1].append(a)
                        rating_set = True
                elif rating_set:
                    if asset.rating == -1:
                        ratings[None].append(a)
                    rating_set = False

                if p is None or _comparable(p.meta) != _comparable(meta):
                    put_meta.append((a, meta))
                    stored_meta = meta
                else:
                    stored_meta = p.meta
                captured = p.capture_stacked if p else was_capture
                states[a] = AssetState(g.id, f.id, want, rating_set, blocked, stored_meta, captured, unrejected)

    for f in released:
        for a in f.asset_ids:
            asset = live.assets.get(a)
            if asset is None:
                continue
            for v in sorted(culler_tags(asset, tag_root)):
                remove[v].append(a)
            p = prev.get(a)
            if p and p.rating_set and asset.rating == -1:
                ratings[None].append(a)
            if p is None or p.meta is not None:
                delete_meta.append(a)
            states[a] = None

    ops: list[Op] = [*deletes.values(), *restores, *group_ops]
    ops += [RemoveTag(v, tuple(ids)) for v, ids in sorted(remove.items())]
    ops += [AddTag(v, tuple(ids)) for v, ids in sorted(add.items())]
    ops += [SetRating(r, tuple(ids)) for r, ids in sorted(ratings.items(), key=lambda kv: str(kv[0]))]
    if put_meta:
        ops.append(PutMeta(tuple(put_meta)))
    if delete_meta:
        ops.append(DeleteMeta(tuple(delete_meta)))
    return Plan(ops=ops, states=states, group_primary=group_primary)


# --- user overrides -------------------------------------------------------------------------------


@dataclass
class Overrides:
    pins: dict[str, str] = field(default_factory=dict)  # group id -> frame id the user put in front
    removed: set[str] = field(default_factory=set)  # frame ids the user took out of a stack
    dissolved: set[str] = field(default_factory=set)  # group ids whose stack the user deleted


@dataclass(frozen=True)
class AppliedGroup:
    id: str
    frame_ids: tuple[str, ...]
    best_frame: str
    primary_id: str
    stacked: bool


def detect_overrides(groups: list[AppliedGroup], frame_assets: dict[str, tuple[str, ...]], live: Live) -> Overrides:
    """Compares what was applied with what Immich shows now. `frame_assets`: frame id -> its photos."""
    out = Overrides()
    for g in groups:
        if not g.stacked:
            continue
        frame_of = {a: fid for fid in g.frame_ids for a in frame_assets.get(fid, ())}
        existing = {fid for a, fid in frame_of.items() if a in live.assets}
        if len(existing) < 2:
            continue  # photos were trashed: the group shrinks, nothing the user said about stacking
        counts: dict[str, int] = defaultdict(int)
        for a in frame_of:
            st = live.stack_of(a)
            if st:
                counts[st.id] += 1
        frames_in = {
            sid: {frame_of[a] for a in live.stacks[sid].asset_ids if a in frame_of}
            for sid in counts
            if sid in live.stacks
        }
        main = max(frames_in, key=lambda s: len(frames_in[s]), default=None)
        if main is None or len(frames_in[main]) < 2:
            out.dissolved.add(g.id)
            continue
        st = live.stacks[main]
        front = frame_of.get(st.primary_id)
        if front and front != g.best_frame and st.primary_id != g.primary_id:
            out.pins[g.id] = front
        for fid in g.frame_ids:
            if fid not in frames_in[main] and any(a in live.assets for a in frame_assets.get(fid, ())):
                out.removed.add(fid)
    return out


# --- undo -------------------------------------------------------------------------------------------


@dataclass
class Before:
    """One photo before a run changed it."""

    stack_primary: str | None
    stack_members: tuple[str, ...]
    rating: int | None
    tags: tuple[str, ...]  # culler tags
    state: AssetState | None

    def to_json(self) -> dict[str, Any]:
        return {
            "stackPrimary": self.stack_primary,
            "stackMembers": list(self.stack_members),
            "rating": self.rating,
            "tags": list(self.tags),
            "state": self.state.to_json() if self.state else None,
        }

    @classmethod
    def from_json(cls, d: dict[str, Any]) -> Before:
        return cls(
            d["stackPrimary"],
            tuple(d["stackMembers"]),
            d["rating"],
            tuple(d["tags"]),
            AssetState.from_json(d["state"]) if d.get("state") else None,
        )


def snapshot_before(asset_ids: set[str], live: Live, prev: dict[str, AssetState], tag_root: str) -> dict[str, Before]:
    out = {}
    for a in asset_ids:
        asset = live.assets.get(a)
        if asset is None:
            continue
        st = live.stack_of(a)
        out[a] = Before(
            st.primary_id if st else None,
            st.asset_ids if st else (),
            asset.rating,
            tuple(sorted(culler_tags(asset, tag_root))),
            prev.get(a),
        )
    return out


def plan_undo(
    before: dict[str, Before],
    after: dict[str, AssetState | None],
    group_primary: dict[str, str],
    live: Live,
    tag_root: str,
) -> tuple[list[Op], list[str]]:
    """Ops that put the photos back as they were, skipping anything the user changed since.
    Returns (ops, notes about what was skipped)."""
    notes: list[str] = []
    deletes: dict[str, DeleteStack] = {}
    group_members: dict[str, set[str]] = defaultdict(set)
    for a, s in after.items():
        if s:
            group_members[s.group_id].add(a)
    for gid, primary in group_primary.items():
        st = live.stack_of(primary)
        if st is None:
            continue
        members = group_members[gid]
        if st.primary_id in members and set(st.asset_ids) - members <= _renders_since(st, before):
            deletes[st.id] = DeleteStack(st.id, st.asset_ids)
        else:
            notes.append(f"stack {st.id} changed since the run and was left as it is")
    # Released frames: the run put their RAW + JPEG back into a stack of their own. Take that apart;
    # the group stack they were in is rebuilt below.
    for a, s in after.items():
        b = before.get(a)
        if s is not None or b is None:
            continue
        st = live.stack_of(a)
        released_here = st and all(m in after and after[m] is None for m in st.asset_ids)
        if released_here and st.id not in deletes and set(st.asset_ids) != set(b.stack_members):
            deletes[st.id] = DeleteStack(st.id, st.asset_ids)

    loose_after_delete = {a for d in deletes.values() for a in d.asset_ids}
    restores: list[CreateStack] = []
    seen: set[tuple[str, ...]] = set()
    for b in before.values():
        if not b.stack_primary or len(b.stack_members) < 2:
            continue
        members = tuple(m for m in b.stack_members if m in live.assets)
        key = tuple(sorted(members))
        if key in seen or len(members) < 2 or b.stack_primary not in members:
            continue
        seen.add(key)
        current = live.stack_of(b.stack_primary)
        if current and current.id not in deletes and set(current.asset_ids) == set(members):
            continue  # this run didn't change that stack
        if all(live.stack_of(m) is None or m in loose_after_delete for m in members):
            restores.append(CreateStack((b.stack_primary, *sorted(m for m in members if m != b.stack_primary))))
        else:
            notes.append(f"could not restore the stack of {b.stack_primary}: its photos are stacked differently now")

    add: dict[str, list[str]] = defaultdict(list)
    remove: dict[str, list[str]] = defaultdict(list)
    ratings: dict[int | None, list[str]] = defaultdict(list)
    put_meta: list[tuple[str, Any]] = []
    delete_meta: list[str] = []
    for a, b in before.items():
        asset = live.assets.get(a)
        if asset is None:
            continue
        s = after.get(a)
        have = culler_tags(asset, tag_root)
        for v in sorted(have - set(b.tags)):
            remove[v].append(a)
        for v in sorted(set(b.tags) - have):
            add[v].append(a)
        set_now = bool(s and s.rating_set) and not bool(b.state and b.state.rating_set)
        cleared_now = s is None and bool(b.state and b.state.rating_set) and b.rating == -1
        if set_now and asset.rating == -1:
            ratings[b.rating].append(a)
        elif cleared_now and asset.rating is None:
            ratings[-1].append(a)
        if b.state and b.state.meta is not None:
            if not s or _comparable(s.meta) != _comparable(b.state.meta):
                put_meta.append((a, b.state.meta))
        elif s and s.meta is not None:
            delete_meta.append(a)

    ops: list[Op] = [*deletes.values(), *restores]
    ops += [RemoveTag(v, tuple(ids)) for v, ids in sorted(remove.items())]
    ops += [AddTag(v, tuple(ids)) for v, ids in sorted(add.items())]
    ops += [SetRating(r, tuple(ids)) for r, ids in sorted(ratings.items(), key=lambda kv: str(kv[0]))]
    if put_meta:
        ops.append(PutMeta(tuple(put_meta)))
    if delete_meta:
        ops.append(DeleteMeta(tuple(delete_meta)))
    return ops, notes


def _renders_since(st: Stack, before: dict[str, Before]) -> set[str]:
    """Photos in the stack that the run never saw (e.g. a render saved in the editor since)."""
    return {a for a in st.asset_ids if a not in before}
