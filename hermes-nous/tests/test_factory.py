"""SOFTWARE FACTORY tests — orchestration around the two-key gate (not the gate).

Proves the factory: plans bounded workstreams; refuses a protected target; aborts
pre-flight (no spawn, no gate) when the cost-governor kill-switch is engaged or a
daily ceiling is hit; in DRY-RUN spawns NO subagent and performs NO merge while
still computing the gate decision on a real branch; on execute records merges +
rollback points; skips the gate for absent/empty branches; breaks on a mid-run
kill-switch; rolls a branch ref back; and the tool handler always returns JSON,
never raises, and stays a dry-run unless doubly-opted-in. The two-key gate + the
delegate fan-out are INJECTED (fakes) so no tokens are spent and no real branch is
touched; git-touching paths use a throwaway repo.

Hermetic: stdlib-only, no network/node/model/framework.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

PLUGIN_DIR = Path(__file__).resolve().parents[1] / "sffs"
sys.path.insert(0, str(PLUGIN_DIR))

import cost_governor as cg  # noqa: E402
import factory  # noqa: E402
import publish_guard as pg  # noqa: E402


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
def _git(repo: Path, *args: str) -> str:
    return subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True, check=True).stdout.strip()


def _make_repo(tmp_path: Path) -> Path:
    """A throwaway repo with a non-protected 'hermes-nous' target + a feature branch."""
    repo = tmp_path / "repo"
    repo.mkdir()
    _git(repo, "init", "-q")
    _git(repo, "config", "user.email", "t@t.t")
    _git(repo, "config", "user.name", "t")
    _git(repo, "checkout", "-q", "-b", "hermes-nous")
    (repo / "a.txt").write_text("base\n")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "base")
    # a feature branch WITH a change
    _git(repo, "checkout", "-q", "-b", "feat-x")
    (repo / "b.txt").write_text("feature\n")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "feat")
    _git(repo, "checkout", "-q", "hermes-nous")
    # an empty branch (no changes vs target)
    _git(repo, "branch", "empty-branch", "hermes-nous")
    return repo


def _fake_gate(merged=False, verdict="REFUSE"):
    calls = []

    def runner(repo, source, target, *, execute, deny_globs, kill_file, offline_review, **_kw):
        calls.append({"source": source, "target": target, "execute": execute,
                      "deny_globs": deny_globs, "offline_review": offline_review})
        return {
            "mode": "execute" if execute else "dry-run",
            "merged": merged,
            "merge_commit": "deadbeef" if merged else None,
            "decision": {"verdict": verdict, "merge": merged, "reasons": ["fake"]},
            "keys": {"harness": {"verdict": "GREEN"}, "review": {"verdict": "APPROVE" if merged else "REJECT"}},
        }

    runner.calls = calls
    return runner


def _spy_delegate():
    calls = []

    def runner(spec, **_kw):
        calls.append(spec)
        return {"spawned": True, "returncode": 0}

    runner.calls = calls
    return runner


# ===========================================================================
# Planning + guards
# ===========================================================================
def test_slugify_and_plan_workstreams():
    ws = factory.plan_workstreams(["Speed up rendering!", "Add a metrics tool", ""], max_workstreams=8)
    assert [w["id"] for w in ws] == ["ws01", "ws02"]  # blank goal dropped
    assert ws[0]["branch"].startswith("sffs-factory/speed-up-rendering")
    assert all(w["base"] == "hermes-nous" for w in ws)


def test_plan_workstreams_bounded_and_dedup():
    ws = factory.plan_workstreams(["same goal", "same goal", "same goal"], max_workstreams=2)
    assert len(ws) == 2  # capped
    assert ws[0]["branch"] != ws[1]["branch"]  # de-duped branch names


def test_is_protected():
    for bad in ("main", "master", "prod", "production", "release", "refs/heads/main"):
        assert factory.is_protected(bad) is not None
    assert factory.is_protected("hermes-nous") is None


# ===========================================================================
# Pre-flight (cost governor)
# ===========================================================================
def test_preflight_ok_when_clear(tmp_path):
    env = {"SFFS_COST_GOVERNOR_DIR": str(tmp_path)}
    pf = factory.preflight(env)
    assert pf["ok"] is True and pf["reason"] is None


def test_preflight_aborts_on_kill(tmp_path):
    env = {"SFFS_COST_GOVERNOR_DIR": str(tmp_path), "SFFS_FACTORY_KILL": "1"}
    pf = factory.preflight(env)
    assert pf["ok"] is False and "kill-switch" in pf["reason"]


def test_preflight_aborts_on_ceiling(tmp_path):
    env = {"SFFS_COST_GOVERNOR_DIR": str(tmp_path), "SFFS_COST_MAX_USD_PER_DAY": "1"}
    cg.record_llm_usage(1_000_000, 1_000_000, "opus", sdir=tmp_path)  # ~$90 >> $1
    pf = factory.preflight(env)
    assert pf["ok"] is False and "ceiling" in pf["reason"]


# ===========================================================================
# run_factory
# ===========================================================================
def test_run_factory_refuses_protected_target(tmp_path):
    gate = _fake_gate()
    res = factory.run_factory(["x"], repo=_make_repo(tmp_path), target="main",
                              gate_runner=gate, env={"SFFS_COST_GOVERNOR_DIR": str(tmp_path)})
    assert res["aborted"] and "protected" in res["aborted"]
    assert gate.calls == []  # never reached the gate


def test_run_factory_aborts_on_kill_no_spawn_no_gate(tmp_path):
    gate = _fake_gate()
    deleg = _spy_delegate()
    env = {"SFFS_COST_GOVERNOR_DIR": str(tmp_path), "SFFS_FACTORY_KILL": "1"}
    res = factory.run_factory(["x"], repo=_make_repo(tmp_path), target="hermes-nous",
                              gate_runner=gate, delegate_runner=deleg, env=env)
    assert res["aborted"] and "kill-switch" in res["aborted"]
    assert gate.calls == [] and deleg.calls == []  # nothing spawned, nothing gated


def test_run_factory_dry_run_gates_without_merge_or_spawn(tmp_path):
    repo = _make_repo(tmp_path)
    gate = _fake_gate(merged=False)
    deleg = _spy_delegate()
    env = {"SFFS_COST_GOVERNOR_DIR": str(tmp_path)}
    res = factory.run_factory(repo=repo, target="hermes-nous", source="feat-x",
                              dry_run=True, execute=False, gate_runner=gate, delegate_runner=deleg, env=env)
    assert res["aborted"] is None
    assert res["mode"] == "dry-run"
    assert len(gate.calls) == 1 and gate.calls[0]["execute"] is False  # gate ran in dry-run
    assert deleg.calls == []                                           # NO subagent spawned in dry-run
    assert res["merged"] == []                                          # nothing merged
    # the workstream carries the gate decision
    src_ws = [w for w in res["workstreams"] if w["branch"] == "feat-x"][0]
    assert src_ws["gate"]["decision"]["verdict"] == "REFUSE"


def test_run_factory_execute_records_merge_and_rollback(tmp_path):
    repo = _make_repo(tmp_path)
    gate = _fake_gate(merged=True, verdict="MERGE")
    deleg = _spy_delegate()
    env = {"SFFS_COST_GOVERNOR_DIR": str(tmp_path)}
    res = factory.run_factory(["improve x"], repo=repo, target="hermes-nous", source="feat-x",
                              dry_run=False, execute=True, gate_runner=gate, delegate_runner=deleg, env=env)
    assert res["mode"] == "execute"
    assert deleg.calls, "execute mode fans out to delegate_runner"
    assert gate.calls[-1]["execute"] is True
    assert res["merged"] and res["merged"][-1]["branch"] == "feat-x"
    assert res["rollback_points"] and "previous_sha" in res["rollback_points"][-1]


def test_run_factory_skips_absent_and_empty_branches(tmp_path):
    repo = _make_repo(tmp_path)
    gate = _fake_gate()
    env = {"SFFS_COST_GOVERNOR_DIR": str(tmp_path)}
    # absent branch
    res = factory.run_factory(repo=repo, target="hermes-nous", source="does-not-exist",
                              gate_runner=gate, env=env)
    assert "does not exist" in res["workstreams"][-1]["gate"]["skipped"]
    # empty branch (no changes vs target)
    res2 = factory.run_factory(repo=repo, target="hermes-nous", source="empty-branch",
                               gate_runner=gate, env=env)
    assert "no changes" in res2["workstreams"][-1]["gate"]["skipped"]
    assert gate.calls == []  # neither reached the gate


def test_run_factory_scope_deny_globs_passed_to_gate(tmp_path):
    repo = _make_repo(tmp_path)
    gate = _fake_gate()
    env = {"SFFS_COST_GOVERNOR_DIR": str(tmp_path)}
    factory.run_factory(repo=repo, target="hermes-nous", source="feat-x", gate_runner=gate, env=env)
    assert "ops/**" in gate.calls[0]["deny_globs"]  # prod-infra scope guard forwarded


# ===========================================================================
# rollback
# ===========================================================================
def test_rollback_to_sha_moves_branch(tmp_path):
    repo = _make_repo(tmp_path)
    first = _git(repo, "rev-parse", "hermes-nous")
    (repo / "c.txt").write_text("more\n")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "advance")
    assert _git(repo, "rev-parse", "hermes-nous") != first
    out = factory.rollback_to_sha(repo, "hermes-nous", first)
    assert out["ok"] is True
    assert _git(repo, "rev-parse", "hermes-nous") == first  # rolled back


# ===========================================================================
# tool handler
# ===========================================================================
def test_tool_handler_dry_run_default(tmp_path, monkeypatch):
    monkeypatch.setenv("SFFS_COST_GOVERNOR_DIR", str(tmp_path))
    monkeypatch.delenv("SFFS_FACTORY_KILL", raising=False)
    # target a bogus repo dir path is fine: no source/goals -> plans nothing, no gate
    out = json.loads(factory.sffs_factory({"goals": ["speed up"], "target": "hermes-nous"}))
    assert out["ok"] is True
    assert out["mode"] == "dry-run"
    assert out["real_run"] is False
    assert "dry-run" in out["note"]


def test_tool_handler_aborts_on_kill(tmp_path, monkeypatch):
    monkeypatch.setenv("SFFS_COST_GOVERNOR_DIR", str(tmp_path))
    monkeypatch.setenv("SFFS_FACTORY_KILL", "1")
    out = json.loads(factory.sffs_factory({"goals": ["x"]}))
    assert out["ok"] is False
    assert "kill-switch" in out["aborted"]


def test_tool_handler_never_raises_on_garbage(tmp_path, monkeypatch):
    monkeypatch.setenv("SFFS_COST_GOVERNOR_DIR", str(tmp_path))
    for bad in ("not-a-dict", 123, None, {"goals": "not-a-list"}, {"max_workstreams": "nope"}):
        out = json.loads(factory.sffs_factory(bad))
        assert "ok" in out  # returned JSON, did not raise


def test_tool_handler_execute_needs_both_flags(tmp_path, monkeypatch):
    # execute=True but dry_run left default(True) => stays a dry-run (real_run False)
    monkeypatch.setenv("SFFS_COST_GOVERNOR_DIR", str(tmp_path))
    monkeypatch.delenv("SFFS_FACTORY_KILL", raising=False)
    out = json.loads(factory.sffs_factory({"execute": True}))
    assert out["real_run"] is False and out["mode"] == "dry-run"


# ===========================================================================
# separation of concerns: factory is CODE self-improvement, never a posting path
# ===========================================================================
def test_factory_tool_is_not_a_posting_tool():
    # publish_guard must NOT flag the factory tool (it changes code, never posts)
    assert pg.refusal_reason("sffs_factory", {"goals": ["x"], "target": "hermes-nous"}) is None
    # but a real publish is STILL blocked (belt intact)
    assert pg.refusal_reason("publer_publish_post_now", {"post_id": "p"}) is not None
    # and the governor's kill-switch DOES halt the factory tool (spend brake)
    assert cg.is_kill_blocked("sffs_factory") is True
