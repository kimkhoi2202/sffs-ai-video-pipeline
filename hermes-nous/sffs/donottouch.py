"""SFFS do-not-touch tools — the READ-ONLY half of the DRAFT-ONLY safety core.

These two tools port the current loop's "belt AND suspenders for pre-existing
live posts" (hermes/src/guardrails.ts ``snapshotDoNotTouch`` / ``verifyDoNotTouch``)
into the Nous framework as tools the agent calls around every cycle:

  * ``sffs_donottouch_snapshot`` — BEFORE a cycle, record the ids of every existing
    ``scheduled`` + ``published`` post.
  * ``sffs_donottouch_verify`` — AFTER a cycle, re-list and prove none of those
    pre-existing live/scheduled posts vanished or moved. Raises (a violation)
    only inside the Node layer; the tool surfaces it as a refusal result.

Both are strictly READ-ONLY: the Node bridge (hermes-nous/bridge/donottouch.ts)
imports ONLY ``snapshotDoNotTouch`` / ``verifyDoNotTouch``, which only ever
``listPosts`` (GET). No write/schedule/publish/delete/update path is imported or
reachable. They complement the write-side belt in draft_guard.py.

Running LIVE needs PUBLER_API_KEY + PUBLER_WORKSPACE_ID (now in $HERMES_HOME/.env).
``dry_run=True`` performs NO network call (snapshot returns a stub; verify only
validates the snapshot's shape), so the tools are testable without keys/network —
see hermes-nous/tests/test_donottouch.py.

Kept stdlib-only and free of intra-package imports so it can be imported directly
by the hermetic test suite (mirrors draft_guard.py).
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any, Dict, Optional


class DoNotTouchError(ValueError):
    """Raised for a malformed snapshot argument (converted to a refusal result)."""


def validate_snapshot(obj: Any) -> Dict[str, Any]:
    """Validate a do-not-touch snapshot object. Pure: no network, no subprocess.

    A snapshot must be a dict with ``scheduled_ids`` and ``published_ids`` that are
    lists of strings (as produced by ``sffs_donottouch_snapshot`` /
    guardrails.ts DoNotTouchSnapshot). ``captured_at`` is optional. Returns a
    normalized copy; raises :class:`DoNotTouchError` on any violation.
    """
    if not isinstance(obj, dict):
        raise DoNotTouchError("snapshot must be a JSON object with scheduled_ids + published_ids")
    out: Dict[str, Any] = {}
    for field in ("scheduled_ids", "published_ids"):
        val = obj.get(field)
        if not isinstance(val, list) or not all(isinstance(x, str) for x in val):
            raise DoNotTouchError(f"snapshot.{field} must be a list of strings")
        out[field] = list(val)
    captured_at = obj.get("captured_at")
    if isinstance(captured_at, str) and captured_at.strip():
        out["captured_at"] = captured_at
    return out


def _repo_dir() -> Path:
    """Absolute path to the pipeline repo root (symlink-safe via resolve()).

    Mirrors draft_guard._repo_dir: donottouch.py → sffs/ → hermes-nous/ → repo.
    ``HERMES_SFFS_REPO_DIR`` overrides.
    """
    override = os.environ.get("HERMES_SFFS_REPO_DIR")
    if override:
        return Path(override).resolve()
    return Path(__file__).resolve().parents[2]


def _bridge_entry() -> Path:
    return _repo_dir() / "hermes-nous" / "bridge" / "donottouch.ts"


def _parse_last_json(stdout: str) -> Optional[Dict[str, Any]]:
    """Return the last stdout line that decodes to a JSON object, else None.

    The Node bridge shares the pipeline's logger (hermes/src/log.ts), which writes
    human-readable INFO/WARN lines to STDOUT (for journald) BEFORE the
    machine-readable result. Those log lines start with a timestamp and never
    parse as JSON; the result JSON is emitted last. So we scan lines bottom-up and
    return the first that decodes to a dict.
    """
    for line in reversed([ln for ln in stdout.splitlines() if ln.strip()]):
        try:
            obj = json.loads(line)
        except Exception:
            continue
        if isinstance(obj, dict):
            return obj
    return None


def _bridge_env() -> Dict[str, str]:
    """Env for the Node bridge. Ensures the Node side can find the Publer keys.

    The Node config.ts loads ``HERMES_ENV_FILE`` (default /home/ec2-user/hermes.env,
    which does not exist here). When running under the isolated HERMES_HOME we point
    it at ``$HERMES_HOME/.env`` (gitignored, holds PUBLER_*) so a live read works
    without the keys having to be exported into the process first.
    """
    env = os.environ.copy()
    if not env.get("HERMES_ENV_FILE"):
        home = env.get("HERMES_HOME")
        if home:
            candidate = Path(home) / ".env"
            if candidate.exists():
                env["HERMES_ENV_FILE"] = str(candidate)
    return env


def run_node_bridge(
    subcommand: str,
    stdin_obj: Optional[Dict[str, Any]] = None,
    *,
    dry_run: bool,
    timeout: int = 120,
) -> Dict[str, Any]:
    """Shell out to the READ-ONLY Node bridge (``snapshot`` | ``verify``).

    ``dry_run=True`` runs the bridge in a network-free mode. Raises
    :class:`DoNotTouchError` on any failure so the handler can convert it to a
    result. Exit 4 from the bridge = a do-not-touch VIOLATION (verify).
    """
    node = shutil.which("node")
    if not node:
        raise DoNotTouchError("node runtime not found on PATH")
    entry = _bridge_entry()
    if not entry.exists():
        raise DoNotTouchError(f"bridge entry missing: {entry}")

    cmd = [node, str(entry), subcommand]
    if dry_run:
        cmd.append("--dry-run")
    try:
        proc = subprocess.run(
            cmd,
            input=json.dumps(stdin_obj) if stdin_obj is not None else "",
            capture_output=True,
            text=True,
            timeout=timeout,
            cwd=str(_repo_dir()),
            env=_bridge_env(),
        )
    except subprocess.TimeoutExpired:
        raise DoNotTouchError(f"bridge timed out after {timeout}s")

    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or "").strip()
        if proc.returncode == 4:
            # A real guardrail violation — surface the message, don't mask it.
            raise DoNotTouchError(f"DO-NOT-TOUCH VIOLATION: {detail[:800]}")
        prefix = "bridge REFUSED" if proc.returncode == 3 else f"bridge failed (exit {proc.returncode})"
        raise DoNotTouchError(f"{prefix}: {detail[:500]}")

    out = (proc.stdout or "").strip()
    parsed = _parse_last_json(out)
    if parsed is None:
        raise DoNotTouchError(f"bridge returned non-JSON: {out[:300]}")
    return parsed


def sffs_donottouch_snapshot(args: Dict[str, Any], **kwargs: Any) -> str:
    """Hermes tool handler: snapshot existing scheduled + published post ids.

    READ-ONLY. Call BEFORE a drafting cycle; pass the returned ``snapshot`` to
    ``sffs_donottouch_verify`` afterward. ``dry_run=True`` makes NO network call.
    Always returns a JSON string; never raises.
    """
    dry_run = bool(args.get("dry_run", False)) if isinstance(args, dict) else False
    if dry_run:
        return json.dumps(
            {
                "ok": True,
                "dry_run": True,
                "note": "snapshot requires a live Publer read; dry-run made no network call",
            }
        )
    try:
        result = run_node_bridge("snapshot", None, dry_run=False)
    except Exception as exc:
        return json.dumps({"ok": False, "error": str(exc)})
    if not isinstance(result, dict):
        return json.dumps({"ok": False, "error": "bridge returned a non-object result"})
    result.setdefault("ok", True)
    return json.dumps(result)


def sffs_donottouch_verify(args: Dict[str, Any], **kwargs: Any) -> str:
    """Hermes tool handler: verify no pre-existing scheduled/published post changed.

    READ-ONLY. Pass the ``snapshot`` returned by ``sffs_donottouch_snapshot``.
    Reports ``ok:false, violation:true`` if any pre-existing live/scheduled post
    vanished or moved. ``dry_run=True`` validates the snapshot shape only, no
    network. Always returns a JSON string; never raises.
    """
    if not isinstance(args, dict):
        return json.dumps({"ok": False, "error": "args must be a JSON object with a 'snapshot'"})

    # Validate the snapshot shape first (belt) — refuse malformed input up front.
    try:
        snapshot = validate_snapshot(args.get("snapshot"))
    except DoNotTouchError as exc:
        return json.dumps({"ok": False, "error": str(exc)})
    except Exception as exc:
        return json.dumps({"ok": False, "error": f"invalid snapshot: {exc}"})

    dry_run = bool(args.get("dry_run", False))
    if dry_run:
        return json.dumps(
            {
                "ok": True,
                "dry_run": True,
                "verified": None,
                "note": "dry-run validated the snapshot shape only; made no network call",
                "counts": {
                    "scheduled": len(snapshot["scheduled_ids"]),
                    "published": len(snapshot["published_ids"]),
                },
            }
        )

    try:
        result = run_node_bridge("verify", snapshot, dry_run=False)
    except DoNotTouchError as exc:
        msg = str(exc)
        violation = msg.startswith("DO-NOT-TOUCH VIOLATION")
        return json.dumps({"ok": False, "violation": violation, "error": msg})
    except Exception as exc:
        return json.dumps({"ok": False, "error": str(exc)})
    if not isinstance(result, dict):
        return json.dumps({"ok": False, "error": "bridge returned a non-object result"})
    result.setdefault("ok", True)
    result.setdefault("verified", True)
    return json.dumps(result)
