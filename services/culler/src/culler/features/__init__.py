"""Per-photo measurements: exposure (of the photo, its faces and its people), sharpness, faces with
eye state and smile, people, and a similarity embedding."""

from __future__ import annotations

import hashlib
import json
import logging
from pathlib import Path
from typing import Literal

from culler.config import Config
from culler.features.embedding import ClipEmbedder, Embedder
from culler.features.exposure import measure_exposure
from culler.features.eyes import EyeStateDetector, MediaPipeEyes, classify_eyes
from culler.features.faces import FaceDetector, relevant_faces
from culler.features.image import decode_jpeg
from culler.features.people import PeopleDetector, relevant_people
from culler.features.raw_exposure import measure_raw_exposure
from culler.features.sharpness import measure_sharpness_parts
from culler.model_files import EMBEDDING_FILES, EYES_FILES, PEOPLE_FILES, missing
from culler.models import Features

log = logging.getLogger(__name__)

# Bump when a measurement changes, so cached features are recomputed.
FEATURE_VERSION = 3  # 2: RAW exposure from the RAW file. 3: faces, people and smiles measured apart


class Analyzer:
    def __init__(
        self,
        cfg: Config,
        embedder: Embedder | None = None,
        faces: FaceDetector | None = None,
        eyes: EyeStateDetector | None = None,
        people: PeopleDetector | None = None,
        load_models: bool = True,
    ):
        self.cfg = cfg
        md = cfg.models_dir
        self.embedder = embedder
        self.faces = faces
        self.eyes = eyes
        self.people = people
        if not load_models:
            return
        if self.embedder is None:
            if missing(md, EMBEDDING_FILES):
                raise RuntimeError(f"CLIP model missing in {md}: run `culler fetch-models`")
            self.embedder = ClipEmbedder(md / "clip_visual.onnx", md / "clip_preprocess_cfg.json", cfg.threads)
        # Faces are found whether the eyes check is on or not: they also count for exposure and smiles.
        if self.faces is None or self.eyes is None:
            if missing(md, EYES_FILES):
                log.warning("face models missing in %s: no faces, eyes or smiles", md)
            else:
                try:
                    self.faces = self.faces or FaceDetector(md / "yunet.onnx", cfg.eyes.detector_score)
                    self.eyes = self.eyes or MediaPipeEyes(md / "face_landmarker.task")
                except Exception:  # mediapipe can fail to load on some platforms
                    log.exception("could not load the face models: no faces, eyes or smiles")
                    self.faces = self.eyes = None
        if self.people is None:
            if missing(md, PEOPLE_FILES):
                log.warning("people model missing in %s: people without a face are not found", md)
            else:
                try:
                    self.people = PeopleDetector(md / "efficientdet_lite0.tflite")
                except Exception:
                    log.exception("could not load the people model: people without a face are not found")

    def close(self) -> None:
        for model in (self.eyes, self.people):
            close = getattr(model, "close", None)
            if close:
                close()
        self.eyes = self.people = None

    @property
    def eyes_available(self) -> bool:
        """Faces with eye state and smile can be measured."""
        return self.faces is not None and self.eyes is not None

    @property
    def people_available(self) -> bool:
        return self.people is not None

    @property
    def cache_key(self) -> str:
        """Changes whenever cached features would come out differently."""
        payload = {
            "v": FEATURE_VERSION,
            "eyes": self.eyes_available,
            "people": self.people_available,
            **self.cfg.analysis_dict(),
        }
        return hashlib.sha1(json.dumps(payload, sort_keys=True).encode()).hexdigest()[:16]

    def analyse(
        self, data: bytes, asset_id: str, source: Literal["raw", "jpeg", "render"], raw_path: Path | None = None
    ) -> Features:
        """`data`: Immich's preview. `raw_path`: the RAW file, for exposure (see raw_exposure.py)."""
        rgb = decode_jpeg(data)
        faces = []
        if self.eyes_available:
            faces = relevant_faces(self.faces.detect(rgb), self.cfg.eyes)
            for face in faces:
                m = self.eyes.measure(rgb, face)
                if m is None:
                    continue
                face.blink, face.ear, face.yaw, face.pitch = m.blink, m.ear, m.yaw, m.pitch
                face.smile = m.smile
                face.state = classify_eyes(m, self.cfg.eyes)
        h, w = rgb.shape[:2]
        bodies = relevant_people(self.people.detect(rgb), self.cfg.people, w, h) if self.people else []
        boxes = [f.box for f in faces]
        body_boxes = [b.box for b in bodies]
        measured, exposure_source = None, "preview"
        if raw_path is not None:
            try:
                measured = measure_raw_exposure(raw_path, boxes, body_boxes, w, self.cfg.lighting.raw_headroom_ev)
                exposure_source = "raw"
            except Exception as e:  # a RAW LibRaw can't read: fall back to the preview
                log.warning("could not read the RAW file of %s (%s): measuring its preview", asset_id, e)
        measured = measured or measure_exposure(rgb, boxes, body_boxes)
        photo_sharp, face_sharp = measure_sharpness_parts(rgb, boxes)
        return Features(
            asset_id=asset_id,
            source=source,
            width=w,
            height=h,
            exposure=measured.photo,
            sharpness=photo_sharp if face_sharp is None else face_sharp,
            faces=faces,
            embedding=self.embedder.embed(rgb) if self.embedder else None,
            exposure_source=exposure_source,
            bodies=bodies,
            face_exposure=measured.faces,
            body_exposure=measured.people,
            photo_sharpness=photo_sharp,
            face_sharpness=face_sharp is not None,
        )
