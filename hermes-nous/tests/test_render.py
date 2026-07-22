"""RENDER tool test — proves sffs_render validates its props, runs subprocess-free
in dry-run, surfaces errors as results (never raises), and that its args (incl. the
nested render props with a narration arm) are NOT flagged by the framework's
publish/schedule defense-in-depth guard.

No network, no node, no Chromium, no ffmpeg: imports the pure module (``render``)
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

import render  # noqa: E402
import publish_guard as pg  # noqa: E402


def _no_bridge(*_a, **_k):
    raise AssertionError("run_node_bridge must NOT be called on a dry-run / refused path")


TEXT_Q = {
    "kind": "text",
    "tier": "ODD ONE OUT",
    "prompt": "which one does not belong?",
    "options": ["apple", "banana", "carrot", "grape"],
    "answer": "carrot",
}
NUM_Q = {
    "kind": "numseries",
    "tier": "NUMBER SERIES",
    "prompt": "what comes next?",
    "seq": ["5", "10", "15", "20"],
    "answer": "25",
}


def props(mode="none", questions=None):
    return {
        "title": "SMART or FART?",
        "subtitle": "how many can you get?",
        "outro": "comment your score",
        "music": "audio/music/gameshow-fanfare.mp3",
        "showProgress": True,
        "progressStyle": "short",
        "reveal": "all",
        "countdownSec": 5,
        "narration": {"mode": mode, "clips": []},
        "questions": questions if questions is not None else [TEXT_Q, NUM_Q],
    }


# ===========================================================================
# build_render_request — pure arg guard
# ===========================================================================


def test_minimal_music_only():
    req = render.build_render_request({"id": "v01", "props": props("none")})
    assert req["id"] == "v01"
    assert req["mode"] == "none"
    assert req["force"] is False
    assert req["data_dir"] is None
    assert len(req["props"]["questions"]) == 2


@pytest.mark.parametrize("mode", ["full", "no-question-vo", "no-options-vo", "none"])
def test_all_narration_arms_accepted(mode):
    # verbal/text questions so every arm is representable
    req = render.build_render_request({"id": "arm", "props": props(mode, [TEXT_Q, TEXT_Q, TEXT_Q])})
    assert req["mode"] == mode


def test_id_defaulted_when_absent():
    req = render.build_render_request({"props": props("none")})
    assert req["id"].startswith("sffs-render-")
    assert render._ID_RE.match(req["id"])


def test_force_and_data_dir():
    req = render.build_render_request({"id": "v", "props": props(), "force": True, "data_dir": "/tmp/d"})
    assert req["force"] is True and req["data_dir"] == "/tmp/d"


def test_narration_omitted_defaults_none():
    p = props()
    del p["narration"]
    req = render.build_render_request({"id": "v", "props": p})
    assert req["mode"] == "none"


@pytest.mark.parametrize(
    "bad",
    [
        None,                                                        # not a dict
        "nope",                                                      # not a dict
        {"id": "v"},                                                 # no props
        {"id": "v", "props": {}},                                    # props no questions
        {"id": "v", "props": {"questions": []}},                     # empty questions
        {"id": "v", "props": {"questions": "x"}},                    # questions not a list
        {"id": "v", "props": {"questions": [{"kind": "text"}]}},     # missing prompt/answer/options
        {"id": "v", "props": {"questions": [{"kind": "bogus", "prompt": "p", "answer": "a", "options": ["x", "y"]}]}},  # bad kind
        {"id": "v", "props": {"questions": [{"kind": "text", "prompt": "", "answer": "a", "options": ["x", "y"]}]}},   # empty prompt
        {"id": "v", "props": {"questions": [{"kind": "text", "prompt": "p", "answer": "", "options": ["x", "y"]}]}},   # empty answer
        {"id": "v", "props": {"questions": [{"kind": "text", "prompt": "p", "answer": "a", "options": ["only"]}]}},    # <2 options
        {"id": "v", "props": {"questions": [{"kind": "numseries", "prompt": "p", "answer": "a", "seq": ["1"]}]}},      # <2 seq
        {"id": "v", "props": {**props(), "narration": {"mode": "loud"}}},   # bad narration mode
        {"id": "v", "props": {**props(), "narration": "on"}},              # narration not object
        {"id": "v", "props": {**props(), "reveal": "sometimes"}},          # bad reveal
        {"id": "v", "props": {**props(), "progressStyle": "medium"}},      # bad progressStyle
        {"id": "v", "props": {**props(), "countdownSec": 0}},              # non-positive countdown
        {"id": "v", "props": {**props(), "countdownSec": "5"}},            # countdown not number
        {"id": "v", "props": {**props(), "showProgress": "yes"}},          # showProgress not bool
        {"id": "v", "props": {**props(), "music": ""}},                    # empty music
        {"id": "bad/id", "props": props()},                               # id with path sep
        {"id": "", "props": props()},                                      # empty id
        {"id": "v", "props": props(), "force": "yes"},                    # force not bool
        {"id": "v", "props": props(), "data_dir": ""},                    # empty data_dir
    ],
)
def test_render_request_rejects_bad(bad):
    with pytest.raises(render.RenderGuardError):
        render.build_render_request(bad)


# ===========================================================================
# sffs_render handler — dry-run is subprocess-free
# ===========================================================================


def test_dry_run_makes_no_subprocess(monkeypatch):
    monkeypatch.setattr(render, "run_node_bridge", _no_bridge)
    out = render.sffs_render({"id": "v01", "props": props("full", [TEXT_Q, TEXT_Q]), "dry_run": True})
    data = json.loads(out)
    assert data["ok"] is True and data["dry_run"] is True
    assert data["id"] == "v01" and data["mode"] == "full" and data["questions"] == 2


def test_live_success_passes_id_props_force(monkeypatch):
    captured = {}

    def fake_bridge(stdin_obj, *, dry_run, data_dir=None, timeout=900):
        captured["stdin"] = stdin_obj
        captured["dry_run"] = dry_run
        captured["data_dir"] = data_dir
        return {"ok": True, "id": stdin_obj["id"], "path": "/x/v01.mp4", "frames": 330, "reused": False, "bytes": 900000, "mode": "none"}

    monkeypatch.setattr(render, "run_node_bridge", fake_bridge)
    out = render.sffs_render({"id": "v01", "props": props("none"), "force": True, "data_dir": "/tmp/dd"})
    data = json.loads(out)
    assert data["ok"] is True and data["path"].endswith("v01.mp4") and data["frames"] == 330
    assert captured["stdin"]["id"] == "v01"
    assert captured["stdin"]["force"] is True
    assert captured["stdin"]["props"]["questions"]
    assert captured["dry_run"] is False
    assert captured["data_dir"] == "/tmp/dd"


def test_bad_args_refused_without_bridge(monkeypatch):
    monkeypatch.setattr(render, "run_node_bridge", _no_bridge)
    out = render.sffs_render({"id": "v", "props": {"questions": []}})  # empty questions
    data = json.loads(out)
    assert data["ok"] is False
    assert "questions" in data["error"]


def test_live_error_is_reported_not_raised(monkeypatch):
    def boom(*_a, **_k):
        raise render.RenderGuardError("bridge failed (exit 1): remotion render failed")

    monkeypatch.setattr(render, "run_node_bridge", boom)
    out = render.sffs_render({"id": "v", "props": props("none")})
    data = json.loads(out)
    assert data["ok"] is False
    assert "remotion render failed" in data["error"]


def test_non_object_bridge_result_is_error(monkeypatch):
    monkeypatch.setattr(render, "run_node_bridge", lambda *a, **k: ["not", "an", "object"])
    out = render.sffs_render({"id": "v", "props": props("none")})
    data = json.loads(out)
    assert data["ok"] is False and "non-object" in data["error"]


# ===========================================================================
# Handler NEVER raises on garbage
# ===========================================================================


@pytest.mark.parametrize("garbage", [None, 42, "nope", [], {"props": 3}, {"id": 5, "props": props()}])
def test_handler_never_raises_on_garbage(monkeypatch, garbage):
    monkeypatch.setattr(render, "run_node_bridge", _no_bridge)
    out = render.sffs_render(garbage)
    assert isinstance(out, str)
    assert "ok" in json.loads(out)


# ===========================================================================
# Cross-check: the RENDER tool's args (incl. the nested props + narration arm)
# are NEVER flagged by the publish/schedule defense-in-depth guard (rendering an
# mp4 is not a posting action), while a genuine publish is still blocked.
# ===========================================================================


def test_render_tool_args_are_not_flagged_by_publish_guard():
    for mode in ("none", "full", "no-question-vo", "no-options-vo"):
        args = {"id": "v01", "props": props(mode, [TEXT_Q, TEXT_Q, TEXT_Q]), "force": True, "data_dir": "/tmp/d"}
        assert pg.refusal_reason("sffs_render", args) is None


def test_guard_would_still_block_a_real_publish():
    assert pg.refusal_reason("publer_publish_post_now", {}) is not None
    assert pg.refusal_reason("sffs_publer_draft", {"scheduled_at": "2026-01-01T00:00:00Z"}) is not None
