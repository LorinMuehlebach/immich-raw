import cv2
from conftest import variant

from culler.features.sharpness import measure_sharpness


def test_more_blur_is_less_sharp(scene):
    s = [measure_sharpness(variant(scene, blur=b)) for b in (0, 1, 2, 3)]
    assert s[0] > s[1] > s[2] > s[3]


def test_blurred_frame_falls_below_the_reject_ratio(scene):
    assert measure_sharpness(variant(scene, blur=2)) < 0.7 * measure_sharpness(variant(scene))
    assert measure_sharpness(variant(scene, blur=3)) < 0.7 * measure_sharpness(variant(scene))


def test_exposure_does_not_change_sharpness_much(scene):
    base = measure_sharpness(variant(scene))
    for ev in (-1.0, 0.5):
        assert abs(measure_sharpness(variant(scene, ev=ev)) / base - 1) < 0.10


def test_noise_does_not_make_a_soft_frame_win(scene):
    sharp_noisy = measure_sharpness(variant(scene, noise=6))
    soft_noisy = measure_sharpness(variant(scene, blur=2, noise=6))
    assert sharp_noisy > soft_noisy / 0.7
    assert measure_sharpness(variant(scene, blur=2, noise=6)) < 0.7 * measure_sharpness(variant(scene))


def test_sharp_subject_on_blurred_background_beats_all_blurred(scene):
    sharp = variant(scene)
    soft = cv2.GaussianBlur(sharp, (0, 0), 3)
    subject = soft.copy()
    subject[300:600, 500:900] = sharp[300:600, 500:900]
    assert measure_sharpness(subject) > 1.5 * measure_sharpness(soft)


def test_face_eye_band_is_measured(scene):
    sharp = variant(scene)
    soft = cv2.GaussianBlur(sharp, (0, 0), 3)
    box = (400.0, 200.0, 300.0, 300.0)
    mixed = soft.copy()
    mixed[200:500, 400:700] = sharp[200:500, 400:700]  # the "face" is sharp, the rest is not
    assert measure_sharpness(mixed, [box]) > 2 * measure_sharpness(soft, [box])
