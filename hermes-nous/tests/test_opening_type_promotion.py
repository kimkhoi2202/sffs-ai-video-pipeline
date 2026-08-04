"""test_opening_type_promotion.py — the opening-question-type arms, judged the right way up.

The brief for this experiment says to VERIFY that skip rate is handled correctly for a new
dimension rather than assume it inherits, and the reason is concrete: a recent fix had to
correct several lower-is-better inversions in this path, and on a lower-is-better metric a
plain challenger-minus-incumbent delta promotes the arm with the WORSE hook and reports it
as a win. That failure is silent — the number is real, the sign is not.

These tests drive promote.py's own evaluator with the LIVE policy, so they fail if the
config, the metric, or the direction logic ever moves under this dimension.
"""
import json
import sys
from pathlib import Path

import pytest

PLUGIN_DIR = Path(__file__).resolve().parents[1] / "sffs"
sys.path.insert(0, str(PLUGIN_DIR))

import promote  # noqa: E402

REPO = Path(__file__).resolve().parents[2]
DEFAULTS = REPO / "ab-testing" / "content-defaults.json"

CONCRETE = "open-odd-one-out"
ANALOGY = "open-analogy"
SKIP = "median_skip_rate"


def _cell(median, n):
    return {
        "n_posts": n,
        "n_with_metrics": n,
        "median_skip_rate": median,
        "median_eng_rate": None,
        "median_views": None,
        "median_reach": None,
        "n_by_metric": {"median_skip_rate": n, "median_eng_rate": 0, "median_views": 0, "median_reach": 0},
    }


def _live_policy():
    """The policy the cycle actually runs, not a fixture that could drift from it."""
    return promote.load_policy(DEFAULTS)


def test_the_live_policy_still_judges_this_dimension_on_skip_rate_lower_is_better():
    p = _live_policy()
    assert p["metric"] == SKIP
    assert p["lower_is_better"] is True
    # No per-dimension override may quietly redirect this dimension onto another metric.
    assert promote._metric_for_dimension("opening-question-type", p) == SKIP
    assert promote._lower_is_better(SKIP, p) is True


def test_the_lower_skip_arm_is_the_winner_not_the_higher_one():
    """The inversion, stated as the thing that must not happen."""
    p = dict(_live_policy())
    p.update({"min_sample": 4, "min_abs_improvement_pp": 1.0, "min_rel_improvement": 0.05})

    # concrete opens at 64%, analogy at 74% — concrete has the better hook.
    cand = promote._evaluate_arm(
        "opening-question-type", CONCRETE, ANALOGY, _cell(74.0, 12), _cell(64.0, 12), p
    )
    assert cand is not None, "a 10pp better hook must register as a candidate"
    assert cand["arm"] == CONCRETE
    assert cand["lower_is_better"] is True
    # IMPROVEMENT is signed so positive == better whichever way the metric runs.
    assert cand["delta_abs_pp"] == pytest.approx(10.0)

    # ...and the same comparison the other way round must NOT produce a candidate.
    inverted = promote._evaluate_arm(
        "opening-question-type", ANALOGY, CONCRETE, _cell(64.0, 12), _cell(74.0, 12), p
    )
    assert inverted is None, "the arm with MORE skipping was promoted — direction is inverted"


def test_flipping_the_direction_flag_flips_the_verdict_so_the_flag_is_load_bearing():
    """If lower_is_better ever stopped being read, this dimension would silently invert."""
    p = dict(_live_policy())
    p.update({"min_sample": 4, "min_abs_improvement_pp": 1.0, "min_rel_improvement": 0.05})
    higher = dict(p)
    higher["lower_is_better"] = False

    assert promote._evaluate_arm("opening-question-type", CONCRETE, ANALOGY, _cell(74.0, 12), _cell(64.0, 12), p)
    assert promote._evaluate_arm("opening-question-type", CONCRETE, ANALOGY, _cell(74.0, 12), _cell(64.0, 12), higher) is None


def test_min_sample_counts_the_metric_being_judged_not_merely_matured_posts():
    """A cell with 12 matured posts but 3 skip rates must not promote on 3."""
    p = dict(_live_policy())
    p.update({"min_sample": 12, "min_abs_improvement_pp": 1.0, "min_rel_improvement": 0.05})
    thin = _cell(64.0, 12)
    thin["n_by_metric"]["median_skip_rate"] = 3
    assert promote._evaluate_arm("opening-question-type", CONCRETE, ANALOGY, _cell(74.0, 12), thin, p) is None


def test_the_dimension_is_deliberately_not_auto_promotable_yet():
    """Read-only on purpose, and pinned so the choice is visible rather than forgotten.

    Auto-promotion is stood down account-wide, and there is no content-defaults axis for
    "which type opens a video" for a promotion to flip. The rollup is written where the
    engine reads it (by_variant_arm / by_opening_type) so a human and the dashboard can
    read the result; wiring it into PROMOTABLE_DIMENSIONS is a separate, deliberate step
    that needs a default axis to exist first.
    """
    assert "opening-question-type" not in promote.PROMOTABLE_DIMENSIONS
    assert json.loads(DEFAULTS.read_text())["auto_promotion"]["enabled"] is False
