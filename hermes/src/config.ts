/**
 * config.ts — central config + the HARD, NON-NEGOTIABLE safety constants.
 *
 * DRAFT_ONLY is frozen true here on purpose: the loop may ONLY ever create Publer
 * posts with state="draft". Nothing in this codebase reads a "publish" flag from
 * config — going live is a HUMAN action, never the loop's. See guardrails.ts.
 */
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";

const ENV_FILE = process.env.HERMES_ENV_FILE || "/home/ec2-user/hermes.env";
try {
  if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
} catch {
  /* env may already be exported (e.g. systemd EnvironmentFile) */
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
