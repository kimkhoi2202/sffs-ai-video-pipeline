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
  /**
   * TRUE when this verdict was reached WITHOUT the model that was meant to reach it
   * (gateway 403/429/5xx). A degraded PASS and a real PASS are the same `pass: true`
   * from outside, which is precisely how the 2026-08-03 judge outage stayed invisible
   * for a day. Anything that reports a gate must report this alongside it.
   */
  degraded?: boolean;
}

// ── Nonverbal SHAPE/FIGURE question kinds ────────────────────────────────────
// The paper-folding ("fold") + figure-matrix family ("matrix"/"analogy2"/
// "figure-odd") kinds render from a structured `figure` payload (see Figure)
// instead of text options. These types are dependency-light + React-free on
// purpose (state.ts is imported everywhere): they STRUCTURALLY mirror the
// remotion Question shapes (remotion/src/data/types.ts) + FigState
// (remotion/src/components/FigureCell.tsx) without importing them.

/** The nonverbal shape/figure kinds (options are figures, not text). Covers the
 *  FigState family (fold + matrix/analogy2/figure-odd) AND the legacy classic
 *  nonverbal kinds (dot/shaded/polygon) unlocked via legacyShapes.ts: all render
 *  from a structured `figure` payload with figure (non-text) options. */
export const SHAPE_KINDS = ["fold", "matrix", "analogy2", "figure-odd", "dot", "shaded", "polygon"] as const;
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
  holes?: FigureCell[]; // fold: an unfolded hole pattern
  fig?: FigureState; // matrix-family: a transform-vocabulary figure
  // legacy classic-nonverbal option payloads (dot/shaded/polygon):
  pos?: string; // dot: a DotPos code (tl/tm/tr/rm/br/bm/bl/lm)
  poly?: number | "circle"; // polygon: side count (3-8) or circle
  shape?: string; // shaded: a GlyphKind
  filled?: boolean; // shaded: fill state of the glyph
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
  // legacy classic-nonverbal stimulus (dot/shaded/polygon):
  dotSeq?: string[]; // dot: DotPos codes shown before the "?" tile
  polySeq?: number[]; // polygon: side counts shown before the "?" tile
  leftShape?: string; // shaded: the analogy's left glyph
  rightShape?: string; // shaded: the analogy's right glyph (== the answer shape, filled)
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
  /** The AUTHORED explanation for the reveal plate + reveal VO, carried through from
   *  the bank. Undefined only for entries banked before the raw-text re-import, in
   *  which case render.ts falls back to its generated template. */
  explanation?: string;
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
  /** Where `caption` came from: `llm:<model>` or `fallback` (the hardcoded template). */
  caption_source?: string;
  hashtag_set: string;
  questions: HermesQ[];
  gates: Record<string, GateResult>;
  status: VideoStatus;
  reject_reason?: string;
  render_path?: string;
  /**
   * Per-platform renders produced by the cycle's PREPARE phase and consumed by its
   * PUBLISH phase. Persisted so scheduling (which happens after the whole batch is
   * rendered, once the surviving count is known) never has to re-render or re-synth
   * the voiceover — including across a resumed run.
   */
  renders?: Array<{ platform: string; path: string; frames: number }>;
  media_url?: string;
  metricool?: { media_id?: string; uuids?: string[]; permalinks?: string[] };
  /**
   * Publer-era run state, preserved verbatim for provenance. Never written again:
   * Publer is retired and its ids no longer resolve against anything.
   */
  legacy_publer?: { job_id?: string; media_id?: string; post_ids?: string[]; permalinks?: string[] };
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
  summary: {
    planned: number;
    drafted: number;
    rejected: number;
    failed: number;
    /**
     * Work that SHIPPED without the model that was supposed to do it. Every counter is
     * zero on a healthy cycle, so a non-zero here is the whole signal: drafted/rejected/
     * failed cannot distinguish "twelve judged videos" from "twelve unjudged ones".
     */
    degraded?: {
      /** Gateway calls that failed after retries (429 budget, 403, 5xx, timeout). */
      llm_failed_calls: number;
      /** Videos that shipped the hardcoded template caption. */
      caption_fallbacks: number;
      /** Videos whose brand-voice gate passed on deterministic rules alone. */
      copy_gate_unjudged: number;
      /** Videos whose question-validity gate ran without the LLM rubric. */
      questions_unjudged: number;
    };
  };
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
