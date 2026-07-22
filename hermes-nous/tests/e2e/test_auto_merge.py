"""E2E tests for the TWO-KEY auto-merge gate (:mod:`auto_merge`).

Covers the pure decision truth-table, the guards (kill-switch / protected /
scope), the git merge mechanics on throwaway repos (dry-run never moves the
target; execute advances it only on green+approve), unmergeable + no-change
handling, logging, and one REAL end-to-end run wiring the actual harness +
review agent through a real git merge."""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

import auto_merge as am


# Deterministic key runners for the gate-logic tests (no real harness/model).
def green_harness(_wt):
    return {"verdict": "GREEN", "ok": True}


def red_harness(_wt):
    return {"verdict": "RED", "ok": False, "error": "injected red"}


def approve_review(_diff):
    return {"verdict": "APPROVE", "approved": True, "source": "static+model", "reasons": ["ok"]}


def reject_review(_diff):
    return {"verdict": "REJECT", "approved": False, "source": "static", "reasons": ["injected reject"]}


def _git(repo, *a):
    return subprocess.run(["git", "-C", str(repo), *a], capture_output=True, text=True, check=True).stdout


def _sha(repo, ref):
    return _git(repo, "rev-parse", ref).strip()


# --- the pure two-key decision ----------------------------------------------
@pytest.mark.parametrize(
    "harness_ok,review_approved,mergeable,guards,expect_merge",
    [
        (True, True, True, [], True),        # both keys + clean + no guard -> MERGE
        (False, True, True, [], False),      # key1 red
        (True, False, True, [], False),      # key2 reject
        (False, False, True, [], False),     # both fail
        (True, True, False, [], False),      # conflict
        (True, True, True, ["scope"], False),  # guard tripped
    ],
)
def test_decide_truth_table(harness_ok, review_approved, mergeable, guards, expect_merge):
    d = am.decide(harness_ok=harness_ok, review_approved=review_approved, mergeable=mergeable, guard_failures=guards)
    assert d["merge"] is expect_merge
    assert d["verdict"] == ("MERGE" if expect_merge else "REFUSE")


# --- guards ------------------------------------------------------------------
def test_kill_switch_env(monkeypatch):
    monkeypatch.setenv("SFFS_FACTORY_KILL", "1")
    assert am.check_kill_switch() is not None


def test_kill_switch_file(tmp_path):
    f = tmp_path / "STOP"
    assert am.check_kill_switch(f) is None
    f.write_text("stop")
    assert am.check_kill_switch(f) is not None


def test_protected_branches():
    assert am.check_protected("main") is not None
    assert am.check_protected("refs/heads/master") is not None
    assert am.check_protected("hermes-nous") is None


def test_scope_deny():
    assert am.check_scope(["ops/deploy.sh"], ("ops/**",)) is not None
    assert am.check_scope(["hermes-nous/sffs/x.py"], ("ops/**",)) is None


# --- git merge mechanics (injected runners; real git) ------------------------
def test_dry_run_green_approve_does_not_merge(temp_repo, tmp_path):
    repo, target, source = temp_repo
    before = _sha(repo, target)
    res = am.two_key_gate(repo, source, target, execute=False,
                          harness_runner=green_harness, review_runner=approve_review,
                          log_file=tmp_path / "log")
    assert res["decision"]["merge"] is True
    assert res["merged"] is False
    assert _sha(repo, target) == before, "dry-run must NOT move the target branch"


def test_execute_green_approve_merges(temp_repo, tmp_path):
    repo, target, source = temp_repo
    before = _sha(repo, target)
    res = am.two_key_gate(repo, source, target, execute=True,
                          harness_runner=green_harness, review_runner=approve_review,
                          log_file=tmp_path / "log")
    assert res["merged"] is True
    assert _sha(repo, target) != before, "target must advance on a successful merge"
    assert "feature.txt" in _git(repo, "ls-tree", "-r", "--name-only", target)


def test_execute_red_harness_refuses(temp_repo, tmp_path):
    repo, target, source = temp_repo
    before = _sha(repo, target)
    res = am.two_key_gate(repo, source, target, execute=True,
                          harness_runner=red_harness, review_runner=approve_review,
                          log_file=tmp_path / "log")
    assert res["decision"]["merge"] is False and res["merged"] is False
    assert _sha(repo, target) == before


def test_execute_review_reject_refuses(temp_repo, tmp_path):
    repo, target, source = temp_repo
    before = _sha(repo, target)
    res = am.two_key_gate(repo, source, target, execute=True,
                          harness_runner=green_harness, review_runner=reject_review,
                          log_file=tmp_path / "log")
    assert res["decision"]["merge"] is False and res["merged"] is False
    assert _sha(repo, target) == before


def test_protected_target_refuses_before_any_work(temp_repo, tmp_path, monkeypatch):
    repo, _target, source = temp_repo
    # rename hn->main to make the target protected
    _git(repo, "branch", "-m", "hn", "main")
    called = {"n": 0}

    def spy(_wt):
        called["n"] += 1
        return {"verdict": "GREEN", "ok": True}

    res = am.two_key_gate(repo, source, "main", execute=True,
                          harness_runner=spy, review_runner=approve_review,
                          log_file=tmp_path / "log")
    assert res["decision"]["merge"] is False
    assert called["n"] == 0, "protected target must refuse before running the harness"


def test_kill_switch_refuses(temp_repo, tmp_path, monkeypatch):
    repo, target, source = temp_repo
    monkeypatch.setenv("SFFS_FACTORY_KILL", "1")
    res = am.two_key_gate(repo, source, target, execute=True,
                          harness_runner=green_harness, review_runner=approve_review,
                          log_file=tmp_path / "log")
    assert res["decision"]["merge"] is False and res["merged"] is False


def test_scope_deny_refuses(temp_repo, tmp_path):
    repo, target, source = temp_repo
    res = am.two_key_gate(repo, source, target, execute=True,
                          harness_runner=green_harness, review_runner=approve_review,
                          deny_globs=("feature.txt",), log_file=tmp_path / "log")
    assert res["decision"]["merge"] is False and res["merged"] is False


def test_no_changes_refuses(temp_repo, tmp_path):
    repo, target, _source = temp_repo
    res = am.two_key_gate(repo, target, target, execute=True,
                          harness_runner=green_harness, review_runner=approve_review,
                          log_file=tmp_path / "log")
    assert res["decision"]["merge"] is False


def test_unmergeable_conflict_refuses(temp_repo, tmp_path):
    repo, target, source = temp_repo
    # create a conflicting change on the target so the merge cannot apply cleanly
    _git(repo, "checkout", "-q", target)
    (repo / "feature.txt").write_text("conflicting target content\n")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-qm", "conflict on target")
    before = _sha(repo, target)
    res = am.two_key_gate(repo, source, target, execute=True,
                          harness_runner=green_harness, review_runner=approve_review,
                          log_file=tmp_path / "log")
    assert res.get("mergeable") is False
    assert res["decision"]["merge"] is False and res["merged"] is False
    assert _sha(repo, target) == before, "a conflicting merge must leave the target untouched"


def test_log_is_written(temp_repo, tmp_path):
    repo, target, source = temp_repo
    log = tmp_path / "auto_merge.log"
    am.two_key_gate(repo, source, target, execute=False,
                    harness_runner=green_harness, review_runner=approve_review, log_file=log)
    assert log.exists() and log.read_text().strip()


# --- one REAL end-to-end: actual harness + review agent through a real merge --
@pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")
def test_real_harness_and_review_through_gate(repo_root, tmp_path):
    """Clone the repo, add a benign feature branch, and run the gate dry-run with
    the REAL harness (key #1) + the REAL review agent's static floor (key #2)."""
    # Resolve the shared (non-worktree) git dir so the clone has the committed tip.
    try:
        common = subprocess.run(
            ["git", "-C", str(repo_root), "rev-parse", "--path-format=absolute", "--git-common-dir"],
            capture_output=True, text=True, check=True,
        ).stdout.strip()
        main_repo = Path(common).parent
        clone = tmp_path / "clone"
        subprocess.run(["git", "clone", "--quiet", "--local", str(main_repo), str(clone)], check=True)
        _git(clone, "config", "user.email", "gate@test")
        _git(clone, "config", "user.name", "gate test")
        _git(clone, "checkout", "-q", "hermes-nous")
        _git(clone, "checkout", "-q", "-b", "feat-benign")
        (clone / "hermes-nous" / "scratch_note.txt").write_text("benign non-code note\n")
        _git(clone, "add", "-A")
        _git(clone, "commit", "-qm", "benign note")
    except Exception as exc:  # noqa: BLE001 — environment/setup issue, not a gate defect
        pytest.skip(f"could not set up real-integration clone: {exc}")

    res = am.two_key_gate(
        clone, "feat-benign", "hermes-nous",
        execute=False,  # dry-run: never advances anything
        review_runner=lambda diff: __import__("review_agent").review(diff, require_model=False),
        log_file=tmp_path / "log",
    )
    # Real harness must be GREEN and the benign change must pass the static floor.
    assert res["keys"]["harness"]["verdict"] == "GREEN", res["keys"]["harness"]
    assert res["keys"]["review"]["verdict"] == "APPROVE", res["keys"]["review"]
    assert res["decision"]["merge"] is True
    assert res["merged"] is False  # dry-run
