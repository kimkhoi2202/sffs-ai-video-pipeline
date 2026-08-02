/**
 * config.ts — configuration for the hermes-nous READ-ONLY web dashboard.
 *
 * Node built-ins ONLY (no deps), mirroring the philosophy of the current live
 * dashboard (hermes/src/dashboard.ts). This module is a supervisor UI for the
 * rebuilt `hermes-nous` DRAFT-ONLY agent: it ONLY ever READS run-state JSON, the
 * A/B data files, the software-factory gate ledger, and GitHub PRs (via `gh`).
 *
 * HARD GUARDRAILS (frozen here on purpose):
 *   - READ_ONLY = true. This server never posts, schedules, publishes, merges, or
 *     mutates anything. It introduces NO publish/schedule/merge path. Going live
 *     (posting) and merging code are HUMAN actions, never this dashboard's.
 *   - Secrets come from the environment / $HERMES_HOME/.env (loaded below) and are
 *     NEVER written to git (see dashboard/.gitignore).
 *
 * Paths default to the SAME locations the live loop uses (see hermes/src/config.ts)
 * so the dashboard reads exactly the data the agent produces. Everything is
 * overridable by env for the isolated local/dev setup.
 */
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";

// ── load secrets/env (isolated $HERMES_HOME/.env, or the VPS EnvironmentFile) ──
// Never fatal: under systemd the vars are already exported, and locally a missing
// file just means "no keys" (the dashboard degrades gracefully, staying read-only).
const ENV_FILE =
  process.env.HERMES_ENV_FILE ||
  (process.env.HERMES_HOME ? join(process.env.HERMES_HOME, ".env") : "") ||
  "/home/ec2-user/hermes.env";
try {
  if (ENV_FILE && existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
} catch {
  /* env may already be exported (e.g. systemd EnvironmentFile) */
}

// dashboard/ → hermes-nous/ → <repo root>
const HERMES_NOUS_DIR = resolve(import.meta.dirname, "..");
const REPO_DIR = process.env.HERMES_REPO_DIR || resolve(HERMES_NOUS_DIR, "..");
const DATA_DIR = process.env.HERMES_DATA_DIR || "/home/ec2-user/hermes-data";

export const CONFIG = Object.freeze({
  // ── HARD SAFETY CONSTANT ────────────────────────────────────────────────
  /** This dashboard is strictly read-only. Never make it configurable. */
  READ_ONLY: true as const,

  /**
   * Whether the human approval gate is retired. Read with the SAME idiom and the same
   * default as hermes/src/config.ts, off the same /etc/hermes/hermes.env the dashboard
   * unit already loads, so the two surfaces cannot disagree about what the loop does.
   * The dashboard only ever DISPLAYS this — it does not act on it.
   */
  APPROVAL_PAUSED: String(process.env.HERMES_APPROVAL_PAUSED ?? "true").trim().toLowerCase() !== "false",
  /** The exact one-liner that brings the gate back, shown to the user in the panel. */
  APPROVAL_RESTORE_CMD: "HERMES_APPROVAL_PAUSED=false",

  // ── paths (same data the live loop reads/writes) ─────────────────────────
  REPO_DIR,
  HERMES_NOUS_DIR,
  DATA_DIR,
  /** per-cycle RunState JSON files: DATA_DIR/runs/<run_id>.json */
  RUNS_DIR: process.env.HERMES_RUNS_DIR || join(DATA_DIR, "runs"),
  /** per-run structured log lines (JSONL): DATA_DIR/runs/<run_id>.log */
  AB_DB: process.env.HERMES_AB_DB || join(REPO_DIR, "ab-testing", "ab-database.json"),
  LEARNINGS: process.env.HERMES_LEARNINGS || join(REPO_DIR, "ab-testing", "learnings.json"),
  // CONTENT baseline defaults + the human-approved default-promotion queue.
  CONTENT_DEFAULTS: process.env.HERMES_CONTENT_DEFAULTS || join(REPO_DIR, "ab-testing", "content-defaults.json"),
  PROPOSALS: process.env.HERMES_PROPOSALS || join(REPO_DIR, "ab-testing", "proposals.json"),
  // Reversible ledger for the winner-replication engine (hermes-nous/sffs/replicate.py):
  // which reach outlier the designer is doubling down on, its share of each batch, and
  // the append-only history of detections / escalations / reverts.
  REPLICATION: process.env.HERMES_REPLICATION || join(REPO_DIR, "ab-testing", "replication.json"),
  BANK: process.env.HERMES_BANK || join(REPO_DIR, "content", "master-question-bank.json"),
  USAGE: process.env.HERMES_USAGE || join(REPO_DIR, "content", "ab-test-usage.json"),
  HERMES_USED: process.env.HERMES_USED || join(DATA_DIR, "hermes-used-sigs.json"),
  // Cost-governor spend snapshot (snapshot.json), for the read-only SPEND panel.
  // Mirrors cost_governor.state_dir() precedence: SFFS_COST_GOVERNOR_DIR override,
  // else DATA_DIR/cost-governor. Read-only; degrades to "no snapshot" if absent.
  COST_SNAPSHOT:
    process.env.HERMES_COST_SNAPSHOT ||
    ((process.env.SFFS_COST_GOVERNOR_DIR || "").trim()
      ? join((process.env.SFFS_COST_GOVERNOR_DIR as string).trim(), "snapshot.json")
      : join(DATA_DIR, "cost-governor", "snapshot.json")),

  // Always-on software-factory DAEMON status (factory-status.json), for the live
  // FACTORY panel. Mirrors the daemon's SFFS_FACTORY_DAEMON_DIR (default
  // DATA_DIR/factory-daemon). Read-only; degrades to "no daemon status" if absent.
  FACTORY_STATUS:
    process.env.HERMES_FACTORY_STATUS ||
    ((process.env.SFFS_FACTORY_DAEMON_DIR || "").trim()
      ? join((process.env.SFFS_FACTORY_DAEMON_DIR as string).trim(), "factory-status.json")
      : join(DATA_DIR, "factory-daemon", "factory-status.json")),

  // Always-on continuous SUPERVISOR status (supervisor-status.json), for the live
  // SUPERVISOR panel. Mirrors the supervisor's SFFS_SUPERVISOR_DIR (default
  // DATA_DIR/supervisor). Read-only; degrades to "no supervisor status" if absent.
  SUPERVISOR_STATUS:
    process.env.HERMES_SUPERVISOR_STATUS ||
    ((process.env.SFFS_SUPERVISOR_DIR || "").trim()
      ? join((process.env.SFFS_SUPERVISOR_DIR as string).trim(), "supervisor-status.json")
      : join(DATA_DIR, "supervisor", "supervisor-status.json")),

  // ── GOAL-PROGRESS panel (Hermes's 7-day mandate) ─────────────────────────
  // The 7-day clock is ARMED by a box-only file: it must EXIST and its CONTENT
  // must contain the exact phrase below. t0 = that file's mtime. Read-only: the
  // dashboard only reports the state; arming is a human/box action, never a web
  // action. Both paths default under DATA_DIR and are env-overridable.
  KICKOFF_FILE: process.env.HERMES_KICKOFF_FILE || join(DATA_DIR, "KICKOFF_ARMED"),
  /** exact phrase the KICKOFF_ARMED file must contain to arm the clock. */
  KICKOFF_PHRASE: (process.env.HERMES_KICKOFF_PHRASE || "ARM SFFS AUTONOMY").trim(),
  /** optional per-platform follower snapshot ({instagram:{followers},tiktok:{followers}}). */
  ACCOUNT_METRICS: process.env.HERMES_ACCOUNT_METRICS || join(DATA_DIR, "account-metrics.json"),
  /** LIVE per-network analytics totals, written each cycle by hermes/src/score.ts.
   *  The goal panel's view totals come from here, not from the ab-database join. */
  ANALYTICS_SNAPSHOT: process.env.HERMES_ANALYTICS_SNAPSHOT || join(DATA_DIR, "analytics-totals.json"),

  // ── question-bank runway estimate (coverage panel) ───────────────────────
  /** est. videos/day and questions/video, used only to estimate days-of-runway. */
  VIDEOS_PER_DAY: Number(process.env.HERMES_VIDEOS_PER_DAY || 10),
  AVG_Q_PER_VIDEO: Number(process.env.HERMES_AVG_Q_PER_VIDEO || 3),

  // ── software factory: the two-key auto-merge gate + its JSONL ledger ─────
  // auto_merge.py appends one JSON line per merge attempt to scripts/gate/logs/
  // auto_merge.log (each with keys.harness / keys.review / decision / merged).
  GATE_LOG: process.env.SFFS_GATE_LOG || join(HERMES_NOUS_DIR, "scripts", "gate", "logs", "auto_merge.log"),
  /** "owner/name"; empty ⇒ let `gh` auto-detect from the repo's origin remote. */
  GH_REPO: (process.env.SFFS_GH_REPO || "").trim(),
  GH_BIN: (process.env.GH_BIN || "gh").trim(),
  PR_LIMIT: Number(process.env.SFFS_DASH_PR_LIMIT || 30),
  GH_TIMEOUT_MS: Number(process.env.SFFS_DASH_GH_TIMEOUT_MS || 6000),

  // ── kill-switch (DISPLAY-ONLY indicator) ─────────────────────────────────
  // Mirrors auto_merge.py check_kill_switch: an env var (truthy) OR a stop-file.
  // The dashboard only *reports* the state; it never engages/clears it (that
  // would be a control action — display only).
  KILL_ENV_VARS: ["SFFS_FACTORY_KILL", "HERMES_SFFS_FACTORY_KILL"] as const,
  KILL_FILES: (process.env.SFFS_KILL_FILE
    ? [process.env.SFFS_KILL_FILE]
    : [join(HERMES_NOUS_DIR, "scripts", "gate", "STOP"), join(DATA_DIR, "FACTORY_STOP")]) as string[],

  // ── cycle schedule ───────────────────────────────────────────────────────
  /** cadence used to *estimate* the next run when no live timer is queryable. */
  CADENCE_HOURS: Number(process.env.HERMES_CADENCE_HOURS || 24),
  /** systemd timer unit to query for the authoritative next run, if present. */
  TIMER_UNIT: (process.env.HERMES_TIMER_UNIT || "sffs-nightly.timer").trim(),

  // ── LLM gateway health ping (optional, best-effort; no token spend) ──────
  TFY_BASE_URL: (process.env.TFY_LLM_BASE_URL || "https://tfy.promptlens.trilogy.com/api/llm/v1").trim(),
  TFY_API_KEY: (process.env.TFY_API_KEY || process.env.OPENAI_API_KEY || "").trim(),
  MODEL: (process.env.HERMES_MODEL || "claude-opus-5").trim(),

  // ── dashboard server + basic auth (like the current dashboard) ──────────
  // Default port 8081 so it can run ALONGSIDE the live dashboard (8080) safely.
  DASH_PORT: Number(process.env.HERMES_NOUS_DASH_PORT || 8081),
  DASH_USER: (process.env.HERMES_DASH_USER || "hermes").trim(),
  DASH_PASS: (process.env.HERMES_DASH_PASS || "").trim(),

  // ── Live schedule (READ-ONLY) ────────────────────────────────────────────
  // READ-ONLY Metricool bridge. Spawned as a subprocess on purpose: it keeps
  // createPost/reschedule/deletePost out of this server's module graph.
  METRICOOL_READ_BRIDGE:
    (process.env.HERMES_METRICOOL_READ_BRIDGE || join(HERMES_NOUS_DIR, "bridge", "metricool-read.ts")).trim(),
  // Ledger the controlled poster writes after every create: uuid -> videoId, slot and
  // A/B opening arm. The dashboard joins on uuid to label each card with its arm.
  SCHEDULED_LEDGER:
    (process.env.HERMES_SCHEDULED_LEDGER || join(DATA_DIR, "metricool-scheduled.json")).trim(),
  /** Hook-arm reels the 3-second skip-rate test needs before it can conclude. */
  HOOK_ARM_TARGET: Number(process.env.HERMES_HOOK_ARM_TARGET || 15),
  /** in-memory cache TTL for the live drafts list (ms). */
  DRAFTS_TTL_MS: Number(process.env.HERMES_DRAFTS_TTL_MS || 120_000),
  /** hard timeout for the read-only bridge subprocess (ms). */
  DRAFTS_BRIDGE_TIMEOUT_MS: Number(process.env.HERMES_DRAFTS_BRIDGE_TIMEOUT_MS || 20_000),

  /** fallback account_id → platform map (also read live from ab-database.json accounts). */
  ACCOUNT_PLATFORMS: Object.freeze({
    "6a5fc5451bee22495517bcc5": "tiktok",
    "6a5fc9dc4ccd63dc1f041549": "instagram",
  }) as Record<string, string>,
});

/** Fail-closed boot assertion: refuse to run if the read-only invariant is off. */
export function assertReadOnly(): void {
  if (CONFIG.READ_ONLY !== true) {
    throw new Error("FATAL: dashboard READ_ONLY invariant violated — refusing to start.");
  }
}
