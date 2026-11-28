"""Moments: a scene's stack is split where a new burst shows something else (a new pose)."""

from __future__ import annotations

import numpy as np
import pytest
from conftest import asset, make_scene, variant
from fake_immich import FakeImmich
from test_runner import TinyEmbedder, jpeg, roles, run

from culler.config import Config, GroupingConfig
from culler.features import Analyzer
from culler.features.embedding import cosine
from culler.frames import build_frames
from culler.grouping import group_frames
from culler.runner import Runner
from culler.store import Store

CFG = GroupingConfig()


def unit(*v):
    a = np.array(v, np.float32)
    return a / np.linalg.norm(a)


A, A2 = unit(1, 0, 0, 0), unit(1, -0.15, 0, 0)  # the same pose: 0.99
P = unit(1, 0.45, 0, 0)  # the same scene, another pose: 0.91 to A, 0.84 to A2


def frames(*specs, dup: dict[str, str] | None = None):
    """specs: (id, seconds)"""
    dup = dup or {}
    return build_frames([asset(i, f"{i}.ARW", s, duplicate_id=dup.get(i)) for i, s in specs], {}, {}, set()).frames


def test_new_pose_after_a_pause_is_a_stack_of_its_own():
    fr = frames(("a", 0), ("b", 0.5), ("c", 5), ("d", 5.5))
    assert group_frames(fr, {"a": A, "b": A2, "c": P, "d": P}, CFG) == [["a", "b"], ["c", "d"]]


def test_retake_of_the_same_pose_stays():
    fr = frames(("a", 0), ("b", 5))
    assert group_frames(fr, {"a": A, "b": A2}, CFG) == [["a", "b"]]


def test_a_continuous_burst_is_never_split():
    fr = frames(("a", 0), ("b", 1), ("c", 2))
    assert group_frames(fr, {"a": A, "b": P, "c": A}, CFG) == [["a", "b", "c"]]


def test_back_to_an_earlier_pose_joins_that_moment():
    fr = frames(("a", 0), ("b", 5), ("c", 10))
    assert group_frames(fr, {"a": A, "b": P, "c": A2}, CFG) == [["a", "c"], ["b"]]


def test_duplicates_stay_together_and_zero_turns_it_off():
    fr = frames(("a", 0), ("b", 5), dup={"a": "d1", "b": "d1"})
    assert group_frames(fr, {"a": A, "b": P}, CFG) == [["a", "b"]]
    fr = frames(("a", 0), ("b", 0.5), ("c", 5), ("d", 5.5))
    off = GroupingConfig(moment_similarity=0)
    assert group_frames(fr, {"a": A, "b": A2, "c": P, "d": P}, off) == [["a", "b", "c", "d"]]


# --- end to end: the shot the user put in front keeps its place --------------------------------------------


@pytest.fixture
def env(tmp_path):
    scene = make_scene(5, h=480, w=720)
    imgs = {
        "m0": variant(scene),
        "m1": variant(scene, shift=(2, 0)),
        "n0": variant(scene, shift=(90, 0)),  # the same scene, framed (posed) differently
        "n1": variant(scene, shift=(92, 0)),
    }
    secs = {"m0": 0, "m1": 0.5, "n0": 5, "n1": 5.5}
    immich = FakeImmich()
    for aid, rgb in imgs.items():
        immich.add(asset(aid, f"{aid}.jpg", secs[aid], make="Fuji", model="X-T5"), jpeg(rgb))
    e = {k: TinyEmbedder().embed(v) for k, v in imgs.items()}
    within = min(cosine(e["m0"], e["m1"]), cosine(e["n0"], e["n1"]))
    across = max(cosine(e[a], e[b]) for a in ("m0", "m1") for b in ("n0", "n1"))
    assert across < within - 0.01, (across, within)  # the test needs two tellable moments
    grouping = {"link_similarity": across - 0.02, "medoid_similarity": across - 0.05}
    store = Store(tmp_path / "culler.sqlite")
    runner = Runner(
        Config(data_dir=tmp_path), immich, store, lambda c: Analyzer(c, embedder=TinyEmbedder(), load_models=False)
    )
    yield immich, runner, grouping, (across + within) / 2
    store.close()


def test_a_pin_follows_its_shot_into_its_moment(env):
    immich, runner, grouping, split_at = env
    _, first = run(runner, options={"grouping": {**grouping, "moment_similarity": 0}})
    assert sorted(f["frameId"] for g in first["groups"] for f in g["frames"]) == ["m0", "m1", "n0", "n1"]
    assert len(first["groups"]) == 1
    immich.update_stack(immich.stack_id_of("n1"), "n1")  # the user puts a shot of the second pose in front
    _, report = run(runner, options={"grouping": {**grouping, "moment_similarity": split_at}})
    groups = sorted(sorted(f["frameId"] for f in g["frames"]) for g in report["groups"])
    assert groups == [["m0", "m1"], ["n0", "n1"]]
    assert roles(report)["n1"] == ("best", None)
    n1 = next(f for g in report["groups"] for f in g["frames"] if f["frameId"] == "n1")
    assert n1["pinned"]
    assert immich.stack_id_of("m0") != immich.stack_id_of("n0")
    assert immich.stacks[immich.stack_id_of("n0")]["primaryAssetId"] == "n1"
