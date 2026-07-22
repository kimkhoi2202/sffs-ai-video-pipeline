/**
 * render-paperfold-samples.ts — ISOLATED sample renderer for the new PAPER
 * FOLDING (kind: "fold") question type. Renders 1-2 on-brand 9:16 shorts through
 * the REAL `Short` (FullVideo) composition so the fold/punch/unfold plate is seen
 * exactly as production would draw it, then ffprobe-verifies each output.
 *
 * Fully local + isolated: it does NOT call any TTS/API and does NOT touch the
 * master bank, the box/VPS, the live loop, the dashboard, or any worker. It reads
 * the staging file (content/staging-new-types-paperfold.json), MACHINE-VERIFIES
 * every answer key (ansHoles = unfold(folds, punches) must equal the option marked
 * ansLetter, and every punch must sit in the folded packet), reuses the committed
 * music / SFX / meta narration (timesup, score, outro), and synthesizes only
 * short SILENT reveal-VO placeholders (readVO="none", so no question VO is needed)
 * — the samples are for reviewing the VISUAL, not the narration.
 *
 * Run from remotion/:  npx tsx scripts/render-paperfold-samples.ts [--only 1|2]
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getTimeline, FPS, type Platform, type SfxSet, type Variant, type EndCard } from "../src/full/timeline";
import { COLORS } from "../src/theme/brand";
import { unfold, inActiveRegion, sameHoles, type FoldDir, type HoleCell } from "../src/data/fold";

const REMOTION = resolve(import.meta.dirname, "..");
const VIDEO = resolve(REMOTION, "..");
const CONTENT = join(VIDEO, "content");
const STAGING = join(CONTENT, "staging-new-types-paperfold.json");
const SILENT_ABS = join(REMOTION, "public", "audio", "rounds", "paperfold-samples"); // our silent placeholder VO
const SILENT_REL = "audio/rounds/paperfold-samples/";
const OUT_ROOT = join(VIDEO, "renders.nosync", "new-types-samples", "paperfold");
const FFMPEG = process.env.FFMPEG || "/opt/homebrew/bin/ffmpeg";
const FFPROBE = process.env.FFPROBE || "/opt/homebrew/bin/ffprobe";

const sfxSet = (slug: string): SfxSet => ({ whoosh: `${slug}/whoosh.mp3`, ding: `${slug}/ding.mp3`, sting: `${slug}/sting.mp3` });

// The 1-2 sample shorts. Each is a distinct cut of the staging items with its own
// music bed + SFX set (so they don't sound identical), rendered 1080x1920.
type Sample = { n: number; name: string; ids: number[]; music: string; sfxSlug: string; endCard: EndCard; dropScore: boolean };
const SAMPLES: Sample[] = [
  { n: 1, name: "sample-1-three", ids: [1, 2, 3], music: "gameshow-fanfare.mp3", sfxSlug: "short-1", endCard: "default", dropScore: false },
  { n: 2, name: "sample-2-hard-hero", ids: [4], music: "prize-wheel-parade.mp3", sfxSlug: "short-2", endCard: "verdict", dropScore: true },
];

// reveal-VO placeholder length per item (s) — sets how long each reveal holds.
const R_DUR: Record<number, number> = { 1: 4.6, 2: 4.6, 3: 5.0, 4: 5.6 };
// Silent meta-beat placeholder lengths (s). These are generated locally (no TTS)
// and pace the countdown tail / score / outro. Kept tight so the silent samples
// don't sit on a ~21s narrated score screen; music + ticks + SFX still play.
const META_DUR: Record<string, number> = { timesup: 1.2, score: 4.0, "outro-follow": 4.0, verdict: 3.8 };

function ffprobe(file: string, args: string[]): string {
  return execFileSync(FFPROBE, ["-v", "error", ...args, file], { encoding: "utf8" }).trim();
}
const durOf = (file: string): number => Number(ffprobe(file, ["-show_entries", "format=duration", "-of", "default=nk=1:nw=1"]));

function makeSilent(outFile: string, seconds: number) {
  execFileSync(
    FFMPEG,
    ["-y", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono", "-t", String(seconds), "-c:a", "libmp3lame", "-q:a", "9", outFile],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
}

type StagingItem = {
  id: number; kind: "fold"; category: string; difficulty: string; tier: string; countdown: number;
  grid: number; prompt: string; folds: FoldDir[]; punches: HoleCell[];
  options: { letter: string; holes: HoleCell[] }[]; ansLetter: string; ansLabel: string; explanation: string;
};

/** Validate + convert a staging item to a runtime FoldQuestion (with machine-
 *  derived, verified ansHoles). Throws on any key/geometry inconsistency. */
function toFold(it: StagingItem, durs: Record<string, number>) {
  const n = it.grid ?? 4;
  const vFolds = it.folds.filter((f) => f === "left" || f === "right");
  const hFolds = it.folds.filter((f) => f === "up" || f === "down");
  if (vFolds.length > 1 || hFolds.length > 1) throw new Error(`Q${it.id}: at most one V and one H fold (got ${it.folds.join(",")})`);
  const inRegion = inActiveRegion(it.folds, n);
  for (const p of it.punches) if (!inRegion(p)) throw new Error(`Q${it.id}: punch {r:${p.r},c:${p.c}} is not in the folded packet`);
  const ansHoles = unfold(it.folds, it.punches, n);
  const keyed = it.options.find((o) => o.letter === it.ansLetter);
  if (!keyed) throw new Error(`Q${it.id}: ansLetter ${it.ansLetter} has no option`);
  if (!sameHoles(keyed.holes, ansHoles)) {
    throw new Error(`Q${it.id}: option ${it.ansLetter} != unfold(folds,punches). expected ${JSON.stringify(ansHoles)}`);
  }
  const C = [COLORS.blue, COLORS.mint, COLORS.coral, COLORS.yellow, COLORS.green];
  return {
    kind: "fold" as const, idx: it.id, bg: C[it.id % C.length], tier: it.tier, tierColor: COLORS.mint, accent: COLORS.yellow,
    countdown: it.countdown, ansLetter: it.ansLetter, ansLabel: it.ansLabel, explanation: it.explanation,
    qDur: 0, rDur: durs[`r${it.id}`] ?? 0,
    prompt: it.prompt, grid: n, folds: it.folds, punches: it.punches, options: it.options, ansHoles,
  };
}

function parseArgs(): { only?: number } {
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) if (a[i] === "--only") return { only: Number(a[++i]) };
  return {};
}

function main() {
  const { only } = parseArgs();
  const staging = JSON.parse(readFileSync(STAGING, "utf8")) as { questions: StagingItem[] };
  mkdirSync(SILENT_ABS, { recursive: true });
  mkdirSync(OUT_ROOT, { recursive: true });

  // All narration is SILENT placeholders generated locally (no TTS/API). metaBase
  // + qrBase both point at our silent dir, so meta beats (timesup/score/outro/
  // verdict) and reveal beats are locally paced; music + ticks + SFX still play.
  const durs: Record<string, number> = {};
  for (const [beat, secs] of Object.entries(META_DUR)) {
    const f = join(SILENT_ABS, `${beat}.mp3`);
    if (!existsSync(f)) makeSilent(f, secs);
    durs[beat] = durOf(f);
  }
  // silent reveal-VO placeholder per item -> defines the reveal hold length.
  for (const it of staging.questions) {
    const secs = R_DUR[it.id] ?? 4.6;
    const f = join(SILENT_ABS, `r${it.id}.mp3`);
    if (!existsSync(f)) makeSilent(f, secs);
    durs[`r${it.id}`] = durOf(f);
  }

  const questions = staging.questions.map((it) => toFold(it, durs));
  console.log(`[paperfold] verified ${questions.length} staging items (answer keys + fold geometry OK)`);

  const samples = only ? SAMPLES.filter((s) => s.n === only) : SAMPLES;
  const results: { file: string; expectSec: number }[] = [];

  for (const s of samples) {
    const variant: Variant = { readVO: "none", dropScore: s.dropScore, endCard: s.endCard, metaBase: SILENT_REL };
    const T = getTimeline("instagram" as Platform, s.ids, sfxSet(s.sfxSlug), questions as any, durs, SILENT_REL, variant);
    const expectSec = T.total / FPS;
    const outMp4 = join(OUT_ROOT, `${s.n}.mp4`);
    const props = {
      slug: "", platform: "instagram", questionIds: s.ids, questions, durs, qrBase: SILENT_REL,
      music: s.music, sfx: sfxSet(s.sfxSlug), readVO: "none", dropReveal: false, dropScore: s.dropScore,
      endCard: s.endCard, metaBase: SILENT_REL, totalFrames: T.total,
    };
    const propsFile = join(SILENT_ABS, `_props-${s.n}.json`);
    writeFileSync(propsFile, JSON.stringify(props));
    console.log(`\n[render ${s.n}] ${s.name}  Q[${s.ids.join(",")}]  ~${expectSec.toFixed(1)}s  music=${s.music}`);
    const r = spawnSync("npx", ["remotion", "render", "Short", outMp4, `--props=${propsFile}`, "--log=error"], { cwd: REMOTION, stdio: ["ignore", "inherit", "inherit"] });
    if (r.status !== 0) throw new Error(`render failed: sample ${s.n} (exit ${r.status})`);

    // ffprobe verify: 1080x1920 + duration matches the timeline + A/V aligned.
    const [w, h] = ffprobe(outMp4, ["-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0"]).split(",").map(Number);
    const container = durOf(outMp4);
    const aDur = Number(ffprobe(outMp4, ["-select_streams", "a:0", "-show_entries", "stream=duration", "-of", "default=nk=1:nw=1"]) || "0");
    const problems: string[] = [];
    if (w !== 1080 || h !== 1920) problems.push(`aspect ${w}x${h} != 1080x1920`);
    if (Math.abs(container - expectSec) > 0.4) problems.push(`duration ${container.toFixed(2)}s vs expected ${expectSec.toFixed(2)}s`);
    if (aDur > 0 && Math.abs(aDur - container) > 0.4) problems.push(`A/V drift ${(aDur - container).toFixed(2)}s`);
    if (problems.length) throw new Error(`ffprobe verify FAILED sample ${s.n}: ${problems.join("; ")}`);
    console.log(`  [ok] ${outMp4}  ${w}x${h}  ${container.toFixed(2)}s (audio ${aDur.toFixed(2)}s)`);
    results.push({ file: outMp4, expectSec: container });
  }

  console.log(`\n[done] ${results.length} paper-folding sample(s):`);
  for (const r of results) console.log(`  ${r.file}  (${r.expectSec.toFixed(2)}s)`);
}

main();
