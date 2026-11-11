"""Plain data types shared by the analysis, the planner and the API."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Literal

import numpy as np

# Same list as packages/inject/src/raw.ts (Immich's RAW types minus .psd, .ari, .cin).
RAW_EXTENSIONS = frozenset(
    {
        *(".3fr", ".arw", ".cap", ".cr2", ".cr3", ".crw", ".dcr", ".dng", ".erf", ".fff", ".iiq", ".k25", ".kdc"),
        *(".mrw", ".nef", ".nrw", ".orf", ".ori", ".pef", ".raf", ".raw", ".rw2", ".rwl", ".sr2", ".srf", ".srw"),
        ".x3f",
    }
)

# Metadata keys written by the editor (packages/recipe) and by this service.
RENDER_KEY = "raw-editor.render"
CULL_KEY = "raw-editor.cull"
APP_ID = "immich-raw-culler@0.1.0"

Role = Literal["best", "runner-up", "rejected"]
Reason = Literal["lighting", "blur", "eyes"]


def parse_time(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        t = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return t if t.tzinfo else t.replace(tzinfo=UTC)


def extension(name: str) -> str:
    dot = name.rfind(".")
    return name[dot:].lower() if dot >= 0 else ""


def capture_base_name(name: str) -> str:
    """'DSC01234.ARW' and 'DSC01234.JPG' and the editor's 'DSC01234.edit.jpg' -> 'dsc01234'."""
    lower = name.lower()
    if lower.endswith(".edit.jpg"):
        lower = lower[: -len(".edit.jpg")]
    dot = lower.rfind(".")
    return lower[:dot] if dot > 0 else lower


@dataclass(frozen=True)
class Tag:
    id: str
    value: str


@dataclass(frozen=True)
class StackRef:
    id: str
    primary_id: str
    count: int


@dataclass(frozen=True)
class Asset:
    id: str
    owner_id: str
    name: str
    taken: datetime
    local_date: str
    uploaded: datetime
    checksum: str
    thumbhash: str | None
    is_favorite: bool = False
    is_trashed: bool = False
    rating: int | None = None
    make: str | None = None
    model: str | None = None
    duplicate_id: str | None = None
    stack: StackRef | None = None
    tags: tuple[Tag, ...] = ()
    type: str = "IMAGE"
    visibility: str = "timeline"
    width: int | None = None
    height: int | None = None

    @property
    def is_raw(self) -> bool:
        return extension(self.name) in RAW_EXTENSIONS

    @property
    def is_render_name(self) -> bool:
        return self.name.lower().endswith(".edit.jpg")

    @property
    def base_name(self) -> str:
        return capture_base_name(self.name)

    @property
    def camera(self) -> str | None:
        parts = [p.strip() for p in (self.make, self.model) if p and p.strip()]
        return " ".join(parts) if parts else None

    @classmethod
    def from_api(cls, d: dict[str, Any]) -> Asset:
        exif = d.get("exifInfo") or {}
        stack = d.get("stack")
        taken = parse_time(d.get("fileCreatedAt")) or parse_time(exif.get("dateTimeOriginal"))
        uploaded = parse_time(d.get("createdAt"))
        return cls(
            id=d["id"],
            owner_id=d.get("ownerId", ""),
            name=d.get("originalFileName", ""),
            taken=taken or datetime.fromtimestamp(0, UTC),
            local_date=(d.get("localDateTime") or "")[:10],
            uploaded=uploaded or datetime.fromtimestamp(0, UTC),
            checksum=d.get("checksum", ""),
            thumbhash=d.get("thumbhash"),
            is_favorite=bool(d.get("isFavorite")),
            is_trashed=bool(d.get("isTrashed")),
            rating=exif.get("rating"),
            make=exif.get("make"),
            model=exif.get("model"),
            duplicate_id=d.get("duplicateId"),
            stack=StackRef(stack["id"], stack["primaryAssetId"], int(stack.get("assetCount", 0))) if stack else None,
            tags=tuple(Tag(t["id"], t["value"]) for t in d.get("tags") or ()),
            type=d.get("type", "IMAGE"),
            visibility=d.get("visibility", "timeline"),
            width=d.get("width"),
            height=d.get("height"),
        )


@dataclass(frozen=True)
class Stack:
    id: str
    primary_id: str
    asset_ids: tuple[str, ...]


@dataclass(frozen=True)
class Frame:
    """One capture: a RAW, its camera JPEG and the editor's renders of it, or a single photo."""

    id: str  # the RAW's id, else the camera JPEG's, else the render's: stable across runs
    asset_ids: tuple[str, ...]
    face_id: str  # what goes in front of the stack when this frame is the best
    raw_id: str | None
    jpeg_id: str | None  # camera JPEG/HEIC (anything that is not RAW and not a render)
    render_ids: tuple[str, ...]
    taken: datetime
    camera: str | None
    name: str
    favorite: bool = False
    starred: bool = False  # the user gave it 1-5 stars
    duplicate_ids: frozenset[str] = frozenset()


@dataclass
class ExposureStats:
    key: float  # log2 of the typical brightness (linear)
    clip_hi: float
    clip_lo: float
    range: float  # stops between the 5th and 95th percentile
    badness: float = 0.0


@dataclass
class FaceInfo:
    box: tuple[float, float, float, float]  # x, y, w, h in analysis-image pixels
    score: float
    landmarks: tuple[tuple[float, float], ...] = ()  # YuNet: eye R, eye L, nose, mouth R, mouth L
    state: Literal["open", "closed", "unknown"] = "unknown"
    blink: tuple[float, float] | None = None
    ear: tuple[float, float] | None = None  # eye opening, left and right
    yaw: float | None = None
    pitch: float | None = None

    def to_json(self) -> dict[str, Any]:
        return {
            "box": list(self.box),
            "score": self.score,
            "landmarks": [list(p) for p in self.landmarks],
            "state": self.state,
            "blink": list(self.blink) if self.blink else None,
            "ear": list(self.ear) if self.ear else None,
            "yaw": self.yaw,
            "pitch": self.pitch,
        }

    @classmethod
    def from_json(cls, d: dict[str, Any]) -> FaceInfo:
        return cls(
            box=tuple(d["box"]),
            score=d["score"],
            landmarks=tuple(tuple(p) for p in d.get("landmarks") or ()),
            state=d.get("state", "unknown"),
            blink=tuple(d["blink"]) if d.get("blink") else None,
            ear=tuple(d["ear"]) if d.get("ear") else None,
            yaw=d.get("yaw"),
            pitch=d.get("pitch"),
        )


@dataclass
class Features:
    asset_id: str
    source: Literal["raw", "jpeg", "render"]
    width: int
    height: int
    exposure: ExposureStats
    sharpness: float
    faces: list[FaceInfo] = field(default_factory=list)
    embedding: np.ndarray | None = None
    exposure_source: Literal["preview", "raw"] = "preview"

    @property
    def faces_known(self) -> int:
        return sum(1 for f in self.faces if f.state != "unknown")

    @property
    def faces_closed(self) -> int:
        return sum(1 for f in self.faces if f.state == "closed")

    def to_json(self) -> dict[str, Any]:
        e = self.exposure
        return {
            "assetId": self.asset_id,
            "source": self.source,
            "width": self.width,
            "height": self.height,
            "exposure": {"key": e.key, "clipHi": e.clip_hi, "clipLo": e.clip_lo, "range": e.range},
            "sharpness": self.sharpness,
            "faces": [f.to_json() for f in self.faces],
            "exposureSource": self.exposure_source,
        }

    @classmethod
    def from_json(cls, d: dict[str, Any], embedding: np.ndarray | None) -> Features:
        e = d["exposure"]
        return cls(
            asset_id=d["assetId"],
            source=d["source"],
            width=d["width"],
            height=d["height"],
            exposure=ExposureStats(e["key"], e["clipHi"], e["clipLo"], e["range"]),
            sharpness=d["sharpness"],
            faces=[FaceInfo.from_json(f) for f in d.get("faces") or ()],
            embedding=embedding,
            exposure_source=d.get("exposureSource", "preview"),
        )


@dataclass
class FrameResult:
    frame_id: str
    role: Role
    reason: Reason | None
    rank: int
    score: float
    pinned: bool = False
    metrics: dict[str, Any] = field(default_factory=dict)


@dataclass
class GroupResult:
    frame_ids: list[str]  # ranked: best first
    results: dict[str, FrameResult]

    @property
    def best(self) -> str:
        return self.frame_ids[0]
