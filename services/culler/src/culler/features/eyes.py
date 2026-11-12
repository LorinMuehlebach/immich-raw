"""Open or closed eyes, and smiles, per face.

MediaPipe's FaceLandmarker runs on a square crop around each face that YuNet found (it misses
small faces in a whole photo) and gives blink and smile scores, landmarks and the head pose. The
eye opening from the landmarks (height / width, "eye aspect ratio") separates open from closed
eyes more reliably than the blink scores alone, so both are used.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, Protocol

import cv2
import numpy as np

from culler.config import EyesConfig
from culler.models import FaceInfo

CROP_SCALE = 1.6
CROP_SIZE = 256

# MediaPipe face mesh: corner, upper lid (2), corner, lower lid (2), per eye.
RIGHT_EYE = (33, 160, 158, 133, 153, 144)
LEFT_EYE = (362, 385, 387, 263, 373, 380)


@dataclass(frozen=True)
class EyeMeasure:
    blink: tuple[float, float]  # left, right (0 = open, 1 = closed)
    ear: tuple[float, float]  # eye opening, left and right
    yaw: float | None = None  # degrees
    pitch: float | None = None
    smile: float | None = None  # 0 = neutral, 1 = a broad smile


class EyeStateDetector(Protocol):
    def measure(self, rgb: np.ndarray, face: FaceInfo) -> EyeMeasure | None:
        """None when no face was found in the crop."""
        ...


def classify_eyes(m: EyeMeasure, cfg: EyesConfig) -> Literal["open", "closed", "unknown"]:
    if m.yaw is not None and abs(m.yaw) > cfg.max_yaw_deg:
        return "unknown"  # profile: one eye is hidden
    if m.pitch is not None and abs(m.pitch) > cfg.max_pitch_deg:
        return "unknown"
    opening = (m.ear[0] + m.ear[1]) / 2
    if opening < cfg.ear_closed or min(m.blink) >= cfg.blink_closed:
        return "closed"
    return "open"


def smile_score(blendshapes: dict[str, float]) -> float | None:
    """Both mouth corners averaged: one side alone smiles less on a face turned away."""
    sides = [blendshapes[k] for k in ("mouthSmileLeft", "mouthSmileRight") if k in blendshapes]
    return sum(sides) / len(sides) if sides else None


def eye_aspect_ratio(points: list[tuple[float, float]], idx: tuple[int, ...]) -> float:
    p = [np.asarray(points[i]) for i in idx]
    width = float(np.linalg.norm(p[0] - p[3]))
    if width < 1e-6:
        return 0.0
    return float(np.linalg.norm(p[1] - p[5]) + np.linalg.norm(p[2] - p[4])) / (2 * width)


def face_crop(rgb: np.ndarray, box: tuple[float, float, float, float]) -> np.ndarray:
    x, y, w, h = box
    side = CROP_SCALE * max(w, h)
    cx, cy = x + w / 2, y + h / 2
    x0, y0 = round(cx - side / 2), round(cy - side / 2)
    x1, y1 = x0 + round(side), y0 + round(side)
    H, W = rgb.shape[:2]
    pad = max(0, -x0, -y0, x1 - W, y1 - H)
    src = cv2.copyMakeBorder(rgb, pad, pad, pad, pad, cv2.BORDER_REPLICATE) if pad else rgb
    crop = src[y0 + pad : y1 + pad, x0 + pad : x1 + pad]
    return cv2.resize(crop, (CROP_SIZE, CROP_SIZE), interpolation=cv2.INTER_AREA)


def head_pose(matrix: np.ndarray) -> tuple[float, float]:
    """Yaw and pitch in degrees from MediaPipe's facial transformation matrix."""
    r = np.asarray(matrix, dtype=np.float64)[:3, :3]
    pitch = math.degrees(math.atan2(r[2, 1], r[2, 2]))
    yaw = math.degrees(math.atan2(-r[2, 0], math.hypot(r[2, 1], r[2, 2])))
    return yaw, pitch


class MediaPipeEyes:
    def __init__(self, model_path: Path):
        from mediapipe.tasks.python import BaseOptions, vision

        options = vision.FaceLandmarkerOptions(
            base_options=BaseOptions(model_asset_path=str(model_path)),
            running_mode=vision.RunningMode.IMAGE,
            num_faces=1,
            min_face_detection_confidence=0.3,
            output_face_blendshapes=True,
            output_facial_transformation_matrixes=True,
        )
        self._landmarker = vision.FaceLandmarker.create_from_options(options)

    def close(self) -> None:
        """MediaPipe's own cleanup fails noisily at interpreter exit; close before that."""
        self._landmarker.close()

    def measure(self, rgb: np.ndarray, face: FaceInfo) -> EyeMeasure | None:
        import mediapipe as mp

        crop = np.ascontiguousarray(face_crop(rgb, face.box))
        result = self._landmarker.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=crop))
        if not result.face_blendshapes or not result.face_landmarks:
            return None
        scores = {c.category_name: c.score for c in result.face_blendshapes[0]}
        points = [(p.x * CROP_SIZE, p.y * CROP_SIZE) for p in result.face_landmarks[0]]
        yaw = pitch = None
        if result.facial_transformation_matrixes:
            yaw, pitch = head_pose(result.facial_transformation_matrixes[0])
        return EyeMeasure(
            blink=(scores.get("eyeBlinkLeft", 0.0), scores.get("eyeBlinkRight", 0.0)),
            ear=(eye_aspect_ratio(points, LEFT_EYE), eye_aspect_ratio(points, RIGHT_EYE)),
            yaw=yaw,
            pitch=pitch,
            smile=smile_score(scores),
        )
