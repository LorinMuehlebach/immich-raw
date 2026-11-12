"""Lighting: how far a frame's brightness and clipping are from a good exposure.

The key (typical brightness) uses the same maths as the editor's Auto tone
(packages/pipeline/src/auto.ts): half median, half 2-98 % trimmed mean of log2 luminance.

Three parts of a photo are measured, each with its brightness and its blown / crushed share:
- the whole photo, its centre weighted;
- its faces (the inner part of each face box: skin rather than hair and background);
- the people the object detector found (also seen from the side or from behind).

The lighting check then judges the people first (`judge`): their faces, or else the people,
outweigh the rest of the photo. Every shot of a group is judged on the same part (`exposure_basis`),
so a shot without a usable face doesn't win just because a whole figure is brighter than a face.
This is decided at ranking time, so a run can switch it without measuring the photos again.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

from culler.config import Config, LightingConfig
from culler.features.image import fit_long_edge, to_linear
from culler.models import ExposureStats, Features

ANALYSIS_EDGE = 512
LOG_FLOOR = 1 / 4096
FACE_INSET = 0.15  # of the face box, on each side
MIN_REGION_PX = 16

Box = tuple[float, float, float, float]


@dataclass
class MeasuredExposure:
    photo: ExposureStats
    faces: ExposureStats | None = None
    people: ExposureStats | None = None


def _weighted_key(log_y: np.ndarray, weights: np.ndarray) -> float:
    order = np.argsort(log_y)
    v, w = log_y[order], weights[order]
    cum = np.cumsum(w)
    total = cum[-1]
    median = float(v[min(len(v) - 1, int(np.searchsorted(cum, 0.5 * total)))])
    keep = (cum >= 0.02 * total) & (cum <= 0.98 * total)
    trimmed = float(np.average(v[keep], weights=w[keep])) if keep.any() else median
    return 0.5 * median + 0.5 * trimmed


def centre_weights(h: int, w: int) -> np.ndarray:
    """Gaussian centre weighting, sigma = 35 % of the diagonal."""
    ys = (np.arange(h) - (h - 1) / 2)[:, None]
    xs = (np.arange(w) - (w - 1) / 2)[None, :]
    sigma = 0.35 * math.hypot(h, w)
    return np.exp(-(xs**2 + ys**2) / (2 * sigma**2)).astype(np.float32)


def box_mask(h: int, w: int, boxes: list[Box], scale: float, inset: float = 0.0) -> np.ndarray:
    """The boxes (x, y, w, h; times `scale` = pixels of an h x w image), each shrunk by `inset`."""
    mask = np.zeros((h, w), bool)
    for x, y, bw, bh in boxes:
        x, y, bw, bh = x + inset * bw, y + inset * bh, (1 - 2 * inset) * bw, (1 - 2 * inset) * bh
        x0, y0 = max(0, int(x * scale)), max(0, int(y * scale))
        x1, y1 = min(w, int((x + bw) * scale) + 1), min(h, int((y + bh) * scale) + 1)
        mask[y0:y1, x0:x1] = True
    return mask


def _region(log_y: np.ndarray, hi: np.ndarray, lo: np.ndarray, mask: np.ndarray, key_offset: float):
    n = int(mask.sum())
    if n < MIN_REGION_PX:
        return None
    v = log_y[mask]
    p5, p95 = np.percentile(v, [5, 95])
    return ExposureStats(
        key=_weighted_key(v, np.ones(n, np.float32)) + key_offset,
        clip_hi=float(hi[mask].mean()),
        clip_lo=float(lo[mask].mean()),
        range=float(p95 - p5),
    )


def exposure_from_linear(
    lin: np.ndarray,
    hi: np.ndarray,
    lo: np.ndarray,
    clip_hi: float,
    clip_lo: float,
    face_boxes: list[Box] | None,
    body_boxes: list[Box] | None,
    box_scale: float,
    key_offset: float = 0.0,
) -> MeasuredExposure:
    """`lin`: linear RGB (1.0 = white). `hi` / `lo`: its blown and crushed pixels. `clip_hi` /
    `clip_lo`: the whole photo's shares (possibly counted at full size). Boxes * `box_scale` =
    pixels of `lin`."""
    h, w = lin.shape[:2]
    y = lin[..., 0] * 0.2126 + lin[..., 1] * 0.7152 + lin[..., 2] * 0.0722
    log_y = np.log2(np.maximum(y, LOG_FLOOR))
    flat = log_y.ravel()
    p5, p95 = np.percentile(flat, [5, 95])
    photo = ExposureStats(
        key=_weighted_key(flat, centre_weights(h, w).ravel()) + key_offset,
        clip_hi=clip_hi,
        clip_lo=clip_lo,
        range=float(p95 - p5),
    )
    faces = (
        _region(log_y, hi, lo, box_mask(h, w, face_boxes, box_scale, FACE_INSET), key_offset) if face_boxes else None
    )
    people = _region(log_y, hi, lo, box_mask(h, w, body_boxes, box_scale), key_offset) if body_boxes else None
    return MeasuredExposure(photo, faces, people)


def measure_exposure(rgb: np.ndarray, face_boxes: list[Box] | None = None, body_boxes: list[Box] | None = None):
    """From an sRGB image (a preview or JPEG); boxes are in the pixel coordinates of `rgb`."""
    small = fit_long_edge(rgb, ANALYSIS_EDGE)
    peak = small.max(axis=2)
    hi, lo = peak >= 250, peak <= 5
    return exposure_from_linear(
        to_linear(small),
        hi,
        lo,
        float(hi.mean()),
        float(lo.mean()),
        face_boxes,
        body_boxes,
        small.shape[1] / rgb.shape[1],
    )


def _blend(subject: ExposureStats, photo: ExposureStats, weight: float) -> ExposureStats:
    def mix(a: float, b: float) -> float:
        return weight * a + (1 - weight) * b

    return ExposureStats(
        key=mix(subject.key, photo.key),
        clip_hi=mix(subject.clip_hi, photo.clip_hi),
        clip_lo=mix(subject.clip_lo, photo.clip_lo),
        range=photo.range,
    )


def exposure_basis(feats: list[Features], cfg: Config) -> str:
    """What a group's exposure is judged on: 'faces' when every shot has a usable face, else
    'people' when every shot shows people, else 'photo'."""
    light = cfg.lighting
    if light.people_first and feats and all(f.face_exposure for f in feats):
        return "faces"
    if light.people_first and cfg.people.enabled and feats and all(f.body_exposure for f in feats):
        return "people"
    return "photo"


def subject_exposure(f: Features, basis: str) -> ExposureStats | None:
    return f.face_exposure if basis == "faces" else f.body_exposure if basis == "people" else None


def judge(f: Features, cfg: Config, basis: str) -> tuple[ExposureStats, float]:
    """The exposure the lighting check compares (the subject blended with the photo) and its badness."""
    light = cfg.lighting
    photo_bad = lighting_badness(f.exposure, light)
    subject = subject_exposure(f, basis)
    if subject is None:
        return f.exposure, photo_bad
    if basis == "faces":
        weight, bad = (
            light.face_weight,
            lighting_badness(subject, light, light.face_target_key, light.face_dead_band_ev),
        )
    else:
        weight, bad = light.body_weight, lighting_badness(subject, light)
    return _blend(subject, f.exposure, weight), weight * bad + (1 - weight) * photo_bad


def subject_target(cfg: LightingConfig, basis: str) -> float:
    return cfg.face_target_key if basis == "faces" else cfg.target_key


def lighting_badness(
    e: ExposureStats, cfg: LightingConfig, target: float | None = None, dead_band: float | None = None
) -> float:
    """0 for a good exposure; roughly 'stops of trouble' otherwise."""
    target = cfg.target_key if target is None else target
    dead_band = cfg.dead_band_ev if dead_band is None else dead_band
    off = max(0.0, abs(e.key - target) - dead_band)
    hi = cfg.clip_hi_weight * max(0.0, e.clip_hi - cfg.clip_hi_free)
    lo = cfg.clip_lo_weight * max(0.0, e.clip_lo - cfg.clip_lo_free)
    flat = cfg.range_weight * max(0.0, cfg.min_range_ev - e.range)
    return off + hi + lo + flat
