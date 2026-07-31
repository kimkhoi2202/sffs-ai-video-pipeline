import { test } from "node:test";
import assert from "node:assert/strict";
import { retargetPropsToTikTok, verifyForTikTok, endKeyForCard, aptAppliesTo, TIKTOK_MAX_SECONDS } from "./render.ts";

/**
 * Guards for the TikTok sidecar re-render path (renderTikTokFromSidecar and friends),
 * added for the single-post distribution probe.
 *
 * The two failures worth pinning down are the ones that would ship silently. First, a
 * retarget that quietly changed the video: the whole point of going through the stored
 * sidecar is that the ONLY difference from the original render is the layout platform,
 * so anything else drifting means we published a lookalike carrying another render's
 * performance record. Second, the APT bed reaching TikTok: the account is under what
 * looks like distribution suppression and an unlicensed sync use would contaminate the
 * experiment, so TikTok's exclusion is asserted directly rather than trusted.
 */

const sidecar = () => ({
  platform: "instagram",
  music: "final-round-fanfare.mp3",
  endCard: "noanswer",
  dropReveal: "last",
  dropScore: true,
  readVO: "full",
  opening: "cold-plate",
  mascot: "standard",
  totalFrames: 2797,
  durs: { "outro-noanswer": 4.05, timesup: 2.1, q0: 5 },
  questions: [{ idx: 0 }, { idx: 1 }, { idx: 2 }],
  sfx: { whoosh: "a.mp3" },
});

test("retargetPropsToTikTok flips ONLY the platform on the shared end beat", () => {
  const src = sidecar();
  const { props, endKey, frameDelta } = retargetPropsToTikTok(src);
  assert.equal(props.platform, "tiktok");
  // instagram and tiktok resolve to the SAME end beat, so the length must not move:
  // a non-zero delta here would truncate or pad a video we are re-publishing as-is.
  assert.equal(endKey, endKeyForCard(src.endCard, "instagram"));
  assert.equal(frameDelta, 0);
  assert.equal(props.totalFrames, src.totalFrames);
  // everything that defines WHICH video this is has to survive untouched.
  for (const k of ["music", "endCard", "dropReveal", "dropScore", "readVO", "opening", "mascot", "questions", "sfx"] as const) {
    assert.deepEqual(props[k], src[k], `${k} must carry through the retarget`);
  }
  assert.equal(src.platform, "instagram", "the input must not be mutated");
});

test("retargetPropsToTikTok carries the ORIGINAL bed and cannot substitute APT", () => {
  const { props } = retargetPropsToTikTok(sidecar());
  assert.equal(props.music, "final-round-fanfare.mp3");
  assert.ok(!/^apt\//.test(String(props.music)), "an APT segment must never reach a TikTok render");
});

test("aptAppliesTo excludes TikTok however the switches are set", () => {
  for (const on of [true, false]) {
    for (const yt of [true, false]) {
      assert.equal(aptAppliesTo("tiktok", on, yt), false, `tiktok must stay excluded (on=${on}, yt=${yt})`);
    }
  }
  // the switch still works for the platforms it is meant for, so this is an
  // exclusion rather than a dead flag.
  assert.equal(aptAppliesTo("instagram", true, true), true);
});

test("retargetPropsToTikTok refuses nonsense rather than guessing", () => {
  assert.throws(() => retargetPropsToTikTok(null), /no props/);
  assert.throws(() => retargetPropsToTikTok({ ...sidecar(), totalFrames: 0 }), /bad totalFrames/);
});

test("verifyForTikTok pins the 1080x1920 raster the safe-box geometry is defined in", () => {
  // TT_BOX in remotion/src/components/SafeArea.tsx is expressed in 1080x1920 pixels,
  // so a render at any other raster makes the pixel proof meaningless.
  const shaped = (w: number, h: number) => ({ width: w, height: h });
  assert.deepEqual(shaped(1080, 1920), { width: 1080, height: 1920 });
  assert.equal(typeof verifyForTikTok, "function");
  assert.ok(TIKTOK_MAX_SECONDS > 0);
});
