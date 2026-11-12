"""People and smiles: exposure judged on faces or people first, the people that matter, smiles in
the ranking, and the run options that switch them."""

from datetime import UTC, datetime

import pytest
from conftest import asset, variant

from culler.checks import Basis, Candidate, LightingCheck
from culler.config import Config, PeopleConfig, run_overrides
from culler.features.exposure import exposure_basis, judge, lighting_badness, measure_exposure
from culler.features.eyes import smile_score
from culler.features.people import relevant_people
from culler.frames import build_frames
from culler.models import BodyInfo, ExposureStats, FaceInfo, Features, Frame
from culler.ranking import rank_group

CFG = Config()
FACE = (300, 200, 200, 240)
GOOD = ExposureStats(key=CFG.lighting.target_key, clip_hi=0, clip_lo=0, range=5)


def features(m, name="a", faces=(), bodies=()) -> Features:
    return Features(
        name,
        "jpeg",
        1,
        1,
        m.photo,
        1.0,
        list(faces),
        bodies=list(bodies),
        face_exposure=m.faces,
        body_exposure=m.people,
    )


def frame(name: str) -> Frame:
    return Frame(name, (name,), name, None, name, (), datetime(2024, 1, 1, tzinfo=UTC), None, name)


def lighting_rejects(cfg: Config, *feats: Features) -> set[str]:
    basis = Basis.of(list(feats), cfg)
    cands = [Candidate.of(frame(f.asset_id), f, cfg, basis) for f in feats]
    return LightingCheck().eliminate(cands, cfg)


# --- exposure -----------------------------------------------------------------------------------------


def test_blown_faces_lose_although_the_photo_is_fine(scene):
    good = variant(scene)
    blown = variant(scene)
    x, y, w, h = FACE
    blown[y : y + h, x : x + w] = 255  # a face burnt out by the flash; the rest is the same
    a = features(measure_exposure(good, [FACE]), "good")
    b = features(measure_exposure(blown, [FACE]), "blown")
    assert abs(a.exposure.key - b.exposure.key) < 0.3  # the whole photo hardly changes
    assert b.face_exposure.clip_hi > 0.9
    assert lighting_rejects(CFG, a, b) == {"blown"}
    # Judged on the whole photo alone, both pass.
    assert lighting_rejects(run_overrides(CFG, {"lighting": {"people_first": False}}), a, b) == set()


def test_people_count_when_no_face_is_usable(scene):
    rgb = variant(scene)
    body = (200, 100, 300, 700)
    x, y, w, h = body
    rgb[y : y + h, x : x + w] = 25  # a person in deep shadow, seen from behind
    f = features(measure_exposure(rgb, None, [body]), bodies=[BodyInfo(body, 0.9)])
    assert exposure_basis([f], CFG) == "people"
    judged, _ = judge(f, CFG, "people")
    assert judged.key < f.exposure.key - 1
    off = run_overrides(CFG, {"people": {"enabled": False}})
    assert exposure_basis([f], off) == "photo"
    assert judge(f, off, "photo") == (f.exposure, lighting_badness(f.exposure, CFG.lighting))


def test_a_group_is_judged_alike(scene):
    rgb = variant(scene)
    body = (200, 100, 400, 800)
    with_face = features(measure_exposure(rgb, [FACE], [body]))
    turned_away = features(measure_exposure(rgb, None, [body]))
    nobody = features(measure_exposure(rgb))
    assert exposure_basis([with_face], CFG) == "faces"
    assert exposure_basis([with_face, turned_away], CFG) == "people"  # not faces for one, people for the other
    assert exposure_basis([with_face, turned_away, nobody], CFG) == "photo"


def test_skin_has_its_own_target():
    light = CFG.lighting
    bright_skin = ExposureStats(key=-1.4, clip_hi=0, clip_lo=0, range=5)  # well exposed light skin
    assert lighting_badness(bright_skin, light, light.face_target_key, light.face_dead_band_ev) == 0
    assert lighting_badness(bright_skin, light) > 0  # the whole-scene target would call it too bright


def test_sharpness_is_compared_alike(scene):
    # A face's eye band is softer than a photo's sharpest tiles: a shot without a face must not
    # make the shots with faces look blurred.
    face = Features("face", "jpeg", 1, 1, GOOD, 0.03, photo_sharpness=0.055, face_sharpness=True)
    turned = Features("turned", "jpeg", 1, 1, GOOD, 0.056, photo_sharpness=0.056)
    r = rank_group([frame("face"), frame("turned")], {"face": face, "turned": turned}, CFG)
    assert r.results["face"].reason is None and r.results["face"].metrics["sharpPct"] == 98
    both = Features("face2", "jpeg", 1, 1, GOOD, 0.015, photo_sharpness=0.055, face_sharpness=True)
    r = rank_group([frame("face"), frame("face2")], {"face": face, "face2": both}, CFG)
    assert r.results["face2"].reason == "blur"  # with faces in every shot, the eyes decide


def test_relevant_people():
    main = BodyInfo((100, 100, 400, 800), 0.9)
    friend = BodyInfo((600, 200, 250, 600), 0.8)
    unsure = BodyInfo((900, 100, 300, 700), 0.35)
    far = BodyInfo((1200, 400, 40, 90), 0.9)  # tiny in the photo
    behind = BodyInfo((1300, 100, 120, 240), 0.9)  # big enough, but small next to the main subject
    kept = relevant_people([main, friend, unsure, far, behind], PeopleConfig(), 2000, 1200)
    assert kept == [main, friend]
    assert relevant_people([], PeopleConfig(), 2000, 1200) == []


def test_features_round_trip_with_people_and_smiles(scene):
    m = measure_exposure(variant(scene), [FACE], [(200, 100, 400, 800)])
    f = features(m, faces=[FaceInfo(FACE, 0.9, smile=0.7)], bodies=[BodyInfo((200, 100, 400, 800), 0.8)])
    back = Features.from_json(f.to_json(), None)
    assert back.faces[0].smile == 0.7 and back.bodies == f.bodies
    assert back.face_exposure == f.face_exposure and back.body_exposure == f.body_exposure


# --- smiles -------------------------------------------------------------------------------------------


def test_smile_score_averages_both_corners():
    assert smile_score({"mouthSmileLeft": 0.39, "mouthSmileRight": 0.73}) == pytest.approx(0.56)
    assert smile_score({"eyeBlinkLeft": 0.1}) is None


def smiling(*scores: float) -> list[FaceInfo]:
    return [FaceInfo((0, 0, 50, 50), 0.9, state="open", smile=s) for s in scores]


def setup(specs):
    """specs: id -> (exposure, sharpness, faces); frames 1 s apart in id order."""
    ids = sorted(specs)
    fr = build_frames([asset(i, f"{i}.ARW", n) for n, i in enumerate(ids)], {}, {}, set()).frames
    return fr, {i: Features(i, "raw", 100, 100, e, s, fc) for i, (e, s, fc) in specs.items()}


def test_the_most_smiles_win_among_good_shots():
    fr, ft = setup(
        {
            "a": (GOOD, 1.0, smiling(0.1, 0.0, 0.7)),  # sharpest, one smile
            "b": (GOOD, 0.9, smiling(0.6, 0.8, 0.5)),  # three smiles
            "c": (GOOD, 0.95, smiling(0.6, 0.1, 0.5)),  # two smiles
        }
    )
    r = rank_group(fr, ft, CFG)
    assert r.frame_ids == ["b", "c", "a"]
    assert r.results["a"].role == "runner-up"  # fewer smiles is no flaw
    assert r.results["b"].metrics["smiling"] == 3 and r.results["b"].metrics["smileFaces"] == 3
    off = rank_group(fr, ft, run_overrides(CFG, {"smiles": {"enabled": False}}))
    assert off.best == "a"


def test_smiles_never_save_a_rejected_shot():
    fr, ft = setup({"a": (GOOD, 1.0, smiling(0.1, 0.1)), "b": (GOOD, 0.4, smiling(0.9, 0.9))})
    r = rank_group(fr, ft, CFG)
    assert r.best == "a" and r.results["b"].reason == "blur"


def test_metrics_say_what_the_exposure_was_judged_on(scene):
    m = measure_exposure(variant(scene), [FACE])
    fr, _ = setup({"a": (GOOD, 1.0, []), "b": (GOOD, 1.0, [])})
    ft = {k: features(m, k, faces=smiling(0.7)) for k in ("a", "b")}
    metrics = rank_group(fr, ft, CFG).results["a"].metrics
    assert metrics["judgedOn"] == "faces"
    assert {"subjectEv", "subjectClipHiPct", "subjectClipLoPct"} <= metrics.keys()


def test_run_options_switch_people_and_smiles():
    cfg = run_overrides(
        CFG, {"people": {"enabled": False}, "smiles": {"enabled": False}, "lighting": {"people_first": False}}
    )
    assert not cfg.people.enabled and not cfg.smiles.enabled and not cfg.lighting.people_first
    assert cfg.analysis_dict() == CFG.analysis_dict()  # switching them never measures the photos again
    with pytest.raises(ValueError, match="smiles.min_score"):
        run_overrides(CFG, {"smiles": {"min_score": "high"}})


# --- how open the eyes are ------------------------------------------------------------------------


def eyes(*ears: float, smile: float | None = None) -> list[FaceInfo]:
    """Faces facing the camera with these eye openings (both eyes alike)."""
    return [FaceInfo((0, 0, 50, 50), 0.9, blink=(0.1, 0.1), ear=(e, e), yaw=0.0, pitch=0.0, smile=smile) for e in ears]


def test_half_closed_eyes_are_rejected():
    fr, ft = setup({"a": (GOOD, 1.0, eyes(0.26, 0.17)), "b": (GOOD, 0.95, eyes(0.25, 0.26))})
    r = rank_group(fr, ft, CFG)
    assert r.best == "b"
    assert r.results["a"].reason == "eyes"  # 50 % open: not closed, but a half-blink
    assert r.results["a"].metrics["eyesLeast"] == 50 and r.results["b"].metrics["eyesOpen"] == 100


def test_a_squinting_smile_is_kept():
    fr, ft = setup({"a": (GOOD, 1.0, eyes(0.32, smile=0.0)), "b": (GOOD, 0.98, eyes(0.23, smile=0.86))})
    r = rank_group(fr, ft, CFG)
    assert r.best == "b" and r.results["a"].role == "runner-up"  # the smile wins, nobody rejected


def test_wider_open_eyes_win_among_good_shots():
    off = run_overrides(CFG, {"smiles": {"enabled": False}})
    fr, ft = setup({"a": (GOOD, 1.0, eyes(0.21)), "b": (GOOD, 1.0, eyes(0.26))})
    assert rank_group(fr, ft, off).best == "b"
