"""The elimination checks, run in the configured order (default: lighting, blur, eyes).

Each check looks only at the frames that survived the checks before it and returns the frames it
rejects. A check never rejects the frame that is best by its own measure, so at least one
frame always survives. More checks plug in by adding to CHECKS and to `ranking.order`.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Protocol

from culler.config import Config
from culler.features.exposure import lighting_badness
from culler.features.eyes import EyeMeasure, classify_eyes
from culler.models import Features, Frame, Reason


@dataclass
class Candidate:
    frame: Frame
    features: Features
    badness: float

    @property
    def frame_id(self) -> str:
        return self.frame.id

    @property
    def taken(self) -> datetime:
        return self.frame.taken

    @classmethod
    def of(cls, frame: Frame, features: Features, cfg: Config) -> Candidate:
        # Eye state comes from the cached measurements, so a run's own thresholds apply.
        for face in features.faces:
            if face.blink and face.ear:
                face.state = classify_eyes(EyeMeasure(face.blink, face.ear, face.yaw, face.pitch), cfg.eyes)
        return cls(frame, features, lighting_badness(features.exposure, cfg.lighting))


class Check(Protocol):
    name: Reason

    def enabled(self, cfg: Config) -> bool: ...

    def eliminate(self, cands: list[Candidate], cfg: Config) -> set[str]: ...


class LightingCheck:
    name: Reason = "lighting"

    def enabled(self, cfg: Config) -> bool:
        return cfg.lighting.enabled

    def eliminate(self, cands: list[Candidate], cfg: Config) -> set[str]:
        c = cfg.lighting
        best = min(cands, key=lambda x: x.badness)
        out = set()
        for x in cands:
            worse = x.badness - best.badness
            gap = abs(x.features.exposure.key - best.features.exposure.key)
            # Frames more than a stop apart: keep only the better side, however close the scores.
            if worse > c.tolerance or (gap > c.max_ev_gap and worse > 0):
                out.add(x.frame_id)
        return out


class BlurCheck:
    name: Reason = "blur"

    def enabled(self, cfg: Config) -> bool:
        return cfg.blur.enabled

    def eliminate(self, cands: list[Candidate], cfg: Config) -> set[str]:
        top = max(x.features.sharpness for x in cands)
        if top <= 0:
            return set()
        return {x.frame_id for x in cands if x.features.sharpness < cfg.blur.min_ratio * top}


class EyesCheck:
    """Rejects frames with more closed-eye faces than the best survivor. Frames where no face
    could be judged are left alone (they rank lower in the tie-break instead)."""

    name: Reason = "eyes"

    def enabled(self, cfg: Config) -> bool:
        return cfg.eyes.enabled

    def eliminate(self, cands: list[Candidate], cfg: Config) -> set[str]:
        known = [x for x in cands if x.features.faces_known > 0]
        if not known:
            return set()
        least = min(x.features.faces_closed for x in known)
        return {x.frame_id for x in known if x.features.faces_closed > least}


CHECKS: dict[str, Check] = {c.name: c for c in (LightingCheck(), BlurCheck(), EyesCheck())}
