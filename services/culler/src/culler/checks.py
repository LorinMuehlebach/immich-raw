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
from culler.features.exposure import exposure_basis, judge
from culler.features.eyes import EyeMeasure, classify_eyes, eye_openness
from culler.models import ExposureStats, Features, Frame, Reason


@dataclass(frozen=True)
class Basis:
    """What every shot of a group is compared on, so that all are measured alike."""

    exposure: str = "photo"  # 'faces', 'people' or 'photo'
    # 'faces' (the eye band), 'subject' (the largest animal) or 'photo' (the sharpest tiles)
    sharpness: str = "photo"

    @classmethod
    def of(cls, feats: list[Features], cfg: Config) -> Basis:
        return cls(exposure_basis(feats, cfg), sharpness_basis(feats, cfg))


def sharpness_basis(feats: list[Features], cfg: Config) -> str:
    """Faces when every shot has one, else the animal when every shot shows one, else the photo."""
    if not feats:
        return "photo"
    if all(f.face_sharpness or f.photo_sharpness is None for f in feats):
        return "faces"
    if cfg.subjects.enabled and all(f.subject_sharpness is not None for f in feats):
        return "subject"
    return "photo"


@dataclass
class Candidate:
    frame: Frame
    features: Features
    badness: float
    exposure: ExposureStats  # as the lighting check judges it (people first)
    sharpness: float
    basis: Basis

    @property
    def frame_id(self) -> str:
        return self.frame.id

    @property
    def taken(self) -> datetime:
        return self.frame.taken

    @property
    def judged_on(self) -> str:
        return self.basis.exposure

    @classmethod
    def of(cls, frame: Frame, features: Features, cfg: Config, basis: Basis | None = None) -> Candidate:
        """`basis`: the group's (`Basis.of` all its shots); without it, this shot's own."""
        # Eye state comes from the cached measurements, so a run's own thresholds apply.
        for face in features.faces:
            if face.blink and face.ear:
                m = EyeMeasure(face.blink, face.ear, face.yaw, face.pitch)
                face.state = classify_eyes(m, cfg.eyes)
                face.openness = eye_openness(m, cfg.eyes)
        basis = basis or Basis.of([features], cfg)
        exposure, badness = judge(features, cfg, basis.exposure)
        sharp = features.sharpness
        if basis.sharpness == "photo" and features.photo_sharpness is not None:
            sharp = features.photo_sharpness
        elif basis.sharpness == "subject" and features.subject_sharpness is not None:
            sharp = features.subject_sharpness
        return cls(frame, features, badness, exposure, sharp, basis)


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
            gap = abs(x.exposure.key - best.exposure.key)
            # Frames more than a stop apart: keep only the better side, however close the scores.
            if worse > c.tolerance or (gap > c.max_ev_gap and worse > 0):
                out.add(x.frame_id)
        return out


class BlurCheck:
    name: Reason = "blur"

    def enabled(self, cfg: Config) -> bool:
        return cfg.blur.enabled

    def eliminate(self, cands: list[Candidate], cfg: Config) -> set[str]:
        top = max(x.sharpness for x in cands)
        if top <= 0:
            return set()
        return {x.frame_id for x in cands if x.sharpness < cfg.blur.min_ratio * top}


def least_open(c: Candidate) -> float | None:
    """The least open eyes in the shot (0-1), of the faces that could be judged."""
    values = c.features.eyes_openness()
    return min(values) if values else None


class EyesCheck:
    """Rejects frames with more closed-eye faces than the best survivor, and frames whose least
    open eyes are clearly less open than in the best survivor (half-blinks). Frames where no face
    could be judged are left alone (they rank lower in the tie-break instead)."""

    name: Reason = "eyes"

    def enabled(self, cfg: Config) -> bool:
        return cfg.eyes.enabled

    def eliminate(self, cands: list[Candidate], cfg: Config) -> set[str]:
        known = [x for x in cands if x.features.faces_known > 0]
        if not known:
            return set()
        least = min(x.features.faces_closed for x in known)
        out = {x.frame_id for x in known if x.features.faces_closed > least}
        measured = [(x, v) for x in known if (v := least_open(x)) is not None]
        if measured:
            best = max(v for _, v in measured)
            out |= {x.frame_id for x, v in measured if best - v > cfg.eyes.max_open_gap}
        return out


CHECKS: dict[str, Check] = {c.name: c for c in (LightingCheck(), BlurCheck(), EyesCheck())}
