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


# ---------------------------------------------------------------------------
# QUALITY GATES — the fail-closed checks nothing becomes a draft without.
# READ/JUDGE-only: no create / schedule / publish / delete / update path is
# reachable (see gates.py + bridge/gates.ts). No state/schedule/publish
# vocabulary is exposed (schema-as-guardrail).
# ---------------------------------------------------------------------------

SFFS_GATES_SCHEMA = {
    "name": "sffs_gates",
    "description": (
        "Run a HARD QUALITY GATE (fail-closed; nothing should become a draft unless "
        "it passes). Pick one with 'what': 'dedup' = never-repeat check (refuse any "
        "question already used, claimed in this batch, or duplicated internally; "
        "deterministic, no LLM); 'validity' = LLM rubric per question (exactly one "
        "unambiguous correct answer, factual, grade-appropriate, plausible "
        "distractors; fails closed if unsure); 'copy' = brand-voice + kid-safe check "
        "on caption/on-screen text (deterministic hard rules first, then an LLM "
        "judge); 'render' = render sanity via ffprobe (1080x1920, video+audio, "
        "duration ~ expected). Returns a {pass, reason, detail} verdict; treat "
        "pass=false as 'do not draft'. This never posts. Set dry_run=true to preview "
        "the request with no LLM/network call."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "what": {
                "type": "string",
                "enum": ["dedup", "validity", "copy", "render"],
                "description": "Which gate to run.",
            },
            "questions": {
                "type": "array",
                "items": {"type": "object"},
                "description": (
                    "For 'dedup' / 'validity': the question objects to check (each with "
                    "at least a 'sig'; 'validity' also needs a 'hash'). Use the objects "
                    "returned by sffs_design / sffs_questions."
                ),
            },
            "claimed": {
                "type": "array",
                "items": {"type": "string"},
                "description": "For 'dedup': question sigs already claimed earlier in THIS batch.",
            },
            "pieces": {
                "type": "array",
                "items": {"type": "object"},
                "description": (
                    "For 'copy': the text pieces to judge, each {label, text} (e.g. "
                    "{label:'caption', text:'...'})."
                ),
            },
            "path": {
                "type": "string",
                "description": "For 'render': the rendered mp4 path to probe.",
            },
            "expected_frames": {
                "type": "integer",
                "description": "For 'render': expected frame count (from the render step) to check duration against.",
            },
            "fps": {
                "type": "integer",
                "description": "For 'render': frames per second (default 30).",
            },
            "dry_run": {
                "type": "boolean",
                "description": "If true, preview the request WITHOUT any LLM/network call.",
            },
        },
        "required": ["what"],
    },
}


# ---------------------------------------------------------------------------
# QUESTIONS — never-repeat question SELECTION (read-only). Selects fresh,
# never-before-used questions from the bank; it can NEVER mark questions used
# (no markUsed import) or touch any post (see questions.py + bridge/questions.ts).
# No state/schedule/publish vocabulary is exposed (schema-as-guardrail).
# ---------------------------------------------------------------------------

SFFS_QUESTIONS_SCHEMA = {
    "name": "sffs_questions",
    "description": (
        "READ-ONLY question selection with a strong never-repeat guarantee. Use "
        "what='candidates' (default) to get FRESH, never-before-used questions in a "
        "stable seeded order — every returned question is excluded from both dedup "
        "ledgers (so it has never been used across the campaign) and from any "
        "'exclude' sigs you already claimed in this batch. Only the two "
        "headless-renderable kinds are returned (text = verbal odd-one-out/analogy, "
        "numseries = number series). Use what='stats' for bank freshness counts "
        "(total / usable / fresh / used). This only reads the local bank + ledgers; "
        "it never marks questions used, and never touches any post. Set dry_run=true "
        "to preview the request."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "what": {
                "type": "string",
                "enum": ["candidates", "stats"],
                "description": "'candidates' (default): fresh questions. 'stats': bank freshness counts.",
            },
            "category": {
                "type": "string",
                "enum": ["verbal", "quantitative", "nonverbal", "mixed"],
                "description": (
                    "For 'candidates': restrict to a category ('mixed' or omitted = no "
                    "filter). Note only text/numseries render, so 'nonverbal' yields ~0."
                ),
            },
            "kinds": {
                "type": "array",
                "items": {"type": "string", "enum": ["text", "numseries"]},
                "description": "For 'candidates': restrict to these question kinds (default both).",
            },
            "seed": {
                "type": "string",
                "description": "For 'candidates': a seed for the deterministic ordering (e.g. run+dimension).",
            },
            "exclude": {
                "type": "array",
                "items": {"type": "string"},
                "description": "For 'candidates': question sigs already claimed earlier in THIS batch, to skip.",
            },
            "limit": {
                "type": "integer",
                "description": "For 'candidates': max questions to return (default 20; max 200).",
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
# RENDER — turn a video plan's props into an mp4 (DRAFT media). Wraps render.ts
# renderVideo (+ narration.ts cloned-voice VO). It produces a LOCAL file only; no
# create / schedule / publish / delete / update path is reachable (see render.py +
# bridge/render.ts). No state/schedule/publish vocabulary is exposed (the
# narration ARM lives under the non-state key `mode`; schema-as-guardrail).
# ---------------------------------------------------------------------------

SFFS_RENDER_SCHEMA = {
    "name": "sffs_render",
    "description": (
        "Render a quiz short (the self-contained HermesQuiz composition, 1080x1920, "
        "30fps) to an mp4. Pass the render 'props' from an sffs_design plan (or an "
        "equivalent object) and an optional 'id' (the output filename stem). If "
        "props.narration.mode is 'full' / 'no-question-vo' / 'no-options-vo', the "
        "cloned-voice voiceover for that A/B arm is synthesized and muxed (needs "
        "ELEVENLABS_API_KEY); 'none' (default) is music-only (no key needed). "
        "Idempotent: an existing non-trivial render is reused unless force=true. "
        "Returns {path, frames, reused, bytes}. This produces a LOCAL mp4 (DRAFT "
        "media) only — it never uploads, posts, publishes, or schedules anything "
        "(use sffs_upload_s3 then sffs_publer_draft next). Set dry_run=true to "
        "validate the request without rendering (no network/Chromium/ffmpeg)."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "id": {
                "type": "string",
                "description": (
                    "Output filename stem (filesystem-safe: letters/digits/._-). "
                    "Defaults to a UTC timestamp. Use the plan's video id (e.g. "
                    "'2026-07-22-v01')."
                ),
            },
            "props": {
                "type": "object",
                "description": (
                    "The HermesQuiz render props (as produced by sffs_design plan): "
                    "title/subtitle/outro/music, showProgress/progressStyle, reveal, "
                    "countdownSec, the narration arm, and the questions."
                ),
                "properties": {
                    "title": {"type": "string"},
                    "subtitle": {"type": "string"},
                    "outro": {"type": "string"},
                    "music": {
                        "type": "string",
                        "description": "staticFile path to a music bed (e.g. 'audio/music/gameshow-fanfare.mp3').",
                    },
                    "showProgress": {"type": "boolean"},
                    "progressStyle": {"type": "string", "enum": ["short", "full"]},
                    "reveal": {
                        "type": "string",
                        "enum": ["all", "none", "last"],
                        "description": "Answer-reveal mode: all / none (comment-for-answer) / last (cliffhanger).",
                    },
                    "countdownSec": {"type": "number", "description": "Per-question countdown seconds (tempo)."},
                    "narration": {
                        "type": "object",
                        "description": "The cloned-voice A/B arm.",
                        "properties": {
                            "mode": {
                                "type": "string",
                                "enum": ["full", "none", "no-question-vo", "no-options-vo"],
                                "description": "Voiceover arm; 'none' = music-only (default).",
                            },
                            "clips": {
                                "type": "array",
                                "items": {"type": "object"},
                                "description": "Usually empty; the VO clips are synthesized at render time.",
                            },
                        },
                    },
                    "questions": {
                        "type": "array",
                        "items": {"type": "object"},
                        "description": (
                            "The questions to render, each {kind:'text'|'numseries', tier, "
                            "prompt, answer, options?(text), seq?(numseries)}."
                        ),
                    },
                },
                "required": ["questions"],
            },
            "force": {
                "type": "boolean",
                "description": "If true, re-render (and re-synthesize VO) even if a prior render exists.",
            },
            "data_dir": {
                "type": "string",
                "description": "Override where the mp4 lands (CONFIG.RENDERS_DIR = <data_dir>/renders).",
            },
            "dry_run": {
                "type": "boolean",
                "description": "If true, validate the request WITHOUT rendering (no network/Chromium/ffmpeg).",
            },
        },
        "required": ["props"],
    },
}


# ---------------------------------------------------------------------------
# UPLOAD (S3) — host a rendered mp4, return a presigned fetchable URL. Wraps
# tools/upload-media.ts uploadFile (media hosting only). No Publer/post path is
# imported or reachable (see upload_s3.py + bridge/upload-s3.ts). No state/
# schedule/publish vocabulary is exposed (schema-as-guardrail).
# ---------------------------------------------------------------------------

SFFS_UPLOAD_S3_SCHEMA = {
    "name": "sffs_upload_s3",
    "description": (
        "Upload a rendered mp4 (from sffs_render) to object storage (MEDIA_HOST=s3: "
        "a PRIVATE bucket) and return a PRESIGNED GET URL that Publer can fetch "
        "during a later DRAFT import. Credentials come from AWS env vars or the EC2 "
        "instance role (IMDSv2); S3_BUCKET defaults to hermes-sffs-media. This only "
        "HOSTS media — it never creates, publishes, schedules, or mutates any post "
        "(attach the returned URL to a draft with sffs_publer_draft next). Set "
        "dry_run=true to validate + preview the destination key with no upload and "
        "no credentials."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "local_path": {
                "type": "string",
                "description": "Absolute path to the local mp4 to upload (e.g. the sffs_render 'path').",
            },
            "dest_key": {
                "type": "string",
                "description": (
                    "Optional destination object key (defaults to the file's basename; "
                    "MEDIA_DEST_PREFIX is prepended if set). No '..' path segments."
                ),
            },
            "dry_run": {
                "type": "boolean",
                "description": "If true, validate + preview the destination WITHOUT uploading (no network/creds).",
            },
        },
        "required": ["local_path"],
    },
}
