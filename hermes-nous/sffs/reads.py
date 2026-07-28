"""SFFS READ-ONLY data tool — the cycle's analytics input.

``sffs_score`` is the analytics reader: it pulls per-post metrics (reach, views,
likes, comments, shares, engagement, engagement_rate and — Instagram only — the
3-second skip rate) over a date window, via the Node bridge
``hermes-nous/bridge/metricool-read.ts``. This is the scoring input the A/B loop
reasons about performance with.

It is strictly READ-ONLY: the bridge imports ONLY GET primitives, so no
create / schedule / publish / delete / update path is reachable from here. It
complements the do-not-touch reads (donottouch.py) and the framework-layer
publish guard (publish_guard.py).

WHAT USED TO BE HERE. A second tool, ``sffs_publer_read``, listed connected
accounts and posts straight off Publer. Publer answers HTTP 403 on every content
endpoint now ("Please upgrade to Business to access our API"), so that tool could
only ever fail; it and its bridge were removed with the rest of the Publer path.
The live calendar is read through the Metricool bridge's ``scheduled``
subcommand, which the dashboard already owns — there is no reason for a second
listing tool here.

Running LIVE needs METRICOOL_USER_TOKEN + METRICOOL_USER_ID + METRICOOL_BLOG_ID
(in $HERMES_HOME/.env or /etc/hermes/hermes.env). ``dry_run=True`` makes NO
network call, so the tool is testable without keys or network (the handler
short-circuits before the bridge — see the tests).

Kept stdlib-only and free of intra-package imports so the pure arg-guards can be
imported directly by the hermetic test suite (mirrors donottouch.py).
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, Optional, Tuple


class ReadGuardError(ValueError):
    """Raised for a malformed score argument (converted to an error result)."""


_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


# ---------------------------------------------------------------------------
# Pure arg-guards (no network, no subprocess) — the hermetically testable core
# ---------------------------------------------------------------------------
def _string_list(value: Any, label: str) -> list:
    if not isinstance(value, list) or not all(isinstance(a, str) and a.strip() for a in value):
        raise ReadGuardError(f"{label} must be a list of non-empty strings")
    return list(value)


def build_score_request(args: Dict[str, Any]) -> Dict[str, Any]:
    """Validate + normalize a ``sffs_score`` request. Pure.

    Returns the params dict for the bridge's ``analytics`` subcommand. ``from`` /
    ``to`` are validated (YYYY-MM-DD) when present; the handler fills a default
    window when they are absent. Raises :class:`ReadGuardError` on any bad input.

    Metricool returns the whole brand's rows in one call, so there is no paging and
    no sort parameter to pass through — the Publer-era ``sort_by`` / ``sort_type`` /
    ``max_pages`` arguments were dropped rather than silently ignored, which would
    have let a caller believe it had asked for something it had not.
    """
    if not isinstance(args, dict):
        raise ReadGuardError("args must be a JSON object")

    params: Dict[str, Any] = {}

    for label in ("from", "to"):
        val = args.get(label)
        if val is not None:
            if not isinstance(val, str) or not _DATE_RE.match(val.strip()):
                raise ReadGuardError(f"{label} must be a YYYY-MM-DD date string")
            params[label] = val.strip()

    if args.get("account_ids") is not None:
        params["account_ids"] = _string_list(args.get("account_ids"), "account_ids")

    return params


def default_window(days: int = 30) -> Tuple[str, str]:
    """(from, to) YYYY-MM-DD for the last ``days`` days, UTC. Matches score.ts."""
    to = datetime.now(timezone.utc).date()
    frm = to - timedelta(days=days)
    return frm.isoformat(), to.isoformat()


# ---------------------------------------------------------------------------
# Node bridge plumbing (mirrors donottouch.py — read-only entry metricool-read.ts)
# ---------------------------------------------------------------------------
def _repo_dir() -> Path:
    """Absolute path to the pipeline repo root (symlink-safe via resolve()).

    reads.py → sffs/ → hermes-nous/ → repo. ``HERMES_SFFS_REPO_DIR`` overrides.
    """
    override = os.environ.get("HERMES_SFFS_REPO_DIR")
    if override:
        return Path(override).resolve()
    return Path(__file__).resolve().parents[2]


def _bridge_entry() -> Path:
    return _repo_dir() / "hermes-nous" / "bridge" / "metricool-read.ts"


def _parse_last_json(stdout: str) -> Optional[Dict[str, Any]]:
    """Return the last stdout line that decodes to a JSON object, else None.

    The Node bridge shares hermes/src/log.ts (which writes INFO/WARN to STDOUT for
    journald) BEFORE the machine-readable result. Log lines start with a timestamp
    and never parse as JSON; the result is emitted last. So scan bottom-up. (See
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


def _bridge_env() -> Dict[str, str]:
    """Env for the Node bridge — ensures it can find the Metricool credentials.

    config.ts loads ``HERMES_ENV_FILE`` (default /home/ec2-user/hermes.env, absent
    here). Under the isolated HERMES_HOME we point it at ``$HERMES_HOME/.env``
    (gitignored, holds METRICOOL_*) so a live read works without exporting keys first.
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
    """Shell out to the READ-ONLY Node bridge (``scheduled`` | ``analytics``).

    Raises :class:`ReadGuardError` on any failure so the handler can convert it to
    a result. ``dry_run=True`` runs the bridge network-free.
    """
    node = shutil.which("node")
    if not node:
        raise ReadGuardError("node runtime not found on PATH")
    entry = _bridge_entry()
    if not entry.exists():
        raise ReadGuardError(f"bridge entry missing: {entry}")

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
        raise ReadGuardError(f"bridge timed out after {timeout}s")

    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or "").strip()
        prefix = "bridge bad-usage" if proc.returncode in (2, 3) else f"bridge failed (exit {proc.returncode})"
        raise ReadGuardError(f"{prefix}: {detail[:500]}")

    parsed = _parse_last_json((proc.stdout or "").strip())
    if parsed is None:
        raise ReadGuardError(f"bridge returned non-JSON: {(proc.stdout or '').strip()[:300]}")
    return parsed


# ---------------------------------------------------------------------------
# Tool handler (Hermes contract: return a JSON string; NEVER raise)
# ---------------------------------------------------------------------------
def sffs_score(args: Dict[str, Any], **kwargs: Any) -> str:
    """Hermes tool handler: read per-post analytics (the scoring input). READ-ONLY.

    Pulls Metricool analytics for the SFFS brand over ``from``..``to`` (defaults to
    the last 30 days) and returns per-post metrics. ``dry_run=True`` makes NO
    network call. Always returns a JSON string; never raises.
    """
    a = args if isinstance(args, dict) else {}
    try:
        req = build_score_request(a)
    except ReadGuardError as exc:
        return json.dumps({"ok": False, "error": str(exc)})
    except Exception as exc:
        return json.dumps({"ok": False, "error": f"invalid args: {exc}"})

    if "from" not in req or "to" not in req:
        d_from, d_to = default_window()
        req.setdefault("from", d_from)
        req.setdefault("to", d_to)

    dry_run = bool(a.get("dry_run", False))
    if dry_run:
        return json.dumps(
            {
                "ok": True,
                "dry_run": True,
                "from": req["from"],
                "to": req["to"],
                "request": req,
                "note": "dry-run made no network call",
            }
        )

    try:
        result = run_node_bridge("analytics", req, dry_run=False, timeout=180)
    except Exception as exc:
        return json.dumps({"ok": False, "error": str(exc)})
    if not isinstance(result, dict):
        return json.dumps({"ok": False, "error": "bridge returned a non-object result"})
    result.setdefault("ok", True)
    return json.dumps(result)
