"""DEFAULT-PROMOTION engine tests — the CONTENT human-gate analog of the code gate.

Proves the read-side detector (threshold + min-sample edges), proposal generation
into the durable queue, and the HUMAN approve/reject flow (default flip + append-only
logging), plus the guardrail that the AGENT-facing tool can NEVER approve/reject (that
is a human CLI action). Hermetic: no network, no node, no framework — imports the pure
module directly and drives it against tmp JSON files.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

PLUGIN_DIR = Path(__file__).resolve().parents[1] / "sffs"
sys.path.insert(0, str(PLUGIN_DIR))

import promote  # noqa: E402
import publish_guard as pg  # noqa: E402


# ---------------------------------------------------------------------------
# fixtures / helpers
# ---------------------------------------------------------------------------
def _write(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=2), encoding="utf-8")


def _paths(tmp: Path) -> dict:
    return {
        "content_defaults": tmp / "content-defaults.json",
        "learnings": tmp / "learnings.json",
        "proposals": tmp / "proposals.json",
    }


def _cell(median, n, posts=None):
    return {"n_posts": posts if posts is not None else n, "n_with_metrics": n, "median_eng_rate": median, "avg_reach": 100}


def _seed(tmp: Path, *, defaults=None, promotion=None, by_arm=None, proposals=None):
    p = _paths(tmp)
    cd = {"schema_version": 1, "defaults": defaults or {"narration": "full", "ending": "cliffhanger"}}
    if promotion is not None:
        cd["promotion"] = promotion
    _write(p["content_defaults"], cd)
    _write(p["learnings"], {"rollups": {"by_variant_arm": by_arm or {}}, "decisions_log": []})
    if proposals is not None:
        _write(p["proposals"], proposals)
    return p


DEFAULT_POLICY = dict(promote.FALLBACK_POLICY)


# ===========================================================================
# detect_candidates — the PURE detector (threshold + min-sample edges)
# ===========================================================================
def test_detect_no_rollups_no_candidates():
    assert promote.detect_candidates({}, promote.FALLBACK_DEFAULTS, DEFAULT_POLICY) == []
    assert promote.detect_candidates({"rollups": {}}, promote.FALLBACK_DEFAULTS, DEFAULT_POLICY) == []


def test_detect_clear_win_promotes():
    by_arm = {"control": _cell(3.0, 8), "full-reveal": _cell(6.0, 7)}
    cands = promote.detect_candidates({"rollups": {"by_variant_arm": by_arm}}, promote.FALLBACK_DEFAULTS, DEFAULT_POLICY)
    assert len(cands) == 1
    c = cands[0]
    assert c["dimension"] == "ending"
    assert c["recommended_default"] == "full-reveal"
    assert c["id"] == "promote-ending-full-reveal"
    assert c["delta_abs_pp"] == 3.0
    assert c["delta_rel"] == 1.0
    assert c["confidence"] in ("high", "medium")


def test_detect_no_promote_on_small_n():
    # challenger clearly higher but only 3 metricized posts (< min_sample 5)
    by_arm = {"control": _cell(3.0, 8), "full-reveal": _cell(9.0, 3)}
    assert promote.detect_candidates({"rollups": {"by_variant_arm": by_arm}}, promote.FALLBACK_DEFAULTS, DEFAULT_POLICY) == []


def test_detect_no_promote_when_incumbent_below_min_sample():
    by_arm = {"control": _cell(3.0, 4), "full-reveal": _cell(9.0, 9)}  # control n=4 < 5
    assert promote.detect_candidates({"rollups": {"by_variant_arm": by_arm}}, promote.FALLBACK_DEFAULTS, DEFAULT_POLICY) == []


def test_detect_no_promote_below_absolute_threshold():
    # rel would pass (0.8) but abs (0.4pp) < 1.0pp
    by_arm = {"control": _cell(0.5, 8), "no-answer": _cell(0.9, 8)}
    assert promote.detect_candidates({"rollups": {"by_variant_arm": by_arm}}, promote.FALLBACK_DEFAULTS, DEFAULT_POLICY) == []


def test_detect_no_promote_below_relative_threshold():
    # abs passes (1.5pp) but rel (0.15) < 0.20
    by_arm = {"control": _cell(10.0, 8), "full-reveal": _cell(11.5, 8)}
    assert promote.detect_candidates({"rollups": {"by_variant_arm": by_arm}}, promote.FALLBACK_DEFAULTS, DEFAULT_POLICY) == []


def test_detect_picks_best_arm_per_dimension():
    by_arm = {"control": _cell(3.0, 8), "full-reveal": _cell(6.0, 8), "no-answer": _cell(7.5, 8)}
    cands = promote.detect_candidates({"rollups": {"by_variant_arm": by_arm}}, promote.FALLBACK_DEFAULTS, DEFAULT_POLICY)
    assert len(cands) == 1
    assert cands[0]["recommended_default"] == "no-answer"  # higher of the two winners


def test_detect_skips_arm_equal_to_current_default():
    # if "full" is (hypothetically) in the rollup but full IS the narration default,
    # it is the control and must not be proposed as its own dimension's challenger.
    by_arm = {"control": _cell(3.0, 8), "full": _cell(9.0, 8)}
    cands = promote.detect_candidates({"rollups": {"by_variant_arm": by_arm}}, promote.FALLBACK_DEFAULTS, DEFAULT_POLICY)
    assert all(c["dimension"] != "narration" for c in cands)


def test_detect_after_flip_old_default_becomes_challenger():
    # ending default already flipped to full-reveal -> cliffhanger is now testable
    defaults = {"narration": "full", "ending": "full-reveal"}
    by_arm = {"control": _cell(3.0, 8), "cliffhanger": _cell(6.0, 8)}
    cands = promote.detect_candidates({"rollups": {"by_variant_arm": by_arm}}, defaults, DEFAULT_POLICY)
    assert len(cands) == 1 and cands[0]["recommended_default"] == "cliffhanger"


def test_detect_high_vs_medium_confidence():
    hi = {"control": _cell(3.0, 12), "full-reveal": _cell(6.0, 12)}  # n_min 12>=10, rel 1.0>=0.4
    med = {"control": _cell(3.0, 6), "full-reveal": _cell(4.2, 6)}    # n_min 6, rel 0.4>=0.2 but n<10
    assert promote.detect_candidates({"rollups": {"by_variant_arm": hi}}, promote.FALLBACK_DEFAULTS, DEFAULT_POLICY)[0]["confidence"] == "high"
    assert promote.detect_candidates({"rollups": {"by_variant_arm": med}}, promote.FALLBACK_DEFAULTS, DEFAULT_POLICY)[0]["confidence"] == "medium"


def test_detect_zero_incumbent_needs_positive_absolute():
    by_arm = {"control": _cell(0.0, 8), "full-reveal": _cell(2.0, 8)}  # inc 0 -> rel inf, abs 2 >= 1
    cands = promote.detect_candidates({"rollups": {"by_variant_arm": by_arm}}, promote.FALLBACK_DEFAULTS, DEFAULT_POLICY)
    assert len(cands) == 1 and cands[0]["delta_rel"] is None  # infinite rel serialized as null


# ===========================================================================
# config-driven policy (threshold + min-sample gate come from content-defaults.json)
# ===========================================================================
def test_policy_is_config_driven_min_sample(tmp_path):
    p = _seed(
        tmp_path,
        promotion={"metric": "median_eng_rate", "min_sample": 10, "min_abs_improvement_pp": 1.0, "min_rel_improvement": 0.2, "incumbent_label": "control"},
        by_arm={"control": _cell(3.0, 8), "full-reveal": _cell(6.0, 8)},  # n=8 was enough at 5, not at 10
    )
    policy = promote.load_policy(p["content_defaults"])
    assert policy["min_sample"] == 10
    out = promote.refresh_proposals(paths=p, now="2026-07-22T00:00:00Z")
    assert out["detected"] == 0 and out["pending_count"] == 0


def test_policy_is_config_driven_abs_threshold(tmp_path):
    p = _seed(
        tmp_path,
        promotion={"metric": "median_eng_rate", "min_sample": 5, "min_abs_improvement_pp": 5.0, "min_rel_improvement": 0.2, "incumbent_label": "control"},
        by_arm={"control": _cell(3.0, 8), "full-reveal": _cell(6.0, 8)},  # +3pp < required +5pp
    )
    out = promote.refresh_proposals(paths=p, now="2026-07-22T00:00:00Z")
    assert out["detected"] == 0


# ===========================================================================
# refresh_proposals — persist to the durable queue (proposal generation)
# ===========================================================================
def test_refresh_generates_pending_proposal(tmp_path):
    p = _seed(tmp_path, by_arm={"control": _cell(3.0, 8), "full-reveal": _cell(6.0, 7)})
    out = promote.refresh_proposals(paths=p, now="2026-07-22T00:00:00Z")
    assert out["ok"] and out["detected"] == 1 and out["pending_count"] == 1
    q = json.loads(p["proposals"].read_text())
    assert len(q["proposals"]) == 1
    prop = q["proposals"][0]
    assert prop["id"] == "promote-ending-full-reveal"
    assert prop["status"] == "pending"
    assert prop["recommended_default"] == "full-reveal"
    assert prop["current_default"] == "cliffhanger"
    assert prop["delta_abs_pp"] == 3.0
    assert prop["min_sample"] == 5
    assert "challenger" in prop and prop["challenger"]["n_with_metrics"] == 7
    assert "HUMAN APPROVAL REQUIRED" in prop["rationale"]


def test_refresh_is_idempotent(tmp_path):
    p = _seed(tmp_path, by_arm={"control": _cell(3.0, 8), "full-reveal": _cell(6.0, 7)})
    promote.refresh_proposals(paths=p, now="2026-07-22T00:00:00Z")
    out2 = promote.refresh_proposals(paths=p, now="2026-07-22T01:00:00Z")
    q = json.loads(p["proposals"].read_text())
    assert len(q["proposals"]) == 1  # upsert, not duplicate
    assert out2["refreshed"] == ["promote-ending-full-reveal"]


def test_refresh_expires_a_stale_pending_proposal(tmp_path):
    p = _seed(tmp_path, by_arm={"control": _cell(3.0, 8), "full-reveal": _cell(6.0, 7)})
    promote.refresh_proposals(paths=p, now="2026-07-22T00:00:00Z")
    # signal disappears (challenger regresses below control)
    _write(p["learnings"], {"rollups": {"by_variant_arm": {"control": _cell(3.0, 8), "full-reveal": _cell(2.0, 7)}}, "decisions_log": []})
    out = promote.refresh_proposals(paths=p, now="2026-07-22T02:00:00Z")
    assert "promote-ending-full-reveal" in out["expired"]
    q = json.loads(p["proposals"].read_text())
    assert q["proposals"][0]["status"] == "expired"
    assert any(d["action"] == "auto-expire" for d in q["decisions_log"])


# ===========================================================================
# approve — HUMAN flip of the config default + append-only logging
# ===========================================================================
def test_approve_flips_default_and_logs(tmp_path):
    p = _seed(tmp_path, by_arm={"control": _cell(3.0, 8), "full-reveal": _cell(6.0, 8)})
    promote.refresh_proposals(paths=p, now="2026-07-22T00:00:00Z")
    res = promote.approve("promote-ending-full-reveal", actor="alice", paths=p, now="2026-07-22T03:00:00Z")
    assert res["ok"] and res["to"] == "full-reveal" and res["from"] == "cliffhanger"

    # 1) config default flipped
    cd = json.loads(p["content_defaults"].read_text())
    assert cd["defaults"]["ending"] == "full-reveal"
    assert len(cd["history"]) == 1
    assert cd["history"][0]["approved_by"] == "alice"
    assert cd["history"][0]["from"] == "cliffhanger" and cd["history"][0]["to"] == "full-reveal"

    # 2) proposal marked approved + queue decisions_log
    q = json.loads(p["proposals"].read_text())
    prop = q["proposals"][0]
    assert prop["status"] == "approved" and prop["decided_by"] == "alice"
    assert any(d["action"] == "approve" for d in q["decisions_log"])

    # 3) learnings decisions_log surfaces the human-approved decision (dashboard)
    learn = json.loads(p["learnings"].read_text())
    assert any(d.get("status") == "human-approved" for d in learn["decisions_log"])


def test_approve_is_idempotent_guard(tmp_path):
    p = _seed(tmp_path, by_arm={"control": _cell(3.0, 8), "full-reveal": _cell(6.0, 8)})
    promote.refresh_proposals(paths=p, now="2026-07-22T00:00:00Z")
    promote.approve("promote-ending-full-reveal", actor="a", paths=p, now="2026-07-22T03:00:00Z")
    with pytest.raises(promote.PromoteError):
        promote.approve("promote-ending-full-reveal", actor="a", paths=p)  # already approved


def test_approve_unknown_id_raises(tmp_path):
    p = _seed(tmp_path, by_arm={"control": _cell(3.0, 8)})
    with pytest.raises(promote.PromoteError):
        promote.approve("promote-ending-nope", paths=p)


def test_approve_then_detect_stops_reproposing_same_arm(tmp_path):
    # after a flip, control == full-reveal video; detector no longer re-proposes it.
    p = _seed(tmp_path, by_arm={"control": _cell(3.0, 8), "full-reveal": _cell(6.0, 8)})
    promote.refresh_proposals(paths=p, now="2026-07-22T00:00:00Z")
    promote.approve("promote-ending-full-reveal", paths=p, now="2026-07-22T03:00:00Z")
    # simulate the new control now performing like full-reveal did
    _write(p["learnings"], {"rollups": {"by_variant_arm": {"control": _cell(6.0, 8), "cliffhanger": _cell(3.0, 8)}}, "decisions_log": []})
    out = promote.refresh_proposals(paths=p, now="2026-07-22T04:00:00Z")
    assert not any(pr["recommended_default"] == "full-reveal" and pr["status"] == "pending" for pr in json.loads(p["proposals"].read_text())["proposals"])
    assert out["detected"] == 0  # cliffhanger (3.0) does not beat control (6.0)


# ===========================================================================
# reject — HUMAN reject keeps the arm testing (default unchanged)
# ===========================================================================
def test_reject_keeps_default_and_logs(tmp_path):
    p = _seed(tmp_path, by_arm={"control": _cell(3.0, 8), "full-reveal": _cell(6.0, 8)})
    promote.refresh_proposals(paths=p, now="2026-07-22T00:00:00Z")
    res = promote.reject("promote-ending-full-reveal", reason="too soon", actor="bob", paths=p, now="2026-07-22T03:00:00Z")
    assert res["ok"]
    cd = json.loads(p["content_defaults"].read_text())
    assert cd["defaults"]["ending"] == "cliffhanger"  # UNCHANGED
    q = json.loads(p["proposals"].read_text())
    assert q["proposals"][0]["status"] == "rejected" and q["proposals"][0]["reject_reason"] == "too soon"
    assert any(d["action"] == "reject" for d in q["decisions_log"])
    learn = json.loads(p["learnings"].read_text())
    assert any(d.get("status") == "human-rejected" for d in learn["decisions_log"])


def test_rejected_not_reproposed_unless_reopened(tmp_path):
    p = _seed(tmp_path, by_arm={"control": _cell(3.0, 8), "full-reveal": _cell(6.0, 8)})
    promote.refresh_proposals(paths=p, now="2026-07-22T00:00:00Z")
    promote.reject("promote-ending-full-reveal", reason="no", paths=p, now="2026-07-22T03:00:00Z")
    # normal refresh: stays rejected, no new pending (don't nag)
    out = promote.refresh_proposals(paths=p, now="2026-07-22T04:00:00Z")
    assert out["pending_count"] == 0
    assert json.loads(p["proposals"].read_text())["proposals"][0]["status"] == "rejected"
    # explicit human reconsider: reopen
    out2 = promote.refresh_proposals(paths=p, now="2026-07-22T05:00:00Z", reopen_rejected=True)
    assert out2["pending_count"] == 1
    assert json.loads(p["proposals"].read_text())["proposals"][0]["status"] == "pending"


def test_reject_nonpending_raises(tmp_path):
    p = _seed(tmp_path, by_arm={"control": _cell(3.0, 8), "full-reveal": _cell(6.0, 8)})
    promote.refresh_proposals(paths=p, now="2026-07-22T00:00:00Z")
    promote.approve("promote-ending-full-reveal", paths=p, now="2026-07-22T03:00:00Z")
    with pytest.raises(promote.PromoteError):
        promote.reject("promote-ending-full-reveal", paths=p)


# ===========================================================================
# HUMAN-GATE: the agent-facing tool can DETECT/LIST but NEVER approve/reject
# ===========================================================================
def test_build_request_refuses_approve_and_reject():
    with pytest.raises(promote.PromoteError):
        promote.build_promote_request({"action": "approve", "id": "x"})
    with pytest.raises(promote.PromoteError):
        promote.build_promote_request({"action": "reject", "id": "x"})


def test_build_request_allows_read_actions():
    assert promote.build_promote_request({})["action"] == "list"
    assert promote.build_promote_request({"action": "detect"})["action"] == "refresh"
    assert promote.build_promote_request({"action": "status"})["action"] == "status"
    assert promote.build_promote_request({"action": "show", "id": "p1"}) == {"action": "show", "id": "p1"}


def test_build_request_rejects_bad():
    for bad in (None, "nope", 5, {"action": 3}, {"action": "delete"}, {"action": "show"}):
        with pytest.raises(promote.PromoteError):
            promote.build_promote_request(bad)


def test_tool_refuses_approve_pointing_to_human_cli():
    out = json.loads(promote.sffs_promote({"action": "approve", "id": "p1"}))
    assert out["ok"] is False
    assert "sffs_promote_default" in out["error"] and "human" in out["error"].lower()


def test_tool_list_and_detect_via_default_paths(tmp_path, monkeypatch):
    p = _seed(tmp_path, by_arm={"control": _cell(3.0, 8), "full-reveal": _cell(6.0, 8)})
    monkeypatch.setattr(promote, "default_paths", lambda: p)
    det = json.loads(promote.sffs_promote({"action": "detect"}))
    assert det["ok"] and det["detected"] == 1
    lst = json.loads(promote.sffs_promote({"action": "list", "status": "pending"}))
    assert lst["ok"] and lst["count"] == 1
    st = json.loads(promote.sffs_promote({"action": "status"}))
    assert st["defaults"]["ending"] == "cliffhanger" and st["counts"].get("pending") == 1


@pytest.mark.parametrize("garbage", [None, 42, "nope", [], {"action": {}}])
def test_tool_never_raises_on_garbage(garbage):
    out = promote.sffs_promote(garbage)
    assert isinstance(out, str) and "ok" in json.loads(out)


# ===========================================================================
# CLI (main) — the human entrypoint (approve flips; list works)
# ===========================================================================
def test_cli_detect_then_approve(tmp_path, monkeypatch, capsys):
    p = _seed(tmp_path, by_arm={"control": _cell(3.0, 8), "full-reveal": _cell(6.0, 8)})
    monkeypatch.setattr(promote, "default_paths", lambda: p)
    assert promote.main(["--detect"]) == 0
    assert promote.main(["--approve", "promote-ending-full-reveal", "--actor", "carol"]) == 0
    cd = json.loads(p["content_defaults"].read_text())
    assert cd["defaults"]["ending"] == "full-reveal"
    # subcommand form also works for list
    assert promote.main(["list"]) == 0


# ===========================================================================
# Cross-check: sffs_promote args are NOT flagged by the publish/schedule guard,
# while a genuine publish/schedule still is.
# ===========================================================================
def test_promote_args_not_flagged_by_publish_guard():
    for args in ({"action": "list"}, {"action": "detect"}, {"action": "show", "id": "promote-ending-full-reveal"}, {"action": "approve", "id": "x"}):
        assert pg.refusal_reason("sffs_promote", args) is None


def test_guard_still_blocks_real_publish():
    assert pg.refusal_reason("publer_publish_post_now", {}) is not None
    assert pg.refusal_reason("sffs_promote", {"scheduled_at": "2026-07-22T00:00:00Z"}) is not None
