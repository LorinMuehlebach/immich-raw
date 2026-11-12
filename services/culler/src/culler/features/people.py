"""People, also without a usable face (from the side, from behind, far away), and animals:
MediaPipe's object detector with EfficientDet-Lite0, trained on COCO, keeping only its 'person' class
and its animals."""

from __future__ import annotations

from pathlib import Path

import numpy as np

from culler.config import PeopleConfig, SubjectsConfig
from culler.models import BodyInfo

DETECT_SCORE = 0.3  # the detector's own floor; the configs pick from what it finds
MAX_FOUND = 20


class PeopleDetector:
    def __init__(self, model_path: Path, animals: tuple[str, ...] = ()):
        from mediapipe.tasks.python import BaseOptions, vision

        options = vision.ObjectDetectorOptions(
            base_options=BaseOptions(model_asset_path=str(model_path)),
            running_mode=vision.RunningMode.IMAGE,
            score_threshold=DETECT_SCORE,
            category_allowlist=["person", *animals],
            max_results=MAX_FOUND,
        )
        self._detector = vision.ObjectDetector.create_from_options(options)

    def close(self) -> None:
        self._detector.close()

    def detect(self, rgb: np.ndarray) -> list[BodyInfo]:
        """People and animals, each with its COCO label."""
        import mediapipe as mp

        result = self._detector.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(rgb)))
        out = []
        for d in result.detections:
            b = d.bounding_box
            top = d.categories[0] if d.categories else None
            out.append(
                BodyInfo(
                    box=(float(b.origin_x), float(b.origin_y), float(b.width), float(b.height)),
                    score=top.score if top else 0.0,
                    label=(top.category_name if top and top.category_name else "person"),
                )
            )
        return out


def relevant_people(found: list[BodyInfo], cfg: PeopleConfig, width: int, height: int) -> list[BodyInfo]:
    """Sure enough, big enough in the photo, and not far behind the main subject."""
    area = float(width * height) or 1.0
    sure = [
        p
        for p in found
        if p.label == "person" and p.score >= cfg.min_score and p.box[2] * p.box[3] >= cfg.min_area * area
    ]
    if not sure:
        return []
    largest = max(p.box[2] * p.box[3] for p in sure)
    return [p for p in sure if p.box[2] * p.box[3] >= cfg.min_area_ratio * largest]


def relevant_animals(found: list[BodyInfo], cfg: SubjectsConfig, width: int, height: int) -> list[BodyInfo]:
    """The animals sure enough and big enough to judge, largest first."""
    area = float(width * height) or 1.0
    sure = [
        a
        for a in found
        if a.label in cfg.labels and a.score >= cfg.min_score and a.box[2] * a.box[3] >= cfg.min_area * area
    ]
    return sorted(sure, key=lambda a: a.box[2] * a.box[3], reverse=True)
