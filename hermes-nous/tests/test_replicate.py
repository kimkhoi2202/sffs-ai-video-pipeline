"""Tests for the WINNER-REPLICATION engine (sffs/replicate.py).

The fixtures mirror the REAL corpus shape this was built against: two platforms on
very different scales (TikTok views run ~2x Instagram), a long tail of ordinary
posts, and a couple of reach outliers that share one style — verbal odd-one-out.
That is the exact signal the eng_rate promotion gate cannot see, and the reason this
engine exists.

The invariant these tests care most about is the EXPLORATION FLOOR: replication may
never take more than winner_share_cap of a batch, however the ledger or the config
is edited, because a loop that stops exploring can only rediscover what it already
believes.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

# Import the module FLAT (the sibling convention, e.g. test_cov_promote_get_proposal):
# the auto-merge harness runs its pytest leg with cwd = the REPO ROOT, where the
# `sffs` package is not importable, so `from sffs import replicate` would break the
# gate. replicate.py is deliberately free of intra-package imports for this reason.
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "sffs"))

import replicate  # noqa: E402


# ---------------------------------------------------------------------------
# Fixtures — a corpus shaped like the live one
# ---------------------------------------------------------------------------
def _post(key, platform, views, types, *, nq=3, family="standard", narration="full",
          ending="cliffhanger", as_of="2026-07-25T12:00:00Z", scheduled_at=None):
    return {
        "_hermes_key": key,
        "platform": platform,
        "post_state": "published",
        "scheduled_at": scheduled_at,
        "variant": {
            "family": family,
            "question_types": types,
            "num_questions": nq,
            "narration": narration,
            "ending": ending,
        },
        "metrics": {"video_views": views, "reach": views, "as_of": as_of},
    }


ODD = ["odd-one-out", "figure-analogy", "number-series"]
WORD = ["word-analogy", "number-series", "figure-series"]
NUM = ["number-series", "word-analogy", "fill-in-the-blank"]


def base_corpus():
    """9 TikTok + 6 Instagram posts, shaped like the live corpus.

    The two TikTok odd-one-out posts carry the REAL reported outlier values (1179 and
    1148 views against a TikTok median of 301) — the n=2 evidence this engine was
    built to catch. Note the third odd-one-out post is an ORDINARY Instagram post at
    roughly its own platform median: a correct detector must not let that one average
    sample veto a style that has broken out twice.
    """
    return {
        "posts": [
            # TikTok: median lands on 301
            _post("t1", "tiktok", 1179, ODD),     # outlier #1  (3.92x)
            _post("t2", "tiktok", 1148, ODD),     # outlier #2  (3.81x)
            _post("t3", "tiktok", 400, WORD),
            _post("t4", "tiktok", 307, WORD),
            _post("t5", "tiktok", 301, NUM),
            _post("t6", "tiktok", 293, NUM),
            _post("t7", "tiktok", 275, WORD),
            _post("t8", "tiktok", 131, NUM),
            _post("t9", "tiktok", 7, WORD),
            # Instagram: a whole platform lower
            _post("i1", "instagram", 167, WORD),
            _post("i2", "instagram", 142, WORD),
            _post("i3", "instagram", 135, NUM),
            _post("i4", "instagram", 135, NUM),
            _post("i5", "instagram", 133, ODD),
            _post("i6", "instagram", 110, WORD),
        ]
    }


@pytest.fixture()
def paths(tmp_path: Path):
    ab = tmp_path / "ab-testing"
    ab.mkdir(parents=True)
    (ab / "ab-database.json").write_text(json.dumps(base_corpus()), encoding="utf-8")
    (ab / "content-defaults.json").write_text(json.dumps({"replication": {}}), encoding="utf-8")
    return {
        "content_defaults": ab / "content-defaults.json",
        "ab_database": ab / "ab-database.json",
        "replication": ab / "replication.json",
    }


def _set_policy(paths, **over):
    cd = json.loads(paths["content_defaults"].read_text(encoding="utf-8"))
    cd.setdefault("replication", {}).update(over)
    paths["content_defaults"].write_text(json.dumps(cd), encoding="utf-8")


# ---------------------------------------------------------------------------
# Baselines + fingerprinting
# ---------------------------------------------------------------------------
def test_baselines_are_per_platform_because_the_scales_differ(paths):
    policy = replicate.load_policy(paths["content_defaults"])
    posts = replicate.matured_posts(json.loads(paths["ab_database"].read_text()))
    base = replicate.platform_baselines(posts, policy)
    assert base["tiktok"]["median"] == 301
    assert base["instagram"]["median"] == 135.0
    assert base["tiktok"]["trusted"] and base["instagram"]["trusted"]


def test_normalize_tier_folds_the_two_corpus_eras(paths):
    # The original pipeline wrote "odd-one-out"; the current loop writes "ODD ONE
    # OUT". If these did not fold, an outlier could never be matched by a new video.
    assert replicate.normalize_tier("ODD ONE OUT") == "odd-one-out"
    assert replicate.normalize_tier("odd-one-out") == "odd-one-out"
    assert replicate.normalize_tier("Number_Series") == "number-series"
    assert replicate.normalize_tier(None) == "?"


def test_fingerprint_keys_on_the_lead_question_type(paths):
    fp = replicate.style_fingerprint(_post("x", "tiktok", 1, ["ODD ONE OUT", "NUMBER SERIES"], nq=2))
    assert fp["lead_type"] == "odd-one-out"
    assert fp["key"] == "odd-one-out|2|standard|full|cliffhanger"


# ---------------------------------------------------------------------------
# Detection — the reach outlier the eng_rate gate cannot see
# ---------------------------------------------------------------------------
def test_detects_the_reach_outlier_style_from_the_n2_evidence(paths):
    policy = replicate.load_policy(paths["content_defaults"])
    posts = replicate.matured_posts(json.loads(paths["ab_database"].read_text()))
    det = replicate.detect_winner(posts, policy)
    assert det["found"], det["reason"]
    w = det["winner"]
    assert w["fingerprint"]["lead_type"] == "odd-one-out"
    # exactly the reported evidence: TWO outliers in one style
    assert w["n_outliers"] == 2
    assert w["best_ratio"] == pytest.approx(1179 / 301, rel=1e-3)
    assert det["confidence"] == "high"
    assert "2 reach outlier(s)" in det["reason"]


def test_one_average_post_cannot_veto_a_style_that_broke_out_twice(paths):
    # The third odd-one-out post sits at its own platform median. Judging the style
    # on the median of ALL its posts would drag it under the bar and lose the signal.
    policy = replicate.load_policy(paths["content_defaults"])
    posts = replicate.matured_posts(json.loads(paths["ab_database"].read_text()))
    styles = {s["fingerprint"]["lead_type"]: s for s in replicate.score_styles(posts, policy)}
    odd = styles["odd-one-out"]
    assert odd["n"] == 3 and odd["n_outliers"] == 2
    assert replicate.detect_winner(posts, policy)["found"]


def test_a_mostly_dud_style_with_one_lucky_hit_does_not_qualify(paths):
    # Same single big hit, but surrounded by failures: the style-median floor
    # (min_style_median_ratio) is what rejects it.
    db = {"posts": [
        _post("t1", "tiktok", 1200, ODD),
        *[_post(f"t{i}", "tiktok", 5, ODD) for i in range(2, 7)],
        *[_post(f"w{i}", "tiktok", 300, WORD) for i in range(7, 12)],
    ]}
    paths["ab_database"].write_text(json.dumps(db), encoding="utf-8")
    policy = replicate.load_policy(paths["content_defaults"])
    det = replicate.detect_winner(replicate.matured_posts(db), policy)
    assert not det["found"]
    assert "duds" in det["reason"]


def test_platform_normalisation_stops_tiktok_winning_on_scale_alone(paths):
    # An Instagram post at 400 views is a MUCH bigger outlier than a TikTok post at
    # 400, because IG's median is less than half TikTok's. Raw views would miss it.
    db = {"posts": [p for p in base_corpus()["posts"] if p["_hermes_key"] not in ("t1", "t2")]}
    db["posts"].append(_post("t1", "tiktok", 400, WORD))       # 1.33x on TikTok -> ordinary
    db["posts"].append(_post("i7", "instagram", 400, ["paper-folding", "x", "y"]))  # 2.96x on IG
    paths["ab_database"].write_text(json.dumps(db), encoding="utf-8")
    policy = replicate.load_policy(paths["content_defaults"])
    det = replicate.detect_winner(replicate.matured_posts(db), policy)
    assert det["found"]
    assert det["winner"]["fingerprint"]["lead_type"] == "paper-folding"
    assert det["winner"]["best_ratio"] > 2.0  # scored against IG's median, not TikTok's


def test_no_detection_without_a_trusted_baseline(paths):
    thin = {"posts": [_post("t1", "tiktok", 5000, ODD), _post("t2", "tiktok", 10, WORD)]}
    paths["ab_database"].write_text(json.dumps(thin), encoding="utf-8")
    policy = replicate.load_policy(paths["content_defaults"])
    det = replicate.detect_winner(replicate.matured_posts(thin), policy)
    assert not det["found"]
    assert "baseline" in det["reason"]


def test_absolute_floor_blocks_a_fake_outlier_on_a_soft_median(paths):
    # Every post tiny: one of them is 3x the median but nowhere near worth chasing.
    soft = {"posts": [_post(f"t{i}", "tiktok", v, ODD if i == 0 else WORD)
                      for i, v in enumerate([30, 10, 10, 9, 8, 11, 12])]}
    paths["ab_database"].write_text(json.dumps(soft), encoding="utf-8")
    policy = replicate.load_policy(paths["content_defaults"])
    det = replicate.detect_winner(replicate.matured_posts(soft), policy)
    assert not det["found"]


def test_disabled_policy_detects_nothing(paths):
    _set_policy(paths, enabled=False)
    policy = replicate.load_policy(paths["content_defaults"])
    det = replicate.detect_winner(replicate.matured_posts(json.loads(paths["ab_database"].read_text())), policy)
    assert not det["found"]
    assert "disabled" in det["reason"]


# ---------------------------------------------------------------------------
# The exploration floor — the invariant that matters most
# ---------------------------------------------------------------------------
def test_share_cap_is_clamped_to_half_however_config_is_edited(paths):
    _set_policy(paths, winner_share_cap=0.95, initial_share=0.9)
    policy = replicate.load_policy(paths["content_defaults"])
    assert policy["winner_share_cap"] == 0.5
    assert policy["initial_share"] <= 0.5


def test_opened_round_never_exceeds_the_cap(paths):
    _set_policy(paths, initial_share=0.9)
    replicate.detect_cycle(paths=paths, now="2026-07-25T20:00:00Z")
    d = replicate.current_directive(paths=paths)
    assert d["active"] and d["share"] <= 0.5
    assert replicate.replica_count(12, paths=paths) <= 6


# ---------------------------------------------------------------------------
# Lifecycle: detect -> escalate / fluke-revert -> manual revert
# ---------------------------------------------------------------------------
def test_detect_cycle_opens_a_round_and_writes_a_reversible_ledger(paths):
    res = replicate.detect_cycle(paths=paths, now="2026-07-25T20:00:00Z")
    assert res["action"] == "opened"
    led = json.loads(paths["replication"].read_text())
    assert led["active"]["fingerprint"]["lead_type"] == "odd-one-out"
    assert led["active"]["status"] == "active"
    assert led["active"]["share"] == 0.25
    assert any(h["event"] == "detect_winner" for h in led["history"])
    # a second detect on unchanged evidence must not churn the round
    again = replicate.detect_cycle(paths=paths, now="2026-07-25T21:00:00Z")
    assert again["action"] == "unchanged"


def test_evaluate_waits_until_the_maturity_window_closes(paths):
    replicate.detect_cycle(paths=paths, now="2026-07-25T20:00:00Z")
    res = replicate.evaluate_escalation(paths=paths, now="2026-07-25T22:00:00Z")
    assert res["action"] == "wait"
    assert "maturity window" in res["reason"]


def test_replicas_that_hold_up_escalate_the_share_one_step(paths):
    replicate.detect_cycle(paths=paths, now="2026-07-25T20:00:00Z")
    db = base_corpus()
    for i, v in enumerate([1100, 1050]):  # still ~3.5x the tiktok median, created after the round opened
        db["posts"].append(_post(f"rep{i}", "tiktok", v, ODD, scheduled_at="2026-07-25T23:00:00Z",
                                 as_of="2026-07-26T21:00:00Z"))
    paths["ab_database"].write_text(json.dumps(db), encoding="utf-8")
    res = replicate.evaluate_escalation(paths=paths, now="2026-07-26T21:00:00Z")
    assert res["action"] == "escalated", res
    assert res["to_share"] > res["from_share"]
    assert replicate.current_directive(paths=paths)["share"] <= 0.5


def test_replicas_that_collapse_are_reverted_and_logged_as_a_fluke(paths):
    replicate.detect_cycle(paths=paths, now="2026-07-25T20:00:00Z")
    db = base_corpus()
    for i, v in enumerate([90, 80]):  # well under the tiktok median -> the win was noise
        db["posts"].append(_post(f"rep{i}", "tiktok", v, ODD, scheduled_at="2026-07-25T23:00:00Z",
                                 as_of="2026-07-26T21:00:00Z"))
    paths["ab_database"].write_text(json.dumps(db), encoding="utf-8")
    res = replicate.evaluate_escalation(paths=paths, now="2026-07-26T21:00:00Z")
    assert res["action"] == "reverted", res
    led = json.loads(paths["replication"].read_text())
    assert led["active"] is None
    assert any(h["event"] == "revert_fluke" for h in led["history"])
    assert replicate.current_directive(paths=paths)["active"] is False


def test_escalation_stops_at_the_cap_instead_of_running_away(paths):
    replicate.detect_cycle(paths=paths, now="2026-07-25T20:00:00Z")
    db = base_corpus()
    for i, v in enumerate([1100, 1050]):
        db["posts"].append(_post(f"rep{i}", "tiktok", v, ODD, scheduled_at="2026-07-25T23:00:00Z",
                                 as_of="2026-07-26T21:00:00Z"))
    paths["ab_database"].write_text(json.dumps(db), encoding="utf-8")
    for hour in range(21, 32):  # keep escalating far past what the cap allows
        replicate.evaluate_escalation(paths=paths, now=f"2026-07-{26 + (hour // 24)}T{hour % 24:02d}:00:00Z")
    d = replicate.current_directive(paths=paths)
    assert d["share"] <= 0.5
    assert replicate.replica_count(12, paths=paths) <= 6


def test_manual_revert_closes_the_round_and_is_recorded(paths):
    replicate.detect_cycle(paths=paths, now="2026-07-25T20:00:00Z")
    res = replicate.revert("not on brand", paths=paths, now="2026-07-25T22:00:00Z", actor="tester")
    assert res["action"] == "reverted"
    led = json.loads(paths["replication"].read_text())
    assert led["active"] is None
    entry = [h for h in led["history"] if h["event"] == "revert_manual"][-1]
    assert entry["actor"] == "tester" and entry["reason"] == "not on brand"
    assert replicate.revert(paths=paths)["action"] == "none"  # idempotent


def test_status_is_a_single_read_for_the_dashboard(paths):
    replicate.detect_cycle(paths=paths, now="2026-07-25T20:00:00Z")
    st = replicate.status(paths=paths)
    assert st["enabled"] is True
    assert st["directive"]["active"] is True
    assert st["detection"]["found"] is True
    assert st["matured_posts"] == 15
    assert st["policy"]["winner_share_cap"] == 0.5


# ---------------------------------------------------------------------------
# Guardrail: this engine expresses a preference, it cannot touch posting
# ---------------------------------------------------------------------------
def test_module_imports_no_posting_or_scheduling_path():
    src = Path(replicate.__file__).read_text(encoding="utf-8")
    for forbidden in ("publer", "schedulePost", "requests", "urllib.request", "http.client"):
        assert forbidden not in src, f"replicate.py must not reach {forbidden}"
