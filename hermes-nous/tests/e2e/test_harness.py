"""E2E tests for the auto-merge harness (:mod:`harness`) — key #1."""

from __future__ import annotations

import shutil

import pytest

import harness as h


def test_discover_tool_tests_finds_suite_and_excludes_e2e():
    names = [p.name for p in h.discover_tool_tests()]
    assert "test_publish_guard.py" in names
    assert "test_reads.py" in names
    # the gate's OWN e2e tests must NOT be part of the harness's gating pytest leg
    assert all(not str(p).endswith("test_harness.py") for p in h.discover_tool_tests())
    assert all("/e2e/" not in str(p) for p in h.discover_tool_tests())


def test_selfcheck_step_green():
    step = h.run_selfcheck_step()
    assert step["ok"] is True
    assert step["result"]["verdict"] == "GREEN"


@pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")
def test_node_bridge_matrix_all_pass():
    step = h.run_node_bridges()
    assert step["ok"] is True, step
    assert step["counts"]["passed"] == step["counts"]["total"]
    assert step["counts"]["total"] >= 10  # a real matrix incl. draft/read/donottouch + refusals


def test_pytest_leg_passes():
    step = h.run_pytest()
    assert step["ok"] is True, step.get("summary")
    assert step["returncode"] == 0


@pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")
def test_full_harness_is_green():
    res = h.run_harness()
    assert res["verdict"] == "GREEN", res
    assert res["ok"] is True
    assert set(res["steps"]) == {"pytest", "node_bridges", "selfcheck"}
    assert all(s["ok"] for s in res["steps"].values())
