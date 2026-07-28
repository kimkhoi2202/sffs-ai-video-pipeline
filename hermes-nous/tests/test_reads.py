"""READ-ONLY analytics tool test — proves ``sffs_score`` validates its args, runs
network-free in dry-run, and surfaces errors as results rather than raising.

No network, no node: imports the pure module (``reads``) directly. A dry-run or
bad-arg call must NEVER reach the bridge.

It also pins the Publer removal: the read bridge this module shells out to is the
Metricool one, and the retired ``publer-read.ts`` entry is gone for good — so a
future edit cannot quietly reintroduce a dead 403-ing dependency.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

PLUGIN_DIR = Path(__file__).resolve().parents[1] / "sffs"
sys.path.insert(0, str(PLUGIN_DIR))

import reads  # noqa: E402


# ── build_score_request (pure) ───────────────────────────────────────────────
def test_build_score_request_accepts_a_clean_window():
    assert reads.build_score_request({"from": "2026-07-01", "to": "2026-07-28"}) == {
        "from": "2026-07-01",
        "to": "2026-07-28",
    }


def test_build_score_request_allows_an_empty_request():
    assert reads.build_score_request({}) == {}


@pytest.mark.parametrize("bad", ["2026-7-1", "07-01-2026", "yesterday", "", "2026-07-01T00:00:00"])
def test_build_score_request_rejects_a_non_iso_date(bad):
    with pytest.raises(reads.ReadGuardError):
        reads.build_score_request({"from": bad})


def test_build_score_request_rejects_non_object_args():
    with pytest.raises(reads.ReadGuardError):
        reads.build_score_request(["not", "an", "object"])


def test_build_score_request_passes_account_ids_through():
    assert reads.build_score_request({"account_ids": ["acc1", "acc2"]}) == {"account_ids": ["acc1", "acc2"]}


@pytest.mark.parametrize("bad", [["", "acc"], [1, 2], "acc1", [None]])
def test_build_score_request_rejects_bad_account_ids(bad):
    with pytest.raises(reads.ReadGuardError):
        reads.build_score_request({"account_ids": bad})


def test_publer_era_paging_and_sort_args_are_dropped_not_silently_ignored():
    """Metricool returns the whole brand in one call, so these no longer exist.

    They are dropped from the request rather than accepted-and-ignored, which would
    let a caller believe it had asked for an ordering it never actually got.
    """
    assert reads.build_score_request({"sort_by": "reach", "sort_type": "DESC", "max_pages": 5}) == {}


# ── default window ───────────────────────────────────────────────────────────
def test_default_window_is_thirty_days_and_iso():
    frm, to = reads.default_window()
    assert len(frm) == 10 and len(to) == 10
    assert frm < to


# ── bridge wiring ────────────────────────────────────────────────────────────
def test_bridge_entry_points_at_the_metricool_bridge_and_exists():
    entry = reads._bridge_entry()
    assert entry.name == "metricool-read.ts"
    assert entry.exists(), f"read bridge missing: {entry}"


def test_the_retired_publer_read_bridge_is_gone_and_unreferenced():
    repo = reads._repo_dir()
    src = (repo / "hermes-nous" / "sffs" / "reads.py").read_text(encoding="utf-8")
    assert "publer-read.ts" not in src
    assert not (repo / "hermes-nous" / "bridge" / "publer-read.ts").exists()


def test_a_dry_run_never_reaches_the_bridge(monkeypatch):
    def explode(*_a, **_k):  # pragma: no cover - must never run
        raise AssertionError("dry-run must not shell out to the bridge")

    monkeypatch.setattr(reads, "run_node_bridge", explode)
    out = json.loads(reads.sffs_score({"dry_run": True}))
    assert out["ok"] is True and out["dry_run"] is True


# ── handler: always returns a JSON result, never raises ──────────────────────
def test_sffs_score_dry_run_returns_the_resolved_window():
    out = json.loads(reads.sffs_score({"dry_run": True}))
    assert out["ok"] is True
    assert out["dry_run"] is True
    assert len(out["from"]) == 10 and len(out["to"]) == 10
    assert "no network call" in out["note"]


def test_sffs_score_returns_an_error_result_rather_than_raising():
    out = json.loads(reads.sffs_score({"from": "nope", "dry_run": True}))
    assert out["ok"] is False
    assert "YYYY-MM-DD" in out["error"]


def test_sffs_score_tolerates_non_dict_args():
    out = json.loads(reads.sffs_score(None))
    assert isinstance(out, dict) and "ok" in out


def test_sffs_score_calls_the_analytics_subcommand(monkeypatch):
    seen = {}

    def fake_bridge(sub, params, *, dry_run, timeout=120):
        seen["sub"] = sub
        seen["params"] = params
        return {"ok": True, "reels": []}

    monkeypatch.setattr(reads, "run_node_bridge", fake_bridge)
    out = json.loads(reads.sffs_score({"from": "2026-07-01", "to": "2026-07-28"}))
    assert out["ok"] is True
    assert seen["sub"] == "analytics"
    assert seen["params"]["from"] == "2026-07-01"
