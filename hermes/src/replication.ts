/**
 * replication.ts — the loop's READ side of the winner-replication engine.
 *
 * The detector, the escalation policy and the reversible ledger live in Python
 * (hermes-nous/sffs/replicate.py, the analog of promote.py). This module is the
 * thin, dependency-free contract the TypeScript designer (design.ts) and the
 * dashboard read: "is a reach outlier currently being doubled down on, which style
 * is it, and how many of this batch's slots may it take?"
 *
 * It deliberately CANNOT open, escalate or revert a round — it only reads
 * ab-testing/replication.json and the policy in content-defaults.json. Keeping the
 * write side in one place means there is exactly one thing to audit and one file to
 * revert.
 *
 * The share is clamped twice on the way out (once against the round's own recorded
 * cap, once against the policy cap) because `winner_share_cap` is an EXPLORATION
 * FLOOR: if replication ever ate a whole batch the loop would stop sampling new
 * styles and could only ever rediscover what it already believes.
 */
import { join } from "node:path";
import { CONFIG } from "./config.ts";
import { readJSON } from "./state.ts";

/** Hard ceiling on the share of a batch replication may ever take. */
export const HARD_SHARE_CAP = 0.5;

/** The style axes a replication holds CONSTANT (mirrors replicate.py STYLE_AXES). */
export const STYLE_AXES = ["lead_type", "num_questions", "family", "narration", "ending"] as const;

export interface StyleFingerprint {
  key: string;
  lead_type: string;
  question_types: string[];
  num_questions: number;
  family: string;
  narration: string;
  ending: string;
}

export interface ReplicationDirective {
  active: boolean;
  key?: string;
  fingerprint?: StyleFingerprint;
  /** fraction of the batch the winning style may take (already clamped) */
  share: number;
  share_cap: number;
  round?: number;
  status?: string;
  confidence?: string;
  opened_at?: string;
  evaluate_after?: string;
  vary_only?: string[];
  evidence?: Record<string, unknown>;
  reason?: string;
}

const LEDGER_PATH = (): string => join(CONFIG.REPO_DIR, "ab-testing", "replication.json");

/**
 * Fold a question tier to one comparable token — mirrors replicate.py
 * normalize_tier. The corpus spans two eras ("odd-one-out" vs "ODD ONE OUT"); the
 * designer must fold them the same way the detector does or a replica would never
 * be recognised as matching the winner it is replicating.
 */
export function normalizeTier(t: unknown): string {
  const s = String(t ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s_/]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return s || "?";
}

/** The raw ledger (or an empty one). Never throws. */
export function loadLedger(): { active: unknown; history: unknown[]; updated_at?: string } {
  const led = readJSON<any>(LEDGER_PATH(), null);
  if (!led || typeof led !== "object") return { active: null, history: [] };
  return { active: led.active ?? null, history: Array.isArray(led.history) ? led.history : [], updated_at: led.updated_at };
}

/** Is replication switched on in content-defaults.json? (default: yes) */
function policyEnabledAndCap(): { enabled: boolean; cap: number } {
  const cd = readJSON<any>(CONFIG.CONTENT_DEFAULTS, null);
  const r = cd && typeof cd === "object" && typeof cd.replication === "object" ? cd.replication : {};
  const enabled = typeof r.enabled === "boolean" ? r.enabled : true;
  const rawCap = typeof r.winner_share_cap === "number" && r.winner_share_cap >= 0 ? r.winner_share_cap : HARD_SHARE_CAP;
  return { enabled, cap: Math.max(0, Math.min(HARD_SHARE_CAP, rawCap)) };
}

/** What the designer should do this batch. Mirrors replicate.py current_directive. */
export function currentDirective(): ReplicationDirective {
  const { enabled, cap } = policyEnabledAndCap();
  const { active } = loadLedger();
  const a = active as any;
  if (!enabled) return { active: false, share: 0, share_cap: cap, reason: "replication disabled in content-defaults.json" };
  if (!a || typeof a !== "object" || (a.status !== "active" && a.status !== "escalated")) {
    return { active: false, share: 0, share_cap: cap, reason: "no active replication round" };
  }
  const recorded = typeof a.share === "number" ? a.share : 0;
  const roundCap = typeof a.share_cap === "number" ? a.share_cap : cap;
  const share = Math.max(0, Math.min(recorded, roundCap, cap));
  return {
    active: share > 0,
    key: String(a.key ?? ""),
    fingerprint: a.fingerprint,
    share,
    share_cap: cap,
    round: a.round,
    status: a.status,
    confidence: a.confidence,
    opened_at: a.opened_at,
    evaluate_after: a.evaluate_after,
    vary_only: Array.isArray(a.vary_only) ? a.vary_only : undefined,
    evidence: a.evidence,
    reason: share > 0 ? "replicating a reach outlier" : "round open but share is 0",
  };
}

/**
 * How many of `target` slots the winning style may take.
 *
 * Floors (never rounds up) so the exploration remainder can only ever be larger
 * than the cap promises, and always leaves at least one exploration slot when the
 * batch has room for one — a batch that is 100% replication is the failure mode the
 * cap exists to prevent.
 */
export function replicaCount(target: number, directive: ReplicationDirective = currentDirective()): number {
  if (!directive.active || target <= 0) return 0;
  const byShare = Math.floor(target * directive.share);
  const byCap = Math.floor(target * Math.min(directive.share_cap, HARD_SHARE_CAP));
  const n = Math.min(byShare, byCap);
  return Math.max(0, Math.min(n, target - 1));
}

/** Does a freshly designed video match the style being replicated? */
export function matchesFingerprint(
  candidate: { leadType?: unknown; numQuestions?: number; family?: string; narration?: string; ending?: string },
  fp: StyleFingerprint | undefined,
): boolean {
  if (!fp) return false;
  if (normalizeTier(candidate.leadType) !== normalizeTier(fp.lead_type)) return false;
  if (fp.num_questions > 0 && candidate.numQuestions !== fp.num_questions) return false;
  return true;
}
