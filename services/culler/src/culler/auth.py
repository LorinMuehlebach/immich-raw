"""Who is calling: the request's own Immich login (session cookie, API key or bearer token) is
checked with Immich, and it must be the user whose API key the service runs with."""

from __future__ import annotations

import hashlib
import threading
import time
from collections.abc import Callable
from urllib.parse import urlsplit

import httpx

CACHE_SECONDS = 60
FORWARDED_COOKIES = ("immich_access_token", "immich_auth_type", "immich_is_authenticated")


class AuthError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def credentials(headers: dict[str, str], cookies: dict[str, str]) -> dict[str, str]:
    """The headers to send to Immich to act as the caller (lower-case header names)."""
    out: dict[str, str] = {}
    if headers.get("x-api-key"):
        out["x-api-key"] = headers["x-api-key"]
    if headers.get("authorization", "").lower().startswith("bearer "):
        out["authorization"] = headers["authorization"]
    jar = "; ".join(f"{k}={v}" for k, v in cookies.items() if k in FORWARDED_COOKIES)
    if jar:
        out["cookie"] = jar
    return out


class Authenticator:
    def __init__(
        self, immich_url: str, owner_id: Callable[[], str | None], transport: httpx.BaseTransport | None = None
    ):
        self._http = httpx.Client(base_url=f"{immich_url.rstrip('/')}/api", timeout=15, transport=transport)
        self._owner_id = owner_id
        self._cache: dict[str, tuple[str, float]] = {}
        self._lock = threading.Lock()

    def user_id(self, creds: dict[str, str]) -> str:
        if not creds:
            raise AuthError(401, "log in to Immich first")
        key = hashlib.sha256(repr(sorted(creds.items())).encode()).hexdigest()
        now = time.monotonic()
        with self._lock:
            hit = self._cache.get(key)
            if hit and hit[1] > now:
                return hit[0]
        try:
            res = self._http.get("/users/me", headers=creds)
        except httpx.TransportError as e:
            raise AuthError(503, f"cannot reach Immich: {e}") from e
        if res.status_code in (401, 403):
            raise AuthError(401, "your Immich login is not valid")
        if res.status_code >= 400:
            raise AuthError(502, f"Immich answered {res.status_code}")
        uid = res.json()["id"]
        with self._lock:
            if len(self._cache) > 1000:
                self._cache.clear()
            self._cache[key] = (uid, now + CACHE_SECONDS)
        return uid

    def require_owner(self, creds: dict[str, str]) -> str:
        uid = self.user_id(creds)
        if uid != self._owner_id():
            raise AuthError(403, "this service works on another Immich user's library")
        return uid


def check_same_origin(headers: dict[str, str]) -> None:
    """Changes need the editor's header (forces a CORS preflight, so other sites can't send it)
    and, when the browser says where the request comes from, the same host."""
    if headers.get("x-raw-editor") != "1":
        raise AuthError(403, "missing X-Raw-Editor header")
    origin = headers.get("origin")
    if origin:
        # Host names only: reverse proxies often pass Host without the port (nginx $host).
        host = (headers.get("x-forwarded-host") or headers.get("host") or "").split(",")[0].strip()
        if (urlsplit(origin).hostname or "").lower() != (urlsplit(f"//{host}").hostname or "").lower():
            raise AuthError(403, "request from another site")
