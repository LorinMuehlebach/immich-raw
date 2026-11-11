"""Picks the best frame of a group by sequential elimination, then a tie-break.

Order of the result: best, runner-ups (passed every check) by score, then rejected frames, those
that survived longer first.
"""

from __future__ import annotations

from culler.checks import CHECKS, Candidate
from culler.config import Config
from culler.models import Features, Frame, FrameResult, GroupResult, Reason


def tie_break_score(c: Candidate, top_sharpness: float) -> float:
    sharp = c.features.sharpness / top_sharpness if top_sharpness > 0 else 0.0
    light = 1.0 - min(1.0, c.badness / 1.5)
    f = c.features
    eyes = (f.faces_known - f.faces_closed) / f.faces_known if f.faces_known else 0.5
    return 0.45 * sharp + 0.35 * light + 0.20 * eyes


def rank_group(
    frames: list[Frame], features: dict[str, Features], cfg: Config, pinned: str | None = None
) -> GroupResult:
    cands = [Candidate.of(f, features[f.id], cfg) for f in frames]
    by_id = {c.frame_id: c for c in cands}
    survivors = list(cands)
    rejected: dict[str, tuple[int, Reason]] = {}
    for stage, name in enumerate(cfg.ranking.order):
        check = CHECKS.get(name)
        if check is None or not check.enabled(cfg) or len(survivors) < 2:
            continue
        out = check.eliminate(survivors, cfg)
        if len(out) >= len(survivors):
            continue  # never reject everyone
        for fid in out:
            rejected[fid] = (stage, check.name)
        survivors = [c for c in survivors if c.frame_id not in out]

    top_sharp = max(c.features.sharpness for c in cands)
    score = {c.frame_id: tie_break_score(c, top_sharp) for c in cands}

    def order_key(c: Candidate) -> tuple:
        return (-score[c.frame_id], c.taken, c.frame.name)

    best_id: str | None = None
    if pinned in by_id:
        best_id = pinned
    elif cfg.ranking.respect_favorites:
        favourites = [c for c in cands if c.frame.favorite]
        if len(favourites) == 1:
            best_id = favourites[0].frame_id
    is_pinned = best_id is not None
    if best_id is None:
        best_id = sorted(survivors, key=order_key)[0].frame_id
    rejected.pop(best_id, None)

    runner_ups = sorted((c for c in survivors if c.frame_id != best_id), key=order_key)
    losers = sorted(
        (c for c in cands if c.frame_id in rejected),
        key=lambda c: (-rejected[c.frame_id][0], *order_key(c)),
    )
    ordered = [by_id[best_id], *runner_ups, *losers]

    best = by_id[best_id]
    results: dict[str, FrameResult] = {}
    for rank, c in enumerate(ordered, start=1):
        fid = c.frame_id
        role = "best" if fid == best_id else "rejected" if fid in rejected else "runner-up"
        results[fid] = FrameResult(
            frame_id=fid,
            role=role,
            reason=rejected[fid][1] if fid in rejected else None,
            rank=rank,
            score=round(score[fid], 4),
            pinned=is_pinned and fid == best_id,
            metrics=_metrics(c, best),
        )
    return GroupResult(frame_ids=[c.frame_id for c in ordered], results=results)


def _metrics(c: Candidate, best: Candidate) -> dict:
    f, b = c.features, best.features
    return {
        "evVsBest": round(f.exposure.key - b.exposure.key, 2),
        "clipHiPct": round(100 * f.exposure.clip_hi, 1),
        "clipLoPct": round(100 * f.exposure.clip_lo, 1),
        "lighting": round(c.badness, 2),
        "sharpPct": round(100 * f.sharpness / b.sharpness) if b.sharpness > 0 else None,
        "faces": f.faces_known,
        "closed": f.faces_closed,
    }
