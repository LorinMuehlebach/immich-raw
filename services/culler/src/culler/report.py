"""Plain-text summary of a run report, for the command line."""

from __future__ import annotations

from collections import Counter
from typing import Any

ICON = {"best": "★", "runner-up": "◐", "rejected": "✕", "bracket": "±"}


def describe_metrics(frame: dict[str, Any]) -> str:
    m = frame.get("metrics") or {}
    parts = []
    reason = frame.get("reason")
    if m.get("bracketEv") is not None:
        parts.append(f"bracket {m['bracketEv']:+.1f} EV")
    elif reason == "lighting" or (m.get("evVsBest") and abs(m["evVsBest"]) >= 0.3):
        parts.append(f"{m.get('evVsBest', 0):+.1f} EV vs best")
    if m.get("clipHiPct", 0) >= 1:
        parts.append(f"{m['clipHiPct']:.0f} % blown highlights")
    if m.get("sharpPct") is not None and (reason == "blur" or m["sharpPct"] < 90):
        parts.append(f"sharpness {m['sharpPct']} % of best")
    if m.get("faces"):
        open_ = f" ({m['eyesOpen']} % open, least {m['eyesLeast']} %)" if m.get("eyesOpen") is not None else ""
        parts.append(
            f"{m['closed']} of {m['faces']} faces with closed eyes{open_}"
            if m.get("closed")
            else f"{m['faces']} faces, eyes open{open_}"
        )
    if m.get("smileFaces"):
        parts.append(f"{m.get('smiling', 0)} of {m['smileFaces']} smiling")
    return ", ".join(parts)


def format_report(report: dict[str, Any]) -> str:
    c = report["counts"]
    rej = c["rejected"]
    lines = [
        f"{'Dry run' if report['dryRun'] else 'Applied'}: {report['scope']}",
        f"{c['groups']} stacks from {c['photos']} photos ({c['frames']} captures) · {c['runnerUps']} runner-ups · "
        f"rejected: {rej['lighting']} lighting, {rej['blur']} blur, {rej['eyes']} eyes",
    ]
    if c.get("brackets"):
        lines.append(f"{c['brackets']} of the stacks are exposure brackets (none rejected)")
    if c.get("pending"):
        lines.append(f"{c['pending']} photos are still waiting for Immich's preview and were skipped")
    if c.get("released"):
        lines.append(f"{c['released']} photos are no longer in a stack")
    for i, g in enumerate(report["groups"], start=1):
        frames = g["frames"]
        times = sorted(f["taken"] for f in frames)
        kind = " (exposure bracket)" if g.get("kind") == "bracket" else ""
        lines.append(f"\nStack {i}: {len(frames)} photos, {times[0][11:19]}-{times[-1][11:19]}{kind}")
        for f in frames:
            role = f["role"] if f["role"] != "rejected" else f"rejected ({f['reason']})"
            pin = " (your pick)" if f.get("pinned") else ""
            extra = describe_metrics(f)
            lines.append(f"  {ICON[f['role']]} {f['name']:<28} {role}{pin}{'  ' + extra if extra else ''}")
    ops = Counter(op["op"] for op in report.get("changes", []))
    if ops:
        lines.append("\nChanges: " + ", ".join(f"{n} {k}" for k, n in sorted(ops.items())))
    else:
        lines.append("\nNo changes needed.")
    for e in report.get("errors", []):
        lines.append(f"error: {e}")
    return "\n".join(lines)
