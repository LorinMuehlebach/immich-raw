"""Renders RAW files into JPEGs with LibRaw (rawpy), at half size: the stand-in for Immich's
previews, which e2e/cull.mjs feeds to make_burst.py. Build time only (deploy/demo/Dockerfile).

Usage: python previews.py <out-dir> <raw> [<raw> ...]   writes <out-dir>/0.jpg, 1.jpg, ...
"""

from __future__ import annotations

import sys
from pathlib import Path

import cv2
import rawpy


def main(argv: list[str]) -> None:
    if len(argv) < 2:
        raise SystemExit(__doc__)
    out = Path(argv[0])
    out.mkdir(parents=True, exist_ok=True)
    for i, path in enumerate(argv[1:]):
        with rawpy.imread(path) as raw:
            rgb = raw.postprocess(half_size=True, use_camera_wb=True, output_bps=8)
        cv2.imwrite(str(out / f"{i}.jpg"), cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, 92])
        print(f"{path}: {rgb.shape[1]}x{rgb.shape[0]}")


if __name__ == "__main__":
    main(sys.argv[1:])
