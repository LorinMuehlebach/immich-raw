"""The model files the analysis needs, downloaded once and checked against pinned hashes."""

from __future__ import annotations

import hashlib
import logging
from pathlib import Path

import httpx

log = logging.getLogger(__name__)

# name: (url, sha256). Licences: CLIP MIT (OpenAI, ONNX export by Immich), YuNet MIT (OpenCV Zoo),
# FaceLandmarker Apache-2.0 (Google MediaPipe).
MODELS: dict[str, tuple[str, str]] = {
    "clip_visual.onnx": (
        "https://huggingface.co/immich-app/ViT-B-32__openai/resolve/main/visual/model.onnx",
        "33a3df41ceef21acdf371af00f6dd0456ec1f9eba24d03a7720f9c3734e40859",
    ),
    "clip_preprocess_cfg.json": (
        "https://huggingface.co/immich-app/ViT-B-32__openai/resolve/main/visual/preprocess_cfg.json",
        "c4fd008cd177c58a8fe107b099bac98913eaa6be6114dd59a4b45145c3c7673f",
    ),
    "yunet.onnx": (
        "https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx",
        "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4",
    ),
    "face_landmarker.task": (
        "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
        "64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff",
    ),
}

EMBEDDING_FILES = ("clip_visual.onnx", "clip_preprocess_cfg.json")
EYES_FILES = ("yunet.onnx", "face_landmarker.task")


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def missing(models_dir: Path, names: tuple[str, ...] = tuple(MODELS)) -> list[str]:
    return [n for n in names if not (models_dir / n).is_file()]


def fetch_models(models_dir: Path, verify_existing: bool = False) -> None:
    models_dir.mkdir(parents=True, exist_ok=True)
    for name, (url, digest) in MODELS.items():
        target = models_dir / name
        if target.is_file() and (not verify_existing or sha256_of(target) == digest):
            continue
        log.info("downloading %s", name)
        part = target.with_suffix(target.suffix + ".part")
        h = hashlib.sha256()
        with httpx.stream("GET", url, follow_redirects=True, timeout=120) as res, part.open("wb") as f:
            res.raise_for_status()
            for chunk in res.iter_bytes(1 << 20):
                h.update(chunk)
                f.write(chunk)
        if h.hexdigest() != digest:
            part.unlink(missing_ok=True)
            raise RuntimeError(f"{name}: checksum mismatch (got {h.hexdigest()})")
        part.replace(target)
