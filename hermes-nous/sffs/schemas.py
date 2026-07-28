"""LLM-facing tool schemas for the `sffs` plugin.

The schema is itself a guardrail: it deliberately exposes NO ``state``, NO
``scheduled_at``, and no publish/schedule parameter. The model has no vocabulary
to even request a non-draft or scheduled post through this tool — reinforcing
that the loop's publish path is physically DRAFT-ONLY.
"""

SFFS_DONOTTOUCH_SNAPSHOT_SCHEMA = {
    "name": "sffs_donottouch_snapshot",
    "description": (
        "READ-ONLY safety tool. Capture a snapshot of the ids of every EXISTING "
        "scheduled and published post, to be verified unchanged after a "
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
        "post was touched during a cycle. Pass the 'snapshot' returned by "
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
# update anything (see reads.py + bridge/metricool-read.ts).
#
# NOTE: the post-state filter is deliberately named ``state_filter`` (not
# ``state``) so the framework publish guard never mistakes a READ filter value
# like "published"/"scheduled" for an attempt to SET a live post state.
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
        "from Metricool analytics for the SFFS accounts over a date window "
        "(defaults to the last 30 days). Returns flattened per-post insights plus a "
        "per-account count. Analytics lag ~24h, so recent posts may have no "
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
                "description": "Account ids to pull (defaults to the SFFS IG + TikTok accounts).",
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
        "(use sffs_upload_s3, then the loop's draft path). Set dry_run=true to "
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
        "a PRIVATE bucket) and return a PRESIGNED GET URL that the scheduler can fetch "
        "during a later DRAFT import. Credentials come from AWS env vars or the EC2 "
        "instance role (IMDSv2); S3_BUCKET defaults to hermes-sffs-media. This only "
        "HOSTS media — it never creates, publishes, schedules, or mutates any post "
        "(attach the returned URL to a draft in the loop's publish phase). Set "
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


# ---------------------------------------------------------------------------
# SCORE-ROLLUP — the WRITE-side of scoring (deliberately separate from the
# read-only sffs_score). Pulls matured analytics + recomputes the durable A/B
# memory (ab-database.json + learnings.json). Wraps score.ts pullAndScore; no
# create/schedule/publish/delete/update path is reachable (see score_rollup.py +
# bridge/score-rollup.ts). No state/schedule/publish vocabulary is exposed.
# ---------------------------------------------------------------------------

SFFS_SCORE_ROLLUP_SCHEMA = {
    "name": "sffs_score_rollup",
    "description": (
        "Refresh the A/B decision memory: pull matured Metricool analytics (~24h lag) "
        "over the last 30 days, join them onto ab-database.json to refresh per-post "
        "metrics, and recompute the rollups + front-runners in learnings.json (the "
        "loop's durable, cross-run A/B memory the designer biases toward). This is "
        "the WRITE-side of scoring — deliberately separate from the read-only "
        "sffs_score (which never writes those files). It only reads Metricool analytics "
        "(GET) and writes two LOCAL JSON files; it never creates, publishes, "
        "schedules, or mutates any post. Run this at the START of a cycle (or nightly "
        "on its own). Set dry_run=true (the default) to preview the window WITHOUT "
        "any network call and WITHOUT writing any file."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "dry_run": {
                "type": "boolean",
                "description": (
                    "If true (default), preview the 30-day window WITHOUT any network "
                    "call and WITHOUT writing ab-database.json/learnings.json. Set "
                    "false to actually pull analytics and recompute the rollups."
                ),
            },
            "data_dir": {
                "type": "string",
                "description": "Override HERMES_DATA_DIR for auxiliary data paths (optional).",
            },
        },
        "required": [],
    },
}


# ---------------------------------------------------------------------------
# RECONCILE — close the A/B LEARNING LOOP for the agent's OWN posts by matching
# each ab-database record's metricool_uuid to the native published post and
# back-filling platform_post_id / permalink / posted_at (the join keys scoring
# needs). Read Metricool (GET only) + write ONE local JSON file; idempotent;
# no state/schedule/publish vocabulary is exposed (schema-as-guardrail).
# ---------------------------------------------------------------------------

SFFS_RECONCILE_SCHEMA = {
    "name": "sffs_reconcile",
    "description": (
        "Close the A/B learning loop for the agent's OWN posts: for each "
        "ab-database.json record, match its metricool_uuid (Metricool's stable planner id, "
        "recorded when the loop created the DRAFT) to the native published post and "
        "back-fill platform_post_id (the network-native TikTok video id / Instagram "
        "media id), permalink, and posted_at. Those native ids are the join keys "
        "sffs_score / sffs_score_rollup attach matured analytics on, so without this "
        "back-fill the agent can never learn from a post a human published from one of "
        "its drafts. It only reads Metricool (analytics + planner GETs) and writes "
        "ONE local JSON file (ab-database.json), only when a field actually changed; it "
        "never creates, publishes, schedules, or mutates any post. IDEMPOTENT (a field "
        "is filled only when currently empty). Run it after scoring in a cycle (or on "
        "its own). Set dry_run=true (the default) to preview WITHOUT any network call "
        "and WITHOUT writing any file."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "dry_run": {
                "type": "boolean",
                "description": (
                    "If true (default), preview WITHOUT any network call and WITHOUT "
                    "writing ab-database.json. Set false to actually read Metricool and "
                    "back-fill the native post ids/permalinks/posted_at."
                ),
            },
            "data_dir": {
                "type": "string",
                "description": "Override HERMES_DATA_DIR for auxiliary data paths (optional).",
            },
        },
        "required": [],
    },
}


# ---------------------------------------------------------------------------
# CYCLE — run ONE full DRAFT-ONLY A/B cycle end to end (ties all the tools
# together by wrapping cycle.ts runCycle). It can ONLY ever create DRAFTS
# (Metricool draft:true/autoPublish:false), and it can NEVER push to main (HERMES_SKIP_GIT is forced).
# No state/schedule/publish vocabulary is exposed (schema-as-guardrail).
# ---------------------------------------------------------------------------

SFFS_CYCLE_SCHEMA = {
    "name": "sffs_cycle",
    "description": (
        "Run ONE full DRAFT-ONLY A/B quiz-video cycle end to end. In order: snapshot "
        "do-not-touch (read-only) -> refresh scoring (ab-database.json + "
        "learnings.json) -> design the A/B batch (rotating dimensions incl. the "
        "narration family and progress-counter arms) -> per video [dedup -> validity "
        "-> mark-used -> brand copy -> render -> render-sanity -> S3 upload -> create "
        "a Metricool DRAFT] -> verify do-not-touch (read-only). It can ONLY create "
        "DRAFTS (never publishes or schedules a live post) and it can NEVER push to "
        "main. Set preview=true to see the resolved run config WITHOUT running "
        "anything (no network/render). Set dry_run=true (default) to run the pipeline "
        "in DRY mode (design + gates + render, but NO S3 upload / NO draft / "
        "NO git push); dry_run=false runs a REAL draft-only cycle (also uploads to S3 "
        "and creates Metricool DRAFTS). Use 'target' to bound how many videos to make."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "dry_run": {
                "type": "boolean",
                "description": (
                    "If true (default), the cycle runs in DRY mode: it designs, gates, "
                    "and renders, but creates NO drafts, uploads nothing, and pushes "
                    "nothing. If false, a REAL draft-only cycle (renders + S3 uploads + "
                    "creates Metricool DRAFTS). Never publishes/schedules; never pushes to main."
                ),
            },
            "preview": {
                "type": "boolean",
                "description": (
                    "If true, do NOT run the cycle — just validate and return the "
                    "resolved run config (target, dry_run, skip_git). No network/render."
                ),
            },
            "target": {
                "type": "integer",
                "description": (
                    "How many videos to make (each a different A/B dimension). 1..50; "
                    "defaults to the configured VIDEOS_PER_DAY (10). Fewer are produced "
                    "if the bank lacks fresh questions (quality > volume)."
                ),
            },
            "run_id": {
                "type": "string",
                "description": (
                    "Resumable run id (also the per-video id prefix), e.g. a date like "
                    "'2026-07-22'. Re-running the same id resumes (completed steps are "
                    "skipped). Defaults to today's UTC date."
                ),
            },
            "data_dir": {
                "type": "string",
                "description": "Override where renders/runs land (HERMES_DATA_DIR; defaults outside the repo).",
            },
        },
        "required": [],
    },
}


# ---------------------------------------------------------------------------
# FACTORY — the software-factory self-improvement engine. Proposes CODE changes
# (delegate_task fan-out) and auto-merges each ONLY on the TWO-KEY gate (harness
# GREEN AND review-agent APPROVE), honoring the cost governor + kill-switch,
# scoped to the build branch (never main). DRY-RUN by default. This tool changes
# CODE only — it exposes NO state/schedule/publish vocabulary (schema-as-guardrail)
# and can never post/publish/schedule.
# ---------------------------------------------------------------------------

SFFS_FACTORY_SCHEMA = {
    "name": "sffs_factory",
    "description": (
        "Run the SFFS software factory: the autonomous CODE self-improvement engine. "
        "It proposes code-change workstreams (fanned out to delegate_task subagents) "
        "and auto-merges each proposed branch ONLY when the two-key gate turns BOTH "
        "keys — the E2E harness is GREEN AND an independent review-agent APPROVES "
        "(fail-closed). It honors the cost governor + kill-switch, never targets a "
        "protected branch (main/master/prod), scopes out prod infra/secrets, and "
        "keeps a rollback path. DRY-RUN by DEFAULT: it plans workstreams and runs the "
        "gate WITHOUT spawning subagents or merging. A real run requires BOTH "
        "execute=true AND dry_run=false. It changes CODE only — it can never publish, "
        "schedule, or post. Pass a prepared branch as 'source' to gate it, and/or "
        "'goals' to plan the fan-out."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "dry_run": {
                "type": "boolean",
                "description": (
                    "If true (default), NO subagent is spawned and NO merge happens; the "
                    "two-key gate runs in dry-run on any prepared branch so the decision "
                    "is computed and proven safely."
                ),
            },
            "goals": {
                "type": "array",
                "items": {"type": "string"},
                "description": (
                    "High-level code-improvement goals to fan out to delegate_task "
                    "subagents (each becomes a bounded workstream on its own branch)."
                ),
            },
            "source": {
                "type": "string",
                "description": (
                    "An already-prepared branch to run the two-key gate on (its diff vs "
                    "target is what the harness + review-agent judge)."
                ),
            },
            "target": {
                "type": "string",
                "description": (
                    "Branch to merge INTO (default 'hermes-nous'). NEVER a protected "
                    "branch (main/master/prod) — that is refused."
                ),
            },
            "execute": {
                "type": "boolean",
                "description": (
                    "If true AND dry_run=false, actually spawn the fan-out and perform "
                    "the merge (only on GREEN+APPROVE). Default false. Both flags are "
                    "required for a real run."
                ),
            },
            "offline_review": {
                "type": "boolean",
                "description": (
                    "If true (default for a cheap dry-run proof), the review-agent runs "
                    "its deterministic static-safety floor only (no model tokens). Set "
                    "false to require the full fresh review-agent sign-off."
                ),
            },
            "max_workstreams": {
                "type": "integer",
                "description": "Cap on how many workstreams to plan/fan out (default 8, aggressive-but-bounded).",
            },
        },
        "required": [],
    },
}


# ---------------------------------------------------------------------------
# PROMOTE — the CONTENT default-promotion read-side. This tool DETECTS/LISTS/SHOWS
# proposals where an A/B test arm beat the current default; it can NEVER approve or
# apply one. Flipping a default is a HUMAN action via the sffs_promote_default CLI.
# The schema is itself a guardrail: it exposes NO approve/reject/apply vocabulary,
# so the autonomous agent has no way to change a default through this tool.
# ---------------------------------------------------------------------------

SFFS_PROMOTE_SCHEMA = {
    "name": "sffs_promote",
    "description": (
        "Read the CONTENT default-promotion queue (the analog of the code factory's "
        "gate, but for content defaults — and HUMAN-gated, never auto-applied). It "
        "detects when an A/B TEST ARM clearly beats the current default (control) on "
        "the configured metric with enough samples, and records a PROPOSAL to flip "
        "that default. This tool is READ/DETECT ONLY: 'list' pending proposals, "
        "'detect'/'refresh' to re-scan learnings.json and persist fresh proposals, "
        "'show' one proposal by id, or 'status' for the current defaults + policy + "
        "counts. It can NEVER approve, reject, or apply a proposal — flipping a "
        "default is an explicit HUMAN action via `sffs_promote_default --approve <id>` "
        "in a shell. It never posts, publishes, schedules, or mutates any post."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": ["list", "detect", "refresh", "show", "status"],
                "description": (
                    "list (default) = show proposals; detect/refresh = re-scan the A/B "
                    "memory and upsert fresh proposals into the queue; show = one "
                    "proposal by id; status = current defaults + promotion policy + "
                    "counts. (approve/reject are NOT available — human CLI only.)"
                ),
            },
            "id": {
                "type": "string",
                "description": "Proposal id (required for action='show').",
            },
            "status": {
                "type": "string",
                "description": "Optional filter for action='list' (pending|approved|rejected|expired).",
            },
        },
        "required": [],
    },
}
