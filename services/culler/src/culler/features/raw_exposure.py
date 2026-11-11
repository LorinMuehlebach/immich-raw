"""Exposure of a RAW frame, measured on the RAW file itself.

Immich renders RAW previews with LibRaw's automatic brightness, which evens out exposure: a test
frame 1.5 stops darker got the same preview as the normal one (docs/spike-results.md). So for
RAW frames the lighting check decodes the file without it: linear, camera white balance, half
size. Clipping is counted at the sensor's white level. The key is shifted by the headroom a
camera keeps above its JPEG, so it compares with keys measured on JPEGs and previews.
"""

from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np

from culler.features.exposure import ANALYSIS_EDGE, exposure_from_linear
from culler.models import ExposureStats

CLIP = 0.98  # of the white level (after white balance)
BLACK = 2.0**-9


def measure_raw_exposure(
    path: Path,
    face_boxes: list[tuple[float, float, float, float]] | None,
    preview_width: int,
    face_weight: float,
    headroom_ev: float,
) -> ExposureStats:
    """`face_boxes` are in the coordinates of Immich's preview, which is `preview_width` wide."""
    import rawpy

    with rawpy.imread(str(path)) as raw:
        rgb = raw.postprocess(
            half_size=True,
            no_auto_bright=True,
            use_camera_wb=True,
            output_bps=16,
            gamma=(1, 1),
            output_color=rawpy.ColorSpace.sRGB,
        )
    peak = rgb.max(axis=2)
    clip_hi = float((peak >= CLIP * 65535).mean())
    clip_lo = float((peak <= BLACK * 65535).mean())
    h, w = rgb.shape[:2]
    scale = ANALYSIS_EDGE / max(h, w)
    if scale < 1:
        rgb = cv2.resize(rgb, (max(1, round(w * scale)), max(1, round(h * scale))), interpolation=cv2.INTER_AREA)
    lin = rgb.astype(np.float32) / 65535
    return exposure_from_linear(
        lin, clip_hi, clip_lo, face_boxes, lin.shape[1] / preview_width, face_weight, key_offset=headroom_ev
    )
