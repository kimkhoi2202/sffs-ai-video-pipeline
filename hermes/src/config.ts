/**
 * config.ts — central config + the HARD, NON-NEGOTIABLE safety constants.
 *
 * THE APPROVAL GATE IS RETIRED, AND RESTORABLE IN ONE LINE. Instagram auto-publishes,
 * so the loop creates LIVE scheduled posts rather than drafts a human has to release.
 * The behaviour hangs off HERMES_APPROVAL_PAUSED, which takes the same shape and the
 * same default polarity as HERMES_TIKTOK_PAUSED: anything but the literal "false"
 * leaves the gate retired, and the single line
 *
 *     HERMES_APPROVAL_PAUSED=false
 *
 * in /etc/hermes/hermes.env brings it back — every new post returns to
 * draft:true/autoPublish:false and the dashboard queue relights, with no code change.
 *
 * WHAT THIS FLAG DOES NOT TOUCH. It is a POSTING policy, not a content one. The five
 * deterministic content gates (dedup, question validity, brand/copy, render sanity and
 * Instagram's explicit-thumbnail requirement) run identically either way, and with the
 * human out of the loop they are now the ONLY automated protection on a post. See
 * guardrails.ts and publishGate.ts.
 */
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";

// The box keeps its env at /etc/hermes/hermes.env (0600); the older path is kept for
// dev boxes. Without the /etc fallback nothing here loaded on the VPS unless systemd
// happened to supply EnvironmentFile, which silently left secrets empty.
const ENV_CANDIDATES = [process.env.HERMES_ENV_FILE, "/home/ec2-user/hermes.env", "/etc/hermes/hermes.env"];
for (const f of ENV_CANDIDATES) {
  if (!f) continue;
  try {
    if (existsSync(f)) { process.loadEnvFile(f); break; }
  } catch {
    /* env may already be exported (e.g. systemd EnvironmentFile) */
  }
}

const REPO_DIR = process.env.HERMES_REPO_DIR || resolve(import.meta.dirname, "..", "..");
const DATA_DIR = process.env.HERMES_DATA_DIR || "/home/ec2-user/hermes-data";
const HERMES_HOME = (process.env.HERMES_HOME || "").trim();

/**
 * The one switch that restores the human approval gate. Read once, here, so there is a
 * single place to look and a single line to change on the box.
 */
const APPROVAL_PAUSED = String(process.env.HERMES_APPROVAL_PAUSED ?? "true").trim().toLowerCase() !== "false";

export const CONFIG = Object.freeze({
  // ── POSTING STATE ──────────────────────────────────────────────────────
  /** True while the approval gate is retired and the loop may schedule live. */
  APPROVAL_PAUSED,
  /** True only while the gate is in force. DERIVED — never set this by hand. */
  DRAFT_ONLY: !APPROVAL_PAUSED,
  /** The single post state the loop is allowed to emit, given the gate above. */
  ALLOWED_POST_STATE: (APPROVAL_PAUSED ? "live" : "draft") as "live" | "draft",

  // ── LLM (TrueFoundry gateway) ──────────────────────────────────────────
  TFY_BASE_URL: (process.env.TFY_LLM_BASE_URL || "https://tfy.promptlens.trilogy.com/api/llm/v1").trim(),
  // The TrueFoundry key. Prefer TFY_API_KEY (what the VPS hermes.env sets — it
  // still wins there). Fall back to OPENAI_API_KEY so the SAME TrueFoundry key
  // works when it is only stored under that name (e.g. the isolated hermes-nous
  // build $HERMES_HOME/.env, where the Nous `custom` provider reads it too). One
  // key, two consumers; behavior-preserving where TFY_API_KEY is set.
  TFY_API_KEY: (process.env.TFY_API_KEY || process.env.OPENAI_API_KEY || "").trim(),
  /**
   * THE REASONING MODEL. claude-opus-5 as of 2026-08-02, verified against the live
   * gateway (`GET /models` lists `claude-opus-5` and `claude-group/claude-opus-5`; a
   * chat call to the bare slug returns 200 and routes to anthropic-primary). Used by
   * the question-validity judge and the preflight ping.
   *
   * DO NOT use the `aws-bedrock/...anthropic.claude-opus-*` slugs. They are listed by
   * the gateway but this account is not subscribed to them in AWS Marketplace, so they
   * answer 403 with a message about IAM and Marketplace permissions that reads like an
   * infrastructure fault rather than a wrong model name.
   *
   * COST, MEASURED NOT GUESSED. A real three-question judge call under the current
   * contract: opus-4-8 $0.0133, opus-5 $0.0240, sonnet-5 $0.0148, haiku-4-5 $0.0032.
   * At ~12-16 judge calls a cycle that is well under fifty cents a day for the whole
   * loop. See JUDGE_FALLBACK_MODEL for what happens when the shared cap bites anyway.
   */
  MODEL: (process.env.HERMES_MODEL || "claude-opus-5").trim(),
  CAPTION_MODEL: (process.env.HERMES_CAPTION_MODEL || "claude-haiku-4-5").trim(),
  /**
   * What the validity judge falls back to when the reasoning model is unreachable.
   *
   * The gateway's budget rule is per VIRTUAL ACCOUNT and shared with workloads that
   * have nothing to do with this loop — the 429 storms on 2026-07-25 and 2026-07-29
   * were the pool being spent elsewhere, not by us (this loop's whole daily bill is
   * cents). So an Opus 429 is a statement about someone else's traffic, and answering
   * it by throwing away the day's judgement is the wrong trade. Haiku judged the same
   * three-question probe correctly at an eighth of the cost, so it is a real second
   * opinion rather than a token gesture. The deterministic structural check remains
   * the last resort, only if BOTH models are unreachable.
   */
  JUDGE_FALLBACK_MODEL: (process.env.HERMES_JUDGE_FALLBACK_MODEL || "claude-haiku-4-5").trim(),

  // ── Social accounts ────────────────────────────────────────────────────
  ACCOUNTS: {
    instagram: "6a5fc9dc4ccd63dc1f041549",
    tiktok: "6a5fc5451bee22495517bcc5",
    // The YouTube CHANNEL id, read from Metricool's own brand record
    // (settings/brands -> networksData.youtubeData). The two ids above are
    // Publer-era account ids kept for the historical rows that carry them; there
    // was never a Publer YouTube account, so this is the channel id instead. It is
    // used only to label A/B rows, never to address the Metricool API.
    youtube: "UCaP4hiMhNnFyUAJhLWvxLMQ",
  },
  ACCOUNT_IDS: ["6a5fc9dc4ccd63dc1f041549", "6a5fc5451bee22495517bcc5", "UCaP4hiMhNnFyUAJhLWvxLMQ"],

  // ── Metricool ──────────────────────────────────────────────────────────
  // userId/blogId are mandatory on every call
  // and are declared on NONE of the spec's 497 paths, so metricool.ts injects them in
  // the transport layer and never at a call site.
  METRICOOL_BASE_URL: (process.env.METRICOOL_BASE_URL || "https://app.metricool.com/api").trim(),
  METRICOOL_USER_TOKEN: (process.env.METRICOOL_USER_TOKEN || "").trim(),
  METRICOOL_USER_ID: (process.env.METRICOOL_USER_ID || "").trim(),
  METRICOOL_BLOG_ID: (process.env.METRICOOL_BLOG_ID || "").trim(),
  /** Brand timezone. Metricool takes naive local datetimes plus a separate IANA zone. */
  METRICOOL_TZ: (process.env.METRICOOL_TZ || "America/Chicago").trim(),
  /**
   * Fair Use publication budget, per brand per month. Metricool's documented base
   * threshold is 600 and this account's maxPostsPerBrand is 700. Breaching does NOT
   * return 429 — it triggers a manual human review during which the account cannot
   * post at all, so we plan against 600 and treat 700 as the ceiling we never approach.
   *
   * THIS IS NOT A BILLING LEVER. maxPostsPerBrand is 700 on every API-enabled plan, so
   * there is no upgrade that buys headroom — the only way to afford more networks is
   * fewer posts each. And a fan-out costs one record PER NETWORK, not one per video:
   * N networks at P/day is N*P records/day. See postingPolicy.ts monthlyRecords().
   */
  MC_MONTHLY_POST_BUDGET: Number(process.env.HERMES_MC_MONTHLY_BUDGET || 600),
  MC_MONTHLY_HARD_CAP: Number(process.env.HERMES_MC_MONTHLY_HARD_CAP || 700),
  MC_MONTHLY_ALERT_AT: Number(process.env.HERMES_MC_MONTHLY_ALERT_AT || 0.8),

  // ── Attribution ────────────────────────────────────────────────────────
  /** Per-video short link, so signups attribute to a single video instead of the bio. */
  SITE_BASE_URL: (process.env.HERMES_SITE_BASE_URL || "https://smartfellaorfartsmella.com").trim(),
  /**
   * The host NEW captions link to, via the per-platform vanity paths
   * `/instagram`, `/youtube` and `/tiktok` (see platformCaption.vanityUrl).
   *
   * WWW, NOT THE APEX, and that is measured rather than assumed. The apex answers
   * HTTP 308 to the www host and www then answers the 307 that actually carries the
   * attribution, so the apex form works but spends an extra hop before anything is
   * tagged. www is one hop to `/?utm_source=<network>&utm_medium=social`.
   *
   * Kept separate from SITE_BASE_URL, which still addresses the legacy `/go/<id>`
   * tracker that already-published captions point at.
   */
  SITE_VANITY_BASE: (process.env.HERMES_SITE_VANITY_BASE || "https://www.smartfellaorfartsmella.com").trim(),
  GO_LINK_PREFIX: (process.env.HERMES_GO_LINK_PREFIX || "/go/").trim(),

  // ── Media (S3 via tools/upload-media.ts) ───────────────────────────────
  MEDIA_HOST: (process.env.MEDIA_HOST || "s3").trim(),
  S3_BUCKET: (process.env.S3_BUCKET || "hermes-sffs-media").trim(),
  AWS_REGION: (process.env.AWS_REGION || "us-east-1").trim(),
  S3_PRESIGN_TTL: Number(process.env.S3_PRESIGN_TTL || 21600),

  // ── Batch shape ────────────────────────────────────────────────────────
  /**
   * CEILING: the most videos one day may schedule. One video fans out to at most one
   * post per ACTIVE platform, so this tracks the LARGEST per-platform/day cap in
   * PLATFORM_POLICY below (Instagram's 12). The cycle plans up to this many so that
   * gate rejections and transient failures are absorbed WITHOUT dropping below
   * VIDEOS_FLOOR — oversampling, not a loosened gate.
   *
   * Networks with a SMALLER cap than this simply take fewer of the batch: at
   * YouTube's 7/day, a full 12-video day places 7 YouTube posts today and lets
   * planSlots spill the remaining 5 onto the next day with room (loopPublish.ts
   * planSlots, HORIZON_DAYS). That spill is the existing designed behaviour for a
   * batch bigger than one day's cap, not something YouTube introduced.
   */
  VIDEOS_PER_DAY: Number(process.env.HERMES_VIDEOS_PER_DAY || 12),
  /**
   * FLOOR: the minimum videos a healthy cycle must land. If the first wave finishes
   * short of this (and the ceiling still has room), cycle.ts plans a bounded top-up
   * wave rather than leaving the day thin — the 2026-07-25 incident shipped 1 video.
   *
   * RAISED 8 -> 12 on 2026-08-02, to match the ceiling. At 8 the loop stopped topping
   * up as soon as it had 8, so a day with a normal rejection rate landed 8 and the
   * remaining 4 slots of the 12/day cap were simply never used — which is how five
   * consecutive cycles all reported "8 scheduled". Floor == ceiling means the day is
   * only finished when the cap is full or the waves run out.
   */
  VIDEOS_FLOOR: Number(process.env.HERMES_VIDEOS_FLOOR || 12),
  /**
   * PER-PLATFORM posting policy. EVERY NETWORK RUNS 12/DAY (2026-08-02).
   *
   * The campaign has two weeks left and is optimising for distribution, so all three
   * networks take the full daily allowance rather than being rationed against each
   * other. The SPACING rules are unchanged — the same-platform floor and each
   * network's jitter lane (scheduler.ts LANES) still apply, so raising the counts
   * changes how many posts a day holds and not how they are laid out in it.
   *
   * WHAT THIS COSTS. A fan-out spends one Metricool record PER NETWORK, so three
   * networks at 12/day is 36 records/day against the 600/month Fair Use budget the
   * client guards. The month counter stands at 17, and 14 more days at 36 is 504, for
   * 521 of 600 — it fits the remaining window with room to spare. budget() is
   * unchanged and still fails closed at 600; it is the pre-existing guard, not a new
   * monitor, and nothing here alerts.
   *
   * TIKTOK IS LIVE AGAIN. It had been paused under account-level suppression (an
   * earlier throttle only lifted after 27.9 hours of silence) and the most recent
   * evidence is not encouraging — 1 view on our best video 22 hours after posting.
   * Resuming anyway is the owner's explicit decision. It comes back at the same 12/day
   * as everyone else, but it KEEPS ITS OWN 4-HOUR same-platform floor: that gap is a
   * platform-behaviour precaution, not a volume lever, and 12 posts at a 4-hour floor
   * simply spill across days via loopPublish.planSlots the way any over-full network
   * does.
   *
   *   TO PAUSE TIKTOK AGAIN: HERMES_TIKTOK_PAUSED=true in /etc/hermes/hermes.env.
   *
   * `darkUntil` is a naive local datetime in METRICOOL_TZ, long expired, and kept only
   * so the cooldown mechanism still exists for a future throttle.
   */
  PLATFORM_POLICY: {
    // 56 minutes is the same-platform floor the campaign has always run under; it was
    // 0 here only because the daily grid happened to space posts further apart anyway.
    instagram: { perDay: 12, minGapMinutes: 56, darkUntil: null as string | null, paused: false },
    youtube: { perDay: 12, minGapMinutes: 56, darkUntil: null as string | null, paused: false },
    tiktok: {
      perDay: 12,
      minGapMinutes: 240,
      darkUntil: (process.env.HERMES_TIKTOK_DARK_UNTIL || "2026-07-27T18:00:00").trim() as string | null,
      // Defaults to LIVE now. Still one env line either way.
      paused: String(process.env.HERMES_TIKTOK_PAUSED ?? "false").trim().toLowerCase() === "true",
    },
  } as Record<string, { perDay: number; minGapMinutes: number; darkUntil: string | null; paused: boolean }>,
  /**
   * YouTube Shorts publishing defaults (metricool.ts buildCreateBody -> youtubeData).
   *
   * Every one of these is sent EXPLICITLY. Metricool's swagger declares
   * ScheduledPostYoutubeData with seven plain properties and NOT ONE default — verified
   * against the live spec, not the docs — so anything omitted is whatever the server
   * happens to do, which is exactly the class of silent difference this codebase has
   * been bitten by before (see the instagramData showReelOnFeed note).
   *
   * madeForKids is the one that matters most: YouTube requires a COPPA self-declaration
   * on every upload and there is no visible default to inherit. False is correct here —
   * this is general-audience comedy quiz content, not children's content — but the
   * point is that it is stated rather than assumed.
   *
   * CATEGORY comes from the live catalog (/v2/scheduler/catalogs/youtube/categories):
   * one of FILM_ANIMATION, AUTOS_VEHICLES, MUSIC, PETS_ANIMALS, SPORTS, TRAVEL_EVENTS,
   * GAMING, PEOPLE_BLOGS, COMEDY, ENTERTAINMENT, NEWS_POLITICS, HOWTO_STYLE, EDUCATION,
   * SCIENCE_TECHNOLOGY, NONPROFITS_ACTIVISM.
   *
   * PRIVACY is the one value the swagger does not pin down: it declares a bare string
   * with no enum and no default anywhere in the spec. "public" follows YouTube's own
   * API vocabulary (status.privacyStatus is lowercase public/unlisted/private) and
   * matches the lowercase vocabulary Metricool uses for `type`. It is env-overridable
   * so a human can correct it without a code change if the first real post disagrees.
   */
  YOUTUBE: {
    /** "short" — matches Metricool's own lowercase videoType enum (video|short|unknown). */
    type: (process.env.HERMES_YT_TYPE || "short").trim(),
    privacy: (process.env.HERMES_YT_PRIVACY || "public").trim(),
    category: (process.env.HERMES_YT_CATEGORY || "ENTERTAINMENT").trim(),
    /** COPPA self-declaration. Explicit on every post; never left to a default. */
    madeForKids: String(process.env.HERMES_YT_MADE_FOR_KIDS ?? "false").trim().toLowerCase() === "true",
    /** YouTube hard-caps the title at 100 characters. Separate from the post text,
     *  which becomes the (5,000-char) description. */
    titleMaxChars: 100,
    /** Shorts must stay under 3:00. We assert well under it — YouTube can lengthen a
     *  video slightly in processing and reclassify a borderline one as long-form. */
    maxDurationSeconds: Number(process.env.HERMES_YT_MAX_SECONDS || 170),
  },
  /**
   * YOUTUBE RAMP — the per-day YouTube cap while the channel is being seeded.
   *
   * The channel starts with zero history, so it does not open at the full 7/day. The
   * ramp is a CEILING per calendar day, expressed as (days after RAMP_START -> perDay):
   * 3/day from the start, 5/day from +2 days, 7/day from +4 days, where 7 is
   * PLATFORM_POLICY.youtube.perDay and therefore the terminal value.
   *
   * THIS IS A CAP, NOT AN ADDITIONAL BUDGET. It is consulted by
   * postingPolicy.perDayFor(), which loopPublish.planSlots() uses to size each day's
   * remaining room. A catalogue backfill post and a fresh loop post are both just
   * YouTube posts on that day, so the backfill CONSUMES the day's allowance and the
   * loop sees whatever is left — rather than the two stacking and blowing past both
   * the ramp and the 7/day cap. That is the whole mechanism; there is no separate
   * backfill counter to keep in sync.
   *
   * RAMP_START is a naive local (METRICOOL_TZ) calendar date. EMPTY DISABLES THE RAMP
   * entirely and every day falls back to PLATFORM_POLICY.youtube.perDay, so this
   * cannot strand the network at a seeding cap if it is ever forgotten.
   *
   * THE RAMP HAS COMPLETED. It started 2026-07-28 and its last step is +4 days, so from
   * 2026-08-01 onward it returns the terminal value on every day. That terminal was
   * raised 7 -> 12 with the policy on 2026-08-02; leaving it at 7 would have silently
   * held YouTube at 7/day, because perDayFor() takes the MINIMUM of the ramp and the
   * policy. The early steps are left as they are — they are the history of a channel
   * that really was seeded that way, and they only apply to dates already past.
   */
  YT_RAMP_START: (process.env.HERMES_YT_RAMP_START ?? "2026-07-28").trim(),
  /** (days after YT_RAMP_START, cap) — ascending, terminal value must be the
   *  PLATFORM_POLICY youtube perDay so the ramp converges on the real cap. */
  YT_RAMP_STEPS: [
    { afterDays: 0, perDay: 3 },
    { afterDays: 2, perDay: 5 },
    { afterDays: 4, perDay: 12 },
  ] as ReadonlyArray<{ afterDays: number; perDay: number }>,
  MUSIC_TRACKS: [
    "audio/music/gameshow-fanfare.mp3",
    "audio/music/prize-wheel-parade.mp3",
    "audio/music/winner-spin.mp3",
    "audio/music/bonus-round-bounce.mp3",
    "audio/music/final-round-fanfare.mp3",
    "audio/music/fanfare.mp3",
    "audio/music/parade.mp3",
    "audio/music/winner.mp3",
  ],
  // Alternate music bed (see hermes/src/music.ts). OFF unless HERMES_MUSIC_APT=1.
  // When on it applies to NET-NEW Instagram and YouTube renders; TikTok keeps
  // MUSIC_TRACKS (paused, and the account is already under distribution suppression).
  // Off => MUSIC_TRACKS above stays the shipped default on every platform.
  //
  // A REPOST IS NEVER AFFECTED by this switch, on any platform. The catalogue backfill
  // renders from a stored props sidecar and never runs music selection at all, so an
  // already-published video keeps whatever bed it shipped with. See render.ts musicFor.
  MUSIC_APT: process.env.HERMES_MUSIC_APT === "1",
  /**
   * YouTube-only kill switch for the alternate bed, ON by default whenever MUSIC_APT
   * is on. `HERMES_MUSIC_APT_YOUTUBE=0` takes YouTube back to its licensed beds while
   * leaving Instagram on.
   *
   * This exists because the YouTube downside is categorically worse than Instagram's.
   * A Content ID claim on a Short OVER ONE MINUTE is a HARD BLOCK rather than a
   * monetisation redirect, and these videos run 69 to 91 seconds — all of them over
   * the line. On Instagram the realistic outcome is muted audio or reach suppression.
   * Same switch shape, one line either way.
   */
  MUSIC_APT_YOUTUBE: process.env.HERMES_MUSIC_APT_YOUTUBE !== "0",
  HASHTAG_SETS: {
    A: ["#fyp", "#foryou", "#quiz", "#trivia", "#brainteaser"],
    B: ["#smartorfart", "#iqtest", "#puzzletok", "#riddles", "#mindgames"],
    C: ["#quiztime", "#braintest", "#canyoupass", "#puzzle", "#trivianight"],
  } as Record<string, string[]>,

  // ── Paths ──────────────────────────────────────────────────────────────
  REPO_DIR,
  DATA_DIR,
  RUNS_DIR: join(DATA_DIR, "runs"),
  RENDERS_DIR: join(DATA_DIR, "renders"),
  CACHE_DIR: join(DATA_DIR, "cache"),
  AB_DB: join(REPO_DIR, "ab-testing", "ab-database.json"),
  LEARNINGS: join(REPO_DIR, "ab-testing", "learnings.json"),
  // CONTENT baseline defaults + human-approved default-promotion policy (see defaults.ts).
  CONTENT_DEFAULTS: join(REPO_DIR, "ab-testing", "content-defaults.json"),
  // Durable default-promotion proposal queue (written by the Python promotion engine).
  PROPOSALS: join(REPO_DIR, "ab-testing", "proposals.json"),
  /**
   * The OPENING-QUESTION policy ledger (leadPromotion.ts). Rewritten every cycle with
   * the evidence table, the resulting mix, and the mix it replaced. This file IS the
   * reversal mechanism: `history` holds the previous shares, and deleting the file
   * returns the loop to an even draw on the next run.
   */
  LEAD_POLICY: join(REPO_DIR, "ab-testing", "lead-policy.json"),
  HOOK_BANK: join(REPO_DIR, "ab-testing", "hook-bank.json"),
  USAGE: join(REPO_DIR, "content", "ab-test-usage.json"),
  BANK: join(REPO_DIR, "content", "master-question-bank.json"),
  BRAND_VOICE: join(REPO_DIR, "brand", "brand-voice.md"),
  BRAND_EXAMPLES: join(REPO_DIR, "brand", "brand-voice-examples.json"),
  HERMES_USED: join(DATA_DIR, "hermes-used-sigs.json"),
  /**
   * QUARANTINE: questions the validity gate REJECTED. Separate from HERMES_USED
   * because they were never published — but they must be excluded from selection
   * just as firmly, or the generator keeps re-proposing them. It did: seven
   * questions were flagged twice between 2026-07-30 and 2026-08-02 and one burned
   * two slots inside a single run. See questions.ts markRejected.
   */
  HERMES_REJECTED: join(DATA_DIR, "hermes-rejected-sigs.json"),
  /**
   * LIVE per-network analytics totals, rewritten every cycle by score.ts. The goal
   * rollup reads THIS rather than summing the ab-database join, so the headline number
   * is what the analytics API actually reports and not what the join managed to
   * attribute. See score.ts buildAnalyticsSnapshot.
   */
  ANALYTICS_SNAPSHOT: join(DATA_DIR, "analytics-totals.json"),
  // The framework's live agent memory. Each cycle appends a bounded one-line
  // takeaway here (see memory.ts). On the VPS this is $HERMES_HOME/memories/
  // MEMORY.md (what the agent actually reads); locally it falls back to DATA_DIR
  // so a dev run never churns the repo's MEMORY.md template.
  MEMORY_FILE:
    process.env.HERMES_MEMORY_FILE ||
    (HERMES_HOME ? join(HERMES_HOME, "memories", "MEMORY.md") : join(DATA_DIR, "memories", "MEMORY.md")),

  // ── Dashboard ──────────────────────────────────────────────────────────
  DASH_PORT: Number(process.env.HERMES_DASH_PORT || 8080),
  DASH_USER: (process.env.HERMES_DASH_USER || "hermes").trim(),
  DASH_PASS: (process.env.HERMES_DASH_PASS || "").trim(),

  REMOTION_DIR: join(REPO_DIR, "remotion"),
});

/**
 * The post-state invariant. This used to assert a frozen constant; now that the state
 * is configurable, the thing worth asserting is COHERENCE — that the gate flag, the
 * derived DRAFT_ONLY and the emitted post state all agree. A half-applied change (a
 * run that believes it is drafting while it emits live posts, or the reverse) still
 * refuses to start rather than discovering the disagreement one write at a time.
 */
export function assertPostState(): void {
  const gated = !CONFIG.APPROVAL_PAUSED;
  if (CONFIG.DRAFT_ONLY !== gated || CONFIG.ALLOWED_POST_STATE !== (gated ? "draft" : "live")) {
    throw new Error(
      `FATAL: post-state invariant violated (APPROVAL_PAUSED=${CONFIG.APPROVAL_PAUSED} ` +
        `DRAFT_ONLY=${CONFIG.DRAFT_ONLY} ALLOWED_POST_STATE=${CONFIG.ALLOWED_POST_STATE}) — refusing to run.`,
    );
  }
}
