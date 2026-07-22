"""SFFS CYCLE tool — run ONE full DRAFT-ONLY A/B cycle end to end.

One tool, ``sffs_cycle``, that ties all the individual sffs wrap tools into the
autonomous cycle by wrapping hermes/src/cycle.ts ``runCycle`` (the proven
orchestrator). runCycle runs, in order:

  preflight (assertDraftOnly + LLM ping) -> snapshotDoNotTouch (read-only) ->
  pullAndScore (refresh ab-database.json + learnings.json) -> planBatch (design
  the A/B batch: rotating dimensions incl. the narration family + progress-counter
  arms) -> per video [dedup -> validity -> markUsed(after validity) -> copy ->
  render -> render-sanity -> (live) S3 upload -> Publer media import ->
  createDraftOnly] -> verifyDoNotTouch (read-only) .

SAFETY — this cannot publish, schedule, or push to main (belt AND suspenders):
  * createDraftOnly is the ONLY Publer write runCycle performs and it forces
    state="draft"; no schedule/publish/delete/update path is imported in cycle.ts.
  * ``_bridge_env`` ALWAYS sets ``HERMES_SKIP_GIT=1`` and the bridge (bridge/
    cycle.ts) also forces it — so a cycle from the sandbox can NEVER
    ``git push origin HEAD:main`` (cycle.ts's gitCommitPush is gated on it). This
    is verified in tests/test_cycle.py.
  * The framework ``pre_tool_call`` publish guard (publish_guard.py) is the third
    layer across every tool.

MODES:
  * ``preview=True`` (subprocess-free, the hermetic default surface for tests):
    validate the request and return the resolved run config (target, dry_run, and
    ``skip_git=True``) WITHOUT running node.
  * ``dry_run=True`` (default when actually running): the cycle runs in the
    pipeline's DRY mode — planBatch + gates + render execute, but there is NO S3
    upload, NO Publer draft, and NO git push. A safe end-to-end dry-run.
  * ``dry_run=False``: a REAL draft-only cycle — additionally uploads to S3 and
    creates Publer DRAFTS (via createDraftOnly). Still never publishes/schedules a
    live post, and still never pushes to main.

Running LIVE needs the TrueFoundry key (design/gates LLM), PUBLER_* (reads +
draft), ELEVENLABS_API_KEY (voiced narration arms only), and — for a non-dry
cycle — AWS creds/instance role (S3). All are read from $HERMES_HOME/.env via
config.ts. ``preview`` needs none of them, so the tool is testable without keys,
network, node, or the Hermes framework.

Kept stdlib-only and free of intra-package imports so the pure arg-guards can be
imported directly by the hermetic test suite (mirrors render.py / reads.py).
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from pathlib import Path
from typing import Any, Dict, Optional


class CycleGuardError(ValueError):
    """Raised for a malformed cycle argument (converted to an error result)."""


# A run id becomes a filename stem + git-free run key, so keep it filesystem-safe.
_RUN_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_MAX_TARGET = 50


# ---------------------------------------------------------------------------
# Pure arg-guards (no network, no subprocess) — the hermetically testable core
# ---------------------------------------------------------------------------
def build_cycle_request(args: Dict[str, Any]) -> Dict[str, Any]:
    """Validate + normalize an ``sffs_cycle`` request. Pure.

    Returns ``{"dry_run", "preview", "target", "run_id", "data_dir"}``. Raises
    :class:`CycleGuardError` on any bad input.
    """
    if not isinstance(args, dict):
        raise CycleGuardError("args must be a JSON object")

    dry_run = args.get("dry_run", True)
    if not isinstance(dry_run, bool):
        raise CycleGuardError("dry_run must be a boolean")

    preview = args.get("preview", False)
    if not isinstance(preview, bool):
        raise CycleGuardError("preview must be a boolean")

    target = args.get("target")
    if target is not None:
        if isinstance(target, bool) or not isinstance(target, int):
            raise CycleGuardError("target must be an integer")
        if target < 1 or target > _MAX_TARGET:
            raise CycleGuardError(f"target must be between 1 and {_MAX_TARGET}")

    run_id = args.get("run_id")
    if run_id is not None:
        if not isinstance(run_id, str) or not _RUN_ID_RE.match(run_id.strip()):
            raise CycleGuardError(
                "run_id must be a filesystem-safe string (letters/digits/._-, <=128 chars)"
            )
        run_id = run_id.strip()

    data_dir = args.get("data_dir")
    if data_dir is not None and (not isinstance(data_dir, str) or not data_dir.strip()):
        raise CycleGuardError("data_dir must be a non-empty string path")

    return {
        "dry_run": dry_run,
        "preview": preview,
        "target": target,
        "run_id": run_id,
        "data_dir": data_dir.strip() if isinstance(data_dir, str) else None,
    }


# ---------------------------------------------------------------------------
# Node bridge plumbing (mirrors render.py — entry bridge/cycle.ts)
# ---------------------------------------------------------------------------
def _repo_dir() -> Path:
    override = os.environ.get("HERMES_SFFS_REPO_DIR")
    if override:
        return Path(override).resolve()
    return Path(__file__).resolve().parents[2]


def _bridge_entry() -> Path:
    return _repo_dir() / "hermes-nous" / "bridge" / "cycle.ts"


def _default_data_dir() -> Path:
    """Where renders/runs land (CONFIG.DATA_DIR). Prefer the isolated HERMES_HOME
    (outside the repo, writable, untracked); fall back to a gitignored repo dir."""
    home = os.environ.get("HERMES_HOME")
    if home:
        return Path(home) / "sffs-data"
    return _repo_dir() / ".sffs-data"


def _parse_last_json(stdout: str) -> Optional[Dict[str, Any]]:
    """Return the last stdout line that decodes to a JSON object, else None.

    cycle.ts shares hermes/src/log.ts (INFO/WARN to STDOUT for journald) before the
    machine-readable RunState. Log lines start with a timestamp and never parse as
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


def _bridge_env(req: Dict[str, Any]) -> Dict[str, str]:
    """Env for the Node bridge. ALWAYS sets HERMES_SKIP_GIT=1 (a cycle from the
    sandbox can never push to main). Maps the request to the env cycle.ts/config.ts
    read at module load (HERMES_DRY_RUN, HERMES_VIDEOS_PER_DAY) + runtime
    (HERMES_RUN_ID, HERMES_SKIP_GIT)."""
    env = os.environ.copy()

    # --- SAFETY: never push to main from the sandbox (belt; the bridge also sets it).
    env["HERMES_SKIP_GIT"] = "1"

    # --- keys for the LLM / Publer / narration / S3 calls the cycle makes.
    if not env.get("HERMES_ENV_FILE"):
        home = env.get("HERMES_HOME")
        if home:
            candidate = Path(home) / ".env"
            if candidate.exists():
                env["HERMES_ENV_FILE"] = str(candidate)

    # --- render-sanity gate (gates.ts) shells to ffprobe, whose default path is
    #     /usr/local/bin/ffprobe (VPS/Linux). Resolve the real ffprobe on PATH so
    #     the gate works on any host (e.g. Apple Silicon: /opt/homebrew/bin). The
    #     VPS keeps its default when FFPROBE is unset there and this can't resolve.
    if not env.get("FFPROBE"):
        ffprobe = shutil.which("ffprobe")
        if ffprobe:
            env["FFPROBE"] = ffprobe

    # --- DRY mode (render + gates, but no upload/draft/push). Read at module load.
    if req.get("dry_run"):
        env["HERMES_DRY_RUN"] = "1"
    else:
        env.pop("HERMES_DRY_RUN", None)

    # --- bound the batch size. Read by config.ts (frozen at load).
    if req.get("target") is not None:
        env["HERMES_VIDEOS_PER_DAY"] = str(req["target"])

    # --- resumable run id (read at runtime inside runCycle).
    if req.get("run_id"):
        env["HERMES_RUN_ID"] = req["run_id"]

    # --- where renders/runs land (outside the repo).
    if req.get("data_dir"):
        env["HERMES_DATA_DIR"] = req["data_dir"]
    elif not env.get("HERMES_DATA_DIR"):
        env["HERMES_DATA_DIR"] = str(_default_data_dir())

    return env


def run_node_bridge(req: Dict[str, Any], *, timeout: int = 3600) -> Dict[str, Any]:
    """Shell out to the CYCLE Node bridge. Raises :class:`CycleGuardError` on any
    failure so the handler can convert it to a result."""
    node = shutil.which("node")
    if not node:
        raise CycleGuardError("node runtime not found on PATH")
    entry = _bridge_entry()
    if not entry.exists():
        raise CycleGuardError(f"bridge entry missing: {entry}")

    try:
        proc = subprocess.run(
            [node, str(entry)],
            input="",
            capture_output=True,
            text=True,
            timeout=timeout,
            cwd=str(_repo_dir()),
            env=_bridge_env(req),
        )
    except subprocess.TimeoutExpired:
        raise CycleGuardError(f"bridge timed out after {timeout}s")

    parsed = _parse_last_json((proc.stdout or "").strip())
    if parsed is None:
        detail = (proc.stderr or proc.stdout or "").strip()
        raise CycleGuardError(f"bridge returned non-JSON (exit {proc.returncode}): {detail[-500:]}")
    return parsed


def _summarize(state: Dict[str, Any], req: Dict[str, Any]) -> Dict[str, Any]:
    """Compact, dashboard-friendly view of the RunState returned by runCycle."""
    videos = state.get("videos") or []
    return {
        "ok": True,
        "dry_run": bool(req.get("dry_run")),
        "run_id": state.get("run_id"),
        "status": state.get("status"),
        "target_count": state.get("target_count"),
        "summary": state.get("summary"),
        "scoring": state.get("scoring"),
        "do_not_touch": {
            "scheduled": len((state.get("do_not_touch") or {}).get("scheduled_ids") or []),
            "published": len((state.get("do_not_touch") or {}).get("published_ids") or []),
            "captured_at": (state.get("do_not_touch") or {}).get("captured_at"),
        },
        "git": state.get("git"),
        "errors": state.get("errors") or [],
        "videos": [
            {
                "id": v.get("id"),
                "dimension": v.get("dimension"),
                "arm": v.get("arm"),
                "status": v.get("status"),
                "reject_reason": v.get("reject_reason"),
                "render_path": v.get("render_path"),
                "media_url": v.get("media_url"),
                "post_ids": (v.get("publer") or {}).get("post_ids"),
            }
            for v in videos
        ],
    }


# ---------------------------------------------------------------------------
# Tool handler (Hermes contract: return a JSON string; NEVER raise)
# ---------------------------------------------------------------------------
def sffs_cycle(args: Dict[str, Any], **kwargs: Any) -> str:
    """Hermes tool handler: run ONE full DRAFT-ONLY A/B cycle end to end.

    ``preview=True`` returns the resolved run config WITHOUT running (no
    subprocess). Otherwise it runs the cycle via the Node bridge: ``dry_run=True``
    (default) renders + gates but creates no drafts and pushes nothing;
    ``dry_run=False`` additionally uploads to S3 and creates Publer DRAFTS (never
    publishes/schedules, never pushes to main). Always returns a JSON string;
    never raises.
    """
    a = args if isinstance(args, dict) else {}
    try:
        req = build_cycle_request(a)
    except CycleGuardError as exc:
        return json.dumps({"ok": False, "error": str(exc)})
    except Exception as exc:
        return json.dumps({"ok": False, "error": f"invalid args: {exc}"})

    if req["preview"]:
        return json.dumps(
            {
                "ok": True,
                "preview": True,
                "dry_run": req["dry_run"],
                "target": req["target"],
                "run_id": req["run_id"],
                "skip_git": True,  # a cycle from the sandbox never pushes to main
                "note": (
                    "preview only — no cycle was run (no LLM/Publer/render/S3/network). "
                    "Run with preview=false to execute; dry_run controls whether drafts are created."
                ),
            }
        )

    try:
        state = run_node_bridge(req)
    except Exception as exc:
        return json.dumps({"ok": False, "error": str(exc)})
    if not isinstance(state, dict):
        return json.dumps({"ok": False, "error": "bridge returned a non-object result"})
    return json.dumps(_summarize(state, req))
