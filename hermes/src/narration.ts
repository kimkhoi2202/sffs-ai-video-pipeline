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

const FPS = 30;
/** Frames of breathing room after the VO finishes before the countdown starts. */
export const READ_TAIL = 12;

export type NarrationMode = "full" | "none" | "no-question-vo" | "no-options-vo";
export type ClipKind = "full" | "stem" | "options";

export interface NarrationClip {
  index: number; // question index (0-based)
  src: string; // staticFile path relative to remotion/public
  durSec: number; // measured VO duration
  kind: ClipKind;
}

export interface Narration {
  mode: NarrationMode;
  voiceId?: string;
  clips: NarrationClip[];
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

const isNum = (s: string) => /^-?\d+$/.test(String(s).trim());
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const speakNum = (s: string) => (isNum(s) ? n2w(s) : String(s).toLowerCase());
/** Spell any bare integers embedded in free text (e.g. "5, 10, 15"). */
const spellNums = (s: string) => String(s).replace(/\b\d+\b/g, (m) => n2w(m));

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

function resolveFfprobe(): string {
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

/**
 * Generate (idempotently) the cloned-voice VO for a video's questions under a
 * mode, writing mp3s under remotion/public/audio/hermes-vo/<id>/ (served by
 * staticFile at render) and returning each clip's measured duration. Reuses the
 * existing voice/tts_batch.py end to end (ElevenLabs + ffprobe durations).
 */
export function generateNarration(id: string, questions: RenderQ[], mode: NarrationMode, opts: { force?: boolean } = {}): Narration {
  if (mode === "none") return { mode, clips: [] };
  const beats = planBeats(questions, mode);
  if (!beats.length) return { mode, clips: [] };

  const voiceId = resolveVoiceId();
  const relDir = join("audio", "hermes-vo", id);
  const outDir = join(CONFIG.REMOTION_DIR, "public", relDir);
  if (opts.force) rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const beatsFile = join(outDir, "_beats.json");
  writeFileSync(beatsFile, JSON.stringify(beats.map((b) => ({ beat: b.beat, text: b.text })), null, 2));

  const script = join(CONFIG.REPO_DIR, "voice", "tts_batch.py");
  const args = [script, "--beats", beatsFile, "--voice-id", voiceId, "--out-dir", outDir, "--skip-existing"];
  info("narration: synth", { id, mode, voiceId, clips: beats.length });
  const res = spawnSync("python3", args, {
    encoding: "utf8",
    timeout: 6 * 60_000,
    env: { ...process.env, FFPROBE: resolveFfprobe() },
  });
  if (res.status !== 0) {
    throw new Error(`narration TTS failed for ${id} (status ${res.status}): ${(res.stderr || res.stdout || "").slice(-500)}`);
  }

  const durs = readJSON<Record<string, number>>(join(outDir, "durations.json"), {});
  const clips: NarrationClip[] = beats.map((b) => {
    const durSec = Number(durs[b.beat] ?? 0);
    if (!(durSec > 0)) throw new Error(`narration: missing/zero duration for ${id} ${b.beat}`);
    return { index: b.index, src: `${relDir}/${b.beat}.mp3`.replace(/\\/g, "/"), durSec, kind: b.kind };
  });
  info("narration: ready", { id, mode, total: clips.length, secs: clips.map((c) => Math.round(c.durSec * 10) / 10) });
  return { mode, voiceId, clips };
}

/** Frames of the read window for a clip (0 when there is no clip). MUST match
 * the identical helper in remotion/hermes/HermesQuiz.tsx. */
export function readFramesFor(clip: NarrationClip | undefined, fps = FPS): number {
  if (!clip || !(clip.durSec > 0)) return 0;
  return Math.round(clip.durSec * fps) + READ_TAIL;
}
