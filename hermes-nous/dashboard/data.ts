/**
 * data.ts — READ-ONLY data loaders for the dashboard.
 *
 * Every loader is best-effort: a missing/%corrupt file NEVER crashes the page, it
 * degrades to an empty/fallback value. Nothing here writes, posts, schedules, or
 * mutates anything — it only reads local JSON, queries `systemctl`/`df` for health,
 * and (optionally) pings the LLM gateway with a short timeout.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { CONFIG } from "./config.ts";
import type { RunState } from "./types.ts";
import { computeGoalProgress, goalWindowStart, type GoalProgress, type FollowerSnapshot, type LiveAnalyticsRow } from "./goal.ts";

// ── JSON + runs ───────────────────────────────────────────────────────────────

export function readJSON<T>(path: string, fallback: T): T {
  try {
    if (!existsSync(path)) return fallback;
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function listRuns(): string[] {
  try {
    return readdirSync(CONFIG.RUNS_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/**
 * Redact fields that must never reach a PUBLIC response. Currently: the per-video
 * `media_url` is a PRESIGNED S3 URL (carries X-Amz-Signature / X-Amz-Credential /
 * X-Amz-Security-Token — temporary credentials). The dashboard is now public, so
 * we strip it here at the single load point (covers /, /api/state, /api/run,
 * /api/health). The video itself is reviewable via its Metricool permalink.
 */
export function redactRunForPublic(run: RunState | null): RunState | null {
  if (!run || !Array.isArray(run.videos)) return run;
  for (const v of run.videos) {
    if (v && typeof v === "object" && "media_url" in v) delete (v as { media_url?: unknown }).media_url;
  }
  return run;
}

export function loadRun(runId: string): RunState | null {
  if (!runId || /[\\/]/.test(runId)) return null; // no path traversal
  return redactRunForPublic(readJSON<RunState | null>(`${CONFIG.RUNS_DIR}/${runId}.json`, null));
}

export function runSummaries(limit = 30): RunState[] {
  return listRuns()
    .slice(0, limit)
    .map((id) => loadRun(id))
    .filter((r): r is RunState => !!r);
}

export function abDb(): any {
  return readJSON<any>(CONFIG.AB_DB, { posts: [] });
}

export function learnings(): any {
  return readJSON<any>(CONFIG.LEARNINGS, {});
}

/** The durable default-promotion queue (proposals + decisions_log). Read-only. */
export function proposals(): any {
  return readJSON<any>(CONFIG.PROPOSALS, { proposals: [], decisions_log: [] });
}

/** The current CONTENT defaults + promotion policy (content-defaults.json). Read-only. */
export function contentDefaults(): any {
  return readJSON<any>(CONFIG.CONTENT_DEFAULTS, { defaults: {}, promotion: {} });
}

// ── opening-question policy (RETAIN panel) ───────────────────────────────────

export interface LeadBandView {
  band: string;
  label: string;
  n: number;
  median: number | null;
  ci_lo: number | null;
  ci_hi: number | null;
  advantage: number | null;
  passes: boolean;
  reason: string;
  share: number;
}
export interface LeadPolicyView {
  present: boolean;
  applied: boolean;
  updated_at: string | null;
  run_id: string | null;
  n_posts: number;
  min_posts: number;
  note: string;
  evidence_source: string;
  bands: LeadBandView[];
  history: Array<{ at: string; run_id: string; shares: Record<string, number>; applied: boolean; note: string }>;
}

/**
 * The opening-question policy, resolved for display. A pure read of
 * ab-testing/lead-policy.json — the dashboard never computes the policy and never
 * changes it; that is the cycle's job (hermes/src/leadPromotion.ts), on the loop's
 * own schedule. Degrades to "not run yet" rather than inventing a mix.
 */
export function leadPolicy(): LeadPolicyView {
  const led = readJSON<any>(CONFIG.LEAD_POLICY, null);
  const p = led?.policy;
  if (!p || !Array.isArray(p.bands)) {
    return {
      present: false, applied: false, updated_at: null, run_id: null, n_posts: 0,
      min_posts: 12, note: "The opening-question policy has not run yet.",
      evidence_source: "", bands: [], history: [],
    };
  }
  return {
    present: true,
    applied: !!p.applied,
    updated_at: led.updated_at ?? null,
    run_id: led.run_id ?? null,
    n_posts: Number(p.n_posts) || 0,
    min_posts: Number(p.min_posts) || 12,
    note: String(p.note ?? ""),
    evidence_source: String(led.evidence_source ?? ""),
    bands: p.bands.map((b: any) => ({
      band: String(b.band), label: String(b.label), n: Number(b.n) || 0,
      median: b.median ?? null, ci_lo: b.ci_lo ?? null, ci_hi: b.ci_hi ?? null,
      advantage: b.advantage ?? null, passes: !!b.passes, reason: String(b.reason ?? ""),
      share: Number(b.share) || 0,
    })),
    history: Array.isArray(led.history) ? led.history.slice(-8).reverse() : [],
  };
}

// ── winner replication (REPLICATE panel) ─────────────────────────────────────

/** Hard ceiling on the batch share replication may take (mirrors replicate.py). */
export const REPLICATION_HARD_CAP = 0.5;

export interface ReplicationView {
  enabled: boolean;
  active: boolean;
  key: string | null;
  fingerprint: any | null;
  /** clamped share of each batch the winning style currently takes */
  share: number;
  share_cap: number;
  round: number | null;
  status: string | null;
  confidence: string | null;
  opened_at: string | null;
  evaluate_after: string | null;
  vary_only: string[];
  evidence: any | null;
  replicas: any[];
  history: any[];
  updated_at: string | null;
}

/**
 * The replication ledger, resolved for display. Pure read of replication.json +
 * the policy block in content-defaults.json — the dashboard never runs the detector
 * (that is replicate.py's job, on the loop's schedule) and never opens or closes a
 * round. The share is clamped here as well as in the engine so the panel can never
 * advertise a share above the exploration cap, whatever is on disk.
 */
export function replication(): ReplicationView {
  return resolveReplicationView(readJSON<any>(CONFIG.REPLICATION, null), readJSON<any>(CONFIG.CONTENT_DEFAULTS, {}));
}

/** Pure core of `replication()` — ledger + defaults in, display view out. */
export function resolveReplicationView(led: any, cd: any): ReplicationView {
  const pol = cd && typeof cd.replication === "object" && cd.replication ? cd.replication : {};
  const enabled = typeof pol.enabled === "boolean" ? pol.enabled : true;
  const cap = Math.max(0, Math.min(REPLICATION_HARD_CAP,
    typeof pol.winner_share_cap === "number" ? pol.winner_share_cap : REPLICATION_HARD_CAP));
  const a = led && typeof led.active === "object" ? led.active : null;
  const open = !!a && (a.status === "active" || a.status === "escalated");
  const share = open ? Math.max(0, Math.min(Number(a.share) || 0, Number(a.share_cap) || cap, cap)) : 0;
  return {
    enabled,
    active: enabled && open && share > 0,
    key: a?.key ?? null,
    fingerprint: a?.fingerprint ?? null,
    share,
    share_cap: cap,
    round: a?.round ?? null,
    status: a?.status ?? null,
    confidence: a?.confidence ?? null,
    opened_at: a?.opened_at ?? null,
    evaluate_after: a?.evaluate_after ?? null,
    vary_only: Array.isArray(a?.vary_only) ? a.vary_only : [],
    evidence: a?.evidence ?? null,
    replicas: Array.isArray(a?.replicas) ? a.replicas : [],
    history: Array.isArray(led?.history) ? led.history.slice(-10).reverse() : [],
    updated_at: led?.updated_at ?? null,
  };
}

// ── per-run structured log stream (JSONL) ─────────────────────────────────────

export function runLog(runId: string, maxLines = 400): any[] {
  if (!runId || /[\\/]/.test(runId)) return [];
  const path = `${CONFIG.RUNS_DIR}/${runId}.log`;
  if (!existsSync(path)) return [];
  try {
    const lines = readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
    return lines.slice(-maxLines).map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return { ts: "", level: "raw", msg: l };
      }
    });
  } catch {
    return [];
  }
}

// ── bank freshness (matches hermes/src/questions.ts semantics) ───────────────

export interface BankStats {
  total: number;
  usable: number;
  fresh: number;
  used: number;
}

/** Renderable kinds the self-contained composition can produce (see questions.ts). */
const RENDERABLE_KINDS = new Set(["text", "numseries"]);

export function bankStats(): BankStats {
  try {
    const raw = readJSON<{ entries?: any[] }>(CONFIG.BANK, {});
    const entries = Array.isArray(raw.entries) ? raw.entries : [];
    const used = loadUsedSigs();
    let usable = 0;
    let fresh = 0;
    for (const e of entries) {
      if (e && RENDERABLE_KINDS.has(e.kind)) {
        usable++;
        if (e.sig && !used.has(e.sig)) fresh++;
      }
    }
    return { total: entries.length, usable, fresh, used: used.size };
  } catch {
    return { total: 0, usable: 0, fresh: 0, used: 0 };
  }
}

/**
 * The TRUE used-question set, reconciled across EVERY durable record of a consumed
 * question — not just the (partly-lost) usage ledger. Unions, in order:
 *   1. content/ab-test-usage.json      — the primary usage ledger. It UNDER-counts:
 *      it was lost when the prior box was terminated and only partly rebuilt.
 *   2. hermes-used-sigs.json           — the loop's own dedup set.
 *   3. every run-state video's questions[].sig (RUNS_DIR) — the recovered
 *      post-recovery run-state, the authoritative record of what each drafted /
 *      rendered / posted video actually consumed. This back-fills sigs the lost
 *      ledger dropped and SELF-HEALS as new cycles write exact per-video sigs.
 *   4. ab-database posts carrying explicit question sigs (future-proof; today's
 *      records store question_types/tiers, NOT sigs, so this contributes 0 now —
 *      The scheduler never stores our internal sigs, so posted history can't be
 *      sig-reconciled beyond what the run-state already captured).
 * Reconciling HERE keeps "fresh"/"runway" honest without mutating any pipeline
 * data file (the dashboard stays strictly read-only). Residual uncertainty: any
 * pre-recovery video whose exact sigs were never recorded is unrecoverable, so
 * "used" is a floor and "fresh"/"runway" an upper bound — see the BANK panel note.
 */
function loadUsedSigs(): Set<string> {
  const used = new Set<string>();
  const usage = readJSON<{ videos?: Array<{ questions?: Array<{ sig?: string }> }> }>(CONFIG.USAGE, {});
  for (const v of usage.videos ?? []) for (const q of v.questions ?? []) if (q.sig) used.add(q.sig);
  const hermes = readJSON<{ sigs?: string[] }>(CONFIG.HERMES_USED, {});
  for (const s of hermes.sigs ?? []) used.add(s);
  // Recovered run-state: each video's questions carry the exact bank sig it used.
  for (const r of runSummaries(500)) {
    for (const v of r.videos ?? []) for (const q of v.questions ?? []) if (q?.sig) used.add(q.sig);
  }
  // ab-database posts that recorded explicit sigs (0 today; self-heals if added).
  const posts: any[] = Array.isArray(abDb()?.posts) ? abDb().posts : [];
  for (const p of posts) {
    const cand: unknown[] = Array.isArray(p?.variant?.question_sigs) ? p.variant.question_sigs
      : Array.isArray(p?.question_sigs) ? p.question_sigs
      : Array.isArray(p?.questions) ? p.questions.map((q: any) => q?.sig)
      : [];
    for (const s of cand) if (s) used.add(String(s));
  }
  return used;
}

// ── question-bank COVERAGE + days-of-runway ──────────────────────────────────

export interface TypeCoverage {
  tier: string; // the question TYPE (ODD ONE OUT / VERBAL ANALOGY / NUMBER SERIES / …)
  usable: number;
  fresh: number;
}

export interface BankCoverage extends BankStats {
  /** fresh as a percentage of usable (0–100). */
  freshPct: number;
  /** estimated questions consumed per day (VIDEOS_PER_DAY × AVG_Q_PER_VIDEO). */
  perDay: number;
  /** estimated days until the fresh usable pool runs out, or null if perDay ≤ 0. */
  runwayDays: number | null;
  /** per-TYPE coverage (only the headless-renderable kinds), most-fresh first. */
  byType: TypeCoverage[];
}

/**
 * Pure coverage projection over bank entries + the used-sig set. Only the
 * headless-renderable kinds (text/numseries) count as usable (matches
 * questions.ts). Split out so it is unit-testable without touching disk.
 */
export function computeBankCoverage(entries: any[], used: Set<string>, perDay: number): BankCoverage {
  const list = Array.isArray(entries) ? entries : [];
  const byTierU: Record<string, number> = {};
  const byTierF: Record<string, number> = {};
  let usable = 0;
  let fresh = 0;
  for (const e of list) {
    if (!e || !RENDERABLE_KINDS.has(e.kind)) continue;
    const tier = String(e.tier ?? "(untyped)");
    usable++;
    byTierU[tier] = (byTierU[tier] ?? 0) + 1;
    if (e.sig && !used.has(e.sig)) {
      fresh++;
      byTierF[tier] = (byTierF[tier] ?? 0) + 1;
    }
  }
  const byType: TypeCoverage[] = Object.keys(byTierU)
    .map((tier) => ({ tier, usable: byTierU[tier], fresh: byTierF[tier] ?? 0 }))
    .sort((a, b) => b.fresh - a.fresh || a.tier.localeCompare(b.tier));
  return {
    total: list.length,
    usable,
    fresh,
    used: used.size,
    freshPct: usable > 0 ? Math.round((fresh / usable) * 1000) / 10 : 0,
    perDay,
    runwayDays: perDay > 0 ? Math.floor(fresh / perDay) : null,
    byType,
  };
}

export function bankCoverage(): BankCoverage {
  try {
    const raw = readJSON<{ entries?: any[] }>(CONFIG.BANK, {});
    const entries = Array.isArray(raw.entries) ? raw.entries : [];
    const perDay = Math.max(0, CONFIG.VIDEOS_PER_DAY * CONFIG.AVG_Q_PER_VIDEO);
    return computeBankCoverage(entries, loadUsedSigs(), perDay);
  } catch {
    return { total: 0, usable: 0, fresh: 0, used: 0, freshPct: 0, perDay: 0, runwayDays: null, byType: [] };
  }
}

// ── cost-governor SPEND snapshot (read-only) ─────────────────────────────────

/** The cost-governor snapshot.json (cost_governor.snapshot() shape) or null. */
export function costSnapshot(): any {
  return readJSON<any>(CONFIG.COST_SNAPSHOT, null);
}

/** The always-on software-factory daemon status (factory-status.json) or null. */
export function factoryStatus(): any {
  return readJSON<any>(CONFIG.FACTORY_STATUS, null);
}

/** The always-on continuous SUPERVISOR status (supervisor-status.json) or null. */
export function supervisorStatus(): any {
  return readJSON<any>(CONFIG.SUPERVISOR_STATUS, null);
}

// ── GOAL-PROGRESS (Hermes's 7-day mandate) ───────────────────────────────────

export interface KickoffState {
  /** true iff the KICKOFF file exists AND its content contains the arm phrase. */
  armed: boolean;
  /** t0 (ISO) = the KICKOFF file's mtime when armed, else null. */
  since: string | null;
}

/**
 * Read the box-only KICKOFF file: armed iff it EXISTS and its CONTENT contains the
 * exact arm phrase; t0 = its mtime. READ-ONLY — the dashboard never writes/arms it
 * (arming is a human/box action). Degrades to "pending" on any error.
 */
export function kickoffState(): KickoffState {
  try {
    const path = CONFIG.KICKOFF_FILE;
    if (!path || !existsSync(path)) return { armed: false, since: null };
    const content = readFileSync(path, "utf8");
    if (!content.includes(CONFIG.KICKOFF_PHRASE)) return { armed: false, since: null };
    return { armed: true, since: statSync(path).mtime.toISOString() };
  } catch {
    return { armed: false, since: null };
  }
}

/**
 * Optional per-platform follower snapshot (account-metrics.json), shape
 * {instagram:{followers:N}, tiktok:{followers:N}}. null when absent ⇒ followers
 * render as "pending" (never 0/fake).
 */
export function accountFollowers(): FollowerSnapshot | null {
  return readJSON<FollowerSnapshot | null>(CONFIG.ACCOUNT_METRICS, null);
}

/**
 * The LIVE analytics snapshot the loop rewrites every cycle, or null when it has not
 * been written yet. Its `rows` are the source of the goal panel's view totals.
 */
export function liveAnalyticsRows(): LiveAnalyticsRow[] | null {
  const snap = readJSON<{ rows?: LiveAnalyticsRow[] } | null>(CONFIG.ANALYTICS_SNAPSHOT, null);
  return Array.isArray(snap?.rows) && snap.rows.length ? snap.rows : null;
}

/**
 * Live GOAL-PROGRESS against the mandate.
 *
 * View TOTALS come from the analytics snapshot; the ab-database supplies the per-arm
 * attribution and is the fallback when no snapshot exists. Before this split the panel
 * summed the ab-database join and reported 9,500 views over 28 Instagram posts on a
 * day the API said 39,382 over 101 across three networks.
 */
export function goalProgress(): GoalProgress {
  const posts = Array.isArray(abDb()?.posts) ? abDb().posts : [];
  const k = kickoffState();
  return computeGoalProgress(
    posts,
    goalWindowStart(k.since),
    accountFollowers(),
    new Date(),
    liveAnalyticsRows(),
    k.since,
  );
}

// ── kill-switch (DISPLAY-ONLY) ────────────────────────────────────────────────

export interface KillSwitchState {
  engaged: boolean;
  sources: string[]; // human-readable reasons it's engaged (env var / file path)
}

/** Pure evaluator (injectable for tests): env truthiness OR a present stop-file. */
export function evaluateKillSwitch(
  envVarNames: readonly string[],
  env: Record<string, string | undefined>,
  files: string[],
  fileExists: (p: string) => boolean,
): KillSwitchState {
  const sources: string[] = [];
  const truthy = (v: string | undefined) => !!v && ["1", "true", "yes", "on"].includes(v.trim().toLowerCase());
  for (const name of envVarNames) {
    if (truthy(env[name])) sources.push(`env ${name}`);
  }
  for (const f of files) {
    if (f && fileExists(f)) sources.push(`stop-file ${f}`);
  }
  return { engaged: sources.length > 0, sources };
}

export function killSwitch(): KillSwitchState {
  return evaluateKillSwitch(CONFIG.KILL_ENV_VARS, process.env, CONFIG.KILL_FILES, existsSync);
}

// ── cycle schedule (last run + next scheduled) ───────────────────────────────

export interface Schedule {
  last: { run_id?: string; status?: string; at?: string; drafted?: number } | null;
  next: string;
  nextSource: "systemd" | "estimated" | "unknown";
}

function systemdNext(): string | null {
  try {
    const out = execFileSyncSafe("systemctl", [
      "show",
      CONFIG.TIMER_UNIT,
      "--property=NextElapseUSecRealtime",
      "--no-pager",
    ]);
    if (!out) return null;
    const m = out.match(/NextElapseUSecRealtime=(.+)/);
    const v = (m?.[1] || "").trim();
    return v && v !== "n/a" && v !== "0" ? v : null;
  } catch {
    return null;
  }
}

export function cycleSchedule(latest: RunState | null): Schedule {
  const last = latest
    ? {
        run_id: latest.run_id,
        status: latest.status,
        at: latest.finished_at || latest.updated_at || latest.started_at,
        drafted: latest.summary?.drafted ?? 0,
      }
    : null;

  const sysNext = systemdNext();
  if (sysNext) return { last, next: sysNext, nextSource: "systemd" };

  // No live timer queryable ⇒ estimate from the last run + cadence.
  const base = last?.at ? Date.parse(last.at) : NaN;
  if (!Number.isNaN(base)) {
    const next = new Date(base + CONFIG.CADENCE_HOURS * 3600 * 1000);
    return { last, next: `${next.toISOString()} (est. +${CONFIG.CADENCE_HOURS}h)`, nextSource: "estimated" };
  }
  return { last, next: "unknown (no run yet / no timer)", nextSource: "unknown" };
}

// ── host health ───────────────────────────────────────────────────────────────

export function diskInfo(): string {
  try {
    const out = execFileSyncSafe("df", ["-h", "/"]);
    const line = (out || "").trim().split("\n").pop() || "";
    const c = line.split(/\s+/);
    return c.length >= 5 ? `${c[2]} used / ${c[1]} (${c[4]})` : "n/a";
  } catch {
    return "n/a";
  }
}

export interface LlmHealth {
  ok: boolean;
  configured: boolean;
  model: string;
  detail?: string;
}

/** Best-effort LLM gateway reachability. Never spends tokens (GET /models). */
export async function llmPing(): Promise<LlmHealth> {
  if (!CONFIG.TFY_API_KEY) {
    return { ok: false, configured: false, model: CONFIG.MODEL, detail: "no API key configured" };
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 4000);
  try {
    const res = await fetch(`${CONFIG.TFY_BASE_URL.replace(/\/$/, "")}/models`, {
      method: "GET",
      headers: { authorization: `Bearer ${CONFIG.TFY_API_KEY}` },
      signal: ctrl.signal,
    });
    return {
      ok: res.ok,
      configured: true,
      model: CONFIG.MODEL,
      detail: res.ok ? "gateway reachable" : `gateway HTTP ${res.status}`,
    };
  } catch (e) {
    return { ok: false, configured: true, model: CONFIG.MODEL, detail: `unreachable: ${e instanceof Error ? e.message : String(e)}` };
  } finally {
    clearTimeout(t);
  }
}

// ── tiny helper: synchronous execFile with a hard timeout, never throws upward ─
// Uses execFile* (never a shell) so there is no shell-injection surface; on any
// error (command missing, timeout, non-zero exit) it degrades to "".
function execFileSyncSafe(cmd: string, args: string[]): string {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", timeout: 4000, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return "";
  }
}

/**
 * PUBLIC Metricool CDN allowlist — the single validator that decides whether a URL
 * may appear in a public response. Metricool rehosts our media at schedule time onto
 * static.metricool.com, which is genuinely public: verified live, it serves the asset
 * with no Referer, with a hostile Referer, and with a foreign Origin (HTTP 200 every
 * way). It therefore needs NO server-side proxy and the <video> points straight at it.
 *
 * The same structural exclusion still applies: an S3 PRESIGNED url lives on
 * *.amazonaws.com and always carries X-Amz-* query params, so requiring an exact
 * host and no query string means a signed URL can never pass.
 */
export function publicMetricoolCdnUrl(u: unknown): string | null {
  if (typeof u !== "string" || !u) return null;
  let parsed: URL;
  try {
    parsed = new URL(u);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  if (parsed.hostname !== "static.metricool.com") return null;
  if (parsed.username || parsed.password) return null;
  if (parsed.search || parsed.hash) return null;
  if (/x-amz-|amazonaws\.com|credential=|signature=|security-token/i.test(u)) return null;
  return parsed.href;
}

/** First meaningful caption line (drops the showcase tag + trailing hashtags). */
export function draftHook(text: string): string {
  const t = String(text || "").replace(/\[hermes-nous showcase\]/i, "").trim();
  const line = t.split("\n").map((s) => s.trim()).filter(Boolean)[0] || t;
  const cleaned = line.replace(/#\S+/g, "").replace(/\s+/g, " ").trim();
  return cleaned.slice(0, 160) || "(no caption)";
}

/** One resolved A/B variant for a live post (from RunState or ab-database). */
export interface VariantHit {
  dimension: string;
  arm: string;
  question_types: string[];
  run_id?: string;
  /** the loop's own video id (e.g. "2026-07-28-v01"), so a card can name the draft. */
  video_id?: string;
  source: "run" | "ab-database";
}

/** Multi-key index so a live post links to its arm by planner uuid → numeric id → caption. */
export interface VariantIndex {
  byId: Map<string, VariantHit>;
  byMedia: Map<string, VariantHit>;
  byCaption: Map<string, VariantHit | null>; // null = AMBIGUOUS (same caption, different arms) → never used
}

/** Normalize a caption for a reliable text join (collapse whitespace, trim, lowercase). */
export function normCaption(text: string): string {
  return String(text || "").replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Canonical string key for a Metricool id.
 *
 * A planner uuid is a SIGNED 64-BIT INTEGER carried as TEXT, and it can be NEGATIVE, so
 * it must never pass through a JS number: 8357829085189587553 round-tripped as a double
 * comes back 8357829085189587000, and the join would silently miss on every post. This
 * keeps ids as text, and REFUSES a value that arrives as a number outside the safe-integer
 * range — such a value has already lost digits, so matching on it would be a coincidence
 * rather than a join, and this file must never guess.
 */
export function idKey(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) return ""; // precision already gone — refuse to key on it
    return String(v);
  }
  const s = String(v).trim();
  return /^-?\d{1,25}$/.test(s) ? s : "";
}

/** Add a caption→variant entry, collapsing collisions (same caption, DIFFERENT arm) to
 *  null so an ambiguous caption is NEVER used to fabricate an arm. */
function addCaptionKey(byCaption: Map<string, VariantHit | null>, cap: string, hit: VariantHit): void {
  if (!cap) return;
  if (byCaption.has(cap)) {
    const prev = byCaption.get(cap);
    if (prev && (prev.dimension !== hit.dimension || prev.arm !== hit.arm)) byCaption.set(cap, null);
  } else {
    byCaption.set(cap, hit);
  }
}

/**
 * Index every known post → its A/B variant, from RunState + ab-database.
 *
 * `runs` / `dbPosts` are injectable so the regression suite can drive the REAL index and
 * the REAL projection off realistic rows instead of asserting on a helper in isolation —
 * which is how this join stayed broken through a green suite once already.
 */
export function buildVariantMap(runs?: RunState[], dbPosts?: any[]): VariantIndex {
  const byId = new Map<string, VariantHit>();
  const byMedia = new Map<string, VariantHit>();
  const byCaption = new Map<string, VariantHit | null>();
  for (const r of runs ?? runSummaries(50)) {
    for (const v of r.videos || []) {
      const tiers = (v.questions || []).map((q) => q.tier).filter((t): t is string => !!t);
      const hit: VariantHit = {
        dimension: v.dimension || "\u2014", arm: v.arm || "\u2014", question_types: tiers,
        run_id: r.run_id, video_id: v.id, source: "run",
      };
      for (const id of v.metricool?.uuids || []) {
        const k = idKey(id);
        if (k) byId.set(k, hit);
      }
      const mediaId = idKey(v.metricool?.media_id);
      if (mediaId && !byMedia.has(mediaId)) byMedia.set(mediaId, hit);
      addCaptionKey(byCaption, normCaption(v.caption), hit);
    }
  }
  // ab-database.json (published posts) — fills any id/caption the runs don't have.
  const posts: any[] = dbPosts ?? (Array.isArray(abDb()?.posts) ? abDb().posts : []);
  for (const p of posts) {
    const va = p.variant || {};
    const qt = Array.isArray(va.question_types) ? va.question_types.map((x: unknown) => String(x)) : [];
    const hit: VariantHit = {
      dimension: va.family || p.experiment?.dimension || "\u2014",
      arm: va.arm || va.hook || p.experiment?.arm || "\u2014",
      question_types: qt,
      video_id: typeof p.video_id === "string" ? p.video_id : undefined,
      source: "ab-database",
    };
    const id = idKey(p?.metricool_uuid);
    if (id && !byId.has(id)) byId.set(id, hit);
    addCaptionKey(byCaption, normCaption(p.caption || p.text), hit);
  }
  return { byId, byMedia, byCaption };
}

/**
 * Resolve a live post to its A/B variant, most-precise first. Returns null when nothing
 * matches, and the card then shows a neutral "unknown" — NEVER a guess, and never the
 * caption opener (caption-inference was removed on purpose and must not come back).
 *
 * WHY THE UUID IS PROBED FIRST, and why this regressed.
 * Metricool splits post identity in two: `uuid` is stable, while the numeric `id` is
 * REASSIGNED on every update. The loop persists the uuid into run-state at schedule time,
 * so the uuid is the key the index is actually built on. Publer had a single `id`, so the
 * pre-migration resolver probed `p.id` — and after the cutover that probe started asking
 * the uuid-keyed map for a numeric id, missed every time, and every fresh post fell
 * through to "unknown".
 */
export function resolvePostVariant(p: any, idx: VariantIndex): VariantHit | null {
  const uuidKey = idKey(p?.uuid);
  if (uuidKey) {
    const hit = idx.byId.get(uuidKey);
    if (hit) return hit;
  }
  // The current numeric id, against the id run-state recorded when the post was created.
  // Weaker (it moves on edit) but still an EXACT match, so it is a join and not a guess.
  const numKey = idKey(p?.id);
  if (numKey) {
    const hit = idx.byId.get(numKey) || idx.byMedia.get(numKey);
    if (hit) return hit;
  }
  // An explicit media id, for rows that carry media objects rather than bare CDN urls.
  const m0 = p && Array.isArray(p.media) ? p.media[0] : null;
  const mediaKey = idKey(m0 && typeof m0 === "object" ? (m0 as { id?: unknown }).id : null);
  if (mediaKey) {
    const hit = idx.byMedia.get(mediaKey);
    if (hit) return hit;
  }
  // Full caption, ONLY when collision-free: an ambiguous caption is stored as null above
  // and deliberately falls through to unknown rather than picking one of two arms.
  const cap = normCaption(p?.text);
  if (cap) {
    const byCap = idx.byCaption.get(cap);
    if (byCap) return byCap;
  }
  return null;
}

/** Spawn a READ-ONLY bridge subprocess and parse its single JSON stdout line. */
function runReadBridge(sub: string, params: Record<string, unknown>, timeoutMs: number, script: string = CONFIG.METRICOOL_READ_BRIDGE): Promise<any> {
  return new Promise((resolvePromise) => {
    let done = false;
    let stdout = "";
    let stderr = "";
    const finish = (v: any): void => {
      if (!done) {
        done = true;
        resolvePromise(v);
      }
    };
    let child;
    try {
      child = spawn(process.execPath, [script, sub], {
        cwd: CONFIG.REPO_DIR,
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) {
      return finish({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      finish({ ok: false, error: "bridge timeout" });
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      finish({ ok: false, error: e instanceof Error ? e.message : String(e) });
    });
    child.on("close", () => {
      clearTimeout(timer);
      const line = stdout.trim().split("\n").filter(Boolean).pop() || "";
      try {
        finish(JSON.parse(line));
      } catch {
        finish({ ok: false, error: (stderr.trim() || "unparseable bridge output").slice(0, 200) });
      }
    });
    try {
      child.stdin.write(JSON.stringify(params));
      child.stdin.end();
    } catch {
      /* the close/error handler will resolve */
    }
  });
}

// ── SCHEDULED posts (post-KICKOFF) — mirrored LIVE from Metricool ─────────────
// Once autonomy is ARMED, the loop AUTO-SCHEDULES each new draft on Metricool at a
// jittered time inside the 7am-1am CST window (scheduler.ts / loopPublish.ts).
// This surfaces those scheduled posts + their times on the dashboard, read LIVE
// from Metricool via a READ-ONLY bridge — so the dashboard and the Metricool planner
// show the SAME posts at the SAME times BY CONSTRUCTION. Read-only: nothing here
// schedules or mutates; it only lists what is already on the board.
export interface ScheduledPost {
  /**
   * True while the post is still a loop draft that the human has not cleared to
   * publish (Metricool `draft: true, autoPublish: false`). The projection below
   * always assigns it, so an absent value means the projection was skipped rather
   * than that the post is approved.
   */
  awaiting_approval?: boolean;
  post_id: string; // Metricool uuid (STABLE; the numeric id is reassigned on update)
  platform: string; // "instagram" | "tiktok"
  scheduled_at: string; // ISO (UTC) — the source-of-truth publication instant
  scheduled_cst: string; // same instant formatted in America/Chicago (what the human tracks)
  hook: string; // caption first line
  dimension: string; // A/B dimension (from run/ab-database) or "unknown" (no match)
  arm: string; // A/B arm (from run/ab-database) or "unknown" (no match — NEVER the caption opener)
  arm_source: "run" | "ab-database" | "inferred";
  video_key: string; // stable key for the inline preview
  thumbnail: string | null; // validated PUBLIC CDN poster image (or null)
  media_url: string | null; // validated PUBLIC static.metricool.com mp4 (or null)
  /** PENDING until Metricool publishes it, then PUBLISHED. */
  status: string;
  /** Live permalink once published (providers[].publicUrl), else null. */
  public_url: string | null;
  /** Opening arm under test: "cold-plate" | "motion-hook" | "" when not ours. */
  opening: string;
  /** Our own video id from the posting ledger, e.g. "2026-07-27-r03". */
  video_id: string;
  /**
   * Published on a treatment we have since replaced, so it is NOT a data point for the
   * running experiment. Four hook reels went out on the old tilted opening before the
   * square one replaced it; averaging them in would compare two different designs.
   */
  excluded: boolean;
  /**
   * 3-second skip rate for a PUBLISHED reel. null means NOT YET SYNCED rather than
   * zero — Metricool's analytics land on a nightly cycle up to ~24h behind, and
   * rendering a fresh post as 0% would read as a perfect hook.
   */
  skip_rate: number | null;
}

/** Roll-up of the running opening-arm experiment, for the dashboard header. */
export interface ExperimentView {
  target: number;
  /** USABLE hook reels — excludes any that ran a superseded treatment. */
  hook_scheduled: number;
  /** Hook reels published on the old opening and deliberately not counted. */
  hook_excluded: number;
  hook_posted: number;
  control_scheduled: number;
  control_posted: number;
  hook_with_data: number;
  hook_median_skip: number | null;
  control_median_skip: number | null;
  on_track: boolean;
}
export interface ScheduledView {
  /** Loop-generated drafts a human has not yet approved. Nothing ships until this is 0. */
  awaiting_approval?: number;
  ok: boolean;
  posts: ScheduledPost[];
  count: number;
  by_platform: Record<string, number>;
  by_status: Record<string, number>;
  experiment: ExperimentView;
  /** The lever the view target actually depends on. Absent when analytics failed. */
  skip?: SkipRateHeadline;
  source: string;
  as_of: string;
  error?: string;
}

// ── SKIP RATE: the headline number ────────────────────────────────────────────
/**
 * The 3-second skip rate the goal requires, in percent.
 *
 * 200,000 views is the target; skip rate is the only measured lever that can reach it,
 * so this is the number the operator is actually steering. Against 126 live Instagram
 * reels (2026-07-20..2026-08-03) skip rate predicts reach at Spearman -0.709, monotonic
 * across all eight buckets with a 10.7x spread from best to worst:
 *
 *     <50%  median reach 1305        65-70%  median reach 157
 *     50-55%             1058        70-75%              145
 *     55-60%              849        75-80%              131
 *     60-65%              296        80%+                123
 *
 * The account medians ~70% and therefore lives in the 145 band. The 50-55% band medians
 * 1,058 reach, which is the band where the target stops being arithmetic fiction — so
 * 55 is the wall, not a preference. A view counter cannot be acted on; this can.
 */
export const SKIP_TARGET_PCT = 55;
/** Days of published reels the headline median is taken over. */
export const SKIP_WINDOW_DAYS = 7;

// ── WHAT A BAND IS WORTH IN VIEWS ─────────────────────────────────────────────
/**
 * A skip-rate band and the combined views it projects over one full goal window at
 * the current cadence. This is what lets the panel state the view target and the
 * thing that moves it in the same breath, instead of showing a number with no lever
 * attached.
 *
 * COARSE ON PURPOSE. The projections descend from bucketed reach medians, so the
 * honest unit is a band, not a point. "52.4% earns 203,000" would be precision this
 * data does not have; "land in 50-55% and the target is reachable" is what it
 * supports. `to` is therefore the number that matters operationally — it is the
 * threshold a median has to get UNDER to be in the band.
 *
 * NOT A PARTITION. 60-70% has no row: these are the bands that were actually
 * projected, not a fitted curve over the whole range, and inventing the missing
 * rows would be inventing data.
 */
export interface SkipBandProjection {
  /** inclusive lower bound in percent; null = open below ("under 50%"). */
  from: number | null;
  /** the threshold a median must get under to be in this band, in percent. */
  to: number;
  /** how the band is written on the page. */
  label: string;
  /** combined views this band projects over one full window. */
  projectedViews: number;
  /** stated inline when the band's sample is thin enough that a reader should know. */
  caveat?: string;
}

/**
 * The measured band -> window-views projections, best band first.
 *
 * Recorded 2026-08-03 against the same 126 live reels as the reach table above, at
 * 11 posts per network per day over a 14-day window. The status-quo row is what the
 * account was actually doing when the target was set.
 */
export const SKIP_VIEW_PROJECTIONS: readonly SkipBandProjection[] = Object.freeze([
  { from: null, to: 50, label: "under 50%", projectedViews: 274_000, caveat: "best ever, n=2" },
  { from: 50, to: 55, label: "50–55%", projectedViews: 215_000 },
  { from: 55, to: 60, label: "55–60%", projectedViews: 181_000 },
  { from: 65, to: 75, label: "~70%", projectedViews: 31_000, caveat: "status quo" },
]);

/**
 * The least demanding measured band that still reaches `targetViews`.
 *
 * NULL MEANS THE TARGET IS NOT REACHABLE from anything this account has measured —
 * which is not an error case, it is the single most useful thing this function can
 * say. 500,000 returned null against every band, and that is why the target is now
 * 200,000. A panel that renders null as "no measured band reaches this" is telling
 * the truth; one that clamps to the best band is not.
 */
export function requiredSkipBand(
  targetViews: number,
  bands: readonly SkipBandProjection[] = SKIP_VIEW_PROJECTIONS,
): SkipBandProjection | null {
  const reaching = bands.filter((b) => b.projectedViews >= targetViews);
  if (reaching.length === 0) return null;
  // Least demanding = smallest projection that still clears the bar, i.e. the band
  // requiring the smallest improvement rather than the best band on the table.
  return reaching.reduce((a, b) => (b.projectedViews < a.projectedViews ? b : a));
}

export interface SkipRateHeadline {
  /** median skip % over the last SKIP_WINDOW_DAYS; null when nothing has matured. */
  median: number | null;
  n: number;
  /** the same median over the window BEFORE it — the trend comparator. */
  priorMedian: number | null;
  priorN: number;
  /** signed change vs the prior window; negative is improvement. null when either is null. */
  delta: number | null;
  /** the threshold the mandate requires. */
  threshold: number;
  windowDays: number;
  /** true when the current median is at or under the threshold. */
  meetingTarget: boolean;
  /** what that skip rate is currently buying, same window. */
  medianReach: number | null;
  medianViews: number | null;
}

/** A reel row as the read-only analytics bridge emits it. */
export interface AnalyticsReel {
  publishedAt?: { dateTime?: string; timezone?: string } | string | null;
  reach?: number | null;
  views?: number | null;
  skipRate?: number | null;
}

/** Metricool reports publishedAt as a naive local time plus a separate zone. */
function reelPublishedMs(pa: AnalyticsReel["publishedAt"]): number {
  if (!pa) return NaN;
  if (typeof pa === "string") return Date.parse(pa);
  const dt = pa.dateTime;
  if (!dt) return NaN;
  return Date.parse(chicagoNaiveToISO(dt, pa.timezone || "UTC"));
}

/**
 * The headline skip-rate reading: current median vs the threshold, plus the trend.
 *
 * Pure, so the suite can drive it with fixed rows and a fixed clock. Reels with no skip
 * rate are EXCLUDED rather than counted as zero — Metricool syncs analytics up to ~24h
 * behind, and a pending reel scored as 0% would read as a perfect hook.
 */
export function summarizeSkipRate(
  reels: AnalyticsReel[],
  now: Date = new Date(),
  windowDays: number = SKIP_WINDOW_DAYS,
  threshold: number = SKIP_TARGET_PCT,
): SkipRateHeadline {
  const nowMs = now.getTime();
  const win = windowDays * 864e5;
  const dated = (Array.isArray(reels) ? reels : [])
    .filter((r) => typeof r?.skipRate === "number")
    .map((r) => ({ ms: reelPublishedMs(r.publishedAt), skip: r.skipRate as number, reach: r.reach, views: r.views }))
    .filter((r) => Number.isFinite(r.ms));
  const cur = dated.filter((r) => r.ms >= nowMs - win);
  const prior = dated.filter((r) => r.ms >= nowMs - 2 * win && r.ms < nowMs - win);
  const nums = (xs: (number | null | undefined)[]) => xs.filter((v): v is number => typeof v === "number");
  const median_ = median(cur.map((r) => r.skip));
  const priorMedian = median(prior.map((r) => r.skip));
  return {
    median: median_,
    n: cur.length,
    priorMedian,
    priorN: prior.length,
    delta: median_ != null && priorMedian != null ? Math.round((median_ - priorMedian) * 10) / 10 : null,
    threshold,
    windowDays,
    meetingTarget: median_ != null && median_ <= threshold,
    medianReach: median(nums(cur.map((r) => r.reach))),
    medianViews: median(nums(cur.map((r) => r.views))),
  };
}

/** Format a UTC instant in America/Chicago (DST-correct) — e.g. "Fri Jul 24, 9:39 AM CDT". */
function formatChicago(iso: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Chicago", weekday: "short", month: "short", day: "numeric",
      hour: "numeric", minute: "2-digit", hour12: true, timeZoneName: "short",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

/**
 * Resolve a SCHEDULED post's validated PUBLIC-CDN asset URL by video_key + kind.
 * static.metricool.com is genuinely public, so the panel plays it directly — there is
 * no server-side media proxy any more, and this stays the single allowlist choke point.
 */
export function resolveScheduledMediaUrl(view: ScheduledView | null, videoKey: string, kind: "video" | "thumb"): string | null {
  if (!view || !Array.isArray(view.posts) || !videoKey) return null;
  const p = view.posts.find((x) => x.video_key === videoKey);
  if (!p) return null;
  return publicMetricoolCdnUrl(kind === "thumb" ? p.thumbnail : p.media_url);
}

/** Public choke point: force every scheduled media_url/thumbnail through the PUBLIC-CDN allowlist. */
export function sanitizeScheduledForPublic(view: ScheduledView): ScheduledView {
  for (const p of view.posts || []) {
    // Anything that is not a clean public Metricool CDN asset (notably an S3 presigned
    // url) is nulled. This is the single choke point every served view passes through.
    p.media_url = publicMetricoolCdnUrl(p.media_url);
    p.thumbnail = publicMetricoolCdnUrl(p.thumbnail);
  }
  return view;
}

let _schedCache: { at: number; view: ScheduledView } | null = null;
let _schedInflight: Promise<ScheduledView> | null = null;

/** Live SCHEDULED Metricool posts (post-kickoff), cached (TTL) + single-flight. */
export async function scheduledPosts(): Promise<ScheduledView> {
  const now = Date.now();
  if (_schedCache && now - _schedCache.at < CONFIG.DRAFTS_TTL_MS) return _schedCache.view;
  if (_schedInflight) return _schedInflight;
  _schedInflight = (async () => {
    let view: ScheduledView;
    try {
      view = await computeScheduled();
    } catch (e) {
      view = { ok: false, posts: [], count: 0, by_platform: {}, by_status: {}, experiment: summarizeExperiment([], CONFIG.HOOK_ARM_TARGET), source: "metricool (read-only bridge)", as_of: new Date().toISOString(), error: e instanceof Error ? e.message : String(e) };
    }
    if (view.ok) _schedCache = { at: Date.now(), view };
    _schedInflight = null;
    // Choke point: guarantee public-CDN-only media on EVERY served scheduled view.
    return sanitizeScheduledForPublic(view);
  })();
  return _schedInflight;
}

/** Read the controlled poster's ledger: Metricool uuid -> our video id + opening arm. */
function loadPostingLedger(): Map<string, { video_id: string; opening: string; excluded: boolean }> {
  const out = new Map<string, { video_id: string; opening: string; excluded: boolean }>();
  try {
    if (!existsSync(CONFIG.SCHEDULED_LEDGER)) return out;
    const led = JSON.parse(readFileSync(CONFIG.SCHEDULED_LEDGER, "utf8"));
    for (const rec of led?.posts ?? []) {
      if (rec?.uuid) {
        out.set(String(rec.uuid), {
          video_id: String(rec.videoId ?? ""),
          opening: String(rec.opening ?? ""),
          // Reels published on a superseded treatment. They still show on the board,
          // but they must not be counted toward the experiment.
          excluded: rec.excluded === true,
        });
      }
    }
  } catch {
    /* a missing or malformed ledger just means no arm labels */
  }
  return out;
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

/** Roll up the opening-arm experiment from the posts we can attribute. */
export function summarizeExperiment(posts: ScheduledPost[], target: number): ExperimentView {
  // USABLE only. An excluded reel ran a superseded treatment, so counting it toward the
  // target would report the experiment as further along than it is.
  const usable = posts.filter((p) => !p.excluded);
  const hook = usable.filter((p) => p.opening === "motion-hook");
  const control = usable.filter((p) => p.opening === "cold-plate");
  const posted = (xs: ScheduledPost[]) => xs.filter((p) => p.status === "PUBLISHED");
  const skips = (xs: ScheduledPost[]) => xs.map((p) => p.skip_rate).filter((v): v is number => typeof v === "number");
  const hookPosted = posted(hook);
  return {
    target,
    hook_scheduled: hook.length,
    hook_excluded: posts.filter((p) => p.excluded && p.opening === "motion-hook").length,
    hook_posted: hookPosted.length,
    control_scheduled: control.length,
    control_posted: posted(control).length,
    hook_with_data: skips(hookPosted).length,
    hook_median_skip: median(skips(hookPosted)),
    control_median_skip: median(skips(posted(control))),
    // On track when enough hook reels are already scheduled to reach the target.
    on_track: hook.length >= target,
  };
}

/** Everything the scheduled projection joins against. Injected so the regression suite
 *  can drive the REAL projection with realistic bridge rows, rather than exercising
 *  helpers in isolation — which is how a silently-unassigned field passed 80 tests. */
export interface ScheduledJoins {
  variantIdx: VariantIndex;
  ledger?: Map<string, { video_id: string; opening: string; excluded: boolean }>;
  bySkip?: Map<string, number>;
}

/**
 * THE projection: raw metricool-read bridge rows → the ScheduledPost cards everything
 * downstream renders. /api/scheduled, the scheduled panel and the approval queue all
 * come out of this one function, so a field that is wrong here is wrong everywhere —
 * which is exactly why the suite drives this rather than its parts.
 */
export function projectScheduledPosts(rows: any[], joins: ScheduledJoins): ScheduledPost[] {
  const ledger = joins.ledger ?? new Map<string, { video_id: string; opening: string; excluded: boolean }>();
  const bySkip = joins.bySkip ?? new Map<string, number>();
  const posts: ScheduledPost[] = [];
  for (const p of rows || []) {
    const dt = String(p?.dateTime || "");
    if (!dt) continue;
    const tz = String(p?.timezone || "America/Chicago");
    const iso = chicagoNaiveToISO(dt, tz);
    const provs: any[] = Array.isArray(p.providers) ? p.providers : [];
    const mine = ledger.get(String(p.uuid)) || { video_id: "", opening: "", excluded: false };
    const hit = resolvePostVariant(p, joins.variantIdx);
    // One Metricool post can carry several networks; render one card per network so a
    // per-platform status and permalink are both visible.
    for (const pr of provs.length ? provs : [{ network: "unknown", status: "PENDING", publicUrl: null }]) {
      const url = typeof pr.publicUrl === "string" ? pr.publicUrl : null;
      const skip = url && bySkip.has(url) ? (bySkip.get(url) as number) : null;
      posts.push({
        post_id: String(p.uuid || p.id),
        awaiting_approval: p.draft === true && p.auto_publish === false,
        platform: String(pr.network || "unknown"),
        scheduled_at: iso,
        scheduled_cst: formatChicago(iso),
        hook: draftHook(p.text),
        dimension: hit ? hit.dimension : (mine.opening ? "opening" : "unknown"),
        arm: hit ? hit.arm : (mine.opening || "unknown"),
        arm_source: hit ? hit.source : "inferred",
        video_key: `${p.uuid}:${pr.network}`,
        thumbnail: publicMetricoolCdnUrl(p.thumbnail),
        media_url: publicMetricoolCdnUrl((p.media || [])[0]),
        status: String(pr.status || "PENDING").toUpperCase(),
        public_url: url,
        opening: mine.opening,
        // The loop's own video id, from the ledger when it knows the post and otherwise
        // from the resolved run-state variant. Both are exact joins; neither is a guess.
        video_id: mine.video_id || hit?.video_id || "",
        excluded: mine.excluded,
        skip_rate: skip,
      });
    }
  }
  posts.sort((a, b) => (Date.parse(a.scheduled_at) || 0) - (Date.parse(b.scheduled_at) || 0));
  return posts;
}

/**
 * The live calendar, read from Metricool. The bridge is a subprocess on purpose, so
 * no write symbol (createPost / reschedule / deletePost) enters this server's module
 * graph — a read-only dashboard should be read-only by construction, not by care.
 */
async function computeScheduled(): Promise<ScheduledView> {
  const asOf = new Date().toISOString();
  const emptyExp = summarizeExperiment([], CONFIG.HOOK_ARM_TARGET);
  // A week back so freshly PUBLISHED posts stay visible, and a month forward.
  const start = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 19);
  const end = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 19);

  const res = await runReadBridge("scheduled", { start, end }, CONFIG.DRAFTS_BRIDGE_TIMEOUT_MS, CONFIG.METRICOOL_READ_BRIDGE);
  if (!res || res.ok !== true || !Array.isArray(res.posts)) {
    return {
      ok: false, posts: [], count: 0, by_platform: {}, by_status: {}, experiment: emptyExp,
      source: "metricool (read-only bridge)", as_of: asOf,
      error: res && res.error ? String(res.error).slice(0, 200) : "scheduled posts unavailable (bridge returned no posts)",
    };
  }

  // Analytics are best-effort: a published reel with no row yet is PENDING data, not
  // a zero, so a failure here must not blank the whole panel.
  //
  // Reaches back TWICE the headline window, unlike the calendar above. The per-card skip
  // chips only need the posts on screen, but the headline needs a prior window to have a
  // trend at all, and a trend that only ever reads "—" is not a trend.
  const analyticsFrom = new Date(Date.now() - 2 * SKIP_WINDOW_DAYS * 864e5).toISOString().slice(0, 19);
  let bySkip = new Map<string, number>();
  let skip: SkipRateHeadline | undefined;
  try {
    const a = await runReadBridge("analytics", { from: analyticsFrom, to: end }, CONFIG.DRAFTS_BRIDGE_TIMEOUT_MS, CONFIG.METRICOOL_READ_BRIDGE);
    if (a && a.ok === true && Array.isArray(a.reels)) {
      for (const r of a.reels) {
        if (typeof r?.skipRate === "number") {
          if (r.url) bySkip.set(String(r.url), r.skipRate);
          if (r.platformPostId) bySkip.set(String(r.platformPostId), r.skipRate);
        }
      }
      skip = summarizeSkipRate(a.reels as AnalyticsReel[]);
    }
  } catch {
    /* leave skip rates null => rendered as "pending" */
  }

  const posts = projectScheduledPosts(res.posts, {
    variantIdx: buildVariantMap(),
    ledger: loadPostingLedger(),
    bySkip,
  });
  const by_platform: Record<string, number> = {};
  const by_status: Record<string, number> = {};
  for (const p of posts) {
    by_platform[p.platform] = (by_platform[p.platform] || 0) + 1;
    by_status[p.status] = (by_status[p.status] || 0) + 1;
  }
  const awaiting = posts.filter((p) => p.awaiting_approval).length;
  return {
    ok: true,
    awaiting_approval: awaiting, posts, count: posts.length, by_platform, by_status,
    experiment: summarizeExperiment(posts, CONFIG.HOOK_ARM_TARGET),
    skip,
    source: "metricool (live, read-only bridge)", as_of: asOf,
  };
}

/**
 * Metricool reports a NAIVE local datetime plus a separate IANA zone. Convert that
 * pair to a real instant by correcting a UTC guess with the zone's offset at that
 * moment; two passes settle DST edges.
 */
export function chicagoNaiveToISO(naive: string, timeZone: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/.exec(naive.trim());
  if (!m) return naive;
  const [y, mo, d, h, mi, sec] = m.slice(1).map(Number);
  let guess = Date.UTC(y, mo - 1, d, h, mi, sec);
  for (let i = 0; i < 2; i++) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone, hour12: false, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(new Date(guess));
    const g: Record<string, number> = {};
    for (const q of parts) if (q.type !== "literal") g[q.type] = Number(q.value);
    const asUtc = Date.UTC(g.year, g.month - 1, g.day, g.hour === 24 ? 0 : g.hour, g.minute, g.second);
    guess += Date.UTC(y, mo - 1, d, h, mi, sec) - asUtc;
  }
  return new Date(guess).toISOString();
}
