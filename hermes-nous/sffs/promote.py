"""SFFS DEFAULT-PROMOTION engine — the CONTENT analog of the code factory's gate.

The loop A/B-tests every content axis against the current DEFAULT (the "control":
full narration + cliffhanger). This module is the READ-SIDE of that A/B memory: it
detects when a TEST ARM clearly beats the current default, and turns that into a
governed PROPOSAL a HUMAN must approve before any default flips.

The pipeline is deliberately split from the code factory's two-key auto-merge gate
(scripts/gate/*, which merges CODE on GREEN-tests AND review-agent-APPROVE). THIS
gate governs CONTENT defaults and is HUMAN-ONLY — there is NO auto-apply path:

  detect (loop/agent, read-only)  ->  propose (queue)  ->  HUMAN approve/reject (CLI)
                                                             |
                                                             +-> approve: flip the
                                                                 config default + log
                                                             +-> reject: log, keep the
                                                                 arm testing

WHAT COUNTS AS A CLEAR WIN (all config-driven in ab-testing/content-defaults.json
`promotion`, with the fallbacks below):
  * metric               = median_eng_rate (percent; the campaign's primary metric)
  * min_sample           = 5  posts-with-metrics on BOTH the challenger AND control
  * min_abs_improvement  = 1.0 percentage points of eng_rate over control
  * min_rel_improvement  = 0.20 (>= 20% better than control)
Requiring BOTH an absolute AND a relative margin (on top of a min-sample gate) is
what keeps us from promoting on noise.

GUARDRAILS: this module NEVER posts/publishes/schedules anything. It only reads
ab-testing/learnings.json (the durable rollups) + content-defaults.json, and writes
ab-testing/proposals.json (the queue) plus — ONLY on a human approval — the
content-defaults.json default + an append-only decisions log. It is stdlib-only and
free of intra-package imports so the hermetic test suite imports it directly
(mirrors design.py / reads.py).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple


class PromoteError(ValueError):
    """Raised for a malformed promotion request/argument (converted to a result)."""


# ---------------------------------------------------------------------------
# Canonical arm universe + fallback policy (mirror hermes/src/defaults.ts).
# The arm LABELS here are exactly the keys score.ts writes to
# learnings.json rollups.by_variant_arm, so detection lines up with rendering.
# ---------------------------------------------------------------------------
PROMOTABLE_DIMENSIONS: Dict[str, List[str]] = {
    "narration": ["full", "no-narration", "no-question-vo", "no-options-vo"],
    "ending": ["cliffhanger", "full-reveal", "no-answer"],
}

FALLBACK_DEFAULTS: Dict[str, str] = {"narration": "full", "ending": "cliffhanger"}

FALLBACK_POLICY: Dict[str, Any] = {
    "metric": "median_eng_rate",
    "min_sample": 5,
    "min_abs_improvement_pp": 1.0,
    "min_rel_improvement": 0.20,
    "incumbent_label": "control",
}

_ID_ALLOWED_ACTIONS = ("list", "detect", "refresh", "show", "status")


# ---------------------------------------------------------------------------
# Paths (mirror score_rollup.py / design.py repo resolution; test-overridable)
# ---------------------------------------------------------------------------
def _repo_dir() -> Path:
    override = os.environ.get("HERMES_SFFS_REPO_DIR")
    if override:
        return Path(override).resolve()
    return Path(__file__).resolve().parents[2]


def default_paths() -> Dict[str, Path]:
    ab = _repo_dir() / "ab-testing"
    return {
        "content_defaults": ab / "content-defaults.json",
        "learnings": ab / "learnings.json",
        "proposals": ab / "proposals.json",
    }


# ---------------------------------------------------------------------------
# Small JSON helpers (atomic write like state.ts writeJSONAtomic)
# ---------------------------------------------------------------------------
def _read_json(path: Path, fallback: Any) -> Any:
    try:
        if not Path(path).exists():
            return fallback
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return fallback


def _write_json_atomic(path: Path, obj: Any) -> None:
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(p.suffix + f".tmp-{os.getpid()}")
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(obj, fh, indent=2)
        fh.write("\n")
    os.replace(tmp, p)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _today() -> str:
    return datetime.now(timezone.utc).date().isoformat()


# ---------------------------------------------------------------------------
# Config resolution (config-driven policy + current defaults)
# ---------------------------------------------------------------------------
def load_defaults(content_defaults_path: Path) -> Dict[str, str]:
    """Resolve the current content defaults (arm labels), with safe fallbacks."""
    raw = _read_json(content_defaults_path, {}) or {}
    d = raw.get("defaults") if isinstance(raw, dict) else None
    d = d if isinstance(d, dict) else {}
    out = dict(FALLBACK_DEFAULTS)
    for dim in PROMOTABLE_DIMENSIONS:
        val = d.get(dim)
        if isinstance(val, str) and val in PROMOTABLE_DIMENSIONS[dim]:
            out[dim] = val
    return out


def load_policy(content_defaults_path: Path) -> Dict[str, Any]:
    """Resolve the promotion policy (config-driven), merged over the fallbacks."""
    raw = _read_json(content_defaults_path, {}) or {}
    p = raw.get("promotion") if isinstance(raw, dict) else None
    p = p if isinstance(p, dict) else {}
    policy = dict(FALLBACK_POLICY)
    if isinstance(p.get("metric"), str) and p["metric"].strip():
        policy["metric"] = p["metric"].strip()
    if isinstance(p.get("incumbent_label"), str) and p["incumbent_label"].strip():
        policy["incumbent_label"] = p["incumbent_label"].strip()
    for k in ("min_sample",):
        v = p.get(k)
        if isinstance(v, int) and not isinstance(v, bool) and v >= 1:
            policy[k] = v
    for k in ("min_abs_improvement_pp", "min_rel_improvement"):
        v = p.get(k)
        if isinstance(v, (int, float)) and not isinstance(v, bool) and v >= 0:
            policy[k] = float(v)
    return policy


# ---------------------------------------------------------------------------
# The detector (PURE: rollups + defaults + policy -> proposals). No I/O.
# ---------------------------------------------------------------------------
def _cell(rollups_by_arm: Dict[str, Any], label: str) -> Optional[Dict[str, Any]]:
    c = rollups_by_arm.get(label)
    return c if isinstance(c, dict) else None


def _metric_of(cell: Optional[Dict[str, Any]], metric: str) -> Optional[float]:
    if not cell:
        return None
    v = cell.get(metric)
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def _n_of(cell: Optional[Dict[str, Any]]) -> int:
    if not cell:
        return 0
    v = cell.get("n_with_metrics")
    return int(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else 0


def _confidence(n_min: int, rel: float, policy: Dict[str, Any]) -> str:
    strong_n = n_min >= 2 * int(policy["min_sample"])
    strong_rel = rel >= 2 * float(policy["min_rel_improvement"])
    return "high" if (strong_n and strong_rel) else "medium"


def _evaluate_arm(
    dimension: str,
    arm: str,
    incumbent_label: str,
    inc_cell: Optional[Dict[str, Any]],
    chal_cell: Optional[Dict[str, Any]],
    policy: Dict[str, Any],
) -> Optional[Dict[str, Any]]:
    """Return a candidate dict if `arm` clearly beats the incumbent, else None."""
    metric = str(policy["metric"])
    min_sample = int(policy["min_sample"])
    min_abs = float(policy["min_abs_improvement_pp"])
    min_rel = float(policy["min_rel_improvement"])

    n_chal, n_inc = _n_of(chal_cell), _n_of(inc_cell)
    m_chal, m_inc = _metric_of(chal_cell, metric), _metric_of(inc_cell, metric)

    # MIN-SAMPLE GATE: never promote on noise — need enough matured metrics on BOTH.
    if n_chal < min_sample or n_inc < min_sample:
        return None
    if m_chal is None or m_inc is None:
        return None

    abs_delta = round(m_chal - m_inc, 4)
    if m_inc > 0:
        rel_delta = round(abs_delta / m_inc, 4)
    else:
        # incumbent at/below zero: only a positive absolute move can "beat" it.
        rel_delta = float("inf") if abs_delta > 0 else 0.0

    if abs_delta < min_abs or rel_delta < min_rel:
        return None

    n_min = min(n_chal, n_inc)
    return {
        "dimension": dimension,
        "arm": arm,
        "incumbent_label": incumbent_label,
        "metric": metric,
        "challenger": {"arm": arm, metric: m_chal, "n_with_metrics": n_chal},
        "incumbent": {"arm": incumbent_label, metric: m_inc, "n_with_metrics": n_inc},
        "delta_abs_pp": abs_delta,
        "delta_rel": (rel_delta if rel_delta != float("inf") else None),
        "min_sample": min_sample,
        "confidence": _confidence(n_min, (rel_delta if rel_delta != float("inf") else min_rel * 2), policy),
    }


def detect_candidates(
    learnings: Dict[str, Any],
    defaults: Dict[str, str],
    policy: Dict[str, Any],
) -> List[Dict[str, Any]]:
    """PURE detector: one BEST candidate per promotable dimension (or none).

    For each dimension, compare every arm != current-default against the incumbent
    ('control') on the configured metric; keep those that clear BOTH the absolute
    and relative thresholds with >= min_sample on each side; return the single
    strongest challenger per dimension (highest metric).
    """
    rollups = (learnings or {}).get("rollups") if isinstance(learnings, dict) else {}
    rollups = rollups if isinstance(rollups, dict) else {}
    by_arm = rollups.get("by_variant_arm")
    by_arm = by_arm if isinstance(by_arm, dict) else {}
    metric = str(policy["metric"])
    incumbent_label = str(policy["incumbent_label"])
    inc_cell = _cell(by_arm, incumbent_label)

    out: List[Dict[str, Any]] = []
    for dimension, arms in PROMOTABLE_DIMENSIONS.items():
        current_default = defaults.get(dimension, FALLBACK_DEFAULTS[dimension])
        best: Optional[Dict[str, Any]] = None
        best_metric = -float("inf")
        for arm in arms:
            if arm == current_default:
                continue  # this arm IS the current default (== control); nothing to test
            cand = _evaluate_arm(dimension, arm, incumbent_label, inc_cell, _cell(by_arm, arm), policy)
            if cand is None:
                continue
            m = float(cand["challenger"][metric])
            if m > best_metric:
                best, best_metric = cand, m
        if best is not None:
            best["current_default"] = current_default
            best["recommended_default"] = best["arm"]
            best["id"] = f"promote-{dimension}-{best['arm']}"
            out.append(best)
    return out


def _proposal_from_candidate(cand: Dict[str, Any], now: str) -> Dict[str, Any]:
    metric = cand["metric"]
    rel = cand.get("delta_rel")
    rel_txt = "∞" if rel is None else f"{rel * 100:.1f}%"
    rationale = (
        f"Test arm '{cand['arm']}' beat the current default '{cand['current_default']}' "
        f"(incumbent '{cand['incumbent_label']}') on {metric}: "
        f"{cand['challenger'][metric]}% vs {cand['incumbent'][metric]}% "
        f"(+{cand['delta_abs_pp']}pp, +{rel_txt}), "
        f"n={cand['challenger']['n_with_metrics']}/{cand['incumbent']['n_with_metrics']} "
        f">= min_sample {cand['min_sample']}. Recommend flipping the {cand['dimension']} "
        f"default to '{cand['recommended_default']}'. HUMAN APPROVAL REQUIRED."
    )
    return {
        "id": cand["id"],
        "dimension": cand["dimension"],
        "current_default": cand["current_default"],
        "recommended_default": cand["recommended_default"],
        "incumbent_label": cand["incumbent_label"],
        "metric": metric,
        "challenger": cand["challenger"],
        "incumbent": cand["incumbent"],
        "delta_abs_pp": cand["delta_abs_pp"],
        "delta_rel": cand["delta_rel"],
        "min_sample": cand["min_sample"],
        "confidence": cand["confidence"],
        "status": "pending",
        "detected_at": now,
        "updated_at": now,
        "rationale": rationale,
    }


# ---------------------------------------------------------------------------
# Queue I/O + refresh (the read-side detection that PERSISTS to proposals.json)
# ---------------------------------------------------------------------------
def _empty_queue() -> Dict[str, Any]:
    return {
        "schema_version": 1,
        "updated_at": _now_iso(),
        "campaign": "Smart Fella or Fart Smella",
        "proposals": [],
        "decisions_log": [],
    }


def load_queue(proposals_path: Path) -> Dict[str, Any]:
    q = _read_json(proposals_path, None)
    if not isinstance(q, dict):
        q = _empty_queue()
    q.setdefault("proposals", [])
    q.setdefault("decisions_log", [])
    if not isinstance(q["proposals"], list):
        q["proposals"] = []
    if not isinstance(q["decisions_log"], list):
        q["decisions_log"] = []
    return q


def _index_by_id(proposals: List[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    return {p["id"]: p for p in proposals if isinstance(p, dict) and p.get("id")}


def refresh_proposals(
    *,
    paths: Optional[Dict[str, Path]] = None,
    now: Optional[str] = None,
    reopen_rejected: bool = False,
) -> Dict[str, Any]:
    """Detect current winners and UPSERT them into the durable queue.

    - New winners are added as `pending`.
    - Existing `pending` proposals for a still-winning arm are refreshed (metrics/
      confidence/updated_at) in place.
    - `pending` proposals whose arm no longer clears the bar are `expired` (logged).
    - `rejected` proposals are left rejected (the arm keeps testing) unless
      `reopen_rejected=True`, so we don't nag a human with the same evidence.
    - `approved` ids never recur (the arm becomes the default, so it stops being a
      challenger in detect_candidates).
    NEVER flips a default. Returns a summary. This is the read-side of the A/B memory.
    """
    paths = paths or default_paths()
    now = now or _now_iso()
    defaults = load_defaults(paths["content_defaults"])
    policy = load_policy(paths["content_defaults"])
    learnings = _read_json(paths["learnings"], {}) or {}
    queue = load_queue(paths["proposals"])

    candidates = detect_candidates(learnings, defaults, policy)
    cand_by_id = {c["id"]: c for c in candidates}
    existing = _index_by_id(queue["proposals"])

    added, refreshed, expired = [], [], []

    # Upsert winners.
    for cand in candidates:
        pid = cand["id"]
        prior = existing.get(pid)
        fresh = _proposal_from_candidate(cand, now)
        if prior is None:
            queue["proposals"].append(fresh)
            added.append(pid)
        elif prior.get("status") == "pending":
            prior.update(
                {
                    "current_default": fresh["current_default"],
                    "recommended_default": fresh["recommended_default"],
                    "challenger": fresh["challenger"],
                    "incumbent": fresh["incumbent"],
                    "delta_abs_pp": fresh["delta_abs_pp"],
                    "delta_rel": fresh["delta_rel"],
                    "confidence": fresh["confidence"],
                    "rationale": fresh["rationale"],
                    "updated_at": now,
                }
            )
            refreshed.append(pid)
        elif prior.get("status") == "rejected" and reopen_rejected:
            prior.update(fresh)  # human explicitly asked to reconsider
            prior["status"] = "pending"
            prior["reopened_at"] = now
            added.append(pid)
        # approved/rejected(without reopen): leave as-is.

    # Expire pending proposals that are no longer winning.
    for p in queue["proposals"]:
        if p.get("status") == "pending" and p.get("id") not in cand_by_id:
            p["status"] = "expired"
            p["updated_at"] = now
            expired.append(p.get("id"))
            queue["decisions_log"].append(
                {
                    "date": _today(),
                    "ts": now,
                    "action": "auto-expire",
                    "id": p.get("id"),
                    "dimension": p.get("dimension"),
                    "note": "challenger no longer clears the promotion threshold; proposal expired (default unchanged)",
                }
            )

    queue["updated_at"] = now
    _write_json_atomic(paths["proposals"], queue)

    pending = [p for p in queue["proposals"] if p.get("status") == "pending"]
    return {
        "ok": True,
        "detected": len(candidates),
        "added": added,
        "refreshed": refreshed,
        "expired": expired,
        "pending": pending,
        "pending_count": len(pending),
        "defaults": defaults,
        "policy": policy,
    }


def list_proposals(
    *,
    paths: Optional[Dict[str, Path]] = None,
    status: Optional[str] = None,
) -> List[Dict[str, Any]]:
    paths = paths or default_paths()
    queue = load_queue(paths["proposals"])
    props = queue["proposals"]
    if status:
        props = [p for p in props if p.get("status") == status]
    return props


def get_proposal(pid: str, *, paths: Optional[Dict[str, Path]] = None) -> Optional[Dict[str, Any]]:
    paths = paths or default_paths()
    return _index_by_id(load_queue(paths["proposals"])["proposals"]).get(pid)


# ---------------------------------------------------------------------------
# HUMAN-ONLY decisions: approve (flip the default + log) / reject (log, keep testing)
# ---------------------------------------------------------------------------
def _append_learnings_decision(learnings_path: Path, entry: Dict[str, Any], now: str) -> None:
    """Append a one-line decision to learnings.json decisions_log (dashboard surface)."""
    learnings = _read_json(learnings_path, None)
    if not isinstance(learnings, dict):
        return  # no learnings file yet; nothing to annotate
    log = learnings.get("decisions_log")
    if not isinstance(log, list):
        log = []
    log.append(entry)
    learnings["decisions_log"] = log
    learnings["updated_at"] = now
    _write_json_atomic(learnings_path, learnings)


def approve(
    pid: str,
    *,
    actor: str = "human",
    paths: Optional[Dict[str, Path]] = None,
    now: Optional[str] = None,
) -> Dict[str, Any]:
    """HUMAN approval: flip the content-defaults default for the proposal's dimension,
    record the change (content-defaults.json history + proposals + learnings logs).
    Refuses anything but a `pending` proposal. NEVER touches posting."""
    paths = paths or default_paths()
    now = now or _now_iso()
    queue = load_queue(paths["proposals"])
    prop = _index_by_id(queue["proposals"]).get(pid)
    if prop is None:
        raise PromoteError(f"no proposal with id '{pid}'")
    if prop.get("status") != "pending":
        raise PromoteError(f"proposal '{pid}' is '{prop.get('status')}', not 'pending' — cannot approve")

    dimension = prop["dimension"]
    new_arm = prop["recommended_default"]
    if dimension not in PROMOTABLE_DIMENSIONS or new_arm not in PROMOTABLE_DIMENSIONS[dimension]:
        raise PromoteError(f"proposal '{pid}' targets unknown dimension/arm ({dimension}/{new_arm})")

    # 1) flip the config default (the ONLY writer of content-defaults.json defaults).
    cd = _read_json(paths["content_defaults"], None)
    if not isinstance(cd, dict):
        cd = {"schema_version": 1, "defaults": dict(FALLBACK_DEFAULTS)}
    cd.setdefault("defaults", {})
    prev = cd["defaults"].get(dimension, prop.get("current_default"))
    cd["defaults"][dimension] = new_arm
    cd["updated_at"] = now
    history = cd.get("history")
    if not isinstance(history, list):
        history = []
    history_entry = {
        "date": _today(),
        "ts": now,
        "dimension": dimension,
        "from": prev,
        "to": new_arm,
        "proposal_id": pid,
        "approved_by": actor,
        "metric": prop.get("metric"),
        "delta_abs_pp": prop.get("delta_abs_pp"),
        "delta_rel": prop.get("delta_rel"),
        "challenger": prop.get("challenger"),
        "incumbent": prop.get("incumbent"),
    }
    history.append(history_entry)
    cd["history"] = history
    _write_json_atomic(paths["content_defaults"], cd)

    # 2) mark the proposal approved + append to the queue decisions_log.
    prop["status"] = "approved"
    prop["decided_at"] = now
    prop["decided_by"] = actor
    prop["applied_change"] = {"dimension": dimension, "from": prev, "to": new_arm}
    prop["updated_at"] = now
    queue["decisions_log"].append(
        {
            "date": _today(),
            "ts": now,
            "action": "approve",
            "id": pid,
            "dimension": dimension,
            "from": prev,
            "to": new_arm,
            "approved_by": actor,
            "metric": prop.get("metric"),
            "delta_abs_pp": prop.get("delta_abs_pp"),
            "delta_rel": prop.get("delta_rel"),
            "rationale": prop.get("rationale"),
        }
    )
    queue["updated_at"] = now
    _write_json_atomic(paths["proposals"], queue)

    # 3) surface it in learnings.json decisions_log (dashboard Decisions list).
    _append_learnings_decision(
        paths["learnings"],
        {
            "date": _today(),
            "decision": (
                f"DEFAULT PROMOTED: {dimension} '{prev}' -> '{new_arm}' "
                f"(+{prop.get('delta_abs_pp')}pp {prop.get('metric')} vs control; "
                f"n={prop.get('challenger', {}).get('n_with_metrics')})."
            ),
            "rationale": prop.get("rationale"),
            "status": "human-approved",
            "approved_by": actor,
            "proposal_id": pid,
        },
        now,
    )

    return {
        "ok": True,
        "action": "approve",
        "id": pid,
        "dimension": dimension,
        "from": prev,
        "to": new_arm,
        "approved_by": actor,
        "note": f"content default '{dimension}' flipped to '{new_arm}'; takes effect on the next design pass",
    }


def reject(
    pid: str,
    *,
    reason: str = "",
    actor: str = "human",
    paths: Optional[Dict[str, Path]] = None,
    now: Optional[str] = None,
) -> Dict[str, Any]:
    """HUMAN rejection: log it + KEEP the arm testing (default unchanged). Refuses
    anything but a `pending` proposal."""
    paths = paths or default_paths()
    now = now or _now_iso()
    queue = load_queue(paths["proposals"])
    prop = _index_by_id(queue["proposals"]).get(pid)
    if prop is None:
        raise PromoteError(f"no proposal with id '{pid}'")
    if prop.get("status") != "pending":
        raise PromoteError(f"proposal '{pid}' is '{prop.get('status')}', not 'pending' — cannot reject")

    prop["status"] = "rejected"
    prop["decided_at"] = now
    prop["decided_by"] = actor
    prop["reject_reason"] = reason
    prop["updated_at"] = now
    queue["decisions_log"].append(
        {
            "date": _today(),
            "ts": now,
            "action": "reject",
            "id": pid,
            "dimension": prop.get("dimension"),
            "recommended_default": prop.get("recommended_default"),
            "rejected_by": actor,
            "reason": reason,
        }
    )
    queue["updated_at"] = now
    _write_json_atomic(paths["proposals"], queue)

    _append_learnings_decision(
        paths["learnings"],
        {
            "date": _today(),
            "decision": (
                f"Default-promotion REJECTED for {prop.get('dimension')} -> "
                f"'{prop.get('recommended_default')}' (default kept; arm keeps testing)."
            ),
            "rationale": reason or "human rejected the proposed default change",
            "status": "human-rejected",
            "rejected_by": actor,
            "proposal_id": pid,
        },
        now,
    )

    return {
        "ok": True,
        "action": "reject",
        "id": pid,
        "dimension": prop.get("dimension"),
        "reason": reason,
        "note": "default unchanged; the arm keeps testing (can be re-proposed if it keeps winning)",
    }


# ---------------------------------------------------------------------------
# Pure arg-guard + Hermes tool handler (AGENT-facing = DETECT/LIST/SHOW ONLY).
# The autonomous agent must NEVER approve/reject — that is a human CLI action.
# ---------------------------------------------------------------------------
def build_promote_request(args: Dict[str, Any]) -> Dict[str, Any]:
    """Validate + normalize an ``sffs_promote`` request. Pure.

    Allowed actions are READ/DETECT ONLY: list | detect | refresh | show | status.
    approve/reject are DELIBERATELY rejected here — they are HUMAN actions via the
    sffs_promote_default CLI, never an autonomous tool call (the CONTENT gate).
    """
    if not isinstance(args, dict):
        raise PromoteError("args must be a JSON object")
    action = args.get("action", "list")
    if not isinstance(action, str):
        raise PromoteError("'action' must be a string")
    action = action.strip().lower()
    if action in ("approve", "reject"):
        raise PromoteError(
            "approve/reject is a HUMAN action — run `sffs_promote_default --approve <id>` "
            "(or --reject <id>) in a shell. The autonomous agent may only detect/list/show proposals."
        )
    if action not in _ID_ALLOWED_ACTIONS:
        raise PromoteError(f"'action' must be one of {', '.join(_ID_ALLOWED_ACTIONS)}")

    out: Dict[str, Any] = {"action": "refresh" if action == "detect" else action}
    if action == "show":
        pid = args.get("id")
        if not isinstance(pid, str) or not pid.strip():
            raise PromoteError("'show' requires a non-empty string 'id'")
        out["id"] = pid.strip()
    status = args.get("status")
    if status is not None:
        if not isinstance(status, str) or not status.strip():
            raise PromoteError("'status' must be a non-empty string")
        out["status"] = status.strip()
    return out


def sffs_promote(args: Dict[str, Any], **kwargs: Any) -> str:
    """Hermes tool handler: DETECT/LIST/SHOW default-promotion proposals (read-side).

    Actions: ``list`` (default) | ``detect``/``refresh`` (re-scan learnings + persist
    fresh proposals) | ``show`` (one proposal by id) | ``status`` (defaults + counts).
    approve/reject are NOT available here — they are a human CLI action. Always
    returns a JSON string; never raises.
    """
    a = args if isinstance(args, dict) else {}
    try:
        req = build_promote_request(a)
    except PromoteError as exc:
        return json.dumps({"ok": False, "error": str(exc)})
    except Exception as exc:
        return json.dumps({"ok": False, "error": f"invalid args: {exc}"})

    try:
        action = req["action"]
        if action == "refresh":
            return json.dumps(refresh_proposals())
        if action == "list":
            props = list_proposals(status=req.get("status"))
            return json.dumps({"ok": True, "action": "list", "count": len(props), "proposals": props})
        if action == "show":
            prop = get_proposal(req["id"])
            if prop is None:
                return json.dumps({"ok": False, "error": f"no proposal with id '{req['id']}'"})
            return json.dumps({"ok": True, "action": "show", "proposal": prop})
        if action == "status":
            paths = default_paths()
            defaults = load_defaults(paths["content_defaults"])
            policy = load_policy(paths["content_defaults"])
            props = load_queue(paths["proposals"])["proposals"]
            counts: Dict[str, int] = {}
            for p in props:
                counts[p.get("status", "?")] = counts.get(p.get("status", "?"), 0) + 1
            return json.dumps(
                {"ok": True, "action": "status", "defaults": defaults, "policy": policy, "counts": counts}
            )
        return json.dumps({"ok": False, "error": f"unhandled action '{action}'"})
    except Exception as exc:
        return json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"})


# ---------------------------------------------------------------------------
# Human CLI: `sffs_promote_default --approve <id>` / `--reject <id>` / --list / --detect
# ---------------------------------------------------------------------------
def _print(obj: Any) -> None:
    print(json.dumps(obj, indent=2))


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="sffs_promote_default",
        description="HUMAN gate for CONTENT default promotions (approve/reject a proposed default change).",
    )
    # Convenience flag form (matches the documented `--approve <id>` UX)...
    p.add_argument("--approve", metavar="ID", help="approve proposal ID: flip the config default + log it")
    p.add_argument("--reject", metavar="ID", help="reject proposal ID: log it, keep the arm testing")
    p.add_argument("--list", action="store_true", help="list proposals")
    p.add_argument("--detect", "--refresh", dest="detect", action="store_true", help="re-scan + persist proposals")
    p.add_argument("--show", metavar="ID", help="show one proposal by id")
    p.add_argument("--status", metavar="STATUS", help="filter --list by status (pending|approved|rejected|expired)")
    p.add_argument("--reason", default="", help="reason for --reject")
    p.add_argument("--actor", default=os.environ.get("USER", "human"), help="who is deciding (for the log)")
    # ...and a positional subcommand form: approve <id> / reject <id> / list / detect / show <id>
    p.add_argument("cmd", nargs="?", choices=["approve", "reject", "list", "detect", "refresh", "show"], help=argparse.SUPPRESS)
    p.add_argument("cmd_id", nargs="?", help=argparse.SUPPRESS)
    return p


def main(argv: Optional[List[str]] = None) -> int:
    args = _build_parser().parse_args(argv)

    # Resolve the intended action from either the flag form or the subcommand form.
    action: Optional[str] = None
    pid: Optional[str] = None
    if args.approve:
        action, pid = "approve", args.approve
    elif args.reject:
        action, pid = "reject", args.reject
    elif args.show:
        action, pid = "show", args.show
    elif args.list:
        action = "list"
    elif args.detect:
        action = "detect"
    elif args.cmd:
        action = args.cmd
        pid = args.cmd_id

    try:
        if action in ("detect", "refresh"):
            _print(refresh_proposals())
            return 0
        if action == "list":
            _print({"ok": True, "proposals": list_proposals(status=args.status)})
            return 0
        if action == "show":
            if not pid:
                print("show requires an id", file=sys.stderr)
                return 3
            prop = get_proposal(pid)
            _print(prop or {"ok": False, "error": f"no proposal with id '{pid}'"})
            return 0 if prop else 1
        if action == "approve":
            if not pid:
                print("approve requires an id", file=sys.stderr)
                return 3
            _print(approve(pid, actor=args.actor))
            return 0
        if action == "reject":
            if not pid:
                print("reject requires an id", file=sys.stderr)
                return 3
            _print(reject(pid, reason=args.reason, actor=args.actor))
            return 0
    except PromoteError as exc:
        print(json.dumps({"ok": False, "error": str(exc)}))
        return 1

    # Nothing chosen -> show pending proposals (safe default).
    _print({"ok": True, "pending": list_proposals(status="pending")})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
