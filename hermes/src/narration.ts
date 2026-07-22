/**
 * narration.ts — cloned-voice question/options VO for the Hermes loop's render path.
 *
 * REUSE, don't rewrite: the actual ElevenLabs generation is the EXISTING
 * voice/tts_batch.py (the cloned "Booming Ringmaster" host, voice_id
 * lZcmpVLaoXF4v0uz4l6Q — the same voice + engine the production render-ab.ts uses).
 * This module only (a) turns Hermes' headless question shape into spoken beat
 * scripts (mirroring content/gen-narration-scripts.mjs wording, and reusing its
 * n2w number-speller) and (b) shells out to tts_batch.py, then reports each clip's
 * measured duration so the composition can size each question's read window.
 *
 * The four toggle modes ARE the "don't narrate" A/B family:
 *   full           -> one clip/question: opener + stem + "A.. B.. or D..? Five seconds!"
 *   no-options-vo  -> stem only (drop the options read; the options still DISPLAY)
 *   no-question-vo -> options only (drop the stem read; the question still DISPLAYS)
 *   none           -> no VO at all (music-only; the loop's current behavior)
 *
 * SECURITY: the ElevenLabs key never touches this file — tts_batch.py reads it
 * from ELEVENLABS_API_KEY (systemd EnvironmentFile on the box) or the gitignored
 * voice/.env. We only forward FFPROBE so duration measurement works off-macOS.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG } from "./config.ts";
import { readJSON } from "./state.ts";
import { info } from "./log.ts";
// Reuse the pipeline's canonical number-speller so "20" reads "twenty" everywhere.
import { n2w } from "../../content/gen-narration-scripts.mjs";

export type NarrationMode = "full" | "none" | "no-question-vo" | "no-options-vo";
export type ClipKind = "full" | "stem" | "options";

export interface NarrationClip {
  index: number; // question index (0-based)
  src: string; // staticFile path relative to remotion/public
  durSec: number; // measured VO duration
  kind: ClipKind;
}

/** A question as it appears in HermesQuiz render props. */
interface RenderQ {
  kind: "text" | "numseries";
  tier: string;
  prompt: string;
  options?: string[];
  seq?: string[];
  answer: string;
}

/** Integer test + number-spellers shared with render.ts (one copy; imported there). */
export const isNum = (s: string) => /^-?\d+$/.test(String(s).trim());
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const speakNum = (s: string) => (isNum(s) ? n2w(s) : String(s).toLowerCase());
/** Spell any bare integers embedded in free text (e.g. "5, 10, 15"). */
export const spellNums = (s: string) => String(s).replace(/\b\d+\b/g, (m) => n2w(m));

// Short, position-neutral openers (no "next/first/last") — same spirit as the
// production ENERGIZERS, so a clip reads fine regardless of its slot.
const ENERGIZERS = ["Okay", "Alright", "Here's one", "Check this out"];
const TYPE_PHRASE: Record<string, string> = {
  "ODD ONE OUT": "",
  "VERBAL ANALOGY": "a word analogy",
  "NUMBER ANALOGY": "a number analogy",
  "NUMBER SERIES": "a number series",
  "SENTENCE COMPLETION": "fill in the blank",
};

const LETTERS = ["A", "B", "C", "D"];

/** The spoken question stem (no options), for a Hermes render question. */
function stemText(q: RenderQ, idx: number): string {
  const tier = (q.tier || "").toUpperCase();
  const opener = ENERGIZERS[idx % ENERGIZERS.length];
  const tp = TYPE_PHRASE[tier] ?? "";
  const lead = tp ? `${opener}, ${tp}!` : `${opener}!`;

  if (q.kind === "numseries") {
    const nums = (q.seq ?? []).filter((t) => t !== "?").map((t) => n2w(t)).join(", ");
    return `[excited] ${lead} ${cap(nums)}, and then... what comes next?`.replace(/\s+/g, " ").trim();
  }
  // text: read the on-screen prompt, spelling numbers and voicing blanks.
  const prompt = spellNums(String(q.prompt || "").replace(/_+/g, " what ").replace(/\s+/g, " ").trim());
  return `[excited] ${lead} ${cap(prompt)}${/[.?!]$/.test(prompt) ? "" : "?"}`.replace(/\s+/g, " ").trim();
}

/** The spoken options list ("A, x... B, y... or D, z? Five seconds!"). */
function optionsText(q: RenderQ): string {
  const opts = (q.options ?? []).slice(0, 4);
  if (!opts.length) return ""; // numseries etc. have no on-screen options
  const parts = opts.map((o, i) => `${LETTERS[i]}, ${speakNum(o)}`);
  const list = parts.length > 1 ? parts.slice(0, -1).join("... ") + ", or " + parts[parts.length - 1] : parts[0];
  return `[excited] ${list}? Five seconds!`.replace(/\s+/g, " ").trim();
}

/** Full read = stem + options in one clip. */
function fullText(q: RenderQ, idx: number): string {
  const stem = stemText(q, idx).replace(/^\[excited\]\s*/, "");
  const opts = optionsText(q).replace(/^\[excited\]\s*/, "");
  const joined = opts ? `${stem} ${opts}` : `${stem} Five seconds!`;
  return `[excited] ${joined}`.replace(/\s+/g, " ").trim();
}

/**
 * The (beat, text, kind) each question voices under a mode. Every non-"none" mode
 * yields exactly ONE clip per question. For questions without on-screen options
 * (numseries), "no-question-vo" gracefully falls back to the stem so we never
 * synthesize an empty clip.
 */
export function planBeats(questions: RenderQ[], mode: NarrationMode): Array<{ index: number; beat: string; text: string; kind: ClipKind }> {
  if (mode === "none") return [];
  const out: Array<{ index: number; beat: string; text: string; kind: ClipKind }> = [];
  questions.forEach((q, idx) => {
    let text = "";
    let kind: ClipKind = "full";
    if (mode === "full") {
      text = fullText(q, idx);
      kind = "full";
    } else if (mode === "no-options-vo") {
      text = stemText(q, idx);
      kind = "stem";
    } else if (mode === "no-question-vo") {
      const opts = optionsText(q);
      if (opts) {
        text = opts;
        kind = "options";
      } else {
        text = stemText(q, idx); // graceful fallback (no options to read)
        kind = "stem";
      }
    }
    out.push({ index: idx, beat: `q${idx}`, text, kind });
  });
  return out;
}

/** ffprobe resolver shared with render.ts (one copy; imported there). */
export function resolveFfprobe(): string {
  if (process.env.FFPROBE) return process.env.FFPROBE;
  for (const c of ["/usr/local/bin/ffprobe", "/usr/bin/ffprobe", "/opt/homebrew/bin/ffprobe"]) {
    if (existsSync(c)) return c;
  }
  return "ffprobe";
}

function resolveVoiceId(): string {
  if (process.env.HERMES_VOICE_ID) return process.env.HERMES_VOICE_ID.trim();
  const idx = readJSON<{ voice_id?: string }>(join(CONFIG.REPO_DIR, "voice", "narration", "narration_index.json"), {});
  return (idx.voice_id || "lZcmpVLaoXF4v0uz4l6Q").trim(); // cloned "Booming Ringmaster"
}

// ---------------------------------------------------------------------------
// FULL-VIDEO VO (read + reveal) — for the Short/FullVideo render path.
//
// The production Short/FullVideo timeline (remotion/src/full/timeline.ts) reads
// per-question VO by NAME from a per-video dir: the READ clip `q<idx>.mp3` (whose
// AUDIO is the mode-appropriate stem/options/full text — the readVO="full" branch
// just plays whatever that clip contains, which is why the four narration modes
// need no separate qo/qs files) and, for every REVEALING question, a `r<idx>.mp3`
// reveal clip. The meta beats (timesup/score/outro-*) are round-agnostic and
// served from the committed audio/narration/ dir. This synthesizes both the read
// and reveal clips for a video in ONE tts_batch.py call and returns each clip's
// MEASURED duration so render.ts can build the timeline `durs` map.
// ---------------------------------------------------------------------------

/** A reveal beat to voice: r<index> with its spoken text (built by render.ts). */
export interface RevealBeatInput {
  index: number; // 0-based question index (matches the read clip index)
  text: string; // spoken reveal line ("The answer is ...")
}

export interface VOResult {
  voiceId: string;
  /** staticFile base for this video's clips (append "<beat>.mp3"), e.g.
   *  "audio/hermes-vo/<id>/". */
  qrBase: string;
  /** measured seconds per beat: q<idx> (read, when narrated) + r<idx> (reveal). */
  durs: Record<string, number>;
  /** the read clips (for annotation/debug); empty for mode "none". */
  readClips: NarrationClip[];
}

/** Run tts_batch.py for a set of beats into outDir; returns durations.json. */
function runTts(outDir: string, beats: Array<{ beat: string; text: string }>, voiceId: string, id: string): Record<string, number> {
  mkdirSync(outDir, { recursive: true });
  const beatsFile = join(outDir, "_beats.json");
  writeFileSync(beatsFile, JSON.stringify(beats, null, 2));
  const script = join(CONFIG.REPO_DIR, "voice", "tts_batch.py");
  const args = [script, "--beats", beatsFile, "--voice-id", voiceId, "--out-dir", outDir, "--skip-existing"];
  const res = spawnSync("python3", args, {
    encoding: "utf8",
    timeout: 6 * 60_000,
    env: { ...process.env, FFPROBE: resolveFfprobe() },
  });
  if (res.status !== 0) {
    throw new Error(`narration TTS failed for ${id} (status ${res.status}): ${(res.stderr || res.stdout || "").slice(-500)}`);
  }
  return readJSON<Record<string, number>>(join(outDir, "durations.json"), {});
}

/**
 * Synthesize (idempotently) the cloned-voice READ + REVEAL VO the Short/FullVideo
 * timeline needs for one video, under remotion/public/audio/hermes-vo/<id>/.
 *   - READ  : one `q<idx>.mp3` per question (mode-appropriate text), unless mode="none".
 *   - REVEAL: one `r<idx>.mp3` per revealing question (caller supplies the text).
 * Returns the qrBase + the MEASURED per-beat durations (q<idx>/r<idx>). Reuses the
 * existing voice/tts_batch.py end to end (ElevenLabs + ffprobe). Idempotent
 * (--skip-existing), so a second platform render of the same id makes zero API calls.
 */
export function generateVO(
  id: string,
  questions: RenderQ[],
  mode: NarrationMode,
  reveals: RevealBeatInput[],
  opts: { force?: boolean } = {},
): VOResult {
  const voiceId = resolveVoiceId();
  const relDir = join("audio", "hermes-vo", id);
  const qrBase = `${relDir.replace(/\\/g, "/")}/`;
  const outDir = join(CONFIG.REMOTION_DIR, "public", relDir);
  if (opts.force) rmSync(outDir, { recursive: true, force: true });

  const readBeats = planBeats(questions, mode); // [] when mode==="none"
  const revealBeats = reveals.map((r) => ({ index: r.index, beat: `r${r.index}`, text: r.text }));
  const allBeats = [
    ...readBeats.map((b) => ({ beat: b.beat, text: b.text })),
    ...revealBeats.map((b) => ({ beat: b.beat, text: b.text })),
  ];
  if (!allBeats.length) {
    info("narration: no VO beats (music-only, no reveals)", { id, mode });
    return { voiceId, qrBase, durs: {}, readClips: [] };
  }

  info("narration: synth read+reveal", { id, mode, read: readBeats.length, reveal: revealBeats.length, voiceId });
  const durs = runTts(outDir, allBeats, voiceId, id);

  // Validate every beat got a positive measured duration.
  for (const b of allBeats) {
    if (!(Number(durs[b.beat]) > 0)) throw new Error(`narration: missing/zero duration for ${id} ${b.beat}`);
  }

  const readClips: NarrationClip[] = readBeats.map((b) => ({
    index: b.index,
    src: `${qrBase}${b.beat}.mp3`,
    durSec: Number(durs[b.beat]),
    kind: b.kind,
  }));
  info("narration: VO ready", { id, mode, read: readClips.length, reveal: revealBeats.length });
  return { voiceId, qrBase, durs, readClips };
}
