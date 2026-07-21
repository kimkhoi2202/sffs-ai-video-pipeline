/**
 * Rhubarb cue generation — the reusable core shared by the `lipsync.ts` CLI and
 * the `render-mascot.ts` batch. Turns ONE mp3 into viseme timings (A–H + X).
 *
 * The pipeline is: mp3 -> mono 16 kHz WAV (ffmpeg) -> Rhubarb `-f json` with the
 * full extended shape set. Callers pass the EXACT played/muxed mp3 (the copy
 * under public/) so the visemes line up with what's heard.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export type RhubarbCue = { start: number; end: number; value: string };
export type RhubarbResult = { mouthCues: RhubarbCue[]; duration: number };

/** Resolve the Rhubarb binary: $RHUBARB, then a video/tools/rhubarb symlink,
 *  then any extracted video/tools/Rhubarb-Lip-Sync-* release dir, then PATH. */
export function findRhubarb(toolsDir: string): string {
  const candidates: string[] = [];
  if (process.env.RHUBARB) candidates.push(process.env.RHUBARB);
  candidates.push(join(toolsDir, "rhubarb"));
  if (existsSync(toolsDir)) {
    for (const d of readdirSync(toolsDir)) {
      if (d.startsWith("Rhubarb-Lip-Sync")) candidates.push(join(toolsDir, d, "rhubarb"));
    }
  }
  candidates.push("rhubarb");
  for (const c of candidates) {
    try {
      execFileSync(c, ["--version"], { stdio: "ignore" });
      return c;
    } catch {
      /* try next */
    }
  }
  throw new Error(
    "Rhubarb binary not found. Download the macOS release from " +
      "https://github.com/DanielSWolf/rhubarb-lip-sync/releases into video/tools/, or set $RHUBARB.",
  );
}

const rand = () => Math.random().toString(36).slice(2);

/**
 * Generate viseme cues for one mp3. Optionally pass the exact `dialog` transcript
 * to run Rhubarb's guided PocketSphinx pass (tighter word boundaries). Quiet by
 * default; throws if ffmpeg/Rhubarb fail (non-zero exit).
 */
export function generateCues(rhubarb: string, mp3Abs: string, opts: { dialog?: string } = {}): RhubarbResult {
  const stamp = `${Date.now()}-${rand()}`;
  const tmpWav = join(tmpdir(), `lipsync-${stamp}.wav`);
  const outJson = join(tmpdir(), `lipsync-${stamp}.json`);
  const tmpDialog = opts.dialog ? join(tmpdir(), `lipsync-${stamp}.txt`) : undefined;
  execFileSync("ffmpeg", ["-y", "-i", mp3Abs, "-ac", "1", "-ar", "16000", tmpWav], { stdio: "ignore" });
  const args = ["-f", "json", "--extendedShapes", "GHX", "-o", outJson];
  if (tmpDialog && opts.dialog) {
    writeFileSync(tmpDialog, opts.dialog, "utf8");
    args.push("--dialogFile", tmpDialog);
  }
  args.push(tmpWav);
  try {
    execFileSync(rhubarb, args, { stdio: "ignore" });
    const parsed = JSON.parse(readFileSync(outJson, "utf8")) as {
      mouthCues: RhubarbCue[];
      metadata?: { duration?: number };
    };
    const cues = parsed.mouthCues ?? [];
    const duration = parsed.metadata?.duration ?? (cues.length ? cues[cues.length - 1].end : 0);
    return { mouthCues: cues, duration };
  } finally {
    rmSync(tmpWav, { force: true });
    rmSync(outJson, { force: true });
    if (tmpDialog) rmSync(tmpDialog, { force: true });
  }
}
