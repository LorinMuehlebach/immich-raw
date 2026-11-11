"""Settings: built-in defaults, then a TOML file, then environment variables.

The TOML file is CULLER_CONFIG, or <data dir>/culler.toml when it exists. Its sections match the
dataclasses below ([grouping], [lighting], [blur], [eyes], [ranking], [tags], [watcher]).
Runs started from the editor may pass `options` with the same shape to try other thresholds.
"""

from __future__ import annotations

import math
import os
import tomllib
from dataclasses import dataclass, field, fields, is_dataclass, replace
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class GroupingConfig:
    max_gap_s: float = 90.0  # a longer pause between two shots starts a new scene
    max_span_s: float = 600.0  # one stack never covers more than this
    max_size: int = 60
    link_similarity: float = 0.88  # cosine to one of the group's last few frames
    medoid_similarity: float = 0.82  # cosine to the group's most typical frame (stops drift in a pan)
    recent_frames: int = 3
    split_by_camera: bool = True


@dataclass(frozen=True)
class LightingConfig:
    enabled: bool = True
    tolerance: float = 0.75  # reject when this much worse than the best frame
    max_ev_gap: float = 1.0  # ... or this many stops off the best frame's brightness and worse at all
    target_key: float = math.log2(0.16)  # same target as the editor's Auto tone
    dead_band_ev: float = 0.5  # brightness within this of the target costs nothing
    clip_hi_free: float = 0.005
    clip_hi_weight: float = 10.0
    clip_lo_free: float = 0.02
    clip_lo_weight: float = 5.0
    min_range_ev: float = 3.5  # flatter than this (haze, flare) costs a little
    range_weight: float = 0.25
    face_weight: float = 0.6
    # RAW frames: measure from the RAW file ("file") or from Immich's preview ("preview"). Immich
    # renders RAW previews with automatic brightness, which hides a darker or brighter frame.
    raw_source: str = "file"
    raw_headroom_ev: float = 1.0  # a well exposed RAW sits this far below what its JPEG shows


@dataclass(frozen=True)
class BlurConfig:
    enabled: bool = True
    min_ratio: float = 0.70  # reject when below this share of the sharpest survivor


@dataclass(frozen=True)
class EyesConfig:
    enabled: bool = True
    detector_score: float = 0.7
    min_face_px: int = 40
    min_face_area_ratio: float = 0.10  # of the largest face: drops people in the background
    max_yaw_proxy: float = 0.5
    max_yaw_deg: float = 40.0  # turned further away: eyes are not judged
    max_pitch_deg: float = 50.0
    # Closed when the eye opening (height/width from landmarks, both eyes averaged) is below
    # ear_closed, or both blink scores are at least blink_closed. Calibrated on stage photos:
    # closed eyes measured 0.08-0.13, open ones 0.19-0.35.
    ear_closed: float = 0.155
    blink_closed: float = 0.5


@dataclass(frozen=True)
class RankingConfig:
    order: tuple[str, ...] = ("lighting", "blur", "eyes")
    respect_favorites: bool = True


@dataclass(frozen=True)
class TagConfig:
    root: str = "Culling"


@dataclass(frozen=True)
class WatcherConfig:
    enabled: bool = True
    interval_s: int = 120
    quiet_s: int = 300  # wait until uploads have paused this long
    preview_timeout_s: int = 7200
    auto_apply: bool = True


@dataclass(frozen=True)
class Config:
    immich_url: str = "http://immich-server:2283"
    api_key: str = field(default="", repr=False)
    data_dir: Path = Path("/data")
    models_dir: Path = Path("/models")
    port: int = 8080
    base_path: str = "/immich-raw/culler"
    webhook_secret: str = field(default="", repr=False)
    threads: int = 2
    grouping: GroupingConfig = field(default_factory=GroupingConfig)
    lighting: LightingConfig = field(default_factory=LightingConfig)
    blur: BlurConfig = field(default_factory=BlurConfig)
    eyes: EyesConfig = field(default_factory=EyesConfig)
    ranking: RankingConfig = field(default_factory=RankingConfig)
    tags: TagConfig = field(default_factory=TagConfig)
    watcher: WatcherConfig = field(default_factory=WatcherConfig)

    def with_overrides(self, overrides: dict[str, Any] | None) -> Config:
        """A copy with `overrides` applied; unknown keys or wrong types raise ValueError."""
        return _merge(self, overrides or {}, "")

    def analysis_dict(self) -> dict[str, Any]:
        """The settings that change measured features (part of the feature cache key)."""
        e = self.eyes
        return {
            "eyes": [e.enabled, e.detector_score, e.min_face_px, e.min_face_area_ratio, e.max_yaw_proxy],
            "face_weight": self.lighting.face_weight,
            "raw": [self.lighting.raw_source, self.lighting.raw_headroom_ev],
        }


# Section names a run's `options` may change. Connection settings and the tag root are not.
OVERRIDABLE = {"grouping", "lighting", "blur", "eyes", "ranking"}


def _coerce(name: str, current: Any, value: Any) -> Any:
    if isinstance(current, bool):
        if not isinstance(value, bool):
            raise ValueError(f"{name}: expected true/false")
        return value
    if isinstance(current, int) and not isinstance(current, bool):
        if isinstance(value, bool) or not isinstance(value, int):
            raise ValueError(f"{name}: expected a whole number")
        return value
    if isinstance(current, float):
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            raise ValueError(f"{name}: expected a number")
        return float(value)
    if isinstance(current, tuple):
        if not isinstance(value, (list, tuple)) or not all(isinstance(v, str) for v in value):
            raise ValueError(f"{name}: expected a list of names")
        return tuple(value)
    if isinstance(current, Path):
        return Path(str(value))
    if isinstance(current, str):
        if not isinstance(value, str):
            raise ValueError(f"{name}: expected text")
        return value
    raise ValueError(f"{name}: cannot be set")


def _merge(obj: Any, values: dict[str, Any], prefix: str, allowed: set[str] | None = None) -> Any:
    if not isinstance(values, dict):
        raise ValueError(f"{prefix or 'options'}: expected a table")
    known = {f.name: f for f in fields(obj)}
    changes: dict[str, Any] = {}
    for key, value in values.items():
        name = f"{prefix}{key}"
        if key not in known or (allowed is not None and key not in allowed):
            raise ValueError(f"unknown setting: {name}")
        current = getattr(obj, key)
        changes[key] = _merge(current, value, f"{name}.") if is_dataclass(current) else _coerce(name, current, value)
    return replace(obj, **changes)


def _env_bool(value: str) -> bool:
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _read_secret(env: dict[str, str], name: str) -> str | None:
    if env.get(f"{name}_FILE"):
        return Path(env[f"{name}_FILE"]).read_text(encoding="utf-8").strip()
    return env.get(name)


def load_config(env: dict[str, str] | None = None) -> Config:
    env = dict(os.environ if env is None else env)
    cfg = Config()
    if env.get("CULLER_DATA_DIR"):
        cfg = replace(cfg, data_dir=Path(env["CULLER_DATA_DIR"]))

    toml_path = Path(env["CULLER_CONFIG"]) if env.get("CULLER_CONFIG") else cfg.data_dir / "culler.toml"
    if toml_path.is_file():
        with toml_path.open("rb") as f:
            cfg = _merge(cfg, tomllib.load(f), "")

    simple: dict[str, Any] = {}
    if env.get("IMMICH_URL"):
        simple["immich_url"] = env["IMMICH_URL"].rstrip("/")
    api_key = _read_secret(env, "IMMICH_API_KEY")
    if api_key:
        simple["api_key"] = api_key
    secret = _read_secret(env, "CULLER_WEBHOOK_SECRET")
    if secret:
        simple["webhook_secret"] = secret
    if env.get("CULLER_MODELS_DIR"):
        simple["models_dir"] = Path(env["CULLER_MODELS_DIR"])
    if env.get("CULLER_PORT"):
        simple["port"] = int(env["CULLER_PORT"])
    if env.get("CULLER_THREADS"):
        simple["threads"] = max(1, int(env["CULLER_THREADS"]))
    cfg = replace(cfg, **simple)

    watcher: dict[str, Any] = {}
    if env.get("CULLER_WATCH"):
        watcher["enabled"] = _env_bool(env["CULLER_WATCH"])
    if env.get("CULLER_AUTO_APPLY"):
        watcher["auto_apply"] = _env_bool(env["CULLER_AUTO_APPLY"])
    if env.get("CULLER_WATCH_INTERVAL"):
        watcher["interval_s"] = int(env["CULLER_WATCH_INTERVAL"])
    if env.get("CULLER_WATCH_QUIET"):
        watcher["quiet_s"] = int(env["CULLER_WATCH_QUIET"])
    if watcher:
        cfg = replace(cfg, watcher=replace(cfg.watcher, **watcher))
    if env.get("CULLER_TAG_ROOT"):
        cfg = replace(cfg, tags=TagConfig(root=env["CULLER_TAG_ROOT"].strip("/")))
    return cfg


def run_overrides(cfg: Config, options: dict[str, Any] | None) -> Config:
    """Applies a run's `options`: only the analysis sections may change."""
    if not options:
        return cfg
    if not isinstance(options, dict):
        raise ValueError("options: expected an object")
    return _merge(cfg, options, "", allowed=OVERRIDABLE)
