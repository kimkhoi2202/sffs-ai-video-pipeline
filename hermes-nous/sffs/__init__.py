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

from . import design, donottouch, draft_guard, gates, publish_guard, questions, reads, schemas


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

    # --- READ-ONLY data tools the cycle reasons about A/B performance with. ---
    ctx.register_tool(
        name="sffs_publer_read",
        toolset="sffs",
        schema=schemas.SFFS_PUBLER_READ_SCHEMA,
        handler=reads.sffs_publer_read,
        emoji="📖",
        description="List Publer accounts or posts (read-only; can never write/schedule/publish).",
    )
    ctx.register_tool(
        name="sffs_score",
        toolset="sffs",
        schema=schemas.SFFS_SCORE_SCHEMA,
        handler=reads.sffs_score,
        emoji="📊",
        description="Read per-post analytics (the A/B scoring input; read-only).",
    )

    # --- DESIGN the day's A/B batch (or introspect the dimension catalog). ---
    # DESIGN/READ-only: selects fresh questions + writes gated captions; it can
    # never create/publish/schedule/mutate a post.
    ctx.register_tool(
        name="sffs_design",
        toolset="sffs",
        schema=schemas.SFFS_DESIGN_SCHEMA,
        handler=design.sffs_design,
        emoji="🎬",
        description="Design the A/B batch or list the A/B dimension catalog (design-only).",
    )

    # --- HARD QUALITY GATES (fail-closed): dedup / validity / copy / render. ---
    # Read/judge-only verdicts; nothing becomes a draft unless it passes. Cannot
    # create/publish/schedule/mutate a post.
    ctx.register_tool(
        name="sffs_gates",
        toolset="sffs",
        schema=schemas.SFFS_GATES_SCHEMA,
        handler=gates.sffs_gates,
        emoji="🚦",
        description="Run a quality gate (dedup/validity/brand-copy/render-sanity; fail-closed).",
    )

    # --- Never-repeat question SELECTION (read-only; cannot mark used or post). ---
    ctx.register_tool(
        name="sffs_questions",
        toolset="sffs",
        schema=schemas.SFFS_QUESTIONS_SCHEMA,
        handler=questions.sffs_questions,
        emoji="❓",
        description="Select fresh never-repeated questions or read bank stats (read-only).",
    )

    # --- Defense-in-depth: refuse ANY publish/schedule/post-mutation tool call. ---
    # A belt across ALL tools (not just ours) at the framework layer. Returns a
    # {"action":"block","message":...} directive to hard-refuse; None to allow.
    ctx.register_hook("pre_tool_call", publish_guard.pre_tool_call)
