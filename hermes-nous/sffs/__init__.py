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
iterations add score-rollup, skills, cron, the cost governor, and the
software-factory subagents (render / design / quality-gate / read / upload tools
are in place).
"""

from __future__ import annotations

from . import (
    cost_governor,
    cycle,
    design,
    donottouch,
    draft_guard,
    factory,
    gates,
    promote,
    publish_guard,
    questions,
    reads,
    render,
    schemas,
    score_rollup,
    upload_s3,
)


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

    # --- RENDER a quiz short to an mp4 (DRAFT media; produces a local file only). ---
    # Wraps render.ts renderVideo (+ narration.ts cloned-voice VO arms); it can never
    # create/publish/schedule/mutate a post. Uploading + drafting are separate steps.
    ctx.register_tool(
        name="sffs_render",
        toolset="sffs",
        schema=schemas.SFFS_RENDER_SCHEMA,
        handler=render.sffs_render,
        emoji="🎥",
        description="Render a quiz short (HermesQuiz 1080x1920) to an mp4, with optional cloned-voice narration.",
    )

    # --- UPLOAD a rendered mp4 to S3 (private bucket + presigned GET URL). ---
    # Wraps tools/upload-media.ts uploadFile (media hosting only); no Publer/post
    # path is imported or reachable. Returns a fetchable URL for a later DRAFT.
    ctx.register_tool(
        name="sffs_upload_s3",
        toolset="sffs",
        schema=schemas.SFFS_UPLOAD_S3_SCHEMA,
        handler=upload_s3.sffs_upload_s3,
        emoji="☁️",
        description="Upload a rendered mp4 to S3 and return a presigned fetchable URL (media hosting; never posts).",
    )

    # --- SCORE ROLLUP: refresh the durable A/B memory (write-side of scoring). ---
    # Wraps score.ts pullAndScore (pull analytics -> refresh ab-database.json +
    # recompute learnings.json). Read-only on Publer (GET); writes only local JSON.
    # Deliberately separate from the read-only sffs_score. Cannot post/publish/schedule.
    ctx.register_tool(
        name="sffs_score_rollup",
        toolset="sffs",
        schema=schemas.SFFS_SCORE_ROLLUP_SCHEMA,
        handler=score_rollup.sffs_score_rollup,
        emoji="🧮",
        description="Refresh A/B metrics + recompute learnings.json rollups (the durable cross-run memory; write-side of scoring).",
    )

    # --- CYCLE: run ONE full DRAFT-ONLY A/B cycle end to end (ties the tools). ---
    # Wraps cycle.ts runCycle: snapshot -> score -> design -> per-video gates ->
    # render -> (live) upload -> createDraftOnly -> verify. It can ONLY create
    # DRAFTS and can NEVER push to main (HERMES_SKIP_GIT is forced by the bridge
    # AND the handler env). No publish/schedule path is reachable.
    ctx.register_tool(
        name="sffs_cycle",
        toolset="sffs",
        schema=schemas.SFFS_CYCLE_SCHEMA,
        handler=cycle.sffs_cycle,
        emoji="🔁",
        description="Run one full DRAFT-ONLY A/B cycle end to end (design->gates->render->upload->Publer DRAFTS; never publishes/schedules; never pushes to main).",
    )

    # --- DEFAULT-PROMOTION (read-side): detect/list proposals to flip a CONTENT default. ---
    # The CONTENT analog of the software factory's gate, but HUMAN-gated: this tool
    # only ever DETECTS/LISTS/SHOWS proposals where an A/B test arm beat the current
    # default. It can NEVER approve/apply one — flipping a default is a human CLI
    # action (scripts/sffs_promote_default --approve <id>). It reads learnings.json +
    # content-defaults.json and writes only the proposals queue; it never posts.
    ctx.register_tool(
        name="sffs_promote",
        toolset="sffs",
        schema=schemas.SFFS_PROMOTE_SCHEMA,
        handler=promote.sffs_promote,
        emoji="🗳️",
        description="Detect/list CONTENT default-promotion proposals (read-only; approving a default flip is a human CLI action, never this tool).",
    )

    # --- SOFTWARE FACTORY: autonomous CODE self-improvement on the two-key gate. ---
    # Proposes code changes (delegate_task fan-out) and auto-merges each ONLY on
    # GREEN harness AND review-agent APPROVE (consumes scripts/gate/*, never
    # reimplements it), honoring the cost governor + kill-switch, scoped to the
    # build branch (never main), with rollback. DRY-RUN by default; a real run
    # needs execute=true AND dry_run=false. It changes CODE only — never posts.
    ctx.register_tool(
        name="sffs_factory",
        toolset="sffs",
        schema=schemas.SFFS_FACTORY_SCHEMA,
        handler=factory.sffs_factory,
        emoji="🏭",
        description="Run the software factory: propose code changes + auto-merge ONLY on the two-key gate (harness GREEN AND review-agent APPROVE); cost-governed + kill-switched; dry-run by default; never posts.",
    )

    # --- Defense-in-depth: refuse ANY publish/schedule/post-mutation tool call. ---
    # A belt across ALL tools (not just ours) at the framework layer. Returns a
    # {"action":"block","message":...} directive to hard-refuse; None to allow.
    # MUST be registered FIRST among pre_tool_call hooks: the DRAFT-ONLY belt is
    # the priority guard and the one sffs_selfcheck exercises (it grabs the first
    # pre_tool_call callback).
    ctx.register_hook("pre_tool_call", publish_guard.pre_tool_call)

    # --- COST GOVERNOR + kill-switch: the AGGRESSIVE-BUT-BOUNDED spend brake. ---
    # A SEPARATE concern from the DRAFT-ONLY belt above: this halts SPEND (the
    # factory + the loop + subagent fan-out) when the kill-switch is engaged or a
    # HIGH-but-finite daily $/token/spawn or concurrent-child ceiling is hit — it
    # NEVER affects posting autonomy (still frozen at draft-only). Registered
    # AFTER publish_guard so the DRAFT-ONLY hook stays first.
    #   * pre_tool_call  — HARD-STOP: block delegate_task/sffs_factory (factory),
    #                      sffs_cycle (loop), and heavy render/rollup on kill or
    #                      over-ceiling (cheap read/draft tools stay usable).
    #   * pre_llm_call   — advisory nudge to wind down (pre_llm_call can't block).
    #   * post_llm_call  — record an estimated $/token usage event (append-only).
    #   * subagent_start/stop — track concurrent children + the daily spawn tally.
    ctx.register_hook("pre_tool_call", cost_governor.pre_tool_call)
    ctx.register_hook("pre_llm_call", cost_governor.pre_llm_call)
    ctx.register_hook("post_llm_call", cost_governor.post_llm_call)
    ctx.register_hook("subagent_start", cost_governor.subagent_start)
    ctx.register_hook("subagent_stop", cost_governor.subagent_stop)
