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

  // ── paths (same data the live loop reads/writes) ─────────────────────────
  REPO_DIR,
  HERMES_NOUS_DIR,
  DATA_DIR,
  /** per-cycle RunState JSON files: DATA_DIR/runs/<run_id>.json */
  RUNS_DIR: process.env.HERMES_RUNS_DIR || join(DATA_DIR, "runs"),
  /** per-run structured log lines (JSONL): DATA_DIR/runs/<run_id>.log */
  AB_DB: process.env.HERMES_AB_DB || join(REPO_DIR, "ab-testing", "ab-database.json"),
  LEARNINGS: process.env.HERMES_LEARNINGS || join(REPO_DIR, "ab-testing", "learnings.json"),
  BANK: process.env.HERMES_BANK || join(REPO_DIR, "content", "master-question-bank.json"),
  USAGE: process.env.HERMES_USAGE || join(REPO_DIR, "content", "ab-test-usage.json"),
  HERMES_USED: process.env.HERMES_USED || join(DATA_DIR, "hermes-used-sigs.json"),

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
  MODEL: (process.env.HERMES_MODEL || "claude-opus-4-8").trim(),

  // ── dashboard server + basic auth (like the current dashboard) ──────────
  // Default port 8081 so it can run ALONGSIDE the live dashboard (8080) safely.
  DASH_PORT: Number(process.env.HERMES_NOUS_DASH_PORT || 8081),
  DASH_USER: (process.env.HERMES_DASH_USER || "hermes").trim(),
  DASH_PASS: (process.env.HERMES_DASH_PASS || "").trim(),
});

/** Fail-closed boot assertion: refuse to run if the read-only invariant is off. */
export function assertReadOnly(): void {
  if (CONFIG.READ_ONLY !== true) {
    throw new Error("FATAL: dashboard READ_ONLY invariant violated — refusing to start.");
  }
}
