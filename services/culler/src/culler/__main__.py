"""Command line: `python -m culler <command>` (or `culler <command>` when installed).

serve                           HTTP API + upload watcher (what the container runs)
run --day 2024-05-01 [--apply]  cull one day (dry run unless --apply); also --album, --from/--to, --ids
undo <run id>                   undo an applied run
runs                            recent runs
calibrate --day 2024-05-01      similarity and time gap of neighbouring photos, to tune grouping
fetch-models                    download the model files into CULLER_MODELS_DIR
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys

# numpy/OpenBLAS reserve memory per thread at import time; the work is done on few threads anyway.
os.environ.setdefault("OPENBLAS_NUM_THREADS", "2")
os.environ.setdefault("OMP_NUM_THREADS", "2")


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="culler", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("-v", "--verbose", action="store_true")
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("serve")
    for name in ("run", "calibrate"):
        p = sub.add_parser(name)
        p.add_argument("--day")
        p.add_argument("--album")
        p.add_argument("--from", dest="start")
        p.add_argument("--to", dest="end")
        p.add_argument("--ids", help="comma-separated asset ids")
        if name == "run":
            p.add_argument("--apply", action="store_true", help="change Immich (default: dry run)")
            p.add_argument("--force", action="store_true", help="also regroup stacks you took apart")
            p.add_argument("--options", help='JSON threshold overrides, e.g. \'{"blur": {"min_ratio": 0.6}}\'')
            p.add_argument("--json", action="store_true", help="print the full report as JSON")
    u = sub.add_parser("undo")
    u.add_argument("run_id")
    sub.add_parser("runs")
    f = sub.add_parser("fetch-models")
    f.add_argument("--verify", action="store_true", help="re-check the hashes of files already there")
    return parser


def _scope(args: argparse.Namespace) -> dict:
    if args.day:
        return {"kind": "day", "date": args.day}
    if args.album:
        return {"kind": "album", "id": args.album}
    if args.start and args.end:
        return {"kind": "range", "from": args.start, "to": args.end}
    if args.ids:
        return {"kind": "assets", "ids": args.ids.split(",")}
    raise SystemExit("give --day, --album, --from/--to or --ids")


def main(argv: list[str] | None = None) -> None:
    args = _parser().parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s"
    )

    from culler.config import load_config

    cfg = load_config()
    if args.cmd == "fetch-models":
        from culler.model_files import fetch_models

        fetch_models(cfg.models_dir, verify_existing=args.verify)
        print(f"models ready in {cfg.models_dir}")
        return
    if not cfg.api_key:
        raise SystemExit("set IMMICH_API_KEY (or IMMICH_API_KEY_FILE)")

    from culler.service import Service

    service = Service(cfg)
    try:
        _run_command(args, service)
    finally:
        service.runner.close()  # MediaPipe fails noisily if left to close at interpreter exit


def _run_command(args: argparse.Namespace, service) -> None:
    cfg = service.cfg
    if args.cmd == "serve":
        import uvicorn

        from culler.api import create_app

        service.start(watch=True)
        logging.getLogger(__name__).info("culling the library of %s", service.owner_email)
        app = create_app(service)
        uvicorn.run(
            app, host="0.0.0.0", port=cfg.port, proxy_headers=True, forwarded_allow_ips="*", log_level="warning"
        )
        return

    if args.cmd == "runs":
        for r in service.store.runs(30):
            undone = " (undone)" if r["undoneAt"] else ""
            kind = "dry run" if r["dryRun"] else r["origin"]
            print(f"{r['id']}  {r['status']:<7} {kind:<8} {json.dumps(r['scope'])}{undone}")
        return

    if args.cmd == "undo":
        report = service.runner.undo(args.run_id)
        print(f"undone: {report['applied']} changes" + "".join(f"\n  note: {n}" for n in report["notes"]))
        for e in report["errors"]:
            print(f"  error: {e}")
        return

    from culler.runner import Scope, new_run_id

    scope = Scope.from_json(_scope(args))
    runner = service.runner

    if args.cmd == "calibrate":
        from culler.frames import build_frames
        from culler.grouping import neighbour_similarities

        live = runner.load(set(runner.collect(scope, cfg)), cfg.tags.root).live
        frames = build_frames(list(live.assets.values()), live.stacks, {}, set()).frames
        feats, _ = runner.measure(frames, live, cfg, None)
        emb = {fid: f.embedding for fid, f in feats.items() if f.embedding is not None}
        g = cfg.grouping
        print(f"grouping: same scene if similarity >= {g.link_similarity} and gap <= {g.max_gap_s:.0f} s\n")
        for a, b, seconds, sim in neighbour_similarities([f for f in frames if f.id in emb], emb):
            mark = "same" if sim >= g.link_similarity and seconds <= g.max_gap_s else "    "
            print(f"{mark}  {sim:5.3f}  {seconds:7.1f} s  {a.name} -> {b.name}")
        return

    from culler.report import format_report
    from culler.service import run_summary
    from culler.store import utcnow

    rid = new_run_id()
    options = json.loads(args.options) if args.options else None
    service.store.create_run(rid, "cli", scope.to_json(), options, not args.apply)

    def progress(phase: str, done: int, total: int) -> None:
        if total:
            print(f"\r{phase}: {done}/{total}   ", end="", file=sys.stderr, flush=True)

    try:
        report = runner.run(rid, scope, dry_run=not args.apply, options=options, force=args.force, progress=progress)
    except Exception as e:
        service.store.update_run(rid, status="failed", error=str(e))
        raise
    print(file=sys.stderr)
    service.store.update_run(rid, status="done", report=report, summary=run_summary(report), finished_at=utcnow())
    print(json.dumps(report, indent=2) if args.json else format_report(report))
    print(f"\nrun {rid}" + ("" if args.apply else " (dry run: add --apply to change Immich)"))


if __name__ == "__main__":
    main()
