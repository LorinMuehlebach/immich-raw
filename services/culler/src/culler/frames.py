"""Builds frames (one capture each) from the photos in scope. Pure, so it can be tested.

- A RAW and a camera JPEG/HEIC with the same base name, the same camera and at most 2 s apart
  are one frame.
- The editor's renders (metadata `raw-editor.render.sourceAssetId`) join their RAW's frame.
- An existing stack that holds one capture (at most one RAW and one other original within 2 s,
  plus any renders) is one frame, and its primary stays the frame's face.
- A stack this service made is rebuilt from the rules above.
- Any other stack is the user's own: its photos are left out.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field

from culler.models import Asset, Frame, Stack, manual_reject_tag

PAIR_SECONDS = 2.0


@dataclass
class FrameSet:
    frames: list[Frame]
    frame_of: dict[str, str]  # asset id -> frame id
    excluded: dict[str, str] = field(default_factory=dict)  # asset id -> reason


class _Union:
    def __init__(self, ids):
        self.parent = {i: i for i in ids}

    def find(self, x: str) -> str:
        while self.parent[x] != x:
            self.parent[x] = self.parent[self.parent[x]]
            x = self.parent[x]
        return x

    def union(self, a: str, b: str) -> None:
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.parent[rb] = ra


def _close(a: Asset, b: Asset) -> bool:
    return abs((a.taken - b.taken).total_seconds()) <= PAIR_SECONDS


def _same_camera(a: Asset, b: Asset) -> bool:
    return a.camera is None or b.camera is None or a.camera.lower() == b.camera.lower()


def is_capture_stack(members: list[Asset], render_ids: set[str]) -> bool:
    originals = [a for a in members if a.id not in render_ids]
    raws = [a for a in originals if a.is_raw]
    others = [a for a in originals if not a.is_raw]
    if len(raws) > 1 or len(others) > 1:
        return False
    return all(_close(a, b) for a in originals for b in originals)


def build_frames(
    assets: list[Asset],
    stacks: dict[str, Stack],
    render_sources: dict[str, str],
    culler_stack_ids: set[str],
    tag_root: str = "Culling",
) -> FrameSet:
    """`assets`: the photos in scope plus the other members of their stacks (no trash, images only).
    `render_sources`: render asset id -> source RAW id. `culler_stack_ids`: stacks this service made.
    `tag_root`: the culler's tags (a shot with the user's own reject tag under it is never the best)."""
    by_id = {a.id: a for a in assets}
    uf = _Union(by_id)
    excluded: dict[str, str] = {}
    renders = {rid for rid in render_sources if rid in by_id}

    for rid in renders:
        if render_sources[rid] in by_id:
            uf.union(render_sources[rid], rid)

    by_base: dict[str, list[Asset]] = defaultdict(list)
    for a in assets:
        if a.id not in renders:
            by_base[a.base_name].append(a)
    for group in by_base.values():
        raws = [a for a in group if a.is_raw]
        for o in (a for a in group if not a.is_raw):
            for r in raws:
                if _close(r, o) and _same_camera(r, o):
                    uf.union(r.id, o.id)

    capture_primaries: list[str] = []
    for st in stacks.values():
        members = [by_id[m] for m in st.asset_ids if m in by_id]
        if len(members) < 2 or st.id in culler_stack_ids:
            continue
        if is_capture_stack(members, renders):
            for m in members[1:]:
                uf.union(members[0].id, m.id)
            if st.primary_id in by_id:
                capture_primaries.append(st.primary_id)
        else:
            for m in members:
                excluded[m.id] = "in a stack you made"

    # A photo paired with one in the user's own stack is part of that capture: leave it out too.
    excluded_roots = {uf.find(a) for a in excluded}
    for a in assets:
        if a.id not in excluded and uf.find(a.id) in excluded_roots:
            excluded[a.id] = "same capture as a photo in a stack you made"

    capture_primary = {uf.find(p): p for p in capture_primaries}
    members_of: dict[str, list[Asset]] = defaultdict(list)
    for a in assets:
        if a.id not in excluded:
            members_of[uf.find(a.id)].append(a)

    frames: list[Frame] = []
    frame_of: dict[str, str] = {}
    for root, members in members_of.items():
        frame = _make_frame(members, renders, capture_primary.get(root), manual_reject_tag(tag_root))
        frames.append(frame)
        for m in members:
            frame_of[m.id] = frame.id
    frames.sort(key=lambda f: (f.taken, f.name))
    return FrameSet(frames=frames, frame_of=frame_of, excluded=excluded)


def _make_frame(members: list[Asset], renders: set[str], capture_primary: str | None, user_reject: str) -> Frame:
    raws = sorted((a for a in members if a.is_raw and a.id not in renders), key=lambda a: (a.taken, a.name))
    others = sorted((a for a in members if not a.is_raw and a.id not in renders), key=lambda a: (a.taken, a.name))
    rendered = sorted((a for a in members if a.id in renders), key=lambda a: a.uploaded, reverse=True)
    anchor = (raws or others or rendered)[0]
    if capture_primary and any(m.id == capture_primary for m in members):
        face = capture_primary
    else:
        face = (rendered or others or raws)[0].id
    originals = raws + others or rendered
    exposed = next((a for a in raws + others if a.exposure_ev is not None), None)
    return Frame(
        id=anchor.id,
        asset_ids=tuple(sorted(m.id for m in members)),
        face_id=face,
        raw_id=raws[0].id if raws else None,
        jpeg_id=others[0].id if others else None,
        render_ids=tuple(a.id for a in rendered),
        taken=min(a.taken for a in originals),
        camera=anchor.camera,
        name=anchor.name,
        favorite=any(m.is_favorite for m in members),
        starred=any(m.rating is not None and 1 <= m.rating <= 5 for m in members),
        user_rejected=any(t.value == user_reject for m in members for t in m.tags),
        duplicate_ids=frozenset(m.duplicate_id for m in members if m.duplicate_id),
        exposure_ev=exposed.exposure_ev if exposed else None,
        exposure_time=exposed.exposure_time if exposed else None,
    )
