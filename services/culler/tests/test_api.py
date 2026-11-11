from __future__ import annotations

import time

import httpx
import pytest
from conftest import asset, make_scene, variant
from fake_immich import FakeImmich
from fastapi.testclient import TestClient
from test_runner import SPECS, TinyEmbedder, jpeg

from culler.api import create_app
from culler.auth import Authenticator
from culler.config import Config
from culler.features import Analyzer
from culler.service import Service
from culler.store import Store

BASE = "/immich-raw/culler/api/v1"
OWNER = {"immich_access_token": "good"}
OTHER = {"immich_access_token": "other"}
WRITE = {"X-Raw-Editor": "1"}


def immich_users(request: httpx.Request) -> httpx.Response:
    cookie = request.headers.get("cookie", "")
    if "immich_access_token=good" in cookie or request.headers.get("x-api-key") == "key":
        return httpx.Response(200, json={"id": "owner"})
    if "immich_access_token=other" in cookie:
        return httpx.Response(200, json={"id": "someone-else"})
    return httpx.Response(401, json={"message": "Invalid user token"})


@pytest.fixture
def client(tmp_path):
    scenes = {k: make_scene(seed, h=480, w=720) for k, seed in (("A", 1), ("B", 2), ("C", 3))}
    immich = FakeImmich()
    for aid, (scene, sec, kw) in SPECS.items():
        immich.add(asset(aid, f"{aid}.jpg", sec, make="Fuji", model="X-T5"), jpeg(variant(scenes[scene], **kw)))
    cfg = Config(data_dir=tmp_path, webhook_secret="s3cret")
    service = Service(
        cfg, immich, Store(tmp_path / "c.sqlite"), lambda c: Analyzer(c, embedder=TinyEmbedder(), load_models=False)
    )
    service.start(watch=False)
    auth = Authenticator("http://immich", lambda: service.owner_id, transport=httpx.MockTransport(immich_users))
    with TestClient(create_app(service, auth)) as c:
        c.immich = immich
        yield c
    service.stop()


def wait(c: TestClient, run_id: str) -> dict:
    for _ in range(200):
        r = c.get(f"{BASE}/runs/{run_id}", cookies=OWNER).json()
        if r["status"] in ("done", "failed"):
            return r
        time.sleep(0.05)
    raise AssertionError("run did not finish")


def test_health_needs_no_login(client):
    assert client.get(f"{BASE}/health").json()["ok"] is True


def test_login_is_required_and_must_be_the_owner(client):
    assert client.get(f"{BASE}/runs").status_code == 401
    assert client.get(f"{BASE}/runs", cookies={"immich_access_token": "bad"}).status_code == 401
    assert client.get(f"{BASE}/runs", cookies=OTHER).status_code == 403
    assert client.get(f"{BASE}/runs", cookies=OWNER).status_code == 200
    assert client.get(f"{BASE}/runs", headers={"x-api-key": "key"}).status_code == 200


def test_changes_need_the_editor_header_and_same_origin(client):
    body = {"scope": {"kind": "day", "date": "2024-05-01"}}
    assert client.post(f"{BASE}/runs", json=body, cookies=OWNER).status_code == 403
    other_site = {**WRITE, "Origin": "https://evil.example", "Host": "photos.example"}
    assert client.post(f"{BASE}/runs", json=body, cookies=OWNER, headers=other_site).status_code == 403
    same_site = {**WRITE, "Origin": "http://photos.example:8088", "Host": "photos.example"}
    assert client.post(f"{BASE}/runs", json=body, cookies=OWNER, headers=same_site).status_code == 202


def test_bad_scope_or_options_are_rejected(client):
    r = client.post(f"{BASE}/runs", json={"scope": {"kind": "week"}}, cookies=OWNER, headers=WRITE)
    assert r.status_code == 400
    r = client.post(
        f"{BASE}/runs",
        json={"scope": {"kind": "day", "date": "2024-05-01"}, "options": {"blur": {"min_ratio": "x"}}},
        cookies=OWNER,
        headers=WRITE,
    )
    assert r.status_code == 400 and "min_ratio" in r.json()["message"]


def test_dry_run_apply_lookup_pick_and_undo(client):
    scope = {"kind": "day", "date": "2024-05-01"}
    rid = client.post(f"{BASE}/runs", json={"scope": scope, "dryRun": True}, cookies=OWNER, headers=WRITE).json()[
        "runId"
    ]
    dry = wait(client, rid)
    assert dry["status"] == "done" and dry["summary"]["groups"] == 2
    assert not client.immich.stacks

    applied = wait(client, client.post(f"{BASE}/runs/{rid}/apply", cookies=OWNER, headers=WRITE).json()["runId"])
    assert applied["status"] == "done" and client.immich.stacks

    items = client.post(f"{BASE}/assets/lookup", json={"ids": list(SPECS)}, cookies=OWNER).json()["items"]
    assert items["a2"]["role"] == "rejected" and items["a2"]["reason"] == "blur"
    assert "c0" not in items

    group = items["a0"]["groupId"]
    runner_up = next(a for a, i in items.items() if i["groupId"] == group and i["role"] == "runner-up")
    picked = wait(
        client,
        client.post(f"{BASE}/groups/{group}/best", json={"assetId": runner_up}, cookies=OWNER, headers=WRITE).json()[
            "runId"
        ],
    )
    assert picked["status"] == "done"
    assert client.immich.stacks[client.immich.stack_id_of(runner_up)]["primaryAssetId"] == runner_up
    assert client.post(f"{BASE}/assets/lookup", json={"ids": [runner_up]}, cookies=OWNER).json()["items"][runner_up][
        "pinned"
    ]

    # Undo newest first.
    assert client.post(f"{BASE}/runs/{applied['id']}/undo", cookies=OWNER, headers=WRITE).status_code == 202
    blocked = wait(client, client.get(f"{BASE}/runs", cookies=OWNER).json()["runs"][0]["id"])
    assert blocked["status"] == "failed" and "later runs" in blocked["error"]
    wait(client, client.post(f"{BASE}/runs/{picked['id']}/undo", cookies=OWNER, headers=WRITE).json()["runId"])
    wait(client, client.post(f"{BASE}/runs/{applied['id']}/undo", cookies=OWNER, headers=WRITE).json()["runId"])
    assert not client.immich.stacks


def test_ungroup_takes_a_stack_apart_for_good(client):
    rid = client.post(
        f"{BASE}/runs",
        json={"scope": {"kind": "day", "date": "2024-05-01"}, "dryRun": False},
        cookies=OWNER,
        headers=WRITE,
    ).json()["runId"]
    wait(client, rid)
    group = client.post(f"{BASE}/assets/lookup", json={"ids": ["b0"]}, cookies=OWNER).json()["items"]["b0"]["groupId"]
    wait(client, client.delete(f"{BASE}/groups/{group}", cookies=OWNER, headers=WRITE).json()["runId"])
    assert client.immich.stack_id_of("b0") is None
    again = wait(
        client,
        client.post(
            f"{BASE}/runs",
            json={"scope": {"kind": "day", "date": "2024-05-01"}, "dryRun": False},
            cookies=OWNER,
            headers=WRITE,
        ).json()["runId"],
    )
    assert again["status"] == "done"
    assert client.immich.stack_id_of("b0") is None
    assert client.immich.stack_id_of("a0") is not None


def test_webhook_needs_the_secret(client):
    assert client.post(f"{BASE}/hooks/immich", json={}).status_code == 404
    assert client.post(f"{BASE}/hooks/immich", json={}, headers={"X-Culler-Secret": "nope"}).status_code == 404
    payload = {"trigger": "AssetCreate", "data": {"asset": {"id": "x", "ownerId": "owner"}}}
    assert client.post(f"{BASE}/hooks/immich", json=payload, headers={"X-Culler-Secret": "s3cret"}).status_code == 204
