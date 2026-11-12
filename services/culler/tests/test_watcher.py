from datetime import timedelta

import pytest
from conftest import T0, asset
from fake_immich import FakeImmich

from culler.config import Config, WatcherConfig, load_config, run_overrides
from culler.store import Store
from culler.watcher import CHECKPOINT, Watcher


class Clock:
    def __init__(self, t):
        self.t = t

    def __call__(self):
        return self.t


@pytest.fixture
def setup(tmp_path):
    immich = FakeImmich()
    store = Store(tmp_path / "w.sqlite")
    clock = Clock(T0 + timedelta(days=1))
    runs = []
    w = Watcher(WatcherConfig(quiet_s=300), immich, store, lambda scope, dry: runs.append((scope, dry)) or "run", clock)
    store.set(CHECKPOINT, "2024-05-01T00:00:00.000Z")
    yield immich, store, clock, runs, w
    store.close()


def upload(immich, aid, minutes_after_t0_day1, name=None, thumbhash="th"):
    # conftest's asset() puts uploads one day after T0 plus `seconds`.
    immich.add(asset(aid, name or f"{aid}.jpg", minutes_after_t0_day1 * 60, thumbhash=thumbhash))


def test_waits_until_the_upload_batch_is_quiet(setup):
    immich, store, clock, runs, w = setup
    upload(immich, "a", 0)
    clock.t = T0 + timedelta(days=1, minutes=2)
    assert w.check() is None and not runs
    clock.t = T0 + timedelta(days=1, minutes=6)
    assert w.check() == "run"
    ((scope, dry),) = runs
    assert scope["kind"] == "uploads" and scope["since"] == "2024-05-01T00:00:00.000Z"
    assert dry is False  # auto apply
    assert store.get(CHECKPOINT) == scope["until"]
    assert w.check() is None  # nothing new since


def test_waits_for_previews(setup):
    immich, _, clock, runs, w = setup
    upload(immich, "a", 0, thumbhash=None)
    clock.t = T0 + timedelta(days=1, minutes=10)
    assert w.check() is None and not runs
    clock.t = T0 + timedelta(days=1, hours=3)  # gives up waiting after preview_timeout_s
    assert w.check() == "run"


def test_editor_renders_alone_only_move_the_checkpoint(setup):
    immich, store, clock, runs, w = setup
    upload(immich, "r", 0, name="DSC1.edit.jpg")
    clock.t = T0 + timedelta(days=1, minutes=10)
    assert w.check() is None and not runs
    assert store.get(CHECKPOINT) != "2024-05-01T00:00:00.000Z"


def test_first_start_only_watches_new_uploads(tmp_path):
    store = Store(tmp_path / "x.sqlite")
    w = Watcher(WatcherConfig(), FakeImmich(), store, lambda *a: "run", Clock(T0))
    w.start()
    w.stop()
    assert store.get(CHECKPOINT) == "2024-05-01T10:00:00.000Z"
    store.close()


def test_run_options_are_validated_and_limited():
    cfg = Config()
    assert run_overrides(cfg, {"blur": {"min_ratio": 0.6}}).blur.min_ratio == 0.6
    assert run_overrides(cfg, {"ranking": {"order": ["blur", "lighting"]}}).ranking.order == ("blur", "lighting")
    for bad in (
        {"blur": {"min_ratio": "x"}},
        {"nope": {}},
        {"api_key": "x"},
        {"tags": {"root": "X"}},
        {"blur": {"x": 1}},
    ):
        with pytest.raises(ValueError):
            run_overrides(cfg, bad)


def test_environment_settings(tmp_path):
    (tmp_path / "key").write_text("secret-key\n")
    cfg = load_config(
        {
            "CULLER_DATA_DIR": str(tmp_path),
            "IMMICH_URL": "http://immich:2283/",
            "IMMICH_API_KEY_FILE": str(tmp_path / "key"),
            "CULLER_WATCH": "false",
            "CULLER_TAG_ROOT": "Cull/",
        }
    )
    assert cfg.immich_url == "http://immich:2283"
    assert cfg.api_key == "secret-key"
    assert cfg.watcher.enabled is False
    assert cfg.tags.root == "Cull"
    (tmp_path / "culler.toml").write_text("[blur]\nmin_ratio = 0.5\n")
    assert load_config({"CULLER_DATA_DIR": str(tmp_path)}).blur.min_ratio == 0.5
