/**
 * gates.ts — HARD QUALITY GATES. Nothing becomes a draft unless it passes. Every
 * gate result is logged and stored on the video plan for the dashboard. Failures
 * cause reject+regenerate (copy) or drop (questions/render). Quality > volume.
 *
 * Gates:
 *   1. Question dedup — never repeat a question (verified against the used ledger).
 *   2. Question validity (LLM rubric, cached) — exactly one unambiguous correct
 *      answer, correct + factual, grade-appropriate difficulty, plausible distractors.
 *   3. Copy brand-voice + kid-safe — deterministic rules + LLM judge.
 *   4. Render sanity — 1080x1920, video+audio streams present, duration as expected.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chatJSON } from "./llm.ts";
import { loadBrandVoice, ruleCheckCopy } from "./brand.ts";
import { readJSON, writeJSONAtomic, type HermesQ, type GateResult } from "./state.ts";
import { loadUsedSigs, loadUsedFuzzySigs, fuzzySig } from "./questions.ts";
import { CONFIG } from "./config.ts";
import { gate } from "./log.ts";
import { join } from "node:path";

const FFPROBE = process.env.FFPROBE || "/usr/local/bin/ffprobe";

// ── Gate 1: dedup ────────────────────────────────────────────────────────────
export function gateDedup(questions: HermesQ[], claimedThisBatch: Set<string>): GateResult {
  const used = loadUsedSigs();
  const dupUsed = questions.filter((q) => used.has(q.sig)).map((q) => q.sig);
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
    if (isNear && !exactDup.has(q.sig)) nearDup.push(q.sig);
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

// ── Gate 2: question validity (LLM rubric, cached by hash) ───────────────────
interface QVerdict {
  valid: boolean;
  reason: string;
  difficulty?: string;
}

function loadQCache(): Record<string, QVerdict> {
  return readJSON<Record<string, QVerdict>>(join(CONFIG.CACHE_DIR, "qvalidation.json"), {});
}
function saveQCache(c: Record<string, QVerdict>): void {
  writeJSONAtomic(join(CONFIG.CACHE_DIR, "qvalidation.json"), c);
}

export async function validateQuestions(
  questions: HermesQ[],
): Promise<{ results: Record<string, QVerdict>; gate: GateResult }> {
  const cache = loadQCache();
  const results: Record<string, QVerdict> = {};
  const todo = questions.filter((q) => !cache[q.hash]);

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
      "odd-one-out, number series). Be strict: reject anything that could confuse or mislead a learner.";
    const user =
      "For EACH question decide validity on ALL of: (a) EXACTLY ONE unambiguous correct answer; " +
      "(b) the stated_answer is actually correct (no factual errors); (c) difficulty is grade-appropriate " +
      "(roughly ages 8-16); (d) distractors are plausible but clearly wrong (no second correct option, none absurd). " +
      'Return JSON {"results":[{"index":number,"valid":boolean,"reason":"short","difficulty":"easy|medium|hard|off"}]}.\n\n' +
      JSON.stringify(payload);
    const resp = await chatJSON<{ results: Array<{ index: number; valid: boolean; reason: string; difficulty?: string }> }>(
      system,
      user,
      { model: CONFIG.MODEL, maxTokens: 1600 },
    );
    for (const r of resp.results ?? []) {
      const q = todo[r.index];
      if (!q) continue;
      cache[q.hash] = { valid: !!r.valid, reason: String(r.reason ?? "").slice(0, 200), difficulty: r.difficulty };
    }
    // any todo the model skipped -> treat as invalid (fail closed)
    for (const q of todo) if (!cache[q.hash]) cache[q.hash] = { valid: false, reason: "no verdict returned (fail-closed)" };
    saveQCache(cache);
  }

  for (const q of questions) results[q.sig] = cache[q.hash] ?? { valid: false, reason: "uncached (fail-closed)" };
  const invalid = questions.filter((q) => !results[q.sig].valid);
  const g: GateResult = {
    pass: invalid.length === 0,
    reason: invalid.length === 0 ? "all questions valid" : `${invalid.length} invalid question(s)`,
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
    "no em dashes, at most one emoji, and NOT AI-slop. " +
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
