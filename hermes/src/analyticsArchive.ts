#!/usr/bin/env node
/**
 * analyticsArchive.ts — an append-only archive of everything Metricool will still tell
 * us about what we published.
 *
 * WHY THIS EXISTS. The analytics endpoints serve a ROLLING WINDOW of roughly fourteen
 * days and do not say so. A request for June returns `[]` with HTTP 200, which reads
 * exactly like "nothing was published in June". Measured 2026-08-04: June → 0 rows,
 * Jul 1–14 → 0 rows, and the oldest row the account can still see is
 * 2026-07-20T01:12:18 Europe/Madrid (2026-07-19T18:12:18 America/Chicago). Every
 * finding this campaign rests on is computed against a window that erases its own
 * oldest day, every day, in silence. The Jul 23–28 attribution blackout is already
 * permanent for this reason. Nothing here can recover that; the point is that it stops
 * happening from today forward.
 *
 * WHAT IT STORES. The rows VERBATIM. No projection, no renaming, no dropped keys —
 * see metricool.ts rawAnalytics() for why the loop's own readers are the wrong shape
 * for an archive. Alongside the rows, and never instead of them, each snapshot carries
 * a `time_index`: the same posts keyed by platform id with their timestamp resolved to
 * a true instant plus the zone the row DECLARED. Metricool answers these endpoints on
 * the brand's clock (Europe/Madrid here) whatever zone was requested, so a naive local
 * string is not a fact — it is a fact plus an unstated seven-hour offset, and reading
 * it as written is what filed a 00:21 Chicago reel under "morning". See insights.ts.
 *
 * APPEND-ONLY, IN TWO PLACES. Every snapshot gets its own dated key stamped with the
 * capture instant, so a later run cannot land on an earlier one's key. Both writers
 * refuse rather than clobber: the disk writer will not open an existing path, and the
 * S3 writer HEADs first and passes If-None-Match. Nothing here ever deletes.
 *
 *   disk  ${HERMES_DATA_DIR}/analytics-archive/dt=YYYY-MM-DD/snapshot-<instant>.json
 *   s3    s3://${S3_BUCKET}/hermes/analytics-archive/dt=YYYY-MM-DD/snapshot-<instant>.json
 *
 * Two places because neither is sufficient alone: this box's predecessor was terminated
 * with work on it, and the repo it would otherwise be committed into is ~102 commits
 * ahead of an origin it cannot safely push to. S3 is the copy that survives the box.
 *
 * USAGE
 *   node hermes/src/analyticsArchive.ts              # capture, write disk + S3
 *   node hermes/src/analyticsArchive.ts --dry-run    # no network, no writes; prints the plan
 *   node hermes/src/analyticsArchive.ts --no-s3      # disk only (used by tests//first runs)
 *
 * EXIT CODES: 0 ok · 1 capture or write failed · 2 a destination refused (key existed).
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG } from "./config.ts";
import { ANALYTICS_SOURCES, listPosts, rawAnalytics, type AnalyticsSource } from "./metricool.ts";
import { instantFromWallClock, isoInZone } from "./scheduler.ts";
import { info, warn } from "./log.ts";

/** Where the archive lives, relative to its two roots. */
export const ARCHIVE_DIRNAME = "analytics-archive";
export const S3_PREFIX = "hermes/analytics-archive";

/**
 * How far back each capture asks. Deliberately far wider than the retention window:
 * asking for more than exists costs one request and returns what survives, whereas
 * asking for exactly fourteen days would clip anything the window happens to hold a
 * little longer. Verified 2026-08-04 that a single wide request and a day-by-day sweep
 * of the same span return the identical 126 reels, so the wide form loses nothing.
 */
export const WINDOW_FROM = "2026-01-01T00:00:00";
export const WINDOW_TO_YEARS_AHEAD = 1;

// ── timestamps ───────────────────────────────────────────────────────────────

export interface ResolvedInstant {
  /** The true moment, as an absolute ISO-8601 instant. */
  utc: string | null;
  /** The same moment rendered on the ACCOUNT's posting clock, offset attached. */
  account: string | null;
  /** The zone the row itself declared, or null when it declared none. */
  declared_zone: string | null;
  /** True when no zone was declared and the request zone had to be assumed. */
  zone_assumed: boolean;
}

const UNRESOLVED: ResolvedInstant = { utc: null, account: null, declared_zone: null, zone_assumed: false };

/**
 * Resolve whichever timestamp shape a network sent into an unambiguous pair.
 *
 * Three shapes arrive and only one of them is self-describing:
 *   {dateTime, timezone}  Instagram and YouTube — naive local plus a declared zone
 *   "…+0200" / "…Z"       TikTok — an absolute instant
 *   "…" naive             nothing declares the zone; the request zone is a GUESS and
 *                         is flagged as one rather than left looking exact
 */
export function resolveInstant(v: unknown, requestZone: string = CONFIG.METRICOOL_TZ): ResolvedInstant {
  const render = (ms: number, zone: string | null, assumed: boolean): ResolvedInstant =>
    Number.isFinite(ms)
      ? { utc: new Date(ms).toISOString(), account: isoInZone(ms), declared_zone: zone, zone_assumed: assumed }
      : UNRESOLVED;

  if (v && typeof v === "object") {
    const o = v as { dateTime?: unknown; timezone?: unknown };
    const dt = typeof o.dateTime === "string" ? o.dateTime.trim() : "";
    if (!dt) return UNRESOLVED;
    const declared = typeof o.timezone === "string" && o.timezone.trim() ? o.timezone.trim() : null;
    return render(instantFromWallClock(dt, declared ?? requestZone), declared, declared === null);
  }

  if (typeof v === "string") {
    const s = v.trim();
    if (!s) return UNRESOLVED;
    // "+0200" (TikTok) as well as "+02:00" and "Z".
    const off = /(?:Z|[+-]\d{2}:?\d{2})$/.exec(s);
    if (off) return render(Date.parse(s), off[0] === "Z" ? "UTC" : off[0], false);
    return render(instantFromWallClock(s, requestZone), null, true);
  }

  return UNRESOLVED;
}

/** Where each source keeps its id and its timestamp. Rows are never reshaped by this. */
const ROW_SHAPE: Record<string, { id: string[]; at: string[] }> = {
  instagramReels: { id: ["reelId"], at: ["publishedAt"] },
  instagramPosts: { id: ["postId", "id", "reelId"], at: ["publishedAt"] },
  tiktokPosts: { id: ["videoId"], at: ["createTime"] },
  youtubePosts: { id: ["videoId"], at: ["publishedAt"] },
  schedulerPosts: { id: ["uuid"], at: ["publicationDate"] },
};

export interface TimeIndexEntry extends ResolvedInstant {
  id: string;
  /** The timestamp EXACTLY as it arrived, so the resolution can always be re-checked. */
  raw: unknown;
}

/**
 * The timestamp index for one source. Additive: it never replaces a row, so a future
 * reader who distrusts this resolution can redo it from `raw` in the same file.
 */
export function timeIndexFor(source: string, rows: unknown[], requestZone?: string): TimeIndexEntry[] {
  const shape = ROW_SHAPE[source];
  if (!shape) return [];
  const out: TimeIndexEntry[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const idKey = shape.id.find((k) => r[k] != null);
    const atKey = shape.at.find((k) => r[k] != null);
    const raw = atKey ? r[atKey] : null;
    out.push({ id: idKey ? String(r[idKey]) : "", raw, ...resolveInstant(raw, requestZone) });
  }
  return out;
}

// ── snapshot document ────────────────────────────────────────────────────────

export interface SourceCapture {
  path: string;
  request: Record<string, unknown>;
  ok: boolean;
  error?: string;
  row_count: number;
  /** VERBATIM. Never projected. */
  rows: unknown[];
  time_index: TimeIndexEntry[];
}

export interface Snapshot {
  schema_version: 1;
  kind: "metricool-analytics-snapshot";
  snapshot_id: string;
  captured_at: string;
  captured_at_account: string;
  request_timezone: string;
  window: { from: string; to: string };
  note: string;
  sources: Record<string, SourceCapture>;
  coverage: Record<string, { rows: number; earliest_utc: string | null; latest_utc: string | null; days: number | null }>;
}

/** Compact, sortable, filename-safe capture stamp: 20260804T001108Z. */
export function snapshotId(capturedAtMs: number): string {
  return new Date(capturedAtMs).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/**
 * The dated, per-capture relative key. Two properties matter and both are load-bearing:
 * the `dt=` partition makes a day's snapshots enumerable without listing the world, and
 * the capture instant in the filename means no run can ever address another run's
 * object. Overwriting is not merely discouraged here, it is unaddressable.
 */
export function snapshotKey(capturedAtMs: number): string {
  const day = new Date(capturedAtMs).toISOString().slice(0, 10);
  return `dt=${day}/snapshot-${snapshotId(capturedAtMs)}.json`;
}

function coverageOf(cap: SourceCapture): { rows: number; earliest_utc: string | null; latest_utc: string | null; days: number | null } {
  const stamps = cap.time_index.map((e) => e.utc).filter((s): s is string => !!s).sort();
  if (!stamps.length) return { rows: cap.row_count, earliest_utc: null, latest_utc: null, days: null };
  const first = stamps[0];
  const last = stamps[stamps.length - 1];
  const days = Math.round(((Date.parse(last) - Date.parse(first)) / 86_400_000) * 10) / 10;
  return { rows: cap.row_count, earliest_utc: first, latest_utc: last, days };
}

export function buildSnapshot(input: {
  capturedAtMs: number;
  requestTimezone: string;
  window: { from: string; to: string };
  sources: Record<string, Omit<SourceCapture, "time_index">>;
}): Snapshot {
  const sources: Record<string, SourceCapture> = {};
  const coverage: Snapshot["coverage"] = {};
  for (const [name, cap] of Object.entries(input.sources)) {
    const full: SourceCapture = { ...cap, time_index: timeIndexFor(name, cap.rows, input.requestTimezone) };
    sources[name] = full;
    coverage[name] = coverageOf(full);
  }
  return {
    schema_version: 1,
    kind: "metricool-analytics-snapshot",
    snapshot_id: snapshotId(input.capturedAtMs),
    captured_at: new Date(input.capturedAtMs).toISOString(),
    captured_at_account: isoInZone(input.capturedAtMs),
    request_timezone: input.requestTimezone,
    window: input.window,
    note:
      "Rows are verbatim Metricool payloads. time_index resolves each row's timestamp to a true " +
      "instant plus the zone the row declared; Metricool answers on the BRAND's clock regardless " +
      "of the requested zone, so the naive dateTime alone is not a usable time.",
    sources,
    coverage,
  };
}

// ── writers (both refuse to overwrite) ───────────────────────────────────────

export class DestinationExists extends Error {}

export function writeOnce(path: string, body: string): void {
  if (existsSync(path)) throw new DestinationExists(`refusing to overwrite ${path}`);
  mkdirSync(dirname(path), { recursive: true });
  // wx = create-or-fail, so even a race between two runs cannot clobber.
  writeFileSync(path, body, { flag: "wx" });
}

/**
 * Upload without ever replacing an object. HEAD first for a clear error, then
 * If-None-Match as the actual guarantee — the HEAD alone is advisory across a race,
 * the conditional put is not. Older CLIs reject the flag; those fall back to the HEAD
 * check, which is still correct given every key carries its own capture instant.
 */
export function s3PutOnce(bucket: string, key: string, localPath: string): { uploaded: boolean; conditional: boolean } {
  const head = spawnSync("aws", ["s3api", "head-object", "--bucket", bucket, "--key", key], { encoding: "utf8" });
  if (head.status === 0) throw new DestinationExists(`refusing to overwrite s3://${bucket}/${key}`);

  const base = ["s3api", "put-object", "--bucket", bucket, "--key", key, "--body", localPath, "--content-type", "application/json"];
  let res = spawnSync("aws", [...base, "--if-none-match", "*"], { encoding: "utf8" });
  let conditional = true;
  if (res.status !== 0 && /Unknown options?:.*if-none-match|argument.*--if-none-match/i.test(res.stderr || "")) {
    conditional = false;
    res = spawnSync("aws", base, { encoding: "utf8" });
  }
  if (res.status !== 0) throw new Error(`s3 put failed (${res.status}): ${(res.stderr || "").slice(-400)}`);
  return { uploaded: true, conditional };
}

// ── capture ──────────────────────────────────────────────────────────────────

function windowTo(nowMs: number): string {
  const d = new Date(nowMs);
  return `${d.getUTCFullYear() + WINDOW_TO_YEARS_AHEAD}-12-31T23:59:59`;
}

export async function capture(nowMs: number): Promise<Snapshot> {
  const tz = CONFIG.METRICOOL_TZ;
  const win = { from: WINDOW_FROM, to: windowTo(nowMs) };
  const sources: Record<string, Omit<SourceCapture, "time_index">> = {};

  for (const name of Object.keys(ANALYTICS_SOURCES) as AnalyticsSource[]) {
    const path = ANALYTICS_SOURCES[name];
    const request = { from: win.from, to: win.to, timezone: tz };
    try {
      const rows = await rawAnalytics(name, win.from, win.to, tz);
      sources[name] = { path, request, ok: true, row_count: rows.length, rows };
      info("archived analytics source", { source: name, rows: rows.length });
    } catch (e) {
      // One dead network must not cost us the others — a partial snapshot beats none,
      // and the failure is recorded in the file rather than only in a log that rotates.
      const error = (e instanceof Error ? e.message : String(e)).slice(0, 300);
      sources[name] = { path, request, ok: false, error, row_count: 0, rows: [] };
      warn("analytics source failed; snapshot continues", { source: name, error });
    }
  }

  // The scheduler is archived alongside the analytics because it forgets FASTER. On
  // 2026-08-03, 21 of the opening experiment's 41 posts had already fallen off
  // /v2/scheduler/posts, which is what silently broke the uuid → permalink → skip-rate
  // join. listPosts() carries an index signature, so its rows are already unprojected.
  try {
    const rows = await listPosts(win.from, win.to);
    sources.schedulerPosts = {
      path: "/v2/scheduler/posts",
      request: { start: win.from, end: win.to, timezone: tz, extendedRange: false },
      ok: true,
      row_count: rows.length,
      rows,
    };
    info("archived scheduler posts", { rows: rows.length });
  } catch (e) {
    const error = (e instanceof Error ? e.message : String(e)).slice(0, 300);
    sources.schedulerPosts = { path: "/v2/scheduler/posts", request: {}, ok: false, error, row_count: 0, rows: [] };
    warn("scheduler capture failed; snapshot continues", { error });
  }

  return buildSnapshot({ capturedAtMs: nowMs, requestTimezone: tz, window: win, sources });
}

// ── entrypoint ───────────────────────────────────────────────────────────────

export interface ArchiveResult {
  snapshot_id: string;
  disk_path: string;
  s3_uri: string | null;
  bytes: number;
  coverage: Snapshot["coverage"];
}

export async function runArchive(opts: { nowMs?: number; s3?: boolean } = {}): Promise<ArchiveResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const snap = await capture(nowMs);
  const body = JSON.stringify(snap, null, 1);
  const rel = snapshotKey(nowMs);

  const diskPath = join(CONFIG.DATA_DIR, ARCHIVE_DIRNAME, rel);
  writeOnce(diskPath, body);

  let s3Uri: string | null = null;
  if (opts.s3 !== false) {
    const key = `${S3_PREFIX}/${rel}`;
    s3PutOnce(CONFIG.S3_BUCKET, key, diskPath);
    s3Uri = `s3://${CONFIG.S3_BUCKET}/${key}`;
  }

  // Append-only ledger of what exists. Never rewritten, so it cannot lose a line by
  // being regenerated from a directory that has since been pruned.
  appendFileSync(
    join(CONFIG.DATA_DIR, ARCHIVE_DIRNAME, "index.ndjson"),
    JSON.stringify({
      snapshot_id: snap.snapshot_id,
      captured_at: snap.captured_at,
      disk: diskPath,
      s3: s3Uri,
      bytes: Buffer.byteLength(body),
      coverage: snap.coverage,
    }) + "\n",
  );

  return { snapshot_id: snap.snapshot_id, disk_path: diskPath, s3_uri: s3Uri, bytes: Buffer.byteLength(body), coverage: snap.coverage };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const nowMs = Date.now();

  if (argv.includes("--dry-run")) {
    const rel = snapshotKey(nowMs);
    console.log(
      JSON.stringify(
        {
          ok: true,
          dry_run: true,
          sources: Object.keys(ANALYTICS_SOURCES).concat("schedulerPosts"),
          disk_path: join(CONFIG.DATA_DIR, ARCHIVE_DIRNAME, rel),
          s3_uri: `s3://${CONFIG.S3_BUCKET}/${S3_PREFIX}/${rel}`,
        },
        null,
        2,
      ),
    );
    return;
  }

  try {
    const out = await runArchive({ nowMs, s3: !argv.includes("--no-s3") });
    console.log(JSON.stringify({ ok: true, ...out }, null, 2));
  } catch (e) {
    if (e instanceof DestinationExists) {
      console.error(JSON.stringify({ ok: false, refused: true, error: e.message }));
      process.exit(2);
    }
    console.error(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }));
    process.exit(1);
  }
}

if (import.meta.filename === process.argv[1]) await main();
