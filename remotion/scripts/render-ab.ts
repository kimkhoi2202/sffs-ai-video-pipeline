/**
 * render-ab.ts — the A/B-TEST BATCH RENDER. Builds 12 short-form 9:16 videos in
 * four tests, each a PROP-DRIVEN variant of the shared `Short` (FullVideo)
 * composition — no new compositions, one tiny Root.tsx hook (totalFrames). All
 * variant behavior (drop reveal/score, selectively drop question/options VO,
 * sped VO, comment/verdict end cards) is carried by the timeline `variant` opts.
 *
 * Per video it:
 *   1. pulls FRESH, globally-deduped questions from an UN-RENDERED round of the
 *      master bank (each video a distinct round -> disjoint questions), and
 *      asserts every picked question is a tracked master-bank entry;
 *   2. synthesizes only the VO beats it actually needs with the cloned voice
 *      (voice/tts_batch.py) — the full q clip, or the split qs/qo clips, plus r
 *      and the new comment/verdict end-VO — reusing the committed meta beats;
 *   3. for the SPEED test, atempo's every VO clip to ~1.25x (=1.12x baseline x
 *      1.116) and ASSERTS each sped clip is ~0.90x its original before render
 *      (guards the past "atempo silently didn't apply" bug);
 *   4. builds the variant timeline (cold open, 5s countdowns, ducked distinct
 *      music + SFX) and renders via `remotion render Short --props`;
 *   5. ffprobe-verifies every output (1080x1920, duration vs timeline, A/V drift);
 *   6. writes captions.srt/.vtt + questions.json + info.md per video, the A/B
 *      manifest, and marks the consumed questions used in content/ab-test-usage.json.
 *
 * Run from remotion/:  npx tsx scripts/render-ab.ts [--concurrency 3] [--only <test>]
 *                      [--skip-existing] [--voice-id <id>]
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { pathToFileURL } from "node:url";
import { getTimeline, FPS, type Platform, type SfxSet, type TimelineData, type Variant, type ReadVO, type EndCard, type DropReveal } from "../src/full/timeline";
import { COLORS } from "../src/theme/brand";

const REMOTION = resolve(import.meta.dirname, "..");
const VIDEO = resolve(REMOTION, "..");
const CONTENT = join(VIDEO, "content");
const ROUNDS = join(CONTENT, "rounds");
const BANK_PATH = join(CONTENT, "master-question-bank.json");
const NARR_COMMITTED_ABS = join(REMOTION, "public", "audio", "narration");
const AB_AUDIO_ABS = join(REMOTION, "public", "audio", "rounds", "ab"); // served via audio/rounds/ab/<slug>/
const AB_AUDIO_REL = "audio/rounds/ab";
const OUT_ROOT = join(VIDEO, "renders.nosync", "videos", "ab-tests");
const FFPROBE = process.env.FFPROBE || "/opt/homebrew/bin/ffprobe";
const FFMPEG = process.env.FFMPEG || "/opt/homebrew/bin/ffmpeg";

// ---- speed test: 1.12x baseline -> ~1.25x. atempo = 1.25/1.12; each sped clip
//      must land at ~0.90x (=1.12/1.25) its original length. -------------------
const SPEED_ATEMPO = 1.25 / 1.12; // ≈ 1.1161 (pitch-preserving, single-stage, in [0.5,2])
const SPEED_TARGET_RATIO = 1.12 / 1.25; // ≈ 0.896 expected sped/original length
const SPEED_RATIO_TOL = 0.05; // accept 0.846..0.946
const SPEED_MUST_SHRINK = 0.96; // and it MUST be clearly shorter (catch the silent no-op)

// New round-agnostic end-card VO (cloned voice), committed under audio/narration/.
const NOANSWER_TEXT = "[excited] Want the full test? It's free! Link in our bio.";
const NOANSWER_YT_TEXT = "[excited] Want the full test? It's free! Link in the description.";
const VERDICT_TEXT = "[excited] So... are you a smart fella, or a fart smella?";
const META_TEXT: Record<string, string> = {
  timesup: "TIME'S UP!",
  score: "So, are you smart or fart? Count up your correct answers to find your rank!",
  "outro-follow": "So, how did you do? The full test is free. Link in our bio!",
  "outro-youtube": "So, how did you do? The full test is free. Link in the description!",
  "outro-noanswer": "Want the full test? It's free! Link in our bio.",
  "outro-noanswer-youtube": "Want the full test? It's free! Link in the description.",
  verdict: "So... are you a smart fella, or a fart smella?",
};

const sfxSet = (slug: string): SfxSet => ({ whoosh: `${slug}/whoosh.mp3`, ding: `${slug}/ding.mp3`, sting: `${slug}/sting.mp3` });

type ABVideo = {
  test: string;
  variant: string; // may nest (arm/video) for don't-narrate
  round: string;
  ids: number[];
  readVO: ReadVO;
  dropReveal?: DropReveal; // false=reveal all, true=reveal none, "last"=cliffhanger
  dropScore?: boolean;
  endCard: EndCard;
  speed?: boolean;
  music: string;
  sfxSlug: string;
};

// 12 videos across 4 tests. Each video = a distinct UN-RENDERED round (008..019;
// rendered rounds 001-007/020/025 are avoided), so questions are fresh + disjoint.
// 3Q videos use [1,11,7] (verbal->nonverbal->quant hard finale); 1Q videos vary.
const Q3 = [1, 11, 7];
const VIDEOS: ABVideo[] = [
  // 1) NO-ANSWER: 3Q ask+5s, drop reveal + score, comment-CTA end card.
  { test: "no-answer", variant: "video-1", round: "round-008", ids: Q3, readVO: "full", dropReveal: true, dropScore: true, endCard: "noanswer", music: "gameshow-fanfare.mp3", sfxSlug: "short-1" },
  { test: "no-answer", variant: "video-2", round: "round-009", ids: Q3, readVO: "full", dropReveal: true, dropScore: true, endCard: "noanswer", music: "prize-wheel-parade.mp3", sfxSlug: "short-2" },

  // 2) DON'T-NARRATE: standard 3Q + reveal + score, selectively drop read VO (3 arms x 2).
  { test: "dont-narrate", variant: "no-question-vo/video-1", round: "round-010", ids: Q3, readVO: "options", endCard: "default", music: "winner-spin.mp3", sfxSlug: "short-3" },
  { test: "dont-narrate", variant: "no-question-vo/video-2", round: "round-011", ids: Q3, readVO: "options", endCard: "default", music: "bonus-round-bounce.mp3", sfxSlug: "short-4" },
  { test: "dont-narrate", variant: "no-options-vo/video-1", round: "round-012", ids: Q3, readVO: "stem", endCard: "default", music: "final-round-fanfare.mp3", sfxSlug: "short-5" },
  { test: "dont-narrate", variant: "no-options-vo/video-2", round: "round-013", ids: Q3, readVO: "stem", endCard: "default", music: "fanfare.mp3", sfxSlug: "short-1" },
  { test: "dont-narrate", variant: "no-narration/video-1", round: "round-014", ids: Q3, readVO: "none", endCard: "default", music: "parade.mp3", sfxSlug: "short-2" },
  { test: "dont-narrate", variant: "no-narration/video-2", round: "round-015", ids: Q3, readVO: "none", endCard: "default", music: "winner.mp3", sfxSlug: "short-3" },

  // 3) SPEED: standard 3Q + reveal + score, VO atempo'd to ~1.25x.
  { test: "speed", variant: "video-1", round: "round-016", ids: Q3, readVO: "full", endCard: "default", speed: true, music: "gameshow-fanfare.mp3", sfxSlug: "short-4" },
  { test: "speed", variant: "video-2", round: "round-017", ids: Q3, readVO: "full", endCard: "default", speed: true, music: "prize-wheel-parade.mp3", sfxSlug: "short-5" },

  // 4) ONE-QUESTION: exactly 1Q + 5s + reveal, one-shot verdict payoff (no score).
  { test: "one-question", variant: "video-1", round: "round-018", ids: [1], readVO: "full", dropScore: true, endCard: "verdict", music: "winner-spin.mp3", sfxSlug: "short-1" },
  { test: "one-question", variant: "video-2", round: "round-019", ids: [7], readVO: "full", dropScore: true, endCard: "verdict", music: "bonus-round-bounce.mp3", sfxSlug: "short-2" },

  // 5) CLIFFHANGER: 3Q, reveal Q1 + Q2, but NO reveal for Q3 -> end on comment-CTA (no score).
  { test: "cliffhanger", variant: "video-1", round: "round-021", ids: Q3, readVO: "full", dropReveal: "last", dropScore: true, endCard: "noanswer", music: "final-round-fanfare.mp3", sfxSlug: "short-3" },
  { test: "cliffhanger", variant: "video-2", round: "round-022", ids: Q3, readVO: "full", dropReveal: "last", dropScore: true, endCard: "noanswer", music: "gameshow-fanfare.mp3", sfxSlug: "short-5" },
];

const TEST_DESC: Record<string, string> = {
  "no-answer": "Ask 3 questions with a 5s countdown each, DROP the reveal + score, end on a comment-for-the-answer CTA. Baseline = existing full shorts.",
  "dont-narrate": "Standard 3Q + reveal + score, selectively drop question/options VO (question still displays). Baseline = existing full-narration shorts.",
  speed: "Standard 3Q + reveal + score, VO sped to ~1.25x (1.12x baseline x1.116 atempo). Baseline = existing 1.12x shorts.",
  "one-question": "Exactly 1 question + 5s + reveal, then a one-shot smart-fella/fart-smella verdict (no score screen).",
  cliffhanger: "3Q + 5s each; reveal Q1 and Q2 normally, but NO reveal for Q3 — end on the comment-for-the-answer CTA (no score screen).",
};

// ---------------------------------------------------------------------------
type Args = { concurrency: number; only?: string; skipExisting: boolean; voiceId: string };
function parseArgs(): Args {
  const a = process.argv.slice(2);
  let concurrency = 3;
  let only: string | undefined;
  let skipExisting = false;
  let voiceId = "";
  for (let i = 0; i < a.length; i++) {
    const t = a[i];
    if (t === "--concurrency") concurrency = Number(a[++i]);
    else if (t.startsWith("--concurrency=")) concurrency = Number(t.slice(14));
    else if (t === "--only") only = a[++i];
    else if (t.startsWith("--only=")) only = t.slice(7);
    else if (t === "--skip-existing") skipExisting = true;
    else if (t === "--voice-id") voiceId = a[++i];
    else if (t.startsWith("--voice-id=")) voiceId = t.slice(11);
  }
  return { concurrency: Math.max(1, concurrency), only, skipExisting, voiceId };
}

const flatSlug = (v: ABVideo) => `${v.test}-${v.variant.replace(/\//g, "-")}`;

// ---- round JSON question -> runtime Question shape (mirrors render-round.ts) --
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

// ---- ffprobe / ffmpeg helpers ---------------------------------------------
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
  // MUST re-encode (never -c:a copy) or the filter is silently dropped.
  execFileSync(FFMPEG, ["-y", "-i", inFile, "-filter:a", `atempo=${factor}`, "-c:a", "libmp3lame", "-q:a", "2", outFile], { stdio: ["ignore", "ignore", "inherit"] });
}

// ---- captions (phrase-chunked from each VO beat's window; mirrors render-round.ts) ----
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

// ---- TTS wrapper -----------------------------------------------------------
function ttsBeats(beats: { beat: string; text: string }[], outDir: string, voiceId: string): Record<string, number> {
  mkdirSync(outDir, { recursive: true });
  const bf = join(outDir, "_beats.json");
  writeFileSync(bf, JSON.stringify(beats, null, 2));
  const r = spawnSync("python3", [join(VIDEO, "voice", "tts_batch.py"), "--beats", bf, "--voice-id", voiceId, "--out-dir", outDir, "--skip-existing"], { stdio: "inherit" });
  if (r.status !== 0) throw new Error(`tts_batch failed -> ${outDir}`);
  return JSON.parse(readFileSync(join(outDir, "durations.json"), "utf8"));
}

// ---------------------------------------------------------------------------
type Job = {
  v: ABVideo; slug: string; outDir: string; outMp4: string; propsFile: string;
  T: TimelineData; expectSec: number; durs: Record<string, number>;
  scripts: Record<string, string>; textForKey: (k: string) => string; round: any;
};

async function main() {
  const { concurrency, only, skipExisting, voiceId: voiceArg } = parseArgs();
  const nar = await import(pathToFileURL(join(CONTENT, "gen-narration-scripts.mjs")).href);
  const { roundScripts, qStemBeat, qOptionsBeat } = nar as {
    roundScripts: (r: any) => Record<string, string>;
    qStemBeat: (q: any) => string;
    qOptionsBeat: (q: any) => string;
  };
  const narrIndexPath = join(VIDEO, "voice", "narration", "narration_index.json");
  const narrIndex = existsSync(narrIndexPath) ? JSON.parse(readFileSync(narrIndexPath, "utf8")) : {};
  const voiceId = voiceArg || narrIndex.voice_id || "lZcmpVLaoXF4v0uz4l6Q";
  console.log(`[ab] cloned voice_id = ${voiceId} (from narration_index.json)`);

  // AUDIO HYGIENE: every meta VO duration is measured from the ACTUAL played copy
  // under public/audio/narration/ (what Remotion muxes) — NEVER the stale
  // voice/narration/ index (a divergence there caused a lip-sync bug elsewhere).
  const metaDur = (b: string) => durOf(join(NARR_COMMITTED_ABS, `${b}.mp3`));

  const bank = JSON.parse(readFileSync(BANK_PATH, "utf8"));
  const bankSigs = new Set<string>(bank.entries.map((e: any) => e.sig));
  const bySlugRound = new Map<string, any>();
  const roundOf = (slug: string) => {
    if (!bySlugRound.has(slug)) bySlugRound.set(slug, JSON.parse(readFileSync(join(ROUNDS, `${slug}.json`), "utf8")));
    return bySlugRound.get(slug);
  };

  const videos = only ? VIDEOS.filter((v) => v.test === only) : VIDEOS;

  // 0) new committed end-card VO (cloned voice), generated once.
  console.log(`\n[ab] end-card VO (outro-noanswer[-youtube], verdict) -> audio/narration/`);
  ttsBeats(
    [
      { beat: "outro-noanswer", text: NOANSWER_TEXT },
      { beat: "outro-noanswer-youtube", text: NOANSWER_YT_TEXT },
      { beat: "verdict", text: VERDICT_TEXT },
    ],
    NARR_COMMITTED_ABS,
    voiceId,
  );
  const NOANSWER_DUR = metaDur("outro-noanswer");
  const VERDICT_DUR = metaDur("verdict");

  // ---- phase A (serial, API-bound): narration + speed + timelines + props ----
  const jobs: Job[] = [];
  const usage: any[] = [];
  for (const v of videos) {
    const slug = flatSlug(v);
    const round = roundOf(v.round);
    const scripts = roundScripts(round);
    const qById = new Map<number, any>(round.questions.map((q: any) => [q.id, q]));

    // freshness + dedup: every picked question must be a tracked master-bank entry.
    for (const id of v.ids) {
      const e = bank.entries.find((x: any) => x.slug === v.round && x.id === id);
      if (!e) throw new Error(`${slug}: ${v.round} Q${id} not in master bank`);
      if (!bankSigs.has(e.sig)) throw new Error(`${slug}: ${v.round} Q${id} sig missing from bank`);
    }

    const audioDir = join(AB_AUDIO_ABS, slug);
    const audioRel = `${AB_AUDIO_REL}/${slug}/`;

    // beats this variant actually voices (read + reveal).
    const readBeats: { beat: string; text: string }[] = [];
    for (const id of v.ids) {
      if (v.readVO === "full") readBeats.push({ beat: `q${id}`, text: scripts[`q${id}`] });
      else if (v.readVO === "options") readBeats.push({ beat: `qo${id}`, text: qOptionsBeat(qById.get(id)) });
      else if (v.readVO === "stem") readBeats.push({ beat: `qs${id}`, text: qStemBeat(qById.get(id)) });
    }
    // reveal VO only for questions that actually reveal: none (true), all but the
    // last ("last" = cliffhanger), or all (false/undefined).
    const revealIds = v.dropReveal === true ? [] : v.dropReveal === "last" ? v.ids.slice(0, -1) : v.ids;
    const revealBeats = revealIds.map((id) => ({ beat: `r${id}`, text: scripts[`r${id}`] }));

    let qrBase = audioRel;
    let metaBase = "audio/narration/";
    let durs: Record<string, number> = {};

    if (v.speed) {
      // 1) natural VO into _nat/, 2) atempo every clip (read+reveal+meta) into audioDir, 3) ASSERT ~0.90x.
      const natDir = join(audioDir, "_nat");
      const natDurs = ttsBeats([...readBeats, ...revealBeats], natDir, voiceId);
      mkdirSync(audioDir, { recursive: true });
      const spedDurs: Record<string, number> = {};
      const assertShrink = (beat: string, nat: number, sped: number) => {
        const ratio = sped / nat;
        const ok = ratio < SPEED_MUST_SHRINK && Math.abs(ratio - SPEED_TARGET_RATIO) <= SPEED_RATIO_TOL;
        console.log(`  [speed] ${beat.padEnd(6)} ${nat.toFixed(2)}s -> ${sped.toFixed(2)}s  (x${ratio.toFixed(3)})${ok ? "" : "  <-- OUT OF RANGE"}`);
        if (!ok) throw new Error(`${slug}: atempo assertion failed for ${beat}: ratio ${ratio.toFixed(3)} (want ~${SPEED_TARGET_RATIO.toFixed(3)}, must be < ${SPEED_MUST_SHRINK})`);
      };
      for (const b of [...readBeats, ...revealBeats]) {
        atempo(join(natDir, `${b.beat}.mp3`), join(audioDir, `${b.beat}.mp3`), SPEED_ATEMPO);
        const sped = durOf(join(audioDir, `${b.beat}.mp3`));
        assertShrink(b.beat, natDurs[b.beat], sped);
        spedDurs[b.beat] = sped;
      }
      // meta beats used by a standard cut: timesup + score + outro-follow (endCard default).
      for (const m of ["timesup", "score", "outro-follow"]) {
        atempo(join(NARR_COMMITTED_ABS, `${m}.mp3`), join(audioDir, `${m}.mp3`), SPEED_ATEMPO);
        const sped = durOf(join(audioDir, `${m}.mp3`));
        assertShrink(m, metaDur(m), sped);
        spedDurs[m] = sped;
      }
      durs = spedDurs;
      metaBase = audioRel; // sped meta lives beside the sped q/r
    } else {
      const vDurs = readBeats.length || revealBeats.length ? ttsBeats([...readBeats, ...revealBeats], audioDir, voiceId) : {};
      durs = {
        timesup: metaDur("timesup"), score: metaDur("score"), "outro-follow": metaDur("outro-follow"),
        "outro-noanswer": NOANSWER_DUR, verdict: VERDICT_DUR, ...vDurs,
      };
    }

    const variant: Variant = { readVO: v.readVO, dropReveal: v.dropReveal, dropScore: v.dropScore, endCard: v.endCard, metaBase };
    const questions = toQuestions(round, durs);
    const T = getTimeline("instagram" as Platform, v.ids, sfxSet(v.sfxSlug), questions, durs, qrBase, variant);
    const expectSec = T.total / FPS;

    const outDir = join(OUT_ROOT, v.test, v.variant);
    mkdirSync(outDir, { recursive: true });
    const outMp4 = join(outDir, `${slug}.mp4`);

    const props = {
      slug: "", platform: "instagram", questionIds: v.ids, questions, durs, qrBase,
      music: v.music, sfx: sfxSet(v.sfxSlug),
      readVO: v.readVO, dropReveal: v.dropReveal ?? false, dropScore: !!v.dropScore, endCard: v.endCard, metaBase,
      totalFrames: T.total,
    };
    const propsFile = join(audioDir, `_props.json`);
    mkdirSync(audioDir, { recursive: true });
    writeFileSync(propsFile, JSON.stringify(props));

    // caption text per clip key
    const textForKey = (k: string): string => {
      if (/^q\d+$/.test(k)) return scripts[k] ?? "";
      if (/^qo\d+$/.test(k)) return qOptionsBeat(qById.get(Number(k.slice(2))));
      if (/^qs\d+$/.test(k)) return qStemBeat(qById.get(Number(k.slice(2))));
      if (/^r\d+$/.test(k)) return scripts[k] ?? "";
      return META_TEXT[k] ?? "";
    };

    usage.push({
      videoSlug: slug, test: v.test, variant: v.variant, round: v.round,
      questions: v.ids.map((id) => {
        const e = bank.entries.find((x: any) => x.slug === v.round && x.id === id);
        return { id, sig: e.sig, tier: e.tier, answerNorm: e.answerNorm };
      }),
    });

    jobs.push({ v, slug, outDir, outMp4, propsFile, T, expectSec, durs, scripts, textForKey, round });
    console.log(`[prep] ${slug}: ${v.round} Q[${v.ids.join(",")}] readVO=${v.readVO}${v.dropReveal ? " -reveal" : ""}${v.dropScore ? " -score" : ""} end=${v.endCard}${v.speed ? " SPED" : ""} ~${expectSec.toFixed(1)}s`);
  }

  // ---- phase B (concurrent, CPU-bound): render ----
  const toRender = jobs.filter((j) => !(skipExisting && existsSync(j.outMp4)));
  console.log(`\n[ab] rendering ${toRender.length}/${jobs.length} video(s), concurrency ${concurrency}\n`);
  const renderOne = (j: Job) => new Promise<void>((res, rej) => {
    const p = spawn("npx", ["remotion", "render", "Short", j.outMp4, `--props=${j.propsFile}`, "--log=error"], { cwd: REMOTION, stdio: ["ignore", "inherit", "inherit"] });
    p.on("exit", (code) => (code === 0 ? res() : rej(new Error(`render failed: ${j.slug} (exit ${code})`))));
    p.on("error", rej);
  });
  const queue = [...toRender];
  let started = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length) {
      const j = queue.shift()!;
      console.log(`[render ${++started}/${toRender.length}] ${j.slug} -> ${j.v.test}/${j.v.variant}`);
      await renderOne(j);
    }
  }));

  // ---- phase C (serial): verify + sidecars ----
  const manifestTests = new Map<string, any>();
  for (const j of jobs) {
    const { v, T, expectSec } = j;
    const [w, h] = ffprobe(j.outMp4, ["-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0"]).split(",").map(Number);
    const container = durOf(j.outMp4);
    const aDur = Number(ffprobe(j.outMp4, ["-select_streams", "a:0", "-show_entries", "stream=duration", "-of", "default=nk=1:nw=1"]) || "0");
    const problems: string[] = [];
    if (w !== 1080 || h !== 1920) problems.push(`aspect ${w}x${h} != 1080x1920`);
    if (Math.abs(container - expectSec) > 0.35) problems.push(`duration ${container.toFixed(2)}s vs expected ${expectSec.toFixed(2)}s`);
    if (aDur > 0 && Math.abs(aDur - container) > 0.3) problems.push(`A/V drift ${(aDur - container).toFixed(2)}s`);
    if (problems.length) throw new Error(`ffprobe verify FAILED ${j.slug}: ${problems.join("; ")}`);
    console.log(`  [ok] ${j.slug}  ${w}x${h}  ${container.toFixed(2)}s (audio ${aDur.toFixed(2)}s)`);

    // captions from the actual VO events on this variant's timeline
    const cues: { s: number; e: number; text: string }[] = [];
    for (const n of T.narration) {
      const key = clipKey(n.src);
      const text = j.textForKey(key);
      if (!text) continue;
      const beatDur = j.durs[key] ?? 3;
      for (const c of beatCaptions(text, n.from, beatDur)) cues.push({ s: c.s / FPS, e: c.e / FPS, text: c.text });
    }
    cues.sort((a, b) => a.s - b.s);
    const srt = cues.map((c, i) => `${i + 1}\n${tsStamp(c.s, true)} --> ${tsStamp(c.e, true)}\n${c.text}\n`).join("\n");
    const vtt = "WEBVTT\n\n" + cues.map((c) => `${tsStamp(c.s, false)} --> ${tsStamp(c.e, false)}\n${c.text}\n`).join("\n");
    writeFileSync(join(j.outDir, "captions.srt"), srt);
    writeFileSync(join(j.outDir, "captions.vtt"), vtt);

    // questions.json + info.md
    const byId = new Map<number, any>(j.round.questions.map((q: any) => [q.id, q]));
    const promptOf = (q: any) => (q.kind === "text" ? q.question : q.prompt).replace(/\n/g, " / ");
    const qMeta = v.ids.map((id, i) => {
      const q = byId.get(id);
      return { pos: i + 1, id, kind: q.kind, category: q.category, difficulty: q.difficulty, tier: q.tier, prompt: promptOf(q), answer: { letter: q.ansLetter, label: q.ansLabel } };
    });
    const treatment = { readVO: v.readVO, dropReveal: v.dropReveal ?? false, dropScore: !!v.dropScore, endCard: v.endCard, speed: !!v.speed, ...(v.speed ? { atempo: Number(SPEED_ATEMPO.toFixed(4)), targetRatio: Number(SPEED_TARGET_RATIO.toFixed(3)) } : {}) };
    writeFileSync(join(j.outDir, "questions.json"), JSON.stringify({ test: v.test, variant: v.variant, round: v.round, format: "9:16", questionCount: v.ids.length, countdownSec: 5, treatment, music: v.music, sfx: v.sfxSlug, questions: qMeta }, null, 2) + "\n");
    const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
    const rows = qMeta.map((q) => `| ${q.pos} | Q${q.id} | ${q.category} | ${q.difficulty} | ${q.tier} | ${q.answer.letter} · ${q.answer.label} |`).join("\n");
    writeFileSync(join(j.outDir, "info.md"), `# A/B — ${v.test} — ${v.variant}

- **Test:** ${v.test} — ${TEST_DESC[v.test]}
- **Source round:** ${v.round} (fresh / un-rendered)
- **Aspect:** 9:16 (1080x1920), cold open, 5s countdown/question
- **Treatment:** readVO=${v.readVO}, dropReveal=${v.dropReveal ?? false}, dropScore=${!!v.dropScore}, endCard=${v.endCard}, speed=${!!v.speed}
- **Duration:** ~${mmss(expectSec)} (${Math.round(expectSec)}s)
- **Music:** ${v.music} · **SFX set:** ${v.sfxSlug}
- **File:** \`${basename(j.outMp4)}\`

## Questions (play order)

| # | Source | Category | Difficulty | Type | Answer |
|---|--------|----------|------------|------|--------|
${rows}

## Files
- \`${basename(j.outMp4)}\` — the video (h264/yuv420p + AAC), ffprobe-verified 1080x1920, ${container.toFixed(2)}s, A/V drift ${(aDur - container).toFixed(2)}s.
- \`captions.srt\` / \`captions.vtt\` — spoken transcript (phrase-chunked; reflects the dropped/sped VO).
- \`questions.json\` — this video's questions + treatment.
`);

    if (!manifestTests.has(v.test)) manifestTests.set(v.test, { test: v.test, description: TEST_DESC[v.test], videos: [] });
    manifestTests.get(v.test).videos.push({
      variant: v.variant,
      path: join("ab-tests", v.test, v.variant, basename(j.outMp4)),
      round: v.round,
      questionIds: v.ids,
      questions: qMeta.map((q) => ({ pos: q.pos, id: q.id, tier: q.tier, answer: `${q.answer.letter} · ${q.answer.label}` })),
      durationSec: Math.round(container * 100) / 100,
      frames: T.total,
      treatment, music: v.music, sfx: v.sfxSlug,
      captions: { srt: "captions.srt", vtt: "captions.vtt" },
    });
  }

  // ---- manifest + usage ledger ----
  const manifest = {
    generated: new Date().toISOString().slice(0, 10),
    voiceId,
    format: "9:16 (1080x1920)",
    global: "cold open, 5s countdown/question, distinct per-video music + SFX, cloned ElevenLabs voice, ffprobe-verified",
    notes: [
      "Shorts are now PERMANENTLY cold-open: the `withIntro` flag + the short intro-prepend branch were retired, so a 9:16 short can never render with a branded intro again. The YouTube long-form title intro and the standalone brand-intro promo (IntroBrand / sffs-brand-intro-v1) are unchanged.",
    ],
    speed: { atempo: Number(SPEED_ATEMPO.toFixed(4)), baseline: "1.12x", target: "~1.25x", expectedClipRatio: Number(SPEED_TARGET_RATIO.toFixed(3)) },
    tests: [...manifestTests.values()],
  };
  writeFileSync(join(OUT_ROOT, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

  const usagePath = join(CONTENT, "ab-test-usage.json");
  const prevUsage = existsSync(usagePath) ? JSON.parse(readFileSync(usagePath, "utf8")) : { note: "Questions consumed by A/B-test renders (fresh pulls from the append-only master bank; every sig is a tracked bank entry).", videos: [] };
  const byVideo = new Map<string, any>((prevUsage.videos || []).map((u: any) => [u.videoSlug, u]));
  for (const u of usage) byVideo.set(u.videoSlug, u);
  writeFileSync(usagePath, JSON.stringify({ ...prevUsage, updated: new Date().toISOString().slice(0, 10), videos: [...byVideo.values()] }, null, 2) + "\n");

  console.log(`\n[done] ${jobs.length} A/B video(s) -> ${OUT_ROOT}`);
  console.log(`[done] manifest -> ab-tests/manifest.json ; usage -> content/ab-test-usage.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
