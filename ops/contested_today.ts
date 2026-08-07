/**
 * ops/contested_today.ts — ship the FIVE contested-answer posts for 2026-08-07.
 *
 * A one-day, owner-directed batch, deliberately kept OUT of the daily cycle. The cycle
 * plans a whole day from the pinned format on its own timer; this places five specific
 * questions into the gaps that are left in today's window, and changes nothing about
 * what the cycle will do tomorrow.
 *
 * WHAT IT DOES NOT BYPASS. Every content gate the loop runs, runs here, in the same
 * order and from the same modules: dedup, question validity, brand/copy, render sanity.
 * The Metricool 600-record guard is consulted before anything is created. The 56-minute
 * Instagram floor is re-checked against the LIVE calendar rather than trusted from the
 * times below, so a slot that has stopped being free is refused instead of crowded.
 *
 * WHAT IT DOES DIFFERENTLY, and why each is deliberate:
 *   INSTAGRAM ONLY. YouTube is hard-blocking roughly eleven of every twelve uploads and
 *   TikTok is paused; rendering or posting to either would spend budget for nothing.
 *   ONE QUESTION PER VIDEO. The one-question arm averages 1.33 comments against 0.19
 *   for three-question posts, and comments are the whole point of this batch.
 *   FIVE ABOVE THE DAILY ELEVEN. Today's Instagram cap was already full, and the
 *   instruction was not to displace what is scheduled. The standing policy is left at
 *   11/day so tomorrow's cycle is unaffected; this is an override for one day, and it
 *   is logged as one.
 */
import { readJSON, writeJSONAtomic, type HermesQ } from "../hermes/src/state.ts";
import { CONFIG } from "../hermes/src/config.ts";
import { toHermesQ, markUsed } from "../hermes/src/questions.ts";
import { gateDedup, validateQuestions, gateCopy, gateRenderSanity } from "../hermes/src/gates.ts";
import { quantVerdict } from "../hermes/src/arithmetic.ts";
import { contestedLabel, CONTESTED_ARM, CONTESTED_DIMENSION } from "../hermes/src/contested.ts";
import { renderForPlatforms } from "../hermes/src/render.ts";
import { publishAsDraft } from "../hermes/src/loopPublish.ts";
import { budget, listPosts } from "../hermes/src/metricool.ts";
import { leadStamp } from "../hermes/src/leadPromotion.ts";
import { contentDefaults, narrationModeForArm, revealForEnding, mascotModeForArm, defaultOutro } from "../hermes/src/defaults.ts";
import { info, decision, warn, gate } from "../hermes/src/log.ts";
import { createHash } from "node:crypto";
import { join } from "node:path";

const MODE = process.argv.includes("--publish") ? "publish" : "dry";
const RUN_ID = "contested-20260807";
const NETWORK = "instagram" as const;

/**
 * The five, and the slot each one takes.
 *
 * Every question is a NUMBER PUZZLE carrying a signposted trap: one worked example is
 * true under BOTH the hidden rule and plain addition, and the plain sum of the query is
 * offered as a distractor. Five DIFFERENT rules, no shared example line, and the
 * coincidence line sits in a different position in each, because five near-identical
 * puzzles in one day is the exact shape near-duplicate detection is built to catch.
 *
 * `at` times were chosen to fall in the gaps between posts ALREADY on today's calendar
 * while keeping 56 minutes clear on both sides. They are re-verified at run time.
 */
const BATCH: Array<{
  rule: string; prompt: string; options: string[]; answer: string;
  explanation: string; caption: string; hashtagSet: string; at: string;
}> = [
  {
    rule: "a*b+a",
    prompt: "IF 8+9=80, 1+2=3, 9+9=90 THEN 2+3=?",
    options: ["5", "7", "8", "9"],
    answer: "8",
    explanation: "Multiply the two numbers, then add the first one back. 8x9+8=80, 1x2+1=3, 9x9+9=90. So 2x3+2=8.",
    caption: "if you got this one instantly, read it again 👀 what's your answer? drop it in the comments, then take the full test 🧠💨",
    hashtagSet: "A",
    at: "2026-08-07T15:51:00",
  },
  {
    rule: "a^2+b",
    prompt: "IF 7+4=53, 5+3=28, 1+5=6 THEN 3+2=?",
    options: ["9", "5", "11", "15"],
    answer: "11",
    explanation: "Square the first number, then add the second. 7x7+4=53, 5x5+3=28, 1x1+5=6. So 3x3+2=11.",
    caption: "the comments are gonna fight about this one. what's your answer? drop it below, then take the full test 🧠💨",
    hashtagSet: "B",
    at: "2026-08-07T17:53:00",
  },
  {
    rule: "a*b-b",
    prompt: "IF 3+3=6, 9+9=72, 8+6=42 THEN 4+3=?",
    options: ["8", "9", "7", "12"],
    answer: "9",
    explanation: "Multiply the two numbers, then subtract the second. 3x3-3=6, 9x9-9=72, 8x6-6=42. So 4x3-3=9.",
    caption: "two answers look right here, only one of them is. what's your answer? tell us in the comments, then take the full test 🧠💨",
    hashtagSet: "C",
    at: "2026-08-07T19:57:00",
  },
  {
    rule: "a*b-a-b",
    prompt: "IF 9+8=55, 7+6=29, 4+4=8 THEN 3+5=?",
    options: ["8", "15", "7", "23"],
    answer: "7",
    explanation: "Multiply the two numbers, then subtract both of them. 9x8-9-8=55, 7x6-7-6=29, 4x4-4-4=8. So 3x5-3-5=7.",
    caption: "bet you picked the obvious one 👀 what's your answer? drop it in the comments, then take the full test 🧠💨",
    hashtagSet: "A",
    at: "2026-08-07T22:03:00",
  },
  {
    rule: "(a+b)*(a-b)",
    prompt: "IF 9+2=77, 2+1=3, 8+5=39 THEN 5+2=?",
    options: ["12", "7", "21", "9"],
    answer: "21",
    explanation: "The sum times the difference. (9+2)x(9-2)=77, (2+1)x(2-1)=3, (8+5)x(8-5)=39. So (5+2)x(5-2)=21.",
    caption: "read the middle line again. what's your answer? settle it in the comments, then take the full test 🧠💨",
    hashtagSet: "B",
    at: "2026-08-08T00:09:00",
  },
];

// ── bank entry construction (byte-identical to content/validate.mjs) ─────────
const norm = (s: string): string => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const slugify = (s: string): string => norm(s).replace(/ /g, "-");
const payloadOfText = (prompt: string, options: string[]): string =>
  norm(prompt) + " || " + options.map(norm).sort().join("~");
const sigOf = (kind: string, category: string, tier: string, payload: string, answerNorm: string): string =>
  [kind, category, slugify(tier), payload, answerNorm].join("|");
const hashOf = (s: string): string => createHash("sha1").update(s).digest("hex").slice(0, 12);

interface BankEntry { sig: string; hash: string; kind: string; category: string; tier: string; promptNorm: string; payloadNorm: string; answerNorm: string; prompt: string; options: string[]; answer: string; explanation: string; slug: string; id: number; }

function bankEntryFor(b: (typeof BATCH)[number], i: number): BankEntry {
  const payloadNorm = payloadOfText(b.prompt, b.options);
  const answerNorm = norm(b.answer);
  const sig = sigOf("text", "quantitative", "NUMBER PUZZLE", payloadNorm, answerNorm);
  return {
    sig, hash: hashOf(sig),
    kind: "text", category: "quantitative", tier: "NUMBER PUZZLE",
    promptNorm: norm(b.prompt), payloadNorm, answerNorm,
    prompt: b.prompt, options: b.options, answer: b.answer, explanation: b.explanation,
    slug: RUN_ID, id: i + 1,
  };
}

function main(): Promise<void> { return run(); }

async function run(): Promise<void> {
  console.log(`=== contested_today (${MODE}) ===\n`);

  // ── 0. the record budget guard, before anything is created ────────────────
  const b = await budget();
  console.log(`budget: ${b.used}/${b.budget} used, ${b.remaining} remaining, blocked=${b.blocked}`);
  if (b.blocked) throw new Error("Metricool monthly guard is BLOCKED — refusing to create posts");
  if (b.remaining < BATCH.length) throw new Error(`only ${b.remaining} records left, need ${BATCH.length}`);

  // ── 1. the 56-minute Instagram floor, re-checked against the LIVE calendar ─
  const rows = await listPosts("2026-08-07T00:00:00", "2026-08-09T00:00:00");
  const igTimes: number[] = [];
  for (const p of rows) {
    if (!(p.providers ?? []).some((x) => x.network === NETWORK)) continue;
    const dt = p.publicationDate?.dateTime;
    if (dt) igTimes.push(Date.parse(dt + "Z"));
  }
  const gapMin = CONFIG.PLATFORM_POLICY[NETWORK].minGapMinutes;
  const planned = BATCH.map((x) => Date.parse(x.at + "Z"));
  for (const [i, t] of planned.entries()) {
    const clash = [...igTimes, ...planned.filter((_, j) => j !== i)]
      .filter((o) => Math.abs(o - t) < gapMin * 60_000);
    if (clash.length) {
      throw new Error(`slot ${BATCH[i].at} is within ${gapMin}min of ${clash.length} existing/planned post(s) — refusing`);
    }
  }
  console.log(`slots: all ${BATCH.length} keep the ${gapMin}-minute Instagram floor against ${igTimes.length} calendar rows\n`);

  // ── 2. bank the questions (idempotent) ────────────────────────────────────
  const bank = readJSON<{ entries?: BankEntry[] }>(CONFIG.BANK, {});
  bank.entries = bank.entries ?? [];
  const entries = BATCH.map(bankEntryFor);
  let added = 0;
  for (const e of entries) {
    if (bank.entries.some((x) => x.sig === e.sig)) continue;
    bank.entries.push(e);
    added++;
  }
  if (added && MODE === "publish") writeJSONAtomic(CONFIG.BANK, bank);
  console.log(`bank: ${added} new entr(ies)${added && MODE !== "publish" ? " (not written in dry mode)" : ""}, ${bank.entries.length} total\n`);

  // ── 3. prove each question BEFORE building anything ───────────────────────
  const qs: HermesQ[] = [];
  for (const [i, e] of entries.entries()) {
    const q = toHermesQ(e as any);
    if (!q) throw new Error(`Q${i + 1} did not survive toHermesQ (structural limits)`);
    const v = quantVerdict(q);
    const l = contestedLabel(q);
    console.log(`Q${i + 1} ${BATCH[i].rule}`);
    console.log(`   ${q.prompt}`);
    console.log(`   options ${q.options?.join(" / ")}   answer ${q.answer}`);
    console.log(`   validity : ${v.handled ? (v.valid ? "VALID" : "INVALID") : "not handled"} — ${(v as any).reason ?? ""}`);
    console.log(`   contested: ${l.contested} — ${l.reason}`);
    if (!v.handled || !v.valid) throw new Error(`Q${i + 1} is not a valid question — refusing to ship`);
    if (!l.contested) throw new Error(`Q${i + 1} carries no signposted trap — refusing to ship`);
    qs.push(q);
  }
  console.log("");

  // ── 4. build, gate, render, publish ───────────────────────────────────────
  const defaults = contentDefaults();
  const narration = narrationModeForArm(defaults.narration);
  const reveal = revealForEnding(defaults.ending);
  const mascot = mascotModeForArm(defaults.mascot);
  const shipped: Array<Record<string, unknown>> = [];

  for (const [i, q] of qs.entries()) {
    const spec = BATCH[i];
    const id = `${RUN_ID}-v${String(i + 1).padStart(2, "0")}`;
    const tags = CONFIG.HASHTAG_SETS[spec.hashtagSet];
    const caption = `${spec.caption}\n\n${tags.join(" ")}`;
    console.log(`--- ${id} (${spec.rule}) ---`);

    // dedup — scoped to this video, exactly as prepareVideo does
    const dedup = gateDedup([q], new Set<string>(), id);
    gate(`${id} dedup: ${dedup.reason}`);
    if (!dedup.pass) throw new Error(`${id} dedup failed: ${dedup.reason}`);

    // question validity — the real gate, which for NUMBER PUZZLE is decided by
    // enumeration in arithmetic.ts rather than by the LLM rubric
    const val = await validateQuestions([q]);
    gate(`${id} question-validity: ${val.gate.reason}`);
    if (!val.gate.pass) throw new Error(`${id} validity failed: ${val.gate.reason}`);

    const props: Record<string, unknown> = {
      opening: "cold-plate",
      outro: defaultOutro(reveal),
      music: CONFIG.MUSIC_TRACKS[i % CONFIG.MUSIC_TRACKS.length],
      showProgress: false,
      progressStyle: "short",
      reveal,
      countdownSec: 5,
      narration: { mode: narration, clips: [] },
      ending: defaults.ending,
      mascot,
      mascotArm: defaults.mascot,
      questions: [{ kind: q.kind, tier: q.tier, prompt: q.prompt, options: q.options, seq: q.seq, answer: q.answer, explanation: q.explanation }],
      title: "",
      subtitle: "",
    };

    // brand / copy gate
    const copy = await gateCopy([
      { label: "caption", text: caption },
      { label: "outro", text: String(props.outro) },
    ]);
    gate(`${id} copy: ${copy.reason}`);
    if (!copy.pass) throw new Error(`${id} copy gate failed: ${copy.reason}`);
    if (copy.unjudged) warn(`${id} copy gate was UNJUDGED (rules passed, judge never answered)`);

    if (MODE === "publish") markUsed(id, CONTESTED_DIMENSION, CONTESTED_ARM, [q]);

    // render — INSTAGRAM ONLY
    const renders = renderForPlatforms(id, props, { platforms: [NETWORK] });
    const r = renders[0];
    const sanity = gateRenderSanity(r.path, r.frames);
    gate(`${id} render sanity: ${sanity.reason}`);
    if (!sanity.pass) throw new Error(`${id} render sanity failed: ${sanity.reason}`);
    console.log(`   rendered ${r.path} (${r.frames} frames, ${(r.frames / 30).toFixed(1)}s)`);

    if (MODE !== "publish") { shipped.push({ id, rule: spec.rule, path: r.path, seconds: r.frames / 30 }); console.log(""); continue; }

    const renderProps = readJSON<Record<string, unknown>>(join(CONFIG.RENDERS_DIR, `${id}.${NETWORK}.props.json`), {});
    const draft = await publishAsDraft({
      runId: RUN_ID, videoId: id, index: i, caption, title: "",
      hashtagSet: spec.hashtagSet, questions: [q], explanations: [q.explanation ?? ""],
      answerLabels: [q.answer], renderPath: r.path, renderProps,
      whenLocal: spec.at, network: NETWORK,
    });
    console.log(`   scheduled ${spec.at} America/Chicago  uuid=${draft.uuid}`);
    annotate(id, caption, q, spec, draft.uuid);
    shipped.push({ id, rule: spec.rule, at: spec.at, uuid: draft.uuid, path: r.path, seconds: r.frames / 30 });
    console.log("");
  }

  decision(
    `CONTESTED-ANSWER BATCH: ${shipped.length} Instagram post(s) ${MODE === "publish" ? "scheduled" : "built (dry)"} for 2026-08-07, ` +
      `one question each, arm "${CONTESTED_ARM}". Every question carries a signposted trap (a worked example true under ` +
      `both the hidden rule and plain addition, with the plain sum offered as a distractor) AND a uniquely determined ` +
      `official answer. Five different rules. This is a ONE-DAY override above the 11/day Instagram policy, which is ` +
      `unchanged; nothing already on the calendar was moved.`,
    { shipped },
  );
  console.log("\n=== SHIPPED ===");
  console.log(JSON.stringify(shipped, null, 2));
}

/** One ab-database row per post, matching cycle.ts annotateDb's shape. */
function annotate(id: string, caption: string, q: HermesQ, spec: (typeof BATCH)[number], uuid: string): void {
  const db = readJSON<any>(CONFIG.AB_DB, null);
  if (!db || !Array.isArray(db.posts)) { warn("ab-database missing — skipping annotation"); return; }
  const key = `hermes:${id}:${NETWORK}`;
  const existing = db.posts.find((p: any) => p._hermes_key === key);
  const rec = existing ?? {};
  const label = contestedLabel(q);
  Object.assign(rec, {
    _hermes_key: key,
    metricool_uuid: uuid,
    platform_post_id: null,
    platform: NETWORK,
    account_id: CONFIG.ACCOUNTS[NETWORK],
    account_handle: "@smartfellafartsmellatest",
    permalink: null,
    caption,
    source_video: `hermes-render:${id}.${NETWORK}.mp4`,
    media_url_note: "S3 private object (presigned at post time)",
    variant: {
      family: CONTESTED_DIMENSION,
      arm: CONTESTED_ARM,
      label: CONTESTED_ARM,
      narration: "full",
      ending: contentDefaults().ending,
      question_types: [q.tier],
      num_questions: 1,
      // The trap, recorded as data rather than left to be re-derived. The arm is judged
      // on COMMENTS, and a post whose label is not stored cannot be told apart later
      // from a one-question post that merely happened to be hard.
      contested: label.contested,
      contested_naive_answer: label.naiveAnswer,
      contested_endorsed_by: label.endorsedBy,
      contested_rule: spec.rule,
      ...leadStamp(q),
    },
    experiment: {
      dimension: CONTESTED_DIMENSION,
      arm: CONTESTED_ARM,
      rationale:
        "One question, and the plain-arithmetic answer is both offered as a distractor and endorsed by a worked " +
        "example. Judged on COMMENTS, not skip rate: skip rate cannot see an argument.",
      hermes_video_id: id,
    },
    hashtag_set: spec.hashtagSet,
    post_state: "scheduled",
    scheduled_at: spec.at,
    metrics: { reach: null, video_views: null, reactions: null, comments: null, shares: null, eng_rate: null, as_of: null, source: "pending" },
    match_confidence: "high",
    notes: "Owner-directed contested-answer batch, 2026-08-07. Instagram only.",
  });
  if (!existing) db.posts.push(rec);
  db.updated_at = new Date().toISOString();
  writeJSONAtomic(CONFIG.AB_DB, db);
  info("ab-database annotated", { id, uuid });
}

await main();
