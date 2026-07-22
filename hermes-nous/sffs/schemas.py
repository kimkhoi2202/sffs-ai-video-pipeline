"""LLM-facing tool schemas for the `sffs` plugin.

The schema is itself a guardrail: it deliberately exposes NO ``state``, NO
``scheduled_at``, and no publish/schedule parameter. The model has no vocabulary
to even request a non-draft or scheduled post through this tool — reinforcing
that ``sffs_publer_draft`` is physically DRAFT-ONLY.
"""

SFFS_PUBLER_DRAFT_SCHEMA = {
    "name": "sffs_publer_draft",
    "description": (
        "Create a Publer DRAFT for the SFFS quiz-video accounts (Instagram + TikTok). "
        "This is the ONLY sanctioned Publer write path and it can ONLY create drafts — "
        "it can never publish or schedule a live post (going live is a human action). "
        "Use it to attach a rendered short (already uploaded to Publer as media) as a "
        "draft for human review. Set dry_run=true to validate and preview the exact "
        "draft payload without creating anything (no network call)."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "account_ids": {
                "type": "array",
                "items": {"type": "string"},
                "description": (
                    "Publer social account ids to draft for (e.g. the Instagram and "
                    "TikTok account ids for the SFFS brand)."
                ),
            },
            "text": {
                "type": "string",
                "description": "The post caption / text (include hashtags as desired).",
            },
            "media_ids": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Publer media ids to attach (returned by a prior media import).",
            },
            "media_objects": {
                "type": "array",
                "items": {"type": "object"},
                "description": (
                    "Full per-network media objects (e.g. carrying a custom video cover). "
                    "Use INSTEAD of media_ids when a custom cover/thumbnail is required."
                ),
            },
            "type": {
                "type": "string",
                "enum": ["video", "photo", "carousel", "status"],
                "description": "Content type. Defaults to 'video' (these are video shorts).",
            },
            "dry_run": {
                "type": "boolean",
                "description": (
                    "If true, validate and return the draft payload WITHOUT creating "
                    "anything and without any network call."
                ),
            },
        },
        "required": ["account_ids", "text"],
    },
}


# ---------------------------------------------------------------------------
# Do-not-touch (READ-ONLY) — snapshot before a cycle, verify after. These only
# ever LIST scheduled + published posts; they can never write/schedule/publish/
# delete/update anything (see donottouch.py + bridge/donottouch.ts).
# ---------------------------------------------------------------------------

SFFS_DONOTTOUCH_SNAPSHOT_SCHEMA = {
    "name": "sffs_donottouch_snapshot",
    "description": (
        "READ-ONLY safety tool. Capture a snapshot of the ids of every EXISTING "
        "scheduled and published Publer post, to be verified unchanged after a "
        "drafting cycle. Call this BEFORE the agent creates any drafts, then pass "
        "the returned 'snapshot' to sffs_donottouch_verify afterward. This never "
        "writes, schedules, publishes, deletes, or modifies any post. Set "
        "dry_run=true to skip the live read (no network call)."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "dry_run": {
                "type": "boolean",
                "description": "If true, make NO network call (returns a stub).",
            },
        },
        "required": [],
    },
}

SFFS_DONOTTOUCH_VERIFY_SCHEMA = {
    "name": "sffs_donottouch_verify",
    "description": (
        "READ-ONLY safety tool. Verify that no PRE-EXISTING scheduled or published "
        "Publer post was touched during a cycle. Pass the 'snapshot' returned by "
        "sffs_donottouch_snapshot (taken before the cycle); this re-lists the live "
        "posts and reports a violation if any of them vanished or changed state. It "
        "never writes/schedules/publishes/deletes/modifies anything. Set "
        "dry_run=true to validate the snapshot shape without a network call."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "snapshot": {
                "type": "object",
                "description": (
                    "The snapshot object returned by sffs_donottouch_snapshot "
                    "(contains scheduled_ids and published_ids)."
                ),
                "properties": {
                    "scheduled_ids": {"type": "array", "items": {"type": "string"}},
                    "published_ids": {"type": "array", "items": {"type": "string"}},
                    "captured_at": {"type": "string"},
                },
            },
            "dry_run": {
                "type": "boolean",
                "description": "If true, validate the snapshot shape only (no network call).",
            },
        },
        "required": ["snapshot"],
    },
}


# ---------------------------------------------------------------------------
# READ-ONLY data tools (list accounts/posts + read per-post analytics). These
# only ever issue GET requests; they can never write/schedule/publish/delete/
# update anything (see reads.py + bridge/publer-read.ts).
#
# NOTE: the post-state filter is deliberately named ``state_filter`` (not
# ``state``) so the framework publish guard never mistakes a READ filter value
# like "published"/"scheduled" for an attempt to SET a live post state.
# ---------------------------------------------------------------------------

SFFS_PUBLER_READ_SCHEMA = {
    "name": "sffs_publer_read",
    "description": (
        "READ-ONLY. List the connected Publer social accounts, or list posts. Use "
        "what='accounts' to get account ids/providers (Instagram + TikTok), or "
        "what='posts' to list posts filtered by state_filter (draft|scheduled|"
        "published), account_ids, and/or a text query. This only reads (GET); it "
        "can never create, publish, schedule, delete, or modify any post. Set "
        "dry_run=true to preview the request with no network call."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "what": {
                "type": "string",
                "enum": ["accounts", "posts"],
                "description": "What to read: 'accounts' (default) or 'posts'.",
            },
            "state_filter": {
                "type": "string",
                "enum": ["draft", "scheduled", "published"],
                "description": (
                    "For what='posts': only list posts in this state. This is a "
                    "read FILTER, not a state to set."
                ),
            },
            "account_ids": {
                "type": "array",
                "items": {"type": "string"},
                "description": "For what='posts': restrict to these Publer account ids.",
            },
            "query": {
                "type": "string",
                "description": "For what='posts': a free-text search over post captions.",
            },
            "page": {
                "type": "integer",
                "description": "For what='posts': 0-based page (Publer pages are ~10 posts).",
            },
            "all_pages": {
                "type": "boolean",
                "description": (
                    "For what='posts': page through and return ALL posts in the "
                    "state_filter (defaults to 'published' if state_filter is unset)."
                ),
            },
            "max_pages": {
                "type": "integer",
                "description": "For what='posts' with all_pages: cap on pages to fetch.",
            },
            "dry_run": {
                "type": "boolean",
                "description": "If true, preview the request WITHOUT any network call.",
            },
        },
        "required": [],
    },
}

# ---------------------------------------------------------------------------
# DESIGN — plan the day's A/B batch (or introspect the A/B dimension catalog).
# DESIGN/READ-only: no create / schedule / publish / delete / update path is
# reachable (see design.py + bridge/design.ts). No state/schedule/publish
# vocabulary is exposed (schema-as-guardrail).
# ---------------------------------------------------------------------------

SFFS_DESIGN_SCHEMA = {
    "name": "sffs_design",
    "description": (
        "Design the day's A/B quiz-video batch (DESIGN-only; it never posts). Use "
        "what='catalog' (default) to see the A/B dimension space with NO LLM/network "
        "call — every dimension and arm, including the narration family (full / none "
        "/ no-question-vo / no-options-vo) and the progress-counter arms. Use "
        "what='plan' to actually build a batch: it picks FRESH, never-repeated "
        "questions for each dimension and writes on-brand, gated captions (this calls "
        "the LLM for captions), returning one plan per video (its dimension, arm, "
        "questions, caption, and render props incl. the narration arm). It can never "
        "create, publish, schedule, or modify a post. Set dry_run=true to preview the "
        "request with no LLM/network call."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "what": {
                "type": "string",
                "enum": ["catalog", "plan"],
                "description": (
                    "'catalog' (default): list the A/B dimensions/arms (no LLM/network). "
                    "'plan': build the batch (selects questions + generates captions)."
                ),
            },
            "run_id": {
                "type": "string",
                "description": (
                    "For what='plan': the run id — a deterministic seed AND the per-video "
                    "id prefix (e.g. a date like '2026-07-22'). Defaults to today's UTC date."
                ),
            },
            "target": {
                "type": "integer",
                "description": (
                    "For what='plan': how many videos to design (each a different A/B "
                    "dimension). Defaults to 10; max 50. Fewer are returned if the bank "
                    "lacks enough fresh questions (quality > volume)."
                ),
            },
            "dry_run": {
                "type": "boolean",
                "description": "If true, preview the request WITHOUT any LLM/network call.",
            },
        },
        "required": [],
    },
}


SFFS_SCORE_SCHEMA = {
    "name": "sffs_score",
    "description": (
        "READ-ONLY analytics reader — the A/B scoring input. Pull per-post metrics "
        "(reach, views, likes, comments, shares, saves, engagement, engagement_rate) "
        "from Publer post_insights for the SFFS accounts over a date window "
        "(defaults to the last 30 days). Returns flattened per-post insights plus a "
        "per-account count. Publer analytics lag ~24h, so recent posts may have no "
        "metrics yet. This only reads (GET); it never writes, schedules, publishes, "
        "or modifies anything, and it does not itself mutate local A/B files. Set "
        "dry_run=true to preview the request with no network call."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "from": {
                "type": "string",
                "description": "Window start, YYYY-MM-DD (defaults to 30 days ago).",
            },
            "to": {
                "type": "string",
                "description": "Window end, YYYY-MM-DD (defaults to today, UTC).",
            },
            "account_ids": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Publer account ids to pull (defaults to the SFFS IG + TikTok accounts).",
            },
            "sort_by": {
                "type": "string",
                "description": "Metric to sort by (e.g. reach, engagement, engagement_rate, likes). Default reach.",
            },
            "sort_type": {
                "type": "string",
                "enum": ["ASC", "DESC"],
                "description": "Sort direction. Default DESC.",
            },
            "max_pages": {
                "type": "integer",
                "description": "Cap on analytics pages per account (each page = 10 posts). Default 20.",
            },
            "dry_run": {
                "type": "boolean",
                "description": "If true, preview the request WITHOUT any network call.",
            },
        },
        "required": [],
    },
}
