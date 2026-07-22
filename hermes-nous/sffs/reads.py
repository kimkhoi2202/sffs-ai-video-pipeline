"""SFFS READ-ONLY data tools — the cycle's analytics/listing inputs.

Two tools the A/B loop uses to *reason* about performance, both strictly
READ-ONLY (they only ever issue GET requests through the Node bridge):

  * ``sffs_publer_read`` — list connected accounts, or list posts (by state /
    account / query / page). Wraps hermes/src/publer.ts ``listAccounts`` /
    ``listPosts`` / ``listAllPosts``.
  * ``sffs_score`` — the analytics reader: pull per-post metrics (reach, views,
    likes, comments, shares, saves, engagement, engagement_rate) from Publer
    ``post_insights`` over a date window. Wraps ``getPostInsights`` +
    ``flattenPostInsights``. This is the scoring input the loop uses.

Neither imports or can reach any create / schedule / publish / delete / update
path — the Node bridge (hermes-nous/bridge/publer-read.ts) imports ONLY read
functions. They complement the write-side belt (draft_guard.py), the do-not-touch
reads (donottouch.py), and the framework-layer publish guard (publish_guard.py).

DELIBERATE ARG-NAMING SAFETY: the post-state filter is exposed as ``state_filter``
(not ``state``). The ``pre_tool_call`` publish guard refuses a live/scheduled/
published VALUE under a state-like KEY (``state`` / ``post_state`` / ``post_status``)
on a posting-named tool — and ``sffs_publer_read`` is posting-named ("publer").
Naming the read filter ``state_filter`` (which normalizes to ``statefilter``, not a
state key) lets the agent legitimately LIST published/scheduled posts WITHOUT
tripping the write guard and WITHOUT weakening it. See tests/test_reads.py, which
locks this in so a rename back to ``state`` would go red.

Running LIVE needs PUBLER_API_KEY + PUBLER_WORKSPACE_ID (in $HERMES_HOME/.env).
``dry_run=True`` makes NO network call, so both tools are testable without keys or
network (the handler short-circuits before the bridge — see the tests).

Kept stdlib-only and free of intra-package imports so the pure arg-guards can be
imported directly by the hermetic test suite (mirrors draft_guard.py /
donottouch.py).
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
    """Raised for a malformed read/score argument (converted to an error result)."""


# Post states the read tool will filter by (Publer list states). Kept tight; the
# value is a GET filter only (never a state to *set* on a post).
_READ_STATES = frozenset({"draft", "scheduled", "published"})

# Allowed post_insights sort keys (Publer analytics API); a wrong value would only
# yield a Publer 4xx, so we constrain it for a clear up-front error message.
_SORT_BY = frozenset(
    {
        "reach",
        "engagement",
        "engagement_rate",
        "likes",
        "video_views",
        "comments",
        "shares",
        "saves",
        "link_clicks",
        "post_clicks",
        "scheduled_at",
        "postType",
    }
)

_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


# ---------------------------------------------------------------------------
# Pure arg-guards (no network, no subprocess) — the hermetically testable core
# ---------------------------------------------------------------------------
def _pos_int(value: Any, label: str, *, allow_zero: bool) -> int:
    """Validate a (non-negative | positive) integer, rejecting bools."""
    if isinstance(value, bool) or not isinstance(value, int):
        raise ReadGuardError(f"{label} must be an integer")
    if value < 0 or (not allow_zero and value == 0):
        raise ReadGuardError(f"{label} must be a {'non-negative' if allow_zero else 'positive'} integer")
    return value


def _string_list(value: Any, label: str) -> list:
    if not isinstance(value, list) or not all(isinstance(a, str) and a.strip() for a in value):
        raise ReadGuardError(f"{label} must be a list of non-empty strings")
    return list(value)


def build_read_request(args: Dict[str, Any]) -> Dict[str, Any]:
    """Validate + normalize a ``sffs_publer_read`` request. Pure.

    Returns ``{"sub": "accounts"|"posts", "params": <stdin dict|None>}``. The
    ``params`` dict uses the bridge's OWN field names (e.g. ``state``) — those go
    on the Node bridge's stdin and are NEVER seen by the framework's publish guard
    (which only inspects the TOOL args). Raises :class:`ReadGuardError` on any bad
    input.
    """
    if not isinstance(args, dict):
        raise ReadGuardError("args must be a JSON object")

    what = args.get("what", "accounts")
    if what not in ("accounts", "posts"):
        raise ReadGuardError("'what' must be 'accounts' or 'posts'")

    if what == "accounts":
        return {"sub": "accounts", "params": None}

    params: Dict[str, Any] = {}

    state = args.get("state_filter")
    if state is not None:
        if not isinstance(state, str) or not state.strip():
            raise ReadGuardError("state_filter must be a non-empty string")
        s = state.strip().lower()
        if s not in _READ_STATES:
            raise ReadGuardError(f"state_filter must be one of {sorted(_READ_STATES)}")
        params["state"] = s

    if args.get("page") is not None:
        params["page"] = _pos_int(args.get("page"), "page", allow_zero=True)

    if args.get("account_ids") is not None:
        params["account_ids"] = _string_list(args.get("account_ids"), "account_ids")

    query = args.get("query")
    if query is not None:
        if not isinstance(query, str):
            raise ReadGuardError("query must be a string")
        if query.strip():
            params["query"] = query.strip()

    all_pages = args.get("all_pages")
    if all_pages is not None:
        if not isinstance(all_pages, bool):
            raise ReadGuardError("all_pages must be a boolean")
        if all_pages:
            params["all"] = True

    if args.get("max_pages") is not None:
        params["max_pages"] = _pos_int(args.get("max_pages"), "max_pages", allow_zero=False)

    return {"sub": "posts", "params": params}


def build_score_request(args: Dict[str, Any]) -> Dict[str, Any]:
    """Validate + normalize a ``sffs_score`` request. Pure.

    Returns the params dict for the bridge's ``insights`` subcommand. ``from`` /
    ``to`` are validated (YYYY-MM-DD) when present; the handler fills a default
    window when they are absent. Raises :class:`ReadGuardError` on any bad input.
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

    sort_by = args.get("sort_by")
    if sort_by is not None:
        if not isinstance(sort_by, str) or sort_by.strip() not in _SORT_BY:
            raise ReadGuardError(f"sort_by must be one of {sorted(_SORT_BY)}")
        params["sort_by"] = sort_by.strip()

    sort_type = args.get("sort_type")
    if sort_type is not None:
        st = sort_type.strip().upper() if isinstance(sort_type, str) else sort_type
        if st not in ("ASC", "DESC"):
            raise ReadGuardError("sort_type must be 'ASC' or 'DESC'")
        params["sort_type"] = st

    if args.get("max_pages") is not None:
        params["max_pages"] = _pos_int(args.get("max_pages"), "max_pages", allow_zero=False)

    return params


def default_window(days: int = 30) -> Tuple[str, str]:
    """(from, to) YYYY-MM-DD for the last ``days`` days, UTC. Matches score.ts."""
    to = datetime.now(timezone.utc).date()
    frm = to - timedelta(days=days)
    return frm.isoformat(), to.isoformat()


# ---------------------------------------------------------------------------
# Node bridge plumbing (mirrors donottouch.py — read-only entry publer-read.ts)
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
    return _repo_dir() / "hermes-nous" / "bridge" / "publer-read.ts"


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
    """Env for the Node bridge — ensures it can find the Publer keys.

    config.ts loads ``HERMES_ENV_FILE`` (default /home/ec2-user/hermes.env, absent
    here). Under the isolated HERMES_HOME we point it at ``$HERMES_HOME/.env``
    (gitignored, holds PUBLER_*) so a live read works without exporting keys first.
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
    """Shell out to the READ-ONLY Node bridge (``accounts`` | ``posts`` | ``insights``).

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
# Tool handlers (Hermes contract: return a JSON string; NEVER raise)
# ---------------------------------------------------------------------------
def sffs_publer_read(args: Dict[str, Any], **kwargs: Any) -> str:
    """Hermes tool handler: list Publer accounts, or list posts. READ-ONLY.

    ``dry_run=True`` makes NO network call. Always returns a JSON string; never
    raises.
    """
    try:
        req = build_read_request(args if isinstance(args, dict) else {})
    except ReadGuardError as exc:
        return json.dumps({"ok": False, "error": str(exc)})
    except Exception as exc:
        return json.dumps({"ok": False, "error": f"invalid args: {exc}"})

    dry_run = bool(args.get("dry_run", False)) if isinstance(args, dict) else False
    if dry_run:
        return json.dumps(
            {
                "ok": True,
                "dry_run": True,
                "what": req["sub"],
                "request": req["params"] or {},
                "note": "dry-run made no network call",
            }
        )

    try:
        result = run_node_bridge(req["sub"], req["params"], dry_run=False)
    except Exception as exc:
        return json.dumps({"ok": False, "error": str(exc)})
    if not isinstance(result, dict):
        return json.dumps({"ok": False, "error": "bridge returned a non-object result"})
    result.setdefault("ok", True)
    return json.dumps(result)


def sffs_score(args: Dict[str, Any], **kwargs: Any) -> str:
    """Hermes tool handler: read per-post analytics (the scoring input). READ-ONLY.

    Pulls Publer ``post_insights`` for the SFFS accounts over ``from``..``to``
    (defaults to the last 30 days) and returns flattened per-post metrics.
    ``dry_run=True`` makes NO network call. Always returns a JSON string; never
    raises.
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
        result = run_node_bridge("insights", req, dry_run=False, timeout=180)
    except Exception as exc:
        return json.dumps({"ok": False, "error": str(exc)})
    if not isinstance(result, dict):
        return json.dumps({"ok": False, "error": "bridge returned a non-object result"})
    result.setdefault("ok", True)
    return json.dumps(result)
