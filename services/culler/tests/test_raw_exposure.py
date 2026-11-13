"""RAW exposure on real DNG files, written by the same writer the end-to-end test uses
(e2e/raw-burst.mjs, packages/dng). Skipped without Node or rawpy."""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import numpy as np
import pytest
from conftest import asset, make_scene, variant
from test_runner import DAY, TinyEmbedder, jpeg, roles, run

from culler.checks import Candidate, LightingCheck
from culler.config import Config
from culler.features import Analyzer
from culler.features.exposure import measure_exposure
from culler.features.raw_exposure import measure_raw_exposure
from culler.models import Features, Frame
from culler.runner import Runner
from culler.store import Store

pytest.importorskip("rawpy")
NODE = shutil.which("node")
RAW_BURST = Path(__file__).resolve().parents[3] / "e2e" / "raw-burst.mjs"
pytestmark = pytest.mark.skipif(not NODE or not RAW_BURST.is_file(), reason="needs Node and e2e/raw-burst.mjs")


def write_dngs(tmp: Path, frames: dict[str, np.ndarray]) -> dict[str, Path]:
    """Linear frames (1.0 = JPEG white) -> DNGs with one stop of sensor headroom."""
    manifest = []
    for i, (name, lin) in enumerate(frames.items()):
        sensor = np.clip(lin * 0.5, 0, 1)
        (tmp / f"{name}.rgb16").write_bytes(np.round(sensor * 65535).astype("<u2").tobytes())
        manifest.append(
            {"name": name, "raw": f"{name}.rgb16", "width": lin.shape[1], "height": lin.shape[0], "seconds": i}
        )
    (tmp / "manifest.json").write_text(json.dumps(manifest))
    script = (
        f"import {{ readFileSync }} from 'node:fs';"
        f"import {{ writeDng }} from {json.dumps(RAW_BURST.as_uri())};"
        f"const dir = {json.dumps(str(tmp))};"
        "for (const e of JSON.parse(readFileSync(dir + '/manifest.json', 'utf8')))"
        "  await writeDng(dir, e, Date.parse('2024-05-01T10:00:00Z') + e.seconds * 1000, 3);"
    )
    subprocess.run([NODE, "--input-type=module", "-e", script], check=True, capture_output=True, timeout=120)
    return {name: tmp / f"{name}.dng" for name in frames}


@pytest.fixture(scope="module")
def dngs(tmp_path_factory):
    scene = make_scene(4, h=480, w=720)
    frames = {"base": scene, "dark": scene * 2.0**-1.5, "bright": scene * 2.0**1.7}
    return scene, write_dngs(tmp_path_factory.mktemp("dng"), frames)


def raw_exposure(path: Path):
    return measure_raw_exposure(path, None, None, 720, headroom_ev=1.0).photo


def test_exposure_differences_survive(dngs):
    _, files = dngs
    base, dark, bright = (raw_exposure(files[k]) for k in ("base", "dark", "bright"))
    assert abs((dark.key - base.key) - -1.5) < 0.15
    assert abs((bright.key - base.key) - 1.7) < 0.25  # a little less: the brightest parts clip
    assert bright.clip_hi > base.clip_hi == 0


def test_raw_key_matches_the_jpeg_key(dngs):
    scene, files = dngs
    from_jpeg = measure_exposure(variant(scene)).photo
    assert abs(raw_exposure(files["base"]).key - from_jpeg.key) < 0.4


def test_lighting_check_on_raw_measurements(dngs):
    _, files = dngs
    cfg = Config()
    cands = []
    for i, k in enumerate(("base", "dark", "bright")):
        frame = Frame(k, (k,), k, k, None, (), asset(k, f"{k}.DNG", i).taken, None, k)
        cands.append(Candidate.of(frame, Features(k, "raw", 1, 1, raw_exposure(files[k]), 1.0), cfg))
    assert LightingCheck().eliminate(cands, cfg) == {"dark", "bright"}


def test_runner_reads_the_raw_file_when_previews_look_alike(dngs, tmp_path):
    """Immich's previews of RAWs are auto-brightened: here all three previews are the same image."""
    scene, files = dngs
    immich = __import__("fake_immich").FakeImmich()
    preview = jpeg(variant(scene))
    for i, k in enumerate(("base", "dark", "bright")):
        immich.add(asset(k, f"{k}.DNG", i, make="Immich-RAW", model="Test Camera"), preview)
        immich.originals[k] = files[k].read_bytes()
    store = Store(tmp_path / "s.sqlite")
    runner = Runner(
        Config(data_dir=tmp_path), immich, store, lambda c: Analyzer(c, embedder=TinyEmbedder(), load_models=False)
    )
    _, report = run(runner, dry_run=True, scope=DAY)
    r = roles(report)
    assert r["base"] == ("best", None)
    assert r["dark"] == ("rejected", "lighting")
    assert r["bright"] == ("rejected", "lighting")
    assert {f["exposureFrom"] for g in report["groups"] for f in g["frames"]} == {"raw"}

    _, from_previews = run(runner, dry_run=True, scope=DAY, options={"lighting": {"raw_source": "preview"}})
    assert roles(from_previews)["dark"] != ("rejected", "lighting")  # what Immich's previews alone would give
    store.close()


def test_measurements_of_the_previous_version_are_brought_up_to_date(dngs, tmp_path):
    """After an update that only adds animals, a run neither downloads nor decodes the RAW files again."""
    scene, files = dngs
    immich = __import__("fake_immich").FakeImmich()
    preview = jpeg(variant(scene))
    for i, k in enumerate(("base", "dark", "bright")):
        immich.add(asset(k, f"{k}.DNG", i, make="Immich-RAW", model="Test Camera"), preview)
        immich.originals[k] = files[k].read_bytes()
    store = Store(tmp_path / "s.sqlite")
    runner = Runner(
        Config(data_dir=tmp_path), immich, store, lambda c: Analyzer(c, embedder=TinyEmbedder(), load_models=False)
    )
    _, first = run(runner, dry_run=True, scope=DAY)
    analyzer = runner.analyzer(runner.cfg)
    # As if the previous version had measured them: its key, and no animals looked for.
    store._x("UPDATE features SET cache_key = ?", (analyzer.upgradable_key,))

    downloads, analysed, upgraded = [], [], []
    original, analyse, add_animals = immich.original, analyzer.analyse, analyzer.add_animals
    immich.original = lambda aid, dest: (downloads.append(aid), original(aid, dest))[1]
    analyzer.analyse = lambda *a, **kw: (analysed.append(a[1]), analyse(*a, **kw))[1]
    analyzer.add_animals = lambda f, data: (upgraded.append(f.asset_id), add_animals(f, data))[1]
    _, second = run(runner, dry_run=True, scope=DAY)
    assert downloads == [] and analysed == []
    assert sorted(upgraded) == ["base", "bright", "dark"]
    assert roles(second) == roles(first)
    assert {f["exposureFrom"] for g in second["groups"] for f in g["frames"]} == {"raw"}  # kept, not measured again
    assert all(store.features(k, analyzer.cache_key, "th") for k in ("base", "dark", "bright"))

    upgraded.clear()
    run(runner, dry_run=True, scope=DAY)
    assert upgraded == [] and analysed == [] and downloads == []  # now under the current key
    store.close()


def test_a_raw_bracket_is_found_from_the_raw_files(tmp_path):
    # As e2e/cull.mjs scene E: 0 / -2 / +2 EV by the shutter speed (1/250, 1/1000, 1/60 s at f/4, ISO 100).
    from datetime import timedelta

    from conftest import T0

    from culler.brackets import find_brackets
    from culler.config import BracketsConfig
    from culler.models import camera_exposure_ev

    scene = make_scene(6, h=480, w=720)
    shots = {"e0": (0.0, 1 / 250), "e1": (-2.0, 1 / 1000), "e2": (2.06, 1 / 60)}
    paths = write_dngs(tmp_path, {n: scene * 2.0**ev for n, (ev, _) in shots.items()})
    frames, feats = [], {}
    for i, (n, (_, t)) in enumerate(shots.items()):
        ev = camera_exposure_ev(t, 4.0, 100.0)
        frames.append(
            Frame(n, (n,), n, n, None, (), T0 + timedelta(seconds=0.3 * i), "Test", n, exposure_ev=ev, exposure_time=t)
        )
        feats[n] = Features(n, "raw", 720, 480, raw_exposure(paths[n]), 0.05, exposure_source="raw")
    keys = {n: round(f.exposure.key - feats["e0"].exposure.key, 2) for n, f in feats.items()}
    assert keys["e1"] < -1.0 and keys["e2"] > 1.0, keys  # the steps show in the RAW files, clipping and all
    assert find_brackets(frames, feats, BracketsConfig()) == [["e0", "e1", "e2"]]
