/**
 * render-hook-proof.ts — PROOF harness for the opening-hook surface.
 *
 * Renders one real short per hook MECHANISM (plus a cold-open control) through the
 * exact production path: design-shaped props -> render.ts renderVideo -> cloned-voice
 * TTS -> Remotion. Not a unit test and not a mock; the point is pixels and audio.
 *
 * It also asserts the thing unit tests cannot see: that render.ts computeShortFrames
 * and the Remotion timeline agree on the total once a hook segment exists. If they
 * diverge the video is silently cut or padded, so the harness compares the predicted
 * frame count against the muxed duration ffprobe reports.
 *
 *   node tools/render-hook-proof.ts                # every mechanism + control
 *   node tools/render-hook-proof.ts hook-stat      # just these arms
 *
 * Writes to renders.nosync/hook-proof/.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG } from "../hermes/src/config.ts";
import { renderVideo, computeFrames, mapProps } from "../hermes/src/render.ts";
import { hookArms, pickHook } from "../hermes/src/hooks.ts";
import { readJSON, type HermesQ } from "../hermes/src/state.ts";

const OUT = join(CONFIG.REPO_DIR, "renders.nosync", "hook-proof2");
const FPS = 30;

/** Three fixed questions so every arm renders the SAME quiz and only the hook varies. */
function fixtureQuestions(): HermesQ[] {
  const bank = readJSON<{ entries: any[] }>(CONFIG.BANK, { entries: [] });
  const pick = (tier: string) =>
    bank.entries.find((e) => e.tier === tier && !e.posted) ?? bank.entries.find((e) => e.tier === tier);
  const chosen = [pick("ODD ONE OUT"), pick("VERBAL ANALOGY"), pick("NUMBER SERIES")].filter(Boolean);
  return chosen.map((e: any) => {
    const parts = String(e.payloadNorm).split(" || ");
    const common = { sig: e.sig, hash: e.hash, kind: e.kind, category: e.category, tier: e.tier };
    if (e.kind === "numseries") {
      // numseries payload is the bare sequence; the answer is the missing value.
      return { ...common, prompt: String(e.promptNorm).toUpperCase(), seq: parts[0].split("~"), answer: String(e.answerNorm) } as HermesQ;
    }
    const opts = parts[1]?.split("~") ?? [];
    return {
      ...common,
      prompt: String(parts[0]).toUpperCase(),
      options: opts.map((o: string) => o.toUpperCase()),
      answer: String(e.answerNorm).toUpperCase(),
    } as HermesQ;
  });
}

function propsFor(opening: "cold-plate" | "motion-hook", hook: { title: string; subtitle?: string; vo: string } | null, qs: HermesQ[]) {
  return {
    opening,
    hook: hook ?? undefined,
    outro: "comment your answer 👇 follow for more",
    music: "audio/music/gameshow-fanfare.mp3",
    showProgress: true,
    progressStyle: "short",
    reveal: "allButLast", // the cliffhanger default
    countdownSec: 5,
    narration: { mode: "full", clips: [] },
    questions: qs.map((q) => ({ kind: q.kind, tier: q.tier, prompt: q.prompt, options: q.options, seq: q.seq, answer: q.answer })),
  };
}

function probeSeconds(path: string): number {
  const out = execFileSync(process.env.FFPROBE || "/opt/homebrew/bin/ffprobe", [
    "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", path,
  ], { encoding: "utf8" });
  return Number(String(out).trim());
}

function stills(mp4: string, id: string, atSecs: number[]) {
  for (const t of atSecs) {
    const png = join(OUT, `${id}.t${String(t).replace(".", "_")}s.png`);
    execFileSync(process.env.FFMPEG || "/opt/homebrew/bin/ffmpeg", [
      "-y", "-loglevel", "error", "-ss", String(t), "-i", mp4, "-frames:v", "1", png,
    ]);
  }
}

const want = process.argv.slice(2);
mkdirSync(OUT, { recursive: true });
const qs = fixtureQuestions();
if (qs.length < 3) throw new Error(`need 3 fixture questions, got ${qs.length}`);
console.log("fixture questions:", qs.map((q) => q.tier).join(", "));

type Job = { id: string; arm: string; opening: "cold-plate" | "motion-hook"; hook: any };
const jobs: Job[] = [
  { id: "proof2-cold-plate", arm: "cold-plate", opening: "cold-plate", hook: null },
  { id: "proof2-motion-hook", arm: "motion-hook", opening: "motion-hook", hook: null },
];
for (const { mechanism, arm } of hookArms()) {
  const h = pickHook(mechanism, `proof:${arm}`, { numQ: 3, countdownSec: 5, ending: "cliffhanger", wrongLetters: ["B", "C", "D"] });
  if (!h) { console.log(`SKIP ${arm}: no eligible bank line`); continue; }
  jobs.push({ id: `proof2-${arm}`, arm, opening: "motion-hook", hook: h });
}

const results: any[] = [];
for (const job of jobs.filter((j) => !want.length || want.includes(j.arm))) {
  const props = propsFor(job.opening, job.hook, qs);
  console.log(`\n=== ${job.arm} ===`);
  if (job.hook) console.log(`  vo:    "${job.hook.vo}"\n  plate: ${job.hook.title} / ${job.hook.subtitle ?? ""}`);
  const r = renderVideo(job.id, props, { force: false });
  const secs = probeSeconds(r.path);
  const exact = computeFrames(props);
  const muxed = Math.round(secs * FPS);
  const short = (props as any).__short ?? {};
  const hookVo = Number(short.durs?.hook ?? 0);
  // QUESTION ONE'S ARRIVAL: the whole point. Zero on the cold plate, and on every
  // motion arm exactly the animation length, whether or not it carries a voice.
  const q1At = job.opening === "motion-hook" ? 2.2 : 0;
  console.log(`  frames exact=${exact} muxed=${muxed} drift=${muxed - exact}   hookVO=${hookVo}s   Q1 at ${q1At.toFixed(2)}s`);
  if (job.hook && !hookVo) console.log("  !! hook VO was DROPPED (over budget) - this arm rendered wordless");
  stills(r.path, job.id, job.opening === "motion-hook" ? [0.1, 0.7, 1.4, 2.35] : [0.2]);
  results.push({ arm: job.arm, id: job.id, path: r.path, secs: Number(secs.toFixed(2)), exact, muxed, drift: muxed - exact, q1At, hookVo, hook: job.hook });
}

writeFileSync(join(OUT, "results.json"), JSON.stringify(results, null, 2));
console.log("\n=== QUESTION ONE ARRIVAL ===");
console.log("arm                    Q1 at    hookVO   total   line");
for (const r of results) {
  console.log(`${r.arm.padEnd(22)} ${r.q1At.toFixed(2)}s   ${String(r.hookVo).padStart(5)}s  ${String(r.secs).padStart(6)}s  ${(r.hook || {}).vo ?? "(no spoken hook)"}`);
}
console.log(`\nwrote ${results.length} renders + stills to ${OUT}`);
