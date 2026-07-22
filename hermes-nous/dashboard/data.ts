/**
 * data.ts — READ-ONLY data loaders for the dashboard.
 *
 * Every loader is best-effort: a missing/%corrupt file NEVER crashes the page, it
 * degrades to an empty/fallback value. Nothing here writes, posts, schedules, or
 * mutates anything — it only reads local JSON, queries `systemctl`/`df` for health,
 * and (optionally) pings the LLM gateway with a short timeout.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { CONFIG } from "./config.ts";
import type { RunState } from "./types.ts";

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

export function loadRun(runId: string): RunState | null {
  if (!runId || /[\\/]/.test(runId)) return null; // no path traversal
  return readJSON<RunState | null>(`${CONFIG.RUNS_DIR}/${runId}.json`, null);
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

function loadUsedSigs(): Set<string> {
  const used = new Set<string>();
  const usage = readJSON<{ videos?: Array<{ questions?: Array<{ sig?: string }> }> }>(CONFIG.USAGE, {});
  for (const v of usage.videos ?? []) for (const q of v.questions ?? []) if (q.sig) used.add(q.sig);
  const hermes = readJSON<{ sigs?: string[] }>(CONFIG.HERMES_USED, {});
  for (const s of hermes.sigs ?? []) used.add(s);
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
