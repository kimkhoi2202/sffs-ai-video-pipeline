"""SUPERVISOR tests — the ALWAYS-ON continuous (NON-posting) orchestrator.

Proves the supervisor: plans only DUE non-posting work by cadence (converges, no
churn); PAUSES fail-closed on the kill-switch and the governor ceiling; runs
injected executors only when LIVE (dry-run by default → zero side effects); records
per-action cadence; and — the CRITICAL INVARIANT — has NO posting/scheduling action
and no posting code path anywhere (continuous WORK, bounded POSTING).

Hermetic: stdlib-only; a tmp state/status dir; the cost governor is injected (a fake)
so the tests never depend on the real stop-file, and no executor has a side effect.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

import supervisor as sup  # noqa: E402


class _FakeCG:
    """Injectable cost-governor: fully controllable kill / ceiling, no real files."""
    def __init__(self, kill=None, ceiling=None):
        self._kill = kill
        self._ceiling = ceiling
        self.snapshots = 0
    def kill_switch_reason(self, env=None, *a, **k):
        return self._kill
    def ceiling_reason(self, *a, **k):
        return self._ceiling
    def read_tally(self, *a, **k):
        return {}
    def load_limits(self, *a, **k):
        return {}
    def write_snapshot(self, *a, **k):
        self.snapshots += 1


@pytest.fixture()
def isolated(tmp_path, monkeypatch):
    """Redirect the supervisor's state/status/log into a tmp dir + inject a clean cg."""
    monkeypatch.setattr(sup, "SUP_DIR", tmp_path)
    monkeypatch.setattr(sup, "STATUS_FILE", tmp_path / "supervisor-status.json")
    monkeypatch.setattr(sup, "STATE_FILE", tmp_path / "supervisor-state.json")
    monkeypatch.setattr(sup, "LOG_FILE", tmp_path / "supervisor.log")
    monkeypatch.setattr(sup, "cg", _FakeCG())
    return tmp_path


CFG = dict(sup.default_cfg())


# ── PURE planning ────────────────────────────────────────────────────────────
def test_plan_actions_all_due_on_fresh_state_capped():
    # never-run state ⇒ everything due, but capped to converge (max_actions_per_cycle)
    cfg = {**CFG, "max_actions_per_cycle": 2}
    due = sup.plan_actions({"last": {}}, now=1_000_000.0, cfg=cfg)
    assert due == ["knowledge", "content_prep"]  # priority order, capped at 2


def test_plan_actions_respects_cadence_and_converges_to_idle():
    now = 1_000_000.0
    # everything ran "just now" ⇒ nothing due ⇒ idle (no churn)
    last = {a: now for a in sup.ACTIONS}
    assert sup.plan_actions({"last": last}, now=now, cfg=CFG) == []


def test_plan_actions_only_the_elapsed_action_is_due():
    now = 1_000_000.0
    last = {a: now for a in sup.ACTIONS}
    last["upkeep"] = now - (CFG["upkeep_interval"] + 1)  # only upkeep has elapsed
    due = sup.plan_actions({"last": last}, now=now, cfg=CFG)
    assert due == ["upkeep"]


def test_plan_actions_never_returns_a_posting_action():
    due = sup.plan_actions({"last": {}}, now=1e12, cfg={**CFG, "max_actions_per_cycle": 99})
    for a in due:
        assert a in sup.ACTIONS
        assert a not in ("post", "schedule", "publish")


# ── one cycle: pause / dry-run / live ────────────────────────────────────────
def test_run_cycle_pauses_fail_closed_on_kill_switch(isolated, monkeypatch):
    monkeypatch.setattr(sup, "cg", _FakeCG(kill="kill-switch engaged (stop-file present)"))
    out = sup.run_cycle({"last": {}}, now=1_000_000.0, cfg=CFG, env={}, dry_run=False,
                        executors={a: (lambda e, c: (_ for _ in ()).throw(AssertionError("must not run when killed"))) for a in sup.ACTIONS})
    assert out["action"] == "paused" and "kill-switch" in out["reason"]


def test_run_cycle_pauses_on_governor_ceiling(isolated, monkeypatch):
    monkeypatch.setattr(sup, "cg", _FakeCG(ceiling="daily USD ceiling reached"))
    out = sup.run_cycle({"last": {}}, now=1_000_000.0, cfg=CFG, env={}, dry_run=False,
                        executors={a: (lambda e, c: {"ran": a}) for a in sup.ACTIONS})
    assert out["action"] == "paused" and "ceiling" in out["reason"]


def test_run_cycle_dry_run_is_the_default_and_has_no_side_effects(isolated):
    calls = []
    execs = {a: (lambda e, c, _a=a: calls.append(_a)) for a in sup.ACTIONS}
    out = sup.run_cycle({"last": {}}, now=1_000_000.0, cfg=CFG, env={}, executors=execs)  # dry_run defaults True
    assert out["action"] == "worked" and out["dry_run"] is True
    assert calls == []  # NO executor was actually invoked in dry-run


def test_run_cycle_live_runs_injected_executors_and_records_cadence(isolated):
    calls = []
    execs = {a: (lambda e, c, _a=a: (calls.append(_a) or {"action": _a, "ok": True})) for a in sup.ACTIONS}
    st = {"last": {}}
    out = sup.run_cycle(st, now=1_000_000.0, cfg={**CFG, "max_actions_per_cycle": 2}, env={}, executors=execs, dry_run=False)
    assert out["action"] == "worked"
    assert calls == ["knowledge", "content_prep"]  # only the due (capped) work ran
    assert st["last"]["knowledge"] == 1_000_000.0  # cadence recorded so it won't re-run immediately
    assert st["totals"]["knowledge"] == 1


def test_run_cycle_idles_when_nothing_due(isolated):
    now = 1_000_000.0
    st = {"last": {a: now for a in sup.ACTIONS}}
    out = sup.run_cycle(st, now=now, cfg=CFG, env={}, executors={}, dry_run=False)
    assert out["action"] == "idle"


# ── CRITICAL INVARIANT: continuous WORK, bounded POSTING ─────────────────────
def test_invariant_action_set_has_no_posting_action():
    for forbidden in ("post", "schedule", "publish", "go_live", "draft"):
        assert forbidden not in sup.ACTIONS


def test_invariant_supervisor_source_has_no_posting_code_path():
    src = Path(sup.__file__).read_text(encoding="utf-8")
    # the supervisor must never import/call ANY scheduling/posting entrypoint
    for forbidden in ("kickoff_schedule", "createScheduledPostArmed", "createScheduled",
                      "publer-draft", "publer_publish_post_now", "publer_create_post",
                      "scheduled_at", "sffs_publer_draft"):
        assert forbidden not in src, f"supervisor must not reference posting path: {forbidden}"
