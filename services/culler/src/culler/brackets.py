"""Exposure brackets: shots taken seconds apart whose camera settings step the exposure (for example
0, -2, +2 EV) and whose measured brightness steps along. Pure, so it can be tested.

1. Per camera, shots in time order are cut into runs wherever the pause is longer than `max_gap_s`
   plus the previous shot's exposure time (a long exposure delays the next shot).
2. From each shot on, the longest stretch whose exposures all differ (by at least `min_step_ev`)
   is tried, down to `min_frames` shots; the first that counts is a set, and the search goes on
   after it. Repeated sets, as for an HDR panorama, come apart; a shot of the burst before a set
   doesn't join it.
3. A stretch counts when its exposures span at least `min_spread_ev` and the measured brightness
   follows the settings: against the middle shot, each shot is brighter or darker by at least
   `min_follow` of its step. In an automatic mode the camera changes its settings to keep the
   brightness the same, so a normal burst doesn't count.

Shots without exposure EXIF (shutter speed, aperture, ISO) never count.
"""

from __future__ import annotations

from collections import defaultdict
from statistics import median

from culler.config import BracketsConfig
from culler.models import Features, Frame


def find_brackets(frames: list[Frame], features: dict[str, Features], cfg: BracketsConfig) -> list[list[str]]:
    """Frame ids of each bracket set, in time order."""
    if not cfg.enabled:
        return []
    out: list[list[str]] = []
    for run in _runs([f for f in frames if f.exposure_ev is not None and f.id in features], cfg):
        i = 0
        while i <= len(run) - cfg.min_frames:
            found = _longest_set(run, i, features, cfg)
            if found:
                out.append([f.id for f in found])
                i += len(found)
            else:
                i += 1
    return out


def _runs(frames: list[Frame], cfg: BracketsConfig) -> list[list[Frame]]:
    by_camera: dict[str | None, list[Frame]] = defaultdict(list)
    for f in frames:
        by_camera[f.camera].append(f)
    runs: list[list[Frame]] = []
    for shots in by_camera.values():
        current: list[Frame] = []
        for f in sorted(shots, key=lambda f: (f.taken, f.name)):
            if current:
                last = current[-1]
                if (f.taken - last.taken).total_seconds() > cfg.max_gap_s + (last.exposure_time or 0.0):
                    runs.append(current)
                    current = []
            current.append(f)
        runs.append(current)
    return [r for r in runs if len(r) >= cfg.min_frames]


def _longest_set(run: list[Frame], start: int, features: dict[str, Features], cfg: BracketsConfig) -> list[Frame]:
    end = start
    while end < len(run) and all(abs(run[end].exposure_ev - f.exposure_ev) >= cfg.min_step_ev for f in run[start:end]):
        end += 1
    for stop in range(end, start + cfg.min_frames - 1, -1):
        if is_bracket(run[start:stop], features, cfg):
            return run[start:stop]
    return []


def is_bracket(shots: list[Frame], features: dict[str, Features], cfg: BracketsConfig) -> bool:
    if len(shots) < cfg.min_frames:
        return False
    evs = [f.exposure_ev for f in shots]
    if max(evs) - min(evs) < cfg.min_spread_ev:
        return False
    mid = middle(shots)
    for f in shots:
        step = f.exposure_ev - mid.exposure_ev
        if f is mid or abs(step) < cfg.min_step_ev:
            continue
        moved = features[f.id].exposure.key - features[mid.id].exposure.key
        if moved * (1 if step > 0 else -1) < cfg.min_follow * abs(step):
            return False
    return True


def middle(shots: list[Frame]) -> Frame:
    """The shot nearest the set's median exposure; on a tie the earlier one."""
    known = [f for f in shots if f.exposure_ev is not None]
    if not known:
        return min(shots, key=lambda f: (f.taken, f.name))
    m = median(f.exposure_ev for f in known)
    return min(known, key=lambda f: (abs(f.exposure_ev - m), f.taken, f.name))
