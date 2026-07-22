/**
 * design.ts — the batch designer. Produces up to VIDEOS_PER_DAY videos, EACH a
 * DIFFERENT A/B dimension, biased by learnings.json, with FRESH questions and
 * on-brand, gated copy. Quality > volume: if a slot can't be filled with fresh
 * valid questions, it's dropped (logged), not padded with junk.
 *
 * NEW BASELINE DEFAULTS (content-defaults.json, see defaults.ts + dimensions.ts):
 *   EVERY video is NARRATED (narration="full") and ends on a CLIFFHANGER (reveal
 *   the early questions, withhold the last + comment-CTA, no score screen) UNLESS
 *   it is the specific arm under test. The "control/baseline" video is exactly
 *   full-narration + cliffhanger. Each A/B arm DEVIATES ONE axis from those
 *   defaults (see dimensions.ts DIMENSIONS). The current default VALUES are read
 *   from content-defaults.json, so a human-approved promotion
 *   (sffs_promote_default --approve) flips them for the next design pass — no code
 *   change. The narration voiceover is synthesized at render time by
 *   hermes/src/render.ts; music-only is the no-narration arm.
 *
 * The DIMENSION catalog + its defaults-resolution live in the dependency-free
 * dimensions.ts (so `sffs_design catalog` runs offline); design.ts adds the
 * LLM/gates/questions batch build on top.
 */
import { readJSON, type HermesQ, type VideoPlan } from "./state.ts";
import { candidateQuestions } from "./questions.ts";
import { gateCopy } from "./gates.ts";
import { chat } from "./llm.ts";
import { ruleCheckCopy } from "./brand.ts";
import { CONFIG } from "./config.ts";
import { info, decision, warn } from "./log.ts";
import { contentDefaults, captionAsk, defaultOutro, type RevealMode } from "./defaults.ts";
import { buildDimensions, resolveArm } from "./dimensions.ts";

// Re-export the catalog surface so existing importers (bridge/design.ts) are
// unchanged, while the actual definitions live in the dependency-free module.
export { dimensionCatalog, type DimensionInfo } from "./dimensions.ts";

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

function fallbackCaption(reveal: RevealMode, tags: string[]): string {
  const ask = captionAsk(reveal);
  return `are you a SMART fella or a FART smella? ${ask} below and follow for more \uD83D\uDC47\n\n${tags.join(" ")}`;
}

/** Generate an on-brand caption, gated + reject/regenerate, safe fallback. */
async function makeCaption(reveal: RevealMode, tags: string[]): Promise<{ caption: string; source: string }> {
  const ask = captionAsk(reveal).toUpperCase();
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
  return { caption: fallbackCaption(reveal, tags), source: "fallback" };
}

const HASHTAG_ROTATION = ["A", "B", "C"];

export interface Learnings {
  front_runners?: Record<string, unknown>;
  rollups?: Record<string, unknown>;
}

/** Build the day's batch: up to `target` videos, each a different dimension. */
export async function planBatch(runId: string, target: number): Promise<VideoPlan[]> {
  const learnings = readJSON<Learnings>(CONFIG.LEARNINGS, {});
  const defaults = contentDefaults();
  const claimed = new Set<string>(); // in-batch question dedup
  const specs = seededOrder(buildDimensions(defaults), seedOf(runId)).slice(0, target);
  const plans: VideoPlan[] = [];

  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i];
    const resolved = resolveArm(spec, defaults);
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
    const { caption, source } = await makeCaption(resolved.reveal, tags);

    const title = spec.hook?.title ?? "SMART or FART?";
    const subtitle = spec.hook?.subtitle ?? "how many can you get?";
    const outro = defaultOutro(resolved.reveal);

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
        reveal: resolved.reveal,
        countdownSec: spec.countdownSec,
        // The narration axis (default: full). clips[] are synthesized at render time
        // by hermes/src/render.ts; "none" = music-only (the no-narration test arm).
        narration: { mode: resolved.narration, clips: [] },
        // Symbolic ending arm (for the ab-database annotation + dashboard); the
        // composition itself is driven by `reveal` above.
        ending: resolved.endingArm,
        questions: renderQuestions,
      },
    };
    plans.push(plan);
    decision(
      `PLAN ${id}: dimension=${spec.dimension} arm=${spec.arm} q=${chosen.length} tags=${hashtagSet} narration=${resolved.narration} ending=${resolved.endingArm} reveal=${resolved.reveal}`,
      { questions: chosen.map((q) => q.tier) },
    );
  }

  info("batch planned", { runId, planned: plans.length, target, defaults, frontRunner: learnings.front_runners });
  return plans;
}
