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
import { pinnedSpecs, explorationSpecs, resolveArm, selectSpread, newSpreadTally, leadTypeCap, PINNED_ARM, type DimSpec, type SpreadTally } from "./dimensions.ts";
import { normalizeTier, type ReplicationDirective, type StyleFingerprint } from "./replication.ts";
import { allocateLeadBands, bandOf, promptWords, BAND_LABEL, LEAD_BANDS, type LeadBand } from "./leadPolicy.ts";
import { currentLeadShares } from "./leadPromotion.ts";

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
      // FALL BACK TO THE REASONING MODEL, the way the validity judge already falls back
      // to the cheap one. On 2026-08-03 the gateway 403'd claude-haiku-4-5 for 56
      // minutes (14:05-15:01 UTC, 162 times) — squarely inside the cycle window — while
      // claude-opus-5 answered every request it got. Without a fallback that outage cost
      // eleven of twelve videos their written caption and shipped the same hardcoded
      // line to all of them. A caption is cheap; an identical caption on a whole day of
      // posts is the near-duplicate signal this account is already fighting.
      let text = (
        await chat(system, user, { model: CONFIG.CAPTION_MODEL, fallbackModel: CONFIG.MODEL, maxTokens: 120, temperature: 0.8 })
      ).trim();
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
 * Fraction of a full batch reserved for the exploration slice.
 *
 * Chosen off the arithmetic of the promotion gate, not off taste. Promotion needs
 * min_sample=12 matured posts on BOTH sides, and with two fixed arms the slice must
 * therefore produce THREE slots a day: three alternating (dimensions.ts
 * explorationSpecs `rotate`) is 1.5 posts/arm/day and clears 12 in EIGHT DAYS. Two
 * slots is 1/arm/day and takes TWELVE — which is the whole window, with the read
 * landing after the target is judged, and is the same starvation that made the
 * previous seven-arm read unconcludable.
 *
 * 0.25 -> 0.30 on 2026-08-03, when the daily ceiling came down 12 -> 11 to fit the
 * Metricool budget. floor(11 x 0.25) is 2, so the cadence cut would have quietly cost
 * the slice a third of its sample; 0.30 holds it at 3. At the old ceiling of 12 both
 * values give 3, so this changes the slice only where it had to.
 *
 * It leaves 70% on the pinned format, which remains a decisively exploitative
 * posture: the pre-pivot rotation gave any single arm about a seventh of the day.
 * And it still FLOORS, so a small top-up wave (target <= 3) is 100% pinned.
 */
export const EXPLORATION_SHARE = 0.3;

/**
 * How many of `target` slots the exploration slice takes.
 *
 * FLOORS, so the pinned format always gets the rounding, and is clamped to
 * `target - 1` so exploration can never take a whole batch. A consequence worth
 * stating: a small top-up wave (target <= 3) runs 100% pinned. Recovery slots
 * exist to hit the daily floor, and spending them on measurement would trade
 * production volume for a sample the main batch is already accruing.
 */
export function explorationCount(target: number): number {
  if (target <= 0) return 0;
  return Math.max(0, Math.min(Math.floor(target * EXPLORATION_SHARE), target - 1));
}

/**
 * Lay the exploration slots at even intervals through the batch instead of
 * bolting them on the end.
 *
 * Position is not cosmetic here. planBatch assigns the hashtag set by slot index
 * (`HASHTAG_ROTATION[i % 3]`) and loopPublish spaces the day's slots in order, so
 * a slice appended at the end would arrive with one hashtag set, at the latest
 * times of day, every single day — and the arm would be confounded with both.
 * Spread evenly, the three exploration slots of a 12-video day land on indices
 * 3/7/11 and therefore on hashtag sets A/B/C and across the posting window.
 *
 * Deterministic: no run id, no clock, no randomness.
 */
export function interleaveExploration(pinned: DimSpec[], explore: DimSpec[]): DimSpec[] {
  if (explore.length === 0) return pinned;
  const total = pinned.length + explore.length;
  const out: DimSpec[] = [];
  let ei = 0;
  let pi = 0;
  for (let i = 0; i < total; i++) {
    const due = Math.floor(((i + 1) * explore.length) / total) > Math.floor((i * explore.length) / total);
    out.push(due && ei < explore.length ? explore[ei++] : pinned[pi++]);
  }
  return out;
}

/**
 * WHICH FORMAT this batch will run. Split out of planBatch so the decision can be
 * inspected WITHOUT rendering: planBatch goes on to generate captions, call the LLM
 * gates and render video, none of which you want to do just to find out what the
 * batch is. `sffs_design arms` and the tests call this exact function, so what they
 * show is what the cycle will do, not a lookalike.
 *
 * EXPLOITATION, WITH A MEASUREMENT FLOOR. Most of the batch is the PINNED format
 * — see dimensions.ts PINNED for the live-analytics evidence behind it — and the
 * remaining EXPLORATION_SHARE runs the two-arm exploration slice that pinned is
 * measured against (dimensions.ts EXPLORATION_ARMS). Three things that used to
 * shape a batch are still gone from this path:
 *
 *   - the seeded DIMENSION ROTATION over the whole arm catalog;
 *   - the MASCOT elevation weight;
 *   - WINNER REPLICATION (already disabled in content-defaults.json; it is not
 *     consulted at all, so a stray `sffs_replicate --detect` cannot reopen a round);
 *   - HERMES_ONLY_DIMENSIONS, the operator concentration switch, which was live on
 *     the box pinning every slot to `motion-hook,motion-hook-stat,
 *     motion-hook-declared` — the three worst-measured openings in the account.
 *
 * The catalog itself (dimensions.ts buildDimensions and friends) is untouched and
 * still unit-tested. Widening exploration means listing more arms there; it does
 * not mean rebuilding anything.
 */
export function selectBatchSpecs(
  runId: string,
  target: number,
  defaults: ContentDefaults = contentDefaults(),
): { specs: DimSpec[]; onlyDims: string[]; directive: ReplicationDirective; nReplicas: number; fp?: StyleFingerprint } {
  const nExplore = explorationCount(target);
  return {
    specs: interleaveExploration(pinnedSpecs(target - nExplore), explorationSpecs(nExplore, defaults, dayIndex(runId))),
    onlyDims: [],
    directive: { active: false, share: 0, share_cap: 0 },
    nReplicas: 0,
  };
}

/**
 * Days since the epoch for a run id, used ONLY to alternate which exploration arm gets
 * the odd slot (dimensions.ts explorationSpecs).
 *
 * A run id is `YYYY-MM-DD`, with top-up waves suffixed `-t1`, `-t2` — so the date prefix
 * is what is read, and every wave of a day rotates identically. This is the one thing
 * runId is allowed to influence: it is a calendar fact, not a seed, so the batch stays
 * reproducible from the date alone. An unparseable id yields 0, i.e. today's behaviour.
 */
export function dayIndex(runId: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(runId).trim());
  if (!m) return 0;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isFinite(ms) ? Math.floor(ms / 86_400_000) : 0;
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
  const nPinned = specs.filter((s) => s.arm === PINNED_ARM).length;
  const exploreTally = specs
    .filter((s) => s.arm !== PINNED_ARM)
    .reduce<Record<string, number>>((a, s) => ((a[s.arm] = (a[s.arm] ?? 0) + 1), a), {});
  decision(
    `FORMAT MIX: ${nPinned}/${specs.length} slot(s) run ${PINNED_ARM} (3 mixed questions, cold-plate open, ` +
      `${defaults.narration} narration, ${defaults.ending} ending, 5s, short counter); ` +
      `${specs.length - nPinned}/${specs.length} run the exploration slice ` +
      `(${Object.entries(exploreTally).map(([a, n]) => `${a} x${n}`).join(", ") || "none"}) ` +
      `so the pinned format has something live to be measured against. ` +
      `Questions are freshly selected per video and still pass dedup + validity + brand gates.`,
  );

  // WHICH QUESTION OPENS EACH VIDEO — the one axis still decided by measurement.
  // The format is pinned, so this is the remaining lever: the opening question is what
  // holds the screen through the 3 seconds that decide reach on this account. Shares
  // come from the ledger leadPromotion.ts wrote earlier in the cycle; an even draw if it
  // has not run, is switched off, or no band has cleared the evidence bar.
  const lead = currentLeadShares();
  const leadBands = allocateLeadBands(specs.length, lead.shares);
  // Bands ranked best-first, so a slot whose band is exhausted (or whose only type has
  // hit the variety cap) falls to the next-best band rather than to whatever is handy.
  const bandRank: LeadBand[] = [...LEAD_BANDS].sort((a, b) => lead.shares[b] - lead.shares[a]);
  const typeCap = leadTypeCap(specs.length);
  decision(
    `OPENING MIX: ${(["short", "medium", "long"] as const)
      .map((b) => `${BAND_LABEL[b]} x${leadBands.filter((x) => x === b).length}`)
      .join(", ")}` +
      (lead.applied
        ? ` — weighted by 3-second skip rate (Instagram only). ${lead.note}`
        : ` — EVEN DRAW (${lead.note}).`) +
      ` No single question type may open more than ${typeCap} of ${specs.length}.`,
  );

  const plans: VideoPlan[] = [];
  let captionFallbacks = 0;

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
    const wantBand = leadBands[i];
    const prefs: LeadBand[] = wantBand ? [wantBand, ...bandRank.filter((b) => b !== wantBand)] : [];
    const chosen: HermesQ[] = selectSpread(pool, spec.numQ, batchSpread, prefs, typeCap);
    if (chosen.length < spec.numQ) {
      warn("dropping video: not enough fresh questions", { id, dimension: spec.dimension, want: spec.numQ, got: chosen.length });
      decision(`DROP ${id} (${spec.arm}): only ${chosen.length}/${spec.numQ} fresh questions`);
      continue;
    }
    for (const q of chosen) claimed.add(q.sig);

    const hashtagSet = HASHTAG_ROTATION[i % HASHTAG_ROTATION.length];
    const tags = CONFIG.HASHTAG_SETS[hashtagSet];
    const { caption, source } = await makeCaption(resolved.reveal, tags);
    if (source === "fallback") captionFallbacks++;

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
    const gotBand = bandOf(promptWords(chosen[0]?.prompt));
    decision(
      `PLAN ${id}: ${spec.arm} q=${chosen.length} tags=${hashtagSet} narration=${resolved.narration} ending=${resolved.endingArm} reveal=${resolved.reveal} ` +
        `opening=${chosen[0]?.tier} (${promptWords(chosen[0]?.prompt)}w, ${gotBand}` +
        (wantBand && gotBand !== wantBand ? `; wanted ${wantBand} — exhausted or at the variety cap` : "") +
        `)`,
      { questions: chosen.map((q) => q.tier) },
    );
  }

  // A caption that fell back is not a failure anywhere — makeCaption swallows it and
  // returns a usable string — so without this line a batch in which EVERY video shipped
  // the same hardcoded caption reports as a clean run. That happened on 2026-08-03.
  if (captionFallbacks) {
    decision(
      `CAPTION FALLBACK: ${captionFallbacks}/${plans.length} video(s) shipped the hardcoded caption because ` +
        `NEITHER ${CONFIG.CAPTION_MODEL} NOR ${CONFIG.MODEL} could write one. They are on-brand and safe, but ` +
        `they are identical to each other and nothing was written for the question inside.`,
    );
  }

  info("batch planned", {
    runId,
    planned: plans.length,
    target,
    defaults,
    format: PINNED_ARM,
    pinned: nPinned,
    exploration: exploreTally,
    caption_fallbacks: captionFallbacks,
  });
  void learnings;
  return plans;
}
