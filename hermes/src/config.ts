/**
 * config.ts — central config + the HARD, NON-NEGOTIABLE safety constants.
 *
 * DRAFT_ONLY is frozen true here on purpose: the loop may ONLY ever create Publer
 * posts with state="draft". Nothing in this codebase reads a "publish" flag from
 * config — going live is a HUMAN action, never the loop's. See guardrails.ts.
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

export const CONFIG = Object.freeze({
  // ── HARD SAFETY CONSTANTS ──────────────────────────────────────────────
  /** The loop can ONLY create drafts. Frozen. Never make this configurable. */
  DRAFT_ONLY: true as const,
  /** The single Publer post state the loop is allowed to emit. */
  ALLOWED_POST_STATE: "draft" as const,

  // ── LLM (TrueFoundry gateway) ──────────────────────────────────────────
  TFY_BASE_URL: (process.env.TFY_LLM_BASE_URL || "https://tfy.promptlens.trilogy.com/api/llm/v1").trim(),
  // The TrueFoundry key. Prefer TFY_API_KEY (what the VPS hermes.env sets — it
  // still wins there). Fall back to OPENAI_API_KEY so the SAME TrueFoundry key
  // works when it is only stored under that name (e.g. the isolated hermes-nous
  // build $HERMES_HOME/.env, where the Nous `custom` provider reads it too). One
  // key, two consumers; behavior-preserving where TFY_API_KEY is set.
  TFY_API_KEY: (process.env.TFY_API_KEY || process.env.OPENAI_API_KEY || "").trim(),
  MODEL: (process.env.HERMES_MODEL || "claude-opus-4-8").trim(),
  CAPTION_MODEL: (process.env.HERMES_CAPTION_MODEL || "claude-haiku-4-5").trim(),

  // ── Publer ─────────────────────────────────────────────────────────────
  PUBLER_API_KEY: (process.env.PUBLER_API_KEY || "").trim(),
  PUBLER_WORKSPACE_ID: (process.env.PUBLER_WORKSPACE_ID || "").trim(),
  ACCOUNTS: {
    instagram: "6a5fc9dc4ccd63dc1f041549",
    tiktok: "6a5fc5451bee22495517bcc5",
  },
  ACCOUNT_IDS: ["6a5fc9dc4ccd63dc1f041549", "6a5fc5451bee22495517bcc5"],

  // ── Metricool (REPLACES Publer; see docs/hermes/metricool-migration-plan.md) ──
  // Publer 403s on every content endpoint. userId/blogId are mandatory on every call
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
   */
  MC_MONTHLY_POST_BUDGET: Number(process.env.HERMES_MC_MONTHLY_BUDGET || 600),
  MC_MONTHLY_HARD_CAP: Number(process.env.HERMES_MC_MONTHLY_HARD_CAP || 700),
  MC_MONTHLY_ALERT_AT: Number(process.env.HERMES_MC_MONTHLY_ALERT_AT || 0.8),

  // ── Attribution ────────────────────────────────────────────────────────
  /** Per-video short link, so signups attribute to a single video instead of the bio. */
  SITE_BASE_URL: (process.env.HERMES_SITE_BASE_URL || "https://smartfellaorfartsmella.com").trim(),
  GO_LINK_PREFIX: (process.env.HERMES_GO_LINK_PREFIX || "/go/").trim(),

  // ── Media (S3 via tools/upload-media.ts) ───────────────────────────────
  MEDIA_HOST: (process.env.MEDIA_HOST || "s3").trim(),
  S3_BUCKET: (process.env.S3_BUCKET || "hermes-sffs-media").trim(),
  AWS_REGION: (process.env.AWS_REGION || "us-east-1").trim(),
  S3_PRESIGN_TTL: Number(process.env.S3_PRESIGN_TTL || 21600),

  // ── Batch shape ────────────────────────────────────────────────────────
  /**
   * CEILING: the most videos one day may schedule. One video fans out to exactly one
   * post per platform, so this is also the 12/day/platform post cap. The cycle plans
   * up to this many so that gate rejections and transient failures are absorbed
   * WITHOUT dropping below VIDEOS_FLOOR — oversampling, not a loosened gate.
   */
  VIDEOS_PER_DAY: Number(process.env.HERMES_VIDEOS_PER_DAY || 12),
  /**
   * FLOOR: the minimum videos a healthy cycle must land. If the first wave finishes
   * short of this (and the ceiling still has room), cycle.ts plans a bounded top-up
   * wave rather than leaving the day thin — the 2026-07-25 incident shipped 1 video.
   */
  VIDEOS_FLOOR: Number(process.env.HERMES_VIDEOS_FLOOR || 8),
  /**
   * PER-PLATFORM posting policy for the shape-only restart.
   *
   * Instagram carries the campaign: 12/day, and it is the only network that reports
   * a 3-second skip rate, so it is the only place the hook experiment can be measured.
   *
   * TikTok is PAUSED. It is under account-level suppression — a previous throttle only
   * lifted after 27.9 hours of total silence — and it never actually resumed when its
   * cooldown expired, so the pause makes that state a DECISION rather than an accident
   * of nothing having scheduled it.
   *
   * The pause is a pause, not a removal. The cadence below (2/day, 4-hour floor) is
   * deliberately left exactly as it should be when TikTok comes back, so nobody has to
   * reconstruct it later. The TikTok client and its analytics reading are untouched —
   * we still want to watch whether the account recovers.
   *
   *   TO RESUME TIKTOK: set HERMES_TIKTOK_PAUSED=false in /etc/hermes/hermes.env and
   *   restart. That is the whole step. Nothing else needs editing, and the 2/day cap
   *   and 4-hour gap come back with it.
   *
   * `darkUntil` is a naive local datetime in METRICOOL_TZ and is KEPT. It has already
   * expired, so on its own it would let TikTok back in; the pause is checked first and
   * overrides it, which neutralises the date trigger without throwing the cooldown
   * logic away.
   */
  PLATFORM_POLICY: {
    // 56 minutes is the same-platform floor the campaign has always run under; it was
    // 0 here only because the daily grid happened to space posts further apart anyway.
    instagram: { perDay: 12, minGapMinutes: 56, darkUntil: null as string | null, paused: false },
    tiktok: {
      perDay: 2,
      minGapMinutes: 240,
      darkUntil: (process.env.HERMES_TIKTOK_DARK_UNTIL || "2026-07-27T18:00:00").trim() as string | null,
      // Defaults to PAUSED, so the pause survives a fresh box or a lost env file.
      paused: String(process.env.HERMES_TIKTOK_PAUSED ?? "true").trim().toLowerCase() !== "false",
    },
  } as Record<string, { perDay: number; minGapMinutes: number; darkUntil: string | null; paused: boolean }>,
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
  USAGE: join(REPO_DIR, "content", "ab-test-usage.json"),
  BANK: join(REPO_DIR, "content", "master-question-bank.json"),
  BRAND_VOICE: join(REPO_DIR, "brand", "brand-voice.md"),
  BRAND_EXAMPLES: join(REPO_DIR, "brand", "brand-voice-examples.json"),
  HERMES_USED: join(DATA_DIR, "hermes-used-sigs.json"),
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

export function assertDraftOnly(): void {
  if (CONFIG.DRAFT_ONLY !== true || CONFIG.ALLOWED_POST_STATE !== "draft") {
    throw new Error("FATAL: DRAFT_ONLY invariant violated — refusing to run.");
  }
}
