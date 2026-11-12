"""Image embeddings for "do these two frames show the same scene?".

Uses Immich's own CLIP ViT-B/32 image model (ONNX, from huggingface.co/immich-app/ViT-B-32__openai).
Levels are stretched first, so a darker or brighter frame of the same scene still lands close by.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Protocol

import cv2
import numpy as np


class Embedder(Protocol):
    def embed(self, rgb: np.ndarray) -> np.ndarray:
        """Unit-length vector."""
        ...


def cosine(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.dot(a, b))


def stretch_levels(rgb: np.ndarray) -> np.ndarray:
    lo, hi = np.percentile(rgb, [1, 99])
    if hi - lo < 8:
        return rgb
    out = (rgb.astype(np.float32) - lo) * (255.0 / (hi - lo))
    return np.clip(out, 0, 255).astype(np.uint8)


def clip_input(rgb: np.ndarray, size: int, mean: np.ndarray, std: np.ndarray) -> np.ndarray:
    """Resize the shorter side to `size`, centre crop, normalise; NCHW float32.

    Downscaling uses area averaging: like the anti-aliased bicubic resize CLIP was trained with
    (PIL), unlike OpenCV's plain bicubic, which aliases sharp photos and pushes them away from
    blurred frames of the same scene."""
    h, w = rgb.shape[:2]
    scale = size / min(h, w)
    interp = cv2.INTER_AREA if scale < 1 else cv2.INTER_CUBIC
    resized = cv2.resize(rgb, (max(size, round(w * scale)), max(size, round(h * scale))), interpolation=interp)
    rh, rw = resized.shape[:2]
    top, left = (rh - size) // 2, (rw - size) // 2
    crop = resized[top : top + size, left : left + size].astype(np.float32) / 255.0
    crop = (crop - mean) / std
    return np.ascontiguousarray(crop.transpose(2, 0, 1)[None])


class ClipEmbedder:
    def __init__(self, model_path: Path, preprocess_path: Path, threads: int = 2):
        import onnxruntime as ort

        cfg = json.loads(preprocess_path.read_text(encoding="utf-8"))
        self.size = int(cfg["size"][0] if isinstance(cfg["size"], list) else cfg["size"])
        self.mean = np.array(cfg["mean"], np.float32)
        self.std = np.array(cfg["std"], np.float32)
        opts = ort.SessionOptions()
        opts.intra_op_num_threads = threads
        opts.inter_op_num_threads = 1
        self.session = ort.InferenceSession(str(model_path), opts, providers=["CPUExecutionProvider"])
        self.input_name = self.session.get_inputs()[0].name

    def embed(self, rgb: np.ndarray) -> np.ndarray:
        x = clip_input(stretch_levels(rgb), self.size, self.mean, self.std)
        v = self.session.run(None, {self.input_name: x})[0][0].astype(np.float32)
        n = float(np.linalg.norm(v))
        return v / n if n > 0 else v
