/**
 * render-reslot.ts — ONE-OFF driver for the 2026-07-21 "reschedule with the layout
 * fixes + FRESH distinct questions" job. Re-renders the 6 still-scheduled A/B slots
 * (the 18:30 no-answer slot already auto-published, so it is intentionally excluded)
 * in BOTH platform formats (tiktok + instagram), each slot with its OWN fresh,
 * previously-unused, category-varied question set pulled from an unused master-bank
 * round. The IG + TikTok render of a slot SHARE that slot's questions (only the
 * platform layout differs), so a viewer scrolling one feed sees all-different videos.
 *
 * It reuses the committed pipeline building blocks unchanged:
 *   - src/full/timeline.ts getTimeline() for the exact prop-driven timeline/length,
 *   - the `Short` (FullVideo) + `MascotShort` compositions via `remotion render`,
 *   - voice/tts_batch.py (ElevenLabs cloned voice) ONLY for the split stem/options
 *     VO clips that have no pre-generated copy (the no-question-vo / no-options-vo
 *     don't-narrate arms); every other beat REUSES the committed per-round narration
 *     under public/audio/rounds/round-0XX/ (that VO already matches those questions),
 *   - scripts/lipsync-core.ts for the mascot narrator visemes.
 *
 * The VARIANT TREATMENT per slot (readVO / dropReveal / dropScore / endCard / speed /
 * music / sfx / narrator) is copied verbatim from scripts/render-ab.ts + render-mascot.ts
 * (video-1 of each family) so ONLY the questions + platform layout change.
 *
 * Run from remotion/:
 *   npx tsx scripts/render-reslot.ts                       (all slots, both platforms)
 *   node scripts/render-reslot.ts --only s7-mascot --platform tiktok --concurrency 2
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { getTimeline, FPS, type Platform, type SfxSet, type Variant, type ReadVO, type EndCard, type DropReveal, type TimelineData } from "../src/full/timeline";
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
const AB_AUDIO_ABS = join(PUBLIC, "audio", "rounds", "ab");
const OUT_ROOT = join(VIDEO, "renders.nosync", "videos", "ab-reslot-20260721");
const USAGE_PATH = join(CONTENT, "ab-test-usage.json");
const FFPROBE = process.env.FFPROBE || "/opt/homebrew/bin/ffprobe";
const FFMPEG = process.env.FFMPEG || "/opt/homebrew/bin/ffmpeg";

// speed: 1.12x baseline -> ~1.25x (mirrors render-ab.ts).
const SPEED_ATEMPO = 1.25 / 1.12; // ~1.1161
const SPEED_TARGET_RATIO = 1.12 / 1.25; // ~0.896
const SPEED_MUST_SHRINK = 0.96;

const PLATFORMS: Platform[] = ["tiktok", "instagram"];

const META_TEXT: Record<string, string> = {
  timesup: "TIME'S UP!",
  score: "So, are you smart or fart? Count up your correct answers to find your rank!",
  "outro-follow": "So, how did you do? Comment your score below, and follow for more!",
  "outro-noanswer": "What's your answer? Comment below and I'll let you know if you're a Certified Smart Fella!",
  verdict: "So... are you a smart fella, or a fart smella?",
};

type Slot = {
  key: string;
  variantKey: string;
  family: string;
  comp: "Short" | "MascotShort";
  round: string;
  ids: number[];
  readVO: ReadVO;
  dropReveal: DropReveal;
  dropScore: boolean;
  endCard: EndCard;
  speed?: boolean;
  music: string;
  sfxSlug: string;
};

// The 6 still-scheduled slots (18:30 no-answer already published -> excluded).
// Fresh distinct round per slot + a category-varied id triple (1 verbal + 1 nonverbal
// + 1 quantitative for the 3Q videos), sized to the variant's real question count.
const SLOTS: Slot[] = [
  { key: "s2-no-narration",  variantKey: "no-narration",  family: "dont-narrate", comp: "Short",       round: "round-026", ids: [4, 3, 7],   readVO: "none",    dropReveal: false, dropScore: false, endCard: "default", music: "parade.mp3",              sfxSlug: "short-2" },
  { key: "s3-no-question-vo",variantKey: "no-question-vo",family: "dont-narrate", comp: "Short",       round: "round-027", ids: [1, 11, 14], readVO: "options", dropReveal: false, dropScore: false, endCard: "default", music: "winner-spin.mp3",         sfxSlug: "short-3" },
  { key: "s4-no-options-vo", variantKey: "no-options-vo", family: "dont-narrate", comp: "Short",       round: "round-028", ids: [3, 12, 15], readVO: "stem",    dropReveal: false, dropScore: false, endCard: "default", music: "final-round-fanfare.mp3", sfxSlug: "short-5" },
  { key: "s5-speed",         variantKey: "speed",         family: "speed",        comp: "Short",       round: "round-029", ids: [10, 13, 7], readVO: "full",    dropReveal: false, dropScore: false, endCard: "default", speed: true, music: "gameshow-fanfare.mp3", sfxSlug: "short-4" },
  { key: "s6-one-question",  variantKey: "one-question",  family: "one-question", comp: "Short",       round: "round-030", ids: [3],         readVO: "full",    dropReveal: false, dropScore: true,  endCard: "verdict", music: "winner-spin.mp3",         sfxSlug: "short-1" },
  { key: "s7-mascot",        variantKey: "mascot",        family: "mascot",       comp: "MascotShort", round: "round-031", ids: [8, 11, 14], readVO: "full",    dropReveal: false, dropScore: false, endCard: "default", music: "gameshow-fanfare.mp3", sfxSlug: "short-1" },
];

const sfxSet = (slug: string): SfxSet => ({ whoosh: `${slug}/whoosh.mp3`, ding: `${slug}/ding.mp3`, sting: `${slug}/sting.mp3` });

// ---- round JSON question -> runtime Question (verbatim from render-ab.ts) ----
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

function ffprobe(file: string, args: string[]): string {
  let lastErr: unknown;
  for (let a = 0; a < 3; a++) {
    try { return execFileSync(FFPROBE, ["-v", "error", ...args, file], { encoding: "utf8" }).trim(); }
    catch (e) { lastErr = e; spawnSync("sleep", ["2"]); }
  }
  throw lastErr;
}
const durOf = (file: string) => Number(ffprobe(file, ["-show_entries", "format=duration", "-of", "default=nk=1:nw=1"]));
function atempo(inFile: string, outFile: string, factor: number) {
  execFileSync(FFMPEG, ["-y", "-i", inFile, "-filter:a", `atempo=${factor}`, "-c:a", "libmp3lame", "-q:a", "2", outFile], { stdio: ["ignore", "ignore", "inherit"] });
}
const clipKey = (src: string) => basename(src).replace(/\.mp3$/, "");

function ttsBeats(beats: { beat: string; text: string }[], outDir: string, voiceId: string): Record<string, number> {
  mkdirSync(outDir, { recursive: true });
  const bf = join(outDir, "_beats.json");
  writeFileSync(bf, JSON.stringify(beats, null, 2));
  const r = spawnSync("python3", [join(VIDEO, "voice", "tts_batch.py"), "--beats", bf, "--voice-id", voiceId, "--out-dir", outDir, "--skip-existing"], { stdio: "inherit" });
  if (r.status !== 0) throw new Error(`tts_batch failed -> ${outDir}`);
  return JSON.parse(readFileSync(join(outDir, "durations.json"), "utf8"));
}

function parseArgs() {
  const a = process.argv.slice(2);
  let only: string | undefined;
  let platform: Platform | undefined;
  let concurrency = 3;
  let skipExisting = false;
  for (let i = 0; i < a.length; i++) {
    const t = a[i];
    if (t === "--only") only = a[++i];
    else if (t === "--platform") platform = a[++i] as Platform;
    else if (t === "--concurrency") concurrency = Number(a[++i]);
    else if (t === "--skip-existing") skipExisting = true;
  }
  return { only, platform, concurrency: Math.max(1, concurrency), skipExisting };
}

type Prep = {
  slot: Slot;
  round: any;
  qById: Map<number, any>;
  questions: any[];
  durs: Record<string, number>;
  qrBase: string;   // public-relative dir with the read (q/qo/qs) + reveal (r) clips
  metaBase: string; // public-relative dir with timesup/score/outro/verdict
  variant: Variant;
  usage: any;       // ab-test-usage record for this slot
};

async function prep(slot: Slot, voiceId: string, nar: any, bank: any, bankSigs: Set<string>): Promise<Prep> {
  const { qStemBeat, qOptionsBeat } = nar;
  const round = JSON.parse(readFileSync(join(ROUNDS, `${slot.round}.json`), "utf8"));
  const qById = new Map<number, any>(round.questions.map((q: any) => [q.id, q]));

  // freshness + dedup: every picked question must be a tracked master-bank entry.
  const usageQs: any[] = [];
  for (const id of slot.ids) {
    const e = bank.entries.find((x: any) => x.slug === slot.round && x.id === id);
    if (!e) throw new Error(`${slot.key}: ${slot.round} Q${id} not in master bank`);
    if (!bankSigs.has(e.sig)) throw new Error(`${slot.key}: ${slot.round} Q${id} sig missing from bank`);
    usageQs.push({ id, sig: e.sig, tier: e.tier, answerNorm: e.answerNorm });
  }

  const pregenRel = `audio/rounds/${slot.round}/`;
  const pregenAbs = join(PUBLIC, "audio", "rounds", slot.round);
  const pregenDurs: Record<string, number> = JSON.parse(readFileSync(join(pregenAbs, "durations.json"), "utf8"));
  const metaDur = (b: string) => durOf(join(NARR_ABS, `${b}.mp3`));
  const META: Record<string, number> = {
    timesup: metaDur("timesup"), score: metaDur("score"), "outro-follow": metaDur("outro-follow"),
    verdict: metaDur("verdict"), "outro-noanswer": metaDur("outro-noanswer"),
  };

  let qrBase = pregenRel;
  let metaBase = "audio/narration/";
  const durs: Record<string, number> = { ...META };

  if (slot.readVO === "full" && !slot.speed) {
    // reuse pregen q + r for the chosen ids.
    for (const id of slot.ids) { durs[`q${id}`] = pregenDurs[`q${id}`]; durs[`r${id}`] = pregenDurs[`r${id}`]; }
  } else if (slot.readVO === "none") {
    // no question VO at all; only reveal r + meta.
    for (const id of slot.ids) durs[`r${id}`] = pregenDurs[`r${id}`];
  } else if (slot.readVO === "options" || slot.readVO === "stem") {
    // split read VO (qo/qs) has NO pregen copy -> TTS it; reuse pregen r for reveals.
    const dir = join(AB_AUDIO_ABS, slot.key);
    const beats = slot.ids.map((id) => slot.readVO === "options"
      ? { beat: `qo${id}`, text: qOptionsBeat(qById.get(id)) }
      : { beat: `qs${id}`, text: qStemBeat(qById.get(id)) });
    const ttsDurs = ttsBeats(beats, dir, voiceId);
    for (const id of slot.ids) {
      const rk = `r${id}`;
      copyFileSync(join(pregenAbs, `${rk}.mp3`), join(dir, `${rk}.mp3`));
      durs[rk] = pregenDurs[rk];
      const readK = slot.readVO === "options" ? `qo${id}` : `qs${id}`;
      durs[readK] = ttsDurs[readK];
    }
    qrBase = `audio/rounds/ab/${slot.key}/`;
  }

  if (slot.speed) {
    // atempo pregen q/r + committed meta into a per-slot sped dir; assert shrink.
    const dir = join(AB_AUDIO_ABS, `${slot.key}-sped`);
    mkdirSync(dir, { recursive: true });
    const assertShrink = (beat: string, nat: number, sped: number) => {
      const ratio = sped / nat;
      const ok = ratio < SPEED_MUST_SHRINK && Math.abs(ratio - SPEED_TARGET_RATIO) <= 0.05;
      console.log(`  [speed] ${beat.padEnd(8)} ${nat.toFixed(2)}s -> ${sped.toFixed(2)}s (x${ratio.toFixed(3)})${ok ? "" : "  <-- OUT OF RANGE"}`);
      if (!ok) throw new Error(`${slot.key}: atempo assertion failed for ${beat}: ratio ${ratio.toFixed(3)}`);
    };
    for (const id of slot.ids) {
      for (const k of [`q${id}`, `r${id}`]) {
        atempo(join(pregenAbs, `${k}.mp3`), join(dir, `${k}.mp3`), SPEED_ATEMPO);
        const s = durOf(join(dir, `${k}.mp3`));
        assertShrink(k, pregenDurs[k], s);
        durs[k] = s;
      }
    }
    for (const m of ["timesup", "score", "outro-follow"]) {
      atempo(join(NARR_ABS, `${m}.mp3`), join(dir, `${m}.mp3`), SPEED_ATEMPO);
      const s = durOf(join(dir, `${m}.mp3`));
      assertShrink(m, META[m], s);
      durs[m] = s;
    }
    qrBase = `audio/rounds/ab/${slot.key}-sped/`;
    metaBase = qrBase;
  }

  const variant: Variant = { readVO: slot.readVO, dropReveal: slot.dropReveal, dropScore: slot.dropScore, endCard: slot.endCard, metaBase };
  const questions = toQuestions(round, durs);

  const usage = {
    videoSlug: `reslot-${slot.key}`, test: slot.family, variant: `${slot.variantKey} (reslot 2026-07-21, ${slot.round})`,
    round: slot.round, questions: usageQs,
  };

  return { slot, round, qById, questions, durs, qrBase, metaBase, variant, usage };
}

// caption text per clip key (for srt/vtt) — mirrors render-ab.ts
function makeTextForKey(p: Prep, nar: any) {
  const { qStemBeat, qOptionsBeat, roundScripts } = nar;
  const scripts = roundScripts(p.round);
  return (k: string): string => {
    if (/^q\d+$/.test(k)) return scripts[k] ?? "";
    if (/^qo\d+$/.test(k)) return qOptionsBeat(p.qById.get(Number(k.slice(2))));
    if (/^qs\d+$/.test(k)) return qStemBeat(p.qById.get(Number(k.slice(2))));
    if (/^r\d+$/.test(k)) return scripts[k] ?? "";
    return META_TEXT[k] ?? "";
  };
}

type Job = { slot: Slot; platform: Platform; prep: Prep; outMp4: string; propsFile: string; T: TimelineData };

function buildJob(p: Prep, platform: Platform, rhubarb: string, cueCache: Map<string, RhubarbCue[]>): Job {
  const slot = p.slot;
  const T = getTimeline(platform, slot.ids, sfxSet(slot.sfxSlug), p.questions, p.durs, p.qrBase, p.variant);
  const outDir = join(OUT_ROOT, slot.key, platform);
  mkdirSync(outDir, { recursive: true });
  const outMp4 = join(outDir, `${slot.key}-${platform}.mp4`);

  const props: any = {
    slug: "", platform, questionIds: slot.ids, questions: p.questions, durs: p.durs, qrBase: p.qrBase,
    music: slot.music, sfx: sfxSet(slot.sfxSlug),
    readVO: slot.readVO, dropReveal: slot.dropReveal ?? false, dropScore: !!slot.dropScore, endCard: slot.endCard, metaBase: p.metaBase,
    totalFrames: T.total,
  };

  if (slot.comp === "MascotShort") {
    const cuesFor = (relSrc: string): RhubarbCue[] => {
      const abs = join(PUBLIC, relSrc);
      if (!cueCache.has(abs)) {
        if (!existsSync(abs)) throw new Error(`missing audio for cues: ${abs}`);
        cueCache.set(abs, generateCues(rhubarb, abs).mouthCues);
      }
      return cueCache.get(abs)!;
    };
    props.narratorClips = T.narration.map((n) => ({ from: n.from, durF: Math.max(1, Math.round((p.durs[clipKey(n.src)] ?? 3) * FPS)), cues: cuesFor(n.src) }));
  }

  const propsFile = join(tmpdir(), `reslot-${slot.key}-${platform}.props.json`);
  writeFileSync(propsFile, JSON.stringify(props));
  return { slot, platform, prep: p, outMp4, propsFile, T };
}

const renderOne = (j: Job) => new Promise<void>((res, rej) => {
  const pr = spawn("npx", ["remotion", "render", j.slot.comp, j.outMp4, `--props=${j.propsFile}`, "--log=error"], { cwd: REMOTION, stdio: ["ignore", "inherit", "inherit"] });
  pr.on("exit", (code) => (code === 0 ? res() : rej(new Error(`render failed: ${j.slot.key}/${j.platform} (exit ${code})`))));
  pr.on("error", rej);
});

function verify(j: Job) {
  const [w, h] = ffprobe(j.outMp4, ["-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0"]).split(",").map(Number);
  const container = durOf(j.outMp4);
  const aDur = Number(ffprobe(j.outMp4, ["-select_streams", "a:0", "-show_entries", "stream=duration", "-of", "default=nk=1:nw=1"]) || "0");
  const expectSec = j.T.total / FPS;
  const problems: string[] = [];
  if (w !== 1080 || h !== 1920) problems.push(`aspect ${w}x${h} != 1080x1920`);
  if (Math.abs(container - expectSec) > 0.35) problems.push(`duration ${container.toFixed(2)}s vs expected ${expectSec.toFixed(2)}s`);
  if (aDur > 0 && Math.abs(aDur - container) > 0.3) problems.push(`A/V drift ${(aDur - container).toFixed(2)}s`);
  if (problems.length) throw new Error(`ffprobe verify FAILED ${j.slot.key}/${j.platform}: ${problems.join("; ")}`);
  console.log(`  [ok] ${j.slot.key}/${j.platform}  ${w}x${h}  ${container.toFixed(2)}s (audio ${aDur.toFixed(2)}s)`);
  return { w, h, container, aDur };
}

function writeUsage(preps: Prep[]) {
  const prev = existsSync(USAGE_PATH) ? JSON.parse(readFileSync(USAGE_PATH, "utf8")) : { note: "", videos: [] };
  const byVideo = new Map<string, any>((prev.videos || []).map((u: any) => [u.videoSlug, u]));
  for (const p of preps) byVideo.set(p.usage.videoSlug, p.usage);
  writeFileSync(USAGE_PATH, JSON.stringify({ ...prev, updated: new Date().toISOString().slice(0, 10), videos: [...byVideo.values()] }, null, 2) + "\n");
}

async function main() {
  const { only, platform: onlyPlatform, concurrency, skipExisting } = parseArgs();
  const nar = await import(pathToFileURL(join(CONTENT, "gen-narration-scripts.mjs")).href);
  const narrIndex = JSON.parse(readFileSync(join(VIDEO, "voice", "narration", "narration_index.json"), "utf8"));
  const voiceId = narrIndex.voice_id || "lZcmpVLaoXF4v0uz4l6Q";
  const bank = JSON.parse(readFileSync(BANK_PATH, "utf8"));
  const bankSigs = new Set<string>(bank.entries.map((e: any) => e.sig));
  const rhubarb = findRhubarb(TOOLS);
  const cueCache = new Map<string, RhubarbCue[]>();

  const slots = only ? SLOTS.filter((s) => s.key === only) : SLOTS;
  const platforms = onlyPlatform ? [onlyPlatform] : PLATFORMS;
  console.log(`[reslot] ${slots.length} slot(s) x ${platforms.length} platform(s); voice_id=${voiceId}`);

  // ---- phase A (serial): VO prep per slot ----
  const preps: Prep[] = [];
  for (const s of slots) {
    console.log(`[prep] ${s.key} ${s.round} ids[${s.ids.join(",")}] readVO=${s.readVO}${s.speed ? " SPED" : ""} end=${s.endCard} comp=${s.comp}`);
    preps.push(await prep(s, voiceId, nar, bank, bankSigs));
  }

  // ---- build jobs (mascot visemes done here, once per slot, shared across platforms) ----
  const jobs: Job[] = [];
  for (const p of preps) for (const pl of platforms) jobs.push(buildJob(p, pl, rhubarb, cueCache));

  // ---- phase B (concurrent): render ----
  const toRender = jobs.filter((j) => !(skipExisting && existsSync(j.outMp4)));
  console.log(`\n[reslot] rendering ${toRender.length}/${jobs.length}, concurrency ${concurrency}\n`);
  const queue = [...toRender];
  let started = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length) {
      const j = queue.shift()!;
      console.log(`[render ${++started}/${toRender.length}] ${j.slot.key}/${j.platform}`);
      await renderOne(j);
    }
  }));

  // ---- phase C (serial): verify + sidecars ----
  const results: any[] = [];
  for (const j of jobs) {
    const v = verify(j);
    // captions from the actual VO events on this variant's timeline
    const textForKey = makeTextForKey(j.prep, nar);
    const cues: { s: number; e: number; text: string }[] = [];
    for (const n of j.T.narration) {
      const key = clipKey(n.src);
      const text = textForKey(key);
      if (!text) continue;
      const beatDur = j.prep.durs[key] ?? 3;
      // simple word-proportional split
      const clean = text.replace(/\[[^\]]+\]/g, " ").replace(/\s+/g, " ").trim();
      if (clean) cues.push({ s: n.from / FPS, e: (n.from + Math.round(beatDur * FPS)) / FPS, text: clean });
    }
    const outDir = join(OUT_ROOT, j.slot.key, j.platform);
    writeFileSync(join(outDir, "info.json"), JSON.stringify({
      slot: j.slot.key, variant: j.slot.variantKey, family: j.slot.family, platform: j.platform,
      round: j.slot.round, ids: j.slot.ids,
      questions: j.slot.ids.map((id) => { const q = j.prep.qById.get(id); return { id, kind: q.kind, category: q.category, tier: q.tier, answer: q.ansLabel }; }),
      treatment: { readVO: j.slot.readVO, dropReveal: j.slot.dropReveal, dropScore: j.slot.dropScore, endCard: j.slot.endCard, speed: !!j.slot.speed, comp: j.slot.comp },
      music: j.slot.music, sfx: j.slot.sfxSlug, frames: j.T.total, ...v, file: basename(j.outMp4),
    }, null, 2) + "\n");
    results.push({ slot: j.slot.key, platform: j.platform, file: j.outMp4, ...v });
  }

  writeUsage(preps);
  console.log(`\n[done] ${jobs.length} render(s) -> ${OUT_ROOT}`);
  console.log(JSON.stringify({ ok: true, results }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
