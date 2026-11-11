"""Thin Immich REST client. Every route the service uses is here, so a change in Immich's API
(e.g. PUT routes moving to PATCH, deprecated in 3.x) is a change in this file only.
Checked against Immich 3.4.0 (spikes/immich-api/cull-check.mjs)."""

from __future__ import annotations

import logging
import time
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

import httpx

log = logging.getLogger(__name__)

PAGE_SIZE = 1000  # Immich's maximum


class ImmichError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(f"Immich {status}: {message}")
        self.status = status
        self.message = message


class ImmichClient:
    def __init__(
        self,
        base_url: str,
        api_key: str | None = None,
        headers: dict[str, str] | None = None,
        transport: httpx.BaseTransport | None = None,
        timeout: float = 60.0,
    ):
        h = {"Accept": "application/json", **(headers or {})}
        if api_key:
            h["x-api-key"] = api_key
        self._http = httpx.Client(
            base_url=f"{base_url.rstrip('/')}/api", headers=h, timeout=timeout, transport=transport
        )

    def close(self) -> None:
        self._http.close()

    def __enter__(self) -> ImmichClient:
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    def _request(self, method: str, path: str, json: Any = None, params: dict | None = None, raw: bool = False) -> Any:
        for attempt in range(3):
            try:
                res = self._http.request(method, path, json=json, params=params)
            except httpx.TransportError as e:
                if attempt == 2:
                    raise ImmichError(0, f"cannot reach Immich: {e}") from e
                time.sleep(1 + attempt * 2)
                continue
            if res.status_code in (502, 503, 504) and attempt < 2:
                time.sleep(1 + attempt * 2)
                continue
            if res.status_code >= 400:
                try:
                    message = res.json().get("message", res.text)
                except ValueError:
                    message = res.text
                raise ImmichError(res.status_code, str(message))
            if raw:
                return res.content
            if res.status_code == 204 or not res.content:
                return None
            return res.json()
        raise AssertionError("unreachable")

    # --- users / server -----------------------------------------------------------------------
    def me(self) -> dict:
        return self._request("GET", "/users/me")

    def server_version(self) -> dict:
        return self._request("GET", "/server/version")

    # --- search -------------------------------------------------------------------------------
    def search(self, filter: dict, with_exif: bool = True) -> Iterator[dict]:
        """All assets matching a structured filter, oldest first (cursor paging)."""
        cursor = None
        while True:
            body: dict[str, Any] = {
                "filter": filter,
                "size": PAGE_SIZE,
                "withExif": with_exif,
                "orderBy": {"field": "fileCreatedAt", "direction": "asc"},
            }
            if cursor:
                body["cursor"] = cursor
            page = self._request("POST", "/search/metadata", json=body)["assets"]
            yield from page["items"]
            cursor = page.get("nextCursor")
            if not cursor:
                return

    # --- assets -------------------------------------------------------------------------------
    def asset(self, asset_id: str) -> dict:
        return self._request("GET", f"/assets/{asset_id}")

    def assets(self, ids: list[str], workers: int = 6) -> dict[str, dict]:
        """Full info (with stack, tags, rating) for many assets; missing ones are left out."""

        def one(i: str) -> dict | None:
            try:
                return self.asset(i)
            except ImmichError as e:
                if e.status in (400, 404):
                    return None
                raise

        with ThreadPoolExecutor(max_workers=workers) as pool:
            return {d["id"]: d for d in pool.map(one, ids) if d}

    def update_assets(self, ids: list[str], **fields: Any) -> None:
        self._request("PUT", "/assets", json={"ids": ids, **fields})

    def thumbnail(self, asset_id: str, size: str = "preview") -> bytes:
        return self._request("GET", f"/assets/{asset_id}/thumbnail", params={"size": size}, raw=True)

    def original(self, asset_id: str, dest: Path) -> None:
        """Streams the original file (e.g. the RAW) to `dest`."""
        try:
            with self._http.stream("GET", f"/assets/{asset_id}/original") as res:
                if res.status_code >= 400:
                    raise ImmichError(res.status_code, res.read().decode(errors="replace")[:200])
                with dest.open("wb") as f:
                    for chunk in res.iter_bytes(1 << 20):
                        f.write(chunk)
        except httpx.TransportError as e:
            raise ImmichError(0, f"cannot reach Immich: {e}") from e

    def metadata(self, asset_id: str) -> dict[str, Any]:
        return {m["key"]: m["value"] for m in self._request("GET", f"/assets/{asset_id}/metadata") or ()}

    def put_metadata(self, items: list[tuple[str, str, Any]]) -> None:
        if items:
            body = {"items": [{"assetId": a, "key": k, "value": v} for a, k, v in items]}
            self._request("PUT", "/assets/metadata", json=body)

    def delete_metadata(self, items: list[tuple[str, str]]) -> None:
        if items:
            self._request("DELETE", "/assets/metadata", json={"items": [{"assetId": a, "key": k} for a, k in items]})

    # --- stacks -------------------------------------------------------------------------------
    def stack(self, stack_id: str) -> dict:
        return self._request("GET", f"/stacks/{stack_id}")

    def create_stack(self, asset_ids: list[str]) -> dict:
        """The first id becomes the primary; stacks whose primary is passed are absorbed."""
        return self._request("POST", "/stacks", json={"assetIds": asset_ids})

    def update_stack(self, stack_id: str, primary_id: str) -> dict:
        return self._request("PUT", f"/stacks/{stack_id}", json={"primaryAssetId": primary_id})

    def remove_from_stack(self, stack_id: str, asset_id: str) -> None:
        self._request("DELETE", f"/stacks/{stack_id}/assets/{asset_id}")

    def delete_stack(self, stack_id: str) -> None:
        self._request("DELETE", f"/stacks/{stack_id}")

    # --- tags ---------------------------------------------------------------------------------
    def tags(self) -> list[dict]:
        return self._request("GET", "/tags")

    def upsert_tags(self, values: list[str]) -> list[dict]:
        """Creates missing tags (and their parents) for full paths such as 'Culling/Rejected/Blur'."""
        return self._request("PUT", "/tags", json={"tags": values})

    def tag_assets(self, tag_ids: list[str], asset_ids: list[str]) -> None:
        if asset_ids:
            self._request("PUT", "/tags/assets", json={"tagIds": tag_ids, "assetIds": asset_ids})

    def untag_assets(self, tag_id: str, asset_ids: list[str]) -> None:
        if asset_ids:
            self._request("DELETE", f"/tags/{tag_id}/assets", json={"ids": asset_ids})
