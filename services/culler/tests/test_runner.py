"""End to end against the in-memory Immich: real exposure/sharpness measurements on synthetic
bursts, a tiny stand-in for CLIP, the real planner, executor and store."""

from __future__ import annotations

import cv2
import numpy as np
import pytest
from conftest import asset, make_scene, variant
from fake_immich import FakeImmich

from culler.config import Config
from culler.features import Analyzer
from culler.features.embedding import stretch_levels
from culler.models import CULL_KEY
from culler.runner import Runner, Scope, new_run_id
from culler.store import Store

ROOT = "Culling"


class TinyEmbedder:
    """Coarse grey thumbnail: frames of one scene land close together, other scenes don't."""

    def embed(self, rgb: np.ndarray) -> np.ndarray:
        g = cv2.cvtColor(stretch_levels(rgb), cv2.COLOR_RGB2GRAY)
        v = cv2.resize(g, (16, 12), interpolation=cv2.INTER_AREA).astype(np.float32).ravel()
        v -= v.mean()
        return v / np.linalg.norm(v)


def jpeg(rgb: np.ndarray) -> bytes:
    ok, buf = cv2.imencode(".jpg", cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, 92])
    assert ok
    return buf.tobytes()


@pytest.fixture(scope="module")
def scenes():
    return {k: make_scene(seed, h=480, w=720) for k, seed in (("A", 1), ("B", 2), ("C", 3))}


# Scene A: base, -1.5 EV, blurred, shifted (sharp), +1.7 EV with clipping. Scene B 5 min later.
SPECS = {
    "a0": ("A", 0, {}),
    "a1": ("A", 1, {"ev": -1.5}),
    "a2": ("A", 2, {"blur": 3}),
    "a3": ("A", 3, {"shift": (6, 0)}),
    "a4": ("A", 4, {"ev": 1.7}),
    "b0": ("B", 300, {}),
    "b1": ("B", 301, {"blur": 2.5}),
    "b2": ("B", 302, {"shift": (0, 5)}),
    "c0": ("C", 1800, {}),
}


@pytest.fixture
def env(scenes, tmp_path):
    immich = FakeImmich()
    for aid, (scene, sec, kw) in SPECS.items():
        immich.add(asset(aid, f"{aid}.jpg", sec, make="Fuji", model="X-T5"), jpeg(variant(scenes[scene], **kw)))
    cfg = Config(data_dir=tmp_path)
    store = Store(tmp_path / "culler.sqlite")
    runner = Runner(cfg, immich, store, lambda c: Analyzer(c, embedder=TinyEmbedder(), load_models=False))
    yield immich, runner, store
    store.close()


DAY = Scope("day", date="2024-05-01")


def run(runner, dry_run=False, scope=DAY, **kw):
    rid = new_run_id()
    runner.store.create_run(rid, "test", scope.to_json(), None, dry_run)
    report = runner.run(rid, scope, dry_run=dry_run, **kw)
    runner.store.update_run(rid, status="done", report=report)
    return rid, report


def roles(report):
    return {f["frameId"]: (f["role"], f["reason"]) for g in report["groups"] for f in g["frames"]}


def culler_tags(immich, aid):
    return {t for t in immich.tags_of(aid) if t.startswith(ROOT + "/")}


def test_dry_run_groups_ranks_and_changes_nothing(env):
    immich, runner, _ = env
    _, report = run(runner, dry_run=True)
    groups = [sorted(f["frameId"] for f in g["frames"]) for g in report["groups"]]
    assert sorted(groups) == [["a0", "a1", "a2", "a3", "a4"], ["b0", "b1", "b2"]]
    r = roles(report)
    assert r["a1"] == ("rejected", "lighting")
    assert r["a4"] == ("rejected", "lighting")
    assert r["a2"] == ("rejected", "blur")
    assert r["b1"] == ("rejected", "blur")
    assert {r["a0"][0], r["a3"][0]} == {"best", "runner-up"}
    assert "c0" not in r
    assert report["counts"]["rejected"] == {"lighting": 2, "blur": 2, "eyes": 0}
    assert not immich.stacks and not immich.calls


def test_apply_stacks_tags_flags_and_stores_details(env):
    immich, runner, _ = env
    _, report = run(runner)
    best_a = next(
        f["frameId"] for g in report["groups"] for f in g["frames"] if f["role"] == "best" and f["frameId"][0] == "a"
    )
    sid = immich.stack_id_of("a0")
    assert immich.stacks[sid]["primaryAssetId"] == best_a
    assert set(immich.stacks[sid]["assetIds"]) == {"a0", "a1", "a2", "a3", "a4"}
    assert culler_tags(immich, "a1") == {"Culling/Rejected/Lighting"}
    assert culler_tags(immich, "a2") == {"Culling/Rejected/Blur"}
    assert culler_tags(immich, best_a) == {"Culling/Best"}
    assert immich.rating("a1") == -1 and immich.rating("a2") == -1
    assert immich.rating("a0") is None and immich.rating("a3") is None
    assert immich.stack_id_of("c0") is None and not culler_tags(immich, "c0")
    meta = immich.meta["a2"][CULL_KEY]
    assert meta["role"] == "rejected" and meta["reason"] == "blur" and meta["groupSize"] == 5
    assert meta["metrics"]["sharpPct"] < 70


def test_second_run_changes_nothing(env):
    immich, runner, _ = env
    run(runner)
    immich.calls.clear()
    _, report = run(runner)
    assert report["changes"] == []
    assert immich.calls == []


def test_users_choice_of_front_photo_is_kept(env):
    immich, runner, _ = env
    _, first = run(runner)
    r = roles(first)
    old_best = next(f for f in ("a0", "a3") if r[f][0] == "best")
    other = "a3" if old_best == "a0" else "a0"
    sid = immich.stack_id_of("a0")
    immich.update_stack(sid, other)  # the user picks the other one in Immich

    _, report = run(runner)
    assert immich.stacks[immich.stack_id_of("a0")]["primaryAssetId"] == other
    assert roles(report)[other] == ("best", None)
    assert culler_tags(immich, other) == {"Culling/Best"}
    assert culler_tags(immich, old_best) == {"Culling/Runner-up"}
    assert next(f for g in report["groups"] for f in g["frames"] if f["frameId"] == other)["pinned"]


def test_reject_flag_emptied_by_immich_is_not_retried(env):
    immich, runner, _ = env
    run(runner)
    # Immich 3.4 empties -1 when it re-reads the metadata a moment later.
    immich.update_assets(["a1", "a2", "a4", "b1"], rating=None)
    _, report = run(runner)
    assert report["changes"] == []  # no retry, no churn
    assert immich.rating("a1") is None
    assert culler_tags(immich, "a1") == {"Culling/Rejected/Lighting"}


def test_stars_given_by_the_user_win_over_the_reject_flag(env):
    immich, runner, store = env
    run(runner)
    immich.update_assets(["a1"], rating=3)
    run(runner)
    assert immich.rating("a1") == 3
    assert store.asset_states(["a1"])["a1"].rating_blocked
    immich.update_assets(["a1"], rating=None)  # stars taken away again: still the user's call
    run(runner)
    assert immich.rating("a1") is None


def test_deleted_stack_is_not_stacked_again(env):
    immich, runner, _ = env
    run(runner)
    immich.delete_stack(immich.stack_id_of("b0"))
    _, report = run(runner)
    assert immich.stack_id_of("b0") is None
    assert all("b0" not in [f["frameId"] for f in g["frames"]] for g in report["groups"])
    _, forced = run(runner, force=True)
    assert immich.stack_id_of("b0") is not None
    assert any("b0" in [f["frameId"] for f in g["frames"]] for g in forced["groups"])


def test_undo_puts_everything_back(env):
    immich, runner, store = env
    rid, _ = run(runner)
    report = runner.undo(rid)
    assert report["errors"] == []
    assert not immich.stacks
    assert all(not culler_tags(immich, a) for a in SPECS)
    assert all(immich.rating(a) is None for a in SPECS)
    assert all(CULL_KEY not in immich.meta[a] for a in SPECS)
    assert store.asset_states(SPECS) == {}


def test_undo_order_is_enforced(env):
    immich, runner, _ = env
    first, report = run(runner)
    runner_up = next(f for f, (role, _) in roles(report).items() if f[0] == "b" and role == "runner-up")
    immich.update_stack(immich.stack_id_of("b0"), runner_up)
    second, report = run(runner)
    assert report["changes"]
    with pytest.raises(Exception, match="later runs"):
        runner.undo(first)
    runner.undo(second)
    runner.undo(first)
    assert not immich.stacks


def test_raw_and_jpeg_pairs_stack_as_frames(scenes, tmp_path):
    immich = FakeImmich()
    for i, kw in enumerate(({}, {"blur": 3}, {"shift": (4, 0)})):
        data = jpeg(variant(scenes["A"], **kw))
        immich.add(asset(f"r{i}", f"DSC{i}.ARW", i), data)
        immich.add(asset(f"j{i}", f"DSC{i}.JPG", i), data)
    immich.stack_ids("j0", "r0")  # camera pair stacked by the user, JPEG in front
    store = Store(tmp_path / "s.sqlite")
    runner = Runner(
        Config(data_dir=tmp_path), immich, store, lambda c: Analyzer(c, embedder=TinyEmbedder(), load_models=False)
    )
    _, report = run(runner)
    (group,) = report["groups"]
    assert len(group["frames"]) == 3
    creates = [c for c in immich.calls if c[0] == "create_stack"]
    (ids,) = [c[1] for c in creates[1:]]
    assert "r0" not in ids  # the capture stack is absorbed through its primary
    sid = immich.stack_id_of("r0")
    assert set(immich.stacks[sid]["assetIds"]) == {"r0", "j0", "r1", "j1", "r2", "j2"}
    best = next(f for f in group["frames"] if f["role"] == "best")
    assert immich.stacks[sid]["primaryAssetId"] == best["faceId"]
    assert best["faceId"].startswith("j")  # the camera JPEG goes in front
    assert culler_tags(immich, "r1") == culler_tags(immich, "j1") == {"Culling/Rejected/Blur"}

    # Undo restores the user's RAW + JPEG stack.
    runner.undo(next(r["id"] for r in store.runs()))
    sid = immich.stack_id_of("r0")
    assert sid and immich.stacks[sid]["primaryAssetId"] == "j0" and set(immich.stacks[sid]["assetIds"]) == {"j0", "r0"}
    assert immich.stack_id_of("r1") is None
    store.close()


def test_group_that_shrinks_to_one_photo_is_released(env):
    immich, runner, _ = env
    run(runner)
    immich.data["b1"]["isTrashed"] = True
    immich.data["b2"]["isTrashed"] = True
    _, report = run(runner)
    assert report["counts"]["released"] == 1
    assert immich.stack_id_of("b0") is None
    assert not culler_tags(immich, "b0")
    assert CULL_KEY not in immich.meta["b0"]


def test_undo_of_a_run_that_only_retagged_keeps_the_stack(env):
    immich, runner, store = env
    _, first = run(runner)
    runner_up = next(f for f, (role, _) in roles(first).items() if f[0] == "a" and role == "runner-up")
    immich.update_stack(immich.stack_id_of("a0"), runner_up)
    second, _ = run(runner)  # only swaps the Best and Runner-up tags
    runner.undo(second)
    sid = immich.stack_id_of("a0")
    assert sid is not None and immich.stacks[sid]["primaryAssetId"] == runner_up
    assert culler_tags(immich, runner_up) == {"Culling/Runner-up"}


def test_a_run_without_changes_leaves_nothing_to_undo(env):
    immich, runner, store = env
    first, _ = run(runner)
    noop, report = run(runner)
    assert report["changes"] == []
    assert store.snapshot(noop) is None
    runner.undo(first)  # not blocked by the run that changed nothing
    assert not immich.stacks
