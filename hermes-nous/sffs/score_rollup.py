"""SFFS SCORE-ROLLUP tool — the WRITE-side of scoring (deliberately separate from
the read-only ``sffs_score``).

One tool, ``sffs_score_rollup``, wrapping hermes/src/score.ts ``pullAndScore``: it
pulls matured Publer analytics (~24h lag) over the last 30 days, joins them onto
``ab-testing/ab-database.json`` by ``platform_post_id`` to refresh per-post
metrics, and recomputes the decision rollups (medians + front-runners) in
``ab-testing/learnings.json``. Those two JSON files are the loop's durable,
cross-run A/B MEMORY — this tool is how each cycle folds the newest performance
data back into what the designer biases toward next.

Why this is a SEPARATE tool from ``sffs_score`` (reads.py):
  * ``sffs_score`` is READ-ONLY — it returns per-post insights and mutates nothing
    (its bridge imports only getPostInsights / flattenPostInsights).
  * ``sffs_score_rollup`` is the WRITE-side — it refreshes ab-database.json +
    learnings.json. Keeping the ledger/DB write OUT of the read tool mirrors the
    same minimize-the-write-surface discipline used for sffs_questions (select vs
    markUsed): see .ralph/guardrails.md.

score.ts has NO create / schedule / publish / delete / update path in its
dependency tree, so the Node bridge (hermes-nous/bridge/score-rollup.ts) is
physically unable to post, publish, schedule, or mutate any Publer post. It only
issues analytics GETs and writes two LOCAL JSON files.

Running LIVE needs PUBLER_API_KEY + PUBLER_WORKSPACE_ID (in $HERMES_HOME/.env).
``dry_run=True`` makes NO network call and writes NO files, so the tool is testable
without keys, network, node, or the Hermes framework (the handler short-circuits
before the bridge — see tests/test_score_rollup.py).

Kept stdlib-only and free of intra-package imports so the pure arg-guards can be
imported directly by the hermetic test suite (mirrors reads.py / render.py).
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, Optional


class ScoreRollupGuardError(ValueError):
    """Raised for a malformed score-rollup argument (converted to an error result)."""


# ---------------------------------------------------------------------------
# Pure arg-guards (no network, no subprocess) — the hermetically testable core
# ---------------------------------------------------------------------------
def build_rollup_request(args: Dict[str, Any]) -> Dict[str, Any]:
    """Validate + normalize an ``sffs_score_rollup`` request. Pure.

    The rollup window is fixed to the last 30 days (matches score.ts), so the only
    inputs are ``dry_run`` and an optional ``data_dir`` override (where CONFIG data
    paths resolve). Returns ``{"dry_run": bool, "data_dir": str|None}``. Raises
    :class:`ScoreRollupGuardError` on any bad input.
    """
    if not isinstance(args, dict):
        raise ScoreRollupGuardError("args must be a JSON object")

    dry_run = args.get("dry_run", True)
    if not isinstance(dry_run, bool):
        raise ScoreRollupGuardError("dry_run must be a boolean")

    data_dir = args.get("data_dir")
    if data_dir is not None and (not isinstance(data_dir, str) or not data_dir.strip()):
        raise ScoreRollupGuardError("data_dir must be a non-empty string path")

    return {"dry_run": dry_run, "data_dir": data_dir.strip() if isinstance(data_dir, str) else None}


def default_window(days: int = 30) -> tuple[str, str]:
    """(from, to) YYYY-MM-DD for the last ``days`` days, UTC. Matches score.ts."""
    to = datetime.now(timezone.utc).date()
    frm = to - timedelta(days=days)
    return frm.isoformat(), to.isoformat()


# ---------------------------------------------------------------------------
# Node bridge plumbing (mirrors reads.py / render.py — entry bridge/score-rollup.ts)
# ---------------------------------------------------------------------------
def _repo_dir() -> Path:
    override = os.environ.get("HERMES_SFFS_REPO_DIR")
    if override:
        return Path(override).resolve()
    return Path(__file__).resolve().parents[2]


def _bridge_entry() -> Path:
    return _repo_dir() / "hermes-nous" / "bridge" / "score-rollup.ts"


def _parse_last_json(stdout: str) -> Optional[Dict[str, Any]]:
    """Return the last stdout line that decodes to a JSON object, else None.

    score.ts shares hermes/src/log.ts (INFO/WARN to STDOUT for journald) before the
    machine-readable result. Log lines start with a timestamp and never parse as
    JSON; the result is emitted last. So scan bottom-up. (See failures.md F6.)
    """
    for line in reversed([ln for ln in stdout.splitlines() if ln.strip()]):
        try:
            obj = json.loads(line)
        except Exception:
            continue
        if isinstance(obj, dict):
            return obj
    return None


def _bridge_env(data_dir: Optional[str]) -> Dict[str, str]:
    """Env for the Node bridge.

    * HERMES_ENV_FILE -> $HERMES_HOME/.env so config.ts loads PUBLER_* (gitignored).
    * HERMES_DATA_DIR -> the ``data_dir`` arg wins, else keep an existing env value.
      (ab-database.json / learnings.json live under CONFIG.REPO_DIR, not DATA_DIR,
      so this mainly affects where auxiliary data would land.)
    """
    env = os.environ.copy()
    if not env.get("HERMES_ENV_FILE"):
        home = env.get("HERMES_HOME")
        if home:
            candidate = Path(home) / ".env"
            if candidate.exists():
                env["HERMES_ENV_FILE"] = str(candidate)
    if data_dir:
        env["HERMES_DATA_DIR"] = data_dir
    return env


def run_node_bridge(*, dry_run: bool, data_dir: Optional[str] = None, timeout: int = 240) -> Dict[str, Any]:
    """Shell out to the SCORE-ROLLUP Node bridge. Raises :class:`ScoreRollupGuardError`
    on any failure so the handler can convert it to a result. ``dry_run=True`` runs
    the bridge network-free and write-free."""
    node = shutil.which("node")
    if not node:
        raise ScoreRollupGuardError("node runtime not found on PATH")
    entry = _bridge_entry()
    if not entry.exists():
        raise ScoreRollupGuardError(f"bridge entry missing: {entry}")

    cmd = [node, str(entry), "run"]
    if dry_run:
        cmd.append("--dry-run")
    try:
        proc = subprocess.run(
            cmd,
            input="",
            capture_output=True,
            text=True,
            timeout=timeout,
            cwd=str(_repo_dir()),
            env=_bridge_env(data_dir),
        )
    except subprocess.TimeoutExpired:
        raise ScoreRollupGuardError(f"bridge timed out after {timeout}s")

    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or "").strip()
        prefix = "bridge bad-usage" if proc.returncode == 3 else f"bridge failed (exit {proc.returncode})"
        raise ScoreRollupGuardError(f"{prefix}: {detail[-500:]}")

    parsed = _parse_last_json((proc.stdout or "").strip())
    if parsed is None:
        raise ScoreRollupGuardError(f"bridge returned non-JSON: {(proc.stdout or '').strip()[:300]}")
    return parsed


# ---------------------------------------------------------------------------
# Tool handler (Hermes contract: return a JSON string; NEVER raise)
# ---------------------------------------------------------------------------
def sffs_score_rollup(args: Dict[str, Any], **kwargs: Any) -> str:
    """Hermes tool handler: refresh A/B metrics + recompute learnings rollups.

    Pulls matured Publer analytics over the last 30 days, joins onto
    ab-database.json, and recomputes learnings.json (the durable cross-run A/B
    memory). ``dry_run=True`` (the default) makes NO network call and writes NO
    files — it just previews the window. Always returns a JSON string; never
    raises.
    """
    a = args if isinstance(args, dict) else {}
    try:
        req = build_rollup_request(a)
    except ScoreRollupGuardError as exc:
        return json.dumps({"ok": False, "error": str(exc)})
    except Exception as exc:
        return json.dumps({"ok": False, "error": f"invalid args: {exc}"})

    if req["dry_run"]:
        d_from, d_to = default_window()
        return json.dumps(
            {
                "ok": True,
                "dry_run": True,
                "from": d_from,
                "to": d_to,
                "note": (
                    "dry-run made no network call and wrote no files; a live run "
                    "would refresh ab-database.json metrics + recompute learnings.json"
                ),
            }
        )

    try:
        result = run_node_bridge(dry_run=False, data_dir=req["data_dir"])
    except Exception as exc:
        return json.dumps({"ok": False, "error": str(exc)})
    if not isinstance(result, dict):
        return json.dumps({"ok": False, "error": "bridge returned a non-object result"})
    result.setdefault("ok", True)
    return json.dumps(result)
