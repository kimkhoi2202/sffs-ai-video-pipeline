/**
 * gates.ts — HARD QUALITY GATES. Nothing becomes a draft unless it passes. Every
 * gate result is logged and stored on the video plan for the dashboard. Failures
 * cause reject+regenerate (copy) or drop (questions/render). Quality > volume.
 *
 * Gates:
 *   1. Question dedup — never repeat a question (verified against the used ledger).
 *   2. Question validity (LLM rubric, cached) — exactly one unambiguous correct
 *      answer, correct + factual, grade-appropriate difficulty, plausible distractors.
 *      When the judge is UNREACHABLE it degrades to a deterministic structural check
 *      rather than throwing (an outage must not cost the day its throughput).
 *   3. Copy brand-voice + kid-safe — deterministic rules + LLM judge.
 *   4. Render sanity — 1080x1920, video+audio streams present, duration as expected.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chatJSON } from "./llm.ts";
import { loadBrandVoice, ruleCheckCopy } from "./brand.ts";
import { readJSON, writeJSONAtomic, isShapeKind, type HermesQ, type GateResult } from "./state.ts";
import { loadUsedSigs, loadUsedSigOwners, loadUsedFuzzySigs, fuzzySig, shapeStructuralIssue, textStructuralIssue } from "./questions.ts";
import { quantVerdict } from "./arithmetic.ts";
import { CONFIG } from "./config.ts";
import { gate, warn } from "./log.ts";
import { join } from "node:path";

const FFPROBE = process.env.FFPROBE || "/usr/local/bin/ffprobe";

// ── Gate 1: dedup ────────────────────────────────────────────────────────────
/**
 * `selfId` is the video being gated. Questions this ledger says THIS video already
 * claimed are not duplicates of anything — they are its own unshipped claim from an
 * earlier attempt, and treating them as duplicates is what turned a mid-flight crash
 * into a permanent rejection (see questions.ts loadUsedSigOwners). Omit it and the gate
 * behaves exactly as before, which is what the batch-planning caller wants.
 */
export function gateDedup(questions: HermesQ[], claimedThisBatch: Set<string>, selfId?: string): GateResult {
  const used = loadUsedSigs();
  const owners = selfId ? loadUsedSigOwners() : null;
  const ownedBySelf = (sig: string): boolean => Boolean(selfId) && owners?.get(sig) === selfId;
  const dupUsed = questions.filter((q) => used.has(q.sig) && !ownedBySelf(q.sig)).map((q) => q.sig);
  const dupBatch = questions.filter((q) => claimedThisBatch.has(q.sig)).map((q) => q.sig);
  const internal = new Set<string>();
  const dupInternal: string[] = [];
  for (const q of questions) {
    if (internal.has(q.sig)) dupInternal.push(q.sig);
    internal.add(q.sig);
  }
  // SECOND key: fuzzy near-duplicate guard (paraphrase / reordered options /
  // same-structure series) that the exact sig above is blind to. Additive only —
  // exact-dup sigs are NOT re-reported here, so the exact reason is unchanged when
  // there are no *new* near-dups. See questions.ts fuzzySig for the (conservative)
  // structural key.
  const exactDup = new Set<string>([...dupUsed, ...dupBatch, ...dupInternal]);
  const usedFuzzy = loadUsedFuzzySigs();
  const seenFuzzy = new Set<string>();
  const nearDup: string[] = [];
  for (const q of questions) {
    const f = fuzzySig(q);
    const isNear = usedFuzzy.has(f) || seenFuzzy.has(f);
    seenFuzzy.add(f);
    // Self-owned questions seeded usedFuzzy themselves, so without this a retry trades
    // "duplicate" for "near_duplicate" and is rejected all the same.
    if (isNear && !exactDup.has(q.sig) && !ownedBySelf(q.sig)) nearDup.push(q.sig);
  }
  const reasons: string[] = [];
  if (exactDup.size) reasons.push("duplicate question(s) detected");
  if (nearDup.length) reasons.push("near_duplicate question(s) detected");
  const pass = reasons.length === 0;
  return {
    pass,
    reason: pass ? "all questions fresh + unique" : reasons.join("; "),
    detail: { dupUsed, dupBatch, dupInternal, nearDup },
  };
}

// ── Gate 2: question validity ────────────────────────────────────────────────
//
// THREE DECIDERS, in order of authority:
//
//   1. nonverbal shape/figure questions  -> shapeStructuralIssue (options are
//      figures, so the verbal rubric does not apply);
//   2. NUMBER PUZZLE / NUMBER ANALOGY    -> arithmetic.ts, by enumeration;
//   3. everything else                   -> the LLM rubric, cached by hash.
//
// Layer 2 is new and it is why this gate stopped throwing away good questions.
// The rubric was asked to decide, in one pass, whether a hidden-operator puzzle
// has a unique solution — a search problem — and it answered before it had done
// the search. Its verdicts and its own rationales disagreed: "Rule 3->7, 5->13,
// 6->16, 7->? uses 3n-2 ... Correct, single answer", marked INVALID. Between
// 2026-07-30 and 2026-08-02 that pattern cost 29 of 35 rejections, and re-deciding
// those items by enumeration rescued 21 of 23 while upholding 2 real defects.
//
// The fix has two halves and both matter. Layer 2 removes the arithmetic from the
// model's job entirely. The prompt below then fixes the shape of what is left:
// the model must write its ANALYSIS and name its ISSUES before it may state a
// VERDICT, and an "invalid" that names no issue is not a rejection — it is a
// contradiction, and it fails OPEN (see reconcileVerdict). A question whose own
// rationale says it is fine is never discarded again.
interface QVerdict {
  valid: boolean;
  reason: string;
  difficulty?: string;
  /**
   * NOT INVALID — UNJUDGED. Set only when no model could be reached, so the question
   * was held back without any opinion being formed about it.
   *
   * The distinction is load-bearing rather than cosmetic: cycle.ts QUARANTINES the
   * questions behind a failed validity gate, and quarantine is permanent. Without this
   * flag, one shared-budget 429 storm would bury every question it touched — on
   * 2026-07-25 that would have been 28 of 29, and on 2026-07-29 20 of 21. The storm
   * costs a day of POSTING; it must never cost the bank its content.
   */
  unjudged?: boolean;
}

/**
 * Cache generation. BUMP THIS whenever the rubric's contract changes: cached
 * verdicts were produced under the OLD contract and a stale "invalid" would keep
 * a good question buried forever, which is precisely how the answer-before-
 * reasoning bug survived across cycles instead of being one bad afternoon.
 */
const QCACHE_GENERATION = 2;

interface QCacheFile {
  generation?: number;
  verdicts?: Record<string, QVerdict>;
}

function loadQCache(): Record<string, QVerdict> {
  const raw = readJSON<QCacheFile | Record<string, QVerdict>>(join(CONFIG.CACHE_DIR, "qvalidation.json"), {});
  const asFile = raw as QCacheFile;
  if (asFile && typeof asFile === "object" && "generation" in asFile) {
    return asFile.generation === QCACHE_GENERATION ? { ...(asFile.verdicts ?? {}) } : {};
  }
  // Generation 1 wrote bare hash -> verdict with no envelope. Those verdicts came
  // from the broken contract, so they are dropped rather than migrated.
  return {};
}
function saveQCache(c: Record<string, QVerdict>): void {
  writeJSONAtomic(join(CONFIG.CACHE_DIR, "qvalidation.json"), { generation: QCACHE_GENERATION, verdicts: c });
}

/** One rubric row, in the order the model must produce it. */
interface RubricRow {
  index: number;
  analysis?: string;
  issues?: unknown;
  verdict?: string;
  difficulty?: string;
}

/**
 * Turn one rubric row into a verdict, refusing to honour a self-contradiction.
 *
 * The contract makes `issues` the EVIDENCE for an "invalid" verdict, so an invalid
 * that names no issue has no evidence behind it. That is not a close call to
 * adjudicate with string matching — it is a structurally incomplete answer, and the
 * only safe reading of it is that the model reached "invalid" before it had looked.
 * Those fail OPEN and are logged, because an item whose own rationale argues it is
 * valid must not be discarded.
 */
export function reconcileVerdict(row: RubricRow): { verdict: QVerdict; contradiction: boolean } {
  const issues = Array.isArray(row.issues)
    ? row.issues.map((i) => String(i ?? "").trim()).filter(Boolean)
    : String(row.issues ?? "").trim() ? [String(row.issues).trim()] : [];
  const analysis = String(row.analysis ?? "").trim();
  const said = String(row.verdict ?? "").trim().toLowerCase();
  // Accept the vocabulary the model actually uses; anything unrecognised is treated
  // as "not stated", which then hinges on whether it found an issue.
  const saidInvalid = said === "invalid" || said === "false" || said === "no";
  const saidValid = said === "valid" || said === "true" || said === "yes";

  if (saidInvalid && issues.length === 0) {
    return {
      contradiction: true,
      verdict: {
        valid: true,
        reason: `judge said invalid but named no issue — kept (analysis: ${analysis.slice(0, 300) || "none given"})`,
        difficulty: row.difficulty,
      },
    };
  }
  const valid = saidValid ? true : saidInvalid ? false : issues.length === 0;
  return {
    contradiction: false,
    verdict: {
      valid,
      // 400, not 200: the 200-char cut truncated the rationales mid-sentence and hid
      // the contradiction ("...however verify: yes 65 corre") for three days.
      reason: (valid ? analysis || "valid" : issues.join("; ") || analysis || "invalid").slice(0, 400),
      difficulty: row.difficulty,
    },
  };
}

export async function validateQuestions(
  questions: HermesQ[],
): Promise<{ results: Record<string, QVerdict>; gate: GateResult }> {
  const cache = loadQCache();
  const results: Record<string, QVerdict> = {};
  /** Verdicts from the deterministic fail-safe. Kept OUT of the persisted cache. */
  const fallback: Record<string, QVerdict> = {};
  let rubricUnavailable = false;

  // Nonverbal SHAPE/FIGURE questions are validated STRUCTURALLY here — their
  // options are figures (not text), so the verbal/number LLM rubric below does
  // not apply. shapeStructuralIssue is total (never throws) so this can't crash;
  // a malformed figure fails closed with its reason.
  const rubricQuestions = questions.filter((q) => !isShapeKind(q.kind));
  for (const q of questions) {
    if (!isShapeKind(q.kind)) continue;
    const issue = shapeStructuralIssue(q);
    results[q.sig] = issue
      ? { valid: false, reason: issue }
      : { valid: true, reason: "structural shape check passed", difficulty: q.figure?.difficulty };
  }

  // DECIDED BY ENUMERATION, not by the model: the hidden-operator tiers. See
  // arithmetic.ts. Deliberately NOT cached — it is a pure function of the question,
  // so a cache would only add a way for a stale verdict to outlive a fixed rule set.
  const decided = new Map<string, QVerdict>();
  for (const q of rubricQuestions) {
    const v = quantVerdict(q);
    if (v.handled) decided.set(q.sig, { valid: v.valid, reason: v.reason });
  }

  const todo = rubricQuestions.filter((q) => !decided.has(q.sig) && !cache[q.hash]);

  if (todo.length) {
    const payload = todo.map((q, i) => ({
      index: i,
      tier: q.tier,
      kind: q.kind,
      prompt: q.prompt,
      options: q.options,
      sequence: q.seq,
      stated_answer: q.answer,
    }));
    const system =
      "You are a rigorous quiz-QA reviewer for a kids/teens brain-quiz brand (CogAT-style: verbal analogies, " +
      "odd-one-out, sentence completion, number series). Reject what would genuinely confuse a learner, and " +
      "ONLY that. A question that is solvable and has one correct answer is VALID even if it is hard, and " +
      "'the rule is non-obvious' or 'this is tricky' is NOT a defect — difficulty is the product.";
    // ORDER IS THE CONTRACT. `analysis` and `issues` come BEFORE `verdict` so the
    // model has to do the work before it commits, and `issues` is the evidence the
    // verdict rests on. The previous contract put the boolean first, which made every
    // rejection a guess the model then talked itself out of inside the reason string.
    const user =
      "For EACH question, in this exact order: (1) `analysis` — work the question out and say what the answer " +
      "is and why; (2) `issues` — an array naming every CONCRETE defect you found, from: more than one option " +
      "is correct, the stated_answer is wrong, no option is correct, a distractor is also correct, the item is " +
      "self-contradictory, or it is far outside ages 8-16. Empty array if there are none; (3) `verdict` — " +
      '"invalid" ONLY if `issues` is non-empty, otherwise "valid"; (4) `difficulty` — easy|medium|hard|off.\n' +
      "Do not put a verdict in the analysis, and never return an empty `issues` alongside an invalid verdict.\n" +
      'Return JSON {"results":[{"index":number,"analysis":"...","issues":[],"verdict":"valid|invalid","difficulty":"..."}]}.\n\n' +
      JSON.stringify(payload);
    try {
      const resp = await chatJSON<{ results: RubricRow[] }>(system, user, {
        model: CONFIG.MODEL,
        // A shared-pool 429 on the reasoning model is not a verdict on these questions.
        // Take a cheaper real opinion before degrading to the structural check.
        fallbackModel: CONFIG.JUDGE_FALLBACK_MODEL,
        // The analysis field is the whole point of the new contract, so the budget has
        // to fit one per question. At 1600 a full batch truncated the JSON, which
        // extractJSON then rejected outright and charged to the structural fallback.
        maxTokens: 6000,
      });
      let contradictions = 0;
      for (const r of resp.results ?? []) {
        const q = todo[r.index];
        if (!q) continue;
        const { verdict, contradiction } = reconcileVerdict(r);
        if (contradiction) contradictions++;
        cache[q.hash] = verdict;
      }
      if (contradictions) {
        warn(`question-validity: ${contradictions} self-contradicting verdict(s) kept rather than discarded`, {
          of: todo.length,
        });
      }
      // any todo the model skipped -> treat as invalid (fail closed)
      for (const q of todo) if (!cache[q.hash]) cache[q.hash] = { valid: false, reason: "no verdict returned (fail-closed)" };
      saveQCache(cache);
    } catch (e) {
      // BOTH MODELS ARE UNREACHABLE (gateway 429/5xx/timeout) — not a verdict on the
      // questions. This used to admit them on the deterministic structural check alone,
      // and that was the wrong trade.
      //
      // WHAT THE STRUCTURAL CHECK CAN AND CANNOT DO. It enforces exactly-one-option-
      // matching-the-stated-answer, the length budgets and option sanity. It cannot
      // read. It has no way to know whether the stated answer is CORRECT, so a question
      // asserting that 48 has an odd digit sum passes it perfectly — four options, one
      // matching "48", nothing structurally wrong. That exact item was produced during
      // generation testing on 2026-08-03 and would have shipped.
      //
      // WHY THE TRADE FLIPPED. The old reasoning was that a judge outage should not cost
      // the day its posting, which is true as far as it goes. But the two outcomes are
      // not comparable: a missed day costs twelve posts out of a fourteen-day campaign
      // and the questions return to the pool untouched, whereas a wrong answer key is
      // published to an audience, cannot be recalled, and is the one defect a quiz brand
      // cannot afford. On 2026-07-25 this path admitted 28 of 29 questions with no
      // semantic check at all, and 20 of 21 on 2026-07-29.
      //
      // WHAT STILL GETS THROUGH, because it does not need a model. Shape/figure kinds
      // never reach here (validated structurally by design — their options are figures).
      // NUMBER PUZZLE and NUMBER ANALOGY are DECIDED by enumeration in arithmetic.ts and
      // take precedence in the merge below; those are proofs, not opinions. What is held
      // back is exactly the set a structural check cannot speak to: the verbal and
      // reading-dependent types.
      //
      // AND CRUCIALLY, HELD BACK IS NOT REJECTED. `unjudged` tells cycle.ts not to
      // quarantine these, and fallback verdicts are still never cached, so tomorrow's
      // healthy cycle judges the same questions properly and they ship then.
      rubricUnavailable = true;
      const why = e instanceof Error ? e.message : String(e);
      for (const q of todo) {
        const issue = textStructuralIssue(q);
        fallback[q.hash] = issue
          ? { valid: false, reason: `structural: ${issue}` }
          : {
              valid: false,
              unjudged: true,
              reason: "no rubric verdict (both models unreachable) — held back rather than published unchecked",
            };
      }
      gate(`question-validity: LLM rubric unavailable — HOLDING BACK ${todo.length} unjudged question(s) (they return to the pool)`, {
        err: why.slice(0, 200),
      });
    }
  }

  for (const q of rubricQuestions) {
    results[q.sig] = decided.get(q.sig) ?? cache[q.hash] ?? fallback[q.hash] ?? { valid: false, reason: "uncached (fail-closed)" };
  }
  const invalid = questions.filter((q) => !results[q.sig].valid);
  const suffix = rubricUnavailable ? " (deterministic fallback; LLM rubric unavailable)" : "";
  const g: GateResult = {
    pass: invalid.length === 0,
    reason: (invalid.length === 0 ? "all questions valid" : `${invalid.length} invalid question(s)`) + suffix,
    detail: invalid.map((q) => ({ sig: q.sig, reason: results[q.sig].reason })),
  };
  return { results, gate: g };
}

// ── Gate 3: copy brand-voice + kid-safe ──────────────────────────────────────
export async function gateCopy(pieces: { label: string; text: string }[]): Promise<GateResult> {
  // deterministic rules first (fail fast, no tokens)
  const ruleViolations: Record<string, string[]> = {};
  for (const p of pieces) {
    const r = ruleCheckCopy(p.text);
    if (!r.pass) ruleViolations[p.label] = r.violations;
  }
  if (Object.keys(ruleViolations).length) {
    return { pass: false, reason: "brand hard-rule violation", detail: ruleViolations };
  }
  // LLM judgement on top
  const bv = loadBrandVoice();
  const system =
    "You are the SFFS brand-voice guardian. Voice: " +
    bv.hardRules +
    " Signature: " +
    bv.signatureDevice +
    (bv.examples.length ? " Real on-brand examples: " + bv.examples.slice(0, 20).map((e) => `"${e}"`).join("; ") : "");
  const user =
    "Judge whether ALL of these on-screen/caption pieces are on-brand, kid-safe, concise, funny, Gen-Z, " +
    "no em or en dashes, at most one emoji beyond the 🧠💨 logo, and NOT AI-slop. " +
    "IMPORTANT on claims: difficulty puffery about the PUZZLE is ALLOWED and is house style. " +
    "Do NOT flag '97% get this wrong', 'only 3% can solve this', '9 out of 10 pick B' or similar; " +
    "they need no substantiation and are the native idiom of the format. DO flag any claim about the " +
    "PRODUCT or the viewer's OUTCOME, such as '97% of users gain 20 IQ points', 'watch daily and get " +
    "smarter', 'improves memory/focus/grades', 'scientifically proven', or 'guaranteed to'. " +
    'Return JSON {"pass":boolean,"reason":"short","perPiece":[{"label":string,"ok":boolean,"issue":string}]}.\n\n' +
    JSON.stringify(pieces);
  try {
    const v = await chatJSON<{ pass: boolean; reason: string; perPiece?: any[] }>(system, user, {
      model: CONFIG.CAPTION_MODEL,
      maxTokens: 500,
    });
    return { pass: !!v.pass, reason: v.reason ?? (v.pass ? "on-brand" : "off-brand"), detail: v.perPiece };
  } catch (e) {
    // If the judge is unreachable, fall back to the deterministic pass (rules already passed).
    return { pass: true, reason: "rules passed; LLM judge unavailable", detail: { error: e instanceof Error ? e.message : String(e) } };
  }
}

// ── Gate 4: render sanity ────────────────────────────────────────────────────
export function gateRenderSanity(path: string, expectedFrames: number, fps = 30): GateResult {
  if (!existsSync(path)) return { pass: false, reason: "render file missing" };
  let probe: any;
  try {
    const out = execFileSync(
      FFPROBE,
      ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", path],
      { encoding: "utf8" },
    );
    probe = JSON.parse(out);
  } catch (e) {
    return { pass: false, reason: "ffprobe failed", detail: e instanceof Error ? e.message : String(e) };
  }
  const streams = probe.streams ?? [];
  const v = streams.find((s: any) => s.codec_type === "video");
  const a = streams.find((s: any) => s.codec_type === "audio");
  const issues: string[] = [];
  if (!v) issues.push("no video stream");
  else {
    if (Number(v.width) !== 1080) issues.push(`width ${v.width} != 1080`);
    if (Number(v.height) !== 1920) issues.push(`height ${v.height} != 1920`);
  }
  if (!a) issues.push("no audio stream (music expected)");
  const dur = Number(probe.format?.duration ?? 0);
  const expectedSec = expectedFrames / fps;
  if (!dur || Math.abs(dur - expectedSec) > 1.5) issues.push(`duration ${dur.toFixed(2)}s != ~${expectedSec.toFixed(2)}s`);
  const pass = issues.length === 0;
  const g: GateResult = {
    pass,
    reason: pass ? `ok ${v?.width}x${v?.height} ${dur.toFixed(1)}s video+audio` : issues.join("; "),
    detail: { width: v?.width, height: v?.height, duration: dur, hasAudio: !!a },
  };
  gate(`render sanity: ${g.reason}`, { path });
  return g;
}
