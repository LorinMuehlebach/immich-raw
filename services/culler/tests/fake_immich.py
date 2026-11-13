"""In-memory Immich with the stack behaviour measured in M0 (docs/spike-results.md), exposing the
same methods as culler.immich.ImmichClient."""

from __future__ import annotations

import itertools
from collections import defaultdict
from typing import Any

from culler.immich import ImmichError
from culler.models import Asset, parse_time


def _exposure_text(t: float | None) -> str | None:
    """As Immich shows it: '1/250' below a second, else seconds."""
    if t is None:
        return None
    return f"1/{round(1 / t)}" if t < 1 else f"{t:g}"


class FakeImmich:
    def __init__(self, owner: str = "owner"):
        self.owner = owner
        self.data: dict[str, dict[str, Any]] = {}
        self.stacks: dict[str, dict[str, Any]] = {}
        self.tag_rows: dict[str, str] = {}  # id -> value
        self.asset_tags: dict[str, set[str]] = defaultdict(set)
        self.meta: dict[str, dict[str, Any]] = defaultdict(dict)
        self.images: dict[str, bytes] = {}
        self.originals: dict[str, bytes] = {}  # e.g. a DNG behind a RAW asset
        self.calls: list[tuple] = []
        self._ids = itertools.count(1)

    # --- setup ------------------------------------------------------------------------------------
    def add(self, a: Asset, image: bytes | None = None) -> None:
        self.data[a.id] = {
            "id": a.id,
            "ownerId": self.owner,
            "originalFileName": a.name,
            "fileCreatedAt": a.taken.isoformat().replace("+00:00", "Z"),
            "localDateTime": a.local_date + "T00:00:00.000Z",
            "createdAt": a.uploaded.isoformat().replace("+00:00", "Z"),
            "checksum": a.checksum,
            "thumbhash": a.thumbhash,
            "isFavorite": a.is_favorite,
            "isTrashed": a.is_trashed,
            "duplicateId": a.duplicate_id,
            "type": "IMAGE",
            "visibility": "timeline",
            "exifInfo": {
                "rating": a.rating,
                "make": a.make,
                "model": a.model,
                "exposureTime": _exposure_text(a.exposure_time),
                "fNumber": a.f_number,
                "iso": a.iso,
            },
        }
        if image is not None:
            self.images[a.id] = image

    def stack_ids(self, *ids: str) -> str:
        return self.create_stack(list(ids))["id"]

    def stack_id_of(self, asset_id: str) -> str | None:
        return next((s["id"] for s in self.stacks.values() if asset_id in s["assetIds"]), None)

    def tags_of(self, asset_id: str) -> set[str]:
        return {self.tag_rows[t] for t in self.asset_tags[asset_id]}

    def rating(self, asset_id: str) -> int | None:
        return self.data[asset_id]["exifInfo"]["rating"]

    # --- client API ---------------------------------------------------------------------------------
    def me(self) -> dict:
        return {"id": self.owner, "email": "owner@example.com"}

    def server_version(self) -> dict:
        return {"major": 3, "minor": 4, "patch": 0}

    def search(self, filter: dict, with_exif: bool = True):
        def ok(d: dict) -> bool:
            for field, key in (("takenAt", "fileCreatedAt"), ("createdAt", "createdAt")):
                f = filter.get(field)
                if not f:
                    continue
                v = parse_time(d[key])
                if "gte" in f and v < parse_time(f["gte"]) or "lte" in f and v > parse_time(f["lte"]):
                    return False
                if "gt" in f and v <= parse_time(f["gt"]):
                    return False
            return not d["isTrashed"]

        return iter(sorted((self.asset(i) for i, d in self.data.items() if ok(d)), key=lambda d: d["fileCreatedAt"]))

    def asset(self, asset_id: str) -> dict:
        if asset_id not in self.data:
            raise ImmichError(400, "Not found or no asset.read access")
        d = dict(self.data[asset_id])
        sid = self.stack_id_of(asset_id)
        d["stack"] = (
            {
                "id": sid,
                "primaryAssetId": self.stacks[sid]["primaryAssetId"],
                "assetCount": len(self.stacks[sid]["assetIds"]),
            }
            if sid
            else None
        )
        d["tags"] = [{"id": t, "value": self.tag_rows[t]} for t in sorted(self.asset_tags[asset_id])]
        d["exifInfo"] = dict(d["exifInfo"])
        return d

    def assets(self, ids: list[str], workers: int = 6) -> dict[str, dict]:
        return {i: self.asset(i) for i in ids if i in self.data}

    def update_assets(self, ids: list[str], **fields: Any) -> None:
        self.calls.append(("update_assets", tuple(ids), fields))
        for i in ids:
            if "rating" in fields:
                self.data[i]["exifInfo"]["rating"] = fields["rating"]

    def thumbnail(self, asset_id: str, size: str = "preview") -> bytes:
        if asset_id not in self.images:
            raise ImmichError(404, "no thumbnail")
        return self.images[asset_id]

    def original(self, asset_id: str, dest) -> None:
        if asset_id in self.originals:
            dest.write_bytes(self.originals[asset_id])
        elif asset_id in self.images:
            dest.write_bytes(self.images[asset_id])
        else:
            raise ImmichError(404, "no original")

    def metadata(self, asset_id: str) -> dict[str, Any]:
        return dict(self.meta[asset_id])

    def put_metadata(self, items) -> None:
        self.calls.append(("put_metadata", len(items)))
        for a, k, v in items:
            self.meta[a][k] = v

    def delete_metadata(self, items) -> None:
        self.calls.append(("delete_metadata", len(items)))
        for a, k in items:
            self.meta[a].pop(k, None)

    def stack(self, stack_id: str) -> dict:
        if stack_id not in self.stacks:
            raise ImmichError(400, "Stack not found")
        s = self.stacks[stack_id]
        return {"id": stack_id, "primaryAssetId": s["primaryAssetId"], "assets": [self.asset(a) for a in s["assetIds"]]}

    def create_stack(self, asset_ids: list[str]) -> dict:
        self.calls.append(("create_stack", tuple(asset_ids)))
        if len(asset_ids) < 2:
            raise ImmichError(400, "assetIds must contain at least 2 elements")
        absorbed = [s for s in self.stacks.values() if s["primaryAssetId"] in asset_ids]
        members = list(dict.fromkeys([*asset_ids, *(a for s in absorbed for a in s["assetIds"])]))
        for s in absorbed:
            del self.stacks[s["id"]]
        for s in self.stacks.values():  # a non-primary moves and leaves its old stack behind
            s["assetIds"] = [a for a in s["assetIds"] if a not in members]
        sid = f"stack-{next(self._ids)}"
        self.stacks[sid] = {"id": sid, "primaryAssetId": asset_ids[0], "assetIds": members}
        return {"id": sid, "primaryAssetId": asset_ids[0]}

    def update_stack(self, stack_id: str, primary_id: str) -> dict:
        self.calls.append(("update_stack", stack_id, primary_id))
        s = self.stacks.get(stack_id)
        if s is None or primary_id not in s["assetIds"]:
            raise ImmichError(400, "Primary asset must be in the stack")
        s["primaryAssetId"] = primary_id
        return {"id": stack_id, "primaryAssetId": primary_id}

    def remove_from_stack(self, stack_id: str, asset_id: str) -> None:
        s = self.stacks[stack_id]
        if asset_id == s["primaryAssetId"]:
            raise ImmichError(400, "Cannot remove stack's primary asset")
        s["assetIds"].remove(asset_id)

    def delete_stack(self, stack_id: str) -> None:
        self.calls.append(("delete_stack", stack_id))
        if stack_id not in self.stacks:
            raise ImmichError(400, "Stack not found")
        del self.stacks[stack_id]

    def tags(self) -> list[dict]:
        return [{"id": i, "value": v} for i, v in self.tag_rows.items()]

    def upsert_tags(self, values: list[str]) -> list[dict]:
        out = []
        for value in values:
            parts = value.split("/")
            for n in range(1, len(parts) + 1):
                path = "/".join(parts[:n])
                if path not in self.tag_rows.values():
                    self.tag_rows[f"tag-{next(self._ids)}"] = path
            out.append(next({"id": i, "value": v} for i, v in self.tag_rows.items() if v == value))
        return out

    def tag_assets(self, tag_ids: list[str], asset_ids: list[str]) -> None:
        self.calls.append(("tag_assets", tuple(tag_ids), tuple(asset_ids)))
        for a in asset_ids:
            self.asset_tags[a].update(tag_ids)

    def untag_assets(self, tag_id: str, asset_ids: list[str]) -> None:
        self.calls.append(("untag_assets", tag_id, tuple(asset_ids)))
        for a in asset_ids:
            self.asset_tags[a].discard(tag_id)
