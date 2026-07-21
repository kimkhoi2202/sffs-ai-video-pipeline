/**
 * Rhubarb Lip Sync helper (CLI) — turns an existing ElevenLabs narration clip
 * into per-mouth-shape viseme timings for the talking brain-mascot narrator.
 * Thin wrapper over scripts/lipsync-core.ts (the batch render reuses that core).
 *
 * Usage:
 *   npx tsx scripts/lipsync.ts <key> [--dialog "spoken text"] [--mp3 <path>]
 *   e.g.  npx tsx scripts/lipsync.ts intro
 *
 * CRITICAL for sync: analyse the EXACT file the composition muxes, i.e. the copy
 * Remotion serves via staticFile("audio/narration/<key>.mp3") from public/. The
 * voice/narration/ copy can be an OLDER/other take (different length + pauses),
 * which would make the visemes drift against the played audio — so public/ wins.
 * Passing --dialog (the exact transcript) enables Rhubarb's guided pass.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findRhubarb, generateCues } from "./lipsync-core";

const HERE = dirname(fileURLToPath(import.meta.url));
const REMOTION = resolve(HERE, "..");
const VIDEO = resolve(REMOTION, ".."); // .../video
const TOOLS = join(VIDEO, "tools");

const args = process.argv.slice(2);
const key = args.find((a) => !a.startsWith("--")) ?? "intro";
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const dialog = flag("dialog");
const mp3Override = flag("mp3");

const findMp3 = (): string => {
  if (mp3Override) return resolve(process.cwd(), mp3Override);
  const options = [
    join(REMOTION, "public", "audio", "narration", `${key}.mp3`), // <- played/muxed file
    join(VIDEO, "voice", "narration", `${key}.mp3`),
  ];
  for (const o of options) if (existsSync(o)) return o;
  throw new Error(`No mp3 for key "${key}". Looked in:\n  ${options.join("\n  ")}`);
};

const rhubarb = findRhubarb(TOOLS);
const mp3 = findMp3();
const outDir = join(REMOTION, "src", "mascot", "data");
mkdirSync(outDir, { recursive: true });
const outJson = join(outDir, `${key}.rhubarb.json`);

console.log(`[lipsync] key=${key}`);
console.log(`[lipsync] rhubarb=${rhubarb}`);
console.log(`[lipsync] mp3=${mp3}`);

const { mouthCues, duration } = generateCues(rhubarb, mp3, { dialog });
writeFileSync(outJson, JSON.stringify({ metadata: { soundFile: mp3, duration }, mouthCues }, null, 2));

const counts: Record<string, number> = {};
for (const c of mouthCues) counts[c.value] = (counts[c.value] ?? 0) + 1;
console.log(`[lipsync] wrote ${outJson}`);
console.log(`[lipsync] ${mouthCues.length} cues over ${duration.toFixed(2)}s`);
console.log(`[lipsync] shape histogram: ${JSON.stringify(counts)}`);
