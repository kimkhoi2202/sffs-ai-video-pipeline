"""RECONCILE tool test — proves sffs_reconcile validates its (tiny) args, runs
subprocess-free in dry-run (no network, no file write), surfaces errors as results
(never raises), and that its args are NOT flagged by the framework's publish/
schedule defense-in-depth guard while a real publish still is.

No network, no node, no Hermes framework: imports the pure module (``reconcile``)
directly and stubs the Node bridge via monkeypatch. A dry-run / bad-arg call must
NEVER reach the bridge (asserted with a spy that fails if called).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

PLUGIN_DIR = Path(__file__).resolve().parents[1] / "sffs"
sys.path.insert(0, str(PLUGIN_DIR))

import reconcile as rc  # noqa: E402
import publish_guard as pg  # noqa: E402


def _no_bridge(*_a, **_k):
    raise AssertionError("run_node_bridge must NOT be called on a dry-run / refused path")


# ===========================================================================
# build_reconcile_request — pure arg guard
# ===========================================================================


def test_defaults_to_dry_run():
    req = rc.build_reconcile_request({})
    assert req["dry_run"] is True
    assert req["data_dir"] is None


def test_explicit_live_and_data_dir():
    req = rc.build_reconcile_request({"dry_run": False, "data_dir": "/tmp/d"})
    assert req["dry_run"] is False and req["data_dir"] == "/tmp/d"


def test_data_dir_trimmed():
    req = rc.build_reconcile_request({"data_dir": "  /tmp/dd  "})
    assert req["data_dir"] == "/tmp/dd"


@pytest.mark.parametrize(
    "bad",
    [
        None,                       # not a dict
        "nope",                     # not a dict
        123,                        # not a dict
        {"dry_run": "yes"},         # dry_run not bool
        {"dry_run": 1},             # dry_run not bool (int)
        {"data_dir": ""},           # empty data_dir
        {"data_dir": "   "},        # whitespace data_dir
        {"data_dir": 5},            # data_dir not string
    ],
)
def test_reconcile_request_rejects_bad(bad):
    with pytest.raises(rc.ReconcileGuardError):
        rc.build_reconcile_request(bad)


# ===========================================================================
# sffs_reconcile handler — dry-run is subprocess-free + write-free
# ===========================================================================


def test_dry_run_default_makes_no_subprocess(monkeypatch):
    monkeypatch.setattr(rc, "run_node_bridge", _no_bridge)
    out = rc.sffs_reconcile({})  # default dry_run True
    data = json.loads(out)
    assert data["ok"] is True and data["dry_run"] is True
    assert "wrote no files" in data["note"]
    assert "back-fill" in data["note"]


def test_dry_run_explicit_makes_no_subprocess(monkeypatch):
    monkeypatch.setattr(rc, "run_node_bridge", _no_bridge)
    out = rc.sffs_reconcile({"dry_run": True})
    assert json.loads(out)["dry_run"] is True


def test_live_run_calls_bridge_and_returns_result(monkeypatch):
    captured = {}

    def fake_bridge(*, dry_run, data_dir=None, timeout=240):
        captured["dry_run"] = dry_run
        captured["data_dir"] = data_dir
        return {
            "ok": True,
            "records": 42,
            "matched": 5,
            "records_changed": 3,
            "filled": {"platform_post_id": 3, "permalink": 3, "posted_at": 2},
            "note": "back-filled 3 record(s)",
        }

    monkeypatch.setattr(rc, "run_node_bridge", fake_bridge)
    out = rc.sffs_reconcile({"dry_run": False, "data_dir": "/tmp/dd"})
    data = json.loads(out)
    assert data["ok"] is True and data["records_changed"] == 3
    assert data["filled"]["platform_post_id"] == 3
    assert captured["dry_run"] is False
    assert captured["data_dir"] == "/tmp/dd"


def test_bad_args_refused_without_bridge(monkeypatch):
    monkeypatch.setattr(rc, "run_node_bridge", _no_bridge)
    out = rc.sffs_reconcile({"dry_run": "nope"})
    data = json.loads(out)
    assert data["ok"] is False and "dry_run" in data["error"]


def test_live_error_is_reported_not_raised(monkeypatch):
    def boom(*_a, **_k):
        raise rc.ReconcileGuardError("bridge failed (exit 1): publer 401")

    monkeypatch.setattr(rc, "run_node_bridge", boom)
    out = rc.sffs_reconcile({"dry_run": False})
    data = json.loads(out)
    assert data["ok"] is False and "publer 401" in data["error"]


def test_non_object_bridge_result_is_error(monkeypatch):
    monkeypatch.setattr(rc, "run_node_bridge", lambda *a, **k: ["nope"])
    out = rc.sffs_reconcile({"dry_run": False})
    data = json.loads(out)
    assert data["ok"] is False and "non-object" in data["error"]


@pytest.mark.parametrize("garbage", [None, 42, "nope", [], {"dry_run": 3}, {"data_dir": 9}])
def test_handler_never_raises_on_garbage(monkeypatch, garbage):
    monkeypatch.setattr(rc, "run_node_bridge", _no_bridge)
    out = rc.sffs_reconcile(garbage)
    assert isinstance(out, str)
    assert "ok" in json.loads(out)


# ===========================================================================
# _bridge_env — keys + data_dir plumbing (no network)
# ===========================================================================


def test_bridge_env_sets_env_file_from_home(monkeypatch, tmp_path):
    (tmp_path / ".env").write_text("PUBLER_API_KEY=x\n")
    monkeypatch.delenv("HERMES_ENV_FILE", raising=False)
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    env = rc._bridge_env(None)
    assert env["HERMES_ENV_FILE"] == str(tmp_path / ".env")


def test_bridge_env_sets_data_dir(monkeypatch):
    env = rc._bridge_env("/tmp/whatever")
    assert env["HERMES_DATA_DIR"] == "/tmp/whatever"


# ===========================================================================
# Cross-check: the RECONCILE tool's args are NEVER flagged by the publish/
# schedule defense-in-depth guard (back-filling local ids is not a posting
# action), while a genuine publish/schedule is still blocked.
# ===========================================================================


def test_reconcile_tool_args_not_flagged_by_publish_guard():
    for args in ({}, {"dry_run": True}, {"dry_run": False, "data_dir": "/tmp/d"}):
        assert pg.refusal_reason("sffs_reconcile", args) is None


def test_guard_would_still_block_a_real_publish():
    assert pg.refusal_reason("publer_publish_post_now", {}) is not None
    assert pg.refusal_reason("sffs_reconcile", {"scheduled_at": "2026-01-01T00:00:00Z"}) is not None
    assert pg.refusal_reason("publer_update_post", {"post_id": "p1"}) is not None
