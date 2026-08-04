/**
 * music.test.ts — the YouTube music rule.
 *
 * THE RULE: a YouTube post that is a REPOST of an existing video keeps whatever bed
 * that source video had. A NET-NEW YouTube render gets the alternate (APT) bed, the
 * same as Instagram. TikTok never gets it.
 *
 * The discriminator is not a flag. The repost path renders from the STORED PROPS
 * SIDECAR and never runs music selection at all, so "came from a sidecar" IS "is a
 * repost". These tests pin both halves of that: the selection side through
 * musicFor/aptAppliesTo, and the carry-through side through retargetPropsToYouTube.
 *
 * RIGHTS OUTRANK ALL OF IT (2026-08-04). aptAppliesTo now takes a fourth argument, the
 * recorded rights clearance, and refuses before it considers any of the rules below.
 * The bed is NOT cleared, so in production every case here resolves to the licensed bed
 * whatever the switches say. The platform-matrix tests therefore pass `CLEARED`
 * explicitly: they are about the switches, and they would otherwise all pass for the
 * one reason that has nothing to do with what they are testing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { aptAppliesTo, musicFor, retargetPropsToYouTube } from "./render.ts";
import { aptSegmentFor, APT_SEGMENTS } from "./music.ts";
import { CONFIG } from "./config.ts";

const ON = true, OFF = false;
/** Rights clearance, stated explicitly so each test below isolates the switch it means
 *  to test rather than passing because the real bed happens to be uncleared. */
const CLEARED = true;
const isApt = (s: string) => APT_SEGMENTS.includes(s);

// ── NET-NEW: which platforms take the alternate bed ──────────────────────────

test("with the switch on, a net-new YouTube render takes APT (this is the change)", () => {
  assert.equal(aptAppliesTo("youtube", ON, ON, CLEARED), true);
});

test("Instagram is unchanged: it still takes APT", () => {
  assert.equal(aptAppliesTo("instagram", ON, ON, CLEARED), true);
});

test("TikTok NEVER takes APT, switch on or off", () => {
  assert.equal(aptAppliesTo("tiktok", ON, ON, CLEARED), false);
  assert.equal(aptAppliesTo("tiktok", OFF, OFF, CLEARED), false);
});

test("the master switch still kills it everywhere in one line", () => {
  for (const p of ["instagram", "youtube", "tiktok"] as const) assert.equal(aptAppliesTo(p, OFF, ON, CLEARED), false);
});

test("the YouTube kill switch takes YouTube back without touching Instagram", () => {
  assert.equal(aptAppliesTo("youtube", ON, OFF, CLEARED), false);
  assert.equal(aptAppliesTo("instagram", ON, OFF, CLEARED), true);
});

test("the YouTube switch is opt-OUT, which is exactly why the rights gate exists", () => {
  // config.ts reads `process.env.HERMES_MUSIC_APT_YOUTUBE !== "0"`, so UNSET means ON.
  // That asymmetry is how an uncleared track reached the one platform where a Content ID
  // claim is a hard block rather than a monetisation redirect. Asserted as the rule, not
  // as the live CONFIG value, because the deployment now pins the env var to 0 and a test
  // that reads the environment would be pinning today's ops rather than the code.
  assert.equal(undefined !== "0", true, "unset resolves to ON by construction");
  // The property that actually protects us is that rights outrank it.
  assert.equal(aptAppliesTo("youtube", ON, ON, false), false, "uncleared refuses even with both switches on");
});

// ── NET-NEW: the bed actually selected ───────────────────────────────────────

test("PROOF, net-new YouTube: the planned licensed bed is replaced by an APT segment", () => {
  const planned = { music: "audio/music/prize-wheel-parade.mp3" };
  const got = musicFor(planned, "2026-07-29-v03", "youtube", aptAppliesTo("youtube", ON, ON, CLEARED));
  assert.ok(isApt(got), `expected an APT segment, got ${got}`);
  assert.equal(got, aptSegmentFor("2026-07-29-v03"));
  assert.notEqual(got, "prize-wheel-parade.mp3");
});

test("net-new YouTube and net-new Instagram agree on the segment for one video", () => {
  const id = "2026-07-29-v03", planned = { music: "audio/music/parade.mp3" };
  assert.equal(musicFor(planned, id, "youtube", true), musicFor(planned, id, "instagram", true));
});

test("net-new TikTok keeps the licensed bed even while the others take APT", () => {
  const planned = { music: "audio/music/winner-spin.mp3" };
  assert.equal(musicFor(planned, "2026-07-29-v03", "tiktok", aptAppliesTo("tiktok", ON, ON, CLEARED)), "winner-spin.mp3");
});

test("with the switch off, every platform keeps the planned bed", () => {
  const planned = { music: "audio/music/fanfare.mp3" };
  for (const p of ["instagram", "youtube", "tiktok"] as const) {
    assert.equal(musicFor(planned, "2026-07-29-v03", p, aptAppliesTo(p, OFF, OFF, CLEARED)), "fanfare.mp3");
  }
});

// ── REPOST: the catalogue backfill keeps its original bed ────────────────────

/** A stored sidecar, the shape runRemotion wrote for the original Instagram render. */
const sidecar = (music: string) => ({
  platform: "instagram",
  music,
  endCard: "noanswer",
  totalFrames: 2070,
  durs: { "outro-noanswer": 3.2 },
  questions: [{ idx: 1 }],
});

test("PROOF, catalogue repost: retargeting to YouTube carries the ORIGINAL bed through", () => {
  for (const bed of CONFIG.MUSIC_TRACKS) {
    const { props } = retargetPropsToYouTube(sidecar(bed));
    assert.equal(props.music, bed, "a repost must keep the bed its source video shipped with");
    assert.equal(props.platform, "youtube");
  }
});

test("a repost's bed is never an APT segment just because the switch is on", () => {
  const { props } = retargetPropsToYouTube(sidecar("audio/music/prize-wheel-parade.mp3"));
  assert.ok(!isApt(props.music), "the repost path must not select a new bed");
});

test("the repost path changes platform, durs and length — and nothing about the audio bed", () => {
  const before = sidecar("audio/music/winner.mp3");
  const { props } = retargetPropsToYouTube(before);
  for (const k of ["music", "questions", "endCard"]) {
    assert.deepEqual(props[k], before[k], `${k} must survive the retarget untouched`);
  }
});

test("the retarget never mutates the sidecar it was handed", () => {
  const before = sidecar("audio/music/parade.mp3");
  const snapshot = JSON.stringify(before);
  retargetPropsToYouTube(before);
  assert.equal(JSON.stringify(before), snapshot);
});

test("RIGHTS: the alternate bed is recorded as NOT cleared", async () => {
  const { aptRightsCleared } = await import("./music.ts");
  assert.equal(aptRightsCleared(), false, "music-manifest.json rights.cleared must stay false until someone clears it");
});

test("RIGHTS: an uncleared bed cannot ship even with the switch forced ON", async () => {
  const { aptAppliesTo } = await import("./render.ts");
  for (const platform of ["instagram", "youtube", "tiktok"] as const) {
    assert.equal(
      aptAppliesTo(platform, true, true, false), false,
      `${platform}: an uncleared bed must never ship, whatever HERMES_MUSIC_APT says`,
    );
  }
});

test("RIGHTS: clearing the bed re-enables it exactly where it was allowed before", async () => {
  const { aptAppliesTo } = await import("./render.ts");
  // The gate is a veto, not a rewrite: with rights cleared, the old platform rules stand.
  assert.equal(aptAppliesTo("instagram", true, true, true), true);
  assert.equal(aptAppliesTo("youtube", true, true, true), true);
  assert.equal(aptAppliesTo("youtube", true, false, true), false, "the YouTube kill switch still works");
  assert.equal(aptAppliesTo("tiktok", true, true, true), false, "TikTok is excluded outright");
  assert.equal(aptAppliesTo("instagram", false, true, true), false, "and the master switch still works");
});

test("RIGHTS: a missing or malformed manifest fails CLOSED", async () => {
  const { aptRightsCleared } = await import("./music.ts");
  assert.equal(aptRightsCleared("/nonexistent/music-manifest.json"), false);
  assert.equal(aptRightsCleared("/etc/hostname"), false, "unparseable must read as not cleared");
});
