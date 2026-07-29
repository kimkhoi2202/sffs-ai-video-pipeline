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
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { aptAppliesTo, musicFor, retargetPropsToYouTube } from "./render.ts";
import { aptSegmentFor, APT_SEGMENTS } from "./music.ts";
import { CONFIG } from "./config.ts";

const ON = true, OFF = false;
const isApt = (s: string) => APT_SEGMENTS.includes(s);

// ── NET-NEW: which platforms take the alternate bed ──────────────────────────

test("with the switch on, a net-new YouTube render takes APT (this is the change)", () => {
  assert.equal(aptAppliesTo("youtube", ON, ON), true);
});

test("Instagram is unchanged: it still takes APT", () => {
  assert.equal(aptAppliesTo("instagram", ON, ON), true);
});

test("TikTok NEVER takes APT, switch on or off", () => {
  assert.equal(aptAppliesTo("tiktok", ON, ON), false);
  assert.equal(aptAppliesTo("tiktok", OFF, OFF), false);
});

test("the master switch still kills it everywhere in one line", () => {
  for (const p of ["instagram", "youtube", "tiktok"] as const) assert.equal(aptAppliesTo(p, OFF, ON), false);
});

test("the YouTube kill switch takes YouTube back without touching Instagram", () => {
  assert.equal(aptAppliesTo("youtube", ON, OFF), false);
  assert.equal(aptAppliesTo("instagram", ON, OFF), true);
});

test("the YouTube switch defaults ON, so MUSIC_APT alone is enough to enable it", () => {
  assert.equal(CONFIG.MUSIC_APT_YOUTUBE, true);
});

// ── NET-NEW: the bed actually selected ───────────────────────────────────────

test("PROOF, net-new YouTube: the planned licensed bed is replaced by an APT segment", () => {
  const planned = { music: "audio/music/prize-wheel-parade.mp3" };
  const got = musicFor(planned, "2026-07-29-v03", "youtube", aptAppliesTo("youtube", ON, ON));
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
  assert.equal(musicFor(planned, "2026-07-29-v03", "tiktok", aptAppliesTo("tiktok", ON, ON)), "winner-spin.mp3");
});

test("with the switch off, every platform keeps the planned bed", () => {
  const planned = { music: "audio/music/fanfare.mp3" };
  for (const p of ["instagram", "youtube", "tiktok"] as const) {
    assert.equal(musicFor(planned, "2026-07-29-v03", p, aptAppliesTo(p, OFF, OFF)), "fanfare.mp3");
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
