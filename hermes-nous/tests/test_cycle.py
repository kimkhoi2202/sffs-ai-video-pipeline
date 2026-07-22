"""CYCLE tool test — proves sffs_cycle validates its args, is subprocess-free in
preview mode, ALWAYS forces HERMES_SKIP_GIT=1 (a cycle from the sandbox can never
`git push origin HEAD:main`), maps dry_run/target/run_id/data_dir into the bridge
env correctly, surfaces errors as results (never raises), and that its args are
NOT flagged by the framework's publish/schedule defense-in-depth guard while a real
publish still is.

No network, no node, no Chromium, no Publer, no Hermes framework: imports the pure
module (``cycle``) directly and stubs the Node bridge via monkeypatch. A preview /
bad-arg call must NEVER reach the bridge (asserted with a spy that fails if called).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

PLUGIN_DIR = Path(__file__).resolve().parents[1] / "sffs"
sys.path.insert(0, str(PLUGIN_DIR))

import cycle  # noqa: E402
import publish_guard as pg  # noqa: E402


def _no_bridge(*_a, **_k):
    raise AssertionError("run_node_bridge must NOT be called on a preview / refused path")


def _fake_state(status="success"):
    return {
        "run_id": "2026-07-22",
        "status": status,
        "target_count": 1,
        "summary": {"planned": 1, "drafted": 0, "rejected": 0, "failed": 0},
        "scoring": {"from": "2026-06-22", "to": "2026-07-22", "pulled": 14, "updated": 0, "note": "recomputed"},
        "do_not_touch": {"scheduled_ids": ["s1", "s2"], "published_ids": ["p1"], "captured_at": "t"},
        "git": {"committed": False, "pushed": False, "note": "skipped (HERMES_SKIP_GIT=1)"},
        "errors": [],
        "videos": [
            {
                "id": "2026-07-22-v01",
                "dimension": "narration",
                "arm": "full-narration",
                "status": "rendered",
                "render_path": "/data/renders/2026-07-22-v01.mp4",
                "publer": {"post_ids": []},
            }
        ],
    }


# ===========================================================================
# build_cycle_request — pure arg guard
# ===========================================================================


def test_defaults():
    req = cycle.build_cycle_request({})
    assert req["dry_run"] is True      # safe default
    assert req["preview"] is False
    assert req["target"] is None
    assert req["run_id"] is None
    assert req["data_dir"] is None


def test_explicit_values():
    req = cycle.build_cycle_request(
        {"dry_run": False, "preview": True, "target": 3, "run_id": "2026-07-22", "data_dir": "/tmp/d"}
    )
    assert req["dry_run"] is False and req["preview"] is True and req["target"] == 3
    assert req["run_id"] == "2026-07-22" and req["data_dir"] == "/tmp/d"


@pytest.mark.parametrize("t", [1, 10, 50])
def test_target_bounds_accepted(t):
    assert cycle.build_cycle_request({"target": t})["target"] == t


def test_run_id_trimmed():
    assert cycle.build_cycle_request({"run_id": "  2026-07-22  "})["run_id"] == "2026-07-22"


@pytest.mark.parametrize(
    "bad",
    [
        None,                                   # not a dict
        "nope",                                 # not a dict
        {"dry_run": "yes"},                     # dry_run not bool
        {"preview": 1},                         # preview not bool
        {"target": 0},                          # target < 1
        {"target": 51},                         # target > 50
        {"target": "3"},                        # target not int
        {"target": True},                       # target bool, not int
        {"target": 2.0},                        # target float
        {"run_id": "bad/id"},                   # run_id path sep
        {"run_id": ""},                         # empty run_id
        {"run_id": 5},                          # run_id not string
        {"data_dir": ""},                       # empty data_dir
        {"data_dir": "  "},                     # whitespace data_dir
    ],
)
def test_cycle_request_rejects_bad(bad):
    with pytest.raises(cycle.CycleGuardError):
        cycle.build_cycle_request(bad)


# ===========================================================================
# preview mode — subprocess-free; reports skip_git True
# ===========================================================================


def test_preview_is_subprocess_free(monkeypatch):
    monkeypatch.setattr(cycle, "run_node_bridge", _no_bridge)
    out = cycle.sffs_cycle({"preview": True, "dry_run": True, "target": 2})
    data = json.loads(out)
    assert data["ok"] is True and data["preview"] is True
    assert data["skip_git"] is True          # the sandbox never pushes to main
    assert data["dry_run"] is True and data["target"] == 2


def test_preview_reports_dry_run_false_but_still_skip_git(monkeypatch):
    monkeypatch.setattr(cycle, "run_node_bridge", _no_bridge)
    out = cycle.sffs_cycle({"preview": True, "dry_run": False})
    data = json.loads(out)
    assert data["dry_run"] is False and data["skip_git"] is True


# ===========================================================================
# _bridge_env — the SAFETY-CRITICAL env mapping. HERMES_SKIP_GIT is ALWAYS "1".
# ===========================================================================


@pytest.mark.parametrize(
    "req",
    [
        {"dry_run": True, "preview": False, "target": None, "run_id": None, "data_dir": None},
        {"dry_run": False, "preview": False, "target": 5, "run_id": "r1", "data_dir": "/tmp/x"},
        {"dry_run": True, "preview": False, "target": 1, "run_id": None, "data_dir": None},
    ],
)
def test_bridge_env_always_forces_skip_git(req):
    env = cycle._bridge_env(req)
    assert env["HERMES_SKIP_GIT"] == "1"  # <-- can never push to main


def test_bridge_env_dry_run_sets_flag():
    env = cycle._bridge_env({"dry_run": True})
    assert env["HERMES_DRY_RUN"] == "1"


def test_bridge_env_live_removes_dry_flag(monkeypatch):
    monkeypatch.setenv("HERMES_DRY_RUN", "1")  # even if ambient set...
    env = cycle._bridge_env({"dry_run": False})
    assert "HERMES_DRY_RUN" not in env  # ...a live cycle clears it


def test_bridge_env_target_maps_to_videos_per_day():
    env = cycle._bridge_env({"dry_run": True, "target": 7})
    assert env["HERMES_VIDEOS_PER_DAY"] == "7"


def test_bridge_env_run_id_maps():
    env = cycle._bridge_env({"dry_run": True, "run_id": "2026-07-22"})
    assert env["HERMES_RUN_ID"] == "2026-07-22"


def test_bridge_env_data_dir_default_outside_repo(monkeypatch):
    monkeypatch.delenv("HERMES_DATA_DIR", raising=False)
    monkeypatch.delenv("HERMES_HOME", raising=False)
    env = cycle._bridge_env({"dry_run": True})
    # default lands under the repo's .sffs-data (gitignored), NOT the tracked tree
    assert env["HERMES_DATA_DIR"].endswith(".sffs-data")


def test_bridge_env_data_dir_override_wins(monkeypatch):
    env = cycle._bridge_env({"dry_run": True, "data_dir": "/tmp/mine"})
    assert env["HERMES_DATA_DIR"] == "/tmp/mine"


def test_bridge_env_sets_env_file_from_home(monkeypatch, tmp_path):
    (tmp_path / ".env").write_text("OPENAI_API_KEY=x\n")
    monkeypatch.delenv("HERMES_ENV_FILE", raising=False)
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    env = cycle._bridge_env({"dry_run": True})
    assert env["HERMES_ENV_FILE"] == str(tmp_path / ".env")


# ===========================================================================
# live run path — returns a compact summary of the RunState
# ===========================================================================


def test_run_returns_summary(monkeypatch):
    monkeypatch.setattr(cycle, "run_node_bridge", lambda req, **k: _fake_state("success"))
    out = cycle.sffs_cycle({"dry_run": True, "target": 1})
    data = json.loads(out)
    assert data["ok"] is True and data["run_id"] == "2026-07-22" and data["status"] == "success"
    assert data["dry_run"] is True
    assert data["summary"]["planned"] == 1
    assert data["do_not_touch"]["scheduled"] == 2 and data["do_not_touch"]["published"] == 1
    assert data["videos"][0]["dimension"] == "narration"
    assert data["videos"][0]["render_path"].endswith("v01.mp4")


def test_run_passes_request_to_bridge(monkeypatch):
    captured = {}

    def fake_bridge(req, **k):
        captured["req"] = req
        return _fake_state("partial")

    monkeypatch.setattr(cycle, "run_node_bridge", fake_bridge)
    cycle.sffs_cycle({"dry_run": False, "target": 2, "run_id": "2026-07-22"})
    assert captured["req"]["dry_run"] is False
    assert captured["req"]["target"] == 2
    assert captured["req"]["run_id"] == "2026-07-22"


def test_bad_args_refused_without_bridge(monkeypatch):
    monkeypatch.setattr(cycle, "run_node_bridge", _no_bridge)
    out = cycle.sffs_cycle({"target": 999})
    data = json.loads(out)
    assert data["ok"] is False and "target" in data["error"]


def test_live_error_is_reported_not_raised(monkeypatch):
    def boom(*_a, **_k):
        raise cycle.CycleGuardError("bridge returned non-JSON (exit 1): remotion crashed")

    monkeypatch.setattr(cycle, "run_node_bridge", boom)
    out = cycle.sffs_cycle({"dry_run": True})
    data = json.loads(out)
    assert data["ok"] is False and "remotion crashed" in data["error"]


def test_non_object_bridge_result_is_error(monkeypatch):
    monkeypatch.setattr(cycle, "run_node_bridge", lambda *a, **k: ["not", "a", "dict"])
    out = cycle.sffs_cycle({"dry_run": True})
    data = json.loads(out)
    assert data["ok"] is False and "non-object" in data["error"]


@pytest.mark.parametrize("garbage", [None, 42, "nope", [], {"target": []}, {"run_id": 3}])
def test_handler_never_raises_on_garbage(monkeypatch, garbage):
    monkeypatch.setattr(cycle, "run_node_bridge", _no_bridge)
    out = cycle.sffs_cycle(garbage)
    assert isinstance(out, str)
    assert "ok" in json.loads(out)


# ===========================================================================
# Cross-check: the CYCLE tool's args are NEVER flagged by the publish/schedule
# defense-in-depth guard (running the draft-only cycle is not itself a publish
# call), while a genuine publish/schedule/mutation is still blocked. Note the
# tool name "sffs_cycle" is NOT posting-named and exposes no state/schedule key.
# ===========================================================================


def test_cycle_tool_args_not_flagged_by_publish_guard():
    for args in (
        {},
        {"dry_run": True, "target": 1},
        {"dry_run": False, "target": 10, "run_id": "2026-07-22", "data_dir": "/tmp/d"},
        {"preview": True},
    ):
        assert pg.refusal_reason("sffs_cycle", args) is None


def test_guard_would_still_block_a_real_publish():
    assert pg.refusal_reason("publer_publish_post_now", {"post_id": "p1"}) is not None
    assert pg.refusal_reason("sffs_cycle", {"scheduled_at": "2026-08-01T00:00:00Z"}) is not None
    assert pg.refusal_reason("publer_update_post", {"post_id": "p1", "text": "x"}) is not None
