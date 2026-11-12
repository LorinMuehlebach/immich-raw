"""Plain data types shared by the analysis, the planner and the API."""

from __future__ import annotations

import math
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

Role = Literal["best", "runner-up", "rejected", "bracket"]
Reason = Literal["lighting", "blur", "eyes"]


def parse_time(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        t = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return t if t.tzinfo else t.replace(tzinfo=UTC)


def parse_exposure_time(value: Any) -> float | None:
    """Seconds from Immich's exposure time: '1/250', '0.5', '30' or a number."""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        t = float(value)
    else:
        text = str(value).strip().removesuffix("s").strip()
        try:
            if "/" in text:
                num, den = text.split("/", 1)
                t = float(num) / float(den)
            else:
                t = float(text)
        except (ValueError, ZeroDivisionError):
            return None
    return t if math.isfinite(t) and t > 0 else None


def camera_exposure_ev(exposure_time: float | None, f_number: float | None, iso: float | None) -> float | None:
    """How much light the settings let in, in stops (more = brighter): log2(t * ISO/100 / N^2)."""
    if not exposure_time or not f_number or not iso or exposure_time <= 0 or f_number <= 0 or iso <= 0:
        return None
    return math.log2(exposure_time * iso / 100 / (f_number * f_number))


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
    exposure_time: float | None = None  # seconds
    f_number: float | None = None
    iso: float | None = None

    @property
    def exposure_ev(self) -> float | None:
        return camera_exposure_ev(self.exposure_time, self.f_number, self.iso)

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
            exposure_time=parse_exposure_time(exif.get("exposureTime")),
            f_number=exif.get("fNumber"),
            iso=exif.get("iso"),
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
    exposure_ev: float | None = None  # the camera settings' exposure (see camera_exposure_ev)
    exposure_time: float | None = None  # seconds


@dataclass
class ExposureStats:
    key: float  # log2 of the typical brightness (linear)
    clip_hi: float
    clip_lo: float
    range: float  # stops between the 5th and 95th percentile
    badness: float = 0.0

    def to_json(self) -> dict[str, Any]:
        return {"key": self.key, "clipHi": self.clip_hi, "clipLo": self.clip_lo, "range": self.range}

    @classmethod
    def from_json(cls, d: dict[str, Any] | None) -> ExposureStats | None:
        return cls(d["key"], d["clipHi"], d["clipLo"], d["range"]) if d else None


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
    smile: float | None = None  # 0 = neutral, 1 = a broad smile (both mouth corners averaged)
    openness: float | None = None  # eyes: 0 = shut, 1 = fully open (set with `state`, not stored)

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
            "smile": self.smile,
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
            smile=d.get("smile"),
        )


@dataclass
class BodyInfo:
    """A person (also without a usable face) or an animal found by the object detector."""

    box: tuple[float, float, float, float]  # x, y, w, h in analysis-image pixels
    score: float
    label: str = "person"  # COCO's name: 'person', 'bird', 'dog', ...

    def to_json(self) -> dict[str, Any]:
        d: dict[str, Any] = {"box": list(self.box), "score": self.score}
        if self.label != "person":
            d["label"] = self.label
        return d

    @classmethod
    def from_json(cls, d: dict[str, Any]) -> BodyInfo:
        return cls(box=tuple(d["box"]), score=d["score"], label=d.get("label", "person"))


@dataclass
class Features:
    asset_id: str
    source: Literal["raw", "jpeg", "render"]
    width: int
    height: int
    exposure: ExposureStats  # the whole photo, its centre weighted
    sharpness: float
    faces: list[FaceInfo] = field(default_factory=list)
    embedding: np.ndarray | None = None
    exposure_source: Literal["preview", "raw"] = "preview"
    bodies: list[BodyInfo] = field(default_factory=list)
    face_exposure: ExposureStats | None = None  # the faces only
    body_exposure: ExposureStats | None = None  # the people found by the object detector
    # `sharpness` is the face's eye band when there is a face, else this: the sharpest 5 % of tiles.
    photo_sharpness: float | None = None
    face_sharpness: bool = False  # `sharpness` was measured on a face
    animals: list[BodyInfo] = field(default_factory=list)  # largest first
    subject_sharpness: float | None = None  # the largest animal's box

    @property
    def faces_known(self) -> int:
        return sum(1 for f in self.faces if f.state != "unknown")

    @property
    def faces_closed(self) -> int:
        return sum(1 for f in self.faces if f.state == "closed")

    def eyes_openness(self) -> list[float]:
        """How open the eyes of each judged face are (0-1)."""
        return [f.openness for f in self.faces if f.state != "unknown" and f.openness is not None]

    def faces_smiling(self, min_score: float) -> int:
        return sum(1 for f in self.faces if f.smile is not None and f.smile >= min_score)

    def to_json(self) -> dict[str, Any]:
        e = self.exposure
        return {
            "assetId": self.asset_id,
            "source": self.source,
            "width": self.width,
            "height": self.height,
            "exposure": e.to_json(),
            "sharpness": self.sharpness,
            "faces": [f.to_json() for f in self.faces],
            "exposureSource": self.exposure_source,
            "bodies": [b.to_json() for b in self.bodies],
            "faceExposure": self.face_exposure.to_json() if self.face_exposure else None,
            "bodyExposure": self.body_exposure.to_json() if self.body_exposure else None,
            "photoSharpness": self.photo_sharpness,
            "faceSharpness": self.face_sharpness,
            "animals": [a.to_json() for a in self.animals],
            "subjectSharpness": self.subject_sharpness,
        }

    @classmethod
    def from_json(cls, d: dict[str, Any], embedding: np.ndarray | None) -> Features:
        return cls(
            asset_id=d["assetId"],
            source=d["source"],
            width=d["width"],
            height=d["height"],
            exposure=ExposureStats.from_json(d["exposure"]),
            sharpness=d["sharpness"],
            faces=[FaceInfo.from_json(f) for f in d.get("faces") or ()],
            embedding=embedding,
            exposure_source=d.get("exposureSource", "preview"),
            bodies=[BodyInfo.from_json(b) for b in d.get("bodies") or ()],
            face_exposure=ExposureStats.from_json(d.get("faceExposure")),
            body_exposure=ExposureStats.from_json(d.get("bodyExposure")),
            photo_sharpness=d.get("photoSharpness"),
            face_sharpness=bool(d.get("faceSharpness")),
            animals=[BodyInfo.from_json(a) for a in d.get("animals") or ()],
            subject_sharpness=d.get("subjectSharpness"),
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
class PickInfo:
    """The user chose another best than the culler would have: what the culler would have picked,
    and how the user's shot compared (for the "your picks" report and its suggestions)."""

    source: Literal["you", "favourite"]
    your_frame: str
    auto_frame: str
    your_role: Role  # what the user's shot would have been without the pick
    your_reason: Reason | None
    # sharpRatio (of the sharpest shot), lightingWorse (exposure score above the best one), evGap
    # (stops from the best-exposed shot), openGap (least open eyes below the best), closedMore,
    # you/auto: the tie-break parts (sharpness, exposure, eyes), smiles: [you, auto]
    deltas: dict[str, Any] = field(default_factory=dict)

    def to_json(self) -> dict[str, Any]:
        return {
            "source": self.source,
            "yourFrame": self.your_frame,
            "autoFrame": self.auto_frame,
            "yourRole": self.your_role,
            "yourReason": self.your_reason,
            "deltas": self.deltas,
        }


@dataclass
class GroupResult:
    frame_ids: list[str]  # ranked: best first (for a bracket: the shot in front)
    results: dict[str, FrameResult]
    close_call: bool = False  # the best and the next shot nearly tied: worth a look
    margin: float | None = None  # the best's lead over the next shot on the tie-break score
    kind: Literal["burst", "bracket"] = "burst"
    pick: PickInfo | None = None  # the user's pick differs from the culler's

    @property
    def best(self) -> str:
        return self.frame_ids[0]
