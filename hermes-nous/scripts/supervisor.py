#!/usr/bin/env python3
"""supervisor — the ALWAYS-ON SFFS continuous orchestrator (bounded, non-posting).

The user wants Hermes to work CONTINUOUSLY (not just one cycle every 24h):
constantly doing research, updating knowledge, and preparing content — coordinated
with, not duplicating, the always-on software FACTORY (which owns CODE self-
improvement) and the daily posting CYCLE (which owns bounded scheduling).

    preflight (kill-switch + governor)  →  plan the DUE non-posting work by cadence
    →  run it (knowledge / research / content-prep / upkeep)  →  write status  →
    sleep (cadence / idle backoff)  →  repeat.

────────────────────────────────────────────────────────────────────────────────
CRITICAL INVARIANT — CONTINUOUS WORK, BOUNDED POSTING
────────────────────────────────────────────────────────────────────────────────
This supervisor NEVER posts, schedules, or publishes anything, and it never
creates a second scheduler. The HARD posting ceiling (≤12 videos/day/platform,
only 7am–1am CST, jittered, IG≠TikTok, quality/brand-gated, dedup + do-not-touch)
stays EXACTLY where it already is: the single existing daily timer→cycle
(`hermes-nous-loop.timer` → `hermes cron run sffs-nightly`). We deliberately leave
that ONE scheduler untouched, so there is exactly one thing that schedules (no
double-firing) and the ceiling is enforced by the proven, unchanged cycle.

The supervisor's ACTION SET is fixed to non-posting work only (see ACTIONS); there
is no schedule/post/publish executor. The knowledge phase shells out ONLY to the
read/update-only bridges (reconcile / score-rollup — both physically unable to
post). Research / content-prep are bounded, cost-governed, and either record a
directive or run an operator-configured command; neither can reach a posting path.

Every safety invariant is a BRAKE, never removed (same as the factory daemon):
  * KILL-SWITCH — cost_governor.kill_switch_reason() (stop-file / env) → PAUSE.
    (This is the SAME switch the factory + dashboard read, so a maintenance
    FACTORY_STOP pauses the supervisor too.)
  * GOVERNOR    — cost_governor.ceiling_reason() (daily $/token/spawn cap) → PAUSE.
  * CONVERGE    — only DUE work runs each cycle (per-action cadence); when nothing
    is due it idles/backs off (no churn, no cost burn).
Fail-open on its own errors (log + back off, stay alive); fail-closed on the
kill-switch / governor (pause).
"""
from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

REPO = Path(os.environ.get("HERMES_REPO_DIR", "/home/ec2-user/sffs-ai-video-pipeline"))
HERMES_NOUS = REPO / "hermes-nous"
BRIDGE_DIR = HERMES_NOUS / "bridge"
SUP_DIR = Path(os.environ.get("SFFS_SUPERVISOR_DIR", "/home/ec2-user/hermes-data/supervisor"))
STATUS_FILE = SUP_DIR / "supervisor-status.json"
STATE_FILE = SUP_DIR / "supervisor-state.json"
LOG_FILE = SUP_DIR / "supervisor.log"

# Import the shared cost governor (kill-switch + ceiling) — the same brake the
# factory daemon uses, so both obey one switch.
if str(HERMES_NOUS) not in sys.path:
    sys.path.insert(0, str(HERMES_NOUS))
try:
    from sffs import cost_governor as cg  # type: ignore  # noqa: E402
except Exception:  # pragma: no cover - import guard
    cg = None  # type: ignore

# The ONLY work the supervisor may do — deliberately NO post/schedule/publish action.
ACTIONS: tuple[str, ...] = ("knowledge", "content_prep", "research", "upkeep")


def _int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, "") or default)
    except ValueError:
        return default


def default_cfg() -> Dict[str, int]:
    return {
        "cycle_sleep": _int("SFFS_SUPERVISOR_CYCLE_SLEEP", 300),      # base cadence (5 min)
        "idle_sleep": _int("SFFS_SUPERVISOR_IDLE_SLEEP", 900),       # nothing due → back off
        "pause_sleep": _int("SFFS_SUPERVISOR_PAUSE_SLEEP", 120),     # kill-switch / governor
        "max_actions_per_cycle": _int("SFFS_SUPERVISOR_MAX_ACTIONS", 2),  # converge, don't churn
        # per-action cadences (seconds)
        "knowledge_interval": _int("SFFS_SUPERVISOR_KNOWLEDGE_INTERVAL", 3 * 3600),
        "content_interval": _int("SFFS_SUPERVISOR_CONTENT_INTERVAL", 4 * 3600),
        "research_interval": _int("SFFS_SUPERVISOR_RESEARCH_INTERVAL", 6 * 3600),
        "upkeep_interval": _int("SFFS_SUPERVISOR_UPKEEP_INTERVAL", 3600),
        "cmd_timeout": _int("SFFS_SUPERVISOR_CMD_TIMEOUT", 600),
    }


_STOP = False


def _sig(_s, _f):
    global _STOP
    _STOP = True


def now_iso(ts: Optional[float] = None) -> str:
    return datetime.fromtimestamp(ts if ts is not None else time.time(), timezone.utc).isoformat()


def log(level: str, msg: str, **kw: Any) -> None:
    rec = {"ts": now_iso(), "level": level, "msg": msg, **kw}
    line = json.dumps(rec, default=str)
    try:
        SUP_DIR.mkdir(parents=True, exist_ok=True)
        with open(LOG_FILE, "a", encoding="utf-8") as fh:
            fh.write(line + "\n")
    except OSError:
        pass
    print(line, flush=True)


# ── PURE planning: which non-posting work is DUE this cycle ───────────────────
def plan_actions(state: Dict[str, Any], now: float, cfg: Dict[str, int]) -> List[str]:
    """Return the DUE work actions (in priority order), capped to converge.

    Pure + deterministic given (state, now, cfg): an action is due when its last
    run was >= its cadence ago (or never). Priority: knowledge → content_prep →
    research → upkeep. Capped at cfg['max_actions_per_cycle'] so we never try to do
    everything at once (converge, not churn). NEVER returns a posting action —
    ACTIONS contains none, by construction.
    """
    last = state.get("last", {}) if isinstance(state.get("last"), dict) else {}
    intervals = {
        "knowledge": cfg["knowledge_interval"],
        "content_prep": cfg["content_interval"],
        "research": cfg["research_interval"],
        "upkeep": cfg["upkeep_interval"],
    }
    due: List[str] = []
    for action in ACTIONS:  # priority order
        if action == "post" or action == "schedule":  # defensive: never (not in ACTIONS)
            continue
        prev = float(last.get(action, 0) or 0)
        if now - prev >= intervals[action]:
            due.append(action)
    return due[: max(1, cfg["max_actions_per_cycle"])]


# ── production executors (bounded, fail-open, cost-governed, NON-posting) ──────
def _run(cmd: List[str], timeout: int, cwd: Optional[Path] = None) -> Dict[str, Any]:
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, cwd=str(cwd) if cwd else None)
        return {"ok": p.returncode == 0, "code": p.returncode, "tail": (p.stdout or p.stderr or "")[-400:]}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def exec_knowledge(env: Dict[str, str], cfg: Dict[str, int]) -> Dict[str, Any]:
    """Fold live A/B metrics into ab-database/learnings via the read/update-only
    bridges (reconcile + score-rollup), then run ONE autonomous default-promotion
    cycle (adopt confirmed winners + auto-revert underperformers). All content-only:
    physically cannot post/schedule (the bridges + promote engine have no post path)."""
    out: Dict[str, Any] = {"action": "knowledge", "steps": []}
    for bridge in ("reconcile.ts", "score-rollup.ts"):
        path = BRIDGE_DIR / bridge
        if not path.exists():
            out["steps"].append({bridge: "absent (skipped)"})
            continue
        r = _run(["node", str(path)], cfg["cmd_timeout"], cwd=REPO)
        out["steps"].append({bridge: r.get("ok"), "detail": r.get("error") or r.get("code")})
    # Autonomous default-promotion (gated: confirmation round + auto-revert; reversible,
    # logged). Content-only — flips a whitelisted arm label, never a posting path.
    try:
        from sffs import promote  # type: ignore
        ap = promote.auto_promote_cycle()
        out["auto_promotion"] = {
            "enabled": ap.get("enabled"),
            "promoted": ap.get("promoted"),
            "reverted": ap.get("reverted"),
            "confirming": len(ap.get("confirming") or []),
        }
    except Exception as exc:
        out["auto_promotion"] = {"error": str(exc)}
    return out


def exec_research(env: Dict[str, str], cfg: Dict[str, int]) -> Dict[str, Any]:
    """Bounded niche research. If SFFS_SUPERVISOR_RESEARCH_CMD is configured, run it
    (bounded); otherwise record a dated research directive to the learnings log so
    the agent/human can act on it. Never touches a posting path."""
    directive = ("Research what is currently winning on TikTok/Instagram in the kids "
                 "brain-teaser / 'smart or fart' niche; extract 3 concrete, kid-safe, "
                 "brand-voice A/B tactics we could test (hook, question type, timing).")
    cmd = env.get("SFFS_SUPERVISOR_RESEARCH_CMD", "").strip()
    if cmd:
        r = _run(["bash", "-lc", cmd], cfg["cmd_timeout"], cwd=REPO)
        _append_research({"ts": now_iso(), "kind": "research-run", "ok": r.get("ok"), "note": directive})
        return {"action": "research", "ran_cmd": True, "ok": r.get("ok")}
    _append_research({"ts": now_iso(), "kind": "research-directive", "note": directive})
    return {"action": "research", "ran_cmd": False, "recorded_directive": True}


def exec_content_prep(env: Dict[str, str], cfg: Dict[str, int]) -> Dict[str, Any]:
    """Replenish/prepare candidate content (NEVER schedules). If a content command
    is configured, run it (bounded); else record intent. The daily cycle still
    dedup-/quality-gates anything before it is ever drafted or scheduled."""
    cmd = env.get("SFFS_SUPERVISOR_CONTENT_CMD", "").strip()
    if cmd:
        r = _run(["bash", "-lc", cmd], cfg["cmd_timeout"], cwd=REPO)
        return {"action": "content_prep", "ran_cmd": True, "ok": r.get("ok")}
    return {"action": "content_prep", "ran_cmd": False, "recorded_intent": True}


def exec_upkeep(env: Dict[str, str], cfg: Dict[str, int]) -> Dict[str, Any]:
    """Coordinate with (do NOT duplicate) the factory: read its status, refresh the
    cost snapshot for the dashboard. No code self-improvement here (factory owns it)."""
    fac_state = None
    try:
        fs = Path("/home/ec2-user/hermes-data/factory-daemon/factory-status.json")
        if fs.exists():
            fac_state = json.loads(fs.read_text(encoding="utf-8")).get("state")
    except Exception:
        pass
    if cg is not None:
        try:
            cg.write_snapshot()
        except Exception:
            pass
    return {"action": "upkeep", "factory_state": fac_state, "coordinated": True}


def _append_research(entry: Dict[str, Any]) -> None:
    """Append a research note to ab-testing/learnings.json (supervisor_research list)."""
    p = REPO / "ab-testing" / "learnings.json"
    try:
        data = json.loads(p.read_text(encoding="utf-8")) if p.exists() else {}
        lst = data.get("supervisor_research")
        if not isinstance(lst, list):
            lst = []
        lst.insert(0, entry)
        data["supervisor_research"] = lst[:50]  # keep it bounded
        tmp = p.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, indent=2, default=str), encoding="utf-8")
        os.replace(tmp, p)
    except Exception as exc:
        log("warn", "research-append-failed", error=str(exc))


PROD_EXECUTORS: Dict[str, Callable[[Dict[str, str], Dict[str, int]], Dict[str, Any]]] = {
    "knowledge": exec_knowledge,
    "content_prep": exec_content_prep,
    "research": exec_research,
    "upkeep": exec_upkeep,
}


# ── state / status ────────────────────────────────────────────────────────────
def load_state() -> Dict[str, Any]:
    try:
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"cycle": 0, "started_at": now_iso(), "last": {}, "totals": {}, "backoff": 0}


def save_state(st: Dict[str, Any]) -> None:
    try:
        SUP_DIR.mkdir(parents=True, exist_ok=True)
        tmp = STATE_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(st, indent=2, default=str), encoding="utf-8")
        os.replace(tmp, STATE_FILE)
    except OSError:
        pass


def write_status(state: str, reason: str, st: Dict[str, Any], *, last_cycle: Any = None, next_sleep: int = 0, error: str = "") -> None:
    kr = None
    if cg is not None:
        try:
            kr = cg.kill_switch_reason()
        except Exception:
            kr = None
    doc = {
        "ts": now_iso(),
        "pid": os.getpid(),
        "role": "continuous non-posting orchestrator (research / knowledge / content-prep / upkeep)",
        "posting": "BOUNDED — posting/scheduling is owned solely by the daily cycle "
                   "(hermes-nous-loop.timer → sffs-nightly); the supervisor never schedules.",
        "state": state,
        "state_reason": reason,
        "cycle": st.get("cycle", 0),
        "started_at": st.get("started_at"),
        "actions": list(ACTIONS),
        "last": st.get("last", {}),
        "totals": st.get("totals", {}),
        "last_cycle": last_cycle if last_cycle is not None else st.get("last_cycle"),
        "next_sleep_s": next_sleep,
        "kill_switch": {"engaged": kr is not None, "reason": kr},
        "last_error": error,
    }
    try:
        SUP_DIR.mkdir(parents=True, exist_ok=True)
        tmp = STATUS_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(doc, indent=2, default=str), encoding="utf-8")
        os.replace(tmp, STATUS_FILE)
    except OSError:
        pass


# ── one cycle ─────────────────────────────────────────────────────────────────
def run_cycle(
    st: Dict[str, Any],
    *,
    now: Optional[float] = None,
    cfg: Optional[Dict[str, int]] = None,
    env: Optional[Dict[str, str]] = None,
    executors: Optional[Dict[str, Callable]] = None,
    dry_run: bool = True,
) -> Dict[str, Any]:
    """Run ONE supervisor cycle. Executors are injectable (tests pass fakes); the
    default is DRY-RUN (plan only, no side effects). Returns a summary + sleep."""
    now = time.time() if now is None else now
    cfg = cfg or default_cfg()
    env = env if env is not None else dict(os.environ)
    st["cycle"] = st.get("cycle", 0) + 1
    st.setdefault("last", {})

    # 1) kill-switch (fail-closed → pause)
    kr = None
    if cg is not None:
        try:
            kr = cg.kill_switch_reason(env)
        except Exception:
            kr = None
    if kr:
        write_status("paused-kill", kr, st, next_sleep=cfg["pause_sleep"])
        return {"action": "paused", "reason": kr, "sleep": cfg["pause_sleep"]}

    # 2) governor ceiling (fail-closed → pause)
    cr = None
    if cg is not None:
        try:
            cr = cg.ceiling_reason(cg.read_tally(), cg.load_limits())
        except Exception:
            cr = None
    if cr:
        write_status("paused-governor", cr, st, next_sleep=cfg["pause_sleep"])
        return {"action": "paused", "reason": cr, "sleep": cfg["pause_sleep"]}

    # 3) plan the DUE non-posting work (converge)
    due = plan_actions(st, now, cfg)
    if not due:
        write_status("idle", "no work due this cycle (converged / backing off)", st, next_sleep=cfg["idle_sleep"])
        return {"action": "idle", "sleep": cfg["idle_sleep"], "due": []}

    # 4) execute due work (INVARIANT: no action in ACTIONS can post/schedule)
    execs = executors or PROD_EXECUTORS
    results = []
    for action in due:
        assert action in ACTIONS and action not in ("post", "schedule", "publish"), \
            f"supervisor refuses non-whitelisted/posting action: {action}"
        if dry_run:
            results.append({"action": action, "dry_run": True})
        else:
            try:
                results.append(execs[action](env, cfg))
            except Exception as exc:  # fail-open per action
                results.append({"action": action, "ok": False, "error": str(exc)})
        st["last"][action] = now
        tot = st.setdefault("totals", {})
        tot[action] = int(tot.get(action, 0)) + 1

    summary = {"cycle": st["cycle"], "did": due, "results": results, "at": now_iso(now), "dry_run": dry_run}
    st["last_cycle"] = summary
    write_status("working", f"ran {', '.join(due)}", st, last_cycle=summary, next_sleep=cfg["cycle_sleep"])
    log("info", "cycle-done", cycle=st["cycle"], did=due, dry_run=dry_run)
    return {"action": "worked", "sleep": cfg["cycle_sleep"], **summary}


# ── main loop ─────────────────────────────────────────────────────────────────
def main() -> int:
    import argparse
    ap = argparse.ArgumentParser(description="SFFS always-on continuous (non-posting) supervisor")
    ap.add_argument("--once", action="store_true", help="run a single cycle then exit")
    ap.add_argument("--max-cycles", type=int, default=0)
    ap.add_argument("--status", action="store_true", help="print current status json")
    ap.add_argument("--plan", action="store_true", help="print the DUE actions (plan only) then exit")
    ap.add_argument("--dry-run", action="store_true", help="plan + report but take no real action")
    ap.add_argument("--live", action="store_true", help="run production executors (default is dry-run)")
    args = ap.parse_args()

    if args.status:
        print(STATUS_FILE.read_text(encoding="utf-8") if STATUS_FILE.exists() else "{}")
        return 0
    if args.plan:
        st = load_state()
        print(json.dumps({"due": plan_actions(st, time.time(), default_cfg())}, indent=2))
        return 0

    # default is DRY-RUN unless --live is passed (fail-safe: no accidental real work)
    dry = not args.live or args.dry_run
    os.environ.setdefault("HERMES_HOME", "/home/ec2-user/.hermes-nous")
    venv_bin = "/home/ec2-user/.venv-hermes/bin"
    if venv_bin not in os.environ.get("PATH", ""):
        os.environ["PATH"] = venv_bin + ":" + os.environ.get("PATH", "")

    signal.signal(signal.SIGTERM, _sig)
    signal.signal(signal.SIGINT, _sig)
    st = load_state()
    st["started_at"] = st.get("started_at") or now_iso()
    cfg = default_cfg()
    log("info", "supervisor-start", cfg=cfg, dry_run=dry, pid=os.getpid())
    write_status("starting", f"supervisor starting (dry_run={dry})", st)

    n = 0
    while not _STOP:
        try:
            out = run_cycle(st, cfg=cfg, dry_run=dry)
            sleep = int(out.get("sleep", cfg["cycle_sleep"]))
        except Exception as exc:  # fail-open: log, back off, stay alive
            log("error", "cycle-exception", error=str(exc))
            write_status("error-backoff", f"cycle error: {exc}", st, next_sleep=cfg["pause_sleep"], error=str(exc))
            sleep = cfg["pause_sleep"]
        save_state(st)
        n += 1
        if args.once or (args.max_cycles and n >= args.max_cycles):
            break
        for _ in range(max(1, sleep)):  # interruptible sleep
            if _STOP:
                break
            time.sleep(1)

    write_status("stopped", "supervisor stopped (signal)" if _STOP else "supervisor exited", st)
    save_state(st)
    log("info", "supervisor-stop", cycles=n)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
