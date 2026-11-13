"""The planner on its own: the culler tags each photo should carry, and undoing them."""

from __future__ import annotations

from datetime import UTC, datetime

from culler.models import Asset, Frame, FrameResult, GroupResult, Tag
from culler.planner import (
    AddTag,
    AssetState,
    DesiredGroup,
    Live,
    RemoveTag,
    all_tag_values,
    plan_changes,
    plan_undo,
    snapshot_before,
    wanted_tags,
)

ROOT = "Culling"
T = datetime(2024, 5, 1, 12, tzinfo=UTC)


def mk_asset(aid: str, tags: tuple[str, ...] = ()) -> Asset:
    return Asset(
        id=aid,
        owner_id="u",
        name=f"{aid}.jpg",
        taken=T,
        local_date="2024-05-01",
        uploaded=T,
        checksum=aid,
        thumbhash=None,
        tags=tuple(Tag(f"tag-{v}", v) for v in tags),
    )


def mk_frame(aid: str) -> Frame:
    return Frame(
        id=aid, asset_ids=(aid,), face_id=aid, raw_id=None, jpeg_id=aid, render_ids=(), taken=T, camera=None, name=aid
    )


def group(close_call: bool) -> DesiredGroup:
    results = {
        "a": FrameResult("a", "best", None, 1, 0.90),
        "b": FrameResult("b", "runner-up", None, 2, 0.89),
    }
    return DesiredGroup("g1", [mk_frame("a"), mk_frame("b")], GroupResult(["a", "b"], results, close_call=close_call))


def plan(desired: DesiredGroup, live: Live, prev: dict[str, AssetState] | None = None):
    return plan_changes([desired], [], live, prev or {}, set(), ROOT, "run", "now")


def tag_ops(ops, cls) -> set[tuple[str, tuple[str, ...]]]:
    return {(op.value, op.asset_ids) for op in ops if isinstance(op, cls)}


def test_wanted_tags():
    assert wanted_tags(ROOT, "best", None, False) == ("Culling/Best",)
    assert wanted_tags(ROOT, "best", None, True) == ("Culling/Best", "Culling/Close call")
    assert wanted_tags(ROOT, "runner-up", None, True) == ("Culling/Runner-up",)  # only the best is marked
    assert wanted_tags(ROOT, "bracket", None, False) == ("Culling/Bracket",)
    assert "Culling/Close call" in all_tag_values(ROOT) and "Culling/Bracket" in all_tag_values(ROOT)


def test_state_stored_with_one_tag_still_loads():
    old = {"group_id": "g", "frame_id": "f", "tag": "Culling/Best", "rating_set": False, "rating_blocked": False}
    s = AssetState.from_json({**old, "meta": None})
    assert s.tags == ("Culling/Best",)
    assert AssetState.from_json({**old, "tag": None, "meta": None}).tags == ()
    assert AssetState.from_json(s.to_json()) == s
    assert s.to_json()["tags"] == ["Culling/Best"]


def test_close_call_tag_goes_next_to_best():
    live = Live({"a": mk_asset("a"), "b": mk_asset("b")}, {})
    p = plan(group(close_call=True), live)
    assert tag_ops(p.ops, AddTag) == {
        ("Culling/Best", ("a",)),
        ("Culling/Close call", ("a",)),
        ("Culling/Runner-up", ("b",)),
    }
    assert p.states["a"].tags == ("Culling/Best", "Culling/Close call")
    assert p.states["b"].tags == ("Culling/Runner-up",)


def test_close_call_tag_removed_when_no_longer_close():
    live = Live(
        {"a": mk_asset("a", ("Culling/Best", "Culling/Close call")), "b": mk_asset("b", ("Culling/Runner-up",))}, {}
    )
    p = plan(group(close_call=False), live)
    assert tag_ops(p.ops, RemoveTag) == {("Culling/Close call", ("a",))}
    assert tag_ops(p.ops, AddTag) == set()


def test_undo_puts_both_tags_back():
    before_live = Live(
        {"a": mk_asset("a", ("Culling/Best", "Culling/Close call")), "b": mk_asset("b", ("Culling/Runner-up",))}, {}
    )
    before = snapshot_before({"a", "b"}, before_live, {}, ROOT)
    p = plan(group(close_call=False), before_live)
    after_live = Live({"a": mk_asset("a", ("Culling/Best",)), "b": mk_asset("b", ("Culling/Runner-up",))}, {})
    ops, notes = plan_undo(before, p.states, {}, after_live, ROOT)
    assert tag_ops(ops, AddTag) == {("Culling/Close call", ("a",))}
    assert tag_ops(ops, RemoveTag) == set()
    assert notes == []
