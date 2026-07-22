#!/usr/bin/env node
/**
 * render-samples-text.mjs — ISOLATED sample renders for the 5 new TEXT-based
 * question types (Letter Series, Synonyms/Antonyms, Quantitative Comparison,
 * Deductive Logic, Math Word Problems) from content/new-question-types-proposal.md.
 *
 * Self-contained + local: reads content/staging-new-types-text.json (NOT the
 * master bank), builds one small on-brand `Short` round per type (the first 3
 * questions of that type), synthesizes on-brand narration with the cloned host
 * voice (voice/tts_batch.py), renders the REAL `Short` (FullVideo) composition
 * (1080x1920), and ffprobe-verifies each output.
 *
 * Modeled on scripts/render-ab.ts, but:
 *   - uses the DEFAULT timeline variant (full VO + reveal + score + follow outro),
 *     so Root's Short calculateMetadata computes duration from the props itself
 *     (no timeline import needed -> plain Node ESM, no tsx);
 *   - uses EXISTING plates only (text / numseries) — NO new render code;
 *   - writes narration under the gitignored public/audio/rounds/<sample-slug>/
 *     and mp4s under the .nosync renders tree, so nothing shared is touched.
 *
 * Run from remotion/:  node scripts/render-samples-text.mjs [--only <type>] [--skip-existing]
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REMOTION = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const VIDEO = resolve(REMOTION, "..");
const CONTENT = join(VIDEO, "content");
const STAGING = join(CONTENT, "staging-new-types-text.json");
const META_DURS = JSON.parse(readFileSync(join(REMOTION, "src", "data", "durations.json"), "utf8"));
const PUB_ROUNDS = join(REMOTION, "public", "audio", "rounds");
const OUT_ROOT = join(VIDEO, "renders.nosync", "new-types-samples", "text");
const FFPROBE = process.env.FFPROBE || "/opt/homebrew/bin/ffprobe";
const VOICE_ID = process.env.VOICE_ID || "lZcmpVLaoXF4v0uz4l6Q"; // cloned "Booming Ringmaster"
const FPS = 30;

// distinct on-brand music + SFX per sample (from committed public/audio/*).
const LOOK = {
  "letter-series": { music: "gameshow-fanfare.mp3", sfx: "short-1" },
  "synonyms-antonyms": { music: "prize-wheel-parade.mp3", sfx: "short-2" },
  "quantitative-comparison": { music: "bonus-round-bounce.mp3", sfx: "short-3" },
  "deductive-logic": { music: "final-round-fanfare.mp3", sfx: "short-4" },
  "math-word-problems": { music: "winner-spin.mp3", sfx: "short-5" },
};
const sfxSet = (slug) => ({ whoosh: `${slug}/whoosh.mp3`, ding: `${slug}/ding.mp3`, sting: `${slug}/sting.mp3` });

// ---- args ------------------------------------------------------------------
const argv = process.argv.slice(2);
let only, skipExisting = false, dry = false;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--only") only = argv[++i];
  else if (argv[i] === "--skip-existing") skipExisting = true;
  else if (argv[i] === "--dry") dry = true;
}

// ---- narration builder (on-brand, self-contained; mirrors the house style in
//      content/gen-narration-scripts.mjs but tuned for these 5 new tiers; the
//      shared generator is NOT modified) --------------------------------------
const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
function n2w(n) {
  n = Number(n);
  if (!Number.isFinite(n)) return String(n);
  if (n < 0) return "minus " + n2w(-n);
  if (n < 20) return ONES[n];
  if (n < 100) { const t = Math.floor(n / 10), o = n % 10; return TENS[t] + (o ? "-" + ONES[o] : ""); }
  if (n < 1000) { const h = Math.floor(n / 100), r = n % 100; return ONES[h] + " hundred" + (r ? " " + n2w(r) : ""); }
  const th = Math.floor(n / 1000), r = n % 1000; return n2w(th) + " thousand" + (r ? " " + n2w(r) : "");
}
const isInt = (s) => /^-?\d+$/.test(String(s).trim());
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const capSentences = (s) => s.replace(/(^\s*[a-z])|([.?!]\s+[a-z])/g, (m) => m.toUpperCase());

const TYPE_PHRASE = {
  "LETTER SERIES": "a letter pattern",
  SYNONYM: "a word match",
  ANTONYM: "an opposites question",
  COMPARE: "a number face-off",
  LOGIC: "a logic puzzle",
  "WORD PROBLEM": "a word problem",
};
const ENERGIZERS = ["Okay", "Alright", "Here's one", "Check this out"];

// COMPARE values (fractions / decimals) spoken cleanly so the clone never says
// "one slash two". Everything else reads natively.
const FRAC = {
  "1/2": "one half", "1/3": "one third", "2/3": "two thirds", "1/4": "one quarter", "3/4": "three quarters",
  "1/5": "one fifth", "2/5": "two fifths", "3/5": "three fifths", "4/5": "four fifths",
  "1/8": "one eighth", "3/8": "three eighths", "5/8": "five eighths", "7/8": "seven eighths",
  "1/9": "one ninth", "4/9": "four ninths", "5/12": "five twelfths", "7/12": "seven twelfths",
};
const decToWords = (s) => {
  const [i, f] = String(s).split(".");
  const intPart = i === "0" || i === "" ? "zero" : n2w(Number(i));
  if (f === undefined) return intPart;
  return `${intPart} point ${f.split("").map((d) => ONES[Number(d)]).join(" ")}`;
};
const valSpeak = (s) => {
  s = String(s).trim();
  if (/^\d*\.\d+$/.test(s)) return decToWords(s);
  if (/^\d+\/\d+$/.test(s)) return FRAC[s] || s.replace("/", " over ");
  if (isInt(s)) return n2w(Number(s));
  return s.toLowerCase();
};
const optionSpeak = (q, o) => (q.tier === "COMPARE" ? valSpeak(o.text) : isInt(o.text) ? n2w(o.text) : o.text.toLowerCase());
const optionsListOr = (q) => {
  const parts = q.options.map((o) => `${o.letter}. ${cap(optionSpeak(q, o))}`);
  return parts.slice(0, -1).join(", ") + ", or " + parts[parts.length - 1] + "?";
};
const answerSpeak = (q) => (q.tier === "COMPARE" ? valSpeak(q.ansLabel) : isInt(q.ansLabel) ? n2w(q.ansLabel) : q.ansLabel.toLowerCase());

function stem(q) {
  if (q.kind === "numseries") {
    const toks = q.seq.filter((t) => t !== "?").join(", ");
    return `${toks}, and then... what comes next?`;
  }
  return capSentences(q.question.replace(/\n/g, " ").replace(/\s+/g, " ").trim().toLowerCase());
}
function qBeat(q) {
  const tp = TYPE_PHRASE[q.tier] ?? "";
  const e = ENERGIZERS[(q.id - 1) % ENERGIZERS.length];
  const opener = tp ? `${e}, ${tp}!` : `${e}!`;
  return `[excited] ${opener} ${stem(q)} ${optionsListOr(q)} Five seconds!`.replace(/\s+/g, " ").trim();
}
function rBeat(q) {
  const lead = q.id % 2 === 1 ? "The answer is..." : "It's...";
  // cap the spoken answer so a single-letter answer (letter series) is read as
  // its LETTER NAME ("R", not "er"); harmless for words/fractions/numbers.
  return `[excited] ${lead} ${q.ansLetter}, ${cap(answerSpeak(q))}! ${q.explanation}`.replace(/\s+/g, " ").trim();
}

// ---- round JSON question -> runtime Question shape (mirrors render-round.ts) --
const C = ["#839aff", "#c6fcd0", "#fd7962", "#fce552", "#63c088"]; // blue mint coral yellow green
function toRuntime(q, durs) {
  const base = {
    idx: q.id, bg: C[q.id % C.length], tier: q.tier, tierColor: "#c6fcd0", accent: "#fce552",
    countdown: q.countdown, ansLetter: q.ansLetter, ansLabel: q.ansLabel, explanation: q.explanation,
    qDur: durs[`q${q.id}`] ?? 0, rDur: durs[`r${q.id}`] ?? 0,
  };
  if (q.kind === "text") return { ...base, kind: "text", question: q.question, questionFontSize: q.questionFontSize, options: q.options };
  if (q.kind === "numseries") return { ...base, kind: "numseries", prompt: q.prompt, seq: q.seq, options: q.options };
  throw new Error(`unsupported kind ${q.kind}`);
}

// ---- expected duration (replicates the short timeline math in timeline.ts, so
//      we can strictly verify — DEFAULT variant only) --------------------------
const frames = (s) => Math.round(s * FPS);
function expectedFrames(qs, durs) {
  const lead = 0.12, trail = 0.4; // isShort (instagram)
  const timesup = durs.timesup, score = durs.score, outro = durs["outro-follow"];
  let cur = 0; // cold-open: no intro on shorts
  for (const q of qs) {
    cur += frames(lead + durs[`q${q.id}`] + trail); // read (readVO full)
    cur += Math.max(frames(q.countdown + 1), frames(q.countdown + timesup + 0.3)); // countdown + time's up
    cur += frames(lead + durs[`r${q.id}`] + trail); // reveal (reveal all)
  }
  cur += frames(lead + score + trail); // score
  cur += frames(lead + outro + trail); // outro (follow)
  return cur;
}

// ---- ffprobe helpers -------------------------------------------------------
function ffprobe(file, args) {
  let lastErr;
  for (let a = 0; a < 3; a++) {
    try { return execFileSync(FFPROBE, ["-v", "error", ...args, file], { encoding: "utf8" }).trim(); }
    catch (e) { lastErr = e; spawnSync("sleep", ["2"]); }
  }
  throw lastErr;
}
const durOf = (f) => Number(ffprobe(f, ["-show_entries", "format=duration", "-of", "default=nk=1:nw=1"]));

// ---- main ------------------------------------------------------------------
const staging = JSON.parse(readFileSync(STAGING, "utf8"));
const sampleIds = staging.sampleIds || [1, 2, 3];
mkdirSync(OUT_ROOT, { recursive: true });
const results = [];

for (const t of staging.types) {
  if (only && t.type !== only) continue;
  const slug = t.sampleSlug;
  const qs = sampleIds.map((id) => t.questions.find((q) => q.id === id)).filter(Boolean);
  if (qs.length !== sampleIds.length) throw new Error(`${t.type}: missing sample questions ${sampleIds}`);
  console.log(`\n======== ${t.type} (${t.tier}) -> ${slug} ========`);

  // 1) narration: build on-brand beats, synth with the cloned voice
  const audioDir = join(PUB_ROUNDS, slug);
  mkdirSync(audioDir, { recursive: true });
  const beats = [];
  for (const q of qs) beats.push({ beat: `q${q.id}`, text: qBeat(q) });
  for (const q of qs) beats.push({ beat: `r${q.id}`, text: rBeat(q) });
  const beatsFile = join(audioDir, "_beats.json");
  writeFileSync(beatsFile, JSON.stringify(beats, null, 2));
  for (const b of beats) console.log(`   [beat] ${b.beat}: ${b.text}`);
  if (dry) { console.log("   [dry] skipping TTS + render"); continue; }
  const tts = spawnSync("python3", [join(VIDEO, "voice", "tts_batch.py"), "--beats", beatsFile, "--voice-id", VOICE_ID, "--out-dir", audioDir, "--skip-existing"], { stdio: "inherit" });
  if (tts.status !== 0) throw new Error(`tts_batch failed for ${slug}`);
  const qrDurs = JSON.parse(readFileSync(join(audioDir, "durations.json"), "utf8"));

  // 2) durs map = committed meta beats + this round's q/r beats
  const durs = { timesup: META_DURS.timesup, score: META_DURS.score, "outro-follow": META_DURS["outro-follow"], ...qrDurs };
  const questions = qs.map((q) => toRuntime(q, durs));
  const qrBase = `audio/rounds/${slug}/`;
  const { music, sfx } = LOOK[t.type];

  // 3) props for the REAL `Short` (FullVideo) composition — DEFAULT variant, so
  //    Root's calculateMetadata computes the length from these props (no totalFrames).
  const props = {
    slug: "", // MUST override the composition's defaultProps slug ("short-1"); an
              // empty (falsy) slug makes FullVideo/Root ignore the named cut and
              // use platform/questionIds/music/sfx from these props (see render-ab.ts).
    platform: "instagram",
    questionIds: sampleIds,
    questions,
    durs,
    qrBase,
    music,
    sfx: sfxSet(sfx),
  };
  const propsFile = join(audioDir, "_props.json");
  writeFileSync(propsFile, JSON.stringify(props));

  // 4) render
  const outMp4 = join(OUT_ROOT, `${t.type}.mp4`);
  const expFrames = expectedFrames(qs, durs);
  const expSec = expFrames / FPS;
  if (skipExisting && existsSync(outMp4)) {
    console.log(`   [render] skip (exists) ${outMp4}`);
  } else {
    console.log(`   [render] Short 1080x1920 ~${expSec.toFixed(1)}s -> ${outMp4}`);
    const rr = spawnSync("npx", ["remotion", "render", "Short", outMp4, `--props=${propsFile}`, "--log=error"], { cwd: REMOTION, stdio: "inherit" });
    if (rr.status !== 0) throw new Error(`render failed: ${t.type}`);
  }

  // 5) ffprobe verify: 1080x1920, has a video stream, sane duration, A/V aligned
  const [w, h] = ffprobe(outMp4, ["-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0"]).split(",").map(Number);
  const codec = ffprobe(outMp4, ["-select_streams", "v:0", "-show_entries", "stream=codec_type", "-of", "default=nk=1:nw=1"]);
  const container = durOf(outMp4);
  const aDur = Number(ffprobe(outMp4, ["-select_streams", "a:0", "-show_entries", "stream=duration", "-of", "default=nk=1:nw=1"]) || "0");
  const problems = [];
  if (w !== 1080 || h !== 1920) problems.push(`aspect ${w}x${h} != 1080x1920`);
  if (codec !== "video") problems.push(`no video stream (codec_type=${codec})`);
  if (!(container > 15 && container < 180)) problems.push(`duration ${container.toFixed(2)}s not in sane 15..180s band`);
  if (Math.abs(container - expSec) > 0.5) problems.push(`duration ${container.toFixed(2)}s vs expected ${expSec.toFixed(2)}s`);
  if (aDur > 0 && Math.abs(aDur - container) > 0.35) problems.push(`A/V drift ${(aDur - container).toFixed(2)}s`);
  if (problems.length) throw new Error(`ffprobe verify FAILED ${t.type}: ${problems.join("; ")}`);
  console.log(`   [ok] ${w}x${h} ${container.toFixed(2)}s (audio ${aDur.toFixed(2)}s, expected ${expSec.toFixed(2)}s)`);

  // 6) transparency sidecars next to the mp4 (round + a tiny info file)
  const round = { round: 0, slug, title: `SAMPLE — ${t.title}`, grade: staging.grade, cogatLevel: staging.cogatLevel, sampleOf: t.type, questions: qs };
  writeFileSync(join(OUT_ROOT, `${t.type}.round.json`), JSON.stringify(round, null, 2) + "\n");
  const info = {
    type: t.type, title: t.title, tier: t.tier, kind: t.kind, category: t.category,
    file: `${t.type}.mp4`, format: "9:16 (1080x1920)", durationSec: Math.round(container * 100) / 100,
    music, sfx, voiceId: VOICE_ID,
    questions: qs.map((q) => ({ id: q.id, tier: q.tier, prompt: (q.kind === "text" ? q.question : q.prompt).replace(/\n/g, " / "), answer: `${q.ansLetter} · ${q.ansLabel}`, countdown: q.countdown })),
  };
  writeFileSync(join(OUT_ROOT, `${t.type}.info.json`), JSON.stringify(info, null, 2) + "\n");
  results.push({ type: t.type, file: outMp4, durationSec: info.durationSec, w, h });
}

// ---- manifest + summary ----------------------------------------------------
writeFileSync(join(OUT_ROOT, "manifest.json"), JSON.stringify({ generated: new Date().toISOString().slice(0, 10), voiceId: VOICE_ID, format: "9:16 (1080x1920)", composition: "Short (FullVideo)", variant: "default (full VO + reveal + score + follow outro)", staging: "content/staging-new-types-text.json", samples: results }, null, 2) + "\n");
console.log(`\n[done] ${results.length} sample(s) -> ${OUT_ROOT}`);
for (const r of results) console.log(`   ${r.type.padEnd(26)} ${r.w}x${r.h} ${r.durationSec}s  ${r.file}`);
