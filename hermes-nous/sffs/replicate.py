"""SFFS WINNER-REPLICATION engine — double down on a REACH outlier.

The promotion engine (promote.py) governs sticky DEFAULTS and judges arms on
median_eng_rate. It structurally CANNOT see the signal this module exists for: a
post whose *reach* blew past the pack while its engagement rate looked ordinary.
Reach outliers are how a 500K-view goal is actually reached — cadence alone never
gets there — so they need their own detector, their own memory, and their own way
of spending the next batch.

    detect (reach outlier vs a rolling per-platform median)
        -> fingerprint its STYLE
        -> replicate it in the next batches, holding the style CONSTANT and varying
           only SECONDARY knobs (hashtags / tempo / time-of-day) so a confirmed win
           is attributable to the style and not to the noise around it
        -> evaluate_escalation once the replicas mature (~24h)
             +-> replicas held up  -> escalate the share one step
             +-> replicas collapsed -> revert, and log it as a FLUKE

WHY NORMALISE BY PLATFORM: TikTok and Instagram live on different scales here
(median views 301 vs 135 on the current corpus). Comparing raw views would let
TikTok win every time, so every post is scored as a RATIO to its own platform's
rolling median, which makes an IG outlier and a TikTok outlier directly comparable.

HARD LIMITS (all config-driven in ab-testing/content-defaults.json `replication`):
  * winner_share_cap = 0.5 — replication can never take more than half a batch.
    This is an EXPLORATION FLOOR, not a nicety: the day we stop sampling new styles
    is the day the engine can only rediscover what it already believes.
  * Every state change is appended to a reversible ledger (ab-testing/
    replication.json) and `--revert` unwinds to plain exploration at any time.

GUARDRAILS: this module NEVER posts, publishes, schedules, or mutates a post. It
reads ab-database.json + content-defaults.json and writes ONLY replication.json.
It cannot change the posting window, the per-platform daily cap, the same-platform
gap, dedup, or any quality gate — it only expresses a PREFERENCE about which styles
the designer should spend its slots on. Stdlib-only and free of intra-package
imports so the hermetic test suite imports it directly (mirrors promote.py).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple


class ReplicateError(ValueError):
    """Raised for a malformed replication request/argument."""


SCHEMA_VERSION = 1

# ---------------------------------------------------------------------------
# Fallback policy. Every value is overridable from content-defaults.json
# `replication`; these are the shipped defaults.
# ---------------------------------------------------------------------------
FALLBACK_POLICY: Dict[str, Any] = {
    "enabled": True,
    # Which metric carries the reach signal, in preference order per post.
    "metric": "video_views",
    "metric_fallback": "reach",
    # A POST must beat its platform's rolling median by this ratio to be an outlier.
    "min_ratio_vs_median": 2.0,
    # ...and the style's posts overall must not be net losers, so a style that is
    # mostly duds with one lucky hit cannot qualify on that hit alone.
    "min_style_median_ratio": 1.0,
    # ...and clear an absolute floor, so a tiny/soft median can't mint a fake winner.
    "min_absolute": 300,
    # The rolling baseline needs this many matured posts on the platform to be trusted.
    "min_baseline_samples": 5,
    # How many matured posts a fingerprint needs before it can be detected at all.
    "min_winner_samples": 1,
    # ...and how many before the detection is called "high" confidence.
    "high_confidence_samples": 2,
    # EXPLORATION FLOOR: replication may never exceed this share of a batch.
    "winner_share_cap": 0.5,
    # Share of the batch the first (unconfirmed) replication round gets.
    "initial_share": 0.25,
    # How much the share grows per successful escalation round.
    "escalation_step": 0.125,
    # Replicas need this long to accrue believable metrics before being judged.
    "maturity_hours": 24,
    # ...and this many matured replicas.
    "confirm_min_samples": 2,
    # Replicas must still clear this ratio-to-median for the win to be confirmed.
    "confirm_min_ratio": 1.5,
    # At or below this ratio the original was a fluke -> revert to exploration.
    "revert_ratio": 1.0,
}

# The STYLE axes a replication holds CONSTANT. Everything not listed here is a
# secondary knob the replicas are free (and expected) to vary, which is what makes
# a confirmed win attributable to the style rather than to its surroundings.
STYLE_AXES: Tuple[str, ...] = ("lead_type", "num_questions", "family", "narration", "ending")

# Secondary knobs the replicas deliberately vary (documented for the designer side;
# hashtags + tempo are varied in design.ts, time-of-day falls out of the scheduler's
# jitter). Listed here so the ledger records the intent alongside the fingerprint.
SECONDARY_KNOBS: Tuple[str, ...] = ("hashtag_set", "tempo", "time_of_day")


# ---------------------------------------------------------------------------
# Paths (mirror promote.py resolution; test-overridable)
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
        "ab_database": ab / "ab-database.json",
        "replication": ab / "replication.json",
    }


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


def _parse_iso(s: Any) -> Optional[datetime]:
    if not isinstance(s, str) or not s.strip():
        return None
    try:
        return datetime.fromisoformat(s.strip().replace("Z", "+00:00"))
    except Exception:
        return None


def _num(v: Any) -> Optional[float]:
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    return float(v)


def _median(values: List[float]) -> Optional[float]:
    vals = sorted(v for v in values if v is not None)
    if not vals:
        return None
    n = len(vals)
    return vals[n // 2] if n % 2 else (vals[n // 2 - 1] + vals[n // 2]) / 2.0


# ---------------------------------------------------------------------------
# Policy
# ---------------------------------------------------------------------------
def load_policy(content_defaults_path: Path) -> Dict[str, Any]:
    """Resolve the replication policy (config-driven), merged over the fallbacks."""
    raw = _read_json(content_defaults_path, {}) or {}
    p = raw.get("replication") if isinstance(raw, dict) else None
    p = p if isinstance(p, dict) else {}
    policy = dict(FALLBACK_POLICY)
    if isinstance(p.get("enabled"), bool):
        policy["enabled"] = p["enabled"]
    for k in ("metric", "metric_fallback"):
        v = p.get(k)
        if isinstance(v, str) and v.strip():
            policy[k] = v.strip()
    for k in ("min_baseline_samples", "min_winner_samples", "high_confidence_samples",
              "confirm_min_samples", "min_absolute", "maturity_hours"):
        v = p.get(k)
        if isinstance(v, (int, float)) and not isinstance(v, bool) and v >= 0:
            policy[k] = int(v)
    for k in ("min_ratio_vs_median", "min_style_median_ratio", "winner_share_cap", "initial_share",
              "escalation_step", "confirm_min_ratio", "revert_ratio"):
        v = p.get(k)
        if isinstance(v, (int, float)) and not isinstance(v, bool) and v >= 0:
            policy[k] = float(v)
    # The cap is a HARD exploration floor: clamp it into (0, 0.5] no matter what
    # config says, so a bad edit can never let replication eat a whole batch.
    policy["winner_share_cap"] = max(0.0, min(0.5, float(policy["winner_share_cap"])))
    policy["initial_share"] = max(0.0, min(policy["winner_share_cap"], float(policy["initial_share"])))
    return policy


# ---------------------------------------------------------------------------
# Reading the corpus (PURE from here down until the ledger section)
# ---------------------------------------------------------------------------
def matured_posts(db: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Posts carrying real metrics — the only ones that can inform a decision."""
    out: List[Dict[str, Any]] = []
    for p in (db or {}).get("posts", []) or []:
        if not isinstance(p, dict):
            continue
        m = p.get("metrics")
        if isinstance(m, dict) and m.get("as_of"):
            out.append(p)
    return out


def reach_of(post: Dict[str, Any], policy: Dict[str, Any]) -> Optional[float]:
    """The post's reach signal: the configured metric, else its fallback."""
    m = post.get("metrics") if isinstance(post.get("metrics"), dict) else {}
    v = _num(m.get(policy["metric"]))
    if v is None:
        v = _num(m.get(policy["metric_fallback"]))
    return v


def platform_baselines(posts: List[Dict[str, Any]], policy: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
    """Rolling per-platform median reach + sample count.

    Per-platform because the platforms are on different scales; a single global
    median would let the bigger platform define "outlier" for both.
    """
    by_plat: Dict[str, List[float]] = {}
    for p in posts:
        plat = str(p.get("platform") or "").strip() or "unknown"
        v = reach_of(p, policy)
        if v is not None:
            by_plat.setdefault(plat, []).append(v)
    out: Dict[str, Dict[str, Any]] = {}
    for plat, vals in by_plat.items():
        out[plat] = {
            "platform": plat,
            "median": _median(vals),
            "n": len(vals),
            "max": max(vals) if vals else None,
            "trusted": len(vals) >= int(policy["min_baseline_samples"]),
        }
    return out


def normalize_tier(t: Any) -> str:
    """Fold a question tier to one comparable token.

    The corpus spans two eras: the original pipeline wrote "odd-one-out" while the
    current loop writes the tier label "ODD ONE OUT". Without folding them, the very
    outliers we are trying to replicate would never match a freshly designed video.
    """
    s = str(t or "").strip().lower()
    for ch in (" ", "_", "/"):
        s = s.replace(ch, "-")
    while "--" in s:
        s = s.replace("--", "-")
    return s.strip("-") or "?"


def style_fingerprint(post: Dict[str, Any]) -> Dict[str, Any]:
    """The style axes a replication holds constant, plus a stable key.

    Deliberately built from what the A/B database ACTUALLY records for every post
    (older rows predate several fields), so an outlier from any era can still be
    fingerprinted. Missing axes normalise to "?" rather than dropping the post.
    """
    variant = post.get("variant") if isinstance(post.get("variant"), dict) else {}
    types = variant.get("question_types")
    types = [normalize_tier(t) for t in types] if isinstance(types, list) else []
    nq = variant.get("num_questions")
    fp = {
        # The LEAD question type is the headline style signal: it is what the viewer
        # meets in the first seconds, and it is what the current n=2 evidence shares.
        "lead_type": (types[0] if types else "?"),
        "question_types": types,
        "num_questions": int(nq) if isinstance(nq, (int, float)) and not isinstance(nq, bool) else 0,
        "family": str(variant.get("family") or "?"),
        "narration": str(variant.get("narration") or "?"),
        "ending": str(variant.get("ending") or "?"),
    }
    fp["key"] = "|".join(str(fp.get(a, "?")) for a in STYLE_AXES)
    return fp


def score_styles(posts: List[Dict[str, Any]], policy: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Group matured posts by style and score each against its platform baseline.

    Every post becomes a RATIO to its own platform's median, so styles are ranked on
    a platform-neutral scale. Returned sorted best-first.
    """
    base = platform_baselines(posts, policy)
    groups: Dict[str, Dict[str, Any]] = {}
    for p in posts:
        v = reach_of(p, policy)
        plat = str(p.get("platform") or "").strip() or "unknown"
        b = base.get(plat) or {}
        med = b.get("median")
        if v is None or not med or med <= 0 or not b.get("trusted"):
            continue
        fp = style_fingerprint(p)
        g = groups.setdefault(fp["key"], {"fingerprint": fp, "samples": [], "ratios": [], "platforms": set()})
        g["samples"].append({
            "key": p.get("_hermes_key") or p.get("source_video") or "?",
            "platform": plat,
            "value": v,
            "platform_median": med,
            "ratio": v / med,
        })
        g["ratios"].append(v / med)
        g["platforms"].add(plat)
    bar = float(policy["min_ratio_vs_median"])
    floor_abs = float(policy["min_absolute"])
    out: List[Dict[str, Any]] = []
    for g in groups.values():
        ratios = g["ratios"]
        # A style is judged on HOW MANY of its posts are outliers, not on the median
        # of all of them: one ordinary post should not be able to veto a style that
        # has genuinely broken out twice. The style-wide median is kept as a separate
        # sanity floor (see min_style_median_ratio) so a mostly-dud style with one
        # lucky hit still cannot qualify.
        outliers = [s for s in g["samples"] if s["ratio"] >= bar and s["value"] >= floor_abs]
        out.append({
            "fingerprint": g["fingerprint"],
            "n": len(ratios),
            "n_outliers": len(outliers),
            "median_ratio": _median(ratios),
            "outlier_median_ratio": _median([s["ratio"] for s in outliers]),
            "best_ratio": max(ratios),
            "best_value": max(s["value"] for s in g["samples"]),
            "platforms": sorted(g["platforms"]),
            "outliers": sorted(outliers, key=lambda s: -s["ratio"]),
            "samples": sorted(g["samples"], key=lambda s: -s["ratio"]),
        })
    out.sort(key=lambda g: (-g["n_outliers"], -(g["outlier_median_ratio"] or 0), -(g["best_ratio"] or 0)))
    return out


def detect_winner(posts: List[Dict[str, Any]], policy: Dict[str, Any]) -> Dict[str, Any]:
    """Find the reach front-runner style, if the evidence clears the policy bar."""
    baselines = platform_baselines(posts, policy)
    styles = score_styles(posts, policy)
    reasons: List[str] = []
    if not policy.get("enabled", True):
        return {"found": False, "reason": "replication disabled in content-defaults.json", "baselines": baselines, "styles": styles}
    if not styles:
        trusted = [b for b in baselines.values() if b.get("trusted")]
        return {
            "found": False,
            "reason": (
                "no platform has a trusted baseline yet "
                f"(need >= {policy['min_baseline_samples']} matured posts on a platform)"
                if not trusted else "no fingerprintable matured posts"
            ),
            "baselines": baselines,
            "styles": styles,
        }
    for cand in styles:
        key = cand["fingerprint"]["key"]
        if cand["n_outliers"] < int(policy["min_winner_samples"]):
            reasons.append(
                f"{key}: {cand['n_outliers']} outlier(s) >= {policy['min_ratio_vs_median']}x, "
                f"need {policy['min_winner_samples']}"
            )
            continue
        if (cand["median_ratio"] or 0) < float(policy["min_style_median_ratio"]):
            reasons.append(
                f"{key}: style median {cand['median_ratio']:.2f}x < {policy['min_style_median_ratio']} "
                "(mostly duds around one hit)"
            )
            continue
        confidence = "high" if cand["n_outliers"] >= int(policy["high_confidence_samples"]) else "medium"
        return {
            "found": True,
            "winner": cand,
            "confidence": confidence,
            "baselines": baselines,
            "styles": styles,
            "reason": (
                f"{key}: {cand['n_outliers']} reach outlier(s) at a median "
                f"{cand['outlier_median_ratio']:.2f}x their platform median "
                f"(best {cand['best_ratio']:.2f}x = {cand['best_value']:.0f})"
            ),
        }
    return {"found": False, "reason": "; ".join(reasons[:4]) or "no style cleared the bar",
            "baselines": baselines, "styles": styles}


# ---------------------------------------------------------------------------
# The reversible ledger (ab-testing/replication.json)
# ---------------------------------------------------------------------------
def _empty_ledger() -> Dict[str, Any]:
    return {
        "schema_version": SCHEMA_VERSION,
        "updated_at": _now_iso(),
        "description": (
            "Reversible ledger for the WINNER-REPLICATION engine (hermes-nous/sffs/replicate.py). "
            "`active` is the style the designer is currently doubling down on and the share of each "
            "batch it may take (never more than replication.winner_share_cap, an exploration floor). "
            "`history` is append-only: every detection, escalation, revert and fluke is recorded so any "
            "state can be explained and undone (`sffs_replicate --revert`). Replication expresses a "
            "PREFERENCE about which styles get batch slots; it cannot touch the posting window, the "
            "per-platform daily cap, the same-platform gap, dedup, or any quality gate."
        ),
        "active": None,
        "history": [],
    }


def load_ledger(*, paths: Optional[Dict[str, Path]] = None) -> Dict[str, Any]:
    paths = paths or default_paths()
    led = _read_json(paths["replication"], None)
    if not isinstance(led, dict) or "history" not in led:
        return _empty_ledger()
    led.setdefault("schema_version", SCHEMA_VERSION)
    led.setdefault("active", None)
    led.setdefault("history", [])
    return led


def save_ledger(led: Dict[str, Any], *, paths: Optional[Dict[str, Path]] = None) -> None:
    paths = paths or default_paths()
    led["updated_at"] = _now_iso()
    _write_json_atomic(paths["replication"], led)


def _log(led: Dict[str, Any], event: str, detail: Dict[str, Any], now: str) -> None:
    entry = {"ts": now, "event": event}
    entry.update(detail)
    led.setdefault("history", []).append(entry)


# ---------------------------------------------------------------------------
# Cycle 1: DETECT — find a reach outlier and start replicating it
# ---------------------------------------------------------------------------
def detect_cycle(*, paths: Optional[Dict[str, Path]] = None, now: Optional[str] = None) -> Dict[str, Any]:
    """Detect a reach front-runner and, if found, open a replication round."""
    paths = paths or default_paths()
    now = now or _now_iso()
    policy = load_policy(paths["content_defaults"])
    db = _read_json(paths["ab_database"], {}) or {}
    posts = matured_posts(db)
    det = detect_winner(posts, policy)
    led = load_ledger(paths=paths)

    if not det["found"]:
        _log(led, "detect_none", {"reason": det["reason"], "matured_posts": len(posts)}, now)
        save_ledger(led, paths=paths)
        return {"action": "none", "reason": det["reason"], "detection": det, "active": led.get("active")}

    winner = det["winner"]
    key = winner["fingerprint"]["key"]
    active = led.get("active")
    if isinstance(active, dict) and active.get("status") in ("active", "escalated") and active.get("key") == key:
        _log(led, "detect_unchanged", {"key": key, "median_ratio": winner["median_ratio"]}, now)
        save_ledger(led, paths=paths)
        return {"action": "unchanged", "reason": "already replicating this style", "detection": det, "active": active}

    share = float(min(policy["initial_share"], policy["winner_share_cap"]))
    new_active = {
        "key": key,
        "fingerprint": winner["fingerprint"],
        "status": "active",
        "confidence": det["confidence"],
        "share": share,
        "share_cap": policy["winner_share_cap"],
        "round": 1,
        "opened_at": now,
        "evaluate_after": (_parse_iso(now) + timedelta(hours=int(policy["maturity_hours"]))).isoformat().replace("+00:00", "Z")
        if _parse_iso(now) else now,
        "vary_only": list(SECONDARY_KNOBS),
        "evidence": {
            "n": winner["n"],
            "n_outliers": winner["n_outliers"],
            "median_ratio": winner["median_ratio"],
            "outlier_median_ratio": winner["outlier_median_ratio"],
            "best_ratio": winner["best_ratio"],
            "best_value": winner["best_value"],
            "platforms": winner["platforms"],
            "samples": winner["outliers"][:6] or winner["samples"][:6],
            "baselines": {k: {"median": v.get("median"), "n": v.get("n")} for k, v in det["baselines"].items()},
        },
        "replicas": [],
    }
    prev_key = active.get("key") if isinstance(active, dict) else None
    led["active"] = new_active
    _log(led, "detect_winner", {
        "key": key, "previous_key": prev_key, "confidence": det["confidence"],
        "share": share, "n_outliers": winner["n_outliers"],
        "outlier_median_ratio": winner["outlier_median_ratio"], "n": winner["n"],
        "reason": det["reason"],
    }, now)
    save_ledger(led, paths=paths)
    return {"action": "opened", "reason": det["reason"], "detection": det, "active": new_active}


# ---------------------------------------------------------------------------
# Cycle 2: EVALUATE — did the replicas hold up? escalate, hold, or call it a fluke
# ---------------------------------------------------------------------------
def _replica_scores(active: Dict[str, Any], posts: List[Dict[str, Any]], policy: Dict[str, Any]) -> Dict[str, Any]:
    """Score the matured posts produced SINCE the round opened for this style."""
    opened = _parse_iso(active.get("opened_at"))
    base = platform_baselines(posts, policy)
    ratios: List[float] = []
    samples: List[Dict[str, Any]] = []
    for p in posts:
        if style_fingerprint(p)["key"] != active.get("key"):
            continue
        m = p.get("metrics") if isinstance(p.get("metrics"), dict) else {}
        as_of = _parse_iso(m.get("as_of"))
        created = _parse_iso(p.get("scheduled_at")) or as_of
        if opened and created and created < opened:
            continue  # a pre-existing post, not a replica of this round
        v = reach_of(p, policy)
        plat = str(p.get("platform") or "").strip() or "unknown"
        med = (base.get(plat) or {}).get("median")
        if v is None or not med or med <= 0:
            continue
        ratios.append(v / med)
        samples.append({"key": p.get("_hermes_key") or "?", "platform": plat, "value": v, "ratio": v / med})
    return {"n": len(ratios), "median_ratio": _median(ratios), "samples": samples}


def evaluate_escalation(*, paths: Optional[Dict[str, Path]] = None, now: Optional[str] = None) -> Dict[str, Any]:
    """Judge an open replication round once its replicas have matured.

    escalate -> the style keeps winning, give it one more step of the batch (never
                past winner_share_cap);
    fluke    -> the replicas fell back to the pack, revert to plain exploration;
    wait     -> not enough matured replicas yet, or the maturity window is still open.
    """
    paths = paths or default_paths()
    now = now or _now_iso()
    policy = load_policy(paths["content_defaults"])
    led = load_ledger(paths=paths)
    active = led.get("active")
    if not isinstance(active, dict) or active.get("status") not in ("active", "escalated"):
        return {"action": "none", "reason": "no open replication round"}

    now_dt = _parse_iso(now)
    due = _parse_iso(active.get("evaluate_after"))
    if now_dt and due and now_dt < due:
        return {"action": "wait", "reason": f"maturity window open until {active.get('evaluate_after')}", "active": active}

    db = _read_json(paths["ab_database"], {}) or {}
    posts = matured_posts(db)
    rep = _replica_scores(active, posts, policy)
    active["replicas"] = rep["samples"][:8]

    if rep["n"] < int(policy["confirm_min_samples"]):
        _log(led, "evaluate_wait", {"key": active.get("key"), "matured_replicas": rep["n"],
                                    "need": int(policy["confirm_min_samples"])}, now)
        save_ledger(led, paths=paths)
        return {"action": "wait", "reason": f"only {rep['n']} matured replica(s); need {policy['confirm_min_samples']}",
                "active": active}

    ratio = rep["median_ratio"] or 0.0
    if ratio <= float(policy["revert_ratio"]):
        active["status"] = "reverted"
        active["closed_at"] = now
        active["outcome"] = "fluke"
        led["active"] = None
        _log(led, "revert_fluke", {"key": active.get("key"), "replica_median_ratio": ratio,
                                   "replica_n": rep["n"], "reason": "replicas fell back to the platform median"}, now)
        led.setdefault("history", []).append({"ts": now, "event": "closed_round", "round": active})
        save_ledger(led, paths=paths)
        return {"action": "reverted", "reason": f"replica ratio {ratio:.2f} <= revert_ratio {policy['revert_ratio']}",
                "replicas": rep}

    if ratio < float(policy["confirm_min_ratio"]):
        active["evaluate_after"] = ((now_dt or datetime.now(timezone.utc)) + timedelta(hours=int(policy["maturity_hours"]))
                                    ).isoformat().replace("+00:00", "Z")
        _log(led, "evaluate_hold", {"key": active.get("key"), "replica_median_ratio": ratio,
                                    "confirm_min_ratio": policy["confirm_min_ratio"]}, now)
        save_ledger(led, paths=paths)
        return {"action": "hold", "reason": f"replica ratio {ratio:.2f} below confirm bar {policy['confirm_min_ratio']}",
                "active": active, "replicas": rep}

    prev_share = float(active.get("share") or 0)
    new_share = min(prev_share + float(policy["escalation_step"]), float(policy["winner_share_cap"]))
    capped = new_share <= prev_share
    active["share"] = new_share
    active["status"] = "escalated"
    active["round"] = int(active.get("round") or 1) + 1
    active["confidence"] = "high"
    active["evaluate_after"] = ((now_dt or datetime.now(timezone.utc)) + timedelta(hours=int(policy["maturity_hours"]))
                                ).isoformat().replace("+00:00", "Z")
    _log(led, "escalate", {"key": active.get("key"), "from_share": prev_share, "to_share": new_share,
                           "at_cap": capped, "replica_median_ratio": ratio, "replica_n": rep["n"]}, now)
    save_ledger(led, paths=paths)
    return {"action": "escalated" if not capped else "at_cap", "from_share": prev_share, "to_share": new_share,
            "reason": f"replicas held at {ratio:.2f}x", "active": active, "replicas": rep}


# ---------------------------------------------------------------------------
# Revert (the manual undo)
# ---------------------------------------------------------------------------
def revert(reason: str = "", *, paths: Optional[Dict[str, Path]] = None, now: Optional[str] = None,
           actor: str = "human", key: Optional[str] = None) -> Dict[str, Any]:
    """Close any open round and return the designer to plain exploration.

    `key`, when given, must match the open round — a guard against reverting a
    round that has already rolled over to a different style since you looked.
    """
    paths = paths or default_paths()
    now = now or _now_iso()
    led = load_ledger(paths=paths)
    active = led.get("active")
    if not isinstance(active, dict):
        return {"action": "none", "reason": "nothing to revert"}
    if key and str(active.get("key")) != key:
        return {"action": "none", "reason": f"active round is {active.get('key')!r}, not {key!r}"}
    active["status"] = "reverted"
    active["closed_at"] = now
    active["outcome"] = "manual-revert"
    led["active"] = None
    _log(led, "revert_manual", {"key": active.get("key"), "actor": actor, "reason": reason or "(none given)"}, now)
    led.setdefault("history", []).append({"ts": now, "event": "closed_round", "round": active})
    save_ledger(led, paths=paths)
    return {"action": "reverted", "key": active.get("key"), "reason": reason or "(none given)"}


# ---------------------------------------------------------------------------
# Read side: what should the designer actually DO this batch?
# ---------------------------------------------------------------------------
def replica_count(target: int, *, paths: Optional[Dict[str, Path]] = None) -> int:
    """How many of `target` slots this batch may spend on the winning style."""
    d = current_directive(paths=paths)
    if not d.get("active"):
        return 0
    return int(min(int(target * float(d["share"])), int(target * float(d["share_cap"]))))


def current_directive(*, paths: Optional[Dict[str, Path]] = None) -> Dict[str, Any]:
    """The compact contract the TS designer + dashboard read (replication.ts)."""
    paths = paths or default_paths()
    policy = load_policy(paths["content_defaults"])
    led = load_ledger(paths=paths)
    active = led.get("active")
    if not policy.get("enabled", True) or not isinstance(active, dict) or active.get("status") not in ("active", "escalated"):
        return {"active": False, "share": 0.0, "share_cap": policy["winner_share_cap"],
                "reason": "no active replication round"}
    share = min(float(active.get("share") or 0.0), float(policy["winner_share_cap"]))
    return {
        "active": True,
        "key": active.get("key"),
        "fingerprint": active.get("fingerprint"),
        "share": share,
        "share_cap": float(policy["winner_share_cap"]),
        "round": active.get("round"),
        "status": active.get("status"),
        "confidence": active.get("confidence"),
        "opened_at": active.get("opened_at"),
        "evaluate_after": active.get("evaluate_after"),
        "vary_only": active.get("vary_only") or list(SECONDARY_KNOBS),
        "evidence": active.get("evidence"),
    }


def run_cycle(*, paths: Optional[Dict[str, Path]] = None, now: Optional[str] = None) -> Dict[str, Any]:
    """ONE autonomous replication cycle — what the daily loop calls.

    Evaluate first, then detect: judging the open round before looking for a new
    winner means a round that just turned out to be a fluke is closed in the same
    pass that opens its replacement, instead of blocking it for a day.
    """
    paths = paths or default_paths()
    now = now or _now_iso()
    evaluated = evaluate_escalation(paths=paths, now=now)
    detected = detect_cycle(paths=paths, now=now)
    return {"evaluate": evaluated, "detect": detected, "directive": current_directive(paths=paths)}


def status(*, paths: Optional[Dict[str, Path]] = None) -> Dict[str, Any]:
    """Everything the dashboard's REPLICATE panel needs, in one read."""
    paths = paths or default_paths()
    policy = load_policy(paths["content_defaults"])
    db = _read_json(paths["ab_database"], {}) or {}
    posts = matured_posts(db)
    led = load_ledger(paths=paths)
    det = detect_winner(posts, policy)
    return {
        "enabled": bool(policy.get("enabled", True)),
        "policy": policy,
        "directive": current_directive(paths=paths),
        "detection": {
            "found": det.get("found"),
            "reason": det.get("reason"),
            "confidence": det.get("confidence"),
            "winner": det.get("winner"),
            "top_styles": (det.get("styles") or [])[:5],
            "baselines": det.get("baselines"),
        },
        "matured_posts": len(posts),
        "history": (led.get("history") or [])[-12:],
        "updated_at": led.get("updated_at"),
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def _print(obj: Any) -> None:
    print(json.dumps(obj, indent=2, default=str))


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="sffs_replicate",
        description="Detect a REACH outlier, replicate its style under an exploration cap, escalate or revert.",
    )
    p.add_argument("--cycle", action="store_true", help="run ONE autonomous cycle (evaluate the open round, then detect)")
    p.add_argument("--detect", action="store_true", help="scan for a reach front-runner and open a replication round")
    p.add_argument("--evaluate", action="store_true", help="judge an open round once its replicas matured (escalate / hold / revert)")
    p.add_argument("--status", action="store_true", help="print the full replication status (what the dashboard shows)")
    p.add_argument("--directive", action="store_true", help="print just the designer contract (active style + share)")
    p.add_argument("--ledger", action="store_true", help="print the reversible ledger history")
    p.add_argument("--revert", nargs="?", const="", metavar="KEY",
                   help="close the open round and return to plain exploration (optionally assert its style KEY)")
    p.add_argument("--reason", default="", help="reason recorded with --revert")
    p.add_argument("--actor", default=os.environ.get("USER", "human"), help="who is acting (for the ledger)")
    return p


def main(argv: Optional[List[str]] = None) -> int:
    args = _build_parser().parse_args(argv)
    try:
        if args.revert is not None:
            _print(revert(args.reason, actor=args.actor, key=args.revert or None))
        elif args.cycle:
            _print(run_cycle())
        elif args.detect:
            _print(detect_cycle())
        elif args.evaluate:
            _print(evaluate_escalation())
        elif args.directive:
            _print(current_directive())
        elif args.ledger:
            _print(load_ledger().get("history", []))
        else:
            _print(status())
        return 0
    except ReplicateError as e:
        _print({"ok": False, "error": str(e)})
        return 2


if __name__ == "__main__":
    sys.exit(main())
