"""Picks the best frame of a group by sequential elimination, then a tie-break.

Among the frames that pass every check, the one with the most smiling faces is the best (when
smiles count), then the best mix of sharpness, exposure and open eyes.

Order of the result: best, runner-ups (passed every check) in that order, then rejected frames,
those that survived longer first.
"""

from __future__ import annotations

from culler.brackets import middle
from culler.checks import CHECKS, Basis, Candidate
from culler.config import Config
from culler.features.exposure import subject_exposure, subject_target
from culler.models import Features, Frame, FrameResult, GroupResult, Reason


def tie_break_score(c: Candidate, top_sharpness: float) -> float:
    sharp = c.sharpness / top_sharpness if top_sharpness > 0 else 0.0
    light = 1.0 - min(1.0, c.badness / 1.5)
    f = c.features
    openness = f.eyes_openness()
    if openness:
        eyes = sum(openness) / len(openness)
    else:
        eyes = (f.faces_known - f.faces_closed) / f.faces_known if f.faces_known else 0.5
    return 0.45 * sharp + 0.35 * light + 0.20 * eyes


def rank_group(
    frames: list[Frame], features: dict[str, Features], cfg: Config, pinned: str | None = None
) -> GroupResult:
    basis = Basis.of([features[f.id] for f in frames], cfg)
    cands = [Candidate.of(f, features[f.id], cfg, basis) for f in frames]
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

    top_sharp = max(c.sharpness for c in cands)
    score = {c.frame_id: tie_break_score(c, top_sharp) for c in cands}

    def smiles(c: Candidate) -> int:
        return c.features.faces_smiling(cfg.smiles.min_score) if cfg.smiles.enabled else 0

    def order_key(c: Candidate) -> tuple:
        return (-smiles(c), -score[c.frame_id], c.taken, c.frame.name)

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
            metrics=_metrics(c, best, cfg),
        )
    return GroupResult(frame_ids=[c.frame_id for c in ordered], results=results)


def _metrics(c: Candidate, best: Candidate, cfg: Config) -> dict:
    f = c.features
    out = {
        "evVsBest": round(c.exposure.key - best.exposure.key, 2),
        "clipHiPct": round(100 * f.exposure.clip_hi, 1),
        "clipLoPct": round(100 * f.exposure.clip_lo, 1),
        "lighting": round(c.badness, 2),
        "sharpPct": round(100 * c.sharpness / best.sharpness) if best.sharpness > 0 else None,
        "faces": f.faces_known,
        "closed": f.faces_closed,
        "judgedOn": c.judged_on,
        "sharpOn": c.basis.sharpness,
    }
    if c.basis.sharpness == "subject" and f.animals:
        out["subjectLabel"] = f.animals[0].label
    openness = f.eyes_openness()
    if openness:
        out["eyesOpen"] = round(100 * sum(openness) / len(openness))
        out["eyesLeast"] = round(100 * min(openness))
    if cfg.people.enabled:
        out["people"] = len(f.bodies)
    subject = subject_exposure(f, c.judged_on)
    if subject:
        out["subjectEv"] = round(subject.key - subject_target(cfg.lighting, c.judged_on), 2)
        out["subjectClipHiPct"] = round(100 * subject.clip_hi, 1)
        out["subjectClipLoPct"] = round(100 * subject.clip_lo, 1)
    if any(face.smile is not None for face in f.faces):
        out["smiling"] = f.faces_smiling(cfg.smiles.min_score)
        out["smileFaces"] = sum(1 for face in f.faces if face.smile is not None)
    return out


def rank_brackets(
    frames: list[Frame], features: dict[str, Features], cfg: Config, pinned: str | None = None
) -> GroupResult:
    """An exposure bracket: kept whole, nothing rejected. In front: the user's pick (or a sole
    favourite), else the middle exposure; the others follow from dark to bright."""
    by_id = {f.id: f for f in frames}
    front_id: str | None = pinned if pinned in by_id else None
    if front_id is None and cfg.ranking.respect_favorites:
        favourites = [f for f in frames if f.favorite]
        if len(favourites) == 1:
            front_id = favourites[0].id
    is_pinned = front_id is not None
    front = by_id[front_id] if front_id else middle(frames)
    rest = sorted(
        (f for f in frames if f.id != front.id),
        key=lambda f: (f.exposure_ev is None, f.exposure_ev or 0.0, f.taken, f.name),
    )
    ordered = [front, *rest]
    ref = features.get(front.id)
    results: dict[str, FrameResult] = {}
    for rank, f in enumerate(ordered, start=1):
        feats = features.get(f.id)
        metrics: dict = {}
        if feats and ref:
            metrics["evVsBest"] = round(feats.exposure.key - ref.exposure.key, 2)
            metrics["clipHiPct"] = round(100 * feats.exposure.clip_hi, 1)
            metrics["clipLoPct"] = round(100 * feats.exposure.clip_lo, 1)
        if f.exposure_ev is not None and front.exposure_ev is not None:
            metrics["bracketEv"] = round(f.exposure_ev - front.exposure_ev, 1)
        results[f.id] = FrameResult(
            frame_id=f.id,
            role="bracket",
            reason=None,
            rank=rank,
            score=0.0,
            pinned=is_pinned and f.id == front.id,
            metrics=metrics,
        )
    return GroupResult(frame_ids=[f.id for f in ordered], results=results, kind="bracket")
