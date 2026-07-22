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
