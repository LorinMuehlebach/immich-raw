"""Animals: found by the object detector, and sharpness measured on them when no face is there."""

from datetime import UTC, datetime

import cv2
from conftest import variant

from culler.checks import sharpness_basis
from culler.config import Config, SubjectsConfig, run_overrides
from culler.features.people import relevant_animals, relevant_people
from culler.features.sharpness import measure_sharpness_parts
from culler.models import BodyInfo, ExposureStats, Features, Frame
from culler.ranking import rank_group

CFG = Config()
GOOD = ExposureStats(key=CFG.lighting.target_key, clip_hi=0, clip_lo=0, range=5)
BIRD = (500.0, 300.0, 300.0, 240.0)


def frame(name: str) -> Frame:
    return Frame(name, (name,), name, None, name, (), datetime(2024, 1, 1, tzinfo=UTC), None, name)


def feats(name: str, photo: float, subject: float | None, face: bool = False) -> Features:
    animals = [BodyInfo(BIRD, 0.8, "bird")] if subject is not None else []
    return Features(
        name,
        "jpeg",
        1,
        1,
        GOOD,
        photo,
        photo_sharpness=photo,
        face_sharpness=face,
        animals=animals,
        subject_sharpness=subject,
    )


def test_relevant_animals_keeps_sure_big_animals_largest_first():
    bird = BodyInfo((100, 100, 300, 200), 0.8, "bird")
    dog = BodyInfo((600, 300, 500, 400), 0.7, "dog")
    unsure = BodyInfo((900, 100, 300, 300), 0.3, "cat")
    tiny = BodyInfo((10, 10, 20, 20), 0.9, "bird")
    person = BodyInfo((100, 100, 400, 800), 0.9)
    found = [bird, dog, unsure, tiny, person]
    assert relevant_animals(found, SubjectsConfig(), 2000, 1200) == [dog, bird]
    assert relevant_animals(found, SubjectsConfig(labels=("bird",)), 2000, 1200) == [bird]
    assert relevant_people(found, CFG.people, 2000, 1200) == [person]  # animals are not people


def test_subject_sharpness_ignores_a_sharp_background(scene):
    sharp = variant(scene)
    x, y, w, h = (int(v) for v in BIRD)
    in_focus = sharp.copy()  # the whole photo is sharp, the bird too
    missed = sharp.copy()  # focus on the background: the bird is soft
    missed[y : y + h, x : x + w] = cv2.GaussianBlur(sharp, (0, 0), 3)[y : y + h, x : x + w]
    a = measure_sharpness_parts(in_focus, None, [BIRD])
    b = measure_sharpness_parts(missed, None, [BIRD])
    assert abs(a.photo - b.photo) / a.photo < 0.1  # the sharpest areas hardly tell them apart
    assert b.subject < 0.6 * a.subject
    assert a.face is None and measure_sharpness_parts(sharp).subject is None


def test_basis_is_the_animal_only_when_every_shot_shows_one():
    assert sharpness_basis([feats("a", 1, 0.5), feats("b", 1, 0.4)], CFG) == "subject"
    assert sharpness_basis([feats("a", 1, 0.5), feats("b", 1, None)], CFG) == "photo"
    assert sharpness_basis([feats("a", 1, 0.5, face=True), feats("b", 1, 0.4, face=True)], CFG) == "faces"
    off = run_overrides(CFG, {"subjects": {"enabled": False}})
    assert sharpness_basis([feats("a", 1, 0.5), feats("b", 1, 0.4)], off) == "photo"


def test_the_shot_with_the_sharp_animal_wins():
    # Both look equally sharp overall; only the bird tells them apart.
    sharp_bird = feats("sharp", 0.050, 0.040)
    soft_bird = feats("soft", 0.051, 0.020)
    r = rank_group([frame("sharp"), frame("soft")], {"sharp": sharp_bird, "soft": soft_bird}, CFG)
    assert r.best == "sharp"
    assert r.results["soft"].reason == "blur"
    m = r.results["soft"].metrics
    assert m["sharpOn"] == "subject" and m["subjectLabel"] == "bird" and m["sharpPct"] == 50


def test_features_round_trip_with_animals():
    f = feats("a", 0.05, 0.04)
    back = Features.from_json(f.to_json(), None)
    assert back.animals == f.animals and back.animals[0].label == "bird"
    assert back.subject_sharpness == 0.04
    old = f.to_json()
    del old["animals"], old["subjectSharpness"]  # measured before animals were
    assert Features.from_json(old, None).animals == []
    assert BodyInfo.from_json(BodyInfo((1, 2, 3, 4), 0.5).to_json()).label == "person"
