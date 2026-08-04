/**
 * types.ts — the minimal run-state data model the dashboard reads.
 *
 * Mirrored (intentionally, to stay decoupled + dependency-free) from the live
 * loop's contract in hermes/src/state.ts. The rebuilt hermes-nous cycle writes
 * the SAME shape to DATA_DIR/runs/<run_id>.json, so the dashboard reads either
 * the legacy loop's runs or the rebuilt agent's runs unchanged.
 *
 * Only the fields the dashboard renders are declared; unknown extra fields on the
 * JSON are ignored (best-effort, forward-compatible).
 */

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
  /** the verdict was reached WITHOUT the model meant to reach it (gateway 403/429/5xx) */
  degraded?: boolean;
}

export interface HermesQ {
  sig: string;
  hash: string;
  kind: "text" | "numseries" | string;
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
  /** the A/B dimension under test (e.g. "narration", "progress-counter") */
  dimension: string;
  /** the specific arm value within that dimension */
  arm: string;
  rationale: string;
  props?: Record<string, unknown>;
  caption?: string;
  /** `llm:<model>` or `fallback` (the hardcoded template) */
  caption_source?: string;
  hashtag_set?: string;
  questions?: HermesQ[];
  /** quality-gate verdicts, keyed by gate name (dedup/questions/copy/render) */
  gates?: Record<string, GateResult>;
  status: VideoStatus;
  reject_reason?: string;
  render_path?: string;
  media_url?: string;
  metricool?: { media_id?: string; uuids?: string[]; permalinks?: string[] };
  /** Publer-era run state, preserved verbatim for provenance. Never written again. */
  legacy_publer?: { job_id?: string; media_id?: string; post_ids?: string[]; permalinks?: string[] };
  errors?: string[];
}

export interface RunState {
  run_id: string;
  started_at: string;
  updated_at: string;
  finished_at?: string;
  status: "running" | "success" | "partial" | "failed" | string;
  cadence?: string;
  target_count?: number;
  do_not_touch?: {
    scheduled_ids: Array<string | number>;
    published_ids: Array<string | number>;
    captured_at: string;
  };
  scoring?: { from?: string; to?: string; pulled?: number; updated?: number; note?: string };
  videos?: VideoPlan[];
  summary?: {
    planned: number;
    drafted: number;
    rejected: number;
    failed: number;
    /** work that shipped without the model that was supposed to do it (all zero when healthy) */
    degraded?: {
      llm_failed_calls: number;
      caption_fallbacks: number;
      copy_gate_unjudged: number;
      questions_unjudged: number;
    };
  };
  errors?: string[];
}

// ── default-promotion (CONTENT gate) view models ─────────────────────────────

/** One default-promotion proposal (ab-testing/proposals.json). Loose/forward-compat. */
export interface PromotionProposal {
  id: string;
  dimension: string;
  current_default?: string;
  recommended_default?: string;
  incumbent_label?: string;
  metric?: string;
  challenger?: Record<string, unknown> & { arm?: string; n_with_metrics?: number };
  incumbent?: Record<string, unknown> & { arm?: string; n_with_metrics?: number };
  delta_abs_pp?: number;
  delta_rel?: number | null;
  min_sample?: number;
  confidence?: string;
  status: string;
  detected_at?: string;
  updated_at?: string;
  rationale?: string;
}

export interface ProposalsQueue {
  proposals?: PromotionProposal[];
  decisions_log?: unknown[];
}

export interface ContentDefaultsFile {
  defaults?: Record<string, string>;
  promotion?: Record<string, unknown>;
}

// ── software-factory PR view models ───────────────────────────────────────────

/** One line of the two-key auto-merge gate ledger (scripts/gate/logs/auto_merge.log). */
export interface GateAttempt {
  ts?: string;
  source?: string;
  target?: string;
  mode?: string;
  merged?: boolean;
  merge_commit?: string;
  mergeable?: boolean;
  changed_files?: string[];
  /** harness verdict: GREEN | RED | SKIPPED | ? (KEY 1 = tests) */
  harness: string;
  /** review-agent verdict: APPROVE | REJECT | SKIPPED | ? (KEY 2) */
  review: string;
  reviewSource?: string;
  /** final gate decision: MERGE | REFUSE | ? */
  decision: string;
  reasons?: string[];
}

export interface PRCiCheck {
  name: string;
  result: "PASS" | "FAIL" | "PENDING";
}

export interface PRRow {
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "MERGED" | "CLOSED" | string;
  isDraft?: boolean;
  headRefName: string;
  baseRefName: string;
  author?: string;
  createdAt?: string;
  updatedAt?: string;
  mergedAt?: string | null;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  /** GitHub check rollup (the real CI/E2E test status) */
  ci: { status: "PASS" | "FAIL" | "PENDING" | "NONE"; checks: PRCiCheck[] };
  /** GitHub's own review decision (human reviews), distinct from the review-agent */
  reviewDecision?: string | null;
  /** the software-factory gate's own record for this branch (review-agent + harness) */
  gate: (GateAttempt & { matched: boolean }) | { matched: false };
}
