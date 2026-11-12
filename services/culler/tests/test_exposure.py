from datetime import UTC, datetime

from conftest import variant

from culler.checks import Candidate, LightingCheck
from culler.config import Config, LightingConfig
from culler.features.exposure import exposure_basis, judge, lighting_badness, measure_exposure
from culler.models import Features, Frame

CFG = LightingConfig()


def _lighting_rejects(*frames) -> set[int]:
    """Indexes of the frames the lighting check rejects."""
    cfg = Config()
    cands = []
    for i, rgb in enumerate(frames):
        frame = Frame(str(i), (str(i),), str(i), None, str(i), (), datetime(2024, 1, 1, tzinfo=UTC), None, str(i))
        cands.append(Candidate.of(frame, Features(str(i), "jpeg", 1, 1, measure_exposure(rgb).photo, 1.0), cfg))
    return {int(fid) for fid in LightingCheck().eliminate(cands, cfg)}


def test_key_follows_exposure_in_stops(scene):
    base = measure_exposure(variant(scene)).photo
    darker = measure_exposure(variant(scene, ev=-1.5)).photo
    assert abs((darker.key - base.key) - -1.5) < 0.15


def test_base_scene_is_a_good_exposure(scene):
    e = measure_exposure(variant(scene)).photo
    assert e.clip_hi < 0.005
    assert lighting_badness(e, CFG) < 0.25


def test_small_brightness_change_is_tolerated(scene):
    assert _lighting_rejects(variant(scene), variant(scene, ev=0.4), variant(scene, ev=-0.5)) == set()


def test_underexposed_frame_is_rejected(scene):
    assert _lighting_rejects(variant(scene), variant(scene, ev=-1.5)) == {1}


def test_frames_far_apart_in_brightness_keep_only_the_better_one(scene):
    # Both are roughly as far from the target (one bright, one dark), but 1.5 stops apart.
    assert _lighting_rejects(variant(scene, ev=0.5), variant(scene, ev=-1.0)) == {1}


def test_overexposed_frame_clips_and_is_rejected(scene):
    e = measure_exposure(variant(scene, ev=1.7)).photo
    assert e.clip_hi > 0.02
    assert _lighting_rejects(variant(scene), variant(scene, ev=1.7)) == {1}


def _features(m) -> Features:
    return Features("a", "jpeg", 1, 1, m.photo, 1.0, face_exposure=m.faces, body_exposure=m.people)


def test_faces_weigh_more_than_the_rest(scene):
    rgb = variant(scene)
    rgb[100:300, 100:260] = 30  # a dark "face"
    m = measure_exposure(rgb, face_boxes=[(100, 100, 160, 200)])
    f = _features(m)
    assert exposure_basis([f], Config()) == "faces"
    judged, _ = judge(f, Config(), "faces")
    assert m.faces.key < m.photo.key - 2
    assert judged.key < m.photo.key - 1.5  # faces: 80 %
