"""Sharpness of the subject, comparable between frames of the same scene.

1. Grey at 1024 px, contrast stretched (1st to 99th percentile), so a darker frame does not
   look softer just because its edges have less contrast.
2. Fine detail = difference of Gaussians (sigma 0.8 minus 2.0), squared, averaged per tile.
3. Noise floor: the energy of the flattest tiles is subtracted, so a grainy high-ISO frame does
   not look sharp.
4. Subject: the eye band of the largest face; without faces, the sharpest 5 % of tiles (a
   blurred background or a moving edge of the frame doesn't matter).
"""

from __future__ import annotations

import math

import cv2
import numpy as np

from culler.features.image import fit_long_edge, gray

ANALYSIS_EDGE = 1024
GRID_LONG, GRID_SHORT = 16, 12


def _detail_energy(rgb: np.ndarray) -> np.ndarray | None:
    g = gray(fit_long_edge(rgb, ANALYSIS_EDGE))
    lo, hi = np.percentile(g, [1, 99])
    if hi - lo < 1e-3:
        return None
    g = np.clip((g - lo) / (hi - lo), 0.0, 1.0)
    band = cv2.GaussianBlur(g, (0, 0), 0.8) - cv2.GaussianBlur(g, (0, 0), 2.0)
    return band * band


def _tiles(energy: np.ndarray) -> np.ndarray:
    h, w = energy.shape
    rows, cols = (GRID_SHORT, GRID_LONG) if w >= h else (GRID_LONG, GRID_SHORT)
    th, tw = max(1, h // rows), max(1, w // cols)
    rows, cols = h // th, w // tw
    return energy[: th * rows, : tw * cols].reshape(rows, th, cols, tw).mean(axis=(1, 3)).ravel()


def measure_sharpness(rgb: np.ndarray, face_boxes: list[tuple[float, float, float, float]] | None = None) -> float:
    """`face_boxes` are in the pixel coordinates of `rgb`. Larger is sharper; 0 = no detail."""
    energy = _detail_energy(rgb)
    if energy is None:
        return 0.0
    tiles = _tiles(energy)
    floor = float(np.percentile(tiles, 10))

    if face_boxes:
        scale = energy.shape[1] / rgb.shape[1]
        x, y, w, h = max(face_boxes, key=lambda b: b[2] * b[3])
        x0, x1 = int(x * scale), int((x + w) * scale) + 1
        y0, y1 = int((y + 0.2 * h) * scale), int((y + 0.55 * h) * scale) + 1  # brows to cheeks
        region = energy[max(0, y0) : y1, max(0, x0) : x1]
        if region.size >= 64:
            return math.sqrt(max(0.0, float(region.mean()) - floor))

    k = max(3, math.ceil(0.05 * tiles.size))
    top = np.sort(tiles)[-k:]
    return math.sqrt(max(0.0, float(top.mean()) - floor))
