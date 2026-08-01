/**
 * calibrate-hooks.ts — measure every hook line's REAL spoken length and record it.
 *
 * The spoken hook rides over the 2.2s motion opening, so a line that overruns would
 * bleed into the question read: it would talk over the question VO and put back the
 * serial delay this whole design removes. Whether a line fits cannot be estimated from
 * word count with any confidence — the host adds roughly half a second of air at every
 * sentence boundary, so a four-word two-sentence line ("Warning. Question three bites.")
 * measured LONGER than a six-word one-sentence line. It has to be measured.
 *
 * So each line is synthesized once with the production voice and its duration is written
 * back into ab-testing/hook-bank.json as `vo_sec`. hooks.ts then refuses, at selection
 * time, any line that does not fit, which makes "question one never moves" a property of
 * the system rather than a hope. Re-run after editing any `vo`.
 *
 *   node tools/calibrate-hooks.ts            # measure the lines missing a vo_sec
 *   node tools/calibrate-hooks.ts --all      # re-measure everything
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CONFIG } from "../hermes/src/config.ts";
import { speakHook } from "../hermes/src/narration.ts";
import { HOOK_SELECT_MAX_SEC, HOOK_BUDGET_SEC } from "../hermes/src/hooks.ts";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

const BANK = CONFIG.HOOK_BANK;
const bank = JSON.parse(readFileSync(BANK, "utf8"));
const all = process.argv.includes("--all");

// {WRONG} is filled with a real letter before synthesis so the measurement reflects
// what actually ships rather than a placeholder.
const speakable = (vo: string) => speakHook(vo.split("{WRONG}").join("B"));

const todo = (bank.openings as any[]).filter((o) => all || typeof o.vo_sec !== "number");
if (!todo.length) {
  console.log("nothing to calibrate (every opening already has vo_sec; --all to redo)");
  process.exit(0);
}

const outDir = join(CONFIG.REMOTION_DIR, "public", "audio", "hook-calibration");
mkdirSync(outDir, { recursive: true });
// The clip is keyed on a hash of the TEXT, not on the line id. Keying on the id let
// --skip-existing hand back the previous recording after a line was rewritten, which
// silently reported the OLD duration for the NEW words. Content-addressing makes an
// edited line always a cache miss and an unedited one always a cache hit.
const beatFor = (o: any) => `${o.id}-${createHash("sha1").update(speakable(o.vo)).digest("hex").slice(0, 8)}`;
const beats = todo.map((o) => ({ beat: beatFor(o), text: `[excited] ${speakable(o.vo)}` }));
writeFileSync(join(outDir, "_beats.json"), JSON.stringify(beats, null, 2));

const voiceId = process.env.HERMES_VOICE_ID
  || JSON.parse(readFileSync(join(CONFIG.REPO_DIR, "voice", "narration", "narration_index.json"), "utf8")).voice_id
  || "lZcmpVLaoXF4v0uz4l6Q";

console.log(`synthesizing ${beats.length} lines with voice ${voiceId} ...`);
execFileSync("python3", [
  join(CONFIG.REPO_DIR, "voice", "tts_batch.py"),
  "--beats", join(outDir, "_beats.json"),
  "--voice-id", voiceId,
  "--out-dir", outDir,
  ...(all ? [] : ["--skip-existing"]),
], { stdio: "inherit", env: { ...process.env, FFPROBE: process.env.FFPROBE || "/opt/homebrew/bin/ffprobe" } });

const durs = JSON.parse(readFileSync(join(outDir, "durations.json"), "utf8")) as Record<string, number>;
let fits = 0;
for (const o of todo) {
  const d = Number(durs[beatFor(o)]);
  if (!(d > 0)) throw new Error(`no measured duration for ${o.id}`);
  o.vo_sec = Math.round(d * 100) / 100;
  if (o.vo_sec <= HOOK_SELECT_MAX_SEC) fits++;
}
writeFileSync(BANK, JSON.stringify(bank, null, 2) + "\n");

const rows = (bank.openings as any[]).map((o) => ({ id: o.id, mech: o.mechanism, sec: o.vo_sec, ok: o.vo_sec <= HOOK_SELECT_MAX_SEC, vo: o.vo }));
rows.sort((a, b) => b.sec - a.sec);
console.log(`\nhard budget ${HOOK_BUDGET_SEC.toFixed(2)}s (2.2s animation minus the 0.12s lead); offered only at <= ${HOOK_SELECT_MAX_SEC.toFixed(2)}s after TTS margin\n`);
for (const r of rows) console.log(`${r.ok ? "fits" : "OVER"}  ${String(r.sec).padStart(5)}s  ${r.id.padEnd(20)} ${JSON.stringify(r.vo)}`);
const over = rows.filter((r) => !r.ok);
console.log(`\n${rows.length - over.length}/${rows.length} lines fit; ${over.length} over budget`);
if (over.length) console.log("over-budget lines are refused at selection and must be shortened:", over.map((r) => r.id).join(", "));
