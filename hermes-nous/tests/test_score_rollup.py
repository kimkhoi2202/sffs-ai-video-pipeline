"""SCORE-ROLLUP tool test — proves sffs_score_rollup validates its (tiny) args,
runs subprocess-free in dry-run (no network, no file write), surfaces errors as
results (never raises), and that its args are NOT flagged by the framework's
publish/schedule defense-in-depth guard while a real publish still is.

No network, no node, no Hermes framework: imports the pure module (``score_rollup``)
directly and stubs the Node bridge via monkeypatch. A dry-run / bad-arg call must
NEVER reach the bridge (asserted with a spy that fails if called).
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import pytest

PLUGIN_DIR = Path(__file__).resolve().parents[1] / "sffs"
sys.path.insert(0, str(PLUGIN_DIR))

import score_rollup as sr  # noqa: E402
import publish_guard as pg  # noqa: E402

_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _no_bridge(*_a, **_k):
    raise AssertionError("run_node_bridge must NOT be called on a dry-run / refused path")


# ===========================================================================
# build_rollup_request — pure arg guard
# ===========================================================================


def test_defaults_to_dry_run():
    req = sr.build_rollup_request({})
    assert req["dry_run"] is True
    assert req["data_dir"] is None


def test_explicit_live_and_data_dir():
    req = sr.build_rollup_request({"dry_run": False, "data_dir": "/tmp/d"})
    assert req["dry_run"] is False and req["data_dir"] == "/tmp/d"


def test_data_dir_trimmed():
    req = sr.build_rollup_request({"data_dir": "  /tmp/dd  "})
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
def test_rollup_request_rejects_bad(bad):
    with pytest.raises(sr.ScoreRollupGuardError):
        sr.build_rollup_request(bad)


# ===========================================================================
# default_window — matches score.ts (last 30 days, UTC)
# ===========================================================================


def test_default_window_shape():
    frm, to = sr.default_window()
    assert _DATE_RE.match(frm) and _DATE_RE.match(to)
    assert frm < to


def test_default_window_span_30_days():
    from datetime import date

    frm, to = sr.default_window(30)
    d0 = date.fromisoformat(frm)
    d1 = date.fromisoformat(to)
    assert (d1 - d0).days == 30


# ===========================================================================
# sffs_score_rollup handler — dry-run is subprocess-free + write-free
# ===========================================================================


def test_dry_run_default_makes_no_subprocess(monkeypatch):
    monkeypatch.setattr(sr, "run_node_bridge", _no_bridge)
    out = sr.sffs_score_rollup({})  # default dry_run True
    data = json.loads(out)
    assert data["ok"] is True and data["dry_run"] is True
    assert _DATE_RE.match(data["from"]) and _DATE_RE.match(data["to"])
    assert "wrote no files" in data["note"]


def test_dry_run_explicit_makes_no_subprocess(monkeypatch):
    monkeypatch.setattr(sr, "run_node_bridge", _no_bridge)
    out = sr.sffs_score_rollup({"dry_run": True})
    assert json.loads(out)["dry_run"] is True


def test_live_run_calls_bridge_and_returns_result(monkeypatch):
    captured = {}

    def fake_bridge(*, dry_run, data_dir=None, timeout=240):
        captured["dry_run"] = dry_run
        captured["data_dir"] = data_dir
        return {"ok": True, "from": "2026-06-22", "to": "2026-07-22", "pulled": 14, "updated": 3, "note": "metrics refreshed"}

    monkeypatch.setattr(sr, "run_node_bridge", fake_bridge)
    out = sr.sffs_score_rollup({"dry_run": False, "data_dir": "/tmp/dd"})
    data = json.loads(out)
    assert data["ok"] is True and data["pulled"] == 14 and data["updated"] == 3
    assert captured["dry_run"] is False
    assert captured["data_dir"] == "/tmp/dd"


def test_bad_args_refused_without_bridge(monkeypatch):
    monkeypatch.setattr(sr, "run_node_bridge", _no_bridge)
    out = sr.sffs_score_rollup({"dry_run": "nope"})
    data = json.loads(out)
    assert data["ok"] is False and "dry_run" in data["error"]


def test_live_error_is_reported_not_raised(monkeypatch):
    def boom(*_a, **_k):
        raise sr.ScoreRollupGuardError("bridge failed (exit 1): publer 401")

    monkeypatch.setattr(sr, "run_node_bridge", boom)
    out = sr.sffs_score_rollup({"dry_run": False})
    data = json.loads(out)
    assert data["ok"] is False and "publer 401" in data["error"]


def test_non_object_bridge_result_is_error(monkeypatch):
    monkeypatch.setattr(sr, "run_node_bridge", lambda *a, **k: ["nope"])
    out = sr.sffs_score_rollup({"dry_run": False})
    data = json.loads(out)
    assert data["ok"] is False and "non-object" in data["error"]


@pytest.mark.parametrize("garbage", [None, 42, "nope", [], {"dry_run": 3}, {"data_dir": 9}])
def test_handler_never_raises_on_garbage(monkeypatch, garbage):
    monkeypatch.setattr(sr, "run_node_bridge", _no_bridge)
    out = sr.sffs_score_rollup(garbage)
    assert isinstance(out, str)
    assert "ok" in json.loads(out)


# ===========================================================================
# _bridge_env — keys + data_dir plumbing (no network)
# ===========================================================================


def test_bridge_env_sets_env_file_from_home(monkeypatch, tmp_path):
    (tmp_path / ".env").write_text("METRICOOL_USER_TOKEN=x\n")
    monkeypatch.delenv("HERMES_ENV_FILE", raising=False)
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    env = sr._bridge_env(None)
    assert env["HERMES_ENV_FILE"] == str(tmp_path / ".env")


def test_bridge_env_sets_data_dir(monkeypatch):
    env = sr._bridge_env("/tmp/whatever")
    assert env["HERMES_DATA_DIR"] == "/tmp/whatever"


# ===========================================================================
# Cross-check: the SCORE-ROLLUP tool's args are NEVER flagged by the publish/
# schedule defense-in-depth guard (refreshing local analytics is not a posting
# action), while a genuine publish/schedule is still blocked.
# ===========================================================================


def test_rollup_tool_args_not_flagged_by_publish_guard():
    for args in ({}, {"dry_run": True}, {"dry_run": False, "data_dir": "/tmp/d"}):
        assert pg.refusal_reason("sffs_score_rollup", args) is None


def test_guard_would_still_block_a_real_publish():
    assert pg.refusal_reason("publer_publish_post_now", {}) is not None
    assert pg.refusal_reason("sffs_score_rollup", {"scheduled_at": "2026-01-01T00:00:00Z"}) is not None
    assert pg.refusal_reason("publer_update_post", {"post_id": "p1"}) is not None
