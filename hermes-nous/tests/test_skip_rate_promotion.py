"""SKIP-RATE PROMOTION — the gate that was configured but not connected.

Promotion is configured on `median_skip_rate`, which is LOWER-IS-BETTER. Three faults
made that impossible and, worse, made a naive repair actively harmful:

  1. score.ts never persisted skip_rate, so no row ever carried one;
  2. rollup.ts never aggregated it, so no cell exposed median_skip_rate;
  3. promote.py compared challenger-minus-incumbent and required a HIGHER number, and
     ignored `lower_is_better` entirely -- so fixing only (1) and (2) would have
     promoted the arm with the WORSE hook while looking like it finally worked.

These tests drive the REAL detector, and the end-to-end one drives the REAL TypeScript
rollup through the introspect probe, because the lesson from this codebase is that
helpers asserted in isolation stay green while the pipeline between them is dead.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
PROBE = REPO / "hermes-nous" / "bridge" / "introspect.ts"
CONTENT_DEFAULTS = REPO / "ab-testing" / "content-defaults.json"

PLUGIN_DIR = Path(__file__).resolve().parents[1] / "sffs"
sys.path.insert(0, str(PLUGIN_DIR))

import promote  # noqa: E402

SKIP = "median_skip_rate"


def _policy(**over):
    """A policy shaped like the live one: skip rate, lower-is-better."""
    p = dict(promote.FALLBACK_POLICY)
    p.update({"metric": SKIP, "lower_is_better": True, "min_sample": 5,
              "min_abs_improvement_pp": 1.0, "min_rel_improvement": 0.02})
    p.update(over)
    return p


def _cell(skip, n):
    """A rollup cell shaped exactly like hermes/src/rollup.ts emits."""
    return {"n_posts": n, "n_with_metrics": n, "median_eng_rate": None, "avg_reach": None,
            "median_views": None, "median_reach": None, SKIP: skip,
            "n_by_metric": {"median_eng_rate": 0, SKIP: n, "median_views": 0, "median_reach": 0}}


def _detect(by_arm, policy=None, defaults=None):
    return promote.detect_candidates(
        {"rollups": {"by_variant_arm": by_arm}},
        defaults or promote.FALLBACK_DEFAULTS,
        policy or _policy(),
    )


# ===========================================================================
# THE test: direction. A lower skip rate is a BETTER hook.
# ===========================================================================
def test_the_challenger_with_the_LOWER_skip_rate_is_the_one_promoted():
    by_arm = {"control": _cell(80.0, 10), "no-narration": _cell(62.0, 10)}
    cands = _detect(by_arm)
    nar = [c for c in cands if c["dimension"] == "narration"]
    assert len(nar) == 1, "a clearly better hook must produce exactly one candidate"
    assert nar[0]["recommended_default"] == "no-narration"
    assert nar[0]["metric"] == SKIP
    assert nar[0]["lower_is_better"] is True
    # positive == better, whichever way the metric runs
    assert nar[0]["delta_abs_pp"] == pytest.approx(18.0)
    assert nar[0]["challenger"][SKIP] == 62.0
    assert nar[0]["incumbent"][SKIP] == 80.0


def test_the_challenger_with_the_HIGHER_skip_rate_is_NEVER_promoted():
    """The inversion. If lower_is_better regresses this fails loudly instead of
    silently shipping the loser."""
    by_arm = {"control": _cell(62.0, 10), "no-narration": _cell(80.0, 10)}
    cands = _detect(by_arm)
    assert cands == [], "an arm with a WORSE skip rate must never be promoted"
    # and state it the strong way too: whatever comes back, it is not the worse arm
    assert all(c.get("recommended_default") != "no-narration" for c in cands)


def test_the_direction_flag_is_load_bearing_not_incidental():
    """Same data, direction flipped: the OPPOSITE arm wins. Proves the flag is
    actually read, so a silent revert to the old higher-is-better comparison cannot
    pass this file."""
    by_arm = {"control": _cell(80.0, 10), "no-narration": _cell(62.0, 10)}
    lower = _detect(by_arm, _policy(lower_is_better=True))
    higher = _detect(by_arm, _policy(lower_is_better=False))
    assert [c["recommended_default"] for c in lower] == ["no-narration"]
    # under higher-is-better the 80.0 control cannot be beaten by 62.0 -> no candidate
    assert higher == []
    # and with the arms swapped, higher-is-better would pick the arm lower-is-better rejects
    swapped = {"control": _cell(62.0, 10), "no-narration": _cell(80.0, 10)}
    assert [c["recommended_default"] for c in _detect(swapped, _policy(lower_is_better=False))] == ["no-narration"]
    assert _detect(swapped, _policy(lower_is_better=True)) == []


def test_best_arm_is_the_biggest_IMPROVEMENT_not_the_highest_number():
    """Ranking must invert too: 'highest metric wins' picks the WORST qualifying arm
    the moment the metric is lower-is-better."""
    by_arm = {
        "control": _cell(80.0, 10),
        "no-narration": _cell(70.0, 10),      # better
        "no-question-vo": _cell(55.0, 10),    # best
    }
    cands = _detect(by_arm)
    nar = [c for c in cands if c["dimension"] == "narration"]
    assert len(nar) == 1
    assert nar[0]["recommended_default"] == "no-question-vo", "the LOWEST skip rate is the best arm"


# ===========================================================================
# the min-sample gate still holds, and now counts the right posts
# ===========================================================================
def test_min_sample_gate_still_blocks_a_thin_sample():
    pol = _policy(min_sample=12)
    assert _detect({"control": _cell(80.0, 11), "no-narration": _cell(50.0, 11)}, pol) == []
    assert _detect({"control": _cell(80.0, 12), "no-narration": _cell(50.0, 11)}, pol) == []
    assert _detect({"control": _cell(80.0, 11), "no-narration": _cell(50.0, 12)}, pol) == []
    ok = _detect({"control": _cell(80.0, 12), "no-narration": _cell(50.0, 12)}, pol)
    assert [c["recommended_default"] for c in ok] == ["no-narration"]


def test_min_sample_counts_posts_carrying_THE_JUDGED_METRIC():
    """A cell can be rich in matured posts and thin in skip rates (skip rate is
    Instagram-only). The gate must count the latter."""
    thin = _cell(50.0, 12)
    thin["n_with_metrics"] = 12
    thin["n_by_metric"][SKIP] = 3           # only 3 posts actually have a skip rate
    assert _detect({"control": _cell(80.0, 12), "no-narration": thin}, _policy(min_sample=12)) == []
    thin["n_by_metric"][SKIP] = 12
    assert len(_detect({"control": _cell(80.0, 12), "no-narration": thin}, _policy(min_sample=12))) == 1


def test_a_pre_n_by_metric_cell_still_evaluates():
    """learnings.json written before rollup.ts emitted n_by_metric must still work."""
    old = {"n_posts": 10, "n_with_metrics": 10, SKIP: 60.0}
    inc = {"n_posts": 10, "n_with_metrics": 10, SKIP: 80.0}
    cands = _detect({"control": inc, "no-narration": old})
    assert [c["recommended_default"] for c in cands] == ["no-narration"]


def test_thresholds_still_apply_in_the_lower_is_better_direction():
    # a 0.5pp improvement is below min_abs_improvement_pp = 1.0
    assert _detect({"control": _cell(80.0, 10), "no-narration": _cell(79.5, 10)}) == []
    # a 1.5pp improvement clears absolute but not a 10% relative bar
    assert _detect({"control": _cell(80.0, 10), "no-narration": _cell(78.5, 10)},
                   _policy(min_rel_improvement=0.10)) == []
    assert len(_detect({"control": _cell(80.0, 10), "no-narration": _cell(60.0, 10)},
                       _policy(min_rel_improvement=0.10))) == 1


# ===========================================================================
# the LIVE config contract
# ===========================================================================
def test_live_config_declares_skip_rate_lower_is_better_and_the_engine_reads_it():
    policy = promote.load_policy(CONTENT_DEFAULTS)
    assert policy["metric"] == SKIP
    assert policy["lower_is_better"] is True, "the flag must survive load_policy"
    assert promote._lower_is_better(SKIP, policy) is True
    # every promotable dimension is judged on it -- no built-in override survives
    for dim in promote.PROMOTABLE_DIMENSIONS:
        assert promote._metric_for_dimension(dim, policy) == SKIP, dim


def test_all_three_dimensions_can_actually_promote_on_skip_rate():
    """The point of the work: narration, ending and mascot are unblocked."""
    policy = promote.load_policy(CONTENT_DEFAULTS)
    n = int(policy["min_sample"])
    for dim, arm in (("narration", "no-narration"), ("ending", "no-answer"), ("mascot", "mascot-absent")):
        cands = _detect({"control": _cell(80.0, n), arm: _cell(55.0, n)}, policy)
        hit = [c for c in cands if c["dimension"] == dim]
        assert len(hit) == 1, f"{dim} should be promotable on skip rate"
        assert hit[0]["recommended_default"] == arm


# ===========================================================================
# END TO END through the REAL TypeScript rollup
# ===========================================================================
def _real_rollups(posts):
    node = shutil.which("node")
    if not node:
        pytest.skip("node not on PATH")
    proc = subprocess.run([node, str(PROBE), "rollups"], input=json.dumps(posts),
                          capture_output=True, text=True, cwd=str(REPO), timeout=60)
    assert proc.returncode == 0, f"probe failed: {proc.stderr or proc.stdout}"
    return json.loads([l for l in proc.stdout.splitlines() if l.strip()][-1])["rollups"]


def _row(arm, skip):
    """An ab-database row shaped as score.ts persists it."""
    return {"variant": {"label": arm}, "platform": "instagram",
            "metrics": {"reach": 900, "video_views": 1000, "eng_rate": None,
                        "skip_rate": skip, "as_of": "2026-07-28", "source": "api"}}


def test_END_TO_END_skip_rate_survives_real_rollup_into_the_real_detector():
    """score-shaped rows -> the REAL TS computeRollups -> the REAL Python detector.

    Nothing between the two is hand-written: if either side drops skip_rate, or the
    cell key stops matching what promote.py asks for, this goes red.
    """
    posts = [_row("control", s) for s in (82, 80, 79, 81, 78, 80)] + \
            [_row("no-narration", s) for s in (61, 63, 60, 62, 59, 64)]
    rollups = _real_rollups(posts)
    by_arm = rollups["by_variant_arm"]

    # the metric genuinely came through the real TS
    assert by_arm["control"][SKIP] == 80.0
    assert by_arm["no-narration"][SKIP] == 61.5
    assert by_arm["no-narration"]["n_by_metric"][SKIP] == 6

    cands = promote.detect_candidates({"rollups": {"by_variant_arm": by_arm}},
                                      promote.FALLBACK_DEFAULTS, _policy(min_sample=6))
    nar = [c for c in cands if c["dimension"] == "narration"]
    assert len(nar) == 1, "the better hook must be promotable end to end"
    assert nar[0]["recommended_default"] == "no-narration"
    assert nar[0]["delta_abs_pp"] == pytest.approx(18.5)


def test_END_TO_END_the_worse_arm_is_not_promoted_through_the_real_rollup():
    posts = [_row("control", s) for s in (61, 63, 60, 62, 59, 64)] + \
            [_row("no-narration", s) for s in (82, 80, 79, 81, 78, 80)]
    by_arm = _real_rollups(posts)["by_variant_arm"]
    assert by_arm["no-narration"][SKIP] == 80.0
    cands = promote.detect_candidates({"rollups": {"by_variant_arm": by_arm}},
                                      promote.FALLBACK_DEFAULTS, _policy(min_sample=6))
    assert cands == [], "the arm with the worse hook must not be promoted end to end"


def test_END_TO_END_a_tiktok_only_arm_has_no_skip_rate_and_cannot_promote():
    """Metricool returns no watch-time for TikTok, so those rows carry null. A null
    must read as 'unknown' and block promotion, never as a perfect 0% skip."""
    posts = [_row("control", s) for s in (82, 80, 79, 81, 78, 80)] + \
            [{"variant": {"label": "no-narration"}, "platform": "tiktok",
              "metrics": {"reach": 500, "video_views": 900, "eng_rate": 2.0,
                          "skip_rate": None, "as_of": "2026-07-28", "source": "api"}} for _ in range(6)]
    by_arm = _real_rollups(posts)["by_variant_arm"]
    assert by_arm["no-narration"][SKIP] is None, "null must not become 0"
    assert by_arm["no-narration"]["n_by_metric"][SKIP] == 0
    assert promote.detect_candidates({"rollups": {"by_variant_arm": by_arm}},
                                     promote.FALLBACK_DEFAULTS, _policy(min_sample=6)) == []


# ===========================================================================
# auto-revert direction
# ===========================================================================
def test_auto_revert_direction_a_promoted_arm_that_got_WORSE_is_the_one_reverted(tmp_path):
    """Under lower-is-better, 'underperforming' means a HIGHER skip rate. With the old
    comparison the revert would fire on the arm that was doing well."""
    paths = {"content_defaults": tmp_path / "content-defaults.json",
             "learnings": tmp_path / "learnings.json",
             "proposals": tmp_path / "proposals.json"}
    cd = {"schema_version": 1,
          "defaults": {"narration": "no-narration", "ending": "cliffhanger", "mascot": "mascot-prominent"},
          "promotion": {"metric": SKIP, "lower_is_better": True, "min_sample": 5,
                        "min_abs_improvement_pp": 1.0, "min_rel_improvement": 0.02,
                        "incumbent_label": "control"},
          "auto_promotion": {"enabled": True, "min_sample": 5, "revert_min_sample": 5,
                             "revert_abs_drop_pp": 1.0, "confirmation_min_new_samples": 5}}
    paths["content_defaults"].write_text(json.dumps(cd), encoding="utf-8")
    # promoted arm is WORSE (higher skip) than the arm it replaced -> must revert
    by_arm = {"control": _cell(70.0, 10), "no-narration": _cell(85.0, 10), "full": _cell(70.0, 10)}
    paths["learnings"].write_text(json.dumps({"rollups": {"by_variant_arm": by_arm}, "decisions_log": []}), encoding="utf-8")
    paths["proposals"].write_text(json.dumps({
        "schema_version": 1, "proposals": [],
        "auto_ledger": [{"action": "auto-promote", "active": True, "dimension": "narration",
                         "to": "no-narration", "reversible_to": "full", "proposal_id": "p1"}],
    }), encoding="utf-8")

    res = promote.auto_promote_cycle(paths=paths, now="2026-07-28T18:00:00Z")
    assert res["reverted"], "a promoted arm with a WORSE skip rate must be auto-reverted"
    assert json.loads(paths["content_defaults"].read_text())["defaults"]["narration"] == "full"


def test_auto_revert_does_NOT_fire_on_a_promoted_arm_that_is_still_winning(tmp_path):
    paths = {"content_defaults": tmp_path / "content-defaults.json",
             "learnings": tmp_path / "learnings.json",
             "proposals": tmp_path / "proposals.json"}
    cd = {"schema_version": 1,
          "defaults": {"narration": "no-narration", "ending": "cliffhanger", "mascot": "mascot-prominent"},
          "promotion": {"metric": SKIP, "lower_is_better": True, "min_sample": 5,
                        "min_abs_improvement_pp": 1.0, "min_rel_improvement": 0.02,
                        "incumbent_label": "control"},
          "auto_promotion": {"enabled": True, "min_sample": 5, "revert_min_sample": 5,
                             "revert_abs_drop_pp": 1.0, "confirmation_min_new_samples": 5}}
    paths["content_defaults"].write_text(json.dumps(cd), encoding="utf-8")
    # promoted arm is BETTER (lower skip) than what it replaced -> keep it
    by_arm = {"control": _cell(85.0, 10), "no-narration": _cell(60.0, 10), "full": _cell(85.0, 10)}
    paths["learnings"].write_text(json.dumps({"rollups": {"by_variant_arm": by_arm}, "decisions_log": []}), encoding="utf-8")
    paths["proposals"].write_text(json.dumps({
        "schema_version": 1, "proposals": [],
        "auto_ledger": [{"action": "auto-promote", "active": True, "dimension": "narration",
                         "to": "no-narration", "reversible_to": "full", "proposal_id": "p1"}],
    }), encoding="utf-8")

    res = promote.auto_promote_cycle(paths=paths, now="2026-07-28T18:00:00Z")
    assert res["reverted"] == [], "a winning arm must not be reverted"
    assert json.loads(paths["content_defaults"].read_text())["defaults"]["narration"] == "no-narration"
