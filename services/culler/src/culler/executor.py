"""Carries out planned operations against Immich, one by one, collecting errors instead of stopping."""

from __future__ import annotations

import logging
import time
from collections import defaultdict
from collections.abc import Callable
from dataclasses import dataclass, field

from culler.immich import ImmichClient, ImmichError
from culler.models import CULL_KEY, Asset
from culler.planner import (
    AddTag,
    CreateStack,
    DeleteMeta,
    DeleteStack,
    Op,
    PutMeta,
    RemoveTag,
    SetRating,
    UpdatePrimary,
    culler_tags,
)

log = logging.getLogger(__name__)
META_BATCH = 100
TAG_CHECKS = (2.0, 4.0, 8.0)  # seconds to wait before each check of the tags just changed


@dataclass
class ExecResult:
    done: int = 0
    errors: list[str] = field(default_factory=list)
    stacks: dict[str, str] = field(default_factory=dict)  # group id -> stack id


def describe(op: Op) -> str:
    match op:
        case DeleteStack():
            return f"unstack {len(op.asset_ids)} photos"
        case CreateStack():
            return f"stack {len(op.asset_ids)} photos"
        case UpdatePrimary():
            return f"put {op.primary_id} in front"
        case AddTag():
            return f"tag {len(op.asset_ids)} photos {op.value}"
        case RemoveTag():
            return f"remove tag {op.value} from {len(op.asset_ids)} photos"
        case SetRating():
            return f"{'flag' if op.rating == -1 else 'unflag'} {len(op.asset_ids)} photos as rejected"
        case PutMeta():
            return f"store details on {len(op.items)} photos"
        case DeleteMeta():
            return f"remove details from {len(op.asset_ids)} photos"
    return type(op).__name__


def execute(client: ImmichClient, ops: list[Op], progress: Callable[[int, int], None] | None = None) -> ExecResult:
    result = ExecResult()
    tag_ids: dict[str, str] = {}
    if any(isinstance(op, (AddTag, RemoveTag)) for op in ops):
        tag_ids = {t["value"]: t["id"] for t in client.tags()}
        wanted = sorted({op.value for op in ops if isinstance(op, AddTag) and op.value not in tag_ids})
        if wanted:
            tag_ids.update({t["value"]: t["id"] for t in client.upsert_tags(wanted)})

    for i, op in enumerate(ops):
        try:
            match op:
                case DeleteStack():
                    try:
                        client.delete_stack(op.stack_id)
                    except ImmichError as e:
                        if e.status not in (400, 404):  # already gone
                            raise
                case CreateStack():
                    created = client.create_stack(list(op.asset_ids))
                    if op.group_id:
                        result.stacks[op.group_id] = created["id"]
                case UpdatePrimary():
                    client.update_stack(op.stack_id, op.primary_id)
                    result.stacks[op.group_id] = op.stack_id
                case RemoveTag():
                    if op.value in tag_ids:
                        client.untag_assets(tag_ids[op.value], list(op.asset_ids))
                case AddTag():
                    client.tag_assets([tag_ids[op.value]], list(op.asset_ids))
                case SetRating():
                    client.update_assets(list(op.asset_ids), rating=op.rating)
                case PutMeta():
                    for start in range(0, len(op.items), META_BATCH):
                        client.put_metadata([(a, CULL_KEY, v) for a, v in op.items[start : start + META_BATCH]])
                case DeleteMeta():
                    for start in range(0, len(op.asset_ids), META_BATCH):
                        client.delete_metadata([(a, CULL_KEY) for a in op.asset_ids[start : start + META_BATCH]])
            result.done += 1
        except ImmichError as e:
            log.warning("%s failed: %s", describe(op), e)
            result.errors.append(f"{describe(op)}: {e.message}")
        if progress:
            progress(i + 1, len(ops))
    return result


def tag_assets_of(ops: list[Op]) -> set[str]:
    return {a for op in ops if isinstance(op, (AddTag, RemoveTag)) for a in op.asset_ids}


def settle_tags(
    client: ImmichClient,
    want: dict[str, set[str]],
    root: str,
    waits: tuple[float, ...] = TAG_CHECKS,
    sleep: Callable[[float], None] = time.sleep,
) -> list[str]:
    """Checks the culler tags of photos whose tags just changed, and sets them again where Immich lost
    the change. Immich 3.4 writes a photo's tags to its sidecar file in a background job and then
    reads the file back; when a photo's tags change twice in a row (one tag removed, another added),
    a late read-back sometimes drops the newer change. Returns notes for the photos still off."""
    pending = dict(want)
    for i, wait in enumerate(waits):
        sleep(wait)
        infos = client.assets(sorted(pending))
        remove: dict[str, list[str]] = defaultdict(list)
        add: dict[str, list[str]] = defaultdict(list)
        for a, tags in sorted(pending.items()):
            if a not in infos:  # deleted meanwhile
                continue
            have = culler_tags(Asset.from_api(infos[a]), root)
            for v in sorted(have - tags):
                remove[v].append(a)
            for v in sorted(tags - have):
                add[v].append(a)
        off = {a for ids in (*remove.values(), *add.values()) for a in ids}
        if not off:
            return []
        log.info("Immich lost the tag changes of %d photos, setting them again", len(off))
        ops: list[Op] = [RemoveTag(v, tuple(ids)) for v, ids in sorted(remove.items())]
        ops += [AddTag(v, tuple(ids)) for v, ids in sorted(add.items())]
        res = execute(client, ops)
        if res.errors:
            return [f"could not set the tags of {len(off)} photos again: {res.errors[0]}"]
        pending = {a: want[a] for a in off}
        if i == len(waits) - 1:
            return [f"Immich kept losing the tags of {len(off)} photos; set again, a new run checks them"]
    return []
