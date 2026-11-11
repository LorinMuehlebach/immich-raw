"""Lighting: how far a frame's brightness and clipping are from a good exposure.

The key (typical brightness) uses the same maths as the editor's Auto tone
(packages/pipeline/src/auto.ts): half median, half 2-98 % trimmed mean of log2 luminance.
Here it is weighted, so faces (or else the centre) count more than the edges.
"""

from __future__ import annotations

import math

import numpy as np

from culler.config import LightingConfig
from culler.features.image import fit_long_edge, to_linear
from culler.models import ExposureStats

ANALYSIS_EDGE = 512
LOG_FLOOR = 1 / 4096


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


def face_mask(h: int, w: int, boxes: list[tuple[float, float, float, float]], scale: float) -> np.ndarray:
    mask = np.zeros((h, w), np.float32)
    for x, y, bw, bh in boxes:
        x0, y0 = max(0, int(x * scale)), max(0, int(y * scale))
        x1, y1 = min(w, int((x + bw) * scale) + 1), min(h, int((y + bh) * scale) + 1)
        mask[y0:y1, x0:x1] = 1.0
    return mask


def exposure_from_linear(
    lin: np.ndarray,
    clip_hi: float,
    clip_lo: float,
    face_boxes: list[tuple[float, float, float, float]] | None,
    box_scale: float,
    face_weight: float,
    key_offset: float = 0.0,
) -> ExposureStats:
    """Key and range from linear RGB (float, 1.0 = white); `face_boxes` * `box_scale` = pixels of `lin`."""
    h, w = lin.shape[:2]
    y = lin[..., 0] * 0.2126 + lin[..., 1] * 0.7152 + lin[..., 2] * 0.0722
    log_y = np.log2(np.maximum(y, LOG_FLOOR)).ravel()
    key = _weighted_key(log_y, centre_weights(h, w).ravel())
    if face_boxes:
        mask = face_mask(h, w, face_boxes, box_scale).ravel()
        if mask.sum() >= 16:
            face_key = _weighted_key(log_y[mask > 0], np.ones(int((mask > 0).sum()), np.float32))
            key = face_weight * face_key + (1 - face_weight) * key
    p5, p95 = np.percentile(log_y, [5, 95])
    return ExposureStats(key=key + key_offset, clip_hi=clip_hi, clip_lo=clip_lo, range=float(p95 - p5))


def measure_exposure(
    rgb: np.ndarray,
    face_boxes: list[tuple[float, float, float, float]] | None = None,
    face_weight: float = 0.6,
) -> ExposureStats:
    """From an sRGB image (a preview or JPEG); `face_boxes` are in the pixel coordinates of `rgb`."""
    small = fit_long_edge(rgb, ANALYSIS_EDGE)
    peak = small.max(axis=2)
    clip_hi = float((peak >= 250).mean())
    clip_lo = float((peak <= 5).mean())
    return exposure_from_linear(
        to_linear(small), clip_hi, clip_lo, face_boxes, small.shape[1] / rgb.shape[1], face_weight
    )


def lighting_badness(e: ExposureStats, cfg: LightingConfig) -> float:
    """0 for a good exposure; roughly 'stops of trouble' otherwise."""
    off = max(0.0, abs(e.key - cfg.target_key) - cfg.dead_band_ev)
    hi = cfg.clip_hi_weight * max(0.0, e.clip_hi - cfg.clip_hi_free)
    lo = cfg.clip_lo_weight * max(0.0, e.clip_lo - cfg.clip_lo_free)
    flat = cfg.range_weight * max(0.0, cfg.min_range_ev - e.range)
    return off + hi + lo + flat
