"""Per-photo measurements: exposure (of the photo, its faces and its people), sharpness, faces with
eye state and smile, people, animals, and a similarity embedding."""

from __future__ import annotations

import hashlib
import json
import logging
from dataclasses import replace
from pathlib import Path
from typing import Any, Literal

from culler.config import Config
from culler.features.embedding import ClipEmbedder, Embedder
from culler.features.exposure import measure_exposure
from culler.features.eyes import EyeStateDetector, MediaPipeEyes, classify_eyes
from culler.features.faces import FaceDetector, relevant_faces
from culler.features.image import decode_jpeg
from culler.features.people import PeopleDetector, relevant_animals, relevant_people
from culler.features.raw_exposure import measure_raw_exposure
from culler.features.sharpness import measure_sharpness_parts
from culler.model_files import EMBEDDING_FILES, EYES_FILES, PEOPLE_FILES, missing
from culler.models import Features

log = logging.getLogger(__name__)

# Bump when a measurement changes, so cached features are recomputed.
# 2: RAW exposure from the RAW file. 3: faces, people and smiles measured apart. 4: animals.
FEATURE_VERSION = 4
# Measurements of this version are brought up to date instead of measured again: only the animals
# are new since, found on the preview (`add_animals`). Measuring again would download and decode
# every RAW file once more (about 1.5 s a photo instead of 0.1 s).
UPGRADABLE_VERSION = 3


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
                    self.people = PeopleDetector(md / "efficientdet_lite0.tflite", cfg.subjects.labels)
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

    def _key(self, version: int, analysis: dict[str, Any]) -> str:
        payload = {"v": version, "eyes": self.eyes_available, "people": self.people_available, **analysis}
        return hashlib.sha1(json.dumps(payload, sort_keys=True).encode()).hexdigest()[:16]

    @property
    def cache_key(self) -> str:
        """Changes whenever cached features would come out differently."""
        return self._key(FEATURE_VERSION, self.cfg.analysis_dict())

    @property
    def upgradable_key(self) -> str:
        """The key UPGRADABLE_VERSION gave the same settings (it didn't look for animals)."""
        analysis = {k: v for k, v in self.cfg.analysis_dict().items() if k != "animals"}
        return self._key(UPGRADABLE_VERSION, analysis)

    def add_animals(self, f: Features, data: bytes) -> Features:
        """UPGRADABLE_VERSION's measurements with the animals added: found on Immich's preview
        (`data`, the one `f` was measured on), and sharpness on the largest. Nothing else is
        measured again, so a RAW file isn't needed."""
        rgb = decode_jpeg(data)
        h, w = rgb.shape[:2]
        found = self.people.detect(rgb) if self.people else []
        animals = relevant_animals(found, self.cfg.subjects, w, h)
        subject = None
        if animals:
            subject = measure_sharpness_parts(rgb, [face.box for face in f.faces], [a.box for a in animals]).subject
        return replace(f, animals=animals, subject_sharpness=subject)

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
        found = self.people.detect(rgb) if self.people else []
        bodies = relevant_people(found, self.cfg.people, w, h)
        animals = relevant_animals(found, self.cfg.subjects, w, h)
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
        sharp = measure_sharpness_parts(rgb, boxes, [a.box for a in animals])
        return Features(
            asset_id=asset_id,
            source=source,
            width=w,
            height=h,
            exposure=measured.photo,
            sharpness=sharp.photo if sharp.face is None else sharp.face,
            faces=faces,
            embedding=self.embedder.embed(rgb) if self.embedder else None,
            exposure_source=exposure_source,
            bodies=bodies,
            face_exposure=measured.faces,
            body_exposure=measured.people,
            photo_sharpness=sharp.photo,
            face_sharpness=sharp.face is not None,
            animals=animals,
            subject_sharpness=sharp.subject,
        )
