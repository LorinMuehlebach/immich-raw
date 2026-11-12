from conftest import asset

from culler.frames import build_frames
from culler.models import Stack


def frames_by_id(fs):
    return {f.id: f for f in fs.frames}


def test_raw_and_camera_jpeg_are_one_frame_with_the_jpeg_in_front():
    fs = build_frames([asset("r", "DSC1.ARW"), asset("j", "DSC1.JPG", 0.5), asset("x", "DSC2.ARW", 1)], {}, {}, set())
    f = frames_by_id(fs)
    assert set(f) == {"r", "x"}
    assert f["r"].asset_ids == ("j", "r")
    assert f["r"].face_id == "j"
    assert f["r"].raw_id == "r" and f["r"].jpeg_id == "j"


def test_pairs_need_the_same_time_and_camera():
    far = build_frames([asset("r", "DSC1.ARW"), asset("j", "DSC1.JPG", 5)], {}, {}, set())
    other_camera = build_frames([asset("r", "DSC1.ARW"), asset("j", "DSC1.JPG", model="Z9")], {}, {}, set())
    assert len(far.frames) == 2
    assert len(other_camera.frames) == 2


def test_render_joins_its_raw_and_becomes_the_face():
    assets = [asset("r", "DSC1.ARW"), asset("e", "DSC1.edit.jpg", 0, make=None, model=None)]
    fs = build_frames(assets, {}, {"e": "r"}, set())
    (frame,) = fs.frames
    assert frame.id == "r"
    assert frame.render_ids == ("e",)
    assert frame.face_id == "e"


def test_capture_stack_is_one_frame_and_keeps_its_primary():
    assets = [asset("r", "IMG_1.CR3"), asset("j", "photo.jpg", 1)]  # names don't pair, the stack does
    fs = build_frames(assets, {"s": Stack("s", "r", ("r", "j"))}, {}, set())
    (frame,) = fs.frames
    assert frame.face_id == "r"
    assert not fs.excluded


def test_users_own_stack_is_left_out_with_the_paired_jpeg():
    assets = [asset("a", "A.ARW"), asset("b", "B.ARW", 1), asset("aj", "A.JPG", 0.2), asset("c", "C.ARW", 2)]
    fs = build_frames(assets, {"s": Stack("s", "a", ("a", "b"))}, {}, set())
    assert set(fs.excluded) == {"a", "b", "aj"}
    assert [f.id for f in fs.frames] == ["c"]


def test_stacks_made_by_the_culler_are_rebuilt_from_the_rules():
    assets = [asset("a", "A.ARW"), asset("b", "B.ARW", 1), asset("bj", "B.JPG", 1)]
    fs = build_frames(assets, {"s": Stack("s", "a", ("a", "b", "bj"))}, {}, {"s"})
    assert not fs.excluded
    assert {f.id: f.asset_ids for f in fs.frames} == {"a": ("a",), "b": ("b", "bj")}


def test_favourite_and_stars_and_duplicates_are_carried():
    assets = [asset("r", "D.ARW", is_favorite=True), asset("j", "D.JPG", rating=4, duplicate_id="dup")]
    (frame,) = build_frames(assets, {}, {}, set()).frames
    assert frame.favorite and frame.starred
    assert frame.duplicate_ids == frozenset({"dup"})
