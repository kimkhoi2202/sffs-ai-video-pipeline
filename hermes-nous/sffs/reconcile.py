"""SFFS RECONCILE tool — close the A/B LEARNING LOOP for the agent's OWN posts.

One tool, ``sffs_reconcile``, wrapping hermes/src/reconcile.ts ``reconcile``: for
each ``ab-testing/ab-database.json`` record it matches the ``metricool_uuid``
(Metricool's stable planner id, recorded when the loop created the DRAFT) to the native
published post and back-fills ``platform_post_id`` (the network-native TikTok
video id / Instagram media id), ``permalink``, and ``posted_at``. Those native
ids are what ``sffs_score`` / ``sffs_score_rollup`` join matured analytics on — so
without this back-fill the agent could never attach metrics to (i.e. LEARN from)
its own posts once a human publishes them.

IDEMPOTENT + DRAFT-SAFE: a field is filled only when currently empty, and the only
write is the local ab-database.json. reconcile.ts imports ONLY read primitives
from the Metricool facade (listPosts / pullInsights) — it
has NO create / schedule / publish / delete / update path in its dependency tree,
so the Node bridge (hermes-nous/bridge/reconcile.ts) is physically unable to post,
publish, schedule, or mutate any Publer post.

Running LIVE needs PUBLER_API_KEY + PUBLER_WORKSPACE_ID (in $HERMES_HOME/.env).
``dry_run=True`` (the default) makes NO network call and writes NO files, so the
tool is testable without keys, network, node, or the Hermes framework (the handler
short-circuits before the bridge — see tests/test_reconcile.py).

Kept stdlib-only and free of intra-package imports so the pure arg-guards can be
imported directly by the hermetic test suite (mirrors score_rollup.py / reads.py).
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any, Dict, Optional


class ReconcileGuardError(ValueError):
    """Raised for a malformed reconcile argument (converted to an error result)."""


# ---------------------------------------------------------------------------
# Pure arg-guards (no network, no subprocess) — the hermetically testable core
# ---------------------------------------------------------------------------
def build_reconcile_request(args: Dict[str, Any]) -> Dict[str, Any]:
    """Validate + normalize an ``sffs_reconcile`` request. Pure.

    The only inputs are ``dry_run`` (default True) and an optional ``data_dir``
    override. Returns ``{"dry_run": bool, "data_dir": str|None}``. Raises
    :class:`ReconcileGuardError` on any bad input.
    """
    if not isinstance(args, dict):
        raise ReconcileGuardError("args must be a JSON object")

    dry_run = args.get("dry_run", True)
    if not isinstance(dry_run, bool):
        raise ReconcileGuardError("dry_run must be a boolean")

    data_dir = args.get("data_dir")
    if data_dir is not None and (not isinstance(data_dir, str) or not data_dir.strip()):
        raise ReconcileGuardError("data_dir must be a non-empty string path")

    return {"dry_run": dry_run, "data_dir": data_dir.strip() if isinstance(data_dir, str) else None}


# ---------------------------------------------------------------------------
# Node bridge plumbing (mirrors score_rollup.py — entry bridge/reconcile.ts)
# ---------------------------------------------------------------------------
def _repo_dir() -> Path:
    override = os.environ.get("HERMES_SFFS_REPO_DIR")
    if override:
        return Path(override).resolve()
    return Path(__file__).resolve().parents[2]


def _bridge_entry() -> Path:
    return _repo_dir() / "hermes-nous" / "bridge" / "reconcile.ts"


def _parse_last_json(stdout: str) -> Optional[Dict[str, Any]]:
    """Return the last stdout line that decodes to a JSON object, else None.

    reconcile.ts shares hermes/src/log.ts (INFO/WARN to STDOUT for journald) before
    the machine-readable result; those log lines never parse as JSON, and the
    result is emitted last — so scan bottom-up. (Mirrors score_rollup.py; see
    failures.md F6.)
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
      (ab-database.json lives under CONFIG.REPO_DIR, not DATA_DIR.)
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
    """Shell out to the RECONCILE Node bridge. Raises :class:`ReconcileGuardError`
    on any failure so the handler can convert it to a result. ``dry_run=True`` runs
    the bridge network-free and write-free."""
    node = shutil.which("node")
    if not node:
        raise ReconcileGuardError("node runtime not found on PATH")
    entry = _bridge_entry()
    if not entry.exists():
        raise ReconcileGuardError(f"bridge entry missing: {entry}")

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
        raise ReconcileGuardError(f"bridge timed out after {timeout}s")

    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or "").strip()
        prefix = "bridge bad-usage" if proc.returncode == 3 else f"bridge failed (exit {proc.returncode})"
        raise ReconcileGuardError(f"{prefix}: {detail[-500:]}")

    parsed = _parse_last_json((proc.stdout or "").strip())
    if parsed is None:
        raise ReconcileGuardError(f"bridge returned non-JSON: {(proc.stdout or '').strip()[:300]}")
    return parsed


# ---------------------------------------------------------------------------
# Tool handler (Hermes contract: return a JSON string; NEVER raise)
# ---------------------------------------------------------------------------
def sffs_reconcile(args: Dict[str, Any], **kwargs: Any) -> str:
    """Hermes tool handler: back-fill native post ids/permalinks onto ab-database.

    Matches each ab-database record's ``metricool_uuid`` to the native published
    post (via Publer analytics + published-post GETs) and back-fills
    ``platform_post_id`` / ``permalink`` / ``posted_at`` — the join keys scoring
    needs to learn from the agent's OWN posts. IDEMPOTENT + DRAFT-SAFE (read +
    local write only). ``dry_run=True`` (the default) makes NO network call and
    writes NO files. Always returns a JSON string; never raises.
    """
    a = args if isinstance(args, dict) else {}
    try:
        req = build_reconcile_request(a)
    except ReconcileGuardError as exc:
        return json.dumps({"ok": False, "error": str(exc)})
    except Exception as exc:
        return json.dumps({"ok": False, "error": f"invalid args: {exc}"})

    if req["dry_run"]:
        return json.dumps(
            {
                "ok": True,
                "dry_run": True,
                "note": (
                    "dry-run made no network call and wrote no files; a live run would "
                    "back-fill platform_post_id/permalink/posted_at onto ab-database.json "
                    "by matching metricool_uuid -> the native published post"
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
