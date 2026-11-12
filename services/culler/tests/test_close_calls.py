"""Close calls: the best and the next shot nearly tied."""

from datetime import UTC, datetime

from culler.config import Config, run_overrides
from culler.models import ExposureStats, FaceInfo, Features, Frame
from culler.ranking import rank_brackets, rank_group

CFG = Config()
GOOD = ExposureStats(key=CFG.lighting.target_key, clip_hi=0, clip_lo=0, range=5)


def frame(name: str, favorite: bool = False) -> Frame:
    return Frame(name, (name,), name, None, name, (), datetime(2024, 1, 1, tzinfo=UTC), None, name, favorite=favorite)


def feats(name: str, sharp: float, smile: float | None = None) -> Features:
    faces = [FaceInfo((10, 10, 50, 50), 0.9, smile=smile)] if smile is not None else []
    return Features(name, "jpeg", 1, 1, GOOD, sharp, faces, photo_sharpness=sharp)


def rank(*fs: Features, cfg: Config = CFG, pinned: str | None = None, favourite: str | None = None):
    frames = [frame(f.asset_id, favorite=f.asset_id == favourite) for f in fs]
    return rank_group(frames, {f.asset_id: f for f in fs}, cfg, pinned=pinned)


def test_nearly_tied_is_a_close_call():
    r = rank(feats("a", 0.050), feats("b", 0.049))
    assert r.best == "a" and r.close_call
    assert 0 < r.margin < CFG.ranking.close_margin


def test_a_clear_lead_is_not():
    r = rank(feats("a", 0.050), feats("b", 0.040))  # 80 %: passes the blur check, loses clearly
    assert r.best == "a" and r.results["b"].role == "runner-up"
    assert not r.close_call and r.margin >= CFG.ranking.close_margin


def test_smiles_decide_so_not_close():
    r = rank(feats("a", 0.049, smile=0.8), feats("b", 0.050, smile=0.0))
    assert r.best == "a" and not r.close_call


def test_your_pick_or_a_favourite_is_never_a_close_call():
    assert not rank(feats("a", 0.050), feats("b", 0.049), pinned="b").close_call
    assert not rank(feats("a", 0.050), feats("b", 0.049), favourite="b").close_call


def test_no_runner_up_no_close_call():
    r = rank(feats("a", 0.050), feats("b", 0.020))  # b rejected for blur
    assert r.results["b"].role == "rejected" and not r.close_call and r.margin is None


def test_margin_and_weights_are_settings():
    wide = run_overrides(CFG, {"ranking": {"close_margin": 0.2}})
    assert rank(feats("a", 0.050), feats("b", 0.040), cfg=wide).close_call
    # All weight on exposure: equally exposed shots tie exactly.
    exposure_only = run_overrides(
        CFG, {"ranking": {"sharpness_weight": 0.0, "exposure_weight": 1.0, "eyes_weight": 0.0}}
    )
    r = rank(feats("a", 0.050), feats("b", 0.040), cfg=exposure_only)
    assert r.close_call and r.margin == 0


def test_brackets_have_no_close_calls():
    fs = [feats("a", 0.05), feats("b", 0.05), feats("c", 0.05)]
    frames = [frame(f.asset_id) for f in fs]
    r = rank_brackets(frames, {f.asset_id: f for f in fs}, CFG)
    assert not r.close_call and r.kind == "bracket"
