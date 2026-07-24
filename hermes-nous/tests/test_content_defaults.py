"""CONTENT-DEFAULTS + arm-deviation tests.

Two halves:
  1. The durable config contract (ab-testing/content-defaults.json) has the new
     baseline defaults + a config-driven promotion policy.
  2. The REAL TypeScript designer applies those defaults: the control/baseline =
     full narration + cliffhanger, and every arm deviates exactly ONE axis. This is
     asserted by shelling the dependency-free introspection probe
     (hermes-nous/bridge/introspect.ts), which imports only node-builtin modules
     (dimensions.ts / rollup.ts / defaults.ts) so it runs with NO node_modules. The
     TS half is skipped if `node` is unavailable; the config + parity half always runs.
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


def _run_probe(sub: str, stdin: str = "") -> dict:
    node = shutil.which("node")
    if not node:
        pytest.skip("node not on PATH — TS introspection probe unavailable")
    if not PROBE.exists():
        pytest.skip(f"probe missing: {PROBE}")
    proc = subprocess.run(
        [node, str(PROBE), sub],
        input=stdin,
        capture_output=True,
        text=True,
        cwd=str(REPO),
        timeout=60,
    )
    assert proc.returncode == 0, f"probe {sub} failed: {proc.stderr or proc.stdout}"
    lines = [ln for ln in proc.stdout.splitlines() if ln.strip()]
    assert lines, "probe produced no output"
    return json.loads(lines[-1])


def _catalog(stdin: str = "") -> list:
    return _run_probe("catalog", stdin)["dimensions"]


# ===========================================================================
# 1) the config contract
# ===========================================================================
def test_content_defaults_file_shape():
    cd = json.loads(CONTENT_DEFAULTS.read_text())
    assert cd["defaults"]["narration"] == "full"
    assert cd["defaults"]["ending"] == "cliffhanger"
    assert cd["defaults"]["mascot"] == "mascot-standard"
    pol = cd["promotion"]
    assert pol["metric_by_dimension"]["mascot"] == "median_views"
    # config-driven metric + threshold + min-sample gate all present
    assert pol["metric"] == "median_eng_rate"
    assert isinstance(pol["min_sample"], int) and pol["min_sample"] >= 1
    assert isinstance(pol["min_abs_improvement_pp"], (int, float))
    assert isinstance(pol["min_rel_improvement"], (int, float))
    assert pol["incumbent_label"] == "control"


def test_python_engine_reads_the_config_contract():
    # the promotion engine resolves the SAME defaults + policy from the file
    defaults = promote.load_defaults(CONTENT_DEFAULTS)
    policy = promote.load_policy(CONTENT_DEFAULTS)
    assert defaults == {"narration": "full", "ending": "cliffhanger", "mascot": "mascot-standard"}
    assert policy["min_sample"] == json.loads(CONTENT_DEFAULTS.read_text())["promotion"]["min_sample"]


# ===========================================================================
# 2) the REAL designer applies the defaults (baseline) + arms deviate one axis
# ===========================================================================
def test_catalog_baseline_is_full_narration_plus_cliffhanger():
    dims = _catalog()
    control = [d for d in dims if d["baseline"]]
    assert len(control) == 1
    c = control[0]
    assert c["dimension"] == "control"
    assert c["narration"] == "full"
    assert c["ending"] == "cliffhanger"
    assert c["reveal"] == "last"  # cliffhanger maps to reveal=last in the composition
    assert c["deviates"] == "none"


def test_catalog_default_arms_not_relisted_as_challengers():
    dims = _catalog()
    labels = {d["arm"] for d in dims}
    # "full" (narration default) and "cliffhanger" (ending default) are the control;
    # they must not appear as their own dimension's challenger arms.
    assert "full" not in labels
    assert "cliffhanger" not in labels


def test_catalog_narration_arms_deviate_only_narration():
    dims = _catalog()
    narr = [d for d in dims if d["dimension"] == "narration"]
    assert {d["arm"] for d in narr} == {"no-narration", "no-question-vo", "no-options-vo"}
    for d in narr:
        assert d["deviates"] == "narration"
        assert d["narration"] != "full"       # narration axis deviates
        assert d["ending"] == "cliffhanger"   # ending stays the default
        assert d["reveal"] == "last"


def test_catalog_ending_arms_deviate_only_ending():
    dims = _catalog()
    ending = [d for d in dims if d["dimension"] == "ending"]
    assert {d["arm"] for d in ending} == {"full-reveal", "no-answer"}
    for d in ending:
        assert d["deviates"] == "ending"
        assert d["narration"] == "full"       # narration stays the default
        assert d["ending"] != "cliffhanger"   # ending axis deviates
    reveal_by_arm = {d["arm"]: d["reveal"] for d in ending}
    assert reveal_by_arm["full-reveal"] == "all"
    assert reveal_by_arm["no-answer"] == "none"


def test_catalog_other_arms_keep_both_defaults():
    dims = _catalog()
    others = [d for d in dims if d["deviates"] == "other"]
    assert others, "expected other single-axis dimensions (tempo/length/etc.)"
    for d in others:
        assert d["narration"] == "full"
        assert d["ending"] == "cliffhanger"


def test_cliffhanger_generalizes_to_one_question_video():
    # DESIGN AMBIGUITY RESOLVED: a 1-question video under the cliffhanger default uses
    # reveal="last", which the composition collapses to "withhold that single verdict
    # + comment-CTA" (willReveal(last of 1) == false). So cliffhanger is coherent at
    # any question count.
    dims = _catalog()
    one_q = [d for d in dims if d["arm"] == "one-question"]
    assert len(one_q) == 1
    d = one_q[0]
    assert d["numQ"] == 1
    assert d["ending"] == "cliffhanger"
    assert d["reveal"] == "last"


def test_catalog_reflects_a_flipped_default():
    # preview the catalog under a HYPOTHETICAL promoted default (narration->no-narration):
    # control becomes music-only, and the OLD default 'full' becomes a testable arm.
    dims = _catalog(json.dumps({"narration": "no-narration", "ending": "cliffhanger"}))
    control = [d for d in dims if d["baseline"]][0]
    assert control["narration"] == "none"
    narr_arms = {d["arm"] for d in dims if d["dimension"] == "narration"}
    assert "full" in narr_arms          # old default is now a challenger
    assert "no-narration" not in narr_arms  # new default is the control, not an arm


# ===========================================================================
# TS <-> Python arm-label parity (prevents drift between designer + promoter)
# ===========================================================================
def test_arm_labels_match_python_promotion_universe():
    dims = _catalog()
    narr = {d["arm"] for d in dims if d["dimension"] == "narration"}
    ending = {d["arm"] for d in dims if d["dimension"] == "ending"}
    # the TS challenger arms == the Python arm universe minus the current default
    assert narr == set(promote.PROMOTABLE_DIMENSIONS["narration"]) - {"full"}
    assert ending == set(promote.PROMOTABLE_DIMENSIONS["ending"]) - {"cliffhanger"}


# ===========================================================================
# the arm-level rollup the promotion read-side consumes (score.ts computeRollups)
# ===========================================================================
def test_by_variant_arm_rollup_groups_and_excludes_pending():
    posts = [
        {"variant": {"label": "control"}, "platform": "tiktok", "metrics": {"eng_rate": 3.0, "reach": 100, "source": "api"}},
        {"variant": {"label": "control"}, "platform": "tiktok", "metrics": {"eng_rate": 3.0, "reach": 100, "source": "api"}},
        {"variant": {"label": "full-reveal"}, "platform": "tiktok", "metrics": {"eng_rate": 6.0, "reach": 120, "source": "api"}},
        {"variant": {"label": "full-reveal"}, "platform": "tiktok", "metrics": {"eng_rate": 99.0, "source": "pending"}},
    ]
    out = _run_probe("rollups", json.dumps(posts))
    by_arm = out["rollups"]["by_variant_arm"]
    assert by_arm["control"]["n_with_metrics"] == 2
    assert by_arm["control"]["median_eng_rate"] == 3.0
    assert by_arm["full-reveal"]["n_posts"] == 2
    assert by_arm["full-reveal"]["n_with_metrics"] == 1  # pending excluded
    assert by_arm["full-reveal"]["median_eng_rate"] == 6.0


# ===========================================================================
# MASCOT dimension (Part B) -- first-class + promotable, measured on views/reach
# ===========================================================================
def test_mascot_in_python_promotion_universe():
    assert "mascot" in promote.PROMOTABLE_DIMENSIONS
    assert set(promote.PROMOTABLE_DIMENSIONS["mascot"]) == {"mascot-standard", "mascot-absent", "mascot-prominent"}
    assert promote.FALLBACK_DEFAULTS["mascot"] == "mascot-standard"
    # measured PRIMARILY on views (the user's hypothesis metric), not eng_rate.
    assert promote.DIMENSION_METRIC["mascot"] == "median_views"


def test_mascot_catalog_arms_deviate_only_mascot():
    dims = _catalog()
    mascot = [d for d in dims if d["dimension"] == "mascot"]
    assert {d["arm"] for d in mascot} == {"mascot-absent", "mascot-prominent"}
    for d in mascot:
        assert d["deviates"] == "mascot"
        assert d["narration"] == "full"       # keeps the narration default
        assert d["ending"] == "cliffhanger"   # keeps the ending default
    labels = {d["arm"] for d in dims}
    assert "mascot-standard" not in labels  # the default is never re-listed as a challenger


def test_mascot_promotes_on_views_not_eng_rate():
    # A mascot challenger with MORE median_views (but WORSE eng_rate) must still be
    # detected -- the mascot dimension is judged on views, its hypothesis metric.
    by_arm = {
        "control": {"n_posts": 8, "n_with_metrics": 8, "median_eng_rate": 9.0, "median_views": 100, "median_reach": 90},
        "mascot-prominent": {"n_posts": 8, "n_with_metrics": 8, "median_eng_rate": 2.0, "median_views": 200, "median_reach": 180},
    }
    cands = promote.detect_candidates({"rollups": {"by_variant_arm": by_arm}}, promote.FALLBACK_DEFAULTS, dict(promote.FALLBACK_POLICY))
    mascot = [c for c in cands if c["dimension"] == "mascot"]
    assert len(mascot) == 1
    assert mascot[0]["recommended_default"] == "mascot-prominent"
    assert mascot[0]["metric"] == "median_views"
    # no eng_rate winners present, so mascot is the only candidate.
    assert all(c["dimension"] == "mascot" for c in cands)
