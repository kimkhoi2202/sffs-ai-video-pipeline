/**
 * hooks.test.ts — the SPOKEN OPENING HOOK.
 *
 * The invariant this file exists to defend is that a spoken hook costs ZERO extra time.
 * It rides over the 2.2s motion opening that the motion-hook arm already pays for, so
 * question one must arrive at exactly the same frame whether the animation is wordless
 * or carrying a line. If that ever stops being true the arm silently becomes the serial
 * delay it was built to replace, and the comparison against the cold plate is dead.
 *
 * Frame parity against the Remotion timeline itself cannot be asserted here:
 * remotion/src/full/timeline.ts is written for a bundler (extensionless imports all the
 * way down) and Node's ESM loader cannot import it. It is proven end to end by
 * tools/render-hook-proof.ts, which renders real video and measures question one's
 * arrival out of the muxed file. What is pinned here is render.ts's own maths, the
 * cold-plate exclusion, and the budget filter.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { computeShortFrames, mapProps, type Mapped } from "./render.ts";
import { speakHook, planBeats } from "./narration.ts";
import { eligible, pickHook, hookArms, HOOK_BUDGET_SEC, HOOK_SELECT_MAX_SEC, type HookOpening } from "./hooks.ts";

const DURS: Record<string, number> = { q1: 4, q2: 5, q3: 3.5, r1: 3, r2: 2.5, r3: 2, timesup: 0.8, "outro-noanswer": 3.2, hook: 1.9 };
const rq = (idx: number) => ({ idx, countdown: 5, kind: "text", tier: "ODD ONE OUT", ansLetter: "A", ansLabel: "a", explanation: "x", qDur: 0, rDur: 0, bg: "#000", tierColor: "#000", accent: "#000", question: "Q", questionFontSize: 62, options: [] }) as any;

const mapped = (opening: "cold-plate" | "motion-hook", hook?: Mapped["hook"]): Mapped => ({
  questions: [rq(1), rq(2), rq(3)],
  reveals: [],
  ending: { dropReveal: "last", dropScore: true, endCard: "noanswer" } as any,
  mode: "full",
  readVO: "full",
  opening,
  hook,
});

const HOOK = { title: "ONLY 1% PASS", subtitle: "can you get all 3?", vo: "Only one percent pass." };

test("THE INVARIANT: a spoken hook adds ZERO frames to the motion arm", () => {
  const silent = computeShortFrames(mapped("motion-hook"), DURS, "tiktok");
  const spoken = computeShortFrames(mapped("motion-hook", HOOK), DURS, "tiktok");
  assert.equal(spoken, silent, "the hook must ride the animation, never extend it");
});

test("the motion opening still costs exactly its 2.2s against the cold plate", () => {
  const cold = computeShortFrames(mapped("cold-plate"), DURS, "tiktok");
  const motion = computeShortFrames(mapped("motion-hook"), DURS, "tiktok");
  assert.equal(motion - cold, Math.round(2.2 * 30));
});

test("NO REGRESSION: cold-plate is untouched by any of this", () => {
  const withHookProp = computeShortFrames(mapped("cold-plate", HOOK), DURS, "tiktok");
  assert.equal(withHookProp, computeShortFrames(mapped("cold-plate"), DURS, "tiktok"));
});

test("mapProps REFUSES a hook on cold-plate, so no arm can be serially delayed", () => {
  const base = { questions: [{ kind: "text", tier: "ODD ONE OUT", prompt: "P", options: ["a", "b", "c", "d"], answer: "a" }], reveal: "allButLast", countdownSec: 5, narration: { mode: "full" } };
  assert.equal(mapProps({ ...base, opening: "cold-plate", hook: HOOK }).hook, undefined);
  assert.deepEqual(mapProps({ ...base, opening: "motion-hook", hook: HOOK }).hook, HOOK);
});

test("the hook beat leads the VO plan and never collides with question clip indexing", () => {
  assert.equal(planBeats([], "none", "Only one percent pass.").length, 0, "music-only arms stay silent");
  const beats = planBeats([], "full", "Only one percent pass.");
  assert.equal(beats.length, 1);
  assert.equal(beats[0].beat, "hook");
  assert.equal(beats[0].index, -1);
});

test("speakHook turns percentages into words for TTS", () => {
  assert.equal(speakHook("97% get this wrong."), "ninety-seven percent get this wrong.");
  assert.equal(speakHook("9 out of 10 people pick B."), "nine out of ten people pick B.");
  assert.equal(/\d/.test(speakHook("97% and 3 and 9/10")), false, "no digits may survive into TTS text");
});

const O = (over: Partial<HookOpening>): HookOpening => ({
  id: "t", mechanism: "m", vo: "v", vo_sec: 1.5, plate: { title: "T", subtitle: "s" }, claim_class: "none", requires: null, ...over,
});
const CTX = { numQ: 3, countdownSec: 5, ending: "cliffhanger" };

test("the BUDGET FILTER refuses any line that will not fit inside the animation", () => {
  assert.ok(HOOK_SELECT_MAX_SEC < HOOK_BUDGET_SEC, "selection must hold back headroom for TTS drift");
  assert.equal(eligible(O({ vo_sec: HOOK_SELECT_MAX_SEC }), CTX), true, "exactly on the offer threshold fits");
  assert.equal(eligible(O({ vo_sec: HOOK_SELECT_MAX_SEC + 0.01 }), CTX), false);
  // Inside the hard budget but inside the margin too: refused, because a bad TTS roll
  // would push it over and cost the video its hook entirely.
  assert.equal(eligible(O({ vo_sec: HOOK_BUDGET_SEC }), CTX), false);
  assert.equal(eligible(O({ vo_sec: undefined }), CTX), false, "unmeasured must fail closed, never be guessed");
  assert.equal(eligible(O({ vo_sec: 0 }), CTX), false);
});

test("`requires` keeps a line from asserting something the render contradicts", () => {
  assert.equal(eligible(O({ requires: { numQ: 3 } }), CTX), true);
  assert.equal(eligible(O({ requires: { numQ: 1 } }), CTX), false);
  // "one answer stays hidden" must not ship on a full-reveal arm.
  assert.equal(eligible(O({ requires: { ending: "cliffhanger" } }), { ...CTX, ending: "full-reveal" }), false);
  assert.equal(eligible(O({ requires: { countdownSec: 5 } }), { ...CTX, countdownSec: 3 }), false);
});

test("every opening arm in the bank yields a line that is in voice, in budget and fillable", () => {
  const ctx = { ...CTX, wrongLetters: ["B", "C", "D"] };
  const arms = hookArms();
  assert.ok(arms.length >= 6, `expected opening arms in the bank, got ${arms.length}`);
  for (const { mechanism, arm } of arms) {
    const h = pickHook(mechanism, `seed:${arm}`, ctx);
    assert.ok(h, `${arm} produced no line`);
    const all = h.title + h.vo + (h.subtitle ?? "");
    assert.equal(/\{[A-Z]+\}/.test(all), false, `${arm} shipped an unresolved placeholder`);
    assert.equal(/\u2014|\u2013/.test(all), false, `${arm} contains an em/en dash`);
    assert.ok(arm.startsWith("motion-hook-"), `${arm} must sit on the opening axis`);
  }
});

test("a {WRONG} decoy is refused rather than guessed when no wrong letter is known", () => {
  const bank = { openings: [O({ id: "d", mechanism: "decoy", vo: "Everybody picks {WRONG}.", plate: { title: "9 IN 10 PICK {WRONG}" }, fill: { "{WRONG}": "a non-answer letter" } })] };
  assert.equal(pickHook("decoy", "s", { ...CTX, wrongLetters: [] }, bank), null);
  assert.equal(pickHook("decoy", "s", { ...CTX, wrongLetters: ["C"] }, bank)?.vo, "Everybody picks C.");
});

test("pickHook is deterministic in its seed (a re-render reuses the cached hook.mp3)", () => {
  const ctx = { ...CTX, wrongLetters: ["B"] };
  assert.deepEqual(pickHook("stated-difficulty-stat", "run-42:x", ctx), pickHook("stated-difficulty-stat", "run-42:x", ctx));
});
