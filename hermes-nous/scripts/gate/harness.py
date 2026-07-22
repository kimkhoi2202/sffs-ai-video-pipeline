#!/usr/bin/env python3
"""harness — the FIRST key of the SFFS software-factory auto-merge gate.

Runs the full end-to-end test battery for the `hermes-nous` rebuild and returns
a single machine-readable **GREEN / RED** verdict. Three legs:

  1. **pytest suite** — the hermetic Python tests for the plugin. Auto-DISCOVERS
     every ``hermes-nous/tests/test_*.py`` (top-level), so as more tools land on
     the main line their ``test_*.py`` is picked up automatically with no change
     here. (The gate's own tests under ``tests/e2e/`` are deliberately excluded
     from this leg — they *test the harness*, so running them here would be
     circular; they run under the normal ``pytest hermes-nous/tests`` collection.)
  2. **Node bridge dry-run matrix** — actually executes the three Node bridges
     (``publer-draft`` / ``donottouch`` / ``publer-read``) in ``--dry-run`` mode
     across a matrix that proves they run network-free AND that the Node layer
     REFUSES publishing/scheduling (draft-only) and exposes no publish/schedule/
     delete subcommand.
  3. **sffs_selfcheck** — loads the plugin, lists its tools, and drives the
     ``pre_tool_call`` publish guard against the known BLOCK/ALLOW matrix
     (:mod:`sffs_selfcheck`).

GREEN iff all three legs pass. Fail-closed: a missing ``node``/``pytest``, a
crash, or a timeout makes the affected leg (and the verdict) RED.

CLI: ``python harness.py [--json] [--repo PATH]``  →  exit 0 GREEN / 1 RED.
Importable: :func:`run_harness` returns the result dict (used by
:mod:`auto_merge` as key #1 and by the gate's own tests).
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

GATE_DIR = Path(__file__).resolve().parent
HERMES_NOUS_DIR = GATE_DIR.parent.parent          # .../hermes-nous
REPO_DIR = HERMES_NOUS_DIR.parent                 # .../sffs-ai-video-pipeline
TESTS_DIR = HERMES_NOUS_DIR / "tests"
BRIDGE_DIR = HERMES_NOUS_DIR / "bridge"

# Import the shared plugin/guard self-check as a sibling module (works whether
# this file is run as a script or imported as part of the `gate` package).
sys.path.insert(0, str(GATE_DIR))
import sffs_selfcheck  # noqa: E402

_PYTEST_TIMEOUT = 300
_NODE_CASE_TIMEOUT = 60


# ---------------------------------------------------------------------------
# Leg 1 — pytest
# ---------------------------------------------------------------------------
def discover_tool_tests(tests_dir: Path = TESTS_DIR) -> List[Path]:
    """Every top-level ``test_*.py`` under ``hermes-nous/tests`` (sorted).

    Top-level only: the gate's own ``tests/e2e/`` suite is intentionally NOT a
    part of the harness's own gating run (it tests the harness).
    """
    return sorted(p for p in tests_dir.glob("test_*.py") if p.is_file())


def run_pytest(tests_dir: Path = TESTS_DIR, *, repo_dir: Path = REPO_DIR) -> Dict[str, Any]:
    paths = discover_tool_tests(tests_dir)
    step: Dict[str, Any] = {"name": "pytest", "ok": False, "discovered": [p.name for p in paths]}
    if not paths:
        step["error"] = f"no test_*.py discovered under {tests_dir}"
        return step
    try:
        import pytest  # noqa: F401
    except Exception as exc:  # noqa: BLE001 — fail-closed
        step["error"] = f"pytest not importable in this interpreter: {exc!r}"
        return step

    cmd = [sys.executable, "-m", "pytest", *[str(p) for p in paths], "-q", "--no-header"]
    t0 = time.time()
    try:
        proc = subprocess.run(
            cmd, cwd=str(repo_dir), capture_output=True, text=True, timeout=_PYTEST_TIMEOUT
        )
    except subprocess.TimeoutExpired:
        step["error"] = f"pytest timed out after {_PYTEST_TIMEOUT}s"
        return step
    step["seconds"] = round(time.time() - t0, 3)
    step["returncode"] = proc.returncode
    out = (proc.stdout or "") + (proc.stderr or "")
    # Keep the last few lines (the summary) for a compact report.
    step["summary"] = "\n".join([ln for ln in out.splitlines() if ln.strip()][-8:])
    step["ok"] = proc.returncode == 0
    if not step["ok"]:
        step["error"] = "pytest reported failures (see summary)"
    return step


# ---------------------------------------------------------------------------
# Leg 2 — Node bridge dry-run matrix
# ---------------------------------------------------------------------------
# Each case: label, bridge filename, argv (after the file), stdin str|None,
# expected exit code, and an optional predicate on the parsed JSON stdout.
# Exit codes (from the bridge headers): 0 ok · 2 bad json · 3 guard-refusal/
# bad-usage · 4 do-not-touch violation.
def _node_matrix() -> Tuple[Dict[str, Any], ...]:
    return (
        # publer-draft: valid draft dry-run -> ok, state=draft, no network
        {
            "label": "draft valid (dry-run)", "bridge": "publer-draft.ts", "argv": ["--dry-run"],
            "stdin": json.dumps({"account_ids": ["a"], "text": "hi"}), "exit": 0,
            "want": lambda o: o.get("ok") is True and o.get("state") == "draft" and o.get("dry_run") is True,
        },
        # publer-draft: scheduling -> REFUSED at the Node layer (exit 3)
        {
            "label": "draft scheduled_at REFUSED", "bridge": "publer-draft.ts", "argv": ["--dry-run"],
            "stdin": json.dumps({"account_ids": ["a"], "text": "hi", "scheduled_at": "2026-08-01T00:00:00Z"}),
            "exit": 3, "want": None,
        },
        # publer-draft: non-draft state -> REFUSED at the Node layer (exit 3)
        {
            "label": "draft state=published REFUSED", "bridge": "publer-draft.ts", "argv": ["--dry-run"],
            "stdin": json.dumps({"account_ids": ["a"], "text": "hi", "state": "published"}), "exit": 3, "want": None,
        },
        # publer-draft: defense-in-depth — even a stray publish flag is FORCED to a
        # draft by the Node layer (state=="draft", no publish/scheduled_at leaks
        # into the payload). The Python belt + framework hook refuse it earlier;
        # this proves the Node layer can still never emit a non-draft.
        {
            "label": "draft forces state=draft despite stray publish flag", "bridge": "publer-draft.ts",
            "argv": ["--dry-run"], "stdin": json.dumps({"account_ids": ["a"], "text": "hi", "publish": True}),
            "exit": 0,
            "want": lambda o: (
                o.get("ok") is True
                and o.get("state") == "draft"
                and isinstance(o.get("payload"), dict)
                and o["payload"].get("state") == "draft"
                and "publish" not in o["payload"]
                and "scheduled_at" not in o["payload"]
            ),
        },
        # donottouch: snapshot dry-run -> ok, no network
        {
            "label": "donottouch snapshot (dry-run)", "bridge": "donottouch.ts", "argv": ["snapshot", "--dry-run"],
            "stdin": None, "exit": 0, "want": lambda o: o.get("ok") is True and o.get("dry_run") is True,
        },
        # donottouch: verify dry-run with a valid snapshot shape -> ok
        {
            "label": "donottouch verify (dry-run)", "bridge": "donottouch.ts", "argv": ["verify", "--dry-run"],
            "stdin": json.dumps({"scheduled_ids": ["a"], "published_ids": ["b"]}), "exit": 0,
            "want": lambda o: o.get("ok") is True,
        },
        # donottouch: bad snapshot shape -> bad usage (exit 3)
        {
            "label": "donottouch verify bad shape", "bridge": "donottouch.ts", "argv": ["verify", "--dry-run"],
            "stdin": json.dumps({"nope": 1}), "exit": 3, "want": None,
        },
        # donottouch: there is NO publish subcommand (proves read-only surface)
        {
            "label": "donottouch has no publish subcommand", "bridge": "donottouch.ts", "argv": ["publish", "--dry-run"],
            "stdin": None, "exit": 3, "want": None,
        },
        # publer-read: accounts dry-run -> ok, no network
        {
            "label": "read accounts (dry-run)", "bridge": "publer-read.ts", "argv": ["accounts", "--dry-run"],
            "stdin": None, "exit": 0, "want": lambda o: o.get("ok") is True and o.get("dry_run") is True,
        },
        # publer-read: posts dry-run echoes the validated request
        {
            "label": "read posts (dry-run)", "bridge": "publer-read.ts", "argv": ["posts", "--dry-run"],
            "stdin": json.dumps({"state": "published"}), "exit": 0,
            "want": lambda o: o.get("ok") is True and o.get("dry_run") is True,
        },
        # publer-read: insights dry-run with from/to
        {
            "label": "read insights (dry-run)", "bridge": "publer-read.ts", "argv": ["insights", "--dry-run"],
            "stdin": json.dumps({"from": "2026-06-01", "to": "2026-07-01"}), "exit": 0,
            "want": lambda o: o.get("ok") is True and o.get("dry_run") is True,
        },
        # publer-read: no write/publish subcommand (proves read-only surface)
        {
            "label": "read has no publish subcommand", "bridge": "publer-read.ts", "argv": ["publish", "--dry-run"],
            "stdin": None, "exit": 3, "want": None,
        },
    )


def _parse_last_json(text: str) -> Optional[Dict[str, Any]]:
    for line in reversed([ln for ln in (text or "").splitlines() if ln.strip()]):
        try:
            obj = json.loads(line)
        except Exception:
            continue
        if isinstance(obj, dict):
            return obj
    return None


def run_node_bridges(bridge_dir: Path = BRIDGE_DIR) -> Dict[str, Any]:
    step: Dict[str, Any] = {"name": "node_bridges", "ok": False, "cases": []}
    node = shutil.which("node")
    if not node:
        step["error"] = "node runtime not found on PATH (cannot verify the Node bridges — failing closed)"
        return step
    step["node"] = node
    all_ok = True
    t0 = time.time()
    for case in _node_matrix():
        entry = bridge_dir / case["bridge"]
        rec: Dict[str, Any] = {"label": case["label"], "bridge": case["bridge"]}
        if not entry.exists():
            rec.update(ok=False, error=f"bridge missing: {entry}")
            step["cases"].append(rec)
            all_ok = False
            continue
        cmd = [node, str(entry), *case["argv"]]
        try:
            proc = subprocess.run(
                cmd, input=case["stdin"] or "", cwd=str(HERMES_NOUS_DIR),
                capture_output=True, text=True, timeout=_NODE_CASE_TIMEOUT,
            )
        except subprocess.TimeoutExpired:
            rec.update(ok=False, error=f"timed out after {_NODE_CASE_TIMEOUT}s")
            step["cases"].append(rec)
            all_ok = False
            continue
        rec["exit"] = proc.returncode
        exit_ok = proc.returncode == case["exit"]
        want = case["want"]
        want_ok = True
        if want is not None:
            parsed = _parse_last_json(proc.stdout)
            rec["stdout_ok"] = parsed is not None
            try:
                want_ok = bool(parsed is not None and want(parsed))
            except Exception:
                want_ok = False
        rec["ok"] = bool(exit_ok and want_ok)
        if not rec["ok"]:
            rec["error"] = (
                f"expected exit {case['exit']} got {proc.returncode}"
                + ("" if want_ok else "; stdout predicate failed")
            )
            rec["stderr"] = (proc.stderr or "").strip()[:300]
            all_ok = False
        step["cases"].append(rec)
    step["seconds"] = round(time.time() - t0, 3)
    step["counts"] = {"total": len(step["cases"]), "passed": sum(1 for c in step["cases"] if c.get("ok"))}
    step["ok"] = all_ok
    if not all_ok:
        step["error"] = "one or more Node bridge dry-run cases failed"
    return step


# ---------------------------------------------------------------------------
# Leg 3 — plugin + guard self-check (in-process)
# ---------------------------------------------------------------------------
def run_selfcheck_step(plugin_parent: Path = HERMES_NOUS_DIR) -> Dict[str, Any]:
    step: Dict[str, Any] = {"name": "selfcheck", "ok": False}
    try:
        res = sffs_selfcheck.run_selfcheck(plugin_parent)
    except Exception as exc:  # noqa: BLE001 — fail-closed
        step["error"] = f"selfcheck crashed: {exc!r}"
        return step
    step["ok"] = res.get("verdict") == "GREEN"
    step["result"] = res
    if not step["ok"]:
        step["error"] = "; ".join(res.get("failures", [])) or "selfcheck RED"
    return step


# ---------------------------------------------------------------------------
# Aggregate
# ---------------------------------------------------------------------------
def run_harness(repo_dir: Path = REPO_DIR) -> Dict[str, Any]:
    """Run all three legs and return the aggregated GREEN/RED result dict."""
    hermes_nous = repo_dir / "hermes-nous"
    tests_dir = hermes_nous / "tests"
    bridge_dir = hermes_nous / "bridge"
    t0 = time.time()
    steps = [
        run_pytest(tests_dir, repo_dir=repo_dir),
        run_node_bridges(bridge_dir),
        run_selfcheck_step(hermes_nous),
    ]
    ok = all(s.get("ok") for s in steps)
    return {
        "verdict": "GREEN" if ok else "RED",
        "ok": ok,
        "seconds": round(time.time() - t0, 3),
        "repo": str(repo_dir),
        "steps": {s["name"]: s for s in steps},
    }


def _format_human(result: Dict[str, Any]) -> str:
    lines = [f"harness: {result['verdict']}  ({result['seconds']}s)"]
    for name, step in result.get("steps", {}).items():
        mark = "ok" if step.get("ok") else "XX"
        extra = ""
        if name == "pytest" and step.get("discovered") is not None:
            extra = f" ({len(step['discovered'])} test files)"
        if name == "node_bridges" and step.get("counts"):
            extra = f" ({step['counts']['passed']}/{step['counts']['total']} cases)"
        if name == "selfcheck" and step.get("result", {}).get("matrix_counts"):
            mc = step["result"]["matrix_counts"]
            extra = f" ({mc['block_passed']}/{mc['block_total']} block, {mc['allow_passed']}/{mc['allow_total']} allow)"
        lines.append(f"  [{mark}] {name}{extra}")
        if not step.get("ok") and step.get("error"):
            lines.append(f"        -> {step['error']}")
    return "\n".join(lines)


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="SFFS auto-merge harness (key #1): GREEN/RED verdict")
    parser.add_argument("--json", action="store_true", help="print the machine-readable result")
    parser.add_argument("--repo", default=str(REPO_DIR), help="pipeline repo root (defaults to this worktree)")
    args = parser.parse_args(argv)

    result = run_harness(Path(args.repo))
    if args.json:
        print(json.dumps(result, indent=2, default=str))
    else:
        print(_format_human(result))
    return 0 if result["verdict"] == "GREEN" else 1


if __name__ == "__main__":
    raise SystemExit(main())
