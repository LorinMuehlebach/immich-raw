"""Exposure brackets: found from the camera settings and the measured brightness, kept whole."""

from __future__ import annotations

from datetime import timedelta

import pytest
from conftest import T0, asset, make_scene, variant
from fake_immich import FakeImmich
from test_runner import TinyEmbedder, culler_tags, jpeg, roles, run

from culler.brackets import find_brackets, middle
from culler.config import BracketsConfig, Config
from culler.features import Analyzer
from culler.models import Asset, ExposureStats, Features, Frame, camera_exposure_ev, parse_exposure_time
from culler.runner import Runner
from culler.store import Store

CFG = BracketsConfig()
BASE_KEY = -2.6


def fr(name: str, sec: float, ev: float | None, camera: str = "Cam", t: float = 1 / 250) -> Frame:
    return Frame(
        name,
        (name,),
        name,
        None,
        name,
        (),
        T0 + timedelta(seconds=sec),
        camera,
        name,
        exposure_ev=ev,
        exposure_time=t,
    )


def feat(name: str, key: float) -> Features:
    return Features(name, "jpeg", 1, 1, ExposureStats(key=key, clip_hi=0, clip_lo=0, range=5), 0.05)


def shots(*specs) -> tuple[list[Frame], dict[str, Features]]:
    """(name, seconds, settings EV, measured EV offset) each; the measured offset defaults to the settings'."""
    frames, feats = [], {}
    for spec in specs:
        name, sec, ev = spec[:3]
        moved = spec[3] if len(spec) > 3 else ev
        frames.append(fr(name, sec, ev))
        feats[name] = feat(name, BASE_KEY + (moved or 0.0))
    return frames, feats


def test_parse_exposure_and_settings_ev():
    assert parse_exposure_time("1/250") == pytest.approx(0.004)
    assert parse_exposure_time("0.5") == 0.5 and parse_exposure_time("30") == 30.0
    assert parse_exposure_time(0.01) == 0.01
    assert (
        parse_exposure_time("") is None and parse_exposure_time("bulb") is None and parse_exposure_time("1/0") is None
    )
    base = camera_exposure_ev(1 / 125, 8, 100)
    assert camera_exposure_ev(1 / 500, 8, 100) == pytest.approx(base - 2)
    assert camera_exposure_ev(1 / 125, 8, 400) == pytest.approx(base + 2)
    assert camera_exposure_ev(1 / 125, 4, 100) == pytest.approx(base + 2)
    assert camera_exposure_ev(None, 8, 100) is None
    a = Asset.from_api(
        {
            "id": "x",
            "exifInfo": {"exposureTime": "1/125", "fNumber": 8, "iso": 100},
            "fileCreatedAt": "2024-05-01T10:00:00Z",
        }
    )
    assert a.exposure_ev == pytest.approx(base)


def test_aeb_set_is_found():
    frames, feats = shots(("a", 0, 0.0), ("b", 0.3, -2.0, -1.8), ("c", 0.6, 2.0, 1.4))
    assert find_brackets(frames, feats, CFG) == [["a", "b", "c"]]
    assert middle(frames).id == "a"


def test_five_shot_set_and_two_sets_in_a_row():
    frames, feats = shots(("a", 0, 0.0), ("b", 0.2, -1.0), ("c", 0.4, 1.0), ("d", 0.6, -2.0), ("e", 0.8, 2.0))
    assert find_brackets(frames, feats, CFG) == [["a", "b", "c", "d", "e"]]
    frames, feats = shots(
        ("a", 0, 0.0), ("b", 0.3, -2.0), ("c", 0.6, 2.0), ("d", 1.5, 0.0), ("e", 1.8, -2.0), ("f", 2.1, 2.0)
    )
    assert find_brackets(frames, feats, CFG) == [["a", "b", "c"], ["d", "e", "f"]]


def test_burst_shot_before_a_set_does_not_join_it():
    frames, feats = shots(("x", 0, 0.0), ("y", 0.2, 0.0), ("a", 0.4, -2.0), ("b", 0.6, 0.0), ("c", 0.8, 2.0))
    assert find_brackets(frames, feats, CFG) == [["a", "b", "c"]]


def test_auto_mode_burst_is_not_a_bracket():
    # The light changes and the camera follows: the settings step, the photos look the same.
    frames, feats = shots(("a", 0, 0.0, 0.0), ("b", 0.3, 1.2, 0.1), ("c", 0.6, -1.0, -0.1))
    assert find_brackets(frames, feats, CFG) == []


def test_too_far_apart_missing_exif_or_too_few():
    frames, feats = shots(("a", 0, 0.0), ("b", 3, -2.0), ("c", 6, 2.0))
    assert find_brackets(frames, feats, CFG) == []
    frames, feats = shots(("a", 0, 0.0), ("b", 0.3, None), ("c", 0.6, 2.0))
    assert find_brackets(frames, feats, CFG) == []
    frames, feats = shots(("a", 0, 0.0), ("b", 0.3, -2.0))
    assert find_brackets(frames, feats, CFG) == []
    frames, feats = shots(("a", 0, 0.0), ("b", 0.3, -0.5), ("c", 0.6, 0.4))  # spans less than a stop
    assert find_brackets(frames, feats, CFG) == []
    assert find_brackets(*shots(("a", 0, 0.0), ("b", 0.3, -2.0), ("c", 0.6, 2.0)), BracketsConfig(enabled=False)) == []


def test_a_long_exposure_delays_the_next_shot():
    frames = [fr("a", 0, 0.0, t=1 / 8), fr("b", 1.0, -2.0, t=1 / 30), fr("c", 4.5, 2.0, t=2.0)]
    feats = {f.id: feat(f.id, BASE_KEY + f.exposure_ev) for f in frames}
    assert find_brackets(frames, feats, CFG) == []  # 3.5 s after a 1/30 s shot
    frames = [fr("a", 0, 0.0, t=1 / 8), fr("b", 1.0, 2.0, t=2.0), fr("c", 4.5, -2.0, t=1 / 30)]
    feats = {f.id: feat(f.id, BASE_KEY + f.exposure_ev) for f in frames}
    assert find_brackets(frames, feats, CFG) == [["a", "b", "c"]]  # 3.5 s after a 2 s shot


def test_cameras_are_kept_apart():
    frames = [fr("a", 0, 0.0, "A"), fr("b", 0.3, -2.0, "B"), fr("c", 0.6, 2.0, "A")]
    feats = {f.id: feat(f.id, BASE_KEY + f.exposure_ev) for f in frames}
    assert find_brackets(frames, feats, CFG) == []


# --- end to end ------------------------------------------------------------------------------------------

# d: an AEB set 0 / -2 / +2 EV. b: an ordinary burst five minutes later.
BRACKET = {"d0": (0.0, 1 / 125, 0.0), "d1": (0.3, 1 / 500, -2.0), "d2": (0.6, 1 / 30, 2.0)}
BURST = {"b0": (300, {}), "b1": (301, {"blur": 2.5}), "b2": (302, {"shift": (0, 5)})}


@pytest.fixture
def env(tmp_path):
    scene_d, scene_b = make_scene(4, h=480, w=720), make_scene(2, h=480, w=720)
    immich = FakeImmich()
    for aid, (sec, t, ev) in BRACKET.items():
        a = asset(aid, f"{aid}.jpg", sec, make="Fuji", model="X-T5", exposure_time=t, f_number=8.0, iso=100.0)
        immich.add(a, jpeg(variant(scene_d, ev=ev)))
    for aid, (sec, kw) in BURST.items():
        a = asset(aid, f"{aid}.jpg", sec, make="Fuji", model="X-T5", exposure_time=1 / 125, f_number=8.0, iso=100.0)
        immich.add(a, jpeg(variant(scene_b, **kw)))
    store = Store(tmp_path / "culler.sqlite")
    runner = Runner(
        Config(data_dir=tmp_path), immich, store, lambda c: Analyzer(c, embedder=TinyEmbedder(), load_models=False)
    )
    yield immich, runner
    store.close()


OFF = {"brackets": {"enabled": False}}


def test_bracket_gets_its_own_stack_and_nothing_is_rejected(env):
    immich, runner = env
    _, report = run(runner)
    kinds = {g["kind"]: sorted(f["frameId"] for f in g["frames"]) for g in report["groups"]}
    assert kinds == {"bracket": ["d0", "d1", "d2"], "burst": ["b0", "b1", "b2"]}
    r = roles(report)
    assert r["d0"] == r["d1"] == r["d2"] == ("bracket", None)
    assert r["b1"] == ("rejected", "blur")
    assert report["counts"]["brackets"] == 1 and report["counts"]["best"] == 1
    assert immich.stacks[immich.stack_id_of("d0")]["primaryAssetId"] == "d0"  # the middle exposure in front
    for aid in BRACKET:
        assert culler_tags(immich, aid) == {"Culling/Bracket"}
        assert immich.rating(aid) is None
    front = next(f for g in report["groups"] for f in g["frames"] if f["frameId"] == "d1")
    assert front["metrics"]["bracketEv"] == -2.0


def test_brackets_rejected_before_are_set_right(env):
    immich, runner = env
    _, before = run(runner, options=OFF)
    r = roles(before)
    assert {r["d1"], r["d2"]} == {("rejected", "lighting")}
    assert immich.rating("d1") == -1 and immich.rating("d2") == -1
    run(runner)
    for aid in BRACKET:
        assert culler_tags(immich, aid) == {"Culling/Bracket"}
        assert immich.rating(aid) is None  # the flags this service set are taken back
