"""Do-not-touch READ-ONLY tools test — proves snapshot/verify validate their args,
run network-free in dry-run, surface violations, and NEVER raise.

No network, no node: imports the pure module (``donottouch``) directly and stubs
the Node bridge via monkeypatch, so the handler logic (dry-run, refusal, success,
violation surfacing) is verified hermetically. A dry-run / bad-arg call must NEVER
reach the bridge (asserted with a spy that fails if called).

These tools are strictly read-only; this suite also cross-checks that a verify
call's snapshot fields never trip the publish/schedule defense-in-depth guard.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

PLUGIN_DIR = Path(__file__).resolve().parents[1] / "sffs"
sys.path.insert(0, str(PLUGIN_DIR))

import donottouch as dt  # noqa: E402
import publish_guard as pg  # noqa: E402


VALID_SNAPSHOT = {
    "scheduled_ids": ["sched1", "sched2"],
    "published_ids": ["pub1"],
    "captured_at": "2026-07-22T00:00:00Z",
}


def _no_bridge(*_a, **_k):
    raise AssertionError("run_node_bridge must NOT be called on a dry-run / refused path")


# ---------------------------------------------------------------------------
# validate_snapshot — pure arg guard
# ---------------------------------------------------------------------------


def test_validate_snapshot_valid():
    out = dt.validate_snapshot(dict(VALID_SNAPSHOT))
    assert out["scheduled_ids"] == ["sched1", "sched2"]
    assert out["published_ids"] == ["pub1"]
    assert out["captured_at"] == "2026-07-22T00:00:00Z"


def test_validate_snapshot_captured_at_optional():
    out = dt.validate_snapshot({"scheduled_ids": [], "published_ids": []})
    assert out["scheduled_ids"] == []
    assert "captured_at" not in out


@pytest.mark.parametrize(
    "bad",
    [
        None,
        42,
        "nope",
        [],
        {},                                             # missing both fields
        {"scheduled_ids": ["a"]},                       # missing published_ids
        {"published_ids": ["a"]},                       # missing scheduled_ids
        {"scheduled_ids": "a", "published_ids": []},    # not a list
        {"scheduled_ids": [1, 2], "published_ids": []}, # non-string members
        {"scheduled_ids": [], "published_ids": [None]}, # non-string members
    ],
)
def test_validate_snapshot_rejects_bad(bad):
    with pytest.raises(dt.DoNotTouchError):
        dt.validate_snapshot(bad)


# ---------------------------------------------------------------------------
# sffs_donottouch_snapshot — READ-ONLY, dry-run is network-free
# ---------------------------------------------------------------------------


def test_snapshot_dry_run_makes_no_network_call(monkeypatch):
    monkeypatch.setattr(dt, "run_node_bridge", _no_bridge)
    out = dt.sffs_donottouch_snapshot({"dry_run": True})
    data = json.loads(out)
    assert data["ok"] is True
    assert data["dry_run"] is True


def test_snapshot_live_success(monkeypatch):
    captured = {}

    def fake_bridge(subcommand, stdin_obj=None, *, dry_run, timeout=120):
        captured["sub"] = subcommand
        captured["dry_run"] = dry_run
        return {"ok": True, "snapshot": VALID_SNAPSHOT}

    monkeypatch.setattr(dt, "run_node_bridge", fake_bridge)
    out = dt.sffs_donottouch_snapshot({})
    data = json.loads(out)
    assert data["ok"] is True
    assert data["snapshot"] == VALID_SNAPSHOT
    assert captured == {"sub": "snapshot", "dry_run": False}


def test_snapshot_live_error_is_reported_not_raised(monkeypatch):
    def boom(*_a, **_k):
        raise dt.DoNotTouchError("bridge failed (exit 1): network down")

    monkeypatch.setattr(dt, "run_node_bridge", boom)
    out = dt.sffs_donottouch_snapshot({})
    data = json.loads(out)
    assert data["ok"] is False
    assert "network down" in data["error"]


# ---------------------------------------------------------------------------
# sffs_donottouch_verify — READ-ONLY, validates + surfaces violations
# ---------------------------------------------------------------------------


def test_verify_missing_snapshot_refused_without_bridge(monkeypatch):
    monkeypatch.setattr(dt, "run_node_bridge", _no_bridge)
    out = dt.sffs_donottouch_verify({})
    data = json.loads(out)
    assert data["ok"] is False
    assert "snapshot" in data["error"].lower()


def test_verify_bad_snapshot_refused_without_bridge(monkeypatch):
    monkeypatch.setattr(dt, "run_node_bridge", _no_bridge)
    out = dt.sffs_donottouch_verify({"snapshot": {"scheduled_ids": "notalist", "published_ids": []}})
    data = json.loads(out)
    assert data["ok"] is False


def test_verify_dry_run_validates_shape_no_network(monkeypatch):
    monkeypatch.setattr(dt, "run_node_bridge", _no_bridge)
    out = dt.sffs_donottouch_verify({"snapshot": dict(VALID_SNAPSHOT), "dry_run": True})
    data = json.loads(out)
    assert data["ok"] is True
    assert data["dry_run"] is True
    assert data["verified"] is None
    assert data["counts"] == {"scheduled": 2, "published": 1}


def test_verify_live_success(monkeypatch):
    captured = {}

    def fake_bridge(subcommand, stdin_obj=None, *, dry_run, timeout=120):
        captured["sub"] = subcommand
        captured["stdin"] = stdin_obj
        return {"ok": True, "verified": True}

    monkeypatch.setattr(dt, "run_node_bridge", fake_bridge)
    out = dt.sffs_donottouch_verify({"snapshot": dict(VALID_SNAPSHOT)})
    data = json.loads(out)
    assert data["ok"] is True
    assert data["verified"] is True
    assert captured["sub"] == "verify"
    assert captured["stdin"]["scheduled_ids"] == VALID_SNAPSHOT["scheduled_ids"]


def test_verify_live_violation_is_surfaced(monkeypatch):
    def violate(*_a, **_k):
        raise dt.DoNotTouchError(
            'DO-NOT-TOUCH VIOLATION: pre-existing posts changed! missing scheduled=["sched1"]'
        )

    monkeypatch.setattr(dt, "run_node_bridge", violate)
    out = dt.sffs_donottouch_verify({"snapshot": dict(VALID_SNAPSHOT)})
    data = json.loads(out)
    assert data["ok"] is False
    assert data["violation"] is True
    assert "VIOLATION" in data["error"]


def test_verify_live_generic_error_not_marked_violation(monkeypatch):
    def boom(*_a, **_k):
        raise dt.DoNotTouchError("bridge failed (exit 1): timeout")

    monkeypatch.setattr(dt, "run_node_bridge", boom)
    out = dt.sffs_donottouch_verify({"snapshot": dict(VALID_SNAPSHOT)})
    data = json.loads(out)
    assert data["ok"] is False
    assert data.get("violation") is False


@pytest.mark.parametrize("garbage", [None, 42, "nope", [], {"snapshot": 5}, {"snapshot": None}])
def test_handlers_never_raise_on_garbage(monkeypatch, garbage):
    monkeypatch.setattr(dt, "run_node_bridge", _no_bridge)
    # snapshot: garbage (non-dict) would default dry_run False; stub bridge would
    # fail the test if reached, so also pass explicit dry_run for the non-dict case.
    s = dt.sffs_donottouch_snapshot(garbage if isinstance(garbage, dict) else {"dry_run": True})
    assert isinstance(s, str) and "ok" in json.loads(s)
    v = dt.sffs_donottouch_verify(garbage)
    assert isinstance(v, str) and json.loads(v)["ok"] is False


# ---------------------------------------------------------------------------
# Cross-check: the read-only tools' args never trip the publish/schedule belt
# ---------------------------------------------------------------------------


def test_donottouch_args_are_not_flagged_by_publish_guard():
    assert pg.refusal_reason("sffs_donottouch_snapshot", {"dry_run": True}) is None
    assert pg.refusal_reason("sffs_donottouch_verify", {"snapshot": dict(VALID_SNAPSHOT)}) is None
