"""Shared fixtures for the gate's own end-to-end suite.

These tests validate the *gate infrastructure* (harness / review agent / two-key
auto-merge) — they are deliberately kept OUT of the harness's own pytest leg
(which globs only ``tests/test_*.py`` at the top level) so the harness never
tests itself recursively. They DO run under the normal ``pytest hermes-nous/tests``
collection.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

# gate/ modules live under hermes-nous/scripts/gate — put it on the path so the
# tests can import them flat (harness/review_agent/auto_merge/sffs_selfcheck).
E2E_DIR = Path(__file__).resolve().parent
HERMES_NOUS_DIR = E2E_DIR.parent.parent
GATE_DIR = HERMES_NOUS_DIR / "scripts" / "gate"
REPO_DIR = HERMES_NOUS_DIR.parent
sys.path.insert(0, str(GATE_DIR))


def _git(repo: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-C", str(repo), *args], capture_output=True, text=True, check=True
    ).stdout


@pytest.fixture()
def temp_repo(tmp_path):
    """A throwaway git repo with a ``hn`` (target) branch and a ``feat`` branch
    that adds ``feature.txt``. Returns (repo_path, target='hn', source='feat')."""
    repo = tmp_path / "repo"
    repo.mkdir()
    _git(repo, "init", "-q", "-b", "hn")
    _git(repo, "config", "user.email", "gate@test")
    _git(repo, "config", "user.name", "gate test")
    (repo / "a.txt").write_text("base\n")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-qm", "base")
    _git(repo, "checkout", "-q", "-b", "feat")
    (repo / "feature.txt").write_text("new feature\n")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-qm", "feat")
    _git(repo, "checkout", "-q", "hn")
    return repo, "hn", "feat"


@pytest.fixture()
def repo_root() -> Path:
    return REPO_DIR


@pytest.fixture()
def gate_dir() -> Path:
    return GATE_DIR


# Deterministic key runners for gate-logic tests (no real harness/model).
def green_harness(_worktree):
    return {"verdict": "GREEN", "ok": True}


def red_harness(_worktree):
    return {"verdict": "RED", "ok": False, "error": "injected red"}


def approve_review(_diff):
    return {"verdict": "APPROVE", "approved": True, "source": "static+model", "reasons": ["ok"]}


def reject_review(_diff):
    return {"verdict": "REJECT", "approved": False, "source": "static", "reasons": ["injected reject"]}
