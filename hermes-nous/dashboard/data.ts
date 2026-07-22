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
import { computeGoalProgress, type GoalProgress, type FollowerSnapshot } from "./goal.ts";

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
 * /api/health). The video itself is reviewable via the Publer draft/permalink.
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

/** The always-on software-factory daemon status (factory-status.json) or null. */
export function factoryStatus(): any {
  return readJSON<any>(CONFIG.FACTORY_STATUS, null);
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
 * Live GOAL-PROGRESS: aggregate ab-database posts (windowed at kickoff) against
 * the mandate, with the optional follower snapshot. Pure math lives in goal.ts.
 */
export function goalProgress(): GoalProgress {
  const posts = Array.isArray(abDb()?.posts) ? abDb().posts : [];
  const k = kickoffState();
  return computeGoalProgress(posts, k.since, accountFollowers(), new Date());
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

// ── "Drafts awaiting review" (READ-ONLY) ─────────────────────────────────────
// Lists the pending Publer drafts by spawning the pipeline's VETTED read-only
// Publer bridge (bridge/publer-read.ts) — it only issues GET requests and cannot
// create/publish/schedule/mutate a post. The Publer key stays server-side (in the
// bridge's env); it is NEVER rendered. Each video is enriched (best-effort) with
// its A/B variant + question types by correlating the Publer draft id against the
// loop's RunState (publer.post_ids) and ab-database.json; where no record exists
// the label is INFERRED from the caption and clearly tagged.

export interface DraftPlatformLink {
  platform: string; // instagram | tiktok | unknown
  publer_id: string; // Publer post id (opaque; NOT a secret). No public per-draft URL exists.
}

export interface DraftVideo {
  video_key: string; // shared Publer media id (groups the IG + TikTok pair)
  hook: string; // the caption hook (first meaningful line, hashtags stripped)
  caption: string; // full draft caption/text
  thumbnail: string | null; // validated PUBLIC Publer CDN poster image (or null)
  /**
   * The PUBLIC Publer CDN mp4 (media[].path) — NOT the S3 presigned url (which
   * carries AWS tokens and must never reach this public page). It is Referer-gated
   * to Publer's ecosystem, so the browser cannot load it cross-origin; the page
   * renders it same-origin via the read-only /api/draft-media proxy. null if the
   * draft has no clean public CDN video.
   */
  media_url: string | null;
  dimension: string; // A/B dimension (from run) or "hook" (inferred)
  arm: string; // A/B arm (from run) or an inferred slug of the hook
  variant_source: "run" | "ab-database" | "inferred";
  question_types: string[]; // ordered question TYPES/tiers (empty if unknown)
  run_id?: string;
  drafts: DraftPlatformLink[]; // 1–2 platform drafts (IG + TikTok)
  updated_at?: string;
}

export interface DraftsView {
  ok: boolean;
  videos: DraftVideo[];
  count_videos: number;
  count_drafts: number;
  source: string;
  as_of: string;
  error?: string;
}

/**
 * PUBLIC Publer CDN allowlist — the single validator that decides whether a URL
 * may appear in a public drafts response or be proxied. Returns the URL iff it is
 * a clean, PUBLIC Publer CDN asset: https + host EXACTLY `cdn.publer.com` + no
 * userinfo + NO query string / fragment. Publer's CDN mp4/jpg paths are all
 * query-less; an S3 PRESIGNED url (the thing we must never expose) lives on
 * *.amazonaws.com and ALWAYS carries X-Amz-* query params — so it can never pass
 * this check. Returns null for anything else. This is the drafts-surface analogue
 * of redactRunForPublic: a signed/secret-bearing url is structurally excluded.
 */
export function publicPublerCdnUrl(u: unknown): string | null {
  if (typeof u !== "string" || !u) return null;
  let parsed: URL;
  try {
    parsed = new URL(u);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  if (parsed.hostname !== "cdn.publer.com") return null;
  if (parsed.username || parsed.password) return null;
  if (parsed.search || parsed.hash) return null; // presigned/signed URLs always carry a query
  if (/x-amz-|amazonaws\.com|credential=|signature=|security-token/i.test(u)) return null; // defense-in-depth
  return parsed.href;
}

/**
 * Resolve a pending draft's validated PUBLIC-CDN asset URL by video_key + kind.
 * Used by the read-only media proxy so it can ONLY ever fetch a cdn.publer.com
 * asset that belongs to a CURRENT draft (allowlist ⇒ no open-proxy / SSRF).
 */
export function resolveDraftMediaUrl(view: DraftsView | null, videoKey: string, kind: "video" | "thumb"): string | null {
  if (!view || !Array.isArray(view.videos) || !videoKey) return null;
  const v = view.videos.find((x) => x.video_key === videoKey);
  if (!v) return null;
  return publicPublerCdnUrl(kind === "thumb" ? v.thumbnail : v.media_url);
}

/**
 * Public choke point: force every media_url + thumbnail through the PUBLIC-CDN
 * allowlist (nulls anything that is not a clean cdn.publer.com asset — e.g. a
 * stray S3 presigned URL). Mirrors redactRunForPublic for the drafts surface, so
 * the public-CDN-only invariant holds no matter how a DraftVideo was built.
 */
export function sanitizeDraftsForPublic(view: DraftsView): DraftsView {
  for (const v of view.videos || []) {
    v.media_url = publicPublerCdnUrl(v.media_url);
    v.thumbnail = publicPublerCdnUrl(v.thumbnail);
  }
  return view;
}

function platformForAccount(accountId: string, accountsMap: Record<string, any>): string {
  const live = accountsMap?.[accountId]?.platform;
  if (typeof live === "string" && live) return live;
  return CONFIG.ACCOUNT_PLATFORMS[accountId] || "unknown";
}

/** First meaningful caption line (drops the showcase tag + trailing hashtags). */
export function draftHook(text: string): string {
  const t = String(text || "").replace(/\[hermes-nous showcase\]/i, "").trim();
  const line = t.split("\n").map((s) => s.trim()).filter(Boolean)[0] || t;
  const cleaned = line.replace(/#\S+/g, "").replace(/\s+/g, " ").trim();
  return cleaned.slice(0, 160) || "(no caption)";
}

/** Inferred arm slug from the caption hook (used only when no run record matches). */
export function inferArm(text: string): string {
  const h = draftHook(text).toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
  const slug = h.split(/\s+/).filter(Boolean).slice(0, 4).join("-");
  return slug || "variant";
}

/** Map every known Publer post id → its A/B variant, from RunState + ab-database. */
export function buildPublerVariantMap(): Map<
  string,
  { dimension: string; arm: string; question_types: string[]; run_id?: string; source: "run" | "ab-database" }
> {
  const m = new Map<string, { dimension: string; arm: string; question_types: string[]; run_id?: string; source: "run" | "ab-database" }>();
  // RunState is the richest source (dimension + arm + ordered question tiers).
  for (const r of runSummaries(50)) {
    for (const v of r.videos || []) {
      const ids = v.publer?.post_ids || [];
      if (!ids.length) continue;
      const tiers = (v.questions || []).map((q) => q.tier).filter((t): t is string => !!t);
      for (const id of ids) {
        if (id === undefined || id === null) continue;
        m.set(String(id), { dimension: v.dimension || "—", arm: v.arm || "—", question_types: tiers, run_id: r.run_id, source: "run" });
      }
    }
  }
  // ab-database.json (published posts) — fills any id the runs don't have.
  const posts: any[] = Array.isArray(abDb()?.posts) ? abDb().posts : [];
  for (const p of posts) {
    const id = p?.publer_post_id;
    if (id === undefined || id === null || m.has(String(id))) continue;
    const va = p.variant || {};
    const qt = Array.isArray(va.question_types) ? va.question_types.map((x: unknown) => String(x)) : [];
    m.set(String(id), {
      dimension: va.family || p.experiment?.dimension || "—",
      arm: va.arm || va.hook || p.experiment?.arm || "—",
      question_types: qt,
      source: "ab-database",
    });
  }
  return m;
}

/** Spawn the READ-ONLY publer bridge and parse its single JSON stdout line. */
function runReadBridge(sub: string, params: Record<string, unknown>, timeoutMs: number): Promise<any> {
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
      child = spawn(process.execPath, [CONFIG.PUBLER_READ_BRIDGE, sub], {
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

let _draftsCache: { at: number; view: DraftsView } | null = null;
let _draftsInflight: Promise<DraftsView> | null = null;

/** Live pending Publer drafts, grouped into videos, cached (TTL) + single-flight. */
export async function draftsAwaitingReview(): Promise<DraftsView> {
  const now = Date.now();
  if (_draftsCache && now - _draftsCache.at < CONFIG.DRAFTS_TTL_MS) return _draftsCache.view;
  if (_draftsInflight) return _draftsInflight;
  _draftsInflight = (async () => {
    let view: DraftsView;
    try {
      view = await computeDrafts();
    } catch (e) {
      view = { ok: false, videos: [], count_videos: 0, count_drafts: 0, source: "publer (read-only bridge)", as_of: new Date().toISOString(), error: e instanceof Error ? e.message : String(e) };
    }
    // Only cache good results; keep serving the last good view on transient errors.
    if (view.ok) _draftsCache = { at: Date.now(), view };
    else if (_draftsCache) view = _draftsCache.view;
    _draftsInflight = null;
    // Choke point: guarantee public-CDN-only media_url/thumbnail on EVERY served view.
    return sanitizeDraftsForPublic(view);
  })();
  return _draftsInflight;
}

async function computeDrafts(): Promise<DraftsView> {
  const asOf = new Date().toISOString();
  const res = await runReadBridge("posts", { all: true, state: "draft", max_pages: CONFIG.DRAFTS_MAX_PAGES }, CONFIG.DRAFTS_BRIDGE_TIMEOUT_MS);
  if (!res || res.ok !== true || !Array.isArray(res.posts)) {
    return {
      ok: false,
      videos: [],
      count_videos: 0,
      count_drafts: 0,
      source: "publer (read-only bridge)",
      as_of: asOf,
      error: res && res.error ? String(res.error).slice(0, 200) : "drafts unavailable (bridge returned no posts)",
    };
  }
  const posts: any[] = res.posts;
  const accountsMap = (abDb() && abDb().accounts) || {};
  const variantMap = buildPublerVariantMap();

  // Group by the shared Publer media id → one "video" per IG+TikTok pair.
  const groups = new Map<string, any[]>();
  for (const p of posts) {
    const mediaId = (p.media && p.media[0] && p.media[0].id) || p.id;
    const key = String(mediaId);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(p);
  }

  const videos: DraftVideo[] = [];
  for (const [key, ps] of groups) {
    const rep = ps[0];
    const media = (rep.media && rep.media[0]) || {};
    const thumbs: any[] = Array.isArray(media.thumbnails) ? media.thumbnails : [];
    const ti = Number.isInteger(media.default_thumbnail) ? media.default_thumbnail : 0;
    const thumbRaw = (thumbs[ti] && thumbs[ti].real) || (thumbs[0] && (thumbs[0].real || thumbs[0].small)) || null;
    const thumbnail = publicPublerCdnUrl(thumbRaw); // validated PUBLIC CDN poster (never S3-signed)
    // The PUBLIC Publer CDN mp4 (media[].path) — NOT the S3 presigned url. Rendered
    // same-origin via the read-only /api/draft-media proxy (CDN is Referer-gated).
    const media_url = publicPublerCdnUrl(media.path);

    let variant: { dimension: string; arm: string; question_types: string[]; run_id?: string; source: "run" | "ab-database" } | null = null;
    for (const p of ps) {
      const hit = variantMap.get(String(p.id));
      if (hit) {
        variant = hit;
        break;
      }
    }

    // Publer exposes NO stable/public per-draft URL (a draft's `url`/`post_link`/
    // `linkie` are all null; there is no permalink/edit-link field), so we keep the
    // platform + opaque id for labelling but DO NOT emit a (dead) deep-link.
    const drafts: DraftPlatformLink[] = ps
      .map((p) => ({ platform: platformForAccount(String(p.account_id), accountsMap), publer_id: String(p.id) }))
      .sort((a, b) => a.platform.localeCompare(b.platform));

    videos.push({
      video_key: key,
      hook: draftHook(rep.text),
      caption: String(rep.text || ""),
      thumbnail,
      media_url,
      dimension: variant ? variant.dimension : "hook",
      arm: variant ? variant.arm : inferArm(rep.text),
      variant_source: variant ? variant.source : "inferred",
      question_types: variant ? variant.question_types : [],
      run_id: variant?.run_id,
      drafts,
      updated_at: rep.updated_at,
    });
  }

  videos.sort((a, b) => (Date.parse(b.updated_at || "") || 0) - (Date.parse(a.updated_at || "") || 0) || a.video_key.localeCompare(b.video_key));
  const count_drafts = videos.reduce((n, v) => n + v.drafts.length, 0);
  return { ok: true, videos, count_videos: videos.length, count_drafts, source: "publer (live, read-only bridge)", as_of: asOf };
}
