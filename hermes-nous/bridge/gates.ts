#!/usr/bin/env node
/**
 * gates.ts (bridge) — the Node entry the `sffs` plugin shells into to run the
 * HARD QUALITY GATES. It wraps ONLY hermes/src/gates.ts:
 *
 *   - `dedup`    -> gateDedup(questions, claimed)   : never-repeat check against the
 *                  used ledger + the in-batch claims + internal dups. Deterministic;
 *                  reads the used-sigs ledgers (file reads) — no network.
 *   - `validity` -> validateQuestions(questions)    : LLM rubric (cached by hash) —
 *                  exactly one unambiguous correct answer, factual, grade-appropriate,
 *                  plausible distractors. Fails CLOSED for any question with no verdict.
 *   - `copy`     -> gateCopy(pieces)                : brand-voice + kid-safe. Runs the
 *                  deterministic hard rules FIRST (no tokens) then an LLM judge; if the
 *                  judge is unreachable it falls back to the deterministic pass.
 *   - `render`   -> gateRenderSanity(path, frames)  : ffprobe — 1080x1920, video+audio
 *                  streams present, duration ~ expected. Never throws (bad path/ffprobe
 *                  come back as pass:false).
 *
 * gates.ts has NO create/schedule/publish/delete import anywhere (it wraps
 * llm / brand / questions / state / config / log + node ffprobe only), so this
 * bridge is physically unable to create, publish, schedule, or mutate any post.
 * It is fail-closed by construction: every gate is a pass/fail verdict, and the
 * agent must treat pass=false as "do not draft".
 *
 * USAGE (all take a JSON object of params on stdin except where noted):
 *   node gates.ts dedup      {questions:[{sig,...}], claimed?:[sig]}   -> GateResult
 *   node gates.ts validity   {questions:[{sig,hash,...}]}             -> {results,gate}
 *   node gates.ts copy       {pieces:[{label,text}]}                  -> GateResult
 *   node gates.ts render     {path, expected_frames, fps?}            -> GateResult
 *   add --dry-run to any for a NETWORK-FREE run that echoes the request.
 *
 * LIVE `validity` / `copy` need the TrueFoundry key (OPENAI_API_KEY / TFY_API_KEY);
 * `dedup` / `render` need no key. No scheduler keys are ever needed.
 *
 * EXIT CODES: 0 ok · 1 runtime error · 2 bad stdin JSON · 3 bad usage.
 * Diagnostics -> stderr; the machine-readable result -> one JSON line on stdout.
 */
import {
  gateDedup,
  validateQuestions,
  gateCopy,
  gateRenderSanity,
  type GateResult,
} from "../../hermes/src/gates.ts";
import type { HermesQ } from "../../hermes/src/state.ts";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run") || process.env.HERMES_GATES_DRY_RUN === "1";
  const sub = argv.find((a) => !a.startsWith("-"));

  if (sub !== "dedup" && sub !== "validity" && sub !== "copy" && sub !== "render") {
    console.error("gates: usage: gates.ts <dedup|validity|copy|render> [--dry-run]");
    process.exit(3);
    return;
  }

  // All four subcommands take a params object on stdin.
  const raw = (await readStdin()).trim();
  let params: Record<string, unknown> = {};
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        params = parsed as Record<string, unknown>;
      } else {
        console.error("gates: stdin must be a JSON object of params");
        process.exit(2);
        return;
      }
    } catch (e) {
      console.error(`gates: invalid JSON on stdin: ${(e as Error).message}`);
      process.exit(2);
      return;
    }
  }

  // ── dedup ─────────────────────────────────────────────────────────────
  if (sub === "dedup") {
    const questions = asArray(params.questions) as HermesQ[];
    if (questions.length === 0) {
      console.error("gates: dedup requires a non-empty 'questions' array");
      process.exit(3);
      return;
    }
    const claimed = new Set((asArray(params.claimed) as unknown[]).map((s) => String(s)));
    if (dryRun) {
      console.log(JSON.stringify({ ok: true, dry_run: true, sub, request: { questions: questions.length, claimed: claimed.size }, note: "gates dry-run made no network call" }));
      return;
    }
    const gate: GateResult = gateDedup(questions, claimed); // reads used ledgers (no network)
    console.log(JSON.stringify({ ok: true, sub, gate }));
    return;
  }

  // ── validity ──────────────────────────────────────────────────────────
  if (sub === "validity") {
    const questions = asArray(params.questions) as HermesQ[];
    if (questions.length === 0) {
      console.error("gates: validity requires a non-empty 'questions' array");
      process.exit(3);
      return;
    }
    if (dryRun) {
      console.log(JSON.stringify({ ok: true, dry_run: true, sub, request: { questions: questions.length }, note: "gates dry-run made no network call" }));
      return;
    }
    const { results, gate } = await validateQuestions(questions); // LLM rubric (cached)
    console.log(JSON.stringify({ ok: true, sub, gate, results }));
    return;
  }

  // ── copy ──────────────────────────────────────────────────────────────
  if (sub === "copy") {
    const rawPieces = asArray(params.pieces) as Array<{ label?: unknown; text?: unknown }>;
    const pieces = rawPieces
      .filter((p) => p && typeof p === "object")
      .map((p) => ({ label: String(p.label ?? ""), text: String(p.text ?? "") }));
    if (pieces.length === 0) {
      console.error("gates: copy requires a non-empty 'pieces' array of {label,text}");
      process.exit(3);
      return;
    }
    if (dryRun) {
      console.log(JSON.stringify({ ok: true, dry_run: true, sub, request: { pieces: pieces.length }, note: "gates dry-run made no network call" }));
      return;
    }
    const gate: GateResult = await gateCopy(pieces); // rules first, then LLM judge (falls back to pass)
    console.log(JSON.stringify({ ok: true, sub, gate }));
    return;
  }

  // ── render ──────────────────────────────────────────────────────────────
  // sub === "render"
  const path = typeof params.path === "string" ? params.path.trim() : "";
  const expectedFrames =
    typeof params.expected_frames === "number" && Number.isInteger(params.expected_frames) && params.expected_frames > 0
      ? params.expected_frames
      : 0;
  const fps =
    typeof params.fps === "number" && Number.isInteger(params.fps) && params.fps > 0 ? params.fps : 30;
  if (!path || !expectedFrames) {
    console.error("gates: render requires 'path' (string) and 'expected_frames' (positive integer)");
    process.exit(3);
    return;
  }
  if (dryRun) {
    console.log(JSON.stringify({ ok: true, dry_run: true, sub, request: { path, expected_frames: expectedFrames, fps }, note: "gates dry-run made no network call" }));
    return;
  }
  const gate: GateResult = gateRenderSanity(path, expectedFrames, fps); // ffprobe (local; never throws)
  console.log(JSON.stringify({ ok: true, sub, gate }));
}

main().catch((e) => {
  console.error(`gates: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
