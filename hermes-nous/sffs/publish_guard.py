"""SFFS publish/schedule defense-in-depth guard — the framework-layer belt.

This is the THIRD layer of the DRAFT-ONLY guarantee, sitting *above* the two
layer the loop itself applies (Metricool ``draft:true`` / ``autoPublish:false``)
(the Node suspenders):

  * belt        — draft_guard.build_draft_payload() guards the sanctioned
                  ``sffs_publer_draft`` tool.
  * suspenders  — the Node createDraftOnly path re-validates.
  * DEFENSE-IN-DEPTH (here) — a Nous ``pre_tool_call`` hook that inspects EVERY
                  tool call the agent makes (ours, future ones, and — critically —
                  any Publer MCP tools like ``publer_publish_post_now`` /
                  ``publer_update_post`` / ``publer_delete_post`` that might ever
                  be enabled) and HARD-REFUSES any call carrying publish / schedule
                  / go-live / post-mutation intent. It is a belt across ALL tools,
                  not just the SFFS plugin's.

Contract (verified against the framework, hermes_cli/plugins.py
``_get_pre_tool_call_directive_details`` + model_tools.py ``resolve_pre_tool_block``):
a ``pre_tool_call`` hook BLOCKS a tool call by returning
``{"action": "block", "message": "<non-empty reason>"}``; the message becomes the
tool result the model sees. Returning ``None`` (or anything else) lets the call
proceed. The first valid ``block`` wins. ``args`` is always a dict at the hook.

By DESIGN there is NO disable/kill env for this guard: DRAFT-ONLY posting is a
frozen, physically-enforced invariant (see .ralph/guardrails.md). The cost
governor's kill-switch (a later iteration) halts *spend*, never this safety belt.

Kept stdlib-only and free of intra-package imports so the refusal logic can be
unit-tested without the Hermes framework, without Node, and without any network —
see hermes-nous/tests/test_publish_guard.py.

FALSE-POSITIVE DISCIPLINE (why this does not break unrelated tools):
  * Only EXACT, normalized argument KEYS are matched — never substrings of a key.
    So ``scheduled_ids`` / ``published_ids`` (the do-not-touch snapshot fields) and
    ``schedule`` (the cron tool's expression arg) are NOT treated as schedule
    intent.
  * Argument VALUES are only inspected under state-like keys (``state`` /
    ``post_state`` / ``post_status``) and only flagged when the value names a
    live social-post state. So a kanban ``state="in_progress"`` or a git
    ``state="open"`` is untouched.
  * Free-form string values are NEVER word-scanned, so ``terminal`` running
    ``npm publish`` or ``delegate_task`` with goal "publish the post" is untouched.
"""

from __future__ import annotations

import re
from typing import Any, Dict, Iterable, List, Optional, Tuple

# The one post state the whole system is allowed to emit (mirrors
# hermes/src/config.ts CONFIG.ALLOWED_POST_STATE).
ALLOWED_STATE_VALUE = "draft"


def _norm(s: Any) -> str:
    """Lowercase and strip every non-alphanumeric char.

    Makes ``scheduled_at`` / ``scheduledAt`` / ``scheduled-at`` / ``Scheduled_At``
    all compare equal, so key/value matching is spelling-robust.
    """
    if not isinstance(s, str):
        return ""
    return re.sub(r"[^a-z0-9]", "", s.lower())


# --- Argument KEYS (matched EXACTLY after normalization) --------------------

# Keys that schedule a post for later. Any truthy value => refuse.
# NOTE: bare "schedule" is deliberately EXCLUDED — the framework cron tool takes a
# ``schedule`` expression arg, and blocking it would break the agent's own cron.
_SCHEDULE_KEYS = frozenset(
    _norm(k)
    for k in (
        "scheduled_at",
        "publish_at",
        "scheduled_for",
        "schedule_for",
        "schedule_at",
        "scheduled_time",
        "schedule_time",
        "go_live_at",
        "golive_at",
    )
)

# Keys that publish / go live now. Any truthy value => refuse.
_PUBLISH_FLAG_KEYS = frozenset(
    _norm(k)
    for k in (
        "publish",
        "auto_publish",
        "publish_now",
        "go_live",
        "make_live",
        "post_now",
    )
)

# Keys whose VALUE names a post-lifecycle state.
_STATE_KEYS = frozenset(_norm(k) for k in ("state", "post_state", "post_status"))

# State VALUES that mean a live / scheduled / non-draft social post => refuse.
# Includes the draft-VARIANTS (draft_public / draft_private) which are NOT the frozen
# "draft": a "public draft" is visible, so it is a live state as far as this guard cares.
_LIVE_STATE_VALUES = frozenset(
    _norm(v)
    for v in (
        "scheduled",
        "scheduling",
        "schedule",
        "published",
        "publish",
        "publishing",
        "live",
        "going_live",
        "draft_public",
        "draft_private",
        "queued",
        "queue",
        "auto_scheduled",
    )
)

# --- Tool NAME signals (matched as normalized substrings) -------------------

# Normalized-name substrings that mark a tool as a live-publish / schedule / or
# EXISTING-POST-MUTATION action. Any match => refuse outright. These are deliberately
# scheduler-agnostic: they catch any MCP surface named publish_post_now /
# update_post / delete_post, whoever ships it. Creating a *draft* is NOT here
# (create_post is judged by its args instead — a plain draft is fine).
_DENY_NAME_SUBSTRINGS: Tuple[str, ...] = (
    "publishpost",     # publish_post / publishPost / *_publish_post[_now]
    "postnow",         # *_post_now
    "schedulepost",    # schedule_post
    "golive",          # go_live / goLive
    "updatepost",      # update_post — mutating an existing post (do-not-touch)
    "deletepost",      # delete_post[s] — deleting an existing post (do-not-touch)
)

# Normalized-name substrings that mark a tool as POSTING-related, so the strict
# "any non-draft state => refuse" rule applies (the literal `state != draft`
# guard, scoped to where a post state is meaningful so it never trips a kanban /
# git / job ``state`` on an unrelated tool).
_POSTING_TOOL_MARKERS: Tuple[str, ...] = (
    "metricool",
    "createpost",
    "schedulepost",
    "publishpost",
    "socialpost",
)

# Bounds for the (shallow) argument walk — defends against pathological inputs
# while still reaching the nested media_objects/post objects a posting call might carry.
_MAX_DEPTH = 3
_MAX_NODES = 5000


def _is_present(value: Any) -> bool:
    """Truthiness that treats empty/false/zero as "not present".

    ``scheduled_at=""`` / ``publish=False`` /
    ``publish=0`` are no-ops, exactly like the TS guard.
    """
    if value is None or value is False:
        return False
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        return value.strip() != ""
    if isinstance(value, (list, tuple, dict, set)):
        return len(value) > 0
    return True


def _walk_items(args: Any) -> Iterable[Tuple[str, Any]]:
    """Yield (key, value) pairs from a dict and its nested dicts/lists.

    Bounded by _MAX_DEPTH / _MAX_NODES. Only dict keys are yielded (that is where
    intent lives); list items are descended into so a nested media/post object is
    still inspected.
    """
    if not isinstance(args, dict):
        return
    stack: List[Tuple[Any, int]] = [(args, 0)]
    seen = 0
    while stack:
        node, depth = stack.pop()
        seen += 1
        if seen > _MAX_NODES or depth > _MAX_DEPTH:
            continue
        if isinstance(node, dict):
            for k, v in node.items():
                yield (k if isinstance(k, str) else str(k)), v
                if isinstance(v, (dict, list, tuple)) and depth < _MAX_DEPTH:
                    stack.append((v, depth + 1))
        elif isinstance(node, (list, tuple)):
            for item in node:
                if isinstance(item, (dict, list, tuple)) and depth < _MAX_DEPTH:
                    stack.append((item, depth + 1))


def _name_denied(tool_name: str) -> Optional[str]:
    """Return a reason if the tool NAME itself is a publish/schedule/mutate action."""
    nn = _norm(tool_name)
    if not nn:
        return None
    for sub in _DENY_NAME_SUBSTRINGS:
        if sub in nn:
            return f"tool name '{tool_name}' is a publish/schedule/post-mutation action ('{sub}')"
    return None


def _args_denied(tool_name: str, args: Any) -> Optional[str]:
    """Return a reason if any argument carries publish / schedule / live-state intent."""
    is_posting_tool = any(m in _norm(tool_name) for m in _POSTING_TOOL_MARKERS)
    for key, value in _walk_items(args):
        nk = _norm(key)
        if not nk:
            continue
        if nk in _SCHEDULE_KEYS and _is_present(value):
            return f"argument '{key}' schedules a post (DRAFT-ONLY forbids scheduling)"
        if nk in _PUBLISH_FLAG_KEYS and _is_present(value):
            return f"argument '{key}'={value!r} publishes / goes live (DRAFT-ONLY forbids publishing)"
        if nk in _STATE_KEYS and isinstance(value, str) and value.strip():
            nv = _norm(value)
            if nv in _LIVE_STATE_VALUES:
                return f"argument '{key}'='{value}' is a live/scheduled post state (only 'draft' allowed)"
            if is_posting_tool and nv and nv != ALLOWED_STATE_VALUE:
                return (
                    f"argument '{key}'='{value}' is a non-draft post state on a posting tool "
                    f"(only 'draft' allowed)"
                )
    return None


def refusal_reason(tool_name: str, args: Any) -> Optional[str]:
    """The pure decision: return a human-readable reason to REFUSE, or None to allow.

    Refuses when the tool name is a publish/schedule/post-mutation action, or when
    any (possibly nested) argument carries scheduling, publishing, or a live/
    non-draft post-state. Robust to garbage inputs (non-str name, non-dict args)
    by construction; the ``pre_tool_call`` wrapper adds the fail-closed backstop.
    """
    name = tool_name if isinstance(tool_name, str) else str(tool_name or "")
    reason = _name_denied(name)
    if reason:
        return reason
    return _args_denied(name, args)


def build_block(tool_name: str, reason: str) -> Dict[str, str]:
    """Build the framework's ``pre_tool_call`` block directive (message is required)."""
    return {
        "action": "block",
        "message": (
            f"REFUSED by the SFFS draft-only guard: {reason}. "
            f"The SFFS agent is DRAFT-ONLY — publishing or scheduling a live post is a "
            f"HUMAN action, never the agent's. To draft a post, use the sanctioned "
            f"draft-only path (it can only ever create drafts)."
        ),
    }


def pre_tool_call(tool_name: str = "", args: Any = None, **_kwargs: Any) -> Optional[Dict[str, str]]:
    """Nous ``pre_tool_call`` hook — defense-in-depth DRAFT-ONLY belt across ALL tools.

    Returns a ``{"action": "block", "message": ...}`` directive to hard-refuse any
    publish/schedule/post-mutation call; returns ``None`` to let a call proceed.
    Never raises (a raising hook is caught+skipped by the framework, which would
    silently drop the belt — so we swallow everything and fail-closed on the
    posting surface).
    """
    try:
        reason = refusal_reason(tool_name or "", args if isinstance(args, dict) else {})
        if reason:
            return build_block(tool_name or "<unknown>", reason)
    except Exception:
        # A crash here must not disable the belt on the sanctioned posting path.
        nn = _norm(tool_name)
        if any(m in nn for m in _POSTING_TOOL_MARKERS):
            return build_block(
                tool_name or "<unknown>",
                "the draft-only guard errored while inspecting a posting tool (failing closed)",
            )
    return None
