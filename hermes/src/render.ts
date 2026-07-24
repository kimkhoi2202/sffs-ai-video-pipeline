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
 *                              TikTok gets its up-scaled UI-safe transform, IG/YT
 *                              the IG safe box. We render ONCE PER PLATFORM so each
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
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG } from "./config.ts";
import { info } from "./log.ts";
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
const frames = (s: number): number => Math.round(s * FPS);

export type Platform = "youtube" | "instagram" | "tiktok";
/** The platforms the loop renders + drafts (each gets its OWN safe-zone render).
 *  Order matches CONFIG.ACCOUNT_IDS / cycle.ts annotateDb (instagram, tiktok). */
export const RENDER_PLATFORMS: Platform[] = ["instagram", "tiktok"];
/** Default single-platform for the standalone sffs_render bridge. TikTok's safe
 *  box is the tightest (⊆ the IG box), so a single tiktok render is safe on both. */
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
const NOMINAL = { timesup: 1.2, score: 20.8, "outro-follow": 6.0, "outro-youtube": 6.0, "outro-noanswer": 5.0, verdict: 4.0, read: 3.0, reveal: 2.0 } as const;

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
  /** Structured render-ready payload for the shape/figure kinds (undefined for
   *  text/numseries). Carried through from the bank via toHermesQ + design.ts. */
  figure?: Figure;
}

/** A short, HONEST explanation for the reveal plate + reveal VO (no LLM, never a
 *  fabricated fact): number-series get the computed step/ratio; text restates the
 *  relationship. */
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

/** The spoken reveal line for r<idx> (mirrors gen-narration-scripts.mjs rBeat). */
function revealVoText(kind: string, letter: string, answerSpoken: string, explanation: string, idx: number): string {
  const lead = idx % 2 === 0 ? "The answer is..." : "It's...";
  const tail = spellNums(explanation);
  const body = kind === "numseries" ? `${lead} ${answerSpoken}!` : `${lead} ${letter}, ${answerSpoken}!`;
  return `[excited] ${body} ${tail}`.replace(/\s+/g, " ").trim();
}

interface Mapped {
  questions: any[]; // Short/FullVideo Question[]
  reveals: RevealBeatInput[]; // reveal VO to synthesize (r<idx>)
  ending: Ending;
  mode: NarrationMode;
  readVO: "full" | "none";
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
    explanation: f.explanation,
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
      const explanation = explanationFor(lq, ansLabel);
      q = { ...common, ansLetter, ansLabel, explanation, kind: "text", question: lq.prompt, questionFontSize: 62, options };
    } else if (lq.kind === "numseries") {
      // numseries: fill-in-the-blank (no A-D options). Show the series with a "?"
      // tile; the reveal badge is "?" (== the missing value) -> the answer.
      ansLetter = "?";
      ansLabel = lq.answer;
      answerSpoken = isNum(ansLabel) ? n2w(ansLabel) : String(ansLabel).toLowerCase();
      const explanation = explanationFor(lq, ansLabel);
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

  return { questions, reveals, ending, mode, readVO };
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
  if (ending.endCard === "noanswer") return "outro-noanswer";
  if (ending.endCard === "verdict") return "verdict";
  return platform === "youtube" ? "outro-youtube" : "outro-follow";
}
/** Replicated Short timeline total (isShort path: cold-open, tight lead/trail). */
function computeShortFrames(mapped: Mapped, durs: Record<string, number>, platform: Platform): number {
  const lead = SHORT_LEAD;
  const trail = SHORT_TRAIL;
  let cur = 0;
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
  const vo = generateVO(id, mapped.questions.map((q) => ({ kind: q.kind, tier: q.tier ?? "", prompt: q.kind === "text" ? q.question : q.prompt, options: q.kind === "text" ? q.options.map((o: any) => o.text) : undefined, seq: q.kind === "numseries" ? q.seq.filter((t: string) => t !== "?") : undefined, answer: q.ansLabel })), mapped.mode, mapped.reveals, opts);
  // meta beats actually referenced by the timeline (measured from committed mp3s).
  const durs: Record<string, number> = { ...vo.durs };
  durs.timesup = metaDur("timesup");
  if (!mapped.ending.dropScore) durs.score = metaDur("score");
  const endKey = endKeyFor(mapped.ending, RENDER_PLATFORMS[0]); // platform-agnostic for shorts (follow/noanswer/verdict)
  durs[endKey] = metaDur(endKey);
  return { durs, qrBase: vo.qrBase };
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------
function shortProps(mapped: Mapped, durs: Record<string, number>, qrBase: string, props: any, id: string, platform: Platform, totalFrames: number): any {
  const music = String(props.music ?? "audio/music/gameshow-fanfare.mp3").replace(/^audio\/music\//, "");
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
  // Shorts: the total is identical across tiktok/instagram (both cold-open, same
  // follow/noanswer outro), so compute once.
  const totalFrames = computeShortFrames(mapped, durs, RENDER_PLATFORMS[0]);
  // stash for computeFrames(props) (exact after a render) + the dashboard.
  props.__short = { totalFrames, durs, qrBase };
  props.totalFrames = totalFrames;

  return RENDER_PLATFORMS.map((platform) =>
    renderOne(id, mapped, durs, qrBase, props, platform, totalFrames, opts),
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
 * Frame count for `props`. After a render it is EXACT (stashed on props.__short);
 * for the dry-run PREVIEW (bridge/render.ts --dry-run: no TTS/ffprobe/Chromium)
 * it is a nominal estimate. MUST stay a plain number for gateRenderSanity/preview.
 */
export function computeFrames(props: any): number {
  if (props?.__short?.totalFrames) return Number(props.__short.totalFrames);
  const mapped = mapProps(props);
  // nominal durs (no TTS, no ffprobe) — a ballpark for the dry-run preview only.
  const durs: Record<string, number> = { timesup: NOMINAL.timesup, score: NOMINAL.score, "outro-follow": NOMINAL["outro-follow"], "outro-noanswer": NOMINAL["outro-noanswer"], verdict: NOMINAL.verdict };
  mapped.questions.forEach((q) => {
    if (mapped.readVO !== "none") durs[`q${q.idx}`] = NOMINAL.read;
  });
  for (const r of mapped.reveals) durs[`r${r.index}`] = NOMINAL.reveal;
  return computeShortFrames(mapped, durs, DEFAULT_PLATFORM);
}
