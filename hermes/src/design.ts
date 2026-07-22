/**
 * design.ts — the batch designer. Produces up to VIDEOS_PER_DAY videos, EACH a
 * DIFFERENT A/B dimension, biased by learnings.json, with FRESH questions and
 * on-brand, gated copy. Quality > volume: if a slot can't be filled with fresh
 * valid questions, it's dropped (logged), not padded with junk.
 *
 * Dimensions rotated (all faithfully renderable by the self-contained composition):
 *   progress-counter on/off, progress-counter style, answer-reveal vs no-answer,
 *   cliffhanger, tempo (fast/slow countdown), one-question vs three, question
 *   category mix (verbal / quantitative / mixed), and hook/opener style. Hashtag
 *   set (A/B/C) rotates as a secondary dimension on every video.
 *
 * The "narration" family (full / none / no-question-vo / no-options-vo) is now
 * wired into the self-contained composition: hermes/src/render.ts synthesizes the
 * cloned-voice VO (voice/tts_batch.py) per question and HermesQuiz muxes it, so
 * these arms render on the loop's own path (no dependency on render-ab.ts).
 */
import { readJSON, type HermesQ, type VideoPlan } from "./state.ts";
import { candidateQuestions } from "./questions.ts";
import { gateCopy } from "./gates.ts";
import { chat } from "./llm.ts";
import { ruleCheckCopy } from "./brand.ts";
import { CONFIG } from "./config.ts";
import { info, decision, warn } from "./log.ts";
import { type NarrationMode } from "./narration.ts";

type RevealMode = "all" | "none" | "last";

interface DimSpec {
  dimension: string;
  arm: string;
  rationale: string;
  numQ: number;
  category: "verbal" | "quantitative" | "mixed";
  kinds?: Array<"text" | "numseries">;
  showProgress: boolean;
  progressStyle: "short" | "full";
  reveal: RevealMode;
  countdownSec: number;
  hook?: { title: string; subtitle: string };
  narration?: NarrationMode; // cloned-voice VO arm (default: none = music-only)
}

const BASE = {
  numQ: 3,
  category: "mixed" as const,
  showProgress: true,
  progressStyle: "short" as const,
  reveal: "all" as RevealMode,
  countdownSec: 5,
};

/** The rotating dimension catalog. Each entry varies ONE axis off the baseline. */
const DIMENSIONS: DimSpec[] = [
  { ...BASE, dimension: "progress-counter", arm: "hidden", rationale: "retention test: hide the QUESTION x/N pill", showProgress: false },
  { ...BASE, dimension: "progress-counter", arm: "verbose", rationale: "retention test: full 'QUESTION 1 OF 3' vs short 'Q1'", progressStyle: "full" },
  { ...BASE, dimension: "answer-reveal", arm: "no-answer", rationale: "comment-for-answer hook: drop the reveal", reveal: "none" },
  { ...BASE, dimension: "cliffhanger", arm: "last-hidden", rationale: "reveal all but the last -> comment CTA", reveal: "last" },
  { ...BASE, dimension: "tempo", arm: "fast-3s", rationale: "speed test: 3s countdown (faster pace)", countdownSec: 3 },
  { ...BASE, dimension: "tempo", arm: "slow-7s", rationale: "patience test: 7s countdown (more solve time)", countdownSec: 7 },
  { ...BASE, dimension: "length", arm: "one-question", rationale: "single-question payoff vs three", numQ: 1 },
  { ...BASE, dimension: "category-mix", arm: "verbal-only", rationale: "verbal-only (odd-one-out / analogy)", category: "verbal", kinds: ["text"] },
  { ...BASE, dimension: "category-mix", arm: "quant-only", rationale: "quantitative-only (number series)", category: "quantitative", kinds: ["numseries"] },
  {
    ...BASE,
    dimension: "hook",
    arm: "challenge-opener",
    rationale: "hard-challenge opener vs neutral opener",
    hook: { title: "ONLY 1% PASS", subtitle: "can you get all 3?" },
  },
  // ── Narration family (cloned-voice VO on/off) — the "don't narrate" A/B test.
  // Verbal/text 3Q so every question has A–D options (clean stem vs options split).
  { ...BASE, dimension: "narration", arm: "full-narration", rationale: "host reads each question + options aloud (cloned voice) vs silent baseline", narration: "full", category: "verbal", kinds: ["text"] },
  { ...BASE, dimension: "narration", arm: "no-narration", rationale: "music-only control (no voiceover)", narration: "none", category: "verbal", kinds: ["text"] },
  { ...BASE, dimension: "narration", arm: "no-question-vo", rationale: "voice the OPTIONS only; the question shows but is not read", narration: "no-question-vo", category: "verbal", kinds: ["text"] },
  { ...BASE, dimension: "narration", arm: "no-options-vo", rationale: "voice the QUESTION only; the options show but are not read", narration: "no-options-vo", category: "verbal", kinds: ["text"] },
  { ...BASE, dimension: "control", arm: "baseline", rationale: "baseline: short counter, reveal all, 5s, mixed 3Q" },
];

function seededOrder<T>(arr: T[], seed: number): T[] {
  const a = arr.slice();
  let s = seed >>> 0;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function seedOf(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) (h ^= s.charCodeAt(i)), (h = Math.imul(h, 16777619));
  return h >>> 0;
}

function defaultOutro(reveal: RevealMode): string {
  return reveal === "none" ? "comment your answer \uD83D\uDC47 follow for more" : "comment your score \uD83D\uDC47 follow for more";
}
function fallbackCaption(reveal: RevealMode, tags: string[]): string {
  const ask = reveal === "none" ? "comment your answer" : "comment your score";
  return `are you a SMART fella or a FART smella? ${ask} below and follow for more \uD83D\uDC47\n\n${tags.join(" ")}`;
}

/** Generate an on-brand caption, gated + reject/regenerate, safe fallback. */
async function makeCaption(spec: DimSpec, tags: string[]): Promise<{ caption: string; source: string }> {
  const ask = spec.reveal === "none" ? "comment your ANSWER" : "comment your SCORE";
  const system =
    "You write captions for 'Smart Fella or Fart Smella', a Gen-Z brain-quiz brand. Voice: concise, funny, " +
    "lowercase-casual, kid-safe, NO em dashes, at most ONE emoji, no AI-slop, always end with a follow/come-back nudge. " +
    "Signature: SMART FELLA (smart) vs FART SMELLA (miss).";
  const user =
    `Write ONE short TikTok/Reels caption (max 180 chars, before hashtags) for a quiz short. It must nudge viewers to ${ask} ` +
    `and to follow. Do NOT include hashtags. Return ONLY the caption text.`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      let text = (await chat(system, user, { model: CONFIG.CAPTION_MODEL, maxTokens: 120, temperature: 0.8 })).trim();
      text = text.replace(/^["']|["']$/g, "").replace(/#[\w]+/g, "").trim();
      const rule = ruleCheckCopy(text);
      if (!rule.pass || text.length < 8 || text.length > 200) continue;
      const full = `${text}\n\n${tags.join(" ")}`;
      const g = await gateCopy([{ label: "caption", text: full }]);
      if (g.pass) return { caption: full, source: `llm:${CONFIG.CAPTION_MODEL}` };
    } catch (e) {
      warn("caption gen attempt failed", { attempt, err: e instanceof Error ? e.message : String(e) });
    }
  }
  return { caption: fallbackCaption(spec.reveal, tags), source: "fallback" };
}

const HASHTAG_ROTATION = ["A", "B", "C"];

export interface Learnings {
  front_runners?: Record<string, unknown>;
  rollups?: Record<string, unknown>;
}

/** Build the day's batch: up to `target` videos, each a different dimension. */
export async function planBatch(runId: string, target: number): Promise<VideoPlan[]> {
  const learnings = readJSON<Learnings>(CONFIG.LEARNINGS, {});
  const claimed = new Set<string>(); // in-batch question dedup
  const specs = seededOrder(DIMENSIONS, seedOf(runId)).slice(0, target);
  const plans: VideoPlan[] = [];

  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i];
    const idxNN = String(i + 1).padStart(2, "0");
    const id = `${runId}-v${idxNN}`;

    // fresh questions for this dimension
    const pool = candidateQuestions({
      category: spec.category,
      kinds: spec.kinds,
      seed: `${runId}:${spec.dimension}:${spec.arm}`,
      exclude: claimed,
    });
    const chosen: HermesQ[] = pool.slice(0, spec.numQ);
    if (chosen.length < spec.numQ) {
      warn("dropping video: not enough fresh questions", { id, dimension: spec.dimension, want: spec.numQ, got: chosen.length });
      decision(`DROP ${id} (${spec.dimension}/${spec.arm}): only ${chosen.length}/${spec.numQ} fresh questions`);
      continue;
    }
    for (const q of chosen) claimed.add(q.sig);

    const hashtagSet = HASHTAG_ROTATION[i % HASHTAG_ROTATION.length];
    const tags = CONFIG.HASHTAG_SETS[hashtagSet];
    const { caption, source } = await makeCaption(spec, tags);

    const title = spec.hook?.title ?? "SMART or FART?";
    const subtitle = spec.hook?.subtitle ?? "how many can you get?";
    const outro = defaultOutro(spec.reveal);

    const renderQuestions = chosen.map((q) => ({
      kind: q.kind,
      tier: q.tier,
      prompt: q.prompt,
      options: q.options,
      seq: q.seq,
      answer: q.answer,
    }));

    const music = CONFIG.MUSIC_TRACKS[i % CONFIG.MUSIC_TRACKS.length];

    const plan: VideoPlan = {
      id,
      index: i,
      dimension: spec.dimension,
      arm: spec.arm,
      rationale: spec.rationale,
      caption,
      hashtag_set: hashtagSet,
      questions: chosen,
      gates: { copy: { pass: true, reason: `caption ${source}` } },
      status: "planned",
      props: {
        title,
        subtitle,
        outro,
        music,
        showProgress: spec.showProgress,
        progressStyle: spec.progressStyle,
        reveal: spec.reveal,
        countdownSec: spec.countdownSec,
        // clips[] are synthesized at render time by hermes/src/render.ts; "none" = music-only.
        narration: { mode: spec.narration ?? "none", clips: [] },
        questions: renderQuestions,
      },
    };
    plans.push(plan);
    decision(`PLAN ${id}: dimension=${spec.dimension} arm=${spec.arm} q=${chosen.length} tags=${hashtagSet} narration=${spec.narration ?? "none"}`, {
      questions: chosen.map((q) => q.tier),
    });
  }

  info("batch planned", { runId, planned: plans.length, target, frontRunner: learnings.front_runners });
  return plans;
}

/** A read-only entry in the A/B dimension catalog (one variable axis per entry). */
export interface DimensionInfo {
  dimension: string;
  arm: string;
  rationale: string;
  numQ: number;
  category: string;
  narration: NarrationMode;
  showProgress: boolean;
  progressStyle: string;
  reveal: RevealMode;
  countdownSec: number;
}

/**
 * Read-only view of the A/B dimension catalog (dimension / arm / rationale + the
 * key render axes, incl. the narration arm and progress-counter settings). This
 * runs NO LLM and makes NO network call — it just surfaces the static DIMENSIONS
 * table so the `sffs_design` tool (and the agent) can introspect the A/B space
 * cheaply. The full, caption-generating design is planBatch() above.
 */
export function dimensionCatalog(): DimensionInfo[] {
  return DIMENSIONS.map((d) => ({
    dimension: d.dimension,
    arm: d.arm,
    rationale: d.rationale,
    numQ: d.numQ,
    category: d.category,
    narration: d.narration ?? "none",
    showProgress: d.showProgress,
    progressStyle: d.progressStyle,
    reveal: d.reveal,
    countdownSec: d.countdownSec,
  }));
}
