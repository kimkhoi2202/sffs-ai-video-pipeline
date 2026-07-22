"""QUESTIONS tool test — proves sffs_questions validates its args, runs network-free
in dry-run, surfaces errors as results (never raises), and that its args are NOT
flagged by the framework's publish/schedule defense-in-depth guard.

No network, no node: imports the pure module (``questions``) directly and stubs the
Node bridge via monkeypatch. A dry-run / bad-arg call must NEVER reach the bridge
(asserted with a spy that fails if called).

This tool is deliberately READ-ONLY selection: it wraps candidateQuestions +
bankStats and NEVER markUsed, so it cannot mutate the never-repeat ledger. That is
a structural property of the Node bridge (imports), reinforced here at the arg layer.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

PLUGIN_DIR = Path(__file__).resolve().parents[1] / "sffs"
sys.path.insert(0, str(PLUGIN_DIR))

import publish_guard as pg  # noqa: E402
import questions  # noqa: E402


def _no_bridge(*_a, **_k):
    raise AssertionError("run_node_bridge must NOT be called on a dry-run / refused path")


# ===========================================================================
# build_questions_request — pure arg guard
# ===========================================================================


def test_defaults_to_candidates():
    req = questions.build_questions_request({})
    assert req == {"sub": "candidates", "params": {}}


def test_stats_explicit():
    assert questions.build_questions_request({"what": "stats"}) == {"sub": "stats", "params": None}


def test_candidates_full_normalizes():
    req = questions.build_questions_request(
        {
            "what": "candidates",
            "category": "Verbal",       # case-normalized
            "kinds": ["Text", "numseries"],
            "seed": "  2026-07-22:narration  ",
            "exclude": ["s1", "s2"],
            "limit": 5,
        }
    )
    assert req["sub"] == "candidates"
    assert req["params"] == {
        "category": "verbal",
        "kinds": ["text", "numseries"],
        "seed": "2026-07-22:narration",
        "exclude": ["s1", "s2"],
        "limit": 5,
    }


def test_candidates_mixed_category_is_no_filter():
    # "mixed" means no category filter -> not forwarded to the bridge
    req = questions.build_questions_request({"what": "candidates", "category": "mixed"})
    assert "category" not in req["params"]


@pytest.mark.parametrize("kind", ["text", "numseries"])
def test_candidates_accepts_each_kind(kind):
    req = questions.build_questions_request({"what": "candidates", "kinds": [kind]})
    assert req["params"]["kinds"] == [kind]


@pytest.mark.parametrize(
    "bad",
    [
        {"what": "mark_used"},                                 # unknown what
        {"what": "candidates", "category": "history"},         # not a bank category
        {"what": "candidates", "category": 5},                 # not a string
        {"what": "candidates", "kinds": []},                   # empty list
        {"what": "candidates", "kinds": "text"},               # not a list
        {"what": "candidates", "kinds": ["shaded"]},           # not headless-renderable
        {"what": "candidates", "kinds": ["text", 5]},          # non-string member
        {"what": "candidates", "seed": 5},                     # not a string
        {"what": "candidates", "exclude": "s1"},               # not a list
        {"what": "candidates", "exclude": [1]},                # non-string member
        {"what": "candidates", "exclude": ["", "a"]},          # empty member
        {"what": "candidates", "limit": 0},                    # must be >= 1
        {"what": "candidates", "limit": 201},                  # exceeds max
        {"what": "candidates", "limit": -3},                   # negative
        {"what": "candidates", "limit": True},                 # bool is not int
        {"what": "candidates", "limit": "5"},                  # not an int
        "nope",                                                # not a dict
        None,
    ],
)
def test_questions_request_rejects_bad(bad):
    with pytest.raises(questions.QuestionsGuardError):
        questions.build_questions_request(bad)


# ===========================================================================
# sffs_questions handler — dry-run is network-free; live passes params
# ===========================================================================


def test_candidates_dry_run_makes_no_network_call(monkeypatch):
    monkeypatch.setattr(questions, "run_node_bridge", _no_bridge)
    out = questions.sffs_questions({"what": "candidates", "category": "verbal", "dry_run": True})
    data = json.loads(out)
    assert data["ok"] is True and data["dry_run"] is True
    assert data["what"] == "candidates"


def test_stats_dry_run_makes_no_network_call(monkeypatch):
    monkeypatch.setattr(questions, "run_node_bridge", _no_bridge)
    out = questions.sffs_questions({"what": "stats", "dry_run": True})
    data = json.loads(out)
    assert data["ok"] is True and data["dry_run"] is True
    assert data["what"] == "stats"


def test_candidates_live_success_defaults_limit(monkeypatch):
    captured = {}

    def fake_bridge(subcommand, stdin_obj=None, *, dry_run, timeout=60):
        captured["sub"] = subcommand
        captured["stdin"] = stdin_obj
        return {"ok": True, "sub": "candidates", "count": 3, "total_fresh": 900, "questions": [{"sig": "a"}]}

    monkeypatch.setattr(questions, "run_node_bridge", fake_bridge)
    out = questions.sffs_questions({"what": "candidates", "category": "verbal"})
    data = json.loads(out)
    assert data["ok"] is True and data["total_fresh"] == 900
    assert captured["sub"] == "candidates"
    assert captured["stdin"]["category"] == "verbal"
    assert captured["stdin"]["limit"] == 20  # handler-filled default


def test_candidates_live_respects_explicit_limit(monkeypatch):
    captured = {}

    def fake_bridge(subcommand, stdin_obj=None, *, dry_run, timeout=60):
        captured["stdin"] = stdin_obj
        return {"ok": True, "sub": "candidates", "count": 1, "total_fresh": 5, "questions": []}

    monkeypatch.setattr(questions, "run_node_bridge", fake_bridge)
    questions.sffs_questions({"what": "candidates", "limit": 3})
    assert captured["stdin"]["limit"] == 3


def test_stats_live_success(monkeypatch):
    captured = {}

    def fake_bridge(subcommand, stdin_obj=None, *, dry_run, timeout=60):
        captured["sub"] = subcommand
        captured["stdin"] = stdin_obj
        return {"ok": True, "sub": "stats", "stats": {"total": 1500, "usable": 1200, "fresh": 1100, "used": 100}}

    monkeypatch.setattr(questions, "run_node_bridge", fake_bridge)
    out = questions.sffs_questions({"what": "stats"})
    data = json.loads(out)
    assert data["ok"] is True and data["stats"]["fresh"] == 1100
    assert captured["sub"] == "stats"
    assert captured["stdin"] is None  # stats sends no params


def test_bad_args_refused_without_bridge(monkeypatch):
    monkeypatch.setattr(questions, "run_node_bridge", _no_bridge)
    out = questions.sffs_questions({"what": "candidates", "limit": 0})
    data = json.loads(out)
    assert data["ok"] is False
    assert "limit" in data["error"]


def test_live_error_is_reported_not_raised(monkeypatch):
    def boom(*_a, **_k):
        raise questions.QuestionsGuardError("bridge failed (exit 1): bank missing")

    monkeypatch.setattr(questions, "run_node_bridge", boom)
    out = questions.sffs_questions({"what": "stats"})
    data = json.loads(out)
    assert data["ok"] is False
    assert "bank missing" in data["error"]


# ===========================================================================
# Handler NEVER raises on garbage
# ===========================================================================


@pytest.mark.parametrize("garbage", [None, 42, "nope", [], {"what": 5}, {"kinds": 3}, {"exclude": {}}])
def test_handler_never_raises_on_garbage(monkeypatch, garbage):
    monkeypatch.setattr(questions, "run_node_bridge", _no_bridge)
    call = garbage if isinstance(garbage, dict) else {"dry_run": True}
    if isinstance(call, dict):
        call = {**call, "dry_run": True}
    out = questions.sffs_questions(call)
    assert isinstance(out, str) and "ok" in json.loads(out)


# ===========================================================================
# Cross-check: the QUESTIONS tool's args are NEVER flagged by the publish/schedule
# defense-in-depth guard (selecting questions is not a posting action).
# ===========================================================================


def test_questions_tool_args_are_not_flagged_by_publish_guard():
    assert pg.refusal_reason("sffs_questions", {"what": "stats"}) is None
    assert pg.refusal_reason("sffs_questions", {"what": "candidates", "category": "verbal", "limit": 10}) is None
    assert pg.refusal_reason("sffs_questions", {"what": "candidates", "exclude": ["s1", "s2"]}) is None


def test_guard_would_still_block_a_real_publish():
    assert pg.refusal_reason("publer_publish_post_now", {}) is not None
    assert pg.refusal_reason("sffs_publer_draft", {"scheduled_at": "2026-07-22T10:00:00Z"}) is not None
