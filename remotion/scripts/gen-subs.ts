/**
 * Generate .srt + .vtt sidecars for the whole video - ONE cue per caption PHRASE
 * (same chunker the burned-in captions use, src/lib/phrases), so the sidecars
 * match what's on screen. Run: `npx tsx scripts/gen-subs.ts` (defaults to the
 * youtube master; pass a platform arg for IG/TikTok).
 */
import { writeFileSync } from "fs";
import { join } from "path";
import { getTimeline, FPS, type Platform } from "../src/full/timeline";
import { buildPhrases } from "../src/lib/phrases";

const platform = (process.argv[2] as Platform) || "youtube";
const phrases = buildPhrases(getTimeline(platform));

const p2 = (n: number) => String(Math.floor(n)).padStart(2, "0");
const ts = (sec: number, comma: boolean) => {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.round((sec - Math.floor(sec)) * 1000);
  return `${p2(h)}:${p2(m)}:${p2(s)}${comma ? "," : "."}${String(ms).padStart(3, "0")}`;
};

const cues = phrases.map((p) => ({ s: p.s / FPS, e: p.e / FPS, text: p.text }));

const srt = cues.map((c, i) => `${i + 1}\n${ts(c.s, true)} --> ${ts(c.e, true)}\n${c.text}\n`).join("\n");
const vtt = "WEBVTT\n\n" + cues.map((c) => `${ts(c.s, false)} --> ${ts(c.e, false)}\n${c.text}\n`).join("\n");

const base = join(process.cwd(), "..", "renders", "round-15-remotion-master");
writeFileSync(`${base}.srt`, srt);
writeFileSync(`${base}.vtt`, vtt);
console.log(`[subs] ${cues.length} phrase cues (${platform}) -> ${base}.srt + .vtt`);
console.log(srt.split("\n").slice(0, 13).join("\n"));
