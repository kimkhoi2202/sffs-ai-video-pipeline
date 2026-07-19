/**
 * render-round.ts — the repeatable multi-platform BATCH RENDER for one (or more)
 * generated content rounds. For each round it:
 *   1. generates the game-show narration scripts (content/gen-narration-scripts.mjs)
 *      and synthesizes the per-round q/r beats with the cloned voice
 *      (voice/tts_batch.py) into public/audio/rounds/<round>/ (gitignored);
 *   2. builds each cut's timeline from THIS round's questions + measured durations
 *      via the shared, parameterized composition (no source mutation) — full-15 +
 *      cut-10 (16:9) + 5 shorts + 5 sub-60 (9:16), plus the byte-identical TikTok
 *      mirror of each Instagram short;
 *   3. renders each via `remotion render` (5s countdowns, VO-keyed duck/swell, and
 *      the distinct per-short music + SFX all come straight from cuts.ts + timeline);
 *   4. ffprobe-verifies every output (aspect, duration vs the timeline, A/V drift);
 *   5. writes each per-video folder (mp4 + captions.srt/.vtt + questions.json +
 *      info.md) under renders/videos/<round>/… and updates the manifest.
 *
 * Meta beats (intro/timesup/score/outro-*) are round-agnostic and reused from the
 * committed public/audio/narration/. Run from the remotion/ dir:
 *   npx tsx scripts/render-round.ts round-001 [round-002 …] \
 *       [--cuts full-15,short-1,short-1-60] [--voice-id <id>] [--skip-narration]
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync, rmSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { pathToFileURL } from "node:url";
import { getTimeline, FPS, type Platform, type SfxSet, type TimelineData } from "../src/full/timeline";
import { ALL_CUTS, SHORTS, type Cut } from "../src/data/cuts";
import { COLORS } from "../src/theme/brand";

const REMOTION = resolve(import.meta.dirname, "..");
const VIDEO = resolve(REMOTION, "..");
const CONTENT = join(VIDEO, "content");
const ROUNDS = join(CONTENT, "rounds");
const PUB_ROUNDS = join(REMOTION, "public", "audio", "rounds");
// renders.nosync: the ".nosync" suffix makes iCloud skip this whole tree, so the
// thousands of heavy mp4s never get synced (which was throttling all file I/O).
const OUT_ROOT = join(VIDEO, "renders.nosync", "videos");
const DURS_META = JSON.parse(readFileSync(join(REMOTION, "src", "data", "durations.json"), "utf8"));
const FFPROBE = process.env.FFPROBE || "/opt/homebrew/bin/ffprobe";
const DEFAULT_VOICE = "lZcmpVLaoXF4v0uz4l6Q"; // cloned "Booming Ringmaster"

// Round-agnostic meta beats reused from the committed narration + duration map.
const META_KEYS = ["intro", "timesup", "score", "outro", "outro-youtube", "outro-follow"];
const META_TEXT: Record<string, string> = {
  intro: "Are you a SMART fella, or a FART smella? Let's find OUT!",
  timesup: "TIME'S UP!",
  score: "So, are you smart or fart? Count up your correct answers to find your rank!",
  "outro-youtube": "So, how did you do? Comment your score below, and subscribe for more!",
  "outro-follow": "So, how did you do? Comment your score below, and follow for more!",
  outro: "So, how did you do? Comment your score below, and follow or subscribe for more!",
};

type Args = { rounds: string[]; cuts?: Set<string>; voiceId: string; skipNarration: boolean; skipExistingRender: boolean };
function parseArgs(): Args {
  const a = process.argv.slice(2);
  const rounds: string[] = [];
  let cuts: Set<string> | undefined;
  let voiceId = DEFAULT_VOICE;
  let skipNarration = false;
  let skipExistingRender = false;
  for (let i = 0; i < a.length; i++) {
    const t = a[i];
    if (t === "--cuts") cuts = new Set(a[++i].split(","));
    else if (t.startsWith("--cuts=")) cuts = new Set(t.slice(7).split(","));
    else if (t === "--voice-id") voiceId = a[++i];
    else if (t.startsWith("--voice-id=")) voiceId = t.slice(11);
    else if (t === "--skip-narration") skipNarration = true;
    else if (t === "--skip-existing-render") skipExistingRender = true;
    else if (!t.startsWith("--")) rounds.push(t.replace(/\.json$/, ""));
  }
  return { rounds, cuts, voiceId, skipNarration, skipExistingRender };
}

// ---- round JSON -> runtime Question[] (fills legacy/unused fields to satisfy
//      the composition data shape; colors are overridden by slotColors at render).
function toQuestions(round: any, durs: Record<string, number>): any[] {
  const C = [COLORS.blue, COLORS.mint, COLORS.coral, COLORS.yellow, COLORS.green];
  return round.questions.map((q: any) => {
    const base = {
      idx: q.id,
      bg: C[q.id % C.length],
      tier: q.tier,
      tierColor: COLORS.mint,
      accent: COLORS.yellow,
      countdown: q.countdown,
      ansLetter: q.ansLetter,
      ansLabel: q.ansLabel,
      explanation: q.explanation,
      qDur: durs[`q${q.id}`] ?? 0,
      rDur: durs[`r${q.id}`] ?? 0,
    };
    switch (q.kind) {
      case "text":
        return { ...base, kind: "text", question: q.question, questionFontSize: q.questionFontSize, options: q.options };
      case "numseries":
        return { ...base, kind: "numseries", prompt: q.prompt, seq: q.seq, options: q.options };
      case "shaded":
        return { ...base, kind: "shaded", prompt: q.prompt, leftShape: q.leftShape, rightShape: q.rightShape, options: q.options, ansShape: q.ansShape, ansFilled: q.ansFilled };
      case "polygon":
        return { ...base, kind: "polygon", prompt: q.prompt, seq: q.seq, options: q.options, ansShape: q.ansShape };
      case "dot":
        return { ...base, kind: "dot", prompt: q.prompt, seq: q.seq, options: q.options, ansPos: q.ansPos };
      default:
        throw new Error(`unknown kind ${q.kind}`);
    }
  });
}

// ---- captions: chunk each beat's spoken text into phrases across its VO window --
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
function beatTextFor(key: string, scripts: Record<string, string>): string {
  if (/^[qr]\d+$/.test(key)) return scripts[key] ?? "";
  return META_TEXT[key] ?? "";
}

const tsStamp = (sec: number, comma: boolean) => {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
  const ms = Math.round((sec - Math.floor(sec)) * 1000);
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${p2(h)}:${p2(m)}:${p2(s)}${comma ? "," : "."}${String(ms).padStart(3, "0")}`;
};

function ffprobe(file: string, args: string[]): string {
  // retry: ffprobe can fail transiently under heavy load (many parallel renders)
  let lastErr: unknown;
  for (let a = 0; a < 3; a++) {
    try {
      return execFileSync(FFPROBE, ["-v", "error", ...args, file], { encoding: "utf8" }).trim();
    } catch (e) {
      lastErr = e;
      spawnSync("sleep", ["2"]);
    }
  }
  throw lastErr;
}

async function main() {
  const { rounds: roundArgs, cuts: cutFilter, voiceId, skipNarration, skipExistingRender } = parseArgs();
  const roundFiles = roundArgs.length
    ? roundArgs
    : (await import("node:fs")).readdirSync(ROUNDS).filter((f) => /^round-\d{3}\.json$/.test(f)).map((f) => f.replace(/\.json$/, "")).sort();
  const { roundScripts } = await import(pathToFileURL(join(CONTENT, "gen-narration-scripts.mjs")).href);

  const manifestRounds: any[] = [];
  for (const slug of roundFiles) {
    const roundPath = join(ROUNDS, `${slug}.json`);
    const round = JSON.parse(readFileSync(roundPath, "utf8"));
    console.log(`\n======== ${slug}: ${round.title} ========`);

    // 1) narration ----------------------------------------------------------
    const audioDir = join(PUB_ROUNDS, slug);
    const scripts: Record<string, string> = roundScripts(round);
    if (!skipNarration) {
      mkdirSync(audioDir, { recursive: true });
      const beats = Object.keys(scripts).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).map((k) => ({ beat: k, text: scripts[k] }));
      const beatsFile = join(audioDir, "_beats.json");
      writeFileSync(beatsFile, JSON.stringify(beats, null, 2));
      console.log(`[narrate] ${beats.length} beats -> TTS (${voiceId})`);
      const r = spawnSync("python3", [join(VIDEO, "voice", "tts_batch.py"), "--beats", beatsFile, "--voice-id", voiceId, "--out-dir", audioDir, "--skip-existing"], { stdio: "inherit" });
      if (r.status !== 0) throw new Error(`tts_batch failed for ${slug}`);
    }
    const qrDurs = JSON.parse(readFileSync(join(audioDir, "durations.json"), "utf8"));
    const durs: Record<string, number> = {};
    for (const k of META_KEYS) durs[k] = DURS_META[k];
    Object.assign(durs, qrDurs);

    const questions = toQuestions(round, durs);
    const qrBase = `audio/rounds/${slug}/`;

    // 2-5) per-cut render + verify + metadata --------------------------------
    const cutsToRun = ALL_CUTS.filter((c) => !cutFilter || cutFilter.has(c.slug));
    const cutEntries: any[] = [];
    for (const cut of cutsToRun) {
      const comp = cut.format === "16:9" ? "FullVideo" : "Short";
      const T: TimelineData = getTimeline(cut.platform as Platform, cut.ids, cut.sfx as SfxSet | undefined, questions as any, durs, qrBase);
      const expectSec = T.total / FPS;
      const outDir = join(OUT_ROOT, slug, cut.dir);
      mkdirSync(outDir, { recursive: true });
      const outMp4 = join(outDir, cut.file);
      const props = { slug: cut.slug, questions, durs, qrBase };
      const propsFile = join(audioDir, `_props-${cut.slug}.json`);
      writeFileSync(propsFile, JSON.stringify(props));

      // A cut already rendered on a prior pass is trusted WHOLE: skip its render,
      // its ffprobe re-verify, its metadata rewrite AND its tiktok re-mirror.
      // Re-touching every done cut on each resume is slow + fragile (transient
      // ffprobe / fs ETIMEDOUT under heavy I/O, especially on a synced ~/Documents)
      // and would keep aborting the long run before it ever reaches new work.
      const skipped = skipExistingRender && existsSync(outMp4);
      if (skipped) {
        console.log(`[render] ${slug}/${cut.slug} skip (exists)`);
      } else {
        console.log(`[render] ${slug}/${cut.slug} (${comp} ${cut.format}) ~${expectSec.toFixed(1)}s -> ${cut.dir}/${cut.file}`);
        const rr = spawnSync("npx", ["remotion", "render", comp, outMp4, `--props=${propsFile}`], { cwd: REMOTION, stdio: "inherit" });
        if (rr.status !== 0) throw new Error(`render failed: ${slug}/${cut.slug}`);

        // ffprobe verify FRESH renders only: aspect + duration + A/V drift
        const [w, h] = ffprobe(outMp4, ["-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0"]).split(",").map(Number);
        const container = Number(ffprobe(outMp4, ["-show_entries", "format=duration", "-of", "default=nk=1:nw=1"]));
        const aDur = Number(ffprobe(outMp4, ["-select_streams", "a:0", "-show_entries", "stream=duration", "-of", "default=nk=1:nw=1"]) || "0");
        const wantW = cut.format === "16:9" ? 1920 : 1080;
        const wantH = cut.format === "16:9" ? 1080 : 1920;
        const problems: string[] = [];
        if (w !== wantW || h !== wantH) problems.push(`aspect ${w}x${h} != ${wantW}x${wantH}`);
        if (Math.abs(container - expectSec) > 0.35) problems.push(`duration ${container.toFixed(2)}s vs expected ${expectSec.toFixed(2)}s`);
        if (aDur > 0 && Math.abs(aDur - container) > 0.3) problems.push(`A/V drift ${(aDur - container).toFixed(2)}s`);
        if (problems.length) throw new Error(`ffprobe verify FAILED ${slug}/${cut.slug}: ${problems.join("; ")}`);
        console.log(`  [ok] ${w}x${h} ${container.toFixed(2)}s (audio ${aDur.toFixed(2)}s)`);
      }

      // metadata sidecars (fresh renders only; a skipped cut keeps its prior files)
      if (!skipped) writeMetadata(outDir, round, cut, T, expectSec, scripts, durs);
      const platform = cut.dir.startsWith("youtube/") ? "youtube" : cut.dir.startsWith("shorts-60/") ? "instagram+tiktok" : "instagram";
      cutEntries.push({ slug: cut.slug, dir: join(slug, cut.dir), file: cut.file, platform, format: cut.format, questionIds: cut.ids, countdownSec: 5, durationSec: Math.round(expectSec) });

      // TikTok byte-identical mirror of each Instagram short
      if (cut.dir.startsWith("instagram/")) {
        const tkDir = join(OUT_ROOT, slug, cut.dir.replace("instagram/", "tiktok/"));
        // re-mirror only for fresh renders, or if the mirror is somehow missing
        if (!skipped || !existsSync(join(tkDir, cut.file))) {
          rmSync(tkDir, { recursive: true, force: true });
          cpSync(outDir, tkDir, { recursive: true });
        }
        cutEntries.push({ slug: cut.slug, dir: join(slug, cut.dir.replace("instagram/", "tiktok/")), file: cut.file, platform: "tiktok", format: cut.format, questionIds: cut.ids, countdownSec: 5, durationSec: Math.round(expectSec), note: "byte-identical mirror of the instagram short" });
      }
    }

    // merge with any existing round manifest so incremental (bounded) runs keep prior cuts
    const rmPath = join(OUT_ROOT, slug, "manifest.json");
    const prevCuts: any[] = existsSync(rmPath) ? JSON.parse(readFileSync(rmPath, "utf8")).cuts ?? [] : [];
    const mergedCuts = new Map<string, any>(prevCuts.map((c) => [c.dir, c]));
    for (const e of cutEntries) mergedCuts.set(e.dir, e);
    const roundManifest = { round: round.round, slug, title: round.title, generated: new Date().toISOString().slice(0, 10), cuts: [...mergedCuts.values()].sort((a, b) => a.dir.localeCompare(b.dir)) };
    writeFileSync(rmPath, JSON.stringify(roundManifest, null, 2) + "\n");
    manifestRounds.push({ round: round.round, slug, dir: slug, cutCount: cutEntries.length, manifest: `${slug}/manifest.json` });
    console.log(`[round] ${slug}: ${cutEntries.length} cut(s) -> renders.nosync/videos/${slug}/`);
  }

  // update top-level manifest additively (preserve any legacy `cuts`)
  const topPath = join(OUT_ROOT, "manifest.json");
  const top = existsSync(topPath) ? JSON.parse(readFileSync(topPath, "utf8")) : {};
  const byId = new Map<string, any>((top.rounds || []).map((r: any) => [r.slug, r]));
  for (const r of manifestRounds) byId.set(r.slug, r);
  top.generated = new Date().toISOString().slice(0, 10);
  top.rounds = [...byId.values()].sort((a, b) => a.slug.localeCompare(b.slug));
  writeFileSync(topPath, JSON.stringify(top, null, 2) + "\n");
  console.log(`\n[done] ${manifestRounds.length} round(s); top-level manifest lists ${top.rounds.length} round(s)`);
}

function writeMetadata(outDir: string, round: any, cut: Cut, T: TimelineData, expectSec: number, scripts: Record<string, string>, durs: Record<string, number>) {
  const byId = new Map<number, any>(round.questions.map((q: any) => [q.id, q]));
  const promptOf = (q: any) => (q.kind === "text" ? q.question : q.prompt).replace(/\n/g, " / ");
  const questions = cut.ids.map((id, i) => {
    const q = byId.get(id);
    return { pos: i + 1, id, kind: q.kind, category: q.category, difficulty: q.difficulty, tier: q.tier, prompt: promptOf(q), answer: { letter: q.ansLetter, label: q.ansLabel } };
  });
  const platformLine = cut.dir.startsWith("youtube/") ? cut.platform : cut.dir.startsWith("shorts-60/") ? "Instagram + TikTok (single 9:16 cut)" : "Instagram + TikTok (identical 9:16 cut)";
  writeFileSync(join(outDir, "questions.json"), JSON.stringify({ round: round.round, slug: cut.slug, title: `${round.title} — ${cut.title}`, platform: cut.platform, format: cut.format, questionCount: cut.ids.length, countdownSec: 5, questions }, null, 2) + "\n");

  const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  const rows = questions.map((q) => `| ${q.pos} | Q${q.id} | ${q.category} | ${q.difficulty} | ${q.tier} | ${q.answer.letter} · ${q.answer.label} |`).join("\n");
  const info = `# ${round.title} — ${cut.title}

- **Round:** ${round.slug} (Grade ${round.grade} / CogAT Level ${round.cogatLevel})
- **Platform:** ${platformLine}
- **Aspect:** ${cut.format} (${cut.format === "16:9" ? "1920x1080" : "1080x1920"})
- **Questions:** ${cut.ids.length}
- **Duration:** ~${mmss(expectSec)} (${Math.round(expectSec)}s)
- **Countdown:** 5s per question
- **Music:** ${cut.music ?? "fanfare -> parade -> winner arc (shared)"}
- **File:** \`${cut.file}\`

## Questions (play order)

| # | Source | Category | Difficulty | Type | Answer |
|---|--------|----------|------------|------|--------|
${rows}

## Files
- \`${cut.file}\` — the video (h264/yuv420p + AAC).
- \`captions.srt\` / \`captions.vtt\` — spoken transcript (phrase-chunked).
- \`questions.json\` — this cut's question bank.
`;
  writeFileSync(join(outDir, "info.md"), info);

  // captions from the round's spoken beats + this cut's timeline windows
  const cues: { s: number; e: number; text: string }[] = [];
  for (const n of T.narration) {
    const key = clipKey(n.src);
    const text = beatTextFor(key, scripts);
    if (!text) continue;
    const beatDur = durs[key] ?? 3;
    for (const c of beatCaptions(text, n.from, beatDur)) cues.push({ s: c.s / FPS, e: c.e / FPS, text: c.text });
  }
  cues.sort((a, b) => a.s - b.s);
  const srt = cues.map((c, i) => `${i + 1}\n${tsStamp(c.s, true)} --> ${tsStamp(c.e, true)}\n${c.text}\n`).join("\n");
  const vtt = "WEBVTT\n\n" + cues.map((c) => `${tsStamp(c.s, false)} --> ${tsStamp(c.e, false)}\n${c.text}\n`).join("\n");
  writeFileSync(join(outDir, "captions.srt"), srt);
  writeFileSync(join(outDir, "captions.vtt"), vtt);
}

main().catch((e) => { console.error(e); process.exit(1); });
