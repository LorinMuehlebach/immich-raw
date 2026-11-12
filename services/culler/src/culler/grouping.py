"""Groups frames that show the same scene, shot close together. Pure, so it can be tested.

1. Frames in time order are cut into chains wherever the pause is longer than `max_gap_s` or the
   camera changes.
2. Inside a chain, each frame joins the open group it looks most like: similar to one of the
   group's last few frames and to the group's most typical frame (so a slow pan doesn't chain
   into one endless group). A group spans at most `max_span_s` and `max_size` frames.
3. Frames Immich already marked as duplicates of each other always join.
4. Shots the user added to a stack (on the auto-stack page) go into that stack: `apply_joins`.
"""

from __future__ import annotations

from collections import Counter

import numpy as np

from culler.config import GroupingConfig
from culler.features.embedding import cosine
from culler.models import Frame


def _seconds(a: Frame, b: Frame) -> float:
    return (b.taken - a.taken).total_seconds()


def split_chains(frames: list[Frame], cfg: GroupingConfig) -> list[list[Frame]]:
    chains: list[list[Frame]] = []
    for f in sorted(frames, key=lambda f: (f.taken, f.name)):
        if chains:
            last = chains[-1][-1]
            camera_change = cfg.split_by_camera and f.camera and last.camera and f.camera != last.camera
            if _seconds(last, f) <= cfg.max_gap_s and not camera_change:
                chains[-1].append(f)
                continue
        chains.append([f])
    return chains


def _medoid(group: list[Frame], emb: dict[str, np.ndarray]) -> np.ndarray | None:
    vecs = [emb[f.id] for f in group if f.id in emb]
    if not vecs:
        return None
    if len(vecs) <= 2:
        return vecs[0]
    m = np.stack(vecs)
    return vecs[int(np.argmax((m @ m.T).sum(axis=1)))]


def group_frames(frames: list[Frame], emb: dict[str, np.ndarray], cfg: GroupingConfig) -> list[list[str]]:
    """Frame ids per group, each in time order; single frames are groups of one."""
    groups: list[list[Frame]] = []
    for chain in split_chains(frames, cfg):
        open_groups: list[list[Frame]] = []
        for f in chain:
            choice, choice_sim = None, -2.0
            for g in open_groups:
                if _seconds(g[-1], f) > cfg.max_gap_s or _seconds(g[0], f) > cfg.max_span_s or len(g) >= cfg.max_size:
                    continue
                if f.duplicate_ids and any(f.duplicate_ids & x.duplicate_ids for x in g):
                    choice, choice_sim = g, 2.0
                    break
                e = emb.get(f.id)
                if e is None:
                    continue
                recent = [cosine(e, emb[x.id]) for x in g[-cfg.recent_frames :] if x.id in emb]
                medoid = _medoid(g, emb)
                if not recent or medoid is None:
                    continue
                sim = max(recent)
                if sim >= cfg.link_similarity and cosine(e, medoid) >= cfg.medoid_similarity and sim > choice_sim:
                    choice, choice_sim = g, sim
            if choice is None:
                open_groups.append([f])
            else:
                choice.append(f)
        groups.extend(open_groups)
    groups.sort(key=lambda g: (g[0].taken, g[0].name))
    return [[f.id for f in g] for g in groups]


def neighbour_similarities(frames: list[Frame], emb: dict[str, np.ndarray]) -> list[tuple[Frame, Frame, float, float]]:
    """(previous, frame, seconds apart, cosine) for each pair of consecutive frames: for tuning."""
    order = sorted(frames, key=lambda f: (f.taken, f.name))
    out = []
    for a, b in zip(order, order[1:], strict=False):
        if a.id in emb and b.id in emb:
            out.append((a, b, _seconds(a, b), cosine(emb[a.id], emb[b.id])))
    return out


def apply_joins(
    groups: list[list[str]], joins: dict[str, tuple[str, ...]], measured: set[str]
) -> tuple[list[list[str]], set[str], dict[str, str]]:
    """Moves each shot the user added to a stack into the group holding most of that stack's shots
    (`joins`: shot -> the stack's shot ids when it was added). Only measured shots can be ranked, so
    only they move, and only into a group of measured shots. Shots that point only at each other
    (their stack is gone) form a group of their own.

    Returns the groups, the shots placed, and why the others weren't (shot -> reason)."""
    groups = [list(g) for g in groups]
    present = {f for g in groups for f in g}
    movers = {f: tuple(t for t in ts if t != f) for f, ts in joins.items() if f in present and f in measured}
    why = {f: "waiting for Immich's preview" for f in joins if f in present and f not in measured}
    groups = [[f for f in g if f not in movers] for g in groups]
    groups = [g for g in groups if g]
    placed: set[str] = set()
    todo = dict(movers)
    while todo:
        index = {f: i for i, g in enumerate(groups) for f in g}
        moved = False
        for f, targets in sorted(todo.items()):
            hits = Counter(index[t] for t in targets if t in index and all(x in measured for x in groups[index[t]]))
            if not hits:
                continue
            i = max(hits, key=lambda k: (hits[k], -k))  # most of its stack; the earlier group on a tie
            groups[i].append(f)
            index[f] = i
            placed.add(f)
            del todo[f]
            moved = True
        if not moved:
            break
    # Left over: shots whose stack is gone. Those pointing at each other stay together.
    left = set(todo)
    seen: set[str] = set()
    for f in sorted(left):
        if f in seen:
            continue
        component, queue = [], [f]
        while queue:
            x = queue.pop()
            if x in seen:
                continue
            seen.add(x)
            component.append(x)
            queue.extend(t for t in todo[x] if t in left)
            queue.extend(y for y in left if x in todo[y])
        groups.append(sorted(component))
        if len(component) > 1:
            placed.update(component)
        else:
            why[f] = "its stack isn't among these photos any more"
    return groups, placed, why
