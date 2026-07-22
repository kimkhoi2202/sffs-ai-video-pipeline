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

// ── Nonverbal SHAPE/FIGURE question kinds ────────────────────────────────────
// The paper-folding ("fold") + figure-matrix family ("matrix"/"analogy2"/
// "figure-odd") kinds render from a structured `figure` payload (see Figure)
// instead of text options. These types are dependency-light + React-free on
// purpose (state.ts is imported everywhere): they STRUCTURALLY mirror the
// remotion Question shapes (remotion/src/data/types.ts) + FigState
// (remotion/src/components/FigureCell.tsx) without importing them.

/** The nonverbal shape/figure kinds (options are figures, not text). */
export const SHAPE_KINDS = ["fold", "matrix", "analogy2", "figure-odd"] as const;
export type ShapeKind = (typeof SHAPE_KINDS)[number];
const SHAPE_KIND_SET: ReadonlySet<string> = new Set(SHAPE_KINDS);
/** True if `kind` is one of the nonverbal shape/figure kinds. */
export function isShapeKind(kind: string | undefined): kind is ShapeKind {
  return kind !== undefined && SHAPE_KIND_SET.has(kind);
}

/** A grid cell (row, col) — a paper-folding hole/punch coordinate. */
export interface FigureCell {
  r: number;
  c: number;
}

/** One figure in the matrix-family transform vocabulary. Mirrors the remotion
 *  `FigState` (shape + fill/rotate/count/size transforms). */
export interface FigureState {
  shape: string;
  filled?: boolean;
  color?: string;
  rotate?: number;
  count?: number;
  size?: "s" | "m" | "l";
}

/** A shape-question option: fold options carry unfolded `holes`; matrix-family
 *  options carry a `fig`. */
export interface FigureOption {
  letter: string;
  holes?: FigureCell[];
  fig?: FigureState;
}

/**
 * The render-ready payload copied verbatim from a bank entry's `figure` field
 * (fold / matrix / analogy2 / figure-odd). Structurally mirrors the remotion
 * Question shapes MINUS the fields render.ts derives at map time:
 *   fold.ansHoles = unfold(folds, punches, grid);
 *   matrix/analogy2/figure-odd `ans` = the ansLetter option's `fig`.
 */
export interface Figure {
  kind: ShapeKind;
  category?: string;
  tier?: string;
  difficulty?: string;
  countdown?: number;
  prompt: string;
  ansLetter: string;
  ansLabel: string;
  explanation: string;
  options: FigureOption[];
  // fold-only stimulus
  grid?: number;
  folds?: string[];
  punches?: FigureCell[];
  // matrix-family stimulus
  cells?: FigureState[];
  a?: FigureState;
  b?: FigureState;
  c?: FigureState;
}

export interface HermesQ {
  sig: string;
  hash: string;
  kind: "text" | "numseries" | ShapeKind;
  category: string;
  tier: string;
  prompt: string;
  options?: string[];
  seq?: string[];
  answer: string;
  /** Structured render-ready payload for the nonverbal shape/figure kinds
   *  (undefined for text/numseries). Reconstructed by toHermesQ from the bank
   *  entry's `figure` field; consumed by render.ts mapProps. */
  figure?: Figure;
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
