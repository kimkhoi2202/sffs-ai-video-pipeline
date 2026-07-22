"""SFFS cost governor + kill-switch — the AGGRESSIVE-BUT-BOUNDED spend brake.

The software factory (``sffs_factory``) is allowed to run MANY parallel subagents
and use Opus generously — but on a SHARED company sandbox that autonomy MUST be
catchable and stoppable. This module is that brake. It is a set of Nous plugin
hooks that:

  * enforce a **kill-switch** — an env var or a stop-file that HALTS the factory
    + the loop instantly (the shared-sandbox emergency brake);
  * enforce a **daily HIGH-but-finite ceiling** on estimated $ / tokens and on
    subagent spawns, HARD-STOPPING new subagent/LLM work when a ceiling is hit;
  * enforce a **concurrent-child ceiling** (defense-in-depth on top of the
    framework's native ``delegation.max_concurrent_children`` cap).

Two separate domains (never conflated — see .ralph/guardrails.md):

  * This governor halts **SPEND** (the factory + the loop + subagent fan-out).
  * It does NOT touch the DRAFT-ONLY posting belt (``publish_guard.py``): posting
    autonomy is frozen at zero regardless of cost. A cheap read/draft/status tool
    stays usable when the ceiling is hit so the agent can still report + a human
    can inspect; only the SPENDY work is stopped.

Kill-switch surface (mirrors dashboard/data.ts + scripts/gate/auto_merge.py so the
supervisor dashboard's indicator, the auto-merge gate, and this runtime brake all
agree on ONE switch):

  * env (truthy ``1``/``true``/``yes``/``on``): ``SFFS_FACTORY_KILL`` or
    ``HERMES_SFFS_FACTORY_KILL``;
  * stop-file present: ``$SFFS_KILL_FILE`` (if set), ``<hermes-nous>/scripts/gate/STOP``,
    ``$HERMES_DATA_DIR/FACTORY_STOP`` (or ``/home/ec2-user/hermes-data/FACTORY_STOP``),
    and ``$HERMES_HOME/sffs-data/FACTORY_STOP``.

HONEST ACCOUNTING NOTE: we run on the ``custom`` (TrueFoundry) provider, whose
usage the framework's ``post_llm_call`` hook does NOT surface (it hands us the
messages, not provider token counts). So the $/token tally is a CONSERVATIVE
ESTIMATE from message text (~4 chars/token, unknown models priced at the Opus
rate so we over- rather than under-count). The EXACT guarantees are the
kill-switch, the concurrent-child cap, and the daily spawn cap; the $/token
ceiling is a best-effort secondary bound. All ceilings are HIGH by default and
env-overridable (see ``load_limits``).

Design: stdlib-only, no intra-package imports (hermetically testable like
draft_guard/publish_guard — see tests/test_cost_governor.py). Every hook swallows
all exceptions and NEVER raises (a raising hook is silently dropped by the
framework, which would disable the brake — so we fail-closed on the kill-switch
and fail-open elsewhere). Usage/spawn events are an APPEND-ONLY JSONL ledger
(concurrency-robust across parallel subagents; a corrupt line is skipped).
"""

from __future__ import annotations

import json
import math
import os
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Optional, Tuple

# hermes-nous/sffs/cost_governor.py -> parents[1] == hermes-nous/
HERMES_NOUS_DIR = Path(__file__).resolve().parents[1]

ENV_KILL_VARS: Tuple[str, ...] = ("SFFS_FACTORY_KILL", "HERMES_SFFS_FACTORY_KILL")
_TRUTHY = frozenset({"1", "true", "yes", "on"})

# How long a child_start with no matching child_stop is counted as "active"
# before it is treated as leaked and dropped (self-heals a crashed subagent).
_CHILD_TTL_SECONDS = 2 * 3600
# Cap the ledger tail we replay so a long-lived profile never reads an unbounded file.
_MAX_LEDGER_TAIL_LINES = 20_000
# Rough chars-per-token for the estimate (English text ~4; conservative for code).
_CHARS_PER_TOKEN = 4.0


# ---------------------------------------------------------------------------
# tiny env helpers (robust to garbage)
# ---------------------------------------------------------------------------
def _is_truthy(v: Any) -> bool:
    return isinstance(v, str) and v.strip().lower() in _TRUTHY


def _env_float(env: Dict[str, str], key: str, default: float) -> float:
    try:
        raw = env.get(key)
        if raw is None or str(raw).strip() == "":
            return default
        val = float(raw)
        return val if math.isfinite(val) and val >= 0 else default
    except (TypeError, ValueError):
        return default


def _env_int(env: Dict[str, str], key: str, default: int) -> int:
    try:
        raw = env.get(key)
        if raw is None or str(raw).strip() == "":
            return default
        val = int(float(raw))
        return val if val >= 0 else default
    except (TypeError, ValueError):
        return default


def _norm(s: Any) -> str:
    """Lowercase + strip non-alphanumerics (matches publish_guard._norm)."""
    if not isinstance(s, str):
        return ""
    return re.sub(r"[^a-z0-9]", "", s.lower())


# ---------------------------------------------------------------------------
# Kill-switch (the emergency brake) — mirrors the dashboard + auto_merge gate
# ---------------------------------------------------------------------------
def default_kill_files(env: Optional[Dict[str, str]] = None) -> List[str]:
    """The stop-file paths that engage the kill-switch when present.

    Mirrors dashboard/config.ts CONFIG.KILL_FILES so the supervisor UI's
    indicator and this brake agree, plus a HERMES_HOME fallback for local use.
    """
    env = env if env is not None else os.environ
    files: List[str] = []
    override = (env.get("SFFS_KILL_FILE") or "").strip()
    if override:
        files.append(override)
    files.append(str(HERMES_NOUS_DIR / "scripts" / "gate" / "STOP"))
    data_dir = (env.get("HERMES_DATA_DIR") or "").strip() or "/home/ec2-user/hermes-data"
    files.append(str(Path(data_dir) / "FACTORY_STOP"))
    hermes_home = (env.get("HERMES_HOME") or "").strip()
    if hermes_home:
        files.append(str(Path(hermes_home) / "sffs-data" / "FACTORY_STOP"))
    # de-dup, preserve order
    seen, out = set(), []
    for f in files:
        if f and f not in seen:
            seen.add(f)
            out.append(f)
    return out


def kill_switch_reason(
    env: Optional[Dict[str, str]] = None,
    files: Optional[Iterable[str]] = None,
    file_exists: Callable[[str], bool] = os.path.exists,
) -> Optional[str]:
    """Return a human-readable reason if the kill-switch is engaged, else None.

    Dead-simple by design (env truthiness OR a present file) so it cannot itself
    error — the fail-closed backstop the whole brake depends on.
    """
    env = env if env is not None else os.environ
    for name in ENV_KILL_VARS:
        if _is_truthy(env.get(name)):
            return f"kill-switch engaged (env {name})"
    for f in (files if files is not None else default_kill_files(env)):
        try:
            if f and file_exists(f):
                return f"kill-switch engaged (stop-file present: {f})"
        except OSError:
            continue
    return None


# ---------------------------------------------------------------------------
# Limits + pricing (AGGRESSIVE-BUT-BOUNDED: HIGH defaults, env-overridable)
# ---------------------------------------------------------------------------
class Limits:
    """The daily/concurrent ceilings. HIGH but finite — a real hard stop."""

    __slots__ = ("max_usd_per_day", "max_tokens_per_day", "max_concurrent_children", "max_spawns_per_day")

    def __init__(
        self,
        max_usd_per_day: float = 75.0,
        max_tokens_per_day: int = 40_000_000,
        max_concurrent_children: int = 8,
        max_spawns_per_day: int = 500,
    ) -> None:
        self.max_usd_per_day = max_usd_per_day
        self.max_tokens_per_day = max_tokens_per_day
        self.max_concurrent_children = max_concurrent_children
        self.max_spawns_per_day = max_spawns_per_day

    def as_dict(self) -> Dict[str, Any]:
        return {
            "max_usd_per_day": self.max_usd_per_day,
            "max_tokens_per_day": self.max_tokens_per_day,
            "max_concurrent_children": self.max_concurrent_children,
            "max_spawns_per_day": self.max_spawns_per_day,
        }


def load_limits(env: Optional[Dict[str, str]] = None) -> Limits:
    """Build :class:`Limits` from env overrides (HIGH-but-finite defaults)."""
    env = env if env is not None else os.environ
    return Limits(
        max_usd_per_day=_env_float(env, "SFFS_COST_MAX_USD_PER_DAY", 75.0),
        max_tokens_per_day=_env_int(env, "SFFS_COST_MAX_TOKENS_PER_DAY", 40_000_000),
        max_concurrent_children=_env_int(env, "SFFS_MAX_CONCURRENT_CHILDREN", 8),
        max_spawns_per_day=_env_int(env, "SFFS_MAX_SUBAGENT_SPAWNS_PER_DAY", 500),
    )


# per-1M-token (input, output) USD; unknown models priced at the Opus rate so an
# unrecognized model over-counts (fails safe) rather than under-counts.
_PRICE_TABLE: Tuple[Tuple[str, float, float], ...] = (
    ("opus", 15.0, 75.0),
    ("sonnet", 3.0, 15.0),
    ("haiku", 0.80, 4.0),
)
_DEFAULT_PRICE = (15.0, 75.0)


def price_for_model(model: Any, env: Optional[Dict[str, str]] = None) -> Tuple[float, float]:
    """Return (usd_per_mtok_in, usd_per_mtok_out) for a model name.

    A single blended override (``SFFS_COST_PRICE_IN_PER_MTOK`` /
    ``SFFS_COST_PRICE_OUT_PER_MTOK``) wins for ALL models when set.
    """
    env = env if env is not None else os.environ
    ov_in = env.get("SFFS_COST_PRICE_IN_PER_MTOK")
    ov_out = env.get("SFFS_COST_PRICE_OUT_PER_MTOK")
    if ov_in is not None or ov_out is not None:
        return (
            _env_float(env, "SFFS_COST_PRICE_IN_PER_MTOK", _DEFAULT_PRICE[0]),
            _env_float(env, "SFFS_COST_PRICE_OUT_PER_MTOK", _DEFAULT_PRICE[1]),
        )
    nn = _norm(model)
    for key, pin, pout in _PRICE_TABLE:
        if key in nn:
            return (pin, pout)
    return _DEFAULT_PRICE


def estimate_tokens(text: Any) -> int:
    """Conservative token estimate from text length (~4 chars/token, rounded up)."""
    if not isinstance(text, str) or not text:
        return 0
    return int(math.ceil(len(text) / _CHARS_PER_TOKEN))


def estimate_cost_usd(input_tokens: int, output_tokens: int, model: Any = "",
                      env: Optional[Dict[str, str]] = None) -> float:
    pin, pout = price_for_model(model, env)
    return (max(0, input_tokens) / 1_000_000.0) * pin + (max(0, output_tokens) / 1_000_000.0) * pout


# ---------------------------------------------------------------------------
# Persistent, append-only usage ledger (concurrency-robust)
# ---------------------------------------------------------------------------
def state_dir(env: Optional[Dict[str, str]] = None) -> Optional[Path]:
    """Resolve (and best-effort create) the governor's state dir, or None."""
    env = env if env is not None else os.environ
    candidates: List[str] = []
    override = (env.get("SFFS_COST_GOVERNOR_DIR") or "").strip()
    if override:
        candidates.append(override)
    data_dir = (env.get("HERMES_DATA_DIR") or "").strip()
    if data_dir:
        candidates.append(str(Path(data_dir) / "cost-governor"))
    hermes_home = (env.get("HERMES_HOME") or "").strip()
    if hermes_home:
        candidates.append(str(Path(hermes_home) / "sffs-data" / "cost-governor"))
    for c in candidates:
        try:
            p = Path(c)
            p.mkdir(parents=True, exist_ok=True)
            return p
        except OSError:
            continue
    return None


def _today(now: Optional[datetime] = None) -> str:
    now = now or datetime.now(timezone.utc)
    return now.strftime("%Y-%m-%d")


def _append_jsonl(path: Path, entry: Dict[str, Any]) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(entry, default=str) + "\n")
    except OSError:
        pass  # accounting must never crash the agent


def _read_jsonl_tail(path: Path, max_lines: int = _MAX_LEDGER_TAIL_LINES) -> List[Dict[str, Any]]:
    if not path.exists():
        return []
    try:
        with open(path, "r", encoding="utf-8") as fh:
            lines = fh.readlines()
    except OSError:
        return []
    out: List[Dict[str, Any]] = []
    for line in lines[-max_lines:]:
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except (ValueError, TypeError):
            continue  # skip a torn/corrupt line
        if isinstance(obj, dict):
            out.append(obj)
    return out


def _usage_ledger(sdir: Path, day: str) -> Path:
    return sdir / f"usage-{day}.jsonl"


def _children_ledger(sdir: Path) -> Path:
    return sdir / "children.jsonl"


def record_llm_usage(
    input_tokens: int,
    output_tokens: int,
    model: Any = "",
    *,
    env: Optional[Dict[str, str]] = None,
    now: Optional[datetime] = None,
    sdir: Optional[Path] = None,
) -> None:
    env = env if env is not None else os.environ
    sdir = sdir if sdir is not None else state_dir(env)
    if sdir is None:
        return
    usd = estimate_cost_usd(input_tokens, output_tokens, model, env)
    _append_jsonl(_usage_ledger(sdir, _today(now)), {
        "ts": time.time(),
        "kind": "llm",
        "model": str(model or ""),
        "input_tokens": int(max(0, input_tokens)),
        "output_tokens": int(max(0, output_tokens)),
        "usd": round(usd, 6),
    })


def record_spawn(
    count: int = 1,
    *,
    env: Optional[Dict[str, str]] = None,
    now: Optional[datetime] = None,
    sdir: Optional[Path] = None,
) -> None:
    env = env if env is not None else os.environ
    sdir = sdir if sdir is not None else state_dir(env)
    if sdir is None:
        return
    _append_jsonl(_usage_ledger(sdir, _today(now)), {
        "ts": time.time(), "kind": "spawn", "count": int(max(0, count)),
    })


def read_tally(
    *,
    env: Optional[Dict[str, str]] = None,
    now: Optional[datetime] = None,
    sdir: Optional[Path] = None,
) -> Dict[str, Any]:
    """Sum today's usage ledger → {usd, tokens, input_tokens, output_tokens, llm_calls, spawns}."""
    env = env if env is not None else os.environ
    sdir = sdir if sdir is not None else state_dir(env)
    tally = {"usd": 0.0, "tokens": 0, "input_tokens": 0, "output_tokens": 0, "llm_calls": 0, "spawns": 0}
    if sdir is None:
        return tally
    for e in _read_jsonl_tail(_usage_ledger(sdir, _today(now))):
        kind = e.get("kind")
        if kind == "llm":
            it = int(e.get("input_tokens") or 0)
            ot = int(e.get("output_tokens") or 0)
            tally["input_tokens"] += it
            tally["output_tokens"] += ot
            tally["tokens"] += it + ot
            tally["usd"] += float(e.get("usd") or 0.0)
            tally["llm_calls"] += 1
        elif kind == "spawn":
            tally["spawns"] += int(e.get("count") or 0)
    tally["usd"] = round(tally["usd"], 6)
    return tally


# --- concurrency (defense-in-depth over the framework's native semaphore) ---
def note_child_start(child_id: Any, *, env: Optional[Dict[str, str]] = None,
                     now: Optional[float] = None, sdir: Optional[Path] = None) -> None:
    env = env if env is not None else os.environ
    sdir = sdir if sdir is not None else state_dir(env)
    if sdir is None or not str(child_id or "").strip():
        return
    _append_jsonl(_children_ledger(sdir), {
        "ts": now if now is not None else time.time(), "kind": "child_start", "child_id": str(child_id),
    })


def note_child_stop(child_id: Any, *, env: Optional[Dict[str, str]] = None,
                    now: Optional[float] = None, sdir: Optional[Path] = None) -> None:
    env = env if env is not None else os.environ
    sdir = sdir if sdir is not None else state_dir(env)
    if sdir is None or not str(child_id or "").strip():
        return
    _append_jsonl(_children_ledger(sdir), {
        "ts": now if now is not None else time.time(), "kind": "child_stop", "child_id": str(child_id),
    })


def active_child_count(*, env: Optional[Dict[str, str]] = None, now: Optional[float] = None,
                       sdir: Optional[Path] = None) -> int:
    """Number of children started-but-not-stopped within the TTL (self-heals leaks)."""
    env = env if env is not None else os.environ
    sdir = sdir if sdir is not None else state_dir(env)
    if sdir is None:
        return 0
    now = now if now is not None else time.time()
    started: Dict[str, float] = {}
    stopped: set = set()
    for e in _read_jsonl_tail(_children_ledger(sdir)):
        cid = str(e.get("child_id") or "")
        if not cid:
            continue
        if e.get("kind") == "child_start":
            started[cid] = float(e.get("ts") or now)
        elif e.get("kind") == "child_stop":
            stopped.add(cid)
    active = 0
    for cid, ts in started.items():
        if cid in stopped:
            continue
        if (now - ts) > _CHILD_TTL_SECONDS:
            continue  # leaked/stale — do not count
        active += 1
    return active


# ---------------------------------------------------------------------------
# Tool-name classification
# ---------------------------------------------------------------------------
# Tools that START new subagent/LLM work — gated by BOTH kill-switch AND ceiling.
_INITIATOR_MARKERS: Tuple[str, ...] = ("delegatetask", "delegate", "sffscycle", "sffsfactory")
# Additionally halted by the kill-switch: the heaviest SPEND legs, so a lone
# in-flight subagent can't keep burning compute after the brake is pulled.
_KILL_EXTRA_MARKERS: Tuple[str, ...] = ("sffsrender", "sffsscorerollup")
_DELEGATE_MARKERS: Tuple[str, ...] = ("delegatetask", "delegate")


def _matches(tool_name: Any, markers: Tuple[str, ...]) -> bool:
    nn = _norm(tool_name)
    return bool(nn) and any(m in nn for m in markers)


def is_initiator(tool_name: Any) -> bool:
    return _matches(tool_name, _INITIATOR_MARKERS)


def is_kill_blocked(tool_name: Any) -> bool:
    return _matches(tool_name, _INITIATOR_MARKERS + _KILL_EXTRA_MARKERS)


def is_delegate(tool_name: Any) -> bool:
    return _matches(tool_name, _DELEGATE_MARKERS)


# ---------------------------------------------------------------------------
# Pure decisions
# ---------------------------------------------------------------------------
def ceiling_reason(tally: Dict[str, Any], limits: Limits) -> Optional[str]:
    """Return a reason if a daily ceiling is already met/exceeded, else None."""
    if limits.max_usd_per_day and tally.get("usd", 0.0) >= limits.max_usd_per_day:
        return (f"daily spend ceiling reached (~${tally['usd']:.2f} of "
                f"${limits.max_usd_per_day:.2f} estimated)")
    if limits.max_tokens_per_day and tally.get("tokens", 0) >= limits.max_tokens_per_day:
        return (f"daily token ceiling reached (~{tally['tokens']:,} of "
                f"{limits.max_tokens_per_day:,} estimated)")
    if limits.max_spawns_per_day and tally.get("spawns", 0) >= limits.max_spawns_per_day:
        return (f"daily subagent-spawn ceiling reached ({tally['spawns']} of "
                f"{limits.max_spawns_per_day})")
    return None


def concurrency_reason(active: int, limits: Limits) -> Optional[str]:
    if limits.max_concurrent_children and active >= limits.max_concurrent_children:
        return (f"concurrent-child ceiling reached ({active} of "
                f"{limits.max_concurrent_children} active)")
    return None


def _block(reason: str) -> Dict[str, str]:
    """The framework pre_tool_call block directive (message is required)."""
    return {
        "action": "block",
        "message": (
            f"REFUSED by the SFFS cost governor: {reason}. New subagent/LLM/render "
            f"work is halted (aggressive-but-bounded cost stance on a shared sandbox). "
            f"This halts SPEND only — it does NOT affect the DRAFT-ONLY posting belt. "
            f"To resume: clear the kill-switch (env SFFS_FACTORY_KILL / stop-file) or "
            f"wait for the daily ceiling to roll over (or raise SFFS_COST_MAX_* limits)."
        ),
    }


def evaluate(
    tool_name: str,
    *,
    env: Optional[Dict[str, str]] = None,
    now: Optional[datetime] = None,
    sdir: Optional[Path] = None,
) -> Optional[Dict[str, str]]:
    """Pure-ish decision for a tool call: a block directive, or None to allow.

    Order: kill-switch (broad spend set) → daily ceiling (initiators) →
    concurrency (delegate only). Non-spendy tools are always allowed here (the
    DRAFT-ONLY belt is a separate hook).
    """
    env = env if env is not None else os.environ
    kr = kill_switch_reason(env)
    if kr and is_kill_blocked(tool_name):
        return _block(kr)
    if is_initiator(tool_name):
        sdir = sdir if sdir is not None else state_dir(env)
        limits = load_limits(env)
        cr = ceiling_reason(read_tally(env=env, now=now, sdir=sdir), limits)
        if cr:
            return _block(cr)
        if is_delegate(tool_name):
            conc = concurrency_reason(active_child_count(env=env, sdir=sdir), limits)
            if conc:
                return _block(conc)
    return None


def status(*, env: Optional[Dict[str, str]] = None, now: Optional[datetime] = None) -> Dict[str, Any]:
    """A machine-readable snapshot (for the factory pre-flight + a status view)."""
    env = env if env is not None else os.environ
    limits = load_limits(env)
    tally = read_tally(env=env, now=now)
    kr = kill_switch_reason(env)
    return {
        "kill_switch": {"engaged": kr is not None, "reason": kr},
        "limits": limits.as_dict(),
        "today": tally,
        "active_children": active_child_count(env=env),
        "ceiling_reason": ceiling_reason(tally, limits),
        "state_dir": str(state_dir(env) or ""),
    }


# ---------------------------------------------------------------------------
# Nous plugin hooks (registered in sffs/__init__.py) — never raise
# ---------------------------------------------------------------------------
def pre_tool_call(tool_name: str = "", args: Any = None, **_kwargs: Any) -> Optional[Dict[str, str]]:
    """Hard-stop hook: block spendy tool calls when killed or over a ceiling.

    Returns ``{"action":"block","message":...}`` to veto, or ``None`` to allow.
    Fail-closed on the kill-switch (a crash still blocks the spend set if the
    switch is engaged); fail-open otherwise (never wedge an unrelated tool).
    """
    try:
        return evaluate(tool_name or "")
    except Exception:
        try:
            if kill_switch_reason() and is_kill_blocked(tool_name or ""):
                return _block("cost governor errored while the kill-switch was engaged (failing closed)")
        except Exception:
            pass
        return None


def pre_llm_call(**kwargs: Any) -> Optional[Dict[str, str]]:
    """Advisory context injection (pre_llm_call cannot block — it injects text).

    When the kill-switch is engaged or the daily ceiling is hit, nudge the model
    to stop starting new work. The HARD stop is :func:`pre_tool_call`; this is a
    cooperative belt so the top agent winds down promptly.
    """
    try:
        env = os.environ
        kr = kill_switch_reason(env)
        cr = None if kr else ceiling_reason(read_tally(env=env), load_limits(env))
        msg = kr or cr
        if msg:
            return {"context": (
                f"[SFFS COST GOVERNOR] {msg}. Do NOT start new subagents, cycles, or "
                f"renders; wind down and report. (Spend brake only — DRAFT-ONLY posting "
                f"is unaffected.)"
            )}
    except Exception:
        pass
    return None


def post_llm_call(**kwargs: Any) -> None:
    """Record an ESTIMATED usage event after each turn (best-effort, never raises)."""
    try:
        model = kwargs.get("model") or ""
        # Marginal input ≈ the last user message; output ≈ the assistant response.
        history = kwargs.get("conversation_history") or []
        last_user = ""
        if isinstance(history, list):
            for msg in reversed(history):
                if isinstance(msg, dict) and msg.get("role") == "user":
                    content = msg.get("content")
                    last_user = content if isinstance(content, str) else json.dumps(content, default=str)
                    break
        if not last_user:
            last_user = kwargs.get("user_message") if isinstance(kwargs.get("user_message"), str) else ""
        response = kwargs.get("assistant_response")
        response = response if isinstance(response, str) else ""
        record_llm_usage(estimate_tokens(last_user), estimate_tokens(response), model)
    except Exception:
        pass


def subagent_start(**kwargs: Any) -> None:
    """Count a spawned child (concurrency + daily spawn tally). Never raises."""
    try:
        cid = kwargs.get("child_session_id") or kwargs.get("child_subagent_id") or ""
        note_child_start(cid)
        record_spawn(1)
    except Exception:
        pass


def subagent_stop(**kwargs: Any) -> None:
    """Mark a child stopped (frees a concurrency slot). Never raises."""
    try:
        cid = kwargs.get("child_session_id") or kwargs.get("child_subagent_id") or ""
        note_child_stop(cid)
    except Exception:
        pass
