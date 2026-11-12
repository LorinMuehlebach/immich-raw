"""Settings: built-in defaults, then a TOML file, then environment variables.

The TOML file is CULLER_CONFIG, or <data dir>/culler.toml when it exists. Its sections match the
dataclasses below ([grouping], [brackets], [lighting], [blur], [eyes], [people], [subjects], [smiles],
[ranking], [tags], [watcher]).
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
class BracketsConfig:
    """Exposure brackets (see brackets.py) get a stack of their own: the middle exposure in front,
    none of them rejected."""

    enabled: bool = True
    min_frames: int = 3
    max_gap_s: float = 2.0  # plus the previous shot's exposure time
    min_spread_ev: float = 1.0  # the set's exposures span at least this
    min_step_ev: float = 0.3  # exposures closer than this count as the same
    min_follow: float = 0.5  # the measured brightness moves by at least this share of each step


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
    # The people in a photo count most for its exposure: its faces, or else the people found without
    # a usable face. Their brightness and their own blown / crushed areas get this share of the score.
    # A group is judged on faces when every shot has one, else on people when every shot shows some.
    people_first: bool = True
    face_weight: float = 0.8
    body_weight: float = 0.6
    # Well exposed skin is brighter than a whole scene's average and differs between people: its own
    # target, with a wider band that costs nothing.
    face_target_key: float = math.log2(0.21)
    face_dead_band_ev: float = 1.0
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
    # How open the eyes are, 0 (shut) to 1 (fully open), from the same eye opening: 0 at ear_shut,
    # 1 from ear_open. Measured: closed 0.08-0.13, open 0.19-0.32, smiling (narrower) 0.22-0.27.
    ear_shut: float = 0.10
    ear_open: float = 0.24
    turned_deg: float = 30.0  # turned further: only the eye nearer the camera counts (the far one looks wider)
    # Also rejected: shots whose least open eyes are this much less open than in the best shot
    # (half-blinks). A squinting smile stays within it.
    max_open_gap: float = 0.30


@dataclass(frozen=True)
class PeopleConfig:
    """People found by MediaPipe's object detector (EfficientDet-Lite0, COCO 'person'): also seen
    from the side, from behind or too small for a face. Used for exposure when no face is usable."""

    enabled: bool = True
    min_score: float = 0.5
    min_area: float = 0.02  # share of the photo: drops people far in the background
    min_area_ratio: float = 0.15  # of the largest person


# The animals of COCO, which the people detector (EfficientDet-Lite0) knows as well.
ANIMALS = ("bird", "cat", "dog", "horse", "sheep", "cow", "elephant", "bear", "zebra", "giraffe")


@dataclass(frozen=True)
class SubjectsConfig:
    """Animals, found by the same object detector as people. Without a face, sharpness is measured
    on the largest animal when every shot of a group shows one, instead of the sharpest areas."""

    enabled: bool = True
    labels: tuple[str, ...] = ANIMALS
    min_score: float = 0.4
    min_area: float = 0.01  # share of the photo


@dataclass(frozen=True)
class SmilesConfig:
    """Among the shots that pass every check, the one with the most smiling faces is the best."""

    enabled: bool = True
    # MediaPipe's mouthSmile scores, both mouth corners averaged. Measured on real portraits:
    # neutral faces 0.00-0.17, smiles 0.48-0.87.
    min_score: float = 0.4


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
    brackets: BracketsConfig = field(default_factory=BracketsConfig)
    lighting: LightingConfig = field(default_factory=LightingConfig)
    blur: BlurConfig = field(default_factory=BlurConfig)
    eyes: EyesConfig = field(default_factory=EyesConfig)
    people: PeopleConfig = field(default_factory=PeopleConfig)
    subjects: SubjectsConfig = field(default_factory=SubjectsConfig)
    smiles: SmilesConfig = field(default_factory=SmilesConfig)
    ranking: RankingConfig = field(default_factory=RankingConfig)
    tags: TagConfig = field(default_factory=TagConfig)
    watcher: WatcherConfig = field(default_factory=WatcherConfig)

    def with_overrides(self, overrides: dict[str, Any] | None) -> Config:
        """A copy with `overrides` applied; unknown keys or wrong types raise ValueError."""
        return _merge(self, overrides or {}, "")

    def analysis_dict(self) -> dict[str, Any]:
        """The settings that change measured features (part of the feature cache key)."""
        e, p, s = self.eyes, self.people, self.subjects
        return {
            "faces": [e.detector_score, e.min_face_px, e.min_face_area_ratio, e.max_yaw_proxy],
            "people": [p.min_score, p.min_area, p.min_area_ratio],
            "animals": [sorted(s.labels), s.min_score, s.min_area],
            "raw": [self.lighting.raw_source, self.lighting.raw_headroom_ev],
        }


# Section names a run's `options` may change. Connection settings and the tag root are not.
OVERRIDABLE = {"grouping", "brackets", "lighting", "blur", "eyes", "people", "subjects", "smiles", "ranking"}


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
