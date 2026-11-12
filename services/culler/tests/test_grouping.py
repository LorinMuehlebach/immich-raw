import numpy as np
from conftest import asset

from culler.config import GroupingConfig
from culler.frames import build_frames
from culler.grouping import apply_joins, group_frames

CFG = GroupingConfig()


def unit(*v):
    a = np.array(v, np.float32)
    return a / np.linalg.norm(a)


A, A2 = unit(1, 0, 0, 0), unit(1, 0.15, 0, 0)  # same scene
B = unit(0, 1, 0, 0)  # other scene


def frames(*specs):
    """specs: (id, seconds, camera model)"""
    return build_frames([asset(i, f"{i}.ARW", s, model=m) for i, s, m in specs], {}, {}, set()).frames


def test_burst_of_similar_frames_is_one_group():
    fr = frames(("a", 0, "A7"), ("b", 1, "A7"), ("c", 2, "A7"))
    assert group_frames(fr, {"a": A, "b": A2, "c": A}, CFG) == [["a", "b", "c"]]


def test_long_pause_splits():
    fr = frames(("a", 0, "A7"), ("b", 200, "A7"))
    assert group_frames(fr, {"a": A, "b": A}, CFG) == [["a"], ["b"]]


def test_camera_change_splits():
    fr = frames(("a", 0, "A7"), ("b", 1, "Z9"))
    assert group_frames(fr, {"a": A, "b": A}, CFG) == [["a"], ["b"]]


def test_different_scene_is_not_stacked():
    fr = frames(("a", 0, "A7"), ("b", 1, "A7"))
    assert group_frames(fr, {"a": A, "b": B}, CFG) == [["a"], ["b"]]


def test_interleaved_subjects_form_two_groups():
    fr = frames(("a1", 0, "A7"), ("b1", 1, "A7"), ("a2", 2, "A7"), ("b2", 3, "A7"))
    emb = {"a1": A, "a2": A2, "b1": B, "b2": B}
    assert group_frames(fr, emb, CFG) == [["a1", "a2"], ["b1", "b2"]]


def test_slow_pan_does_not_chain_forever():
    # Each frame is close to the previous one, but the last is far from where the group started.
    steps = [unit(np.cos(t), np.sin(t), 0, 0) for t in np.linspace(0, 1.2, 9)]
    fr = frames(*[(f"p{i}", i, "A7") for i in range(9)])
    groups = group_frames(fr, {f"p{i}": v for i, v in enumerate(steps)}, CFG)
    assert len(groups) > 1
    assert sum(len(g) for g in groups) == 9


def test_max_span_and_size():
    fr = frames(*[(f"f{i}", i * 60, "A7") for i in range(12)])  # 11 minutes, 1 per minute
    groups = group_frames(fr, {f"f{i}": A for i in range(12)}, CFG)
    assert all((len(g) - 1) * 60 <= CFG.max_span_s for g in groups)
    small = GroupingConfig(max_size=4)
    assert max(len(g) for g in group_frames(fr[:8], {f"f{i}": A for i in range(8)}, small)) == 4


def test_immich_duplicates_always_join():
    fs = build_frames(
        [asset("a", "a.ARW", 0, duplicate_id="d"), asset("b", "b.ARW", 1, duplicate_id="d")], {}, {}, set()
    ).frames
    assert group_frames(fs, {"a": A, "b": B}, CFG) == [["a", "b"]]


def test_an_added_shot_goes_into_the_group_with_most_of_its_stack():
    groups = [["a", "b", "c"], ["d", "e"], ["x"]]
    out, placed, why = apply_joins(groups, {"x": ("d", "e", "a")}, set("abcdex"))
    assert out == [["a", "b", "c"], ["d", "e", "x"]] and placed == {"x"} and why == {}


def test_an_added_shot_leaves_the_group_it_was_in():
    out, placed, _ = apply_joins([["a", "b", "x"], ["d", "e"]], {"x": ("d",)}, set("abdex"))
    assert out == [["a", "b"], ["d", "e", "x"]] and placed == {"x"}


def test_a_single_target_makes_a_new_pair():
    out, placed, _ = apply_joins([["a"], ["x"]], {"x": ("a",)}, {"a", "x"})
    assert out == [["a", "x"]] and placed == {"x"}


def test_unmeasured_shots_and_targets_stay_where_they_are():
    out, placed, why = apply_joins([["a", "b"], ["x"], ["p"]], {"x": ("p",), "p": ("a",)}, {"a", "b", "x"})
    assert ["x"] in out and ["p"] in out and placed == set()
    assert why == {"x": "its stack isn't among these photos any more", "p": "waiting for Immich's preview"}


def test_chains_of_added_shots_follow_each_other():
    out, placed, _ = apply_joins([["a", "b"], ["x"], ["y"]], {"y": ("x",), "x": ("a",)}, {"a", "b", "x", "y"})
    assert out == [["a", "b", "x", "y"]] and placed == {"x", "y"}


def test_shots_whose_stack_is_gone_stay_together():
    out, placed, why = apply_joins([["x"], ["y"], ["z"]], {"x": ("y", "gone"), "y": ("x",), "z": ("gone",)}, set("xyz"))
    assert ["x", "y"] in out and ["z"] in out and placed == {"x", "y"}
    assert why == {"z": "its stack isn't among these photos any more"}
