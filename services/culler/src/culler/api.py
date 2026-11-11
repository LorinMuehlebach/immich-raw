"""HTTP API under <base path>/api/v1 (default /immich-raw/culler/api/v1), reached through the same
reverse proxy as Immich. Every call needs the caller's Immich login (see auth.py)."""

from __future__ import annotations

import hmac
from typing import Any

from fastapi import APIRouter, Body, Depends, FastAPI, HTTPException, Request, Response
from fastapi.responses import JSONResponse

from culler.auth import Authenticator, AuthError, check_same_origin, credentials
from culler.runner import RunError
from culler.service import Service

MAX_LOOKUP = 2000


def create_app(service: Service, auth: Authenticator | None = None) -> FastAPI:
    cfg = service.cfg
    auth = auth or Authenticator(cfg.immich_url, lambda: service.owner_id)
    app = FastAPI(title="Immich culler", docs_url=None, redoc_url=None, openapi_url=None)
    api = APIRouter(prefix=f"{cfg.base_path.rstrip('/')}/api/v1")

    @app.exception_handler(AuthError)
    async def _auth_error(_: Request, e: AuthError) -> JSONResponse:
        return JSONResponse({"message": e.message}, status_code=e.status)

    @app.exception_handler(RunError)
    async def _run_error(_: Request, e: RunError) -> JSONResponse:
        return JSONResponse({"message": str(e)}, status_code=409)

    @app.exception_handler(ValueError)
    async def _bad_request(_: Request, e: ValueError) -> JSONResponse:
        return JSONResponse({"message": str(e)}, status_code=400)

    def reader(request: Request) -> str:
        return auth.require_owner(credentials(dict(request.headers), request.cookies))

    def writer(request: Request) -> str:
        check_same_origin(dict(request.headers))
        return reader(request)

    def body_dict(payload: Any) -> dict[str, Any]:
        if not isinstance(payload, dict):
            raise ValueError("expected a JSON object")
        return payload

    @api.get("/health")
    def health() -> dict:
        return service.health()

    @api.get("/me", dependencies=[Depends(reader)])
    def me() -> dict:
        return {"owner": service.owner_email, **service.health(), "watcher": service.watcher.state()}

    @api.post("/runs", status_code=202, dependencies=[Depends(writer)])
    def start_run(payload: Any = Body(...)) -> dict:
        p = body_dict(payload)
        rid = service.submit_run(
            p.get("scope"), bool(p.get("dryRun", True)), p.get("options"), "ui", force=bool(p.get("force", False))
        )
        return {"runId": rid}

    @api.get("/runs", dependencies=[Depends(reader)])
    def list_runs(limit: int = 20) -> dict:
        return {"runs": service.store.runs(max(1, min(limit, 200)))}

    @api.get("/runs/{run_id}", dependencies=[Depends(reader)])
    def get_run(run_id: str) -> dict:
        run = service.store.run(run_id)
        if not run:
            raise HTTPException(404, "unknown run")
        return run

    @api.post("/runs/{run_id}/apply", status_code=202, dependencies=[Depends(writer)])
    def apply_run(run_id: str) -> dict:
        return {"runId": service.submit_apply(run_id)}

    @api.post("/runs/{run_id}/undo", status_code=202, dependencies=[Depends(writer)])
    def undo_run(run_id: str) -> dict:
        return {"runId": service.submit_undo(run_id)}

    @api.post("/assets/lookup", dependencies=[Depends(reader)])
    def lookup(payload: Any = Body(...)) -> dict:
        ids = body_dict(payload).get("ids")
        if not isinstance(ids, list) or not all(isinstance(i, str) for i in ids) or len(ids) > MAX_LOOKUP:
            raise ValueError(f"ids: expected up to {MAX_LOOKUP} asset ids")
        return {"items": service.lookup(ids)}

    @api.post("/groups/{group_id}/best", status_code=202, dependencies=[Depends(writer)])
    def make_best(group_id: str, payload: Any = Body(...)) -> dict:
        asset_id = body_dict(payload).get("assetId")
        if not isinstance(asset_id, str):
            raise ValueError("assetId: expected an asset id")
        return {"runId": service.submit_best(group_id, asset_id)}

    @api.post("/groups/{group_id}/recull", status_code=202, dependencies=[Depends(writer)])
    def recull(group_id: str) -> dict:
        return {"runId": service.submit_recull(group_id)}

    @api.delete("/groups/{group_id}", status_code=202, dependencies=[Depends(writer)])
    def ungroup(group_id: str) -> dict:
        return {"runId": service.submit_ungroup(group_id)}

    @api.get("/watcher", dependencies=[Depends(reader)])
    def watcher_state() -> dict:
        return service.watcher.state()

    @api.put("/watcher", dependencies=[Depends(writer)])
    def watcher_update(payload: Any = Body(...)) -> dict:
        p = body_dict(payload)
        for key in ("enabled", "autoApply"):
            if key in p and not isinstance(p[key], bool):
                raise ValueError(f"{key}: expected true/false")
        service.watcher.set(enabled=p.get("enabled"), auto_apply=p.get("autoApply"))
        return service.watcher.state()

    @api.post("/hooks/immich", status_code=204)
    def immich_hook(request: Request, payload: Any = Body(None)) -> Response:
        """Target for an Immich workflow's Webhook step. It only wakes the watcher early."""
        secret = cfg.webhook_secret
        given = request.headers.get("x-culler-secret", "")
        if not secret or not hmac.compare_digest(given.encode(), secret.encode()):
            raise HTTPException(404)
        owner = (
            ((payload or {}).get("data") or {}).get("asset", {}).get("ownerId") if isinstance(payload, dict) else None
        )
        if owner in (None, service.owner_id):
            service.watcher.wake()
        return Response(status_code=204)

    app.include_router(api)
    return app
