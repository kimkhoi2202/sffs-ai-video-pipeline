"""QUALITY GATES tool test — proves sffs_gates validates its per-mode args, runs
network-free in dry-run, surfaces errors as results (never raises), and that its
args are NOT flagged by the framework's publish/schedule defense-in-depth guard.

No network, no node, no LLM: imports the pure module (``gates``) directly and stubs
the Node bridge via monkeypatch. A dry-run / bad-arg call must NEVER reach the
bridge (asserted with a spy that fails if called).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

PLUGIN_DIR = Path(__file__).resolve().parents[1] / "sffs"
sys.path.insert(0, str(PLUGIN_DIR))

import gates  # noqa: E402
import publish_guard as pg  # noqa: E402


def _no_bridge(*_a, **_k):
    raise AssertionError("run_node_bridge must NOT be called on a dry-run / refused path")


Q1 = {"sig": "s1", "hash": "h1", "kind": "text", "tier": "t", "prompt": "p", "options": ["a", "b", "c"], "answer": "a"}
Q2 = {"sig": "s2", "hash": "h2", "kind": "numseries", "tier": "t", "prompt": "next?", "seq": ["1", "2", "3"], "answer": "4"}


# ===========================================================================
# build_gates_request — pure arg guard (per mode)
# ===========================================================================


def test_dedup_minimal():
    req = gates.build_gates_request({"what": "dedup", "questions": [Q1, Q2]})
    assert req["sub"] == "dedup"
    assert req["params"]["questions"] == [Q1, Q2]
    assert "claimed" not in req["params"]


def test_dedup_with_claimed():
    req = gates.build_gates_request({"what": "dedup", "questions": [Q1], "claimed": ["sX", "sY"]})
    assert req["params"]["claimed"] == ["sX", "sY"]


def test_validity_requires_hash():
    req = gates.build_gates_request({"what": "validity", "questions": [Q1, Q2]})
    assert req["sub"] == "validity" and len(req["params"]["questions"]) == 2


def test_copy_normalizes_pieces():
    req = gates.build_gates_request({"what": "copy", "pieces": [{"label": "caption", "text": "hi there"}]})
    assert req["sub"] == "copy"
    assert req["params"]["pieces"] == [{"label": "caption", "text": "hi there"}]


def test_render_minimal_and_fps():
    req = gates.build_gates_request({"what": "render", "path": "/tmp/v.mp4", "expected_frames": 1200})
    assert req["params"] == {"path": "/tmp/v.mp4", "expected_frames": 1200}
    req2 = gates.build_gates_request({"what": "render", "path": "/tmp/v.mp4", "expected_frames": 1200, "fps": 25})
    assert req2["params"]["fps"] == 25


@pytest.mark.parametrize(
    "bad",
    [
        {"what": "nope", "questions": [Q1]},                       # unknown gate
        {"what": "dedup"},                                          # no questions
        {"what": "dedup", "questions": []},                         # empty
        {"what": "dedup", "questions": [{"kind": "text"}]},         # missing sig
        {"what": "dedup", "questions": [{"sig": ""}]},              # empty sig
        {"what": "dedup", "questions": "s1"},                       # not a list
        {"what": "dedup", "questions": [Q1], "claimed": "sX"},      # claimed not a list
        {"what": "dedup", "questions": [Q1], "claimed": [1]},       # claimed non-string
        {"what": "validity", "questions": [{"sig": "s1"}]},         # missing hash
        {"what": "validity", "questions": [{"sig": "s1", "hash": ""}]},  # empty hash
        {"what": "copy"},                                           # no pieces
        {"what": "copy", "pieces": []},                             # empty
        {"what": "copy", "pieces": [{"label": "x"}]},               # missing text
        {"what": "copy", "pieces": [{"text": "x"}]},                # missing label
        {"what": "copy", "pieces": [{"label": "", "text": "x"}]},   # empty label
        {"what": "render", "expected_frames": 10},                  # missing path
        {"what": "render", "path": ""},                             # empty path
        {"what": "render", "path": "/v.mp4"},                       # missing frames
        {"what": "render", "path": "/v.mp4", "expected_frames": 0},   # non-positive
        {"what": "render", "path": "/v.mp4", "expected_frames": True},  # bool not int
        {"what": "render", "path": "/v.mp4", "expected_frames": 10, "fps": 0},  # bad fps
        "nope",                                                     # not a dict
        None,
    ],
)
def test_gates_request_rejects_bad(bad):
    with pytest.raises(gates.GatesGuardError):
        gates.build_gates_request(bad)


# ===========================================================================
# sffs_gates handler — dry-run is network-free for every mode
# ===========================================================================


@pytest.mark.parametrize(
    "call",
    [
        {"what": "dedup", "questions": [Q1], "dry_run": True},
        {"what": "validity", "questions": [Q1], "dry_run": True},
        {"what": "copy", "pieces": [{"label": "c", "text": "hi"}], "dry_run": True},
        {"what": "render", "path": "/v.mp4", "expected_frames": 100, "dry_run": True},
    ],
)
def test_dry_run_makes_no_network_call(monkeypatch, call):
    monkeypatch.setattr(gates, "run_node_bridge", _no_bridge)
    out = gates.sffs_gates(call)
    data = json.loads(out)
    assert data["ok"] is True and data["dry_run"] is True
    assert data["what"] == call["what"]


def test_dedup_live_success_passes_params(monkeypatch):
    captured = {}

    def fake_bridge(subcommand, stdin_obj=None, *, dry_run, timeout=180):
        captured["sub"] = subcommand
        captured["stdin"] = stdin_obj
        captured["timeout"] = timeout
        return {"ok": True, "sub": "dedup", "gate": {"pass": True, "reason": "all questions fresh + unique"}}

    monkeypatch.setattr(gates, "run_node_bridge", fake_bridge)
    out = gates.sffs_gates({"what": "dedup", "questions": [Q1, Q2], "claimed": ["sX"]})
    data = json.loads(out)
    assert data["ok"] is True and data["gate"]["pass"] is True
    assert captured["sub"] == "dedup"
    assert captured["stdin"]["questions"] == [Q1, Q2]
    assert captured["stdin"]["claimed"] == ["sX"]
    assert captured["timeout"] == 60  # deterministic gate -> short timeout


def test_validity_live_uses_llm_timeout(monkeypatch):
    captured = {}

    def fake_bridge(subcommand, stdin_obj=None, *, dry_run, timeout=180):
        captured["timeout"] = timeout
        return {"ok": True, "sub": "validity", "gate": {"pass": False, "reason": "1 invalid question(s)"}, "results": {}}

    monkeypatch.setattr(gates, "run_node_bridge", fake_bridge)
    out = gates.sffs_gates({"what": "validity", "questions": [Q1]})
    data = json.loads(out)
    assert data["ok"] is True and data["gate"]["pass"] is False
    assert captured["timeout"] == 180  # LLM gate -> longer timeout


def test_copy_live_uses_llm_timeout(monkeypatch):
    captured = {}

    def fake_bridge(subcommand, stdin_obj=None, *, dry_run, timeout=180):
        captured["timeout"] = timeout
        return {"ok": True, "sub": "copy", "gate": {"pass": True, "reason": "on-brand"}}

    monkeypatch.setattr(gates, "run_node_bridge", fake_bridge)
    gates.sffs_gates({"what": "copy", "pieces": [{"label": "c", "text": "smart or fart?"}]})
    assert captured["timeout"] == 180


def test_bad_args_refused_without_bridge(monkeypatch):
    monkeypatch.setattr(gates, "run_node_bridge", _no_bridge)
    out = gates.sffs_gates({"what": "validity", "questions": [{"sig": "s1"}]})  # missing hash
    data = json.loads(out)
    assert data["ok"] is False
    assert "hash" in data["error"]


def test_live_error_is_reported_not_raised(monkeypatch):
    def boom(*_a, **_k):
        raise gates.GatesGuardError("bridge failed (exit 1): ffprobe down")

    monkeypatch.setattr(gates, "run_node_bridge", boom)
    out = gates.sffs_gates({"what": "render", "path": "/v.mp4", "expected_frames": 100})
    data = json.loads(out)
    assert data["ok"] is False
    assert "ffprobe down" in data["error"]


# ===========================================================================
# Handler NEVER raises on garbage
# ===========================================================================


@pytest.mark.parametrize("garbage", [None, 42, "nope", [], {"what": 5}, {"what": "dedup", "questions": 3}])
def test_handler_never_raises_on_garbage(monkeypatch, garbage):
    monkeypatch.setattr(gates, "run_node_bridge", _no_bridge)
    call = garbage if isinstance(garbage, dict) else {"what": "dedup", "questions": [Q1], "dry_run": True}
    if isinstance(call, dict):
        call = {**call, "dry_run": True}
    out = gates.sffs_gates(call)
    assert isinstance(out, str) and "ok" in json.loads(out)


# ===========================================================================
# Cross-check: the GATES tool's args are NEVER flagged by the publish/schedule
# defense-in-depth guard (running a quality gate is not a posting action).
# ===========================================================================


def test_gates_tool_args_are_not_flagged_by_publish_guard():
    assert pg.refusal_reason("sffs_gates", {"what": "dedup", "questions": [Q1]}) is None
    assert pg.refusal_reason("sffs_gates", {"what": "validity", "questions": [Q1]}) is None
    assert pg.refusal_reason("sffs_gates", {"what": "copy", "pieces": [{"label": "c", "text": "hi"}]}) is None
    assert pg.refusal_reason("sffs_gates", {"what": "render", "path": "/v.mp4", "expected_frames": 100}) is None


def test_guard_would_still_block_a_real_publish():
    # Sanity: the guard IS active — a genuine publish/schedule attempt is refused.
    assert pg.refusal_reason("publer_publish_post_now", {}) is not None
    assert pg.refusal_reason("sffs_publer_draft", {"state": "published"}) is not None
