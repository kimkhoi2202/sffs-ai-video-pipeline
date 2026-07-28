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

test("while TikTok is PAUSED, only Instagram gets slots", () => {
  const d = P.decide(600, new Date("2026-07-26T20:00:00Z"));
  const ig = d.find((x) => x.network === "instagram")!;
  const tt = d.find((x) => x.network === "tiktok")!;
  assert.equal(ig.slots, 12, "Instagram is untouched by the TikTok pause");
  assert.equal(tt.slots, 0);
  assert.equal(tt.allowed, false);
  assert.equal(tt.paused, true);
  assert.match(tt.reason, /PAUSED by config/);
});

test("the pause OVERRIDES the expired cooldown — no date can re-admit TikTok", () => {
  // The whole hazard: darkUntil has already passed, so without the pause the platform
  // would come back on a timer nobody re-approved. Check well past it, and far future.
  for (const when of ["2026-07-28T02:00:00Z", "2026-08-15T12:00:00Z", "2027-01-01T00:00:00Z"]) {
    const tt = P.decide(600, new Date(when)).find((x) => x.network === "tiktok")!;
    assert.equal(tt.slots, 0, `TikTok must get zero slots at ${when}`);
    assert.equal(tt.paused, true);
  }
});

test("a planned batch produces ZERO TikTok slots while paused", () => {
  // The end-to-end assertion: whatever budget is available, no slot times are handed out.
  for (const budget of [0, 12, 600]) {
    const tt = P.decide(budget).find((x) => x.network === "tiktok")!;
    assert.equal(tt.slots, 0);
    assert.deepEqual(
      P.slotTimes(tt.slots, { dayISO: "2026-08-01", startHour: 7, endHour: 22, minGapMinutes: tt.minGapMinutes }),
      [],
      "zero slots must yield zero scheduled times",
    );
  }
});

test("the cadence TikTok resumes on is PRESERVED while paused, not zeroed", () => {
  // A pause must not quietly destroy the settings we want back. Re-deriving 2/day and a
  // 4-hour floor from a transcript later is how they get lost.
  const tt = P.decide(600).find((x) => x.network === "tiktok")!;
  assert.equal(tt.minGapMinutes, 240, "the 4-hour floor is still configured");
  assert.match(tt.reason, /2\/day/, "the reason states the cadence it will resume on");
  assert.match(tt.reason, /HERMES_TIKTOK_PAUSED=false/, "and how to resume");
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

test("CLEARING the pause restores TikTok's normal allocation", async () => {
  const d = await decideWith({ HERMES_TIKTOK_PAUSED: "false" });
  const tt = d.find((x) => x.network === "tiktok");
  assert.ok(!tt.paused, "no longer reported as paused");
  assert.equal(tt.allowed, true);
  assert.equal(tt.slots, 2, "back to 2/day");
  assert.equal(tt.minGapMinutes, 240, "back behind the 4-hour floor");
});

test("unpausing TikTok still leaves Instagram exactly as it was", async () => {
  const d = await decideWith({ HERMES_TIKTOK_PAUSED: "false" });
  const ig = d.find((x) => x.network === "instagram");
  assert.equal(ig.slots, 12);
  assert.equal(ig.minGapMinutes, 56);
  assert.equal(ig.allowed, true);
});

test("the pause holds for any truthy spelling, and only 'false' clears it", async () => {
  for (const v of ["true", "1", "yes", "TRUE", ""]) {
    const tt = (await decideWith({ HERMES_TIKTOK_PAUSED: v })).find((x) => x.network === "tiktok");
    assert.equal(tt.slots, 0, `HERMES_TIKTOK_PAUSED="${v}" must keep TikTok paused`);
  }
  for (const v of ["false", "False", "FALSE"]) {
    const tt = (await decideWith({ HERMES_TIKTOK_PAUSED: v })).find((x) => x.network === "tiktok");
    assert.equal(tt.slots, 2, `HERMES_TIKTOK_PAUSED="${v}" must resume TikTok`);
  }
});

test("Instagram is unaffected by the TikTok pause at any budget", () => {
  for (const [budget, want] of [[600, 12], [12, 12], [5, 5]] as const) {
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

test("a cover expressed as a millisecond offset satisfies the gate", () => {
  const v = clean();
  delete (v as any).cover_url;
  (v as any).cover_ms = 3900;
  const r = G.publishGate(v as any, []);
  assert.equal(r.pass, true, r.reason);
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
