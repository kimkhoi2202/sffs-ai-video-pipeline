/**
 * render.ts — render the self-contained HermesQuiz composition to an mp4 by
 * shelling out to the Remotion CLI (reusing remotion/ node_modules + the ensured
 * headless Chromium). Idempotent: an existing non-trivial render is reused.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG } from "./config.ts";
import { info } from "./log.ts";
import { generateNarration, READ_TAIL, type NarrationMode } from "./narration.ts";

const FPS = 30;
const INTRO = 60;
const OUTRO = 75;
const REVEAL = 45;
const HOLD = 18;

function willReveal(reveal: string, i: number, n: number): boolean {
  if (reveal === "all") return true;
  if (reveal === "none") return false;
  return i === n - 1 ? false : true; // "last" = cliffhanger
}

/** Frames of the spoken read window for question i (0 when there is no VO clip).
 *  MUST match remotion/hermes/HermesQuiz.tsx readFrames exactly. */
function readFrames(props: any, i: number): number {
  const clip = (props?.narration?.clips ?? []).find((c: any) => c && c.index === i);
  const dur = clip && Number(clip.durSec) > 0 ? Number(clip.durSec) : 0;
  return dur > 0 ? Math.round(dur * FPS) + READ_TAIL : 0;
}

/** MUST match remotion/hermes/HermesQuiz.tsx computeDuration exactly (now
 *  narration-aware: each question's read window precedes its countdown). */
export function computeFrames(props: any): number {
  const qs = props.questions ?? [];
  const n = Math.max(1, qs.length);
  const cd = Math.round(Number(props.countdownSec ?? 5) * FPS);
  let sum = INTRO + OUTRO;
  for (let i = 0; i < n; i++) sum += readFrames(props, i) + cd + (willReveal(props.reveal ?? "all", i, n) ? REVEAL : HOLD);
  return sum;
}

export interface RenderResult {
  path: string;
  frames: number;
  reused: boolean;
}

export function renderVideo(id: string, props: any, opts: { force?: boolean } = {}): RenderResult {
  mkdirSync(CONFIG.RENDERS_DIR, { recursive: true });
  const out = join(CONFIG.RENDERS_DIR, `${id}.mp4`);
  const propsFile = join(CONFIG.RENDERS_DIR, `${id}.props.json`);

  // Narration (cloned-voice question/options VO). Generate/reuse BEFORE computing
  // frames (read windows change the duration) AND before the reuse check (so the
  // caller's later computeFrames(v.props) sees the injected clips). Idempotent:
  // tts_batch.py --skip-existing => zero API calls when the clips already exist.
  const mode: NarrationMode = props?.narration?.mode ?? "none";
  if (mode !== "none") {
    const narr = generateNarration(id, props.questions ?? [], mode, { force: opts.force });
    props.narration = { ...(props.narration ?? {}), mode, voiceId: narr.voiceId, clips: narr.clips };
  }

  const frames = computeFrames(props);
  writeFileSync(propsFile, JSON.stringify(props));

  if (!opts.force && existsSync(out) && statSync(out).size > 100_000) {
    info("render reused", { id, out });
    return { path: out, frames, reused: true };
  }

  const args = [
    "remotion",
    "render",
    "hermes/entry.tsx",
    "HermesQuiz",
    out,
    `--props=${propsFile}`,
    "--log=error",
    "--concurrency=2",
  ];
  info("rendering", { id, frames });
  const res = spawnSync("npx", args, {
    cwd: CONFIG.REMOTION_DIR,
    encoding: "utf8",
    timeout: 8 * 60_000,
    env: { ...process.env },
  });
  if (res.status !== 0) {
    throw new Error(`remotion render failed for ${id} (status ${res.status}): ${(res.stderr || res.stdout || "").slice(-800)}`);
  }
  if (!existsSync(out) || statSync(out).size < 50_000) {
    throw new Error(`remotion render produced no/tiny file for ${id}`);
  }
  info("rendered", { id, out, bytes: statSync(out).size });
  return { path: out, frames, reused: false };
}
