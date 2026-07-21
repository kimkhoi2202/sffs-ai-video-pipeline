/**
 * render-mascot.ts — renders the 2 FULL mascot shorts: standard cold-open 9:16
 * shorts (3Q + reveal + score, 5s countdowns, distinct per-video music+SFX) WITH
 * the bottom-right talking-brain NARRATOR lip-synced across the WHOLE video.
 *
 * Reuses the shared pipeline unchanged: it builds the SAME instagram FullVideo
 * timeline as the other A/B shorts (via --props), but renders the additive
 * `MascotShort` wrapper composition (FullVideo + <MascotNarrator/> on top). For
 * the narrator it generates Rhubarb visemes for EACH VO clip from the EXACT
 * muxed audio under public/, and embeds them (+ each clip's `from` frame) in the
 * props as `narratorClips`. Per-clip local time carries the calibrated AAC
 * priming offset inside MascotNarrator (t = (frame-from)/fps - 2048/48000).
 *
 * Fresh questions: rounds 023 & 024 (un-consumed; recorded in ab-test-usage.json).
 * No TTS/API — those rounds' q/r audio is already generated under
 * public/audio/rounds/round-0XX/; meta VO comes from committed audio/narration/.
 *
 * Run from remotion/:  npx tsx scripts/render-mascot.ts [--only video-1] [--skip-existing]
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { getTimeline, FPS, type Platform, type SfxSet, type Variant } from "../src/full/timeline";
import { COLORS } from "../src/theme/brand";
import { findRhubarb, generateCues, type RhubarbCue } from "./lipsync-core";

const REMOTION = resolve(import.meta.dirname, "..");
const VIDEO = resolve(REMOTION, "..");
const TOOLS = join(VIDEO, "tools");
const CONTENT = join(VIDEO, "content");
const ROUNDS = join(CONTENT, "rounds");
const BANK_PATH = join(CONTENT, "master-question-bank.json");
const PUBLIC = join(REMOTION, "public");
const NARR_ABS = join(PUBLIC, "audio", "narration");
const OUT_ROOT = join(VIDEO, "renders.nosync", "videos", "ab-tests");
const FFPROBE = process.env.FFPROBE || "/opt/homebrew/bin/ffprobe";

const TEST = "mascot";
const TEST_DESC =
  "Standard cold-open 3Q + reveal + score (5s countdowns, distinct music+SFX) WITH a bottom-right talking-brain narrator lip-synced to every VO clip across the whole video. Baseline = the existing full shorts (no narrator).";

const Q3 = [1, 11, 7];
type MVideo = { variant: string; round: string; ids: number[]; music: string; sfxSlug: string };
const VIDEOS: MVideo[] = [
  { variant: "video-1", round: "round-023", ids: Q3, music: "gameshow-fanfare.mp3", sfxSlug: "short-1" },
  { variant: "video-2", round: "round-024", ids: Q3, music: "prize-wheel-parade.mp3", sfxSlug: "short-2" },
];

// Meta VO transcripts (for captions only), matching the committed clips.
const META_TEXT: Record<string, string> = {
  timesup: "TIME'S UP!",
  score: "So, are you smart or fart? Count up your correct answers to find your rank!",
  "outro-follow": "So, how did you do? Comment your score below, and follow for more!",
};

const sfxSet = (slug: string): SfxSet => ({ whoosh: `${slug}/whoosh.mp3`, ding: `${slug}/ding.mp3`, sting: `${slug}/sting.mp3` });

// ---- round JSON question -> runtime Question shape (mirrors render-ab.ts) ----
function toQuestions(round: any, durs: Record<string, number>): any[] {
  const C = [COLORS.blue, COLORS.mint, COLORS.coral, COLORS.yellow, COLORS.green];
  return round.questions.map((q: any) => {
    const base = {
      idx: q.id, bg: C[q.id % C.length], tier: q.tier, tierColor: COLORS.mint, accent: COLORS.yellow,
      countdown: q.countdown, ansLetter: q.ansLetter, ansLabel: q.ansLabel, explanation: q.explanation,
      qDur: durs[`q${q.id}`] ?? 0, rDur: durs[`r${q.id}`] ?? 0,
    };
    switch (q.kind) {
      case "text": return { ...base, kind: "text", question: q.question, questionFontSize: q.questionFontSize, options: q.options };
      case "numseries": return { ...base, kind: "numseries", prompt: q.prompt, seq: q.seq, options: q.options };
      case "shaded": return { ...base, kind: "shaded", prompt: q.prompt, leftShape: q.leftShape, rightShape: q.rightShape, options: q.options, ansShape: q.ansShape, ansFilled: q.ansFilled };
      case "polygon": return { ...base, kind: "polygon", prompt: q.prompt, seq: q.seq, options: q.options, ansShape: q.ansShape };
      case "dot": return { ...base, kind: "dot", prompt: q.prompt, seq: q.seq, options: q.options, ansPos: q.ansPos };
      default: throw new Error(`unknown kind ${q.kind}`);
    }
  });
}

// ---- ffprobe helpers -------------------------------------------------------
function ffprobe(file: string, args: string[]): string {
  return execFileSync(FFPROBE, ["-v", "error", ...args, file], { encoding: "utf8" }).trim();
}
const durOf = (file: string) => Number(ffprobe(file, ["-show_entries", "format=duration", "-of", "default=nk=1:nw=1"]));

// ---- captions (phrase-chunked per VO beat window; mirrors render-ab.ts) -----
const clipKey = (src: string) => basename(src).replace(/\.mp3$/, "");
function chunkWords(words: string[]): string[][] {
  const groups: string[][] = [];
  let g: string[] = [];
  for (const w of words) {
    g.push(w);
    const chars = g.reduce((a, x) => a + x.length + 1, -1);
    if (g.length >= 6 || chars >= 30 || /[.,?!;:]$/.test(w)) { groups.push(g); g = []; }
  }
  if (g.length) groups.push(g);
  if (groups.length >= 2 && groups[groups.length - 1].length === 1) { const last = groups.pop()!; groups[groups.length - 1].push(...last); }
  return groups;
}
function beatCaptions(text: string, fromFrame: number, durS: number): { s: number; e: number; text: string }[] {
  const clean = text.replace(/\[[^\]]+\]/g, " ").replace(/\s+/g, " ").trim();
  const words = clean.split(" ").filter(Boolean);
  if (!words.length) return [];
  const groups = chunkWords(words);
  const totalW = words.length;
  const out: { s: number; e: number; text: string }[] = [];
  let acc = 0;
  for (const gr of groups) {
    const s = fromFrame + Math.round((acc / totalW) * durS * FPS);
    acc += gr.length;
    const e = fromFrame + Math.round((acc / totalW) * durS * FPS);
    out.push({ s, e, text: gr.join(" ") });
  }
  return out;
}
const tsStamp = (sec: number, comma: boolean) => {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
  const ms = Math.round((sec - Math.floor(sec)) * 1000);
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${p2(h)}:${p2(m)}:${p2(s)}${comma ? "," : "."}${String(ms).padStart(3, "0")}`;
};

function parseArgs() {
  const a = process.argv.slice(2);
  let only: string | undefined;
  let skipExisting = false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === "--only") only = a[++i];
    else if (a[i].startsWith("--only=")) only = a[i].slice(7);
    else if (a[i] === "--skip-existing") skipExisting = true;
  }
  return { only, skipExisting };
}

async function main() {
  const { only, skipExisting } = parseArgs();
  const nar = await import(pathToFileURL(join(CONTENT, "gen-narration-scripts.mjs")).href);
  const roundScripts = (nar as { roundScripts: (r: any) => Record<string, string> }).roundScripts;

  const bank = JSON.parse(readFileSync(BANK_PATH, "utf8"));
  const bankSigs = new Set<string>(bank.entries.map((e: any) => e.sig));
  const rhubarb = findRhubarb(TOOLS);
  console.log(`[mascot] rhubarb = ${rhubarb}`);

  // meta durs measured from the ACTUAL played copies (never the stale voice/ index).
  const metaDur = (b: string) => durOf(join(NARR_ABS, `${b}.mp3`));
  const META = { timesup: metaDur("timesup"), score: metaDur("score"), "outro-follow": metaDur("outro-follow") };

  // Rhubarb cache keyed by absolute mp3 path (meta clips are shared across videos).
  const cueCache = new Map<string, RhubarbCue[]>();
  const cuesFor = (relSrc: string): RhubarbCue[] => {
    const abs = join(PUBLIC, relSrc);
    if (!cueCache.has(abs)) {
      if (!existsSync(abs)) throw new Error(`missing audio for cues: ${abs}`);
      const { mouthCues } = generateCues(rhubarb, abs);
      cueCache.set(abs, mouthCues);
    }
    return cueCache.get(abs)!;
  };

  const videos = only ? VIDEOS.filter((v) => v.variant === only) : VIDEOS;
  const usage: any[] = [];
  const manifestVideos: any[] = [];

  for (const v of videos) {
    const slug = `${TEST}-${v.variant}`;
    const round = JSON.parse(readFileSync(join(ROUNDS, `${v.round}.json`), "utf8"));
    const scripts = roundScripts(round);
    const byId = new Map<number, any>(round.questions.map((q: any) => [q.id, q]));

    // freshness + dedup: every picked question must be a tracked master-bank entry.
    for (const id of v.ids) {
      const e = bank.entries.find((x: any) => x.slug === v.round && x.id === id);
      if (!e) throw new Error(`${slug}: ${v.round} Q${id} not in master bank`);
      if (!bankSigs.has(e.sig)) throw new Error(`${slug}: ${v.round} Q${id} sig missing from bank`);
    }

    // durs: q/r measured for this round; meta from the committed clips.
    const roundDurs = JSON.parse(readFileSync(join(PUBLIC, "audio", "rounds", v.round, "durations.json"), "utf8"));
    const durs: Record<string, number> = { ...META };
    for (const id of v.ids) { durs[`q${id}`] = roundDurs[`q${id}`]; durs[`r${id}`] = roundDurs[`r${id}`]; }

    const qrBase = `audio/rounds/${v.round}/`;
    const metaBase = "audio/narration/";
    const variant: Variant = { readVO: "full", dropReveal: false, dropScore: false, endCard: "default", metaBase };
    const questions = toQuestions(round, durs);
    const T = getTimeline("instagram" as Platform, v.ids, sfxSet(v.sfxSlug), questions, durs, qrBase, variant);
    const expectSec = T.total / FPS;

    // narrator clips: one per narration EVENT, with its from-frame + visemes.
    console.log(`[mascot] ${slug}: generating visemes for ${new Set(T.narration.map((n) => n.src)).size} unique VO clip(s)…`);
    const narratorClips = T.narration.map((n) => {
      const key = clipKey(n.src);
      const durF = Math.max(1, Math.round((durs[key] ?? 3) * FPS));
      return { from: n.from, durF, cues: cuesFor(n.src) };
    });

    const outDir = join(OUT_ROOT, TEST, v.variant);
    mkdirSync(outDir, { recursive: true });
    const outMp4 = join(outDir, `${slug}.mp4`);

    const props = {
      // slug MUST be "" (falsy): a truthy slug makes FullVideo resolve bySlug()
      // and override our explicit ids/platform/music/sfx (the merged defaultProps
      // "short-1" would otherwise leak in and mismatch our durs -> NaN).
      slug: "", platform: "instagram", questionIds: v.ids, questions, durs, qrBase,
      music: v.music, sfx: sfxSet(v.sfxSlug),
      readVO: "full", dropReveal: false, dropScore: false, endCard: "default", metaBase,
      totalFrames: T.total, narratorClips,
    };
    const propsFile = join(tmpdir(), `${slug}-props.json`);
    writeFileSync(propsFile, JSON.stringify(props));

    if (!(skipExisting && existsSync(outMp4))) {
      console.log(`[render] ${slug} -> ${TEST}/${v.variant}  (~${expectSec.toFixed(1)}s)`);
      const r = spawnSync("npx", ["remotion", "render", "MascotShort", outMp4, `--props=${propsFile}`, "--log=error"], { cwd: REMOTION, stdio: "inherit" });
      if (r.status !== 0) throw new Error(`render failed: ${slug} (exit ${r.status})`);
    }

    // ---- verify: aspect, duration, A/V drift ----
    const [w, h] = ffprobe(outMp4, ["-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0"]).split(",").map(Number);
    const container = durOf(outMp4);
    const aDur = Number(ffprobe(outMp4, ["-select_streams", "a:0", "-show_entries", "stream=duration", "-of", "default=nk=1:nw=1"]) || "0");
    const problems: string[] = [];
    if (w !== 1080 || h !== 1920) problems.push(`aspect ${w}x${h} != 1080x1920`);
    if (Math.abs(container - expectSec) > 0.35) problems.push(`duration ${container.toFixed(2)}s vs expected ${expectSec.toFixed(2)}s`);
    if (aDur > 0 && Math.abs(aDur - container) > 0.3) problems.push(`A/V drift ${(aDur - container).toFixed(2)}s`);
    if (problems.length) throw new Error(`ffprobe verify FAILED ${slug}: ${problems.join("; ")}`);
    console.log(`  [ok] ${slug}  ${w}x${h}  ${container.toFixed(2)}s (audio ${aDur.toFixed(2)}s, drift ${(aDur - container).toFixed(2)}s)`);

    // ---- captions from the actual VO events ----
    const textForKey = (k: string): string => (/^q\d+$/.test(k) || /^r\d+$/.test(k) ? scripts[k] ?? "" : META_TEXT[k] ?? "");
    const cues: { s: number; e: number; text: string }[] = [];
    for (const n of T.narration) {
      const key = clipKey(n.src);
      const text = textForKey(key);
      if (!text) continue;
      for (const c of beatCaptions(text, n.from, durs[key] ?? 3)) cues.push({ s: c.s / FPS, e: c.e / FPS, text: c.text });
    }
    cues.sort((a, b) => a.s - b.s);
    writeFileSync(join(outDir, "captions.srt"), cues.map((c, i) => `${i + 1}\n${tsStamp(c.s, true)} --> ${tsStamp(c.e, true)}\n${c.text}\n`).join("\n"));
    writeFileSync(join(outDir, "captions.vtt"), "WEBVTT\n\n" + cues.map((c) => `${tsStamp(c.s, false)} --> ${tsStamp(c.e, false)}\n${c.text}\n`).join("\n"));

    // ---- questions.json + info.md ----
    const promptOf = (q: any) => (q.kind === "text" ? q.question : q.prompt).replace(/\n/g, " / ");
    const qMeta = v.ids.map((id, i) => {
      const q = byId.get(id);
      return { pos: i + 1, id, kind: q.kind, category: q.category, difficulty: q.difficulty, tier: q.tier, prompt: promptOf(q), answer: { letter: q.ansLetter, label: q.ansLabel } };
    });
    writeFileSync(join(outDir, "questions.json"), JSON.stringify({
      test: TEST, variant: v.variant, round: v.round, format: "9:16", questionCount: v.ids.length, countdownSec: 5,
      treatment: { narrator: "bottom-right lip-synced talking brain", readVO: "full", dropReveal: false, dropScore: false, endCard: "default", coldOpen: true },
      music: v.music, sfx: v.sfxSlug, questions: qMeta,
    }, null, 2) + "\n");
    const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
    const rows = qMeta.map((q) => `| ${q.pos} | Q${q.id} | ${q.category} | ${q.difficulty} | ${q.tier} | ${q.answer.letter} · ${q.answer.label} |`).join("\n");
    writeFileSync(join(outDir, "info.md"), `# A/B — ${TEST} — ${v.variant}

- **Test:** ${TEST} — ${TEST_DESC}
- **Source round:** ${v.round} (fresh / un-rendered)
- **Aspect:** 9:16 (1080x1920), cold open, 5s countdown/question
- **Narrator:** bottom-right talking brain-mascot (vector), lip-synced to every VO clip (question-read → time's-up → reveal → score → outro), idling at rest during VO-silent gaps. Rhubarb visemes from the EXACT muxed audio; per-clip local time with the calibrated AAC-priming offset (2048/48000 s).
- **Treatment:** standard cold-open 3Q + reveal + score (baseline + narrator overlay)
- **Duration:** ~${mmss(expectSec)} (${Math.round(expectSec)}s)
- **Music:** ${v.music} · **SFX set:** ${v.sfxSlug}
- **File:** \`${basename(outMp4)}\`

## Questions (play order)

| # | Source | Category | Difficulty | Type | Answer |
|---|--------|----------|------------|------|--------|
${rows}

## Files
- \`${basename(outMp4)}\` — the video (h264/yuv420p + AAC), ffprobe-verified 1080x1920, ${container.toFixed(2)}s, A/V drift ${(aDur - container).toFixed(2)}s.
- \`captions.srt\` / \`captions.vtt\` — spoken transcript (phrase-chunked).
- \`questions.json\` — this video's questions + treatment.
`);

    usage.push({
      videoSlug: slug, test: TEST, variant: v.variant, round: v.round,
      questions: v.ids.map((id) => {
        const e = bank.entries.find((x: any) => x.slug === v.round && x.id === id);
        return { id, sig: e.sig, tier: e.tier, answerNorm: e.answerNorm };
      }),
    });
    manifestVideos.push({
      variant: v.variant, path: join("ab-tests", TEST, v.variant, basename(outMp4)), round: v.round, questionIds: v.ids,
      questions: qMeta.map((q) => ({ pos: q.pos, id: q.id, tier: q.tier, answer: `${q.answer.letter} · ${q.answer.label}` })),
      durationSec: Math.round(container * 100) / 100, frames: T.total,
      treatment: { narrator: "bottom-right lip-synced talking brain", coldOpen: true }, music: v.music, sfx: v.sfxSlug,
      captions: { srt: "captions.srt", vtt: "captions.vtt" },
    });
  }

  // ---- merge into ab-tests/manifest.json (replace/insert the mascot test) ----
  const manifestPath = join(OUT_ROOT, "manifest.json");
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : { tests: [] };
  manifest.tests = (manifest.tests || []).filter((t: any) => t.test !== TEST);
  manifest.tests.push({ test: TEST, description: TEST_DESC, videos: manifestVideos });
  manifest.updated = new Date().toISOString().slice(0, 10);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

  // ---- record consumed questions in ab-test-usage.json ----
  const usagePath = join(CONTENT, "ab-test-usage.json");
  const prev = existsSync(usagePath) ? JSON.parse(readFileSync(usagePath, "utf8")) : { note: "Questions consumed by A/B-test renders.", videos: [] };
  const byVideo = new Map<string, any>((prev.videos || []).map((u: any) => [u.videoSlug, u]));
  for (const u of usage) byVideo.set(u.videoSlug, u);
  writeFileSync(usagePath, JSON.stringify({ ...prev, updated: new Date().toISOString().slice(0, 10), videos: [...byVideo.values()] }, null, 2) + "\n");

  console.log(`\n[done] ${videos.length} mascot short(s) -> ${join(OUT_ROOT, TEST)}`);
  console.log(`[done] manifest -> ab-tests/manifest.json ; usage -> content/ab-test-usage.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
