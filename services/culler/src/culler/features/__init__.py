"""Per-photo measurements: exposure, sharpness, faces with eye state, and a similarity embedding."""

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
from culler.features.raw_exposure import measure_raw_exposure
from culler.features.sharpness import measure_sharpness
from culler.model_files import EMBEDDING_FILES, EYES_FILES, missing
from culler.models import Features

log = logging.getLogger(__name__)

# Bump when a measurement changes, so cached features are recomputed.
FEATURE_VERSION = 2  # 2: RAW exposure from the RAW file


class Analyzer:
    def __init__(
        self,
        cfg: Config,
        embedder: Embedder | None = None,
        faces: FaceDetector | None = None,
        eyes: EyeStateDetector | None = None,
        load_models: bool = True,
    ):
        self.cfg = cfg
        md = cfg.models_dir
        self.embedder = embedder
        self.faces = faces
        self.eyes = eyes
        if not load_models:
            return
        if self.embedder is None:
            if missing(md, EMBEDDING_FILES):
                raise RuntimeError(f"CLIP model missing in {md}: run `culler fetch-models`")
            self.embedder = ClipEmbedder(md / "clip_visual.onnx", md / "clip_preprocess_cfg.json", cfg.threads)
        if cfg.eyes.enabled and (self.faces is None or self.eyes is None):
            if missing(md, EYES_FILES):
                log.warning("face models missing in %s: the eyes check is off", md)
            else:
                try:
                    self.faces = self.faces or FaceDetector(md / "yunet.onnx", cfg.eyes.detector_score)
                    self.eyes = self.eyes or MediaPipeEyes(md / "face_landmarker.task")
                except Exception:  # mediapipe can fail to load on some platforms
                    log.exception("could not load the face models: the eyes check is off")
                    self.faces = self.eyes = None

    def close(self) -> None:
        close = getattr(self.eyes, "close", None)
        if close:
            close()
        self.eyes = None

    @property
    def eyes_available(self) -> bool:
        return self.cfg.eyes.enabled and self.faces is not None and self.eyes is not None

    @property
    def cache_key(self) -> str:
        """Changes whenever cached features would come out differently."""
        payload = {"v": FEATURE_VERSION, "eyes": self.eyes_available, **self.cfg.analysis_dict()}
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
                face.state = classify_eyes(m, self.cfg.eyes)
        boxes = [f.box for f in faces]
        light = self.cfg.lighting
        exposure, exposure_source = None, "preview"
        if raw_path is not None:
            try:
                exposure = measure_raw_exposure(raw_path, boxes, rgb.shape[1], light.face_weight, light.raw_headroom_ev)
                exposure_source = "raw"
            except Exception as e:  # a RAW LibRaw can't read: fall back to the preview
                log.warning("could not read the RAW file of %s (%s): measuring its preview", asset_id, e)
        return Features(
            asset_id=asset_id,
            source=source,
            width=rgb.shape[1],
            height=rgb.shape[0],
            exposure=exposure or measure_exposure(rgb, boxes, light.face_weight),
            sharpness=measure_sharpness(rgb, boxes),
            faces=faces,
            embedding=self.embedder.embed(rgb) if self.embedder else None,
            exposure_source=exposure_source,
        )
