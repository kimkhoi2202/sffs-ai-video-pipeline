"""SFFS software factory — autonomous CODE self-improvement on the TWO-KEY gate.

This is the RUNTIME self-improvement engine (RALPH_TASK.md criteria 6 + 7 + 8): the
deployed agent improves its OWN code by fanning out build workstreams to
``delegate_task`` subagents (aggressive-but-bounded), then auto-merging each
proposed change ONLY when the merged two-key gate turns BOTH keys:

    KEY 1  the E2E harness is GREEN, AND
    KEY 2  an independent review-agent APPROVES.

It CONSUMES the already-merged gate in ``scripts/gate/`` — it does NOT reimplement
it. ``auto_merge.two_key_gate`` owns the merge mechanics (ephemeral worktree,
compare-and-swap, protected-branch + scope + kill-switch guards, fail-closed
decision); ``harness.run_harness`` is key 1; ``review_agent.review`` (a fresh
oneshot / ``delegate_task`` subagent, independent of the author) is key 2. This
module adds the ORCHESTRATION around it: cost-governor pre-flight, the delegate
fan-out seam, scope defaults, and a rollback path.

SAFETY (why this is safe to build + dry-run tonight):
  * DRY-RUN by default. The tool never spawns a fleet or merges real code unless
    BOTH ``execute=True`` AND ``dry_run=False`` are set explicitly (never done by
    this build). Dry-run computes the gate decision on a real branch WITHOUT
    merging and WITHOUT spawning subagents.
  * Honors the COST GOVERNOR + kill-switch: pre-flight aborts (no spawn, no gate)
    if the kill-switch is engaged or a daily ceiling is hit, and it re-checks the
    kill-switch before every delegate spawn. The kill-file is also passed to the
    gate so ``auto_merge`` refuses on the same switch.
  * NEVER targets a protected branch (main/master/prod…). Code autonomy is scoped
    to the build branch; the prod cutover is human-gated (ops/CUTOVER.md).
  * Scope guard: deny-globs block prod infra / secrets from an auto-merge, and the
    gate only ever runs git inside the ONE pipeline repo (no unrelated repos).
  * NEVER a posting path. The factory changes CODE; it can never publish/schedule
    (the DRAFT-ONLY belt + the governor are orthogonal and always on).

Design: stdlib-only pure core + a never-raising plugin tool handler. The gate and
delegate runners are INJECTABLE so this module's orchestration is unit-tested on a
throwaway git repo with deterministic keys — never spending tokens or touching a
real branch (see tests/test_factory.py).
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

try:  # package context (framework: sffs.factory) vs flat sys.path (hermetic tests)
    from . import cost_governor as _cg
except ImportError:  # pragma: no cover - exercised via the flat-import test path
    import cost_governor as _cg

# hermes-nous/sffs/factory.py -> parents[1] == hermes-nous/ ; parents[2] == repo
HERMES_NOUS_DIR = Path(__file__).resolve().parents[1]
REPO_DIR = HERMES_NOUS_DIR.parent
GATE_DIR = HERMES_NOUS_DIR / "scripts" / "gate"

DEFAULT_TARGET = "hermes-nous"
PROTECTED_BRANCHES = ("main", "master", "production", "prod", "release")
# Prod infra / secrets an auto-merge must never touch (scope guard passed to the gate).
DEFAULT_DENY_GLOBS = (
    "ops/**",
    "**/*.pem",
    "**/*.key",
    "**/*.p12",
    "**/id_rsa*",
    "**/*.env",
    "**/.env",
)
DEFAULT_MAX_WORKSTREAMS = 8


# ---------------------------------------------------------------------------
# Planning
# ---------------------------------------------------------------------------
def slugify(text: Any) -> str:
    # Collapse to lowercase alnum + single hyphens, then trim separators. The
    # final .strip("-") is applied AFTER the 48-char truncation too: truncating
    # can land on a hyphen boundary and leave a trailing "-", which would make an
    # awkward git branch name (e.g. "sffs-factory/some-long-goal-"). Stripping
    # after the slice keeps every generated workstream branch clean.
    s = re.sub(r"[^a-z0-9]+", "-", str(text or "").strip().lower()).strip("-")
    return s[:48].strip("-") or "workstream"


def plan_workstreams(
    goals: Optional[List[str]],
    *,
    base: str = DEFAULT_TARGET,
    prefix: str = "sffs-factory/",
    max_workstreams: int = DEFAULT_MAX_WORKSTREAMS,
) -> List[Dict[str, Any]]:
    """Turn high-level goal strings into concrete workstream specs (bounded)."""
    out: List[Dict[str, Any]] = []
    seen: set = set()
    for i, goal in enumerate((goals or [])[: max(0, max_workstreams)]):
        g = str(goal or "").strip()
        if not g:
            continue
        slug = slugify(g)
        branch = f"{prefix}{slug}"
        n = 2
        while branch in seen:  # de-dup collisions
            branch = f"{prefix}{slug}-{n}"
            n += 1
        seen.add(branch)
        out.append({"id": f"ws{i + 1:02d}", "goal": g, "branch": branch, "base": base})
    return out


# ---------------------------------------------------------------------------
# Guards
# ---------------------------------------------------------------------------
def is_protected(target: Any, protected: tuple = PROTECTED_BRANCHES) -> Optional[str]:
    name = str(target or "").strip().replace("refs/heads/", "")
    if name in protected:
        return f"target '{name}' is a protected branch — auto-merge is forbidden (human-gated cutover only)"
    return None


def preflight(env: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
    """Cost-governor gate BEFORE any spend: kill-switch + daily ceiling.

    Returns ``{ok, reason, governor}``. ``ok`` is False (abort — no spawn, no
    gate) when the kill-switch is engaged or a daily ceiling is already hit.
    """
    env = env if env is not None else os.environ
    kr = _cg.kill_switch_reason(env)
    if kr:
        return {"ok": False, "reason": kr, "governor": _cg.status(env=env)}
    cr = _cg.ceiling_reason(_cg.read_tally(env=env), _cg.load_limits(env))
    if cr:
        return {"ok": False, "reason": cr, "governor": _cg.status(env=env)}
    return {"ok": True, "reason": None, "governor": _cg.status(env=env)}


# ---------------------------------------------------------------------------
# git helpers
# ---------------------------------------------------------------------------
def _git(repo: Path, *args: str, check: bool = True, timeout: int = 60) -> subprocess.CompletedProcess:
    proc = subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True, timeout=timeout)
    if check and proc.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} failed: {(proc.stderr or proc.stdout or '').strip()[:300]}")
    return proc


def _branch_exists(repo: Path, ref: str) -> bool:
    try:
        return _git(repo, "rev-parse", "--verify", "--quiet", ref, check=False).returncode == 0
    except Exception:
        return False


def _has_changes(repo: Path, target: str, source: str) -> bool:
    try:
        out = _git(repo, "diff", "--name-only", f"{target}...{source}", check=False).stdout
        return any(ln.strip() for ln in out.splitlines())
    except Exception:
        return False


# ---------------------------------------------------------------------------
# Injectable runners
# ---------------------------------------------------------------------------
def default_gate_runner(
    repo: Path,
    source: str,
    target: str,
    *,
    execute: bool,
    deny_globs: tuple = DEFAULT_DENY_GLOBS,
    kill_file: Optional[str] = None,
    offline_review: bool = True,
    log_file: Optional[str] = None,
) -> Dict[str, Any]:
    """Call the REAL two-key gate (scripts/gate/auto_merge.two_key_gate)."""
    if str(GATE_DIR) not in sys.path:
        sys.path.insert(0, str(GATE_DIR))
    import auto_merge  # noqa: E402  (lazy: only when actually gating)
    import review_agent  # noqa: E402

    review_runner = auto_merge._default_review_runner
    if offline_review:
        review_runner = lambda diff: review_agent.review(diff, require_model=False)  # noqa: E731
    return auto_merge.two_key_gate(
        Path(repo), source, target,
        execute=execute,
        review_runner=review_runner,
        deny_globs=tuple(deny_globs),
        kill_file=Path(kill_file) if kill_file else None,
        log_file=Path(log_file) if log_file else auto_merge.DEFAULT_LOG,
    )


def default_delegate_runner(spec: Dict[str, Any], *, env: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
    """Spawn a build subagent for one workstream. Wiring seam (never in dry-run).

    Precedence:
      * ``SFFS_FACTORY_DELEGATE_CMD`` — a shell template (``{goal}`` / ``{branch}``
        substituted) run to implement the workstream on its branch. This is the
        deploy-time hook to point the fan-out at ``delegate_task`` (role=orchestrator,
        aggressive-but-bounded) or a specific runner.
      * otherwise NOT wired here — returns a clear ``spawned:false`` result rather
        than raising (the agent drives ``delegate_task`` per the sffs-software-factory
        skill; this module owns governance + the gate, not the LLM turn).
    """
    env = env if env is not None else os.environ
    template = (env.get("SFFS_FACTORY_DELEGATE_CMD") or "").strip()
    if not template:
        return {
            "spawned": False,
            "note": "no SFFS_FACTORY_DELEGATE_CMD wired — the agent fans out via delegate_task "
                    "per the sffs-software-factory skill; this seam is for a headless runner.",
        }
    cmd = template.replace("{goal}", spec.get("goal", "")).replace("{branch}", spec.get("branch", ""))
    try:
        proc = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=int(env.get("SFFS_FACTORY_DELEGATE_TIMEOUT", "1800")))
        return {"spawned": True, "returncode": proc.returncode, "stdout_tail": (proc.stdout or "")[-2000:]}
    except Exception as exc:  # noqa: BLE001 — never crash the orchestrator
        return {"spawned": False, "error": f"delegate runner failed: {exc}"}


# ---------------------------------------------------------------------------
# Rollback
# ---------------------------------------------------------------------------
def rollback_to_sha(repo: Path, target: str, to_sha: str) -> Dict[str, Any]:
    """Move ``target`` back to a previous (green) SHA. The auto-merge undo path.

    Uses ``update-ref`` (moves the branch pointer) rather than a merge revert so
    the recovery is exact. A no-op in dry-run (nothing was merged).
    """
    try:
        _git(Path(repo), "update-ref", f"refs/heads/{str(target).replace('refs/heads/', '')}", to_sha)
        return {"ok": True, "target": target, "rolled_back_to": to_sha}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": str(exc)}


# ---------------------------------------------------------------------------
# The orchestrator
# ---------------------------------------------------------------------------
def run_factory(
    goals: Optional[List[str]] = None,
    *,
    repo: Path = REPO_DIR,
    target: str = DEFAULT_TARGET,
    source: Optional[str] = None,
    execute: bool = False,
    dry_run: bool = True,
    offline_review: bool = True,
    deny_globs: tuple = DEFAULT_DENY_GLOBS,
    max_workstreams: int = DEFAULT_MAX_WORKSTREAMS,
    kill_file: Optional[str] = None,
    delegate_runner: Optional[Callable[[Dict[str, Any]], Dict[str, Any]]] = None,
    gate_runner: Optional[Callable[..., Dict[str, Any]]] = None,
    env: Optional[Dict[str, str]] = None,
) -> Dict[str, Any]:
    """Run the software factory: propose (delegate) → gate (two-key) → auto-merge.

    ``dry_run=True`` (default): NO subagent is spawned and NO merge happens; the
    gate runs in dry-run on any real prepared branch so the decision is proven.
    A real run requires BOTH ``execute=True`` AND ``dry_run=False``.
    """
    env = env if env is not None else os.environ
    repo = Path(repo)
    gate_runner = gate_runner or default_gate_runner
    delegate_runner = delegate_runner or default_delegate_runner
    real = bool(execute and not dry_run)
    result: Dict[str, Any] = {
        "mode": "execute" if real else "dry-run",
        "target": target,
        "repo": str(repo),
        "aborted": None,
        "preflight": None,
        "workstreams": [],
        "merged": [],
        "rollback_points": [],
    }

    # 1. protected-branch guard (fail-closed) — never auto-merge into prod branches.
    prot = is_protected(target)
    if prot:
        result["aborted"] = prot
        return result

    # 2. cost-governor pre-flight (kill-switch + daily ceiling) — abort before any spend.
    pf = preflight(env)
    result["preflight"] = pf
    if not pf["ok"]:
        result["aborted"] = f"cost governor: {pf['reason']}"
        return result

    # 3. plan workstreams from goals; a directly-supplied `source` is a ready branch.
    workstreams = plan_workstreams(goals, base=target, max_workstreams=max_workstreams)
    if source:
        workstreams.append({"id": "src", "goal": f"gate prepared branch {source}", "branch": source, "base": target})

    # 4. for each workstream: PROPOSE (delegate) then GATE (two-key).
    for ws in workstreams:
        rec: Dict[str, Any] = {"id": ws["id"], "goal": ws["goal"], "branch": ws["branch"]}

        # re-check the kill-switch before EACH spawn (bounded fan-out; belt AND
        # suspenders with the governor's pre_tool_call block on delegate_task).
        kr = _cg.kill_switch_reason(env)
        if kr:
            rec["skipped"] = f"kill-switch engaged mid-run: {kr}"
            result["workstreams"].append(rec)
            break

        # PROPOSE
        if real:
            rec["delegation"] = delegate_runner(ws)
        else:
            rec["delegation"] = {"planned": True, "spawned": False,
                                 "note": "dry-run: would delegate_task to implement this workstream (not spawned)"}

        # GATE — only if the branch exists and actually has changes vs target.
        if not _branch_exists(repo, ws["branch"]):
            rec["gate"] = {"skipped": "branch does not exist yet (would be gated after the workstream lands its commit)"}
        elif not _has_changes(repo, target, ws["branch"]):
            rec["gate"] = {"skipped": "no changes vs target (nothing to merge)"}
        else:
            target_sha_before = _git(repo, "rev-parse", target, check=False).stdout.strip()
            gate = gate_runner(
                repo, ws["branch"], target,
                execute=real, deny_globs=deny_globs, kill_file=kill_file, offline_review=offline_review,
            )
            rec["gate"] = gate
            decision = (gate or {}).get("decision") or {}
            if gate.get("merged"):
                result["merged"].append({"branch": ws["branch"], "commit": gate.get("merge_commit")})
                if target_sha_before:
                    result["rollback_points"].append({"branch": ws["branch"], "previous_sha": target_sha_before})
            rec["verdict"] = decision.get("verdict")

        result["workstreams"].append(rec)

    result["summary"] = {
        "planned": len(workstreams),
        "gated": sum(1 for w in result["workstreams"] if isinstance(w.get("gate"), dict) and "decision" in w["gate"]),
        "merged": len(result["merged"]),
    }
    return result


# ---------------------------------------------------------------------------
# Plugin tool handler — never raises, always returns JSON
# ---------------------------------------------------------------------------
def sffs_factory(args: Dict[str, Any], **_kwargs: Any) -> str:
    """The software-factory tool. DRY-RUN by default; the self-improvement engine.

    Args: ``dry_run`` (default True), ``goals`` (list[str]), ``source`` (a prepared
    branch to gate), ``target`` (default hermes-nous), ``execute`` (default False),
    ``offline_review`` (default True), ``max_workstreams`` (default 8).

    A real run (spawn + merge) requires BOTH ``execute=True`` AND ``dry_run=False``
    — otherwise it stays a dry-run (safe). Honors the cost governor + kill-switch.
    """
    try:
        if not isinstance(args, dict):
            return json.dumps({"ok": False, "error": "args must be an object"})
        dry_run = bool(args.get("dry_run", True))
        execute = bool(args.get("execute", False))
        goals = args.get("goals") if isinstance(args.get("goals"), list) else None
        source = args.get("source") if isinstance(args.get("source"), str) and args["source"].strip() else None
        target = args.get("target") if isinstance(args.get("target"), str) and args["target"].strip() else DEFAULT_TARGET
        offline_review = bool(args.get("offline_review", True))
        try:
            max_ws = int(args.get("max_workstreams", DEFAULT_MAX_WORKSTREAMS))
        except (TypeError, ValueError):
            max_ws = DEFAULT_MAX_WORKSTREAMS

        # A real run must be doubly-explicit; otherwise coerce to a safe dry-run.
        real_requested = execute and not dry_run
        res = run_factory(
            goals,
            target=target,
            source=source,
            execute=execute,
            dry_run=dry_run,
            offline_review=offline_review,
            max_workstreams=max_ws,
            kill_file=str(_cg.default_kill_files()[0]) if _cg.default_kill_files() else None,
        )
        res["ok"] = res.get("aborted") is None
        res["real_run"] = real_requested
        if not real_requested:
            res["note"] = ("dry-run: no subagent spawned, no merge performed. A real run needs "
                           "execute=true AND dry_run=false (and passes the two-key gate + cost governor).")
        return json.dumps(res, default=str)
    except Exception as exc:  # noqa: BLE001 — Hermes contract: never raise
        return json.dumps({"ok": False, "error": f"sffs_factory failed: {exc}"})
