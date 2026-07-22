"""`sffs` plugin — the SFFS DRAFT-ONLY A/B quiz-video agent, on Nous Hermes.

Iteration 2 scope: the SAFETY CORE only. This registers exactly ONE tool,
``sffs_publer_draft``, which can ONLY create Publer drafts:

  * belt      — hermes-nous/sffs/draft_guard.py refuses any non-draft state or
                any scheduling/publish field at the Python tool layer;
  * suspenders — a valid request is handed to the pipeline's ``createDraftOnly``
                path via hermes-nous/bridge/publer-draft.ts, which re-validates
                and never imports schedule/publish/delete/update.

No publish or schedule path is imported or exposed anywhere in this plugin. Later
iterations add render / score / design / quality-gate / upload / do-not-touch
tools, skills, cron, the cost governor, and the software-factory subagents.
"""

from __future__ import annotations

from . import draft_guard, schemas


def register(ctx) -> None:
    """Called once by the Nous plugin loader. Registers the DRAFT-ONLY tool."""
    ctx.register_tool(
        name="sffs_publer_draft",
        toolset="sffs",
        schema=schemas.SFFS_PUBLER_DRAFT_SCHEMA,
        handler=draft_guard.sffs_publer_draft,
        emoji="📝",
        description="Create a Publer DRAFT (draft-only; can never publish or schedule).",
    )
