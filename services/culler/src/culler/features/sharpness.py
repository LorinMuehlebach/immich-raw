"""Sharpness of the subject, comparable between frames of the same scene.

1. Grey at 1024 px, contrast stretched (1st to 99th percentile), so a darker frame does not
   look softer just because its edges have less contrast.
2. Fine detail = difference of Gaussians (sigma 0.8 minus 2.0), squared, averaged per tile.
3. Noise floor: the energy of the flattest tiles is subtracted, so a grainy high-ISO frame does
   not look sharp.
4. Subject: the eye band of the largest face; else the largest animal's box (its sharpest
   quarter, so the plain parts of fur or feathers don't count); else the sharpest 5 % of tiles (a
   blurred background or a moving edge of the frame doesn't matter). All are kept, so a group where
   only some shots show a face or an animal is compared on what every shot has.
"""

from __future__ import annotations

import math
from typing import NamedTuple

import cv2
import numpy as np

from culler.features.image import fit_long_edge, gray

ANALYSIS_EDGE = 1024
GRID_LONG, GRID_SHORT = 16, 12
BOX_GRID = 8  # an animal's box is cut into at most this many tiles each way
BOX_TOP_SHARE = 0.25


class SharpnessParts(NamedTuple):
    photo: float  # the sharpest 5 % of tiles
    face: float | None  # the largest face's eye band
    subject: float | None  # the largest animal's box


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


def _box_region(energy: np.ndarray, box: tuple[float, float, float, float], scale: float) -> np.ndarray:
    x, y, w, h = box
    x0, x1 = max(0, int(x * scale)), int((x + w) * scale) + 1
    y0, y1 = max(0, int(y * scale)), int((y + h) * scale) + 1
    return energy[y0:y1, x0:x1]


def _box_sharpness(region: np.ndarray, floor: float) -> float | None:
    """The sharpest quarter of the box's tiles, above the photo's noise floor."""
    h, w = region.shape
    if h < 8 or w < 8:
        return None
    th, tw = max(2, h // BOX_GRID), max(2, w // BOX_GRID)
    rows, cols = h // th, w // tw
    tiles = region[: th * rows, : tw * cols].reshape(rows, th, cols, tw).mean(axis=(1, 3)).ravel()
    k = max(1, math.ceil(BOX_TOP_SHARE * tiles.size))
    return math.sqrt(max(0.0, float(np.sort(tiles)[-k:].mean()) - floor))


def measure_sharpness_parts(
    rgb: np.ndarray,
    face_boxes: list[tuple[float, float, float, float]] | None = None,
    subject_boxes: list[tuple[float, float, float, float]] | None = None,
) -> SharpnessParts:
    """Larger is sharper. Boxes are in the pixel coordinates of `rgb`."""
    energy = _detail_energy(rgb)
    if energy is None:
        return SharpnessParts(0.0, None, None)
    tiles = _tiles(energy)
    floor = float(np.percentile(tiles, 10))
    k = max(3, math.ceil(0.05 * tiles.size))
    photo = math.sqrt(max(0.0, float(np.sort(tiles)[-k:].mean()) - floor))
    scale = energy.shape[1] / rgb.shape[1]

    face = None
    if face_boxes:
        x, y, w, h = max(face_boxes, key=lambda b: b[2] * b[3])
        x0, x1 = int(x * scale), int((x + w) * scale) + 1
        y0, y1 = int((y + 0.2 * h) * scale), int((y + 0.55 * h) * scale) + 1  # brows to cheeks
        region = energy[max(0, y0) : y1, max(0, x0) : x1]
        if region.size >= 64:
            face = math.sqrt(max(0.0, float(region.mean()) - floor))

    subject = None
    if subject_boxes:
        largest = max(subject_boxes, key=lambda b: b[2] * b[3])
        subject = _box_sharpness(_box_region(energy, largest, scale), floor)
    return SharpnessParts(photo, face, subject)


def measure_sharpness(rgb: np.ndarray, face_boxes: list[tuple[float, float, float, float]] | None = None) -> float:
    """`face_boxes` are in the pixel coordinates of `rgb`. The face when measurable, else the photo."""
    parts = measure_sharpness_parts(rgb, face_boxes)
    return parts.photo if parts.face is None else parts.face
