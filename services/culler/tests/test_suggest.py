"""Your picks: recorded when you choose another best, summed up with settings that would agree."""

from __future__ import annotations

from datetime import UTC, datetime

from fastapi.testclient import TestClient
from test_api import BASE, OWNER, WRITE, client, wait  # noqa: F401  (client is a fixture)
from test_runner import env, roles, run, scenes  # noqa: F401  (env and scenes are fixtures)

from culler.config import Config, run_overrides
from culler.models import ExposureStats, Features, Frame
from culler.ranking import rank_group
from culler.suggest import MIN_PICKS, summarize

CFG = Config()
GOOD = ExposureStats(key=CFG.lighting.target_key, clip_hi=0, clip_lo=0, range=5)


def pick(reason: str | None = None, role: str = "rejected", source: str = "you", **deltas) -> dict:
    base = {
        "sharpRatio": 1.0,
        "lightingWorse": 0.0,
        "evGap": 0.0,
        "you": [1, 1, 1],
        "auto": [1, 1, 1],
        "smiles": [0, 0],
    }
    return {
        "groupId": "g",
        "source": source,
        "yourFrame": "y",
        "autoFrame": "a",
        "yourRole": role,
        "yourReason": reason,
        "deltas": {**base, **deltas},
        "at": "now",
    }


def by_section(summary: dict) -> dict[str, dict]:
    return {s["section"]: s for s in summary["suggestions"]}


def test_counts_and_sources():
    picks = [pick("blur", sharpRatio=0.6), pick("lighting", source="favourite"), pick(None, role="runner-up")]
    s = summarize(picks, 40, CFG)
    assert s["stacks"] == 40 and s["overruled"] == 3
    assert s["bySource"] == {"you": 2, "favourite": 1}
    assert s["byReason"] == {"lighting": 1, "blur": 1, "eyes": 0, "runner-up": 1}
    assert s["suggestions"] == []  # none has MIN_PICKS picks behind it


def test_blur_threshold_goes_just_below_your_softest_pick():
    picks = [pick("blur", sharpRatio=r) for r in (0.66, 0.62, 0.68)]
    assert len(picks) == MIN_PICKS
    s = by_section(summarize(picks, 10, CFG))["blur"]
    assert s["changes"] == [{"key": "blur.min_ratio", "from": 0.7, "to": 0.61}]
    assert s["options"] == {"blur": {"min_ratio": 0.61}}
    assert s["toml"] == "[blur]\nmin_ratio = 0.61"
    assert s["fixes"] == 3 and "62 % to 68 %" in s["why"]
    assert summarize(picks[:2], 10, CFG)["suggestions"] == []


def test_lighting_suggests_only_what_is_needed():
    picks = [pick("lighting", lightingWorse=w, evGap=g) for w, g in ((0.9, 0.5), (1.1, 0.8), (0.8, 0.2))]
    s = by_section(summarize(picks, 10, CFG))["lighting"]
    assert s["options"] == {"lighting": {"tolerance": 1.15}}
    picks = [pick("lighting", lightingWorse=0.3, evGap=g) for g in (1.4, 1.2, 1.6)]
    s = by_section(summarize(picks, 10, CFG))["lighting"]
    assert s["options"] == {"lighting": {"max_ev_gap": 1.7}} and s["fixes"] == 3


def test_half_blinks_but_not_closed_eyes():
    picks = [pick("eyes", closedMore=0, openGap=g) for g in (0.35, 0.40, 0.33)] + [pick("eyes", closedMore=1)]
    s = by_section(summarize(picks, 10, CFG))["eyes"]
    assert s["options"] == {"eyes": {"max_open_gap": 0.42}}
    assert s["fixes"] == 3 and s["of"] == 4 and "1 more had closed eyes" in s["why"]


def test_weights_that_would_have_picked_yours():
    # Your shots: a little softer, clearly more open eyes. Today's weights favour sharpness.
    picks = [pick(None, role="runner-up", you=[0.85, 1, 0.9], auto=[1.0, 1, 0.7]) for _ in range(3)]
    picks.append(pick(None, role="runner-up", you=[0.9, 1, 0.9], auto=[1.0, 1, 0.9], smiles=[0, 1]))  # smiles decided
    s = by_section(summarize(picks, 10, CFG))["ranking"]
    assert s["fixes"] == 3 and s["of"] == 3
    w = {c["key"]: c["to"] for c in s["changes"]}
    new = {**{"ranking.sharpness_weight": 0.45, "ranking.exposure_weight": 0.35, "ranking.eyes_weight": 0.2}, **w}
    assert abs(sum(new.values()) - 1) < 1e-9
    assert new["ranking.eyes_weight"] * 0.2 > new["ranking.sharpness_weight"] * 0.15  # yours now win
    # Preview with these options and your shot comes first.
    cfg = run_overrides(CFG, s["options"])
    assert cfg.ranking.eyes_weight == new["ranking.eyes_weight"]


# --- recorded by the ranking and the runner --------------------------------------------------------------


def frame(name: str, favorite: bool = False) -> Frame:
    return Frame(name, (name,), name, None, name, (), datetime(2024, 1, 1, tzinfo=UTC), None, name, favorite=favorite)


def test_ranking_records_the_culler_s_own_pick():
    sharp = Features("sharp", "jpeg", 1, 1, GOOD, 0.05, photo_sharpness=0.05)
    soft = Features("soft", "jpeg", 1, 1, GOOD, 0.03, photo_sharpness=0.03)  # 60 %: rejected for blur
    feats = {"sharp": sharp, "soft": soft}
    r = rank_group([frame("sharp"), frame("soft")], feats, CFG, pinned="soft")
    assert r.best == "soft" and r.pick
    assert (r.pick.source, r.pick.auto_frame, r.pick.your_role, r.pick.your_reason) == (
        "you",
        "sharp",
        "rejected",
        "blur",
    )
    assert r.pick.deltas["sharpRatio"] == 0.6
    fav = rank_group([frame("sharp"), frame("soft", favorite=True)], feats, CFG)
    assert fav.best == "soft" and fav.pick.source == "favourite"
    assert rank_group([frame("sharp"), frame("soft")], feats, CFG, pinned="sharp").pick is None  # same as the culler


def test_a_pick_in_immich_is_recorded_and_undone(env):  # noqa: F811
    immich, runner, store = env
    _, first = run(runner)
    r = roles(first)
    old_best = next(f for f in ("a0", "a3") if r[f][0] == "best")
    other = "a3" if old_best == "a0" else "a0"
    immich.update_stack(immich.stack_id_of("a0"), other)
    second, _ = run(runner)
    (p,) = store.picks()
    assert (p["yourFrame"], p["autoFrame"], p["source"], p["yourRole"]) == (other, old_best, "you", "runner-up")
    assert store.active_group_count() == 2
    runner.undo(second)
    assert store.picks() == []


def test_picks_route(client: TestClient):  # noqa: F811
    scope = {"kind": "day", "date": "2024-05-01"}
    wait(
        client,
        client.post(f"{BASE}/runs", json={"scope": scope, "dryRun": False}, cookies=OWNER, headers=WRITE).json()[
            "runId"
        ],
    )
    s = client.get(f"{BASE}/picks", cookies=OWNER).json()
    assert s["overruled"] == 0 and s["stacks"] == 2 and s["suggestions"] == []
    assert client.get(f"{BASE}/picks").status_code == 401
