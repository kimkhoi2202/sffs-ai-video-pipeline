"""SFFS DESIGN tool — plan the day's A/B quiz-video batch.

One tool, ``sffs_design``, with two read/design-only modes (selected by ``what``):

  * ``catalog`` — return the static A/B DIMENSION table (dimension / arm /
    rationale + the narration arm and progress-counter axes). Runs NO LLM and
    makes NO network call, so it's the cheap way to see the whole A/B space,
    including the narration family (full / none / no-question-vo / no-options-vo)
    and the progress-counter arms. Wraps design.ts ``dimensionCatalog``.
  * ``plan`` — run the full batch designer: pick FRESH, never-repeated questions
    per dimension and write on-brand, gated captions. Wraps design.ts
    ``planBatch(run_id, target)``. This path DOES call the LLM for captions (the
    designer falls back to safe captions if the LLM is unreachable — it never
    throws for that).

design.ts has NO create / schedule / publish / delete / update path anywhere in
its dependency tree (it composes questions / gates / llm / brand / state / config
/ log only), so the Node bridge (hermes-nous/bridge/design.ts) is physically
unable to create, publish, schedule, or mutate any post. This is a DESIGN/READ
tool; the only sanctioned write is the loop's own Metricool draft path.

GUARD-SAFE ARG NAMING: the args are ``what`` / ``run_id`` / ``target`` / ``dry_run``
— none normalize to a state / schedule / publish key, and ``sffs_design`` is not a
posting-named tool, so the framework publish guard never flags it (locked in by a
cross-check in tests/test_design.py).

Kept stdlib-only and free of intra-package imports so the pure arg-guards can be
imported directly by the hermetic test suite (mirrors reads.py / donottouch.py).
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from pathlib import Path
from typing import Any, Dict, Optional

# Upper bound on a single design batch. The live loop targets ~10/day
# (config.ts VIDEOS_PER_DAY); this cap just keeps a fat-fingered target from
# kicking off a huge LLM caption run. Not a safety invariant, just a sane bound.
_MAX_TARGET = 50

# run_id is used by design.ts as a deterministic seed AND as the per-video id
# prefix, so keep it to filesystem/id-safe characters (dates like 2026-07-22,
# slugs like validate-20260722). Bounded length.
_RUN_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")


class DesignGuardError(ValueError):
    """Raised for a malformed design argument (converted to an error result)."""


# ---------------------------------------------------------------------------
# Pure arg-guard (no network, no subprocess) — the hermetically testable core
# ---------------------------------------------------------------------------
def build_design_request(args: Dict[str, Any]) -> Dict[str, Any]:
    """Validate + normalize an ``sffs_design`` request. Pure.

    Returns ``{"sub": "catalog"|"plan", "params": <stdin dict|None>}``. For
    ``plan``, ``params`` carries ``run_id`` (if provided) and ``target`` (if
    provided); the handler fills sensible defaults (today's date / 10) when they
    are absent. Raises :class:`DesignGuardError` on any bad input.
    """
    if not isinstance(args, dict):
        raise DesignGuardError("args must be a JSON object")

    what = args.get("what", "catalog")
    if what not in ("catalog", "plan"):
        raise DesignGuardError("'what' must be 'catalog' or 'plan'")

    if what == "catalog":
        return {"sub": "catalog", "params": None}

    params: Dict[str, Any] = {}

    run_id = args.get("run_id")
    if run_id is not None:
        if not isinstance(run_id, str) or not _RUN_ID_RE.match(run_id.strip()):
            raise DesignGuardError(
                "run_id must be a short id of letters/digits/._- (e.g. a date like 2026-07-22)"
            )
        params["run_id"] = run_id.strip()

    target = args.get("target")
    if target is not None:
        if isinstance(target, bool) or not isinstance(target, int):
            raise DesignGuardError("target must be an integer")
        if target < 1 or target > _MAX_TARGET:
            raise DesignGuardError(f"target must be between 1 and {_MAX_TARGET}")
        params["target"] = target

    return {"sub": "plan", "params": params}


def default_run_id() -> str:
    """Today's UTC date (YYYY-MM-DD) — matches state.ts todayRunId()."""
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).date().isoformat()


# ---------------------------------------------------------------------------
# Node bridge plumbing (mirrors reads.py — design entry hermes-nous/bridge/design.ts)
# ---------------------------------------------------------------------------
def _repo_dir() -> Path:
    """Absolute path to the pipeline repo root (symlink-safe via resolve()).

    design.py -> sffs/ -> hermes-nous/ -> repo. ``HERMES_SFFS_REPO_DIR`` overrides.
    """
    override = os.environ.get("HERMES_SFFS_REPO_DIR")
    if override:
        return Path(override).resolve()
    return Path(__file__).resolve().parents[2]


def _bridge_entry() -> Path:
    return _repo_dir() / "hermes-nous" / "bridge" / "design.ts"


def _parse_last_json(stdout: str) -> Optional[Dict[str, Any]]:
    """Return the last stdout line that decodes to a JSON object, else None.

    The Node bridge shares hermes/src/log.ts (which writes INFO/WARN to STDOUT for
    journald) BEFORE the machine-readable result — planBatch logs one line per
    planned/dropped video. Log lines start with a timestamp and never parse as
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


def _bridge_env() -> Dict[str, str]:
    """Env for the Node bridge — ensures design.ts can load the LLM (TFY) key.

    config.ts loads ``HERMES_ENV_FILE`` (default /home/ec2-user/hermes.env, absent
    here). Under the isolated HERMES_HOME we point it at ``$HERMES_HOME/.env``
    (gitignored, holds the TrueFoundry key as OPENAI_API_KEY) so a live plan's
    caption generation works without exporting keys first.
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
    timeout: int = 300,
) -> Dict[str, Any]:
    """Shell out to the DESIGN Node bridge (``catalog`` | ``plan``).

    Raises :class:`DesignGuardError` on any failure so the handler can convert it
    to a result. ``dry_run=True`` runs the bridge network-free.
    """
    node = shutil.which("node")
    if not node:
        raise DesignGuardError("node runtime not found on PATH")
    entry = _bridge_entry()
    if not entry.exists():
        raise DesignGuardError(f"bridge entry missing: {entry}")

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
        raise DesignGuardError(f"bridge timed out after {timeout}s")

    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or "").strip()
        prefix = "bridge bad-usage" if proc.returncode in (2, 3) else f"bridge failed (exit {proc.returncode})"
        raise DesignGuardError(f"{prefix}: {detail[:500]}")

    parsed = _parse_last_json((proc.stdout or "").strip())
    if parsed is None:
        raise DesignGuardError(f"bridge returned non-JSON: {(proc.stdout or '').strip()[:300]}")
    return parsed


# ---------------------------------------------------------------------------
# Tool handler (Hermes contract: return a JSON string; NEVER raise)
# ---------------------------------------------------------------------------
def sffs_design(args: Dict[str, Any], **kwargs: Any) -> str:
    """Hermes tool handler: introspect the A/B catalog, or plan the batch.

    ``what='catalog'`` (default) returns the static dimension table (no LLM / no
    network). ``what='plan'`` runs the full designer (LLM captions; DESIGN only,
    no post I/O). ``dry_run=True`` makes NO network/LLM call. Always returns a
    JSON string; never raises.
    """
    a = args if isinstance(args, dict) else {}
    try:
        req = build_design_request(a)
    except DesignGuardError as exc:
        return json.dumps({"ok": False, "error": str(exc)})
    except Exception as exc:
        return json.dumps({"ok": False, "error": f"invalid args: {exc}"})

    dry_run = bool(a.get("dry_run", False))

    if req["sub"] == "catalog":
        if dry_run:
            return json.dumps({"ok": True, "dry_run": True, "what": "catalog", "note": "dry-run made no network call"})
        try:
            result = run_node_bridge("catalog", None, dry_run=False, timeout=60)
        except Exception as exc:
            return json.dumps({"ok": False, "error": str(exc)})
        if not isinstance(result, dict):
            return json.dumps({"ok": False, "error": "bridge returned a non-object result"})
        result.setdefault("ok", True)
        return json.dumps(result)

    # plan: fill defaults the builder deliberately left to the handler.
    params = dict(req["params"] or {})
    params.setdefault("run_id", default_run_id())
    params.setdefault("target", 10)

    if dry_run:
        return json.dumps(
            {
                "ok": True,
                "dry_run": True,
                "what": "plan",
                "request": params,
                "note": "dry-run made no network call",
            }
        )

    try:
        result = run_node_bridge("plan", params, dry_run=False, timeout=300)
    except Exception as exc:
        return json.dumps({"ok": False, "error": str(exc)})
    if not isinstance(result, dict):
        return json.dumps({"ok": False, "error": "bridge returned a non-object result"})
    result.setdefault("ok", True)
    return json.dumps(result)
