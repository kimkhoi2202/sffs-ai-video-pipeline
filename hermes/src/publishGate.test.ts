/**
 * publishGate.test.ts — the deterministic last gate, plus posting policy + attribution.
 *
 * The cases below are the ACTUAL defects that shipped, written as tests: a mangled
 * fraction, a normalized prompt, two questions sharing one templated explanation, and
 * a duplicate caption. Each must fail the gate.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "hermes-pg-"));
process.env.HERMES_ENV_FILE = join(TMP, "nonexistent.env");
process.env.HERMES_REPO_DIR = TMP;
process.env.HERMES_DATA_DIR = TMP;

const G = await import("./publishGate.ts");
const A = await import("./attribution.ts");
const P = await import("./postingPolicy.ts");

const shapeQ = (over: Record<string, unknown> = {}) => ({
  sig: "s1", hash: "h1", kind: "dot", category: "nonverbal", tier: "POSITION",
  prompt: "WHERE DOES THE DOT MOVE NEXT?", answer: "tr", ...over,
}) as any;

const clean = () => ({
  id: "2026-07-27-v01",
  // Every candidate now needs an explicit thumbnail; the gate refuses without one.
  thumbnail_url: "https://static.metricool.com/planner/202607/6617222-file-fixture.jpeg",
  caption: "SMART or FART? drop your answer below\n\n#quiz #brainteaser",
  hashtag_set: "A",
  questions: [shapeQ(), shapeQ({ sig: "s2", answer: "rm" })],
  explanations: [
    "The dot steps two places clockwise each time, so it lands top right (tr).",
    "The dot steps one place clockwise each time, so it lands on the right (rm).",
  ],
  answerLabels: ["TOP-RIGHT", "RIGHT"],
  cover_url: "https://static.metricool.com/planner/202607/6617222-file-18252086396928182933.png",
});

// ── the mangling detector ────────────────────────────────────────────────────
test("looksNormalized recognises normalizer output and spares authored text", () => {
  assert.equal(G.looksNormalized("which one does not belong"), true);
  assert.equal(G.looksNormalized("all cats purr milo is a cat so milo purrs"), true);
  assert.equal(G.looksNormalized("2 3"), true);
  assert.equal(G.looksNormalized("WHICH ONE DOES NOT BELONG?"), false, "uppercase + ? is authored");
  assert.equal(G.looksNormalized("2/3"), false, "a slash is authored");
  assert.equal(G.looksNormalized("CAN'T TELL"), false);
  assert.equal(G.looksNormalized("ALL CATS PURR.\nMILO IS A CAT."), false);
  assert.equal(G.looksNormalized(""), false);
});

test("a normalized PROMPT fails the gate", () => {
  const v = clean();
  v.questions[0] = shapeQ({ prompt: "which one does not belong" });
  const r = G.publishGate(v as any, []);
  assert.equal(r.pass, false);
  assert.match(r.reason, /normalized dedup key/);
});

test("a mangled fraction in the OPTIONS fails the gate", () => {
  const v = clean();
  v.questions[0] = shapeQ({ kind: "text", options: ["2 3", "5 8", "3 5", "7 12"], answer: "2 3" });
  const r = G.publishGate(v as any, []);
  assert.equal(r.pass, false);
  assert.match(r.reason, /mangled numbers/);
});

test("the real authored fraction PASSES", () => {
  const v = clean();
  v.questions[0] = shapeQ({ kind: "text", prompt: "WHICH IS THE GREATEST?", options: ["2/3", "5/8", "3/5", "7/12"], answer: "2/3" });
  v.answerLabels[0] = "2/3";
  v.explanations[0] = "Two thirds (2/3) is the largest, since it is closest to a whole.";
  const r = G.publishGate(v as any, []);
  assert.equal(r.pass, true, r.reason);
});

// ── options ──────────────────────────────────────────────────────────────────
test("duplicate options fail", () => {
  const v = clean();
  v.questions[0] = shapeQ({ kind: "text", prompt: "PICK ONE?", options: ["RED", "RED", "BLUE"], answer: "BLUE" });
  const r = G.publishGate(v as any, []);
  assert.equal(r.pass, false);
  assert.match(r.reason, /duplicate option/);
});

test("an answer matching zero or two options fails", () => {
  const v = clean();
  v.questions[0] = shapeQ({ kind: "text", prompt: "PICK ONE?", options: ["RED", "BLUE", "GREEN"], answer: "PURPLE" });
  const r = G.publishGate(v as any, []);
  assert.equal(r.pass, false);
  assert.match(r.reason, /matches 0 option/);
});

// ── explanations: the 53-and-K regression ────────────────────────────────────
test("two questions sharing ONE templated explanation fail", () => {
  const v = clean();
  v.explanations = ["spot the pattern to crack the sequence", "spot the pattern to crack the sequence"];
  const r = G.publishGate(v as any, []);
  assert.equal(r.pass, false);
  assert.match(r.reason, /repeats another question/);
});

test("a TEXT explanation that never names its answer fails", () => {
  const v = clean();
  v.questions[0] = shapeQ({ kind: "text", prompt: "WHICH IS THE GREATEST?", options: ["2/3", "5/8", "3/5"], answer: "2/3" });
  v.explanations[0] = "Work out the rule and you have it.";
  const r = G.publishGate(v as any, []);
  assert.equal(r.pass, false);
  assert.match(r.reason, /never references its answer/);
});

test("a SHAPE explanation need not name its answer — the reveal plate shows it", () => {
  // q.answer on a shape is an internal code ("tr", "filled-circle") that no sentence
  // would contain; requiring it rejected correct copy on every shape video.
  const v = clean();
  v.explanations[0] = "The dot steps two places clockwise each time.";
  const r = G.publishGate(v as any, []);
  assert.equal(r.pass, true, r.reason);
});

test("the displayed answer LABEL is what a text explanation is checked against", () => {
  const v = clean();
  v.questions[0] = shapeQ({ kind: "numseries", prompt: "WHAT COMES NEXT?", seq: ["A", "B", "D", "G"], answer: "k" });
  v.answerLabels = ["K", ""];
  v.explanations[0] = "The gaps grow by one, so G plus four letters is K.";
  const r = G.publishGate(v as any, []);
  assert.equal(r.pass, true, r.reason);
});

test("an explanation reused in the last 30 posts fails", () => {
  const v = clean();
  const recent = [{ caption: "old", explanations: [v.explanations[0]] }];
  const r = G.publishGate(v as any, recent);
  assert.equal(r.pass, false);
  assert.match(r.reason, /already used in the last 30/);
});

test("a missing explanation fails", () => {
  const v = clean();
  v.explanations[1] = "";
  const r = G.publishGate(v as any, []);
  assert.equal(r.pass, false);
  assert.match(r.reason, /missing explanation/);
});

// ── caption + hashtags: the TikTok throttle cause ────────────────────────────
test("an exact duplicate caption against the last 30 posts fails", () => {
  const v = clean();
  const recent = Array.from({ length: 29 }, (_, i) => ({ caption: `something else ${i}` }));
  recent.push({ caption: "  SMART or FART? Drop your answer below\n\n#quiz #brainteaser  " });
  const r = G.publishGate(v as any, recent);
  assert.equal(r.pass, false);
  assert.match(r.reason, /exact duplicate/);
});

test("a caption older than the window does NOT fail", () => {
  const v = clean();
  const recent = [{ caption: v.caption }, ...Array.from({ length: 30 }, (_, i) => ({ caption: `newer ${i}` }))];
  const r = G.publishGate(v as any, recent);
  assert.equal(r.pass, true, r.reason);
});

test("the same hashtag set three posts running fails", () => {
  const v = clean();
  const recent = [{ caption: "a", hashtag_set: "A" }, { caption: "b", hashtag_set: "A" }, { caption: "c", hashtag_set: "A" }];
  const r = G.publishGate(v as any, recent);
  assert.equal(r.pass, false);
  assert.match(r.reason, /three posts running|last 3 posts/);
});

test("a rotating hashtag set passes", () => {
  const v = clean();
  const recent = [{ caption: "a", hashtag_set: "B" }, { caption: "b", hashtag_set: "C" }, { caption: "c", hashtag_set: "A" }];
  const r = G.publishGate(v as any, recent);
  assert.equal(r.pass, true, r.reason);
});

// ── attribution ──────────────────────────────────────────────────────────────
test("the /go/ link is appended above the hashtags", () => {
  const out = A.withAttribution("SMART or FART? guess below\n\n#quiz #iqtest", "2026-07-27-v03");
  assert.match(out, /\/go\/2026-07-27-v03/);
  const lines = out.split("\n").filter(Boolean);
  assert.match(lines[lines.length - 1], /^#/, "hashtags must stay last");
  assert.match(lines[lines.length - 2], /\/go\//);
});

test("attribution is idempotent", () => {
  const once = A.withAttribution("caption\n\n#a #b", "v1");
  assert.equal(A.withAttribution(once, "v1"), once);
});

test("a caption with no hashtags still gets the link", () => {
  assert.match(A.withAttribution("just words", "v9"), /just words[\s\S]*\/go\/v9/);
});

// ── posting policy ───────────────────────────────────────────────────────────
test("the cooldown logic is KEPT, not deleted — it still evaluates as it always did", () => {
  const before = new Date("2026-07-27T20:00:00Z"); // 15:00 America/Chicago Mon
  const after = new Date("2026-07-28T02:00:00Z"); // 21:00 Chicago Mon
  assert.equal(P.isDark("tiktok", before).dark, true);
  assert.equal(P.isDark("tiktok", after).dark, false, "the cooldown has expired on its own");
  assert.equal(P.isDark("instagram", before).dark, false);
});

test("ALL THREE networks are live and take 11/day", () => {
  // TikTok resumed on 2026-08-02, by explicit owner decision and against the evidence
  // (1 view on our best video 22 hours after posting). The point of asserting it here
  // is that resuming must be a DECISION visible in the policy, the same way the pause
  // was — not something that drifts back on a timer.
  //
  // 12 -> 11 on 2026-08-03: 33 records/day is what the Metricool headroom buys for the
  // full 14-day window, where 36 runs out on 2026-08-15 with two days still to play.
  const d = P.decide(600, new Date("2026-08-02T20:00:00Z"));
  for (const network of ["instagram", "youtube", "tiktok"] as const) {
    const x = d.find((n) => n.network === network)!;
    assert.equal(x.slots, 11, `${network} should take the full 11/day`);
    assert.equal(x.allowed, true);
    assert.ok(!x.paused, `${network} must not be paused`);
  }
});

test("resuming TikTok did NOT relax its 4-hour same-platform floor", () => {
  // Volume and spacing are different levers. The 4-hour gap is a precaution about
  // platform behaviour under suppression; the 12/day is a distribution decision. A
  // resume that quietly compressed the gap would be undoing the recovery.
  const tt = P.decide(600).find((x) => x.network === "tiktok")!;
  assert.equal(tt.minGapMinutes, 240, "the 4-hour floor survives the resume");
  const ig = P.decide(600).find((x) => x.network === "instagram")!;
  assert.equal(ig.minGapMinutes, 56, "and Instagram keeps its own 56-minute floor");
});

test("a 4-hour floor caps how many TikTok slots ONE day can hold, and that is fine", () => {
  // 12/day at a 4-hour gap does not fit in a single window; planSlots spills the rest
  // onto following days. slotTimes must refuse to compress rather than silently
  // violating the floor.
  const t = P.slotTimes(12, { dayISO: "2026-08-03", startHour: 7, endHour: 22, minGapMinutes: 240 });
  assert.ok(t.length < 12, "a 15h window at a 4h gap cannot hold 12 posts");
  for (let i = 1; i < t.length; i++) {
    const gap = (Date.parse(t[i] + "Z") - Date.parse(t[i - 1] + "Z")) / 60000;
    assert.ok(gap >= 240, `gap ${gap}min must respect the 4-hour floor`);
  }
});

test("the pause MECHANISM still exists, so TikTok can be held again in one line", () => {
  // The resume must not have deleted the ability to stop. This is the switch, and the
  // reason string has to tell a human which one it is.
  assert.equal(P.pauseEnvVar("tiktok"), "HERMES_TIKTOK_PAUSED");
});

/**
 * The resume path, exercised in a CHILD PROCESS.
 *
 * Re-importing postingPolicy.ts with a cache-busting query is not enough: it still
 * resolves the already-cached config.ts, so the pause flag never changes. A child
 * process with the env set is the only way to genuinely prove that clearing the flag
 * brings TikTok back — and proving it matters, because this is the path that has to
 * still work whenever someone resumes the platform.
 */
async function decideWith(env: Record<string, string>): Promise<any[]> {
  const { spawnSync } = await import("node:child_process");
  const code = `
    const P = await import("${new URL("./postingPolicy.ts", import.meta.url).pathname}");
    process.stdout.write(JSON.stringify(P.decide(600, new Date("2026-07-28T02:00:00Z"))));
  `;
  const res = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  assert.equal(res.status, 0, `child failed: ${res.stderr}`);
  return JSON.parse(res.stdout.trim().split("\n").pop()!);
}

test("SETTING the pause takes TikTok back out, cleanly", async () => {
  const d = await decideWith({ HERMES_TIKTOK_PAUSED: "true" });
  const tt = d.find((x) => x.network === "tiktok");
  assert.equal(tt.paused, true);
  assert.equal(tt.allowed, false);
  assert.equal(tt.slots, 0, "a paused network takes no slots at all");
  assert.equal(tt.minGapMinutes, 240, "and its cadence is preserved for the next resume");
  assert.match(tt.reason, /PAUSED by config/);
  assert.deepEqual(
    P.slotTimes(tt.slots, { dayISO: "2026-08-03", startHour: 7, endHour: 22, minGapMinutes: tt.minGapMinutes }),
    [],
    "zero slots must yield zero scheduled times",
  );
});

test("pausing TikTok still leaves Instagram exactly as it was", async () => {
  const d = await decideWith({ HERMES_TIKTOK_PAUSED: "true" });
  const ig = d.find((x) => x.network === "instagram");
  assert.equal(ig.slots, 11);
  assert.equal(ig.minGapMinutes, 56);
  assert.equal(ig.allowed, true);
});

test("only the literal 'true' pauses; a lost or garbled env var leaves TikTok LIVE", async () => {
  // The polarity FLIPPED on 2026-08-02 and that is the dangerous kind of change, so it
  // is pinned here. Before, anything but "false" meant paused; now only "true" means
  // paused. A fresh box or a lost env file therefore comes up POSTING, which is the
  // intended default for the remaining campaign.
  for (const v of ["true", "True", "TRUE"]) {
    const tt = (await decideWith({ HERMES_TIKTOK_PAUSED: v })).find((x) => x.network === "tiktok");
    assert.equal(tt.slots, 0, `HERMES_TIKTOK_PAUSED="${v}" must pause TikTok`);
  }
  for (const v of ["false", "0", "no", "", "garbage"]) {
    const tt = (await decideWith({ HERMES_TIKTOK_PAUSED: v })).find((x) => x.network === "tiktok");
    assert.equal(tt.slots, 11, `HERMES_TIKTOK_PAUSED="${v}" must leave TikTok live`);
  }
});

test("Instagram is unaffected by the TikTok pause at any budget", () => {
  for (const [budget, want] of [[600, 11], [11, 11], [5, 5]] as const) {
    const ig = P.decide(budget).find((x) => x.network === "instagram")!;
    assert.equal(ig.slots, want, `budget ${budget} should give Instagram ${want}`);
  }
});

test("slotTimes never violates the minimum gap, even if asked for more", () => {
  const t = P.slotTimes(6, { dayISO: "2026-07-28", startHour: 7, endHour: 23, minGapMinutes: 240 });
  assert.ok(t.length <= 5, `16h window at a 4h gap fits at most 5, got ${t.length}`);
  for (let i = 1; i < t.length; i++) {
    const a = new Date(t[i - 1] + "Z").getTime();
    const b = new Date(t[i] + "Z").getTime();
    assert.ok(b - a >= 240 * 60_000, `gap ${(b - a) / 60000}min < 240min`);
  }
});

test("slotTimes spreads 12 Instagram posts across the window", () => {
  const t = P.slotTimes(12, { dayISO: "2026-07-27", startHour: 7, endHour: 23, minGapMinutes: 0 });
  assert.equal(t.length, 12);
  assert.match(t[0], /^2026-07-27T07:00:00$/);
  assert.match(t[11], /^2026-07-27T23:00:00$/);
});

// ── the answer-reference check is numeral-aware ──────────────────────────────
test("referencesAnswer accepts a spelled-out number", () => {
  // The authored explanations write numbers as WORDS because the same sentence is
  // read aloud as the reveal VO. A digits-only check called 279 of 852 questions
  // unexplained purely for that.
  assert.equal(G.referencesAnswer("Each number is multiplied by two then add one, so six becomes thirteen.", "13"), true);
  assert.equal(G.referencesAnswer("Add the two numbers before it: nineteen plus eleven is thirty.", "30"), true);
  assert.equal(G.referencesAnswer("Each number is multiplied by three then add two, so seven becomes twenty-three.", "23"), true);
});

test("referencesAnswer still accepts plain digits", () => {
  assert.equal(G.referencesAnswer("Each number is doubled then take away one: 5 times 2 is 10, minus 1 is 9.", "9"), true);
});

test("referencesAnswer accepts a multi-word answer when every significant word appears", () => {
  assert.equal(G.referencesAnswer("We can't tell from what we are told, so the answer is uncertain.", "CAN'T TELL"), true);
  // ...and it is LITERAL about it: "cannot tell" is a paraphrase, not the answer text.
  // Being wrong in this direction is safe — it holds a video back, it never ships one.
  assert.equal(G.referencesAnswer("Only some flowers fade fast, so we cannot tell whether the roses do.", "CAN'T TELL"), false);
});

test("referencesAnswer still rejects a genuinely generic explanation", () => {
  assert.equal(G.referencesAnswer("Work out the rule and you have it.", "13"), false);
  assert.equal(G.referencesAnswer("spot the pattern to crack the sequence", "53"), false);
});


// ── branded cover (the 2026-07-26 regression) ────────────────────────────────
// All 41 scheduled posts went out with no cover, so every reel fell back to its own
// first frame. On the motion-hook arm frame one is four blank coloured panels BY
// DESIGN, while the control arm falls back to a readable question plate — so the two
// arms differed in poster quality as well as opening, and a skip-rate difference could
// have been caused by the thumbnail rather than the hook. The gate now refuses.

const COVER = "https://static.metricool.com/planner/202607/6617222-file-18252086396928182933.png";

test("a post with NO cover is refused", () => {
  const v = clean();
  delete (v as any).cover_url;
  const r = G.publishGate(v as any, []);
  assert.equal(r.pass, false);
  assert.match(r.reason, /no cover/);
});

test("an empty or null cover is refused", () => {
  for (const bad of ["", "   ", null, undefined]) {
    const v = clean();
    (v as any).cover_url = bad;
    assert.equal(G.publishGate(v as any, []).pass, false, `cover ${JSON.stringify(bad)} should be refused`);
  }
});

test("a presigned S3 cover is refused — Metricool stores the url verbatim, so it would expire", () => {
  const v = clean();
  (v as any).cover_url = "https://hermes-sffs-media.s3.us-east-1.amazonaws.com/covers/y.png?X-Amz-Signature=abc";
  const r = G.publishGate(v as any, []);
  assert.equal(r.pass, false);
  assert.match(r.reason, /presigned S3/);
});

test("a non-https cover is refused", () => {
  const v = clean();
  (v as any).cover_url = "http://static.metricool.com/x.png";
  const r = G.publishGate(v as any, []);
  assert.equal(r.pass, false);
  assert.match(r.reason, /not https/);
});

test("a durable public cover passes", () => {
  const v = clean();
  (v as any).cover_url = COVER;
  const r = G.publishGate(v as any, []);
  assert.equal(r.pass, true, r.reason);
});


// ── cover as a millisecond offset (the first-question-plate strategy) ────────
// The cover is now the post's own first question plate, taken with
// videoCoverMilliseconds, because a visible puzzle stops a scroller on a profile grid
// where an identical branded card on every post does not.

// SUPERSEDED BY MEASUREMENT. This asserted that an offset alone was enough. It is not:
// Metricool stores videoCoverMilliseconds faithfully and Instagram discards it, so the
// offset satisfies a read-back and nothing else. The offset is still carried — harmless,
// and correct wherever it IS honoured — but it can no longer stand in for a cover.
test("an offset with no explicit thumbnail is refused, however well-formed", () => {
  const v = clean();
  delete (v as any).cover_url;
  (v as any).cover_ms = 3900;
  (v as any).thumbnail_url = null;
  assert.equal(G.publishGate(v as any, []).pass, false);
});

test("a zero or negative cover offset is refused — 0 is frame one, which is the bug", () => {
  for (const ms of [0, -1]) {
    const v = clean();
    delete (v as any).cover_url;
    (v as any).cover_ms = ms;
    const r = G.publishGate(v as any, []);
    assert.equal(r.pass, false, `cover_ms ${ms} should be refused`);
    assert.match(r.reason, /must be positive|no cover/);
  }
});

test("neither cover form present is still refused", () => {
  const v = clean();
  delete (v as any).cover_url;
  const r = G.publishGate(v as any, []);
  assert.equal(r.pass, false);
  assert.match(r.reason, /no cover/);
});

test("an uploaded-url cover still satisfies the gate (both forms accepted)", () => {
  const v = clean();
  (v as any).cover_ms = null;
  assert.equal(G.publishGate(v as any, []).pass, true);
});

test("coverMomentMs: semantic, per-arm, and never frame one", async () => {
  const { coverMomentMs } = await import("./covers.ts");
  const durs = { q0: 3.0 };
  const questions = [{ idx: 0 }];
  const control = coverMomentMs({ opening: "cold-plate", readVO: "full", durs, questions });
  const hook = coverMomentMs({ opening: "motion-hook", readVO: "full", durs, questions });
  // read = round((0.12 + 3.0 + 0.4) * 30) = 106 frames, +30 frames into the countdown
  assert.equal(control, Math.round((136 / 30) * 1000)); // 4533ms
  // the hook arm is the same moment, exactly 2.2s later — the SAME thing, not the same
  // constant, which is precisely what keeps this out of the confound
  assert.equal(hook - control, 2200);
  assert.ok(control > 0 && hook > 0, "never frame one");
  assert.notEqual(control, hook, "a single fixed offset across both arms is the confound");
});

// ── the explicit thumbnail requirement ───────────────────────────────────────
// Instagram ignores videoCoverMilliseconds on this path and serves frame zero instead:
// frame zero won the pixel comparison on 9 of 9 published reels, and on the hook arm
// frame zero is a bare four-colour grid with no text. Only videoThumbnailUrl is honoured.
test("an offset alone no longer satisfies the gate — Instagram ignores it", () => {
  const v = clean();
  (v as any).cover_ms = 6400;
  (v as any).thumbnail_url = null;
  const r = G.publishGate(v as any, []);
  assert.equal(r.pass, false);
  assert.match(r.reason, /explicit videoThumbnailUrl/);
});

test("an explicit https thumbnail satisfies the gate", () => {
  const v = clean();
  (v as any).cover_ms = 6400;
  assert.equal(G.publishGate(v as any, []).pass, true);
});

test("a presigned S3 thumbnail is refused — it expires before the post runs", () => {
  const v = clean();
  (v as any).thumbnail_url = "https://b.s3.amazonaws.com/x.jpg?X-Amz-Signature=ab";
  const r = G.publishGate(v as any, []);
  assert.equal(r.pass, false);
  assert.match(r.reason, /presigned/);
});
