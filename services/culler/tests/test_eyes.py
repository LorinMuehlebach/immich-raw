"""Eye state from measurements taken on real stage photos (Wikimedia Commons, Dylan LeBlanc at
Orange Blossom Special 2025, CC BY-SA 4.0), checked by eye. Only the numbers are kept here."""

import pytest

from culler.config import EyesConfig
from culler.features.eyes import EyeMeasure, classify_eyes, eye_aspect_ratio
from culler.features.faces import relevant_faces, yaw_proxy
from culler.models import FaceInfo

CFG = EyesConfig()

# (photo, blink left/right, eye opening left/right, yaw, pitch)
CLOSED = [
    ("02", (0.69, 0.66), (0.035, 0.187), -28, -36),
    ("04", (0.33, 0.35), (0.137, 0.129), 16, -10),
    ("06", (0.70, 0.49), (0.085, 0.070), -13, -27),
    ("11", (0.49, 0.48), (0.082, 0.072), 10, 5),
    ("20", (0.58, 0.47), (0.066, 0.167), -26, -34),
]
OPEN = [
    ("03", (0.14, 0.16), (0.250, 0.240), 4, -12),
    ("10", (0.40, 0.17), (0.199, 0.199), -15, -29),
    ("12", (0.08, 0.07), (0.301, 0.293), 10, -21),
    ("14", (0.23, 0.19), (0.204, 0.187), 13, -10),
    ("17", (0.26, 0.32), (0.256, 0.164), 28, 1),
    ("20b", (0.20, 0.29), (0.191, 0.233), -21, -26),
    ("21", (0.15, 0.34), (0.199, 0.241), -16, -23),
]


@pytest.mark.parametrize("photo,blink,ear,yaw,pitch", CLOSED)
def test_closed_eyes(photo, blink, ear, yaw, pitch):
    assert classify_eyes(EyeMeasure(blink, ear, yaw, pitch), CFG) == "closed"


@pytest.mark.parametrize("photo,blink,ear,yaw,pitch", OPEN)
def test_open_eyes(photo, blink, ear, yaw, pitch):
    assert classify_eyes(EyeMeasure(blink, ear, yaw, pitch), CFG) == "open"


def test_profile_faces_are_not_judged():
    # Photo 15: singing into the microphone, turned 60 degrees away.
    assert classify_eyes(EyeMeasure((0.14, 0.54), (0.644, 0.221), 60, -12), CFG) == "unknown"


def test_eye_aspect_ratio():
    pts = [(0.0, 0.0)] * 400
    pts[33], pts[133] = (0, 0), (30, 0)  # corners, 30 px apart
    pts[160], pts[144] = (10, -3), (10, 3)
    pts[158], pts[153] = (20, -3), (20, 3)
    assert eye_aspect_ratio(pts, (33, 160, 158, 133, 153, 144)) == pytest.approx(0.2)


def face(x, size, score=0.9, turned=0.0):
    eye_r, eye_l = (x + 0.3 * size, 50.0), (x + 0.7 * size, 50.0)
    nose = (x + (0.5 + turned) * size, 70.0)
    return FaceInfo((x, 20.0, size, size), score, (eye_r, eye_l, nose, (0, 0), (0, 0)))


def test_only_faces_that_matter():
    main, friend = face(0, 300), face(400, 120)
    tiny, bystander, turned, unsure = face(800, 30), face(900, 60), face(1000, 250, turned=0.3), face(1300, 250, 0.5)
    kept = relevant_faces([main, friend, tiny, bystander, turned, unsure], CFG)
    assert kept == [main, friend]
    assert abs(yaw_proxy(turned)) > CFG.max_yaw_proxy
