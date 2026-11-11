"""Makes test bursts from real photos: variants that a culler should tell apart.

Usage: python scripts/make_burst.py <out-dir> <a.jpg> <b.jpg> <c.jpg> <d.jpg> [--linear16]

  Scene A: base, 1.5 stops darker, blurred, shifted (sharp), 1.7 stops brighter; 1 s apart.
  Scene B: base, blurred, shifted; 5 minutes later.
  Scene C: one photo, 30 minutes later.
  Scene D: base, blurred, shifted; an hour later.

Variants are made in linear light, the way a camera would capture them. Writes a JPEG per shot
and manifest.json (file, seconds after the first shot, expected outcome: "best-candidate",
"lighting", "blur" or "single"). With --linear16 it also writes <name>.rgb16: linear RGB,
16-bit little-endian, scaled like a sensor (white = clipping, one stop of headroom over the
JPEG), for e2e/raw-burst.mjs to wrap into DNG files.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import cv2
import numpy as np

LONG_EDGE = 1600
RAW_HEADROOM = 0.5  # the base frame's JPEG white sits one stop below sensor clipping


def load_linear(path: Path) -> np.ndarray:
    img = cv2.imread(str(path), cv2.IMREAD_COLOR)
    if img is None:
        raise SystemExit(f"cannot read {path}")
    h, w = img.shape[:2]
    s = LONG_EDGE / max(h, w)
    if s < 1:
        img = cv2.resize(img, (round(w * s) // 2 * 2, round(h * s) // 2 * 2), interpolation=cv2.INTER_AREA)
    srgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB).astype(np.float32) / 255
    return np.where(srgb <= 0.04045, srgb / 12.92, ((srgb + 0.055) / 1.055) ** 2.4).astype(np.float32)


def to_srgb8(lin: np.ndarray) -> np.ndarray:
    lin = np.clip(lin, 0, 1)
    s = np.where(lin <= 0.0031308, lin * 12.92, 1.055 * np.power(lin, 1 / 2.4) - 0.055)
    return np.clip(np.round(s * 255), 0, 255).astype(np.uint8)


def shift(lin: np.ndarray, dx: float, dy: float) -> np.ndarray:
    h, w = lin.shape[:2]
    m = np.float32([[1.02, 0, -0.01 * w + dx * w], [0, 1.02, -0.01 * h + dy * h]])  # slight zoom + move
    return cv2.warpAffine(lin, m, (w, h), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REFLECT)


def capture(scene: np.ndarray, ev: float = 0.0, blur: float = 0.0, move: tuple[float, float] | None = None) -> np.ndarray:
    """Linear scene light as the sensor sees it (1.0 = JPEG white), before clipping."""
    lin = scene * 2.0**ev
    if move:
        lin = shift(lin, *move)
    if blur:
        lin = cv2.GaussianBlur(lin, (0, 0), blur)
    return lin


def main(argv: list[str]) -> None:
    linear16 = "--linear16" in argv
    args = [a for a in argv if a != "--linear16"]
    if len(args) != 5:
        raise SystemExit(__doc__)
    out = Path(args[0])
    out.mkdir(parents=True, exist_ok=True)
    a, b, c, d = (load_linear(Path(p)) for p in args[1:])
    shots = [
        ("burst_a0", 0, capture(a), "best-candidate"),
        ("burst_a1", 1, capture(a, ev=-1.5), "lighting"),
        ("burst_a2", 2, capture(a, blur=3.0), "blur"),
        ("burst_a3", 3, capture(a, move=(0.01, 0.005)), "best-candidate"),
        ("burst_a4", 4, capture(a, ev=1.7), "lighting"),
        ("burst_b0", 300, capture(b), "best-candidate"),
        ("burst_b1", 301, capture(b, blur=3.0), "blur"),
        ("burst_b2", 302, capture(b, move=(-0.01, 0.0)), "best-candidate"),
        ("burst_c0", 1800, capture(c), "single"),
        ("burst_d0", 3600, capture(d), "best-candidate"),
        ("burst_d1", 3601, capture(d, blur=3.0), "blur"),
        ("burst_d2", 3602, capture(d, move=(0.0, 0.01)), "best-candidate"),
    ]
    manifest = []
    for name, seconds, lin, expect in shots:
        cv2.imwrite(str(out / f"{name}.jpg"), cv2.cvtColor(to_srgb8(lin), cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, 92])
        entry = {"name": name, "file": f"{name}.jpg", "seconds": seconds, "expect": expect, "scene": name[6]}
        if linear16:
            sensor = np.clip(lin * RAW_HEADROOM, 0, 1)
            (out / f"{name}.rgb16").write_bytes(np.round(sensor * 65535).astype("<u2").tobytes())
            entry.update(raw=f"{name}.rgb16", width=lin.shape[1], height=lin.shape[0])
        manifest.append(entry)
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(f"wrote {len(shots)} photos to {out}")


if __name__ == "__main__":
    main(sys.argv[1:])
