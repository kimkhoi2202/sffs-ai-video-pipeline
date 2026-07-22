/**
 * render-samples-matrix.mjs — ISOLATED sample renderer for the MATRIX-FAMILY new
 * nonverbal question types (Figure Matrix 2x2, Figure Analogy v2, Visual
 * Odd-One-Out). Renders ONE on-brand 9:16 sample short per type through the REAL
 * `Short` (FullVideo) composition, exactly like the A/B pipeline — but with NO
 * TTS: it synthesizes tiny SILENT placeholder read/reveal VO clips so the shared
 * timeline paces normally and Root's calculateMetadata computes the SAME length
 * on both code paths (no variant / no totalFrames needed). The committed meta VO
 * (time's up / score / outro) + real music + SFX still play, so the sample is a
 * faithful, on-brand short. Purely local: writes only to this worktree's
 * renders.nosync + the gitignored public/audio/rounds/ scratch dir.
 *
 * Usage (from remotion/):
 *   node scripts/render-samples-matrix.mjs stills   # fast PNG stills (plate + reveal) per type
 *   node scripts/render-samples-matrix.mjs          # the MP4 sample shorts (+ ffprobe verify)
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REMOTION = resolve(__dirname, "..");
const WT = resolve(REMOTION, "..");
const CONTENT = join(WT, "content");
const STAGING = join(CONTENT, "staging-new-types-matrix.json");
const NARR = join(REMOTION, "public", "audio", "narration");
const SILENT_ROOT = join(REMOTION, "public", "audio", "rounds", "samples-matrix");
const OUT_ROOT = join(WT, "renders.nosync", "new-types-samples", "matrix");
const STILL_DIR = join(OUT_ROOT, "stills");
const FFPROBE = process.env.FFPROBE || "/opt/homebrew/bin/ffprobe";
const FFMPEG = process.env.FFMPEG || "/opt/homebrew/bin/ffmpeg";
const REMOTION_BIN = join(REMOTION, "node_modules", ".bin", "remotion");

// slotColors palette (theme/brand.ts SLOT_PALETTE) — replicated so bg matches the
// on-screen frame color (the field itself is unused by QuestionFrame, which keys
// off idx, but keeping it faithful avoids surprises).
const PAL = ["#839aff", "#c6fcd0", "#fd7962", "#63c088", "#fce552"];
const bgFor = (idx) => PAL[(((idx - 1) % 5) + 5) % 5];

const QDUR = 2.0; // silent read hold (s) — question shows this long before the countdown
const RDUR = 4.5; // silent reveal hold (s) — explanation shows this long

const MUSIC = { matrix: "gameshow-fanfare.mp3", analogy2: "prize-wheel-parade.mp3", "figure-odd": "winner-spin.mp3" };
const SFX = { matrix: "short-1", analogy2: "short-2", "figure-odd": "short-3" };
const sfxSet = (slug) => ({ whoosh: `${slug}/whoosh.mp3`, ding: `${slug}/ding.mp3`, sting: `${slug}/sting.mp3` });

const ffprobeDur = (file) =>
  Number(execFileSync(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "default=nk=1:nw=1", file], { encoding: "utf8" }).trim());
const dims = (file) =>
  execFileSync(FFPROBE, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", file], { encoding: "utf8" })
    .trim()
    .split(",")
    .map(Number);
function silent(file, dur) {
  if (existsSync(file)) return;
  execFileSync(FFMPEG, ["-y", "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100", "-t", String(dur), "-c:a", "libmp3lame", "-b:a", "64k", file], { stdio: ["ignore", "ignore", "inherit"] });
}

/** authoring entry (staging JSON) -> runtime Question object (props for the comp). */
function toQuestion(kind, tier, e) {
  const ansFig = e.options.find((o) => o.letter === e.ansLetter)?.fig;
  if (!ansFig) throw new Error(`idx ${e.idx}: ansLetter ${e.ansLetter} has no matching option`);
  const base = {
    idx: e.idx,
    bg: bgFor(e.idx),
    tier,
    tierColor: "#c6fcd0",
    accent: "#fce552",
    countdown: e.countdown,
    ansLetter: e.ansLetter,
    ansLabel: e.ansLabel,
    explanation: e.explanation,
    qDur: QDUR,
    rDur: RDUR,
  };
  if (kind === "matrix") return { ...base, kind, prompt: e.prompt, cells: e.cells, options: e.options, ans: ansFig };
  if (kind === "analogy2") return { ...base, kind, prompt: e.prompt, a: e.a, b: e.b, c: e.c, options: e.options, ans: ansFig };
  if (kind === "figure-odd") return { ...base, kind, prompt: e.prompt, options: e.options, ans: ansFig };
  throw new Error(`unknown kind ${kind}`);
}

const remotion = (args) => {
  const r = spawnSync(REMOTION_BIN, args, { cwd: REMOTION, stdio: ["ignore", "inherit", "inherit"] });
  if (r.status !== 0) throw new Error(`remotion ${args[0]} failed (exit ${r.status})`);
};

function main() {
  const mode = process.argv[2] === "stills" ? "stills" : "mp4";
  const staging = JSON.parse(readFileSync(STAGING, "utf8"));
  mkdirSync(OUT_ROOT, { recursive: true });

  if (mode === "stills") {
    mkdirSync(STILL_DIR, { recursive: true });
    for (const t of staging.types) {
      // still-check EVERY authored question's plate, plus a reveal for the first.
      t.questions.forEach((e, i) => {
        const q = toQuestion(t.kind, t.tier, e);
        const pf = join(STILL_DIR, `_still-${t.kind}-${e.idx}.json`);
        writeFileSync(pf, JSON.stringify({ q, reveal: false }));
        remotion(["still", "MatrixPreview", join(STILL_DIR, `${t.kind}-${e.idx}-plate.png`), `--props=${pf}`, "--log=error"]);
        if (i === 0) {
          const rf = join(STILL_DIR, `_still-${t.kind}-${e.idx}-rev.json`);
          writeFileSync(rf, JSON.stringify({ q, reveal: true }));
          remotion(["still", "MatrixPreview", join(STILL_DIR, `${t.kind}-${e.idx}-reveal.png`), `--props=${rf}`, "--log=error"]);
        }
      });
    }
    console.log(`\n[stills] -> ${STILL_DIR}`);
    return;
  }

  const metaDur = {
    timesup: ffprobeDur(join(NARR, "timesup.mp3")),
    score: ffprobeDur(join(NARR, "score.mp3")),
    "outro-follow": ffprobeDur(join(NARR, "outro-follow.mp3")),
  };

  const results = [];
  for (const t of staging.types) {
    const kind = t.kind;
    const ids = t.sampleIds;
    const entries = ids.map((id) => t.questions.find((q) => q.idx === id));
    if (entries.some((e) => !e)) throw new Error(`${kind}: sampleIds ${JSON.stringify(ids)} not all found`);
    const questions = entries.map((e) => toQuestion(kind, t.tier, e));

    const silentDir = join(SILENT_ROOT, kind);
    mkdirSync(silentDir, { recursive: true });
    const durs = { ...metaDur };
    for (const e of entries) {
      silent(join(silentDir, `q${e.idx}.mp3`), QDUR);
      silent(join(silentDir, `r${e.idx}.mp3`), RDUR);
      durs[`q${e.idx}`] = QDUR;
      durs[`r${e.idx}`] = RDUR;
    }

    const props = {
      slug: "",
      platform: "instagram",
      questionIds: ids,
      questions,
      durs,
      qrBase: `audio/rounds/samples-matrix/${kind}/`,
      music: MUSIC[kind],
      sfx: sfxSet(SFX[kind]),
    };
    const propsFile = join(silentDir, "_props.json");
    writeFileSync(propsFile, JSON.stringify(props));

    const outMp4 = join(OUT_ROOT, `${kind}.mp4`);
    console.log(`\n[render] ${kind}  Q[${ids.join(",")}]  -> ${outMp4}`);
    remotion(["render", "Short", outMp4, `--props=${propsFile}`, "--log=error"]);

    const [w, h] = dims(outMp4);
    const dur = ffprobeDur(outMp4);
    const ok = w === 1080 && h === 1920 && dur > 0;
    console.log(`  [${ok ? "ok" : "FAIL"}] ${kind}  ${w}x${h}  ${dur.toFixed(2)}s`);
    if (!ok) throw new Error(`ffprobe verify failed ${kind}: ${w}x${h} ${dur}s`);
    results.push({ kind, tier: t.tier, out: outMp4, w, h, dur, ids });
  }

  console.log(`\n=== MATRIX-FAMILY SAMPLES (ffprobe-verified) ===`);
  for (const r of results) console.log(`${r.kind.padEnd(11)} ${r.w}x${r.h} ${r.dur.toFixed(2)}s  ${r.out}`);
}

main();
