/**
 * Emit the per-video metadata + subtitle sidecars for every cut (see
 * src/data/cuts.ts): creates renders/videos/<dir>/ and writes questions.json,
 * info.md, and phrase-chunked .srt + .vtt (full transcript for that cut). Does
 * NOT render the mp4s. Run: `npx tsx scripts/build-cuts.ts`.
 */
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { getTimeline, FPS } from "../src/full/timeline";
import { buildPhrases } from "../src/lib/phrases";
import { ALL_CUTS, SHORTS, COG, DIFF, type Cut } from "../src/data/cuts";
import { QUESTIONS } from "../src/data/questions";

const ROOT = join(process.cwd(), "..", "renders.nosync", "videos");
const today = new Date().toISOString().slice(0, 10);

const p2 = (n: number) => String(Math.floor(n)).padStart(2, "0");
const ts = (sec: number, comma: boolean) => {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.round((sec - Math.floor(sec)) * 1000);
  return `${p2(h)}:${p2(m)}:${p2(s)}${comma ? "," : "."}${String(ms).padStart(3, "0")}`;
};
const mmss = (sec: number) => `${Math.floor(sec / 60)}:${p2(sec % 60)}`;

const promptOf = (q: (typeof QUESTIONS)[number]): string =>
  ("question" in q ? q.question : "prompt" in q ? q.prompt : "").replace(/\n/g, " / ");

function emit(cut: Cut) {
  const dir = join(ROOT, cut.dir);
  mkdirSync(dir, { recursive: true });
  const T = getTimeline(cut.platform, cut.ids);
  const durSec = Math.round(T.total / FPS);

  // questions.json — this cut's question bank (in play order)
  const questions = cut.ids.map((id, i) => {
    const q = QUESTIONS.find((x) => x.idx === id)!;
    return {
      pos: i + 1,
      id,
      kind: q.kind,
      category: COG[id],
      difficulty: DIFF[id],
      tier: q.tier,
      prompt: promptOf(q),
      answer: { letter: q.ansLetter, label: q.ansLabel },
    };
  });
  const audio = cut.music ? { music: cut.music, sfx: cut.sfx } : { music: "fanfare -> parade -> winner arc", sfx: "shared default set" };
  writeFileSync(
    join(dir, "questions.json"),
    JSON.stringify({ slug: cut.slug, title: cut.title, platform: cut.platform, format: cut.format, questionCount: cut.ids.length, countdownSec: 5, audio, questions }, null, 2),
  );

  // info.md — human-readable summary
  const platformLine =
    cut.dir.startsWith("youtube/") ? cut.platform : "Instagram + TikTok (identical 9:16 cut)";
  const rows = questions
    .map((q) => `| ${q.pos} | Q${q.id} | ${q.category} | ${q.difficulty} | ${q.tier} | ${q.answer.letter} · ${q.answer.label} |`)
    .join("\n");
  const info = `# ${cut.title}

- **Platform:** ${platformLine}
- **Aspect:** ${cut.format} (${cut.format === "16:9" ? "1920x1080" : "1080x1920"})
- **Questions:** ${cut.ids.length}${cut.dir.startsWith("youtube/") ? " (score out of " + cut.ids.length + ")" : " (mini score out of " + cut.ids.length + ")"}
- **Duration:** ~${mmss(durSec)} (${durSec}s)
- **Countdown:** 5s per question
- **Music:** ${cut.music ?? "fanfare -> parade -> winner arc (shared)"}
- **SFX:** ${cut.sfx ? `distinct set \`${cut.slug}/\` (ding/whoosh/sting)` : "shared default set"}
- **File:** \`${cut.file}\`
- **Rendered:** ${today}
${cut.note ? `- **Note:** ${cut.note}\n` : ""}
## Questions (play order)

| # | Source | Category | Difficulty | Type | Answer |
|---|--------|----------|------------|------|--------|
${rows}

## Files
- \`${cut.file}\` — the video (h264/yuv420p + AAC).
- \`captions.srt\` / \`captions.vtt\` — full spoken transcript (phrase-chunked).
- \`questions.json\` — this cut's question bank.
`;
  writeFileSync(join(dir, "info.md"), info);

  // sidecars — full transcript for THIS cut
  const cues = buildPhrases(T).map((p) => ({ s: p.s / FPS, e: p.e / FPS, text: p.text }));
  const srt = cues.map((c, i) => `${i + 1}\n${ts(c.s, true)} --> ${ts(c.e, true)}\n${c.text}\n`).join("\n");
  const vtt = "WEBVTT\n\n" + cues.map((c) => `${ts(c.s, false)} --> ${ts(c.e, false)}\n${c.text}\n`).join("\n");
  writeFileSync(join(dir, "captions.srt"), srt);
  writeFileSync(join(dir, "captions.vtt"), vtt);

  console.log(`[cut] ${cut.slug.padEnd(8)} ${cut.format} ${String(cut.ids.length).padStart(2)}Q  ~${mmss(durSec)}  ${cues.length} cues  -> videos/${cut.dir}/`);
}

const mkEntry = (c: Cut, dir: string, platform: string) => ({
  slug: c.slug,
  dir,
  file: c.file,
  platform,
  format: c.format,
  questionIds: c.ids,
  countdownSec: 5,
  music: c.music ?? "arc (fanfare/parade/winner)",
  sfx: c.sfx ?? "shared default",
  durationSec: Math.round(getTimeline(c.platform, c.ids).total / FPS),
});
const platformOf = (c: Cut): string =>
  c.dir.startsWith("youtube/") ? c.platform : c.dir.startsWith("shorts-60/") ? "instagram+tiktok" : "instagram";
const manifest = [
  ...ALL_CUTS.map((c) => mkEntry(c, c.dir, platformOf(c))),
  // TikTok is a byte-identical mirror of each instagram short
  ...SHORTS.map((c) => mkEntry(c, c.dir.replace("instagram/", "tiktok/"), "tiktok")),
];

for (const cut of ALL_CUTS) emit(cut);
mkdirSync(ROOT, { recursive: true });
writeFileSync(join(ROOT, "manifest.json"), JSON.stringify({ generated: today, cuts: manifest }, null, 2));
console.log(`[cuts] wrote ${ALL_CUTS.length} cuts + manifest.json -> ${ROOT}`);
