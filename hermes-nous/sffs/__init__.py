"""`sffs` plugin — the SFFS DRAFT-ONLY A/B quiz-video agent, on Nous Hermes.

Safety core (belt AND suspenders, in three layers):

  * ``sffs_publer_draft`` — the ONLY sanctioned Publer write path; can ONLY create
    drafts (draft_guard.py Python belt + bridge/publer-draft.ts Node suspenders).
  * ``sffs_donottouch_snapshot`` / ``sffs_donottouch_verify`` — READ-ONLY tools
    that snapshot the existing scheduled+published posts before a cycle and verify
    none were touched afterward (donottouch.py + bridge/donottouch.ts).
  * a ``pre_tool_call`` hook (publish_guard.py) — defense-in-depth across ALL tools
    (ours, future ones, and any Publer MCP tools) that HARD-REFUSES any tool call
    carrying publish / schedule / go-live / post-mutation intent.

No publish or schedule path is imported or exposed anywhere in this plugin. Later
iterations add render / score / design / quality-gate / upload tools, skills,
cron, the cost governor, and the software-factory subagents.
"""

from __future__ import annotations

from . import donottouch, draft_guard, publish_guard, schemas


def register(ctx) -> None:
    """Called once by the Nous plugin loader. Registers the DRAFT-ONLY safety core."""
    # --- The ONLY sanctioned write path: create a Publer DRAFT (never live). ---
    ctx.register_tool(
        name="sffs_publer_draft",
        toolset="sffs",
        schema=schemas.SFFS_PUBLER_DRAFT_SCHEMA,
        handler=draft_guard.sffs_publer_draft,
        emoji="📝",
        description="Create a Publer DRAFT (draft-only; can never publish or schedule).",
    )

    # --- READ-ONLY do-not-touch guards for pre-existing scheduled/published posts. ---
    ctx.register_tool(
        name="sffs_donottouch_snapshot",
        toolset="sffs",
        schema=schemas.SFFS_DONOTTOUCH_SNAPSHOT_SCHEMA,
        handler=donottouch.sffs_donottouch_snapshot,
        emoji="📸",
        description="Snapshot existing scheduled+published post ids (read-only, before a cycle).",
    )
    ctx.register_tool(
        name="sffs_donottouch_verify",
        toolset="sffs",
        schema=schemas.SFFS_DONOTTOUCH_VERIFY_SCHEMA,
        handler=donottouch.sffs_donottouch_verify,
        emoji="✅",
        description="Verify no pre-existing scheduled/published post changed (read-only, after a cycle).",
    )

    # --- Defense-in-depth: refuse ANY publish/schedule/post-mutation tool call. ---
    # A belt across ALL tools (not just ours) at the framework layer. Returns a
    # {"action":"block","message":...} directive to hard-refuse; None to allow.
    ctx.register_hook("pre_tool_call", publish_guard.pre_tool_call)
