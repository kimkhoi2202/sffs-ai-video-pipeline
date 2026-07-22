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
