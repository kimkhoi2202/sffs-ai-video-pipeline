/**
 * render.ts — render the loop's videos with the REAL production `Short`
 * (FullVideo) composition, replacing the off-brand self-contained HermesQuiz.
 *
 * WHAT THIS DOES
 *   The loop's design.ts emits HermesQuiz-shaped props (title/subtitle/outro/
 *   music/showProgress/progressStyle/reveal/countdownSec/narration/questions).
 *   This module MAPS those onto the production `Short` composition's prop-driven
 *   variant surface (remotion/src/Root.tsx `Short` == FullVideo) and renders it
 *   with the Remotion CLI — the SAME renderer, assets, per-platform SAFE ZONES
 *   (TikTok/IG/YouTube), neo-brutalist plates, options, reveals, score screen,
 *   animated outro, ducked music + SFX that the polished render-ab.ts shorts use.
 *
 *   Per platform it renders `Short` with:
 *     - platform            -> per-platform SAFE ZONES (SafeArea/PlatformProvider):
 *                              TikTok AND YouTube share the up-scaled UI-safe
 *                              transform (the Shorts player's chrome box is the
 *                              TikTok box to within 20px, and TikTok's is the
 *                              tighter, so the TikTok cut clears both); Instagram
 *                              keeps the IG safe box, which does NOT clear the
 *                              Shorts player. We render ONCE PER PLATFORM so each
 *                              draft is safe for the account it goes to.
 *     - readVO (narration)  -> full narration ("full") reads the q<idx>.mp3 clip
 *                              (whose audio is the arm-appropriate stem/options/
 *                              full text); "none" = music-only (reveals + meta VO
 *                              still play, matching the render-ab "no-narration" arm).
 *     - dropReveal/dropScore/endCard (ending) -> full-reveal | cliffhanger | no-answer.
 *     - showProgress/progressStyle           -> the progress-counter A/B dimension.
 *
 *   VO is synthesized ONCE per video (cloned voice, voice/tts_batch.py via
 *   narration.ts) — read clips q<idx> + reveal clips r<idx> — and SHARED across
 *   both platform renders (idempotent; zero extra TTS). Meta beats (timesup/
 *   score/outro-*) are round-agnostic and served from the committed
 *   remotion/public/audio/narration/ dir. SFX + music are committed assets.
 *
 * CONTRACT (unchanged for callers): renderVideo(id, props, {force}) -> one
 * RenderResult (a single default-platform render, for the standalone sffs_render
 * bridge); computeFrames(props) -> a frame count for the dry-run preview.
 * cycle.ts uses renderForPlatforms(id, props) to render both platforms.
 *
 * DRAFT-SAFE: like before, this module imports ONLY config/log/narration (which
 * shells to python3 voice/tts_batch.py) + the pure number-speller; it has NO
 * Publer/create/schedule/publish path anywhere in its dependency tree.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG } from "./config.ts";
import { info } from "./log.ts";
import { aptSegmentFor, aptRightsCleared } from "./music.ts";
import { generateVO, type RevealBeatInput, type NarrationMode, resolveFfprobe, isNum, spellNums } from "./narration.ts";
import { isShapeKind, type Figure } from "./state.ts";
// Reuse the pipeline's canonical number-speller so "25" reads "twenty-five".
import { n2w } from "../../content/gen-narration-scripts.mjs";
// Pure paper-folding solver (no React) — derives fold.ansHoles for the reveal.
import { unfold, type FoldDir, type HoleCell } from "../../remotion/src/data/fold.ts";

const FPS = 30;
/** Frames of breathing room after the VO finishes before the countdown starts.
 *  MUST match remotion/src/full/timeline.ts (READ window uses lead+dur+trail). */
const SILENT_READ = Math.round(1.5 * FPS); // readVO="none" hold (timeline SILENT_READ)

/** Short pacing — MUST match remotion/src/full/timeline.ts build() isShort path. */
const SHORT_LEAD = 0.12;
const SHORT_TRAIL = 0.4;
/** Opening arm for the 3-second skip-rate experiment (mirrors timeline.ts Opening). */
export type Opening = "cold-plate" | "motion-hook";
/** Hook length — MUST match timeline.ts / scenes/Hook.tsx HOOK_SECONDS. */
const HOOK_SECONDS = 2.2;
const frames = (s: number): number => Math.round(s * FPS);

export type Platform = "youtube" | "instagram" | "tiktok";
/**
 * The platforms the loop renders + drafts (each gets its OWN safe-zone render).
 * Order matches CONFIG.ACCOUNT_IDS / cycle.ts annotateDb.
 *
 * YouTube was a first-class Platform everywhere in the Remotion tree — its own outro
 * VO (outro-youtube.mp3) and its own "SUBSCRIBE FOR MORE" CTA — but this array was the
 * one thing gating it, so that code had literally never executed. Adding it here lights
 * up the existing path; it does NOT need new scenes.
 *
 * TikTok stays in the list while PAUSED, exactly as before: it renders and simply takes
 * no slots (postingPolicy), so resuming it is a config flip and not a render change.
 */
export const RENDER_PLATFORMS: Platform[] = ["instagram", "youtube", "tiktok"];
/** Default single-platform for the standalone sffs_render bridge. TikTok's safe
 *  box is the tightest (⊆ the IG box AND ⊆ the YouTube box), so a single tiktok
 *  render is safe on all three. */
const DEFAULT_PLATFORM: Platform = "tiktok";

type Ending = { dropReveal: boolean | "last"; dropScore: boolean; endCard: "default" | "noanswer" | "verdict" };

export interface RenderResult {
  path: string;
  frames: number;
  reused: boolean;
}
export interface PlatformRender extends RenderResult {
  platform: Platform;
}

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------
const norm = (s: unknown): string => String(s ?? "").trim().toLowerCase();
const LETTERS = ["A", "B", "C", "D"];

/** Ending arm -> the Short variant toggles (mirrors defaults.ts semantics):
 *  full-reveal (reveal all) -> reveal every answer + score screen + platform outro;
 *  cliffhanger (reveal="last") -> reveal all but the last, no score, comment-CTA;
 *  no-answer (reveal="none")   -> reveal nothing, no score, comment-CTA. */
function endingFor(reveal: string | undefined): Ending {
  if (reveal === "all") return { dropReveal: false, dropScore: false, endCard: "default" };
  if (reveal === "none") return { dropReveal: true, dropScore: true, endCard: "noanswer" };
  return { dropReveal: "last", dropScore: true, endCard: "noanswer" }; // "last"/default = cliffhanger
}

/** Which questions actually reveal (and thus need a reveal VO clip r<idx>). */
function revealIndexes(n: number, ending: Ending): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const isLast = i === n - 1;
    const revealThis = ending.dropReveal === "last" ? !isLast : !ending.dropReveal;
    if (revealThis) out.push(i);
  }
  return out;
}

/** A stable per-video SFX set (short-1..5), so videos vary like the render-ab shorts. */
function sfxSlugFor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return `short-${(h % 5) + 1}`;
}
const sfxSet = (slug: string) => ({ whoosh: `${slug}/whoosh.mp3`, ding: `${slug}/ding.mp3`, sting: `${slug}/sting.mp3` });

// ---------------------------------------------------------------------------
// ffprobe (committed meta beats) — mirrors render-ab.ts audio hygiene: measure
// the ACTUAL played copy under remotion/public/audio/narration/.
// ---------------------------------------------------------------------------
const NARR_DIR = join(CONFIG.REMOTION_DIR, "public", "audio", "narration");
function metaDur(beat: string): number {
  const file = join(NARR_DIR, `${beat}.mp3`);
  const out = execFileSync(resolveFfprobe(), ["-v", "error", "-show_entries", "format=duration", "-of", "default=nk=1:nw=1", file], { encoding: "utf8" }).trim();
  const d = Number(out);
  if (!(d > 0)) throw new Error(`meta beat has no duration: ${file}`);
  return d;
}
/** Nominal meta/VO durations for the dry-run frame PREVIEW only (no ffprobe/TTS).
 *  The real render measures every clip; these only size computeFrames() previews. */
const NOMINAL = { timesup: 1.2, score: 20.8, "outro-follow": 6.0, "outro-youtube": 6.0, "outro-noanswer": 5.0, "outro-noanswer-youtube": 5.0, verdict: 4.0, read: 3.0, reveal: 2.0 } as const;

// ---------------------------------------------------------------------------
// Question mapping: loop HermesQuiz question -> Short/FullVideo Question.
// ---------------------------------------------------------------------------
interface LoopQ {
  kind: "text" | "numseries" | "fold" | "matrix" | "analogy2" | "figure-odd" | "dot" | "shaded" | "polygon";
  tier: string;
  prompt: string;
  options?: string[];
  seq?: string[];
  answer: string;
  /** The AUTHORED explanation from the bank. Preferred over explanationFor() below. */
  explanation?: string;
  /** Structured render-ready payload for the shape/figure kinds (undefined for
   *  text/numseries). Carried through from the bank via toHermesQ + design.ts. */
  figure?: Figure;
}

/**
 * FALLBACK explanation for the reveal plate + reveal VO, used only when the bank
 * entry carries no authored one (pre-re-import entries).
 *
 * It is honest but generic by construction: number-series get the computed step or
 * ratio, everything else restates the relationship from the tier. That genericness is
 * a real defect when it is the only source — every non-arithmetic series collapses to
 * "spot the pattern to crack the sequence", so two questions answering 53 and K got
 * byte-identical reveal copy. Prefer `q.explanation`; see explanationOf().
 */
function explanationFor(q: LoopQ, ansLabel: string): string {
  if (q.kind === "numseries") {
    const nums = (q.seq ?? []).map((t) => String(t).trim()).filter((t) => isNum(t)).map(Number);
    if (nums.length >= 2) {
      const diffs: number[] = [];
      for (let i = 1; i < nums.length; i++) diffs.push(nums[i] - nums[i - 1]);
      if (diffs.every((d) => d === diffs[0]) && diffs[0] !== 0) {
        const d = diffs[0];
        return d > 0 ? `the numbers climb by ${d} each step` : `the numbers drop by ${-d} each step`;
      }
      const r = nums[0] !== 0 ? nums[1] / nums[0] : NaN;
      if (Number.isInteger(r) && r > 1 && nums.every((n, i) => i === 0 || n === nums[i - 1] * r)) {
        return `each number is ${r} times the one before`;
      }
    }
    return "spot the pattern to crack the sequence";
  }
  const tier = (q.tier || "").toUpperCase();
  const a = ansLabel.toLowerCase();
  if (tier.includes("ODD ONE OUT")) return `the other three go together, ${a} is the odd one out`;
  if (tier.includes("ANALOGY")) return `${a} keeps the pattern`;
  if (tier.includes("SENTENCE") || tier.includes("COMPLETION")) return `${a} fits the blank`;
  return `${a} is the answer`;
}

/** The authored explanation when the bank has one, else the generated fallback. */
function explanationOf(q: LoopQ, ansLabel: string): string {
  return String(q.explanation ?? "").trim() || explanationFor(q, ansLabel);
}

/** The spoken reveal line for r<idx> (mirrors gen-narration-scripts.mjs rBeat). */
function revealVoText(kind: string, letter: string, answerSpoken: string, explanation: string, idx: number): string {
  const lead = idx % 2 === 0 ? "The answer is..." : "It's...";
  const tail = spellNums(explanation);
  const body = kind === "numseries" ? `${lead} ${answerSpoken}!` : `${lead} ${letter}, ${answerSpoken}!`;
  return `[excited] ${body} ${tail}`.replace(/\s+/g, " ").trim();
}

export interface Mapped {
  questions: any[]; // Short/FullVideo Question[]
  reveals: RevealBeatInput[]; // reveal VO to synthesize (r<idx>)
  ending: Ending;
  mode: NarrationMode;
  readVO: "full" | "none";
  /** Opening arm for the 3-second skip-rate experiment. */
  opening: Opening;
  /** Spoken-hook copy for the motion opening. Undefined on cold-plate and on the
   *  wordless motion arm. `vo` is synthesized as hook.mp3 and played OVER the
   *  animation, so it costs no extra time. */
  hook?: { title: string; subtitle?: string; vo?: string };
}

/**
 * Reconstruct a Short/FullVideo shape Question (fold / matrix family) from a loop
 * question's `figure` payload. Fills the Common fields (idx/countdown/tier + the
 * never-read bg/tierColor/accent) and DERIVES the fields the bank omits:
 *   fold.ansHoles = unfold(folds, punches, grid)     (each punch mirrored per crease)
 *   matrix/analogy2/figure-odd.ans = the ansLetter option's `fig`.
 * The figure is guaranteed present + structurally valid here (toHermesQ gate).
 */
function mapShapeQuestion(lq: LoopQ, common: Record<string, unknown>): any {
  const f = lq.figure as Figure;
  const base = {
    ...common,
    countdown: Number(f.countdown ?? common.countdown), // authored per-question solve time
    tier: lq.tier,
    ansLetter: f.ansLetter,
    ansLabel: f.ansLabel,
    // Authored explanation from the bank wins over the figure's own; the LEGACY
    // classic kinds (dot/shaded/polygon) have their figure SYNTHESIZED by
    // legacyShapes.ts, whose explanation is a per-kind template ("each shape gets
    // filled in" on all 100 shaded questions).
    explanation: String(lq.explanation ?? "").trim() || f.explanation,
    prompt: f.prompt,
  };
  if (f.kind === "fold") {
    const grid = f.grid ?? 4;
    const folds = (f.folds ?? []) as FoldDir[];
    const punches = (f.punches ?? []) as HoleCell[];
    return {
      ...base,
      kind: "fold",
      grid,
      folds,
      punches,
      options: (f.options ?? []).map((o) => ({ letter: o.letter, holes: o.holes ?? [] })),
      ansHoles: unfold(folds, punches, grid),
    };
  }
  // legacy classic-nonverbal kinds (dot / shaded / polygon): build the typed
  // render Question from the converter's figure (dotSeq/polySeq/left+rightShape +
  // typed options). ansPos/ansShape come from the ansLetter option (dot/polygon)
  // or the analogy structure (shaded: the right shape, filled).
  if (f.kind === "dot") {
    const options = (f.options ?? []).map((o) => ({ letter: o.letter, pos: o.pos }));
    const ansPos = options.find((o) => o.letter === f.ansLetter)?.pos;
    return { ...base, kind: "dot", seq: f.dotSeq ?? [], options, ansPos };
  }
  if (f.kind === "polygon") {
    const options = (f.options ?? []).map((o) => ({ letter: o.letter, poly: o.poly }));
    const ansShape = options.find((o) => o.letter === f.ansLetter)?.poly;
    return { ...base, kind: "polygon", seq: f.polySeq ?? [], options, ansShape };
  }
  if (f.kind === "shaded") {
    const options = (f.options ?? []).map((o) => ({ letter: o.letter, shape: o.shape, filled: o.filled }));
    return { ...base, kind: "shaded", leftShape: f.leftShape, rightShape: f.rightShape, options, ansShape: f.rightShape, ansFilled: true };
  }
  // matrix-family: the correct figure is the ansLetter option's `fig`.
  const options = (f.options ?? []).map((o) => ({ letter: o.letter, fig: o.fig }));
  const ans = options.find((o) => o.letter === f.ansLetter)?.fig;
  if (f.kind === "matrix") return { ...base, kind: "matrix", cells: f.cells ?? [], options, ans };
  if (f.kind === "analogy2") return { ...base, kind: "analogy2", a: f.a, b: f.b, c: f.c, options, ans };
  return { ...base, kind: "figure-odd", options, ans }; // figure-odd: options only
}

/** Map the loop's props (questions + reveal/ending + narration mode) onto the
 *  Short question shape + the reveal-VO plan + the variant toggles. Pure. */
export function mapProps(props: any): Mapped {
  const loopQs: LoopQ[] = (props.questions ?? []) as LoopQ[];
  const countdownSec = Number(props.countdownSec ?? 5);
  const ending = endingFor(props.reveal);
  let mode: NarrationMode = (props?.narration?.mode as NarrationMode) ?? "none";
  // SHAPE-SAFE NARRATION: shape options are FIGURES (not TTS-able). If any question
  // is a shape kind and the requested mode would read the options ("full" reads
  // stem+options, "no-question-vo" reads options), downgrade to "no-options-vo" so
  // we voice only the PROMPT (+ the reveal ansLabel) and never synthesize option
  // audio. "none" (music-only) is left untouched. This reuses the existing
  // no-options-vo/none handling end to end (buildDurs/generateVO make no per-option
  // clips because the mapped shape questions carry no text options).
  if (loopQs.some((q) => isShapeKind(q.kind)) && (mode === "full" || mode === "no-question-vo")) {
    mode = "no-options-vo";
  }
  const readVO = mode === "none" ? "none" : "full";
  const opening: Opening = props.opening === "motion-hook" ? "motion-hook" : "cold-plate";
  // A spoken hook is only ever carried BY the motion opening. On cold-plate it would
  // have to be a serial segment ahead of question one, which is precisely the delay the
  // motion arm already pays and lost 5.6pp of skip rate to. Enforced here rather than by
  // convention so no caller can accidentally reintroduce it.
  const hook = opening === "motion-hook" && props.hook && props.hook.title
    ? {
        title: String(props.hook.title),
        subtitle: props.hook.subtitle == null ? undefined : String(props.hook.subtitle),
        vo: props.hook.vo == null ? undefined : String(props.hook.vo),
      }
    : undefined;
  const revealIdxs = revealIndexes(loopQs.length, ending);

  const questions: any[] = [];
  const reveals: RevealBeatInput[] = [];
  loopQs.forEach((lq, i) => {
    const idx = i; // 0-based; VO clips are q<idx>/r<idx>; slotColors(idx) in the plate
    let ansLetter: string;
    let ansLabel: string;
    let answerSpoken: string;
    const common = {
      idx,
      tier: lq.tier,
      // bg/tierColor/accent are required by the Question TYPE but the plate uses
      // slotColors(idx) internally, so these values are never read at render.
      bg: "#000000",
      tierColor: "#000000",
      accent: "#000000",
      countdown: countdownSec,
      qDur: 0,
      rDur: 0,
    };
    let q: any;
    if (lq.kind === "text") {
      const options = (lq.options ?? []).slice(0, 4).map((t, j) => ({ letter: LETTERS[j], text: t }));
      const ai = options.findIndex((o) => norm(o.text) === norm(lq.answer));
      ansLetter = ai >= 0 ? LETTERS[ai] : "A";
      ansLabel = ai >= 0 ? options[ai].text : lq.answer;
      answerSpoken = isNum(ansLabel) ? n2w(ansLabel) : String(ansLabel).toLowerCase();
      const explanation = explanationOf(lq, ansLabel);
      q = { ...common, ansLetter, ansLabel, explanation, kind: "text", question: lq.prompt, questionFontSize: 62, options };
    } else if (lq.kind === "numseries") {
      // numseries: fill-in-the-blank (no A-D options). Show the series with a "?"
      // tile; the reveal badge is "?" (== the missing value) -> the answer.
      ansLetter = "?";
      ansLabel = lq.answer;
      answerSpoken = isNum(ansLabel) ? n2w(ansLabel) : String(ansLabel).toLowerCase();
      const explanation = explanationOf(lq, ansLabel);
      const seq = [...(lq.seq ?? [])];
      if (!seq.includes("?")) seq.push("?");
      q = { ...common, ansLetter, ansLabel, explanation, kind: "numseries", prompt: lq.prompt, seq, options: [] };
    } else {
      // SHAPE/FIGURE kinds (fold + matrix family): rebuild from the figure payload.
      q = mapShapeQuestion(lq, common);
      ansLetter = q.ansLetter;
      ansLabel = q.ansLabel;
      // The label is a spoken phrase ("two hearts", "2 holes"); read it as-is.
      answerSpoken = String(ansLabel).toLowerCase();
    }
    questions.push(q);
    if (revealIdxs.includes(i)) reveals.push({ index: i, text: revealVoText(lq.kind, ansLetter, answerSpoken, q.explanation, i) });
  });

  return { questions, reveals, ending, mode, readVO, opening, hook };
}

// ---------------------------------------------------------------------------
// Timeline total — MUST match remotion/src/full/timeline.ts build() SHORT path
// exactly (the composition length is set from props.totalFrames; if it diverges
// from FullVideo's internal getTimeline().total the render is cut/padded).
// ---------------------------------------------------------------------------
function countdownFrames(countdown: number, durs: Record<string, number>): number {
  return Math.max(frames(countdown + 1), frames(countdown + (durs.timesup ?? 0) + 0.3));
}
function endKeyFor(ending: Ending, platform: Platform): string {
  if (ending.endCard === "noanswer") return platform === "youtube" ? "outro-noanswer-youtube" : "outro-noanswer";
  if (ending.endCard === "verdict") return "verdict";
  return platform === "youtube" ? "outro-youtube" : "outro-follow";
}
/** Replicated Short timeline total (isShort path: cold-open, tight lead/trail). */
export function computeShortFrames(mapped: Mapped, durs: Record<string, number>, platform: Platform): number {
  const lead = SHORT_LEAD;
  const trail = SHORT_TRAIL;
  let cur = 0;
  // Opening arm: the motion-hook prepends a fixed, VO-free scene. This mirror of
  // timeline.ts build() must stay in step with it or gateRenderSanity fails the video
  // on a duration mismatch, which is exactly the kind of silent break we want loud.
  if (mapped.opening === "motion-hook") cur += frames(HOOK_SECONDS);
  mapped.questions.forEach((q, qi) => {
    const readDur = mapped.readVO === "none" ? SILENT_READ : frames(lead + (durs[`q${q.idx}`] ?? 0) + trail);
    cur += readDur;
    cur += countdownFrames(Number(q.countdown), durs);
    const isLast = qi === mapped.questions.length - 1;
    const revealThis = mapped.ending.dropReveal === "last" ? !isLast : !mapped.ending.dropReveal;
    if (revealThis) cur += frames(lead + (durs[`r${q.idx}`] ?? 0) + trail);
  });
  if (!mapped.ending.dropScore) cur += frames(lead + (durs.score ?? 0) + trail);
  cur += frames(lead + (durs[endKeyFor(mapped.ending, platform)] ?? 0) + trail);
  return cur;
}

// ---------------------------------------------------------------------------
// Durations: EXACT (synthesize VO + ffprobe committed meta) for a real render.
// ---------------------------------------------------------------------------
function buildDurs(id: string, mapped: Mapped, opts: { force?: boolean }): { durs: Record<string, number>; qrBase: string } {
  // read (q<idx>) + reveal (r<idx>) VO, one tts_batch call, measured seconds.
  const vo = generateVO(id, mapped.questions.map((q) => ({ kind: q.kind, tier: q.tier ?? "", prompt: q.kind === "text" ? q.question : q.prompt, options: q.kind === "text" ? q.options.map((o: any) => o.text) : undefined, seq: q.kind === "numseries" ? q.seq.filter((t: string) => t !== "?") : undefined, answer: q.ansLabel })), mapped.mode, mapped.reveals, { ...opts, hookVo: mapped.hook?.vo });
  // meta beats actually referenced by the timeline (measured from committed mp3s).
  const durs: Record<string, number> = { ...vo.durs };
  // BUDGET GUARD. The hook segment is a FIXED HOOK_SECONDS, so a VO longer than the
  // segment would bleed into the question read: it would talk over the question VO and
  // put the serial delay back. Drop the clip instead. The video still renders as the
  // wordless motion arm, which is a real arm rather than a broken one, and the drop is
  // loud because it means a bank line needs shortening.
  if (mapped.hook?.vo) {
    const spoken = Number(vo.durs.hook ?? 0);
    const budget = HOOK_SECONDS - SHORT_LEAD;
    if (!(spoken > 0) || spoken > budget) {
      info("hook VO over budget, dropping to the wordless motion arm", { id, spoken, budget, line: mapped.hook.vo });
      delete vo.durs.hook;
    }
  }
  durs.timesup = metaDur("timesup");
  if (!mapped.ending.dropScore) durs.score = metaDur("score");
  // The end beat is NOT platform-agnostic any more. It was, while the only platforms
  // were Instagram and TikTok and both ended on "outro-follow"; YouTube ends on
  // "outro-youtube", which is a DIFFERENT and LONGER clip (4.75s vs 4.05s). Measuring
  // only the first platform's key would leave durs["outro-youtube"] undefined, the
  // timeline would size that segment to zero, and the subscribe VO would be cut off —
  // by 0.7s, comfortably inside gateRenderSanity's 1.5s tolerance, so nothing would
  // have complained. Measure every key any RENDER_PLATFORM will ask for.
  for (const key of new Set(RENDER_PLATFORMS.map((pl) => endKeyFor(mapped.ending, pl)))) {
    durs[key] = metaDur(key);
  }
  return { durs, qrBase: vo.qrBase };
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------
/**
 * The bed for one render. Default is the planned CONFIG.MUSIC_TRACKS pick. With
 * CONFIG.MUSIC_APT on, a NET-NEW Instagram or YouTube render instead gets a per-video
 * entry point from the alternate track (see music.ts, including the rights warning).
 * Keyed on `id`, so a re-render yields the same segment.
 *
 * REPOST VERSUS NET-NEW, and why there is no flag for it. A catalogue repost keeps
 * whatever bed its source video had; only new loop output gets the alternate track.
 * That distinction needs no new parameter because the two paths ALREADY differ in
 * whether music selection happens at all:
 *
 *   - NET-NEW  : cycle -> renderForPlatforms -> renderPlatform -> shortProps -> HERE.
 *   - REPOST   : renderYouTubeFromSidecar -> retargetPropsToYouTube -> runRemotion,
 *                which spreads the STORED sidecar (`{ ...sp }`) and carries its
 *                `music` field through verbatim. It never calls shortProps, so it
 *                never reaches this function.
 *
 * The sidecar is the record of what the original render actually used, so "came from a
 * sidecar" IS "is a repost". Inventing a boolean would only restate what the call graph
 * already says, and could then disagree with it.
 *
 * TikTok is excluded outright: it is paused, and the account is already under what
 * looks like distribution suppression.
 *
 * The switch matrix lives in the pure `aptAppliesTo` predicate below so it can be
 * tested without reaching for the environment (CONFIG is frozen at import).
 */
export function aptAppliesTo(
  platform: Platform,
  on: boolean = CONFIG.MUSIC_APT,
  youtubeOn: boolean = CONFIG.MUSIC_APT_YOUTUBE,
  cleared: boolean = aptRightsCleared(),
): boolean {
  // RIGHTS FIRST, ahead of every other consideration. An uncleared bed does not ship
  // even with the switch on: that combination is what hard-blocked four Shorts.
  if (!cleared) return false;
  if (!on) return false;
  if (platform === "tiktok") return false; // paused, and already reach-suppressed
  if (platform === "youtube") return youtubeOn;
  return platform === "instagram";
}

export function musicFor(props: any, id: string, platform: Platform, applies: boolean = aptAppliesTo(platform)): string {
  const planned = String(props.music ?? "audio/music/gameshow-fanfare.mp3").replace(/^audio\/music\//, "");
  if (!applies) return planned;
  const seg = aptSegmentFor(id);
  info("music: alternate bed selected", { id, platform, segment: seg, replaced: planned });
  return seg;
}

function shortProps(mapped: Mapped, durs: Record<string, number>, qrBase: string, props: any, id: string, platform: Platform, totalFrames: number): any {
  const music = musicFor(props, id, platform);
  return {
    slug: "", // falsy -> FullVideo uses these explicit props (not a cuts.ts cut)
    platform, // per-platform SAFE ZONES
    questionIds: mapped.questions.map((q) => q.idx),
    questions: mapped.questions,
    durs,
    qrBase,
    metaBase: "audio/narration/",
    music,
    sfx: sfxSet(sfxSlugFor(id)),
    readVO: mapped.readVO,
    dropReveal: mapped.ending.dropReveal,
    dropScore: mapped.ending.dropScore,
    endCard: mapped.ending.endCard,
    showProgress: props.showProgress ?? true,
    progressStyle: props.progressStyle ?? "full",
    // Brand-mascot A/B visibility ("standard" keeps today's intro/outro brain
    // exactly; "absent" hides it; "prominent" enlarges it). Default preserves the
    // current render byte-for-byte for every non-mascot arm.
    mascot: props.mascot ?? "standard",
    // Opening arm. "cold-plate" is today's render byte-for-byte; "motion-hook" is the
    // only thing that differs between the two arms of the skip-rate experiment.
    opening: mapped.opening,
    // Plate copy for the spoken-hook arms. The Hook scene swaps its "?" for this.
    hook: mapped.hook ? { title: mapped.hook.title, subtitle: mapped.hook.subtitle } : undefined,
    totalFrames,
  };
}

function runRemotion(id: string, platform: Platform, sp: any, outMp4: string): void {
  const propsFile = join(CONFIG.RENDERS_DIR, `${id}.${platform}.props.json`);
  writeFileSync(propsFile, JSON.stringify(sp));
  const args = ["remotion", "render", "Short", outMp4, `--props=${propsFile}`, "--log=error", "--concurrency=2"];
  info("rendering", { id, platform, frames: sp.totalFrames });
  const res = spawnSync("npx", args, { cwd: CONFIG.REMOTION_DIR, encoding: "utf8", timeout: 10 * 60_000, env: { ...process.env } });
  if (res.status !== 0) {
    throw new Error(`remotion render failed for ${id}/${platform} (status ${res.status}): ${(res.stderr || res.stdout || "").slice(-800)}`);
  }
  if (!existsSync(outMp4) || statSync(outMp4).size < 50_000) {
    throw new Error(`remotion render produced no/tiny file for ${id}/${platform}`);
  }
}

/**
 * Render ONE platform (idempotent: reuse an existing non-trivial render unless
 * force). Shared by renderForPlatforms + renderVideo so the reuse/shortProps/
 * runRemotion logic lives in one place.
 */
function renderOne(
  id: string,
  mapped: Mapped,
  durs: Record<string, number>,
  qrBase: string,
  props: any,
  platform: Platform,
  totalFrames: number,
  opts: { force?: boolean },
): PlatformRender {
  const outMp4 = join(CONFIG.RENDERS_DIR, `${id}.${platform}.mp4`);
  if (!opts.force && existsSync(outMp4) && statSync(outMp4).size > 100_000) {
    info("render reused", { id, platform, out: outMp4 });
    return { platform, path: outMp4, frames: totalFrames, reused: true };
  }
  const sp = shortProps(mapped, durs, qrBase, props, id, platform, totalFrames);
  runRemotion(id, platform, sp, outMp4);
  info("rendered", { id, platform, out: outMp4, bytes: statSync(outMp4).size });
  return { platform, path: outMp4, frames: totalFrames, reused: false };
}

/**
 * Render `id`'s video for EVERY platform in RENDER_PLATFORMS (each with its own
 * SAFE ZONES). VO is synthesized once and shared across platforms. Idempotent:
 * an existing non-trivial per-platform render is reused unless force=true.
 * Also stashes the resolved frame count/durs onto `props` so a later
 * computeFrames(props) is exact.
 */
export function renderForPlatforms(id: string, props: any, opts: { force?: boolean } = {}): PlatformRender[] {
  mkdirSync(CONFIG.RENDERS_DIR, { recursive: true });
  const mapped = mapProps(props);
  const { durs, qrBase } = buildDurs(id, mapped, opts);

  // ONE TOTAL PER PLATFORM. This used to be a single number, on the (then true) grounds
  // that Instagram and TikTok share an outro. YouTube does not: on the full-reveal
  // ending it plays "outro-youtube" (4.75s) where the others play "outro-follow"
  // (4.05s), a 21-frame difference at 30fps. totalFrames sets the COMPOSITION LENGTH,
  // so a shared number would have truncated the YouTube render mid-CTA — and by less
  // than gateRenderSanity's 1.5s tolerance, so it would have shipped silently. On the
  // cliffhanger / no-answer endings all three still agree, and this returns the same
  // number for each, so nothing changes for those.
  const framesByPlatform = new Map<Platform, number>(
    RENDER_PLATFORMS.map((pl) => [pl, computeShortFrames(mapped, durs, pl)]),
  );
  // The stash feeds computeFrames(props) and the dashboard preview, which are
  // single-number contracts: use the FIRST platform (Instagram, the measurable arm).
  const totalFrames = framesByPlatform.get(RENDER_PLATFORMS[0]) as number;
  props.__short = { totalFrames, durs, qrBase, framesByPlatform: Object.fromEntries(framesByPlatform) };
  props.totalFrames = totalFrames;

  return RENDER_PLATFORMS.map((platform) =>
    renderOne(id, mapped, durs, qrBase, props, platform, framesByPlatform.get(platform) as number, opts),
  );
}

/**
 * Render ONE video (the default platform) — the contract the standalone
 * sffs_render bridge relies on. Returns a single RenderResult.
 */
export function renderVideo(id: string, props: any, opts: { force?: boolean } = {}): RenderResult {
  mkdirSync(CONFIG.RENDERS_DIR, { recursive: true });
  const mapped = mapProps(props);
  const { durs, qrBase } = buildDurs(id, mapped, opts);
  const totalFrames = computeShortFrames(mapped, durs, DEFAULT_PLATFORM);
  props.__short = { totalFrames, durs, qrBase };
  props.totalFrames = totalFrames;

  const { path, frames, reused } = renderOne(id, mapped, durs, qrBase, props, DEFAULT_PLATFORM, totalFrames, opts);
  return { path, frames, reused };
}

/**
 * The end-beat key a STORED sidecar's endCard resolves to on `platform`.
 * Mirrors remotion/src/full/timeline.ts endCardKey(); the two must agree or the
 * composition length and the audio it has to cover come from different beats.
 */
export function endKeyForCard(endCard: string | undefined, platform: Platform): string {
  if (endCard === "noanswer") return platform === "youtube" ? "outro-noanswer-youtube" : "outro-noanswer";
  if (endCard === "verdict") return "verdict";
  return platform === "youtube" ? "outro-youtube" : "outro-follow";
}

/**
 * Retarget an ALREADY-RENDERED video's stored props sidecar
 * (`<id>.<platform>.props.json`, written by runRemotion) at YouTube.
 *
 * WHY THIS EXISTS. The catalogue backfill re-publishes videos that have already run on
 * Instagram or TikTok, and those masters are wrong for YouTube twice over: they carry
 * the FOLLOW CTA rather than SUBSCRIBE, and the Instagram cut is laid out for the IG
 * safe box, which does NOT clear the Shorts caption band. Re-uploading the master would
 * ship both faults. The sidecar is the exact Remotion input the original render used —
 * same questions, same measured `durs`, same VO clips, same music and sfx, same opening
 * arm — so flipping `platform` reproduces the SAME VIDEO through the corrected path
 * rather than reconstructing a lookalike. Everything that changes is something we WANT
 * to change for YouTube.
 *
 * THE ONE THING THAT IS NOT A FIELD SWAP is the length. totalFrames sets the composition
 * length, and on the full-reveal ending YouTube plays `outro-youtube` (4.75s) where the
 * others play `outro-follow` (4.05s). Carrying the old number over would truncate the
 * render ~21 frames early, mid subscribe-CTA — and by less than gateRenderSanity's 1.5s
 * tolerance, so it would ship silently. So the end beat is re-measured off the file that
 * will actually play and the delta is applied. On the cliffhanger / no-answer endings
 * YouTube now has its OWN no-answer clip too (`outro-noanswer-youtube`: "link in the
 * description" where the others say "link in our bio"), so that ending re-measures the
 * same way. Only `verdict`, which carries no platform pointer, is still one clip
 * everywhere and still carries its length through untouched.
 *
 * Pure apart from the ffprobe measurement, and it never mutates the input.
 */
export function retargetPropsToYouTube(sp: any): { props: any; endKey: string; frameDelta: number } {
  if (!sp || typeof sp !== "object") throw new Error("retargetPropsToYouTube: no props");
  const from = String(sp.platform ?? "") as Platform;
  const durs: Record<string, number> = { ...(sp.durs ?? {}) };
  const oldKey = endKeyForCard(sp.endCard, from);
  const newKey = endKeyForCard(sp.endCard, "youtube");

  let delta = 0;
  if (newKey !== oldKey) {
    // Measure the beat that will actually play, off the committed copy — the same
    // source buildDurs() uses, so a re-render and an original render agree.
    if (!(durs[newKey] > 0)) durs[newKey] = metaDur(newKey);
    const oldDur = durs[oldKey];
    if (!(oldDur > 0)) {
      throw new Error(`retargetPropsToYouTube: sidecar has no duration for its own end beat "${oldKey}" — refusing to guess the length`);
    }
    delta = frames(SHORT_LEAD + durs[newKey] + SHORT_TRAIL) - frames(SHORT_LEAD + oldDur + SHORT_TRAIL);
  }
  const totalFrames = Number(sp.totalFrames) + delta;
  if (!Number.isFinite(totalFrames) || totalFrames <= 0) {
    throw new Error(`retargetPropsToYouTube: bad totalFrames ${sp.totalFrames} -> ${totalFrames}`);
  }
  return { props: { ...sp, platform: "youtube" as Platform, durs, totalFrames }, endKey: newKey, frameDelta: delta };
}

/**
 * Render `id` for YouTube from its STORED sidecar. Idempotent like renderOne: an
 * existing non-trivial `<id>.youtube.mp4` is reused unless force.
 */
export function renderYouTubeFromSidecar(id: string, sidecarPath: string, opts: { force?: boolean } = {}): PlatformRender {
  mkdirSync(CONFIG.RENDERS_DIR, { recursive: true });
  const stored = JSON.parse(readFileSync(sidecarPath, "utf8"));
  const { props: sp } = retargetPropsToYouTube(stored);
  const outMp4 = join(CONFIG.RENDERS_DIR, `${id}.youtube.mp4`);
  if (!opts.force && existsSync(outMp4) && statSync(outMp4).size > 100_000) {
    info("youtube render reused", { id, out: outMp4 });
    return { platform: "youtube", path: outMp4, frames: sp.totalFrames, reused: true };
  }
  runRemotion(id, "youtube", sp, outMp4);
  info("rendered for youtube from sidecar", { id, out: outMp4, bytes: statSync(outMp4).size, frames: sp.totalFrames });
  return { platform: "youtube", path: outMp4, frames: sp.totalFrames, reused: false };
}

export interface ShortCheck {
  ok: boolean;
  width: number;
  height: number;
  seconds: number;
  hasAudio: boolean;
  problems: string[];
}

/**
 * Assert a rendered file is actually publishable AS A YOUTUBE SHORT.
 *
 * This is NOT publishGate. That gate judges freshly GENERATED content — prompt
 * integrity, explanation novelty against a rolling window, caption quality — and a
 * catalogue re-publish would fail it for the wrong reason: these videos have already
 * run, so their own explanations are already inside the novelty window. Running it
 * here would either block the whole backfill or have to be softened, and softening a
 * content gate to let old content through is how a content gate stops meaning anything.
 *
 * What actually matters for a re-publish is that the FILE is a legal Short, because
 * YouTube classifies on the file rather than on any flag we can send:
 *
 *   - PORTRAIT, square or taller. A landscape upload is a normal video, silently.
 *   - UNDER THE DURATION LINE, with margin. YouTube can lengthen a video slightly in
 *     processing and reclassify a borderline one as long-form, so the ceiling is
 *     CONFIG.YOUTUBE.maxDurationSeconds (170s) rather than the nominal 180.
 *   - AUDIO PRESENT. A silent render is the failure mode a props/VO-path mistake
 *     produces, and it is invisible in every other check we run.
 */
export function verifyShortForYouTube(path: string): ShortCheck {
  const probe = execFileSync(resolveFfprobe().replace(/ffprobe$/, "ffprobe"), [
    "-v", "error", "-show_entries", "stream=codec_type,width,height:format=duration",
    "-of", "json", path,
  ], { encoding: "utf8" });
  const j = JSON.parse(probe);
  const v = (j.streams ?? []).find((x: any) => x.codec_type === "video") ?? {};
  const width = Number(v.width ?? 0);
  const height = Number(v.height ?? 0);
  const seconds = Number(j.format?.duration ?? 0);
  const hasAudio = (j.streams ?? []).some((x: any) => x.codec_type === "audio");
  const problems: string[] = [];
  if (!(width > 0 && height > 0)) problems.push("no video stream");
  else if (height < width) problems.push(`landscape ${width}x${height} — YouTube would file this as a normal video, not a Short`);
  if (!(seconds > 0)) problems.push("no duration");
  else if (seconds > CONFIG.YOUTUBE.maxDurationSeconds) {
    problems.push(`${seconds.toFixed(1)}s exceeds the ${CONFIG.YOUTUBE.maxDurationSeconds}s Shorts ceiling`);
  }
  if (!hasAudio) problems.push("no audio stream — a silent render is what a broken VO path produces");
  return { ok: problems.length === 0, width, height, seconds, hasAudio, problems };
}

/**
 * TikTok's own duration ceiling for this account's uploads. TikTok itself allows far
 * longer, so this is not a platform limit but a sanity bound: a render that overruns it
 * is a props/length bug rather than an intentionally long video, and shipping it during
 * a distribution probe would confound the experiment with a second variable.
 */
export const TIKTOK_MAX_SECONDS = 600;

/**
 * Retarget an ALREADY-RENDERED video's stored props sidecar
 * (`<id>.<platform>.props.json`, written by runRemotion) at TikTok.
 *
 * WHY THIS EXISTS, and why it is NOT the same shrug as "just upload the master". The
 * Instagram cut is laid out for the IG safe box (SafeArea.SAFE -> x120-960, y220-1570).
 * TikTok's content-safe box is TT_BOX -> x140-940, y214-1440, because TikTok's bottom
 * caption/username/CTA band starts at y1440. So the IG cut's content runs 130px INTO
 * TikTok's caption band, where the platform's own chrome sits on top of it. Re-uploading
 * the Instagram master to TikTok ships that fault, which is the same mistake already
 * made once by shipping an IG cut to YouTube. Re-rendering from the sidecar reproduces
 * the SAME VIDEO -- same questions, same measured `durs`, same VO, same music and sfx,
 * same opening arm -- through the TikTok layout path, so the only thing that changes is
 * the thing we want changed.
 *
 * LENGTH. Unlike the YouTube retarget this is normally a pure field swap: endKeyForCard
 * resolves `instagram` and `tiktok` to the SAME end beat (`outro-follow` on the
 * full-reveal ending, `outro-noanswer` / `verdict` on the others), so the delta is zero
 * and totalFrames carries through untouched. The measurement is kept anyway rather than
 * assumed, because the only thing guaranteeing the two agree is endKeyForCard, and a
 * future divergence there should change the length rather than silently truncate the
 * render the way the YouTube case would have.
 *
 * Pure apart from the ffprobe measurement, and it never mutates the input.
 */
export function retargetPropsToTikTok(sp: any): { props: any; endKey: string; frameDelta: number } {
  if (!sp || typeof sp !== "object") throw new Error("retargetPropsToTikTok: no props");
  const from = String(sp.platform ?? "") as Platform;
  const durs: Record<string, number> = { ...(sp.durs ?? {}) };
  const oldKey = endKeyForCard(sp.endCard, from);
  const newKey = endKeyForCard(sp.endCard, "tiktok");

  let delta = 0;
  if (newKey !== oldKey) {
    if (!(durs[newKey] > 0)) durs[newKey] = metaDur(newKey);
    const oldDur = durs[oldKey];
    if (!(oldDur > 0)) {
      throw new Error(`retargetPropsToTikTok: sidecar has no duration for its own end beat "${oldKey}" — refusing to guess the length`);
    }
    delta = frames(SHORT_LEAD + durs[newKey] + SHORT_TRAIL) - frames(SHORT_LEAD + oldDur + SHORT_TRAIL);
  }
  const totalFrames = Number(sp.totalFrames) + delta;
  if (!Number.isFinite(totalFrames) || totalFrames <= 0) {
    throw new Error(`retargetPropsToTikTok: bad totalFrames ${sp.totalFrames} -> ${totalFrames}`);
  }
  return { props: { ...sp, platform: "tiktok" as Platform, durs, totalFrames }, endKey: newKey, frameDelta: delta };
}

/**
 * Render `id` for TikTok from its STORED sidecar. Idempotent like renderOne: an
 * existing non-trivial `<id>.tiktok.mp4` is reused unless force.
 *
 * THE MUSIC IS CARRIED THROUGH VERBATIM, and that is load-bearing rather than
 * incidental. This path never calls shortProps, so it never reaches musicFor and the
 * alternate APT bed can NOT be substituted here even when HERMES_MUSIC_APT is on. That
 * matches aptAppliesTo, which excludes TikTok outright: the account is already under
 * what looks like distribution suppression, and an unlicensed sync use is exactly the
 * confound a suppression experiment cannot afford. Two independent mechanisms therefore
 * have to fail before an APT segment reaches TikTok.
 */
export function renderTikTokFromSidecar(id: string, sidecarPath: string, opts: { force?: boolean } = {}): PlatformRender {
  mkdirSync(CONFIG.RENDERS_DIR, { recursive: true });
  const stored = JSON.parse(readFileSync(sidecarPath, "utf8"));
  const { props: sp } = retargetPropsToTikTok(stored);
  const outMp4 = join(CONFIG.RENDERS_DIR, `${id}.tiktok.mp4`);
  if (!opts.force && existsSync(outMp4) && statSync(outMp4).size > 100_000) {
    info("tiktok render reused", { id, out: outMp4 });
    return { platform: "tiktok", path: outMp4, frames: sp.totalFrames, reused: true };
  }
  runRemotion(id, "tiktok", sp, outMp4);
  info("rendered for tiktok from sidecar", { id, out: outMp4, bytes: statSync(outMp4).size, frames: sp.totalFrames });
  return { platform: "tiktok", path: outMp4, frames: sp.totalFrames, reused: false };
}

/**
 * Assert a rendered file is actually publishable ON TIKTOK.
 *
 * Same division of labour as verifyShortForYouTube: this judges the FILE, not the
 * content. What TikTok decides from the file alone is whether it plays full-bleed in the
 * feed (portrait) and whether it has audio at all — a silent render is what a broken VO
 * path produces and it is invisible to every other check we run. The frame size is
 * pinned exactly rather than merely "portrait" because the TT_BOX safe-box geometry in
 * remotion/src/components/SafeArea.tsx is expressed in 1080x1920 pixels; at any other
 * raster those coordinates, and the pixel proof built on them, mean nothing.
 */
export function verifyForTikTok(path: string): ShortCheck {
  const probe = execFileSync(resolveFfprobe().replace(/ffprobe$/, "ffprobe"), [
    "-v", "error", "-show_entries", "stream=codec_type,width,height:format=duration",
    "-of", "json", path,
  ], { encoding: "utf8" });
  const j = JSON.parse(probe);
  const v = (j.streams ?? []).find((x: any) => x.codec_type === "video") ?? {};
  const width = Number(v.width ?? 0);
  const height = Number(v.height ?? 0);
  const seconds = Number(j.format?.duration ?? 0);
  const hasAudio = (j.streams ?? []).some((x: any) => x.codec_type === "audio");
  const problems: string[] = [];
  if (!(width > 0 && height > 0)) problems.push("no video stream");
  else if (height < width) problems.push(`landscape ${width}x${height} — TikTok would letterbox this in a portrait feed`);
  else if (width !== 1080 || height !== 1920) {
    problems.push(`${width}x${height} is not the 1080x1920 raster the TT_BOX safe-box geometry is defined in`);
  }
  if (!(seconds > 0)) problems.push("no duration");
  else if (seconds > TIKTOK_MAX_SECONDS) problems.push(`${seconds.toFixed(1)}s exceeds the ${TIKTOK_MAX_SECONDS}s ceiling`);
  if (!hasAudio) problems.push("no audio stream — a silent render is what a broken VO path produces");
  return { ok: problems.length === 0, width, height, seconds, hasAudio, problems };
}

/**
 * Frame count for `props`. After a render it is EXACT (stashed on props.__short);
 * for the dry-run PREVIEW (bridge/render.ts --dry-run: no TTS/ffprobe/Chromium)
 * it is a nominal estimate. MUST stay a plain number for gateRenderSanity/preview.
 */
export function computeFrames(props: any): number {
  if (props?.__short?.totalFrames) return Number(props.__short.totalFrames);
  const mapped = mapProps(props);
  // nominal durs (no TTS, no ffprobe) — a ballpark for the dry-run preview only.
  const durs: Record<string, number> = { timesup: NOMINAL.timesup, score: NOMINAL.score, "outro-follow": NOMINAL["outro-follow"], "outro-noanswer": NOMINAL["outro-noanswer"], "outro-noanswer-youtube": NOMINAL["outro-noanswer-youtube"], verdict: NOMINAL.verdict };
  mapped.questions.forEach((q) => {
    if (mapped.readVO !== "none") durs[`q${q.idx}`] = NOMINAL.read;
  });
  for (const r of mapped.reveals) durs[`r${r.index}`] = NOMINAL.reveal;
  return computeShortFrames(mapped, durs, DEFAULT_PLATFORM);
}
