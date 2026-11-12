"""Decoding and resizing. Images are RGB uint8 arrays (H, W, 3) throughout."""

from __future__ import annotations

import cv2
import numpy as np


def decode_jpeg(data: bytes) -> np.ndarray:
    arr = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
    if arr is None:
        raise ValueError("not a decodable image")
    return cv2.cvtColor(arr, cv2.COLOR_BGR2RGB)


def fit_long_edge(rgb: np.ndarray, long_edge: int) -> np.ndarray:
    """Downscales so the longer side is at most `long_edge` (never upscales)."""
    h, w = rgb.shape[:2]
    scale = long_edge / max(h, w)
    if scale >= 1:
        return rgb
    return cv2.resize(rgb, (max(1, round(w * scale)), max(1, round(h * scale))), interpolation=cv2.INTER_AREA)


_SRGB_TO_LINEAR = np.array(
    [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in np.arange(256) / 255.0], dtype=np.float32
)


def to_linear(rgb: np.ndarray) -> np.ndarray:
    """sRGB uint8 -> linear float32 in [0, 1]."""
    return _SRGB_TO_LINEAR[rgb]


def linear_luminance(rgb: np.ndarray) -> np.ndarray:
    lin = to_linear(rgb)
    return lin[..., 0] * 0.2126 + lin[..., 1] * 0.7152 + lin[..., 2] * 0.0722


def gray(rgb: np.ndarray) -> np.ndarray:
    return cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY).astype(np.float32) / 255.0
