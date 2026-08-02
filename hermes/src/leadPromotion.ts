/**
 * leadPromotion.ts — run the opening-question policy every cycle, and leave a ledger.
 *
 * This is the half of the loop that was missing. The A/B promotion engine was stood down
 * in the exploitation pivot, correctly — it compared arms and there are no arms left —
 * but nothing replaced it, so nothing was turning measurement back into a decision.
 *
 * THREE THINGS THE OLD ENGINE GOT WRONG, and what is different here:
 *
 *   It never ran. It was registered as a skill and nothing invoked it; it fired zero
 *   times and nobody noticed for weeks. This is called directly from runCycle() between
 *   scoring and planning, on the same systemd timer as everything else, and its verdict
 *   is written into the run state whether it moved anything or not.
 *
 *   It was invisible. There was no record of what it had considered. Every run appends
 *   to ab-testing/lead-policy.json: the full evidence table, the shares that resulted,
 *   and the previous shares it replaced. `history` is what makes it reversible.
 *
 *   It judged on a metric the account had already abandoned. This judges on the 3-second
 *   skip rate, which is the one measure that predicts reach here.
 *
 * INSTAGRAM ONLY, AND SAID SO OUT LOUD. Skip rate exists on Instagram and nowhere else:
 * Metricool declares four TikTok watch-time fields and returns null on every row, and the
 * YouTube payload has no drop-off field at all. So the evidence below is Instagram's
 * alone, and the resulting mix is applied to all three networks. That is a real
 * limitation rather than a rounding of the truth, and the ledger and the dashboard both
 * carry it in words.
 */
import { readJSON, writeJSONAtomic } from "./state.ts";
import { CONFIG } from "./config.ts";
import { info, decision, warn } from "./log.ts";
import {
  LEAD_BANDS, MIN_POSTS_PER_BAND, bandOf, promptWords, computeLeadPolicy,
  type LeadBand, type LeadEvidenceRow, type LeadPolicy,
} from "./leadPolicy.ts";

/** One matured post's contribution to the evidence, kept for auditability. */
export interface LeadEvidenceDetail extends LeadEvidenceRow {
  post_id: string;
  words: number;
  type: string | null;
  /** how the opening question was recovered — stamped | ledger | type */
  via: string;
}

export interface LeadPolicyLedger {
  updated_at: string;
  run_id: string;
  /** Instagram-only, and the ledger says so rather than implying three networks voted. */
  evidence_source: string;
  policy: LeadPolicy;
  detail: LeadEvidenceDetail[];
  history: Array<{
    at: string;
    run_id: string;
    shares: Record<string, number>;
    applied: boolean;
    note: string;
  }>;
}

const norm = (s: unknown): string =>
  String(s ?? "").trim().toUpperCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ");

const TYPE_ALIASES: Record<string, string> = {
  "WORD ANALOGY": "VERBAL ANALOGY",
  "FILL IN THE BLANK": "SENTENCE COMPLETION",
  "DOT POSITION": "POSITION",
  "VISUAL ODD ONE OUT": "FIGURE ODD ONE OUT",
};

/** Canonical question-type label. The db carries both cased and hyphenated spellings. */
export function normType(t: unknown): string {
  const n = norm(t);
  return TYPE_ALIASES[n] ?? n;
}

/** The opening question, as the fields a post record carries about it. */
export interface LeadStamp {
  lead_type: string;
  lead_prompt_words: number;
  lead_band: string;
}

/**
 * What the loop writes about question one when it publishes.
 *
 * ONE definition, because these three fields have to agree with each other and with the
 * bands the policy later reads: lead_band must be bandOf(lead_prompt_words), and it is
 * the kind of pair that drifts the moment it is spelled out twice at the call site.
 *
 * Stamping is not a convenience. Both of leadWordsFor's fallbacks re-derive a post's
 * length from the CURRENT bank, so once bank prompts became editable (the 2026-08-02
 * shortening) an unstamped post would silently report today's wording rather than the
 * wording it actually shipped with. The stamp is what makes a published post's evidence
 * immutable.
 */
export function leadStamp(q: { tier?: string; prompt?: string } | undefined): LeadStamp {
  const words = promptWords(q?.prompt);
  return { lead_type: normType(q?.tier), lead_prompt_words: words, lead_band: bandOf(words) };
}

interface BankEntry { sig: string; tier?: string; prompt?: string; promptNorm?: string }

/**
 * type -> prompt word count, derived from the bank itself rather than hardcoded.
 *
 * The bank uses ONE fixed prompt per type, so this is a lookup and not an estimate for
 * all but four types (sentence completion, word problem, logic, compare) where the
 * authored prompts vary; those take the median, which is why a post recovered this way
 * is tagged `via: "type"` and can be told apart from an exact one in the ledger.
 */
export function typeWordTable(entries: BankEntry[]): Record<string, number> {
  const acc: Record<string, number[]> = {};
  for (const e of entries) {
    const t = normType(e.tier);
    if (!t) continue;
    (acc[t] = acc[t] ?? []).push(promptWords(e.prompt ?? e.promptNorm));
  }
  const out: Record<string, number> = {};
  for (const [t, ws] of Object.entries(acc)) {
    const s = ws.sort((a, b) => a - b);
    out[t] = s[s.length >> 1];
  }
  return out;
}

export interface RecoveryCtx {
  bySig: Map<string, BankEntry>;
  bySlug: Map<string, { questions?: Array<{ sig?: string; tier?: string }> }>;
  typeWords: Record<string, number>;
}

/**
 * The lookup tables leadWordsFor recovers against, built from the repo's own files.
 *
 * Exported because ops/freeze_lead_words.mjs has to recover the SAME way this module
 * does — a second copy of the three-way logic that drifted would silently mis-stamp the
 * history it exists to protect.
 */
export function buildRecoveryCtx(): RecoveryCtx {
  const bank = readJSON<{ entries?: BankEntry[] }>(CONFIG.BANK, {});
  const usage = readJSON<{ videos?: Array<{ videoSlug?: string; questions?: Array<{ sig?: string; tier?: string }> }> }>(CONFIG.USAGE, {});
  const entries = Array.isArray(bank.entries) ? bank.entries : [];
  return {
    bySig: new Map(entries.map((e) => [e.sig, e])),
    bySlug: new Map((usage.videos ?? []).filter((v) => v.videoSlug).map((v) => [String(v.videoSlug), v])),
    typeWords: typeWordTable(entries),
  };
}

/**
 * The opening question's prompt length for one ab-database post, tried three ways.
 *
 * Ordered most-exact first, and every path is recorded, so thin evidence is visible as
 * thin rather than averaged in silently:
 *   stamped — the loop wrote it at publish time (every post from this change onward)
 *   ledger  — _hermes_key -> ab-test-usage.json -> the bank entry that actually shipped
 *   type    — variant.question_types[0] -> the bank's per-type prompt length
 *
 * STAMPED IS NOW LOAD-BEARING, NOT MERELY MORE EXACT. Both fallbacks resolve a post's
 * word count out of the CURRENT bank, which was safe only while the bank's prompts never
 * changed. They do now: the 2026-08-02 shortening rewrote five types' prompts, so a post
 * published under the old 15-word number analogy would come back from the ledger path as
 * a 12-word one and the evidence would quietly restate itself as "everything was always
 * short" — erasing the contrast the policy is built on. ops/freeze_lead_words.mjs
 * therefore stamped every already-published post BEFORE that rewrite. Any future edit to
 * bank prompts must do the same, or it silently rewrites history instead of making it.
 */
export function leadWordsFor(p: any, ctx: RecoveryCtx): { words: number; type: string | null; via: string } | null {
  const v = p?.variant ?? {};
  if (Number.isInteger(v.lead_prompt_words) && v.lead_prompt_words > 0) {
    return { words: v.lead_prompt_words, type: v.lead_type ?? null, via: "stamped" };
  }
  const key = String(p?._hermes_key ?? "");
  if (key.startsWith("hermes:")) {
    const slug = key.split(":")[1];
    const u = ctx.bySlug.get(slug);
    const q0 = u?.questions?.[0];
    if (q0?.sig) {
      const e = ctx.bySig.get(q0.sig);
      if (e) return { words: promptWords(e.prompt ?? e.promptNorm), type: normType(e.tier ?? q0.tier), via: "ledger" };
    }
  }
  const qt = Array.isArray(v.question_types) ? v.question_types : [];
  if (qt.length) {
    const t = normType(qt[0]);
    const w = ctx.typeWords[t];
    if (Number.isFinite(w) && w > 0) return { words: w, type: t, via: "type" };
  }
  return null;
}

/**
 * Every matured INSTAGRAM post we can attribute to its opening question.
 *
 * "Matured" means a skip rate has actually arrived. Metrics lag 4-14 hours, so a post
 * scheduled today contributes nothing today — and a missing skip rate is treated as
 * unknown rather than as a perfect hook (see score.ts: TikTok's null must never become a
 * zero). Reads only files that are already in the repo, so the evidence rebuilds itself
 * every cycle and cannot drift away from what the loop actually published.
 */
export function buildLeadEvidence(): { rows: LeadEvidenceDetail[]; considered: number } {
  const db = readJSON<any>(CONFIG.AB_DB, null);
  const ctx = buildRecoveryCtx();

  const rows: LeadEvidenceDetail[] = [];
  let considered = 0;
  for (const p of (db?.posts ?? []) as any[]) {
    if (p?.platform !== "instagram") continue;
    const skip = p?.metrics?.skip_rate;
    if (typeof skip !== "number" || !Number.isFinite(skip)) continue;
    considered++;
    const lead = leadWordsFor(p, ctx);
    if (!lead) continue;
    rows.push({
      post_id: String(p.platform_post_id ?? p._hermes_key ?? p.metricool_uuid ?? ""),
      band: bandOf(lead.words),
      skip,
      words: lead.words,
      type: lead.type,
      via: lead.via,
    });
  }
  return { rows, considered };
}

/** True unless HERMES_LEAD_WEIGHTING is explicitly "off"/"false"/"0". */
export function weightingEnabled(): boolean {
  const v = String(process.env.HERMES_LEAD_WEIGHTING ?? "on").trim().toLowerCase();
  return v !== "off" && v !== "false" && v !== "0";
}

export interface LeadPromotionResult {
  applied: boolean;
  shares: Record<LeadBand, number>;
  n_posts: number;
  changed: boolean;
  note: string;
  bands: Array<{ band: string; n: number; median: number | null; share: number; passes: boolean }>;
}

/**
 * Compute the policy, write the ledger, log the verdict. Called once per cycle.
 *
 * NEVER THROWS PAST THE CALLER'S TRY: a promotion engine is an optimiser, and an
 * optimiser that can stop the day's posting is a worse bug than a stale mix. On any
 * failure the caller keeps going and planBatch falls back to the uniform draw.
 */
export function runLeadPromotion(runId: string): LeadPromotionResult {
  const { rows, considered } = buildLeadEvidence();
  const enabled = weightingEnabled();
  const policy = computeLeadPolicy(rows, { enabled });

  const prev = readJSON<LeadPolicyLedger | null>(CONFIG.LEAD_POLICY, null);
  const prevShares = prev?.policy?.shares;
  const changed =
    !prevShares || LEAD_BANDS.some((b) => Math.abs((prevShares as any)[b] - policy.shares[b]) > 0.005);

  const history = Array.isArray(prev?.history) ? prev!.history : [];
  if (prev?.policy && changed) {
    history.push({
      at: prev.updated_at,
      run_id: prev.run_id,
      shares: prev.policy.shares,
      applied: prev.policy.applied,
      note: prev.policy.note,
    });
  }

  const ledger: LeadPolicyLedger = {
    updated_at: new Date().toISOString(),
    run_id: runId,
    evidence_source:
      "INSTAGRAM ONLY. The 3-second skip rate is the only retention metric that exists on this account: " +
      "Metricool returns null for every TikTok watch-time field and the YouTube payload has no drop-off " +
      "field at all. The mix decided here is applied to all three networks, but only Instagram voted.",
    policy,
    detail: rows,
    history: history.slice(-40),
  };
  try {
    writeJSONAtomic(CONFIG.LEAD_POLICY, ledger);
  } catch (e) {
    warn("lead-policy ledger write failed (continuing)", { err: e instanceof Error ? e.message : String(e) });
  }

  const bands = policy.bands.map((b) => ({ band: b.label, n: b.n, median: b.median, share: b.share, passes: b.passes }));
  info("lead-opening policy", {
    matured_ig_posts: considered,
    attributed: rows.length,
    applied: policy.applied,
    shares: policy.shares,
  });
  const mix = policy.bands.map((b) => `${b.label} ${Math.round(b.share * 100)}%`).join(" / ");
  decision(
    policy.applied
      ? `OPENING MIX (Instagram skip rate, n=${rows.length}): ${mix}. ${policy.note}`
      : `OPENING MIX left even (${mix}): ${policy.note}`,
  );
  return { applied: policy.applied, shares: policy.shares, n_posts: rows.length, changed, note: policy.note, bands };
}

/**
 * The shares the designer should use right now, read from the ledger.
 *
 * Falls back to an even draw if the ledger is missing, malformed or the switch is off, so
 * design.ts never depends on this having run.
 */
export function currentLeadShares(): { shares: Record<LeadBand, number>; applied: boolean; note: string } {
  const even = { short: 1 / 3, medium: 1 / 3, long: 1 / 3 };
  if (!weightingEnabled()) {
    return { shares: even, applied: false, note: "HERMES_LEAD_WEIGHTING=off" };
  }
  const led = readJSON<LeadPolicyLedger | null>(CONFIG.LEAD_POLICY, null);
  const s = led?.policy?.shares;
  if (!s || !LEAD_BANDS.every((b) => Number.isFinite((s as any)[b]))) {
    return { shares: even, applied: false, note: "no lead-policy ledger yet" };
  }
  return { shares: s as Record<LeadBand, number>, applied: !!led?.policy?.applied, note: led?.policy?.note ?? "" };
}

export { MIN_POSTS_PER_BAND };
