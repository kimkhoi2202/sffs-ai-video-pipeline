#!/usr/bin/env node
/**
 * render.ts (bridge) — the Node entry the `sffs` plugin shells into to RENDER a
 * quiz short to an mp4. It wraps ONLY hermes/src/render.ts:
 *
 *   - `render`          -> renderVideo(id, props, {force}) : synthesize the
 *                          cloned-voice narration for the requested arm (via
 *                          narration.ts -> voice/tts_batch.py; "none" = music-only),
 *                          write the props file, and render the self-contained
 *                          HermesQuiz composition to <RENDERS_DIR>/<id>.mp4 with the
 *                          Remotion CLI (reusing remotion/ node_modules + the ensured
 *                          headless Chromium). Idempotent: an existing non-trivial
 *                          render is reused unless force=true.
 *   - `render --dry-run` -> computeFrames(props) ONLY : the video's frame count for
 *                          the given props WITHOUT rendering, WITHOUT synthesizing
 *                          narration, and WITHOUT any network/Chromium/ffmpeg. A
 *                          cheap way to preview the composition's duration.
 *
 * render.ts imports ONLY config / log / narration (which shells to python3
 * voice/tts_batch.py for VO). It has NO Publer/create/schedule/publish/delete/
 * update import anywhere in its dependency tree, so this bridge is physically
 * unable to create, publish, schedule, or mutate any post — it only produces a
 * local mp4 file (DRAFT media). Uploading + drafting are separate, later steps.
 *
 * USAGE (stdin = a JSON object of params):
 *   node render.ts render            {id, props, force?}  -> { ok, id, path, frames, reused, bytes }
 *   node render.ts render --dry-run  {id?, props}         -> { ok, dry_run, frames, mode, ... }
 *
 * A LIVE narrated render (props.narration.mode != "none") needs ELEVENLABS_API_KEY
 * (read by voice/tts_batch.py from env / voice/.env). A music-only render
 * (mode="none") needs no key. Renders need remotion/ node_modules + a headless
 * Chromium (npx remotion browser ensure) + ffmpeg. The output dir is CONFIG.RENDERS_DIR
 * (HERMES_DATA_DIR/renders); set HERMES_DATA_DIR to control where mp4s land.
 *
 * EXIT CODES: 0 ok · 1 runtime error · 2 bad stdin JSON · 3 bad usage.
 * Diagnostics -> stderr; the machine-readable result -> one JSON line on stdout.
 */
import { existsSync, statSync } from "node:fs";
import { renderVideo, computeFrames } from "../../hermes/src/render.ts";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** A minimal shape check so a bad payload fails as bad-usage (exit 3), not a
 *  mid-render crash. The Python belt does the strict validation; this is a
 *  defensive backstop for direct bridge invocations. */
function validProps(props: unknown): props is Record<string, unknown> {
  if (!props || typeof props !== "object" || Array.isArray(props)) return false;
  const qs = (props as Record<string, unknown>).questions;
  return Array.isArray(qs) && qs.length > 0;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run") || process.env.HERMES_RENDER_DRY_RUN === "1";
  const sub = argv.find((a) => !a.startsWith("-"));

  if (sub !== "render") {
    console.error("render: usage: render.ts render [--dry-run]  (stdin = {id, props, force?})");
    process.exit(3);
    return;
  }

  const raw = (await readStdin()).trim();
  let params: Record<string, unknown> = {};
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        params = parsed as Record<string, unknown>;
      } else {
        console.error("render: stdin must be a JSON object of params");
        process.exit(2);
        return;
      }
    } catch (e) {
      console.error(`render: invalid JSON on stdin: ${(e as Error).message}`);
      process.exit(2);
      return;
    }
  }

  const props = params.props;
  if (!validProps(props)) {
    console.error("render: 'props' must be an object with a non-empty 'questions' array");
    process.exit(3);
    return;
  }
  const mode = String(((props as any).narration && (props as any).narration.mode) || "none");

  // ── dry-run: frame count only (no narration synth, no Chromium, no ffmpeg) ──
  if (dryRun) {
    const frames = computeFrames(props);
    console.log(
      JSON.stringify({
        ok: true,
        dry_run: true,
        sub,
        frames,
        mode,
        questions: (props as any).questions.length,
        note: "render dry-run computed frames only — no narration synth, no Chromium, no ffmpeg, no network",
      }),
    );
    return;
  }

  // ── full render ─────────────────────────────────────────────────────────
  const id =
    typeof params.id === "string" && params.id.trim()
      ? params.id.trim()
      : `sffs-render-${new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14)}`;
  const force = params.force === true;

  // renderVideo synthesizes VO (for mode != "none"), computes frames, writes the
  // props file, and renders to CONFIG.RENDERS_DIR/<id>.mp4. It throws on failure.
  const result = renderVideo(id, props, { force });
  const bytes = existsSync(result.path) ? statSync(result.path).size : 0;
  console.log(
    JSON.stringify({
      ok: true,
      sub,
      id,
      path: result.path,
      frames: result.frames,
      reused: result.reused,
      bytes,
      mode,
    }),
  );
}

main().catch((e) => {
  console.error(`render: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
