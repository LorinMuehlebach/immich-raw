"""Synthetic scenes: a seeded arrangement of shapes with fine texture, rendered in linear light so
exposure changes are exact."""

from __future__ import annotations

import os
from datetime import UTC, datetime, timedelta

# numpy/OpenBLAS reserve memory per thread at import; keep tests light.
os.environ.setdefault("OPENBLAS_NUM_THREADS", "2")
os.environ.setdefault("OMP_NUM_THREADS", "2")

import cv2  # noqa: E402
import numpy as np  # noqa: E402
import pytest  # noqa: E402


def make_scene(seed: int = 0, h: int = 960, w: int = 1440) -> np.ndarray:
    """Linear RGB float32 in [0, 1] with a typical brightness close to the editor's target."""
    rng = np.random.default_rng(seed)
    img = np.zeros((h, w, 3), np.float32)
    sky = np.linspace(0.30, 0.12, h, dtype=np.float32)[:, None, None] * np.array([0.8, 0.9, 1.1], np.float32)
    img[:] = sky
    for _ in range(70):
        # Reflectances spread over ~6 stops, like a real scene with shadows and bright surfaces.
        colour = (2.0 ** rng.uniform(-6.5, -0.5) * rng.uniform(0.7, 1.15, 3)).tolist()
        if rng.random() < 0.5:
            x, y = int(rng.integers(0, w)), int(rng.integers(0, h))
            cv2.rectangle(img, (x, y), (x + int(rng.integers(20, 300)), y + int(rng.integers(20, 300))), colour, -1)
        else:
            centre = (int(rng.integers(0, w)), int(rng.integers(0, h)))
            cv2.circle(img, centre, int(rng.integers(10, 150)), colour, -1, lineType=cv2.LINE_AA)
    texture = cv2.GaussianBlur(rng.normal(0, 1, (h, w)).astype(np.float32), (0, 0), 0.7)
    img *= (1 + 0.25 * texture)[..., None]
    return np.clip(img, 0, 1)


def to_srgb(linear: np.ndarray) -> np.ndarray:
    lin = np.clip(linear, 0, 1)
    s = np.where(lin <= 0.0031308, lin * 12.92, 1.055 * np.power(lin, 1 / 2.4) - 0.055)
    return np.clip(np.round(s * 255), 0, 255).astype(np.uint8)


def variant(
    scene: np.ndarray,
    ev: float = 0.0,
    blur: float = 0.0,
    noise: float = 0.0,
    shift: tuple[int, int] = (0, 0),
    seed: int = 1,
) -> np.ndarray:
    """sRGB uint8 frame: exposure in stops, Gaussian blur sigma (px), noise sigma (0-255 scale), shift (px)."""
    rgb = to_srgb(scene * 2.0**ev)
    if shift != (0, 0):
        m = np.float32([[1, 0, shift[0]], [0, 1, shift[1]]])
        rgb = cv2.warpAffine(rgb, m, (rgb.shape[1], rgb.shape[0]), borderMode=cv2.BORDER_REFLECT)
    if blur > 0:
        rgb = cv2.GaussianBlur(rgb, (0, 0), blur)
    if noise > 0:
        n = np.random.default_rng(seed).normal(0, noise, rgb.shape)
        rgb = np.clip(rgb.astype(np.float32) + n, 0, 255).astype(np.uint8)
    return rgb


@pytest.fixture(scope="session")
def scene() -> np.ndarray:
    return make_scene(0)


@pytest.fixture(scope="session")
def other_scene() -> np.ndarray:
    return make_scene(7)


T0 = datetime(2024, 5, 1, 10, 0, 0, tzinfo=UTC)


def asset(id: str, name: str, seconds: float = 0.0, **kw):
    """An Asset for pure-function tests: `seconds` after T0."""
    from culler.models import Asset

    defaults = dict(
        owner_id="owner",
        taken=T0 + timedelta(seconds=seconds),
        local_date="2024-05-01",
        uploaded=T0 + timedelta(days=1, seconds=seconds),
        checksum=f"sum-{id}",
        thumbhash="th",
        make="Sony",
        model="A7",
    )
    defaults.update(kw)
    return Asset(id=id, name=name, **defaults)
