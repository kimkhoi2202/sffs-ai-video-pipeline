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
import { contentDefaults, captionAsk, defaultOutro, type RevealMode, type ContentDefaults } from "./defaults.ts";
import { pinnedSpecs, resolveArm, selectSpread, newSpreadTally, PINNED_ARM, type DimSpec, type SpreadTally } from "./dimensions.ts";
import { normalizeTier, type ReplicationDirective, type StyleFingerprint } from "./replication.ts";

// Re-export the catalog surface so existing importers (bridge/design.ts) are
// unchanged, while the actual definitions live in the dependency-free module.
export { dimensionCatalog, type DimensionInfo } from "./dimensions.ts";

function fallbackCaption(reveal: RevealMode, tags: string[]): string {
  const ask = captionAsk(reveal);
  return `are you a SMART fella or a FART smella? ${ask} below and follow for more \uD83D\uDC47\n\n${tags.join(" ")}`;
}

/** Generate an on-brand caption, gated + reject/regenerate, safe fallback. */
async function makeCaption(reveal: RevealMode, tags: string[]): Promise<{ caption: string; source: string }> {
  const ask = captionAsk(reveal).toUpperCase();
  const system =
    "You write captions for 'Smart Fella or Fart Smella', a Gen-Z brain-quiz brand. Voice: concise, funny, " +
    "lowercase-casual, kid-safe, NO em or en dashes, at most ONE emoji beyond the 🧠💨 logo, no AI-slop, " +
    "always end with a follow/come-back nudge. Signature: SMART FELLA (smart) vs FART SMELLA (miss). " +
    "Difficulty puffery about the puzzle is house style and needs no substantiation ('97% get this wrong'). " +
    "NEVER claim anything about the product or the viewer's outcome ('users gain IQ points', 'get smarter', " +
    "'scientifically proven') - see compliance.md section 3.";
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

// ---------------------------------------------------------------------------
// WINNER REPLICATION (see hermes-nous/sffs/replicate.py + replication.ts)
//
// When a reach outlier is being doubled down on, the front of the batch is built
// as REPLICAS of its style. The point is attribution: hold the winning style
// CONSTANT and vary only secondary knobs, so if the replicas also win we know it
// was the style and not the surroundings. The rest of the batch stays on the normal
// seeded rotation — that remainder is the exploration floor the share cap protects.
// ---------------------------------------------------------------------------

/** Secondary knob 1: tempo. Cycled across replicas so the style is the constant. */
const REPLICA_COUNTDOWNS = [5, 3, 7, 4, 6, 8];

/** A recorded narration MODE (what the A/B db stores) -> the arm label a spec needs. */
function narrationArmForMode(mode: string): DimSpec["narrationArm"] | undefined {
  switch (normalizeTier(mode)) {
    case "full":
      return "full";
    case "none":
      return "no-narration";
    case "no-question-vo":
      return "no-question-vo";
    case "no-options-vo":
      return "no-options-vo";
    default:
      return undefined; // unknown/older post -> inherit the current default
  }
}

function endingArmFor(ending: string): DimSpec["endingArm"] | undefined {
  const e = normalizeTier(ending);
  return e === "cliffhanger" || e === "full-reveal" || e === "no-answer" ? (e as DimSpec["endingArm"]) : undefined;
}

/**
 * `n` specs that all reproduce the winning style, differing only in tempo (and, via
 * planBatch's existing rotation, hashtag set). Each carries the same canonical arm
 * label so the A/B rollups aggregate the replication round as one arm.
 */
export function replicaSpecs(n: number, fp: StyleFingerprint): DimSpec[] {
  const arm = `replica-${normalizeTier(fp.lead_type)}`;
  const numQ = fp.num_questions > 0 ? fp.num_questions : BASE_NUMQ;
  const out: DimSpec[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      dimension: "replication",
      arm,
      rationale:
        `REPLICA of the current reach front-runner (${fp.key}): the winning style is held CONSTANT ` +
        `(lead question type "${fp.lead_type}", ${numQ} question(s)) and only secondary knobs vary ` +
        `(tempo ${REPLICA_COUNTDOWNS[i % REPLICA_COUNTDOWNS.length]}s, hashtag set, time of day), so a repeat win is attributable to the style.`,
      numQ,
      category: "mixed",
      showProgress: true,
      progressStyle: "short",
      countdownSec: REPLICA_COUNTDOWNS[i % REPLICA_COUNTDOWNS.length],
      narrationArm: narrationArmForMode(fp.narration),
      endingArm: endingArmFor(fp.ending),
    });
  }
  return out;
}

/** Fallback question count when the fingerprint predates num_questions. */
const BASE_NUMQ = 3;

export interface Learnings {
  front_runners?: Record<string, unknown>;
  rollups?: Record<string, unknown>;
}

/**
 * WHICH FORMAT this batch will run. Split out of planBatch so the decision can be
 * inspected WITHOUT rendering: planBatch goes on to generate captions, call the LLM
 * gates and render video, none of which you want to do just to find out what the
 * batch is. `sffs_design arms` and the tests call this exact function, so what they
 * show is what the cycle will do, not a lookalike.
 *
 * EXPLORATION IS OVER (2026-08-02). Every slot is the PINNED format — see
 * dimensions.ts PINNED for the live-analytics evidence behind it. Four things that
 * used to shape a batch are gone from this path:
 *
 *   - the seeded DIMENSION ROTATION over the arm catalog;
 *   - the MASCOT elevation weight;
 *   - WINNER REPLICATION (already disabled in content-defaults.json; now it is not
 *     consulted at all, so a stray `sffs_replicate --detect` cannot reopen a round);
 *   - HERMES_ONLY_DIMENSIONS, the operator concentration switch, which was live on
 *     the box pinning every slot to `motion-hook,motion-hook-stat,
 *     motion-hook-declared` — the three worst-measured openings in the account.
 *
 * The catalog itself (dimensions.ts buildDimensions and friends) is untouched and
 * still unit-tested. Restarting exploration means calling it from here again; it does
 * not mean rebuilding it.
 */
export function selectBatchSpecs(
  runId: string,
  target: number,
  defaults: ContentDefaults = contentDefaults(),
): { specs: DimSpec[]; onlyDims: string[]; directive: ReplicationDirective; nReplicas: number; fp?: StyleFingerprint } {
  void runId;
  void defaults;
  return {
    specs: pinnedSpecs(target),
    onlyDims: [],
    directive: { active: false, share: 0, share_cap: 0 },
    nReplicas: 0,
  };
}

/** Build the day's batch: up to `target` videos, each a different dimension. */
export async function planBatch(runId: string, target: number): Promise<VideoPlan[]> {
  const learnings = readJSON<Learnings>(CONFIG.LEARNINGS, {});
  const defaults = contentDefaults();
  const claimed = new Set<string>(); // in-batch question dedup
  // Running per-batch TYPE/tier tally so questions spread across types within each
  // video AND don't cluster the same types across the day's batch (P1). Shared
  // across every video in this batch. See dimensions.ts selectSpread.
  const batchSpread = newSpreadTally();
  const { specs } = selectBatchSpecs(runId, target, defaults);
  decision(
    `PINNED FORMAT: all ${specs.length} slot(s) run ${PINNED_ARM} (3 mixed questions, cold-plate open, ` +
      `${defaults.narration} narration, ${defaults.ending} ending, 5s, short counter). No A/B rotation. ` +
      `Questions are freshly selected per video and still pass dedup + validity + brand gates.`,
  );

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
    // Pick with per-video type/tier spread + per-batch anti-clustering (P1), instead
    // of just taking the first numQ of the seeded pool. This is what keeps a PINNED
    // batch from being twelve near-identical videos: the format is fixed, the
    // questions inside it are not, and the spread stops the day clustering on one
    // tier. Fixing the format is not repeating the video.
    const chosen: HermesQ[] = selectSpread(pool, spec.numQ, batchSpread);
    if (chosen.length < spec.numQ) {
      warn("dropping video: not enough fresh questions", { id, dimension: spec.dimension, want: spec.numQ, got: chosen.length });
      decision(`DROP ${id} (${spec.arm}): only ${chosen.length}/${spec.numQ} fresh questions`);
      continue;
    }
    for (const q of chosen) claimed.add(q.sig);

    const hashtagSet = HASHTAG_ROTATION[i % HASHTAG_ROTATION.length];
    const tags = CONFIG.HASHTAG_SETS[hashtagSet];
    const { caption, source } = await makeCaption(resolved.reveal, tags);

    const outro = defaultOutro(resolved.reveal);

    const renderQuestions = chosen.map((q) => ({
      kind: q.kind,
      tier: q.tier,
      prompt: q.prompt,
      options: q.options,
      seq: q.seq,
      answer: q.answer,
      // Authored reveal explanation; render.ts falls back to its generated template
      // when the bank entry predates the raw-text re-import.
      explanation: q.explanation,
      // Carry the render-ready shape/figure payload through for nonverbal kinds
      // (fold + matrix family); undefined for text/numseries. render.ts mapProps
      // reconstructs the FullVideo shape Question from this.
      figure: q.figure,
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
        // COLD PLATE. Question one is on screen at 0.00s. The 2.2s motion opening and
        // the spoken hooks that rode it are not rendered any more: the wordless arm
        // measured 5.6 points WORSE on skip rate over 41 posts, and on this account
        // skip rate is the only thing that separates 1,700 views from 130.
        opening: spec.opening ?? "cold-plate",
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
        // The mascot arm: the brand-brain render visibility ("standard" keeps
        // today's cover/outro brain exactly; "absent" hides it; "prominent"
        // enlarges it). Consumed by render.ts -> FullVideo -> Intro/Outro. The
        // canonical arm LABEL (mascotArm) is carried for the ab-database rollup.
        mascot: resolved.mascot,
        mascotArm: resolved.mascotArm,
        questions: renderQuestions,
      },
    };
    plans.push(plan);
    decision(
      `PLAN ${id}: ${spec.arm} q=${chosen.length} tags=${hashtagSet} narration=${resolved.narration} ending=${resolved.endingArm} reveal=${resolved.reveal}`,
      { questions: chosen.map((q) => q.tier) },
    );
  }

  info("batch planned", { runId, planned: plans.length, target, defaults, format: PINNED_ARM });
  void learnings;
  return plans;
}
