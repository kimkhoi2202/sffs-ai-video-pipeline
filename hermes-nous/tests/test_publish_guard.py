"""Defense-in-depth DRAFT-ONLY hook test — proves the pre_tool_call belt refuses
every publish/schedule/post-mutation call while NEVER blocking unrelated tools.

No network, no node, no Hermes framework: imports the pure guard (``publish_guard``)
directly and asserts:

  1. ``refusal_reason`` refuses publish/schedule/go-live/mutate calls (by tool NAME
     and by ARGUMENT intent, including nested + camelCase/sep variants), and
     ALLOWS the sanctioned draft path and all unrelated tools (no false positives);
  2. ``pre_tool_call`` (the hook) returns a valid framework block directive
     ({"action":"block","message": <non-empty>}) on refusal and None otherwise,
     and never raises on garbage.

If any assertion fails, the DRAFT-ONLY belt is broken and CI MUST go red. This
test gates the software-factory auto-merge (RALPH_TASK.md criterion 8).
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

# Import the plugin's pure guard without the Hermes framework.
PLUGIN_DIR = Path(__file__).resolve().parents[1] / "sffs"
sys.path.insert(0, str(PLUGIN_DIR))

import publish_guard as pg  # noqa: E402


# ---------------------------------------------------------------------------
# Tool NAME denylist — publish / schedule / mutate-existing-post actions
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "name",
    [
        "publer_publish_post_now",   # Publer MCP: publish now
        "publer_update_post",        # Publer MCP: mutate existing post
        "publer_delete_post",        # Publer MCP: delete existing post
        "publer_delete_posts",       # Publer MCP: bulk delete
        "publishPost",
        "schedule_post",
        "schedulePost",
        "post_now",
        "go_live",
        "goLive",
    ],
)
def test_refuses_publish_schedule_mutate_tool_names(name):
    reason = pg.refusal_reason(name, {})
    assert reason, f"expected {name!r} to be refused by name"


@pytest.mark.parametrize(
    "name",
    [
        "sffs_publer_draft",          # the sanctioned draft-only path
        "sffs_donottouch_snapshot",   # read-only
        "sffs_donottouch_verify",     # read-only
        "terminal",
        "read_file",
        "write_file",
        "patch",
        "delegate_task",
        "cronjob",
        "web_search",
        "kanban_update_task",
        "compost_heap",               # 'post' substring must NOT trip anything
        "postgres_query",
    ],
)
def test_allows_benign_and_sanctioned_tool_names_with_empty_args(name):
    assert pg.refusal_reason(name, {}) is None, f"{name!r} must not be refused by name"


# ---------------------------------------------------------------------------
# Argument intent — scheduling keys
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "key",
    [
        "scheduled_at",
        "scheduledAt",
        "scheduled-at",
        "Scheduled_At",
        "publish_at",
        "scheduled_for",
        "schedule_time",
        "go_live_at",
    ],
)
def test_refuses_schedule_keys_when_truthy(key):
    assert pg.refusal_reason("some_tool", {key: "2026-08-01T09:00:00Z"})
    # camel/sep variants land on the same normalized key


@pytest.mark.parametrize("falsey", ["", None, False, 0, []])
def test_schedule_key_empty_or_falsey_is_allowed(falsey):
    # Mirrors the TS/py belt: an empty/falsey scheduled_at is a no-op.
    assert pg.refusal_reason("some_tool", {"scheduled_at": falsey}) is None


def test_scheduled_ids_key_is_not_treated_as_schedule_intent():
    # CRITICAL false-positive guard: the do-not-touch snapshot fields must pass.
    snap = {"scheduled_ids": ["a", "b"], "published_ids": ["c"], "captured_at": "t"}
    assert pg.refusal_reason("sffs_donottouch_verify", {"snapshot": snap}) is None
    assert pg.refusal_reason("anything", snap) is None


def test_cron_schedule_expression_key_is_allowed():
    # The framework cron tool takes a `schedule` expression — must NOT be blocked.
    assert pg.refusal_reason("cronjob", {"schedule": "24h", "name": "sffs-nightly"}) is None


# ---------------------------------------------------------------------------
# Argument intent — publish / go-live flags
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "key", ["publish", "auto_publish", "publish_now", "go_live", "make_live", "post_now"]
)
def test_refuses_publish_flags_when_truthy(key):
    assert pg.refusal_reason("some_tool", {key: True})


@pytest.mark.parametrize("key", ["publish", "auto_publish", "go_live", "post_now"])
def test_publish_flags_falsey_is_allowed(key):
    assert pg.refusal_reason("some_tool", {key: False}) is None
    assert pg.refusal_reason("some_tool", {key: 0}) is None


# ---------------------------------------------------------------------------
# Argument intent — post-state values
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "value",
    [
        "scheduled",
        "published",
        "publishing",
        "live",
        "draft_public",   # Publer draft-variant that is NOT the frozen "draft"
        "draft_private",
        "queued",
        "PUBLISHED",
        "Scheduled",
    ],
)
def test_refuses_live_state_values_on_any_tool(value):
    assert pg.refusal_reason("some_tool", {"state": value})
    assert pg.refusal_reason("some_tool", {"post_state": value})


def test_allows_draft_state():
    assert pg.refusal_reason("publer_create_post", {"state": "draft"}) is None
    assert pg.refusal_reason("some_tool", {"state": "draft"}) is None


@pytest.mark.parametrize(
    "value", ["open", "in_progress", "active", "done", "closed", "merged", "pending"]
)
def test_non_posting_tool_arbitrary_state_is_allowed(value):
    # A kanban/git/job `state` on an unrelated tool must NOT be refused.
    assert pg.refusal_reason("kanban_update_task", {"state": value}) is None
    assert pg.refusal_reason("gh_pr", {"state": value}) is None


@pytest.mark.parametrize("value", ["scheduled", "queued", "foobar", "draft_public"])
def test_posting_tool_non_draft_state_is_refused_strictly(value):
    # On a posting tool, ANY non-draft state is refused (the literal state!=draft).
    assert pg.refusal_reason("publer_create_post", {"state": value})


# ---------------------------------------------------------------------------
# Nested args + free-form values (no false positives)
# ---------------------------------------------------------------------------


def test_refuses_nested_live_state_in_media_objects():
    args = {
        "account_ids": ["x"],
        "text": "hi",
        "media_objects": [{"id": "m1", "state": "published"}],
    }
    assert pg.refusal_reason("publer_create_post", args)


def test_refuses_nested_scheduled_at():
    args = {"post": {"inner": {"scheduled_at": "2026-01-01T00:00:00Z"}}}
    assert pg.refusal_reason("some_tool", args)


def test_freeform_string_values_are_not_word_scanned():
    # The dangerous words appearing INSIDE free-form values must NOT trip the guard
    # (only specific keys/state-values are inspected).
    assert pg.refusal_reason("terminal", {"command": "npm publish && gh release"}) is None
    assert pg.refusal_reason("delegate_task", {"goal": "publish the post and go live now"}) is None
    assert pg.refusal_reason("write_file", {"path": "publish.md", "content": "schedule things"}) is None


def test_sanctioned_draft_tool_valid_args_allowed():
    args = {
        "account_ids": ["6a5fc9dc4ccd63dc1f041549"],
        "text": "Smart Fella or Fart Smella? 🧠",
        "type": "video",
        "media_ids": ["m1"],
        "dry_run": True,
    }
    assert pg.refusal_reason("sffs_publer_draft", args) is None


# ---------------------------------------------------------------------------
# The hook wrapper — framework block-directive contract
# ---------------------------------------------------------------------------


def test_hook_returns_valid_block_directive_on_refusal():
    out = pg.pre_tool_call(tool_name="publer_publish_post_now", args={"post_id": "p1"})
    assert isinstance(out, dict)
    assert out.get("action") == "block"
    msg = out.get("message")
    # The framework requires a NON-EMPTY string message for a block to take effect.
    assert isinstance(msg, str) and msg.strip()
    assert "DRAFT-ONLY" in msg


def test_hook_returns_none_when_allowed():
    assert pg.pre_tool_call(tool_name="terminal", args={"command": "ls"}) is None
    assert pg.pre_tool_call(tool_name="sffs_publer_draft", args={"account_ids": ["a"], "text": "x"}) is None


def test_hook_blocks_scheduled_at_via_args():
    out = pg.pre_tool_call(tool_name="sffs_publer_draft", args={"scheduled_at": "2026-08-01T00:00:00Z"})
    assert isinstance(out, dict) and out.get("action") == "block" and out.get("message")


@pytest.mark.parametrize("bad", [None, 42, "nope", [], {"weird": object()}, {"args": None}])
def test_hook_never_raises_on_garbage(bad):
    # Must never raise regardless of input shape (Hermes hook contract).
    out = pg.pre_tool_call(tool_name="whatever", args=bad)
    assert out is None or (isinstance(out, dict) and out.get("action") == "block")


def test_hook_handles_missing_kwargs():
    # Called with no args at all — must not raise.
    assert pg.pre_tool_call() is None


def test_build_block_message_is_non_empty():
    d = pg.build_block("publer_publish_post_now", "because reasons")
    assert d["action"] == "block"
    assert isinstance(d["message"], str) and d["message"].strip()


def test_allowed_state_constant_is_draft():
    assert pg.ALLOWED_STATE_VALUE == "draft"
