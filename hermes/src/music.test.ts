/**
 * music.test.ts — the YouTube music rule.
 *
 * THE RULE (owner's decision, 2026-08-07): the APT bed is PERMITTED on Instagram and
 * TikTok and MUST NOT reach YouTube. It is a per-platform rule, not a global ban, and it
 * applies to the bed a render is about to use no matter where that bed came from.
 *
 * WHAT CHANGED, and why two tests below were rewritten rather than deleted. The rule
 * used to be about SELECTION only: net-new YouTube renders took APT like Instagram, and
 * a repost kept whatever bed its sidecar named. That second half was the hole. The
 * catalogue backfill renders from a STORED PROPS SIDECAR and never runs music selection,
 * so it faithfully reproduced APT beds for YouTube while HERMES_MUSIC_APT=0,
 * HERMES_MUSIC_APT_YOUTUBE=0 and rights.cleared=false all said no — every one of those
 * governs selection, and none of them governs a bed that is already in a sidecar.
 *
 * So the bed is now decided at RENDER time and the sidecar is not authority. These tests
 * pin all three layers: selection (musicFor/aptAppliesTo), the platform rule applied to
 * the repost path (retargetPropsToYouTube), and the hard refusal at the render call
 * (assertBedAllowed) that catches anything which skipped the rule entirely.
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
import { aptAppliesTo, musicFor, retargetPropsToYouTube, bedForPlatform, assertBedAllowed } from "./render.ts";
import { aptSegmentFor, APT_SEGMENTS } from "./music.ts";
import { isAptBed, aptPermittedOn } from "../../remotion/src/data/musicPolicy.ts";
import { CONFIG } from "./config.ts";

const ON = true, OFF = false;
/** Rights clearance, stated explicitly so each test below isolates the switch it means
 *  to test rather than passing because the real bed happens to be uncleared. */
const CLEARED = true;
const isApt = (s: string) => APT_SEGMENTS.includes(s);
/** The licensed pool, in the stripped form a props sidecar stores. */
const LICENSED = CONFIG.MUSIC_TRACKS.map((t) => t.replace(/^audio\/music\//, ""));

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

test("PROOF, net-new Instagram: the planned licensed bed is replaced by an APT segment", () => {
  const planned = { music: "audio/music/prize-wheel-parade.mp3" };
  const got = musicFor(planned, "2026-07-29-v03", "instagram", aptAppliesTo("instagram", ON, ON, CLEARED));
  assert.ok(isApt(got), `expected an APT segment, got ${got}`);
  assert.equal(got, aptSegmentFor("2026-07-29-v03"));
  assert.notEqual(got, "prize-wheel-parade.mp3");
});

test("PROOF, net-new YouTube: selection may say APT, and the platform rule still refuses it", () => {
  // `applies` is forced true, which is the strongest form of the old behaviour: switches
  // on, rights cleared, selection resolved to an APT segment. YouTube still must not get
  // it, and the caller gets a licensed bed rather than an error, so the video still ships.
  const planned = { music: "audio/music/prize-wheel-parade.mp3" };
  const got = musicFor(planned, "2026-07-29-v03", "youtube", true);
  assert.ok(!isApt(got), `APT reached a YouTube render: ${got}`);
  assert.ok(LICENSED.includes(got), `expected a licensed bed, got ${got}`);
});

test("net-new YouTube and net-new Instagram now DISAGREE, which is the whole point", () => {
  const id = "2026-07-29-v03", planned = { music: "audio/music/parade.mp3" };
  const ig = musicFor(planned, id, "instagram", true);
  const yt = musicFor(planned, id, "youtube", true);
  assert.ok(isApt(ig), "Instagram is still permitted the alternate bed");
  assert.ok(!isApt(yt), "YouTube is not");
  assert.notEqual(ig, yt);
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

// ── THE PER-PLATFORM RULE: a sidecar naming APT cannot produce a YouTube render ──

/**
 * These are the tests the 2026-08-07 incident asked for. A stored sidecar naming an APT
 * bed is not a hypothetical: 82 of them sit in RENDERS_DIR, and re-rendering from them is
 * exactly what put uncleared music in the YouTube queue.
 */

test("PROOF: a sidecar naming an APT bed CANNOT produce a YouTube render carrying it", () => {
  for (const seg of APT_SEGMENTS) {
    const { props } = retargetPropsToYouTube(sidecar(seg), "2026-08-04-v11");
    assert.ok(!isApt(props.music), `sidecar ${seg} still reached a YouTube render as ${props.music}`);
    assert.ok(LICENSED.includes(props.music), `expected a licensed bed, got ${props.music}`);
    assert.equal(props.platform, "youtube");
  }
});

test("PROOF: the same holds for the `audio/music/` prefixed form a sidecar may store", () => {
  const { props } = retargetPropsToYouTube(sidecar("audio/music/apt/apt-05.mp3"), "2026-08-04-v11");
  assert.ok(!isApt(props.music), `prefixed APT path survived: ${props.music}`);
});

test("the substituted bed is stable: the same video re-renders to the same bed", () => {
  const a = retargetPropsToYouTube(sidecar("apt/apt-05.mp3"), "2026-08-04-v11").props.music;
  const b = retargetPropsToYouTube(sidecar("apt/apt-05.mp3"), "2026-08-04-v11").props.music;
  assert.equal(a, b, "a re-render must not drift to a different bed");
});

test("Instagram and TikTok MAY carry APT — this is a platform rule, not a ban", () => {
  for (const platform of ["instagram", "tiktok"] as const) {
    assert.equal(aptPermittedOn(platform), true);
    assert.equal(bedForPlatform("apt/apt-05.mp3", platform, "2026-08-04-v11"), "apt/apt-05.mp3",
      `${platform} must keep the bed it was given`);
  }
  assert.equal(aptPermittedOn("youtube"), false);
});

test("a licensed bed passes through completely untouched, prefix and all", () => {
  for (const bed of CONFIG.MUSIC_TRACKS) {
    for (const platform of ["youtube", "instagram", "tiktok"] as const) {
      assert.equal(bedForPlatform(bed, platform, "2026-08-04-v11"), bed);
    }
  }
  assert.equal(bedForPlatform(undefined, "youtube", "x"), undefined, "no bed stays no bed");
});

test("the rule is directory membership, not a substring match on \"apt\"", () => {
  // A licensed bed whose NAME happens to contain "apt" must not be treated as APT.
  for (const notApt of ["adaptive-parade.mp3", "audio/music/apt-ish.mp3", "captions.mp3", "apt.mp3"]) {
    assert.equal(isAptBed(notApt), false, `${notApt} must not read as an APT bed`);
    assert.equal(bedForPlatform(notApt, "youtube", "x"), notApt);
  }
  for (const seg of APT_SEGMENTS) {
    assert.equal(isAptBed(seg), true);
    assert.equal(isAptBed(`audio/music/${seg}`), true, "the prefixed form must read the same");
  }
});

test("LAST LINE: the render call itself refuses an APT bed bound for YouTube", () => {
  assert.throws(
    () => assertBedAllowed("2026-08-04-v11", "youtube", "apt/apt-05.mp3"),
    /must never reach youtube/,
    "a render that skipped bedForPlatform must fail loudly, not ship",
  );
  assert.throws(() => assertBedAllowed("x", "youtube", "audio/music/apt/apt-01.mp3"), /must never reach youtube/);
});

test("LAST LINE: it stays out of the way of every legal render", () => {
  for (const platform of ["instagram", "tiktok"] as const) {
    assertBedAllowed("2026-08-04-v11", platform, "apt/apt-05.mp3"); // permitted
  }
  for (const bed of CONFIG.MUSIC_TRACKS) {
    for (const platform of ["youtube", "instagram", "tiktok"] as const) assertBedAllowed("x", platform, bed);
  }
  assertBedAllowed("x", "youtube", undefined);
});

test("the retarget still does not mutate a sidecar it has to substitute a bed for", () => {
  const before = sidecar("apt/apt-05.mp3");
  const snapshot = JSON.stringify(before);
  retargetPropsToYouTube(before, "2026-08-04-v11");
  assert.equal(JSON.stringify(before), snapshot);
});

test("REGRESSION 2026-08-07: the exact sidecar that shipped to the YouTube queue", () => {
  // 2026-08-04-v11's stored sidecar names apt/apt-05.mp3, and the MP4 the backfill
  // produced from it was audio-verified as carrying that bed. Re-rendering the same
  // sidecar through the same function must now produce a licensed bed instead.
  const { props } = retargetPropsToYouTube(
    { platform: "instagram", music: "apt/apt-05.mp3", endCard: "noanswer",
      totalFrames: 1040, durs: { "outro-noanswer": 3.2 }, questions: [{ idx: 1 }] },
    "2026-08-04-v11",
  );
  assert.ok(!isApt(props.music), `the incident would repeat: ${props.music}`);
});
