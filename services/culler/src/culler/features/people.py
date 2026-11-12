"""People, also without a usable face (from the side, from behind, far away): MediaPipe's object
detector with EfficientDet-Lite0, trained on COCO, keeping only its 'person' class."""

from __future__ import annotations

from pathlib import Path

import numpy as np

from culler.config import PeopleConfig
from culler.models import BodyInfo

DETECT_SCORE = 0.3  # the detector's own floor; PeopleConfig.min_score picks from what it finds
MAX_PEOPLE = 10


class PeopleDetector:
    def __init__(self, model_path: Path):
        from mediapipe.tasks.python import BaseOptions, vision

        options = vision.ObjectDetectorOptions(
            base_options=BaseOptions(model_asset_path=str(model_path)),
            running_mode=vision.RunningMode.IMAGE,
            score_threshold=DETECT_SCORE,
            category_allowlist=["person"],
            max_results=MAX_PEOPLE,
        )
        self._detector = vision.ObjectDetector.create_from_options(options)

    def close(self) -> None:
        self._detector.close()

    def detect(self, rgb: np.ndarray) -> list[BodyInfo]:
        import mediapipe as mp

        result = self._detector.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(rgb)))
        out = []
        for d in result.detections:
            b = d.bounding_box
            score = d.categories[0].score if d.categories else 0.0
            out.append(
                BodyInfo(box=(float(b.origin_x), float(b.origin_y), float(b.width), float(b.height)), score=score)
            )
        return out


def relevant_people(people: list[BodyInfo], cfg: PeopleConfig, width: int, height: int) -> list[BodyInfo]:
    """Sure enough, big enough in the photo, and not far behind the main subject."""
    area = float(width * height) or 1.0
    sure = [p for p in people if p.score >= cfg.min_score and p.box[2] * p.box[3] >= cfg.min_area * area]
    if not sure:
        return []
    largest = max(p.box[2] * p.box[3] for p in sure)
    return [p for p in sure if p.box[2] * p.box[3] >= cfg.min_area_ratio * largest]
