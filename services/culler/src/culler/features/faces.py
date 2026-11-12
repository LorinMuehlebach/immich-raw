"""Face detection (YuNet, bundled with OpenCV) and the choice of which faces matter."""

from __future__ import annotations

import math
from pathlib import Path

import cv2
import numpy as np

from culler.config import EyesConfig
from culler.models import FaceInfo


class FaceDetector:
    def __init__(self, model_path: Path, score: float = 0.7):
        self._det = cv2.FaceDetectorYN.create(str(model_path), "", (320, 320), score, 0.3, 50)

    def detect(self, rgb: np.ndarray) -> list[FaceInfo]:
        h, w = rgb.shape[:2]
        self._det.setInputSize((w, h))
        _, faces = self._det.detect(cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR))
        if faces is None:
            return []
        out = []
        for f in faces:
            pts = tuple((float(f[4 + 2 * i]), float(f[5 + 2 * i])) for i in range(5))
            out.append(
                FaceInfo(box=(float(f[0]), float(f[1]), float(f[2]), float(f[3])), score=float(f[14]), landmarks=pts)
            )
        return out


def yaw_proxy(face: FaceInfo) -> float | None:
    """(nose to right eye - nose to left eye) / eye distance: 0 = facing the camera."""
    if len(face.landmarks) < 3:
        return None
    (rx, ry), (lx, ly), (nx, ny) = face.landmarks[:3]
    eyes = math.hypot(rx - lx, ry - ly)
    if eyes < 1:
        return None
    return (math.hypot(nx - rx, ny - ry) - math.hypot(nx - lx, ny - ly)) / eyes


def relevant_faces(faces: list[FaceInfo], cfg: EyesConfig) -> list[FaceInfo]:
    """Faces big enough, close to the main subject's size, and roughly facing the camera."""
    big = [f for f in faces if f.score >= cfg.detector_score and min(f.box[2], f.box[3]) >= cfg.min_face_px]
    if not big:
        return []
    largest = max(f.box[2] * f.box[3] for f in big)
    out = []
    for f in big:
        if f.box[2] * f.box[3] < cfg.min_face_area_ratio * largest:
            continue
        yp = yaw_proxy(f)
        if yp is not None and abs(yp) > cfg.max_yaw_proxy:
            continue
        out.append(f)
    return out
