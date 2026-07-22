"""DRAFT-ONLY safety test — proves the invariant survives the Nous tool layer.

No network, no node, no Hermes framework: this imports the plugin's pure Python
guard (``draft_guard``) directly and asserts that:

  1. ``build_draft_payload`` (the strict core) RAISES on any non-draft state, any
     scheduling/publish field, and missing account_ids / text; and
  2. ``sffs_publer_draft`` (the Hermes tool handler) returns a JSON string that
     REFUSES those same inputs, never emits anything but ``state="draft"``, and
     never raises — for valid input (in dry-run) it emits exactly a draft.

If any assertion here fails, the DRAFT-ONLY guarantee is broken and CI MUST go
red. This test is a gate on the software-factory auto-merge (see RALPH_TASK.md
completion criterion 8).
"""

from __future__ import annotations

import itertools
import json
import sys
from pathlib import Path

import pytest

# Make the plugin's pure modules importable without the Hermes framework.
# test file → tests/ → hermes-nous/ ; the plugin lives at hermes-nous/sffs/.
PLUGIN_DIR = Path(__file__).resolve().parents[1] / "sffs"
sys.path.insert(0, str(PLUGIN_DIR))

import draft_guard as dg  # noqa: E402

VALID = {
    "account_ids": ["6a5fc9dc4ccd63dc1f041549", "6a5fc5451bee22495517bcc5"],
    "text": "Smart Fella or Fart Smella? 🧠 Can you pass this one?",
    "type": "video",
}


# ---------------------------------------------------------------------------
# build_draft_payload — the strict pure core (raises on violation)
# ---------------------------------------------------------------------------

def test_valid_input_forces_draft():
    payload = dg.build_draft_payload(dict(VALID))
    assert payload["state"] == "draft"
    assert payload["account_ids"] == VALID["account_ids"]
    assert payload["text"] == VALID["text"]
    assert "scheduled_at" not in payload


def test_state_is_always_forced_even_if_absent():
    payload = dg.build_draft_payload({"account_ids": ["a"], "text": "hi"})
    assert payload["state"] == "draft"


@pytest.mark.parametrize(
    "bad_state",
    ["scheduled", "published", "live", "draft_public", "draft_private", "DRAFT", "Draft"],
)
def test_refuses_non_draft_state(bad_state):
    # Note the near-misses: "draft_public"/"draft_private" are real Publer states
    # but NOT the frozen "draft" — they must be refused, as must case variants.
    with pytest.raises(dg.DraftGuardError):
        dg.build_draft_payload({**VALID, "state": bad_state})


@pytest.mark.parametrize(
    "sched", ["2026-08-01T09:00:00Z", "2030-01-01T00:00:00+00:00", "now"]
)
def test_refuses_scheduled_at(sched):
    with pytest.raises(dg.DraftGuardError):
        dg.build_draft_payload({**VALID, "scheduled_at": sched})


@pytest.mark.parametrize(
    "key", ["schedule", "publish", "publish_at", "auto_publish", "go_live"]
)
def test_refuses_other_live_keys(key):
    with pytest.raises(dg.DraftGuardError):
        dg.build_draft_payload({**VALID, key: True})


def test_empty_scheduled_at_is_treated_as_absent():
    # Mirrors the TS guard: an empty/falsey scheduled_at is a no-op, not a live post.
    payload = dg.build_draft_payload({**VALID, "scheduled_at": ""})
    assert payload["state"] == "draft"


@pytest.mark.parametrize(
    "bad_accounts", [None, [], "notalist", [""], ["ok", 123], [None]]
)
def test_requires_account_ids(bad_accounts):
    with pytest.raises(dg.DraftGuardError):
        dg.build_draft_payload({"text": "hi", "account_ids": bad_accounts})


@pytest.mark.parametrize("bad_text", [None, "", "   ", 123, []])
def test_requires_text(bad_text):
    with pytest.raises(dg.DraftGuardError):
        dg.build_draft_payload({"account_ids": ["a"], "text": bad_text})


def test_non_dict_args_rejected():
    for bad in [None, 42, "nope", ["a"]]:
        with pytest.raises(dg.DraftGuardError):
            dg.build_draft_payload(bad)  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# sffs_publer_draft — the Hermes tool handler (returns JSON, never raises)
# ---------------------------------------------------------------------------

def test_handler_dry_run_emits_only_draft():
    out = dg.sffs_publer_draft({**VALID, "dry_run": True})
    assert isinstance(out, str), "handler must return a JSON string"
    data = json.loads(out)
    assert data["ok"] is True
    assert data["dry_run"] is True
    assert data["state"] == "draft"
    assert data["payload"]["state"] == "draft"
    assert "job_id" not in data  # dry-run never creates anything


@pytest.mark.parametrize(
    "bad",
    [
        {"state": "scheduled"},
        {"state": "published"},
        {"state": "draft_public"},
        {"scheduled_at": "2026-08-01T09:00:00Z"},
        {"publish": True},
        {"auto_publish": True},
        {"go_live": True},
    ],
)
def test_handler_refuses_and_never_emits_non_draft(bad):
    # dry_run=True is set to prove that even the "would-be create" path refuses
    # and never reaches a network call.
    out = dg.sffs_publer_draft({**VALID, **bad, "dry_run": True})
    data = json.loads(out)
    assert data["ok"] is False
    assert data.get("refused") is True
    assert "job_id" not in data  # never created / scheduled anything
    # Any state ever reported by this tool is only ever "draft".
    assert data.get("state", "draft") == "draft"


def test_handler_never_raises_on_garbage():
    for garbage in [None, 42, "nope", [], {"account_ids": "notalist"}, {"text": "x"}]:
        out = dg.sffs_publer_draft(garbage)  # type: ignore[arg-type]
        data = json.loads(out)
        assert data["ok"] is False  # refused, but no exception escaped


def test_handler_dry_run_state_is_always_draft_over_many_inputs():
    # Property-style: across a batch of valid inputs, the emitted payload state
    # is ALWAYS "draft" and never a job/live post.
    texts = ["a", "quiz time", "🧠🔥 can you pass?", "x" * 300]
    account_sets = [["x"], ["x", "y"], ["a", "b", "c"]]
    types = ["video", "photo", "carousel"]
    for text, accts, typ in itertools.product(texts, account_sets, types):
        out = dg.sffs_publer_draft(
            {"account_ids": accts, "text": text, "type": typ, "dry_run": True}
        )
        data = json.loads(out)
        assert data["ok"] is True
        assert data["payload"]["state"] == "draft"
        assert "job_id" not in data


def test_allowed_post_state_constant_is_frozen_to_draft():
    # A canary: if someone ever changes the invariant, this fails loudly.
    assert dg.ALLOWED_POST_STATE == "draft"
