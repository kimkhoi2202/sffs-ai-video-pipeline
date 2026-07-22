"""E2E tests for the plugin + DRAFT-ONLY guard self-check (:mod:`sffs_selfcheck`)."""

from __future__ import annotations

from pathlib import Path

import pytest

import sffs_selfcheck as sc


def test_real_plugin_selfcheck_is_green():
    res = sc.run_selfcheck()
    assert res["verdict"] == "GREEN", res["failures"]
    assert res["ok"] is True
    assert all(res["checks"].values()), res["checks"]


def test_required_tools_present_and_no_forbidden():
    res = sc.run_selfcheck()
    # the safety core + read tools are REQUIRED (extra main-line tools allowed)
    assert set(sc.REQUIRED_TOOLS) <= set(res["tools"])
    assert res["checks"]["required_tools_present"] is True
    # NOTHING that can publish/schedule/delete may be registered
    assert res["checks"]["no_forbidden_tool_names"] is True
    assert res["hooks"].count("pre_tool_call") >= 1


def test_guard_matrix_fully_covered():
    res = sc.run_selfcheck()
    mc = res["matrix_counts"]
    assert mc["block_passed"] == mc["block_total"] == len(sc.BLOCK_MATRIX)
    assert mc["allow_passed"] == mc["allow_total"] == len(sc.ALLOW_MATRIX)
    assert mc["block_total"] >= 10 and mc["allow_total"] >= 8  # a real matrix, not a stub


def _load_hook():
    module = sc._load_plugin_module()
    ctx = sc._CaptureCtx()
    module.register(ctx)
    return ctx.hook("pre_tool_call")


@pytest.mark.parametrize("label,tool,args", sc.BLOCK_MATRIX, ids=[m[0] for m in sc.BLOCK_MATRIX])
def test_every_block_case_is_blocked(label, tool, args):
    hook = _load_hook()
    assert sc._directive_is_block(hook(tool_name=tool, args=args)), f"{label} must be blocked"


@pytest.mark.parametrize("label,tool,args", sc.ALLOW_MATRIX, ids=[m[0] for m in sc.ALLOW_MATRIX])
def test_every_allow_case_is_allowed(label, tool, args):
    hook = _load_hook()
    assert hook(tool_name=tool, args=args) is None, f"{label} must be allowed"


def test_directive_is_block_contract():
    assert sc._directive_is_block({"action": "block", "message": "why"}) is True
    assert sc._directive_is_block(None) is False
    assert sc._directive_is_block({"action": "block"}) is False          # missing message
    assert sc._directive_is_block({"action": "block", "message": ""}) is False  # empty message
    assert sc._directive_is_block({"action": "approve", "message": "x"}) is False


def test_missing_plugin_is_fail_closed_red(tmp_path: Path):
    # A plugin that cannot be loaded must yield RED (never a silent pass).
    res = sc.run_selfcheck(plugin_parent=tmp_path)  # no `sffs` package here
    assert res["verdict"] == "RED"
    assert res["checks"].get("plugin_loads") is False
