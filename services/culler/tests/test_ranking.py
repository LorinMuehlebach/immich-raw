from conftest import asset

from culler.config import Config
from culler.frames import build_frames
from culler.models import ExposureStats, FaceInfo, Features
from culler.ranking import rank_group

CFG = Config()
GOOD = ExposureStats(key=CFG.lighting.target_key, clip_hi=0, clip_lo=0, range=5)


def exp(ev: float) -> ExposureStats:
    return ExposureStats(key=CFG.lighting.target_key + ev, clip_hi=0, clip_lo=0, range=5)


def faces(open_: int, closed: int) -> list[FaceInfo]:
    return [FaceInfo((0, 0, 50, 50), 0.9, state="open") for _ in range(open_)] + [
        FaceInfo((0, 0, 50, 50), 0.9, state="closed") for _ in range(closed)
    ]


def setup(specs, **kw):
    """specs: id -> (exposure, sharpness, faces); frames 1 s apart in id order."""
    ids = sorted(specs)
    fr = build_frames([asset(i, f"{i}.ARW", n, **kw.get(i, {})) for n, i in enumerate(ids)], {}, {}, set()).frames
    feats = {i: Features(i, "raw", 100, 100, e, s, fc) for i, (e, s, fc) in specs.items()}
    return fr, feats


def test_order_of_checks_lighting_first():
    # 'a' is dark but the sharpest: it goes for lighting, not for being sharp.
    fr, ft = setup({"a": (exp(-2), 1.0, []), "b": (GOOD, 0.9, []), "c": (GOOD, 0.5, [])})
    r = rank_group(fr, ft, CFG)
    assert r.best == "b"
    assert r.results["a"].role == "rejected" and r.results["a"].reason == "lighting"
    assert r.results["c"].reason == "blur"
    assert r.frame_ids == ["b", "c", "a"]  # blur survived longer than lighting


def test_eyes_only_among_survivors():
    fr, ft = setup(
        {
            "a": (GOOD, 1.0, faces(2, 1)),
            "b": (GOOD, 0.95, faces(3, 0)),
            "c": (GOOD, 0.5, faces(3, 0)),  # open eyes but blurred
        }
    )
    r = rank_group(fr, ft, CFG)
    assert r.best == "b"
    assert r.results["a"].reason == "eyes"
    assert r.results["c"].reason == "blur"


def test_no_faces_skips_the_eyes_check():
    fr, ft = setup({"a": (GOOD, 1.0, []), "b": (GOOD, 0.98, [])})
    r = rank_group(fr, ft, CFG)
    assert r.results["b"].role == "runner-up" and r.results["b"].reason is None


def test_tie_break_prefers_sharper_then_earlier():
    fr, ft = setup({"a": (GOOD, 0.9, []), "b": (GOOD, 1.0, []), "c": (GOOD, 1.0, [])})
    assert rank_group(fr, ft, CFG).frame_ids == ["b", "c", "a"]


def test_pinned_frame_is_best_even_if_a_check_would_reject_it():
    fr, ft = setup({"a": (GOOD, 1.0, []), "b": (GOOD, 0.4, [])})
    r = rank_group(fr, ft, CFG, pinned="b")
    assert r.best == "b" and r.results["b"].pinned and r.results["b"].reason is None
    assert r.results["a"].role == "runner-up"


def test_single_favourite_is_best():
    fr, ft = setup({"a": (GOOD, 1.0, []), "b": (exp(-2), 0.5, [])}, b={"is_favorite": True})
    r = rank_group(fr, ft, CFG)
    assert r.best == "b"


def test_metrics_for_the_tooltip():
    fr, ft = setup({"a": (GOOD, 1.0, []), "b": (exp(-1.5), 0.5, [])})
    m = rank_group(fr, ft, CFG).results["b"].metrics
    assert m["evVsBest"] == -1.5
    assert m["sharpPct"] == 50
