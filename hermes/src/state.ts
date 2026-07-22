/**
 * state.ts — run state persistence for idempotency/resumability + the dashboard.
 *
 * Each ~24h run writes one JSON file under DATA_DIR/runs/<run_id>.json capturing:
 * the do-not-touch snapshot of existing live/scheduled posts, scoring results, the
 * proposed batch (each video's A/B dimension + quality-gate results + status), and
 * a summary. Re-running the same run_id resumes: completed per-video steps are
 * skipped. Files are written atomically (tmp + rename).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { CONFIG } from "./config.ts";

export type VideoStatus =
  | "planned"
  | "questions_selected"
  | "copy_ready"
  | "rendered"
  | "uploaded"
  | "drafted"
  | "rejected"
  | "failed";

export interface GateResult {
  pass: boolean;
  reason?: string;
  detail?: unknown;
}

export interface HermesQ {
  sig: string;
  hash: string;
  kind: "text" | "numseries";
  category: string;
  tier: string;
  prompt: string;
  options?: string[];
  seq?: string[];
  answer: string;
}

export interface VideoPlan {
  id: string;
  index: number;
  dimension: string; // the A/B dimension under test
  arm: string; // the specific arm value
  rationale: string;
  props: Record<string, unknown>; // HermesQuiz render props
  caption: string;
  hashtag_set: string;
  questions: HermesQ[];
  gates: Record<string, GateResult>;
  status: VideoStatus;
  reject_reason?: string;
  render_path?: string;
  media_url?: string;
  publer?: { job_id?: string; media_id?: string; post_ids?: string[]; permalinks?: string[] };
  errors?: string[];
}

export interface RunState {
  run_id: string;
  started_at: string;
  updated_at: string;
  finished_at?: string;
  status: "running" | "success" | "partial" | "failed";
  cadence: string;
  target_count: number;
  do_not_touch: { scheduled_ids: Array<string | number>; published_ids: Array<string | number>; captured_at: string };
  scoring: { from?: string; to?: string; pulled?: number; updated?: number; note?: string };
  videos: VideoPlan[];
  summary: { planned: number; drafted: number; rejected: number; failed: number };
  errors: string[];
}

export function readJSON<T>(path: string, fallback: T): T {
  try {
    if (!existsSync(path)) return fallback;
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function writeJSONAtomic(path: string, obj: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2));
  renameSync(tmp, path);
}

export function runPath(runId: string): string {
  return join(CONFIG.RUNS_DIR, `${runId}.json`);
}

export function loadRun(runId: string): RunState | null {
  return readJSON<RunState | null>(runPath(runId), null);
}

export function saveRun(state: RunState): void {
  state.updated_at = new Date().toISOString();
  writeJSONAtomic(runPath(state.run_id), state);
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

export function latestRun(): RunState | null {
  const runs = listRuns();
  return runs.length ? loadRun(runs[0]) : null;
}

export function todayRunId(d = new Date()): string {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}
