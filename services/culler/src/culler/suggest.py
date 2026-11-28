"""Your picks: how often the best you chose differs from the culler's, why the culler had passed
over your shot, and which settings would have agreed with you. Pure, so it can be tested.

Nothing changes by itself. Each suggestion needs at least MIN_PICKS of your picks behind it, and
carries the run options to preview it with and the culler.toml lines to keep it. A suggestion only
looks at your picks: preview it on a day or an album before keeping it, as it changes other stacks
too.
"""

from __future__ import annotations

import math
from collections import Counter
from typing import Any

from culler.config import Config

MIN_PICKS = 3
WEIGHT_STEPS = 20  # weights in steps of 0.05


def summarize(picks: list[dict[str, Any]], n_groups: int, cfg: Config) -> dict[str, Any]:
    """`picks`: Store.picks(). `n_groups`: the stacks the culler manages."""
    reasons = Counter(_why(p) for p in picks)
    sources = Counter(p["source"] for p in picks)
    found = (_blur(picks, cfg), _lighting(picks, cfg), _eyes(picks, cfg), _weights(picks, cfg))
    return {
        "stacks": n_groups,
        "overruled": len(picks),
        "bySource": {k: sources.get(k, 0) for k in ("you", "favourite")},
        "byReason": {k: reasons.get(k, 0) for k in ("lighting", "blur", "eyes", "runner-up")},
        "minPicks": MIN_PICKS,
        "suggestions": [s for s in found if s],
        "picks": [
            {k: p.get(k) for k in ("groupId", "yourFrame", "autoFrame", "source", "yourRole", "yourReason", "at")}
            for p in picks
        ],
    }


def _why(p: dict[str, Any]) -> str:
    """Why the culler passed over your shot: the check that rejected it, or 'runner-up'."""
    return p["yourReason"] if p["yourRole"] == "rejected" and p.get("yourReason") else "runner-up"


def _suggestion(section: str, old: dict[str, Any], new: dict[str, Any], fixes: int, of: int, why: str) -> dict:
    return {
        "section": section,
        "changes": [{"key": f"{section}.{k}", "from": old[k], "to": v} for k, v in new.items()],
        "fixes": fixes,
        "of": of,
        "why": why,
        "options": {section: dict(new)},
        "toml": "\n".join([f"[{section}]", *(f"{k} = {v}" for k, v in new.items())]),
    }


def _up(v: float, step: float) -> float:
    """`v` rounded up to `step` (0.42 stays 0.42 despite float noise)."""
    return round(math.ceil(round(v / step, 6)) * step, 4)


def _down(v: float, step: float) -> float:
    return round(math.floor(round(v / step, 6)) * step, 4)


def _pct(v: float) -> str:
    return f"{round(100 * v)} %"


def _blur(picks: list[dict], cfg: Config) -> dict | None:
    ps = [p for p in picks if _why(p) == "blur" and p["deltas"].get("sharpRatio") is not None]
    if len(ps) < MIN_PICKS:
        return None
    ratios = sorted(p["deltas"]["sharpRatio"] for p in ps)
    to = max(0.05, _down(ratios[0] - 0.01, 0.01))  # just below your softest pick
    if to >= cfg.blur.min_ratio:
        return None
    span = _pct(ratios[0]) if ratios[0] == ratios[-1] else f"{_pct(ratios[0])} to {_pct(ratios[-1])}"
    why = (
        f"You picked {len(ps)} shots it had set aside as not sharp, at {span} of the sharpest. "
        f"From {_pct(to)}, sharpness wouldn't set them aside."
    )
    return _suggestion("blur", {"min_ratio": cfg.blur.min_ratio}, {"min_ratio": to}, len(ps), len(ps), why)


def _lighting(picks: list[dict], cfg: Config) -> dict | None:
    ps = [p for p in picks if _why(p) == "lighting"]
    if len(ps) < MIN_PICKS:
        return None
    c = cfg.lighting
    new: dict[str, float] = {}
    worse = [p["deltas"]["lightingWorse"] for p in ps if p["deltas"]["lightingWorse"] > c.tolerance]
    if worse:
        new["tolerance"] = _up(max(worse) + 0.05, 0.01)
    gaps = [
        p["deltas"]["evGap"] for p in ps if p["deltas"]["evGap"] > c.max_ev_gap and p["deltas"]["lightingWorse"] > 0
    ]
    if gaps:
        new["max_ev_gap"] = _up(max(gaps) + 0.1, 0.1)
    if not new:
        return None
    tol, gap = new.get("tolerance", c.tolerance), new.get("max_ev_gap", c.max_ev_gap)
    fixes = sum(
        1
        for p in ps
        if p["deltas"]["lightingWorse"] <= tol and not (p["deltas"]["evGap"] > gap and p["deltas"]["lightingWorse"] > 0)
    )
    stops = max(p["deltas"]["evGap"] for p in ps)
    why = (
        f"You picked {len(ps)} shots it had set aside for their lighting, up to {stops:.1f} stops off the "
        "best-exposed shot. With these, lighting wouldn't set them aside."
    )
    old = {"tolerance": c.tolerance, "max_ev_gap": c.max_ev_gap}
    return _suggestion("lighting", {k: old[k] for k in new}, new, fixes, len(ps), why)


def _eyes(picks: list[dict], cfg: Config) -> dict | None:
    ps = [p for p in picks if _why(p) == "eyes"]
    half = [p for p in ps if p["deltas"].get("closedMore", 0) == 0 and p["deltas"].get("openGap") is not None]
    if len(half) < MIN_PICKS:
        return None
    gap = max(p["deltas"]["openGap"] for p in half)
    to = _up(gap + 0.02, 0.01)
    if to <= cfg.eyes.max_open_gap:
        return None
    why = (
        f"You picked {len(half)} shots it had set aside for half-closed eyes, up to {round(100 * gap)} points "
        "less open than in the best shot. With this, they'd stay."
    )
    if len(ps) > len(half):
        why += f" ({len(ps) - len(half)} more had closed eyes: no setting short of turning the check off keeps those.)"
    return _suggestion("eyes", {"max_open_gap": cfg.eyes.max_open_gap}, {"max_open_gap": to}, len(half), len(ps), why)


def _weights(picks: list[dict], cfg: Config) -> dict | None:
    """Your shot passed every check but lost on the mix of sharpness, exposure and open eyes (with as
    many smiles): the weights that would have picked most of them, nearest to today's."""
    ps = [p for p in picks if _why(p) == "runner-up" and p["deltas"]["smiles"][0] == p["deltas"]["smiles"][1]]
    if len(ps) < MIN_PICKS:
        return None
    r = cfg.ranking
    now = (r.sharpness_weight, r.exposure_weight, r.eyes_weight)
    diffs = [[a - b for a, b in zip(p["deltas"]["you"], p["deltas"]["auto"], strict=True)] for p in ps]

    def wins(w: tuple[float, float, float]) -> int:
        return sum(1 for d in diffs if sum(wi * di for wi, di in zip(w, d, strict=True)) > 1e-9)

    grid = [
        (a / WEIGHT_STEPS, b / WEIGHT_STEPS, (WEIGHT_STEPS - a - b) / WEIGHT_STEPS)
        for a in range(WEIGHT_STEPS + 1)
        for b in range(WEIGHT_STEPS + 1 - a)
    ]
    best = max(grid, key=lambda w: (wins(w), -sum(abs(x - y) for x, y in zip(w, now, strict=True))))
    n = wins(best)
    if n < MIN_PICKS or n <= wins(now):
        return None
    names = ("sharpness_weight", "exposure_weight", "eyes_weight")
    new = {k: round(v, 2) for k, v in zip(names, best, strict=True) if abs(v - getattr(r, k)) > 1e-9}
    old = {k: getattr(r, k) for k in new}
    labels = ("sharpness", "exposure", "eyes")
    mix = ", ".join(f"{label} {round(100 * v)} %" for label, v in zip(labels, best, strict=True))
    why = (
        f"{len(ps)} of your picks passed every check and lost on the mix of sharpness, exposure and open eyes. "
        f"With {mix}, {n} of them would have been the best."
    )
    return _suggestion("ranking", old, new, n, len(ps), why)
