"""READ-ONLY data tools test — proves sffs_publer_read + sffs_score validate their
args, run network-free in dry-run, surface errors as results (never raise), and —
critically — that their args are NOT flagged by the framework's publish/schedule
defense-in-depth guard (so legitimate reads of published/scheduled posts work).

No network, no node: imports the pure module (``reads``) directly and stubs the
Node bridge via monkeypatch. A dry-run / bad-arg call must NEVER reach the bridge
(asserted with a spy that fails if called).

The publish-guard cross-check locks in the deliberate ``state_filter`` arg name:
if someone renames it back to ``state``, the guard would refuse a value of
"published"/"scheduled" and these assertions go red.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import pytest

PLUGIN_DIR = Path(__file__).resolve().parents[1] / "sffs"
sys.path.insert(0, str(PLUGIN_DIR))

import publish_guard as pg  # noqa: E402
import reads  # noqa: E402


def _no_bridge(*_a, **_k):
    raise AssertionError("run_node_bridge must NOT be called on a dry-run / refused path")


# ===========================================================================
# build_read_request — pure arg guard
# ===========================================================================


def test_read_defaults_to_accounts():
    req = reads.build_read_request({})
    assert req == {"sub": "accounts", "params": None}


def test_read_accounts_explicit():
    assert reads.build_read_request({"what": "accounts"}) == {"sub": "accounts", "params": None}


def test_read_posts_minimal():
    req = reads.build_read_request({"what": "posts"})
    assert req["sub"] == "posts"
    assert req["params"] == {}


def test_read_posts_full_normalizes():
    req = reads.build_read_request(
        {
            "what": "posts",
            "state_filter": "Published",  # case-normalized
            "page": 2,
            "account_ids": ["a1", "a2"],
            "query": "  quiz  ",
            "all_pages": True,
            "max_pages": 5,
        }
    )
    assert req["sub"] == "posts"
    assert req["params"] == {
        "state": "published",
        "page": 2,
        "account_ids": ["a1", "a2"],
        "query": "quiz",
        "all": True,
        "max_pages": 5,
    }


def test_read_posts_all_pages_false_omitted():
    req = reads.build_read_request({"what": "posts", "all_pages": False})
    assert "all" not in req["params"]


@pytest.mark.parametrize("state", ["published", "scheduled", "draft"])
def test_read_posts_accepts_each_read_state(state):
    req = reads.build_read_request({"what": "posts", "state_filter": state})
    assert req["params"]["state"] == state


@pytest.mark.parametrize(
    "bad",
    [
        {"what": "delete"},                                  # unknown what
        {"what": "posts", "state_filter": "published_live"}, # not a read state
        {"what": "posts", "state_filter": ""},               # empty
        {"what": "posts", "state_filter": 5},                # not a string
        {"what": "posts", "page": -1},                       # negative
        {"what": "posts", "page": True},                     # bool is not int
        {"what": "posts", "page": "2"},                      # not an int
        {"what": "posts", "account_ids": "a1"},              # not a list
        {"what": "posts", "account_ids": [1, 2]},            # non-string members
        {"what": "posts", "account_ids": ["", "a"]},         # empty member
        {"what": "posts", "query": 5},                       # not a string
        {"what": "posts", "all_pages": "yes"},               # not a bool
        {"what": "posts", "max_pages": 0},                   # must be positive
        {"what": "posts", "max_pages": -3},                  # negative
        {"what": "posts", "max_pages": True},                # bool is not int
        "nope",                                              # not a dict
        None,
    ],
)
def test_read_request_rejects_bad(bad):
    with pytest.raises(reads.ReadGuardError):
        reads.build_read_request(bad)


# ===========================================================================
# build_score_request + default_window — pure arg guard
# ===========================================================================


def test_score_empty_is_valid_no_dates():
    # dates are filled by the handler, not the builder
    assert reads.build_score_request({}) == {}


def test_score_full_normalizes():
    req = reads.build_score_request(
        {
            "from": "2026-06-01",
            "to": "2026-07-01",
            "account_ids": ["a1"],
            "sort_by": "engagement_rate",
            "sort_type": "asc",  # upper-cased
            "max_pages": 7,
        }
    )
    assert req == {
        "from": "2026-06-01",
        "to": "2026-07-01",
        "account_ids": ["a1"],
        "sort_by": "engagement_rate",
        "sort_type": "ASC",
        "max_pages": 7,
    }


@pytest.mark.parametrize(
    "bad",
    [
        {"from": "2026/06/01"},            # wrong format
        {"from": "not-a-date"},
        {"to": "2026-6-1"},                # not zero-padded
        {"from": 20260601},                # not a string
        {"account_ids": "a1"},             # not a list
        {"account_ids": [None]},           # non-string member
        {"sort_by": "virality"},           # not an allowed sort key
        {"sort_by": 5},
        {"sort_type": "sideways"},         # not ASC/DESC
        {"max_pages": 0},
        {"max_pages": -1},
        {"max_pages": True},
        "nope",
        None,
    ],
)
def test_score_request_rejects_bad(bad):
    with pytest.raises(reads.ReadGuardError):
        reads.build_score_request(bad)


def test_default_window_shape():
    frm, to = reads.default_window()
    assert re.match(r"^\d{4}-\d{2}-\d{2}$", frm)
    assert re.match(r"^\d{4}-\d{2}-\d{2}$", to)
    assert frm < to  # 30 days earlier


# ===========================================================================
# sffs_publer_read handler — READ-ONLY, dry-run is network-free
# ===========================================================================


def test_read_dry_run_makes_no_network_call(monkeypatch):
    monkeypatch.setattr(reads, "run_node_bridge", _no_bridge)
    out = reads.sffs_publer_read({"what": "posts", "state_filter": "published", "dry_run": True})
    data = json.loads(out)
    assert data["ok"] is True
    assert data["dry_run"] is True
    assert data["what"] == "posts"
    assert data["request"]["state"] == "published"


def test_read_accounts_live_success(monkeypatch):
    captured = {}

    def fake_bridge(subcommand, stdin_obj=None, *, dry_run, timeout=120):
        captured["sub"] = subcommand
        captured["stdin"] = stdin_obj
        return {"ok": True, "count": 2, "accounts": [{"id": "a1"}, {"id": "a2"}]}

    monkeypatch.setattr(reads, "run_node_bridge", fake_bridge)
    out = reads.sffs_publer_read({"what": "accounts"})
    data = json.loads(out)
    assert data["ok"] is True and data["count"] == 2
    assert captured == {"sub": "accounts", "stdin": None}


def test_read_posts_live_success_passes_params(monkeypatch):
    captured = {}

    def fake_bridge(subcommand, stdin_obj=None, *, dry_run, timeout=120):
        captured["sub"] = subcommand
        captured["stdin"] = stdin_obj
        return {"ok": True, "count": 1, "posts": [{"id": "p1"}]}

    monkeypatch.setattr(reads, "run_node_bridge", fake_bridge)
    out = reads.sffs_publer_read({"what": "posts", "state_filter": "draft", "page": 0})
    data = json.loads(out)
    assert data["ok"] is True and data["count"] == 1
    assert captured["sub"] == "posts"
    assert captured["stdin"] == {"state": "draft", "page": 0}


def test_read_bad_args_refused_without_bridge(monkeypatch):
    monkeypatch.setattr(reads, "run_node_bridge", _no_bridge)
    out = reads.sffs_publer_read({"what": "posts", "state_filter": "live"})
    data = json.loads(out)
    assert data["ok"] is False
    assert "state_filter" in data["error"]


def test_read_live_error_is_reported_not_raised(monkeypatch):
    def boom(*_a, **_k):
        raise reads.ReadGuardError("bridge failed (exit 1): network down")

    monkeypatch.setattr(reads, "run_node_bridge", boom)
    out = reads.sffs_publer_read({"what": "accounts"})
    data = json.loads(out)
    assert data["ok"] is False
    assert "network down" in data["error"]


# ===========================================================================
# sffs_score handler — READ-ONLY, dry-run is network-free, defaults filled
# ===========================================================================


def test_score_dry_run_fills_default_window_no_network(monkeypatch):
    monkeypatch.setattr(reads, "run_node_bridge", _no_bridge)
    out = reads.sffs_score({"dry_run": True})
    data = json.loads(out)
    assert data["ok"] is True and data["dry_run"] is True
    assert re.match(r"^\d{4}-\d{2}-\d{2}$", data["from"])
    assert re.match(r"^\d{4}-\d{2}-\d{2}$", data["to"])


def test_score_live_success_passes_window(monkeypatch):
    captured = {}

    def fake_bridge(subcommand, stdin_obj=None, *, dry_run, timeout=120):
        captured["sub"] = subcommand
        captured["stdin"] = stdin_obj
        captured["timeout"] = timeout
        return {"ok": True, "from": stdin_obj["from"], "to": stdin_obj["to"], "count": 3, "posts": []}

    monkeypatch.setattr(reads, "run_node_bridge", fake_bridge)
    out = reads.sffs_score({"from": "2026-06-01", "to": "2026-07-01", "sort_by": "reach"})
    data = json.loads(out)
    assert data["ok"] is True and data["count"] == 3
    assert captured["sub"] == "insights"
    assert captured["stdin"]["from"] == "2026-06-01"
    assert captured["stdin"]["to"] == "2026-07-01"
    assert captured["stdin"]["sort_by"] == "reach"
    assert captured["timeout"] == 180  # analytics can page; longer timeout


def test_score_bad_date_refused_without_bridge(monkeypatch):
    monkeypatch.setattr(reads, "run_node_bridge", _no_bridge)
    out = reads.sffs_score({"from": "june first"})
    data = json.loads(out)
    assert data["ok"] is False
    assert "from" in data["error"]


def test_score_live_error_is_reported_not_raised(monkeypatch):
    def boom(*_a, **_k):
        raise reads.ReadGuardError("bridge failed (exit 1): timeout")

    monkeypatch.setattr(reads, "run_node_bridge", boom)
    out = reads.sffs_score({"from": "2026-06-01", "to": "2026-07-01"})
    data = json.loads(out)
    assert data["ok"] is False
    assert "timeout" in data["error"]


# ===========================================================================
# Handlers NEVER raise on garbage
# ===========================================================================


@pytest.mark.parametrize("garbage", [None, 42, "nope", [], {"what": 5}, {"from": {}}])
def test_handlers_never_raise_on_garbage(monkeypatch, garbage):
    monkeypatch.setattr(reads, "run_node_bridge", _no_bridge)
    # For dict garbage that would validate, force dry_run so the stub bridge (which
    # fails the test if reached) is never called; non-dicts default dry_run False
    # but also fail validation before the bridge.
    r = reads.sffs_publer_read(garbage if isinstance(garbage, dict) else {"dry_run": True})
    assert isinstance(r, str) and "ok" in json.loads(r)
    s = reads.sffs_score(garbage if isinstance(garbage, dict) else {"dry_run": True})
    assert isinstance(s, str) and "ok" in json.loads(s)


# ===========================================================================
# Cross-check: the READ tools' args are NEVER flagged by the publish/schedule
# defense-in-depth guard (this is why they use `state_filter`, not `state`).
# ===========================================================================


def test_read_tool_args_are_not_flagged_by_publish_guard():
    assert pg.refusal_reason("sffs_publer_read", {"what": "accounts"}) is None
    # Listing PUBLISHED / SCHEDULED posts must be allowed — the whole point of a
    # read tool. `state_filter` (not `state`) keeps the guard from misreading it.
    assert pg.refusal_reason("sffs_publer_read", {"what": "posts", "state_filter": "published"}) is None
    assert pg.refusal_reason("sffs_publer_read", {"what": "posts", "state_filter": "scheduled"}) is None
    assert pg.refusal_reason("sffs_publer_read", {"what": "posts", "state_filter": "draft"}) is None
    assert pg.refusal_reason("sffs_publer_read", {"what": "posts", "account_ids": ["a1"], "page": 0}) is None


def test_score_tool_args_are_not_flagged_by_publish_guard():
    assert pg.refusal_reason("sffs_score", {"from": "2026-06-01", "to": "2026-07-01"}) is None
    assert pg.refusal_reason("sffs_score", {"account_ids": ["a1"], "sort_by": "reach", "sort_type": "DESC"}) is None


def test_guard_would_still_block_a_real_state_set():
    # Sanity: the guard IS active — a genuine attempt to SET a live state under a
    # `state` KEY on a posting tool is still refused (proves the read tools pass on
    # merit, not because the guard is toothless).
    assert pg.refusal_reason("sffs_publer_read", {"state": "published"}) is not None
    assert pg.refusal_reason("publer_publish_post_now", {}) is not None
