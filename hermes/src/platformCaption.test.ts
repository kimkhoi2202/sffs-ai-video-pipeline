/**
 * platformCaption.test.ts — the per-network caption substitution layer.
 *
 * The bug this pins: the designer writes ONE caption and it went to Instagram, TikTok
 * and YouTube byte-identical, so YouTube captions said "follow for more" when the verb
 * there is SUBSCRIBE — while the RENDERED video already said SUBSCRIBE (Outro.tsx),
 * making the caption the only surface still wrong. Plus the class of the same bug:
 * "#fyp" and "#puzzletok" are TikTok vernacular that mean nothing on a YouTube channel.
 *
 * The tests are written against the ACTUAL captions on the live board on 2026-07-28,
 * not invented strings, so a regression here is a regression against real copy.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { captionForNetwork, substituteFor, vanityUrl } from "./platformCaption.ts";
import { goLink, withAttribution, stripTrackerLinks, withLink } from "./attribution.ts";

// The exact text of the published 5:41pm YouTube canary (uuid 51656492686459260).
const CANARY =
  "are you a SMART fella or a FART smella? comment your answer below and follow for more \u{1F447}\n\n" +
  "https://smartfellaorfartsmella.com/go/2026-07-25-v02\n\n" +
  "#smartorfart #iqtest #puzzletok #riddles #mindgames";

// The exact text of the first pending Instagram draft (uuid -8653649687801737780).
const IG_DRAFT =
  "bet you can't get this one right. drop your answer in the comments and let's see if you're a " +
  "SMART FELLA or FART SMELLA \u{1F9E0} follow for more brain breaks\n\n" +
  "https://smartfellaorfartsmella.com/go/2026-07-28-v01\n\n" +
  "#fyp #foryou #quiz #trivia #brainteaser";

// ── THE BUG ──────────────────────────────────────────────────────────────────

test("YouTube: the follow nudge becomes a subscribe nudge", () => {
  const out = captionForNetwork(CANARY, "youtube");
  assert.match(out, /subscribe for more/);
  assert.doesNotMatch(out, /\bfollow\b/i);
});

test("Instagram keeps 'follow' — it is the right verb there", () => {
  const out = captionForNetwork(CANARY, "instagram");
  assert.match(out, /follow for more/);
  assert.doesNotMatch(out, /\bsubscribe\b/i);
});

test("TikTok keeps 'follow' too", () => {
  assert.match(captionForNetwork(CANARY, "tiktok"), /follow for more/);
});

test("the substitution is case preserving, so the shouty variants survive", () => {
  assert.equal(substituteFor("FOLLOW FOR MORE", "youtube"), "SUBSCRIBE FOR MORE");
  assert.equal(substituteFor("Follow for more", "youtube"), "Subscribe for more");
  assert.equal(substituteFor("follow for more", "youtube"), "subscribe for more");
});

test("the whole follow word family moves, not just the bare verb", () => {
  assert.equal(substituteFor("10k followers", "youtube"), "10k subscribers");
  assert.equal(substituteFor("thanks for following", "youtube"), "thanks for subscribing");
});

test("the mirror of the bug is also a bug: 'subscribe' is corrected on IG and TikTok", () => {
  assert.match(substituteFor("subscribe for more", "instagram"), /follow for more/);
  assert.match(substituteFor("subscribe for more", "tiktok"), /follow for more/);
});

// ── THE CLASS: platform-native hashtags ──────────────────────────────────────

test("YouTube: #fyp and #foryou become the tags that do that job on YouTube", () => {
  const out = captionForNetwork(IG_DRAFT, "youtube");
  assert.doesNotMatch(out, /#fyp\b/);
  assert.doesNotMatch(out, /#foryou\b/);
  assert.match(out, /#shorts\b/);
  assert.match(out, /#youtubeshorts\b/);
});

test("YouTube: the -tok suffix does not survive the trip", () => {
  const out = captionForNetwork(CANARY, "youtube");
  assert.doesNotMatch(out, /#puzzletok\b/);
  assert.match(out, /#puzzles\b/);
});

test("CLASS FIX: an unlisted -tok tag is handled without another code change", () => {
  assert.equal(substituteFor("#quiztok", "youtube"), "#quiz");
  // Instagram and TikTok keep their wording: the base caption IS the Instagram voice.
  assert.equal(substituteFor("#quiztok", "instagram"), "#quiztok");
  assert.equal(substituteFor("#quiztok", "tiktok"), "#quiztok");
});

test("the -tok rule is guarded: #tiktok is a product name, and no stub tags", () => {
  assert.equal(substituteFor("#tiktok", "youtube"), "#tiktok");
  assert.equal(substituteFor("#ontok", "youtube"), "#ontok"); // stem too short to be a word
});

test("the brand's own tags are left alone on every network", () => {
  for (const n of ["instagram", "youtube", "tiktok"] as const) {
    const out = captionForNetwork(CANARY, n);
    for (const tag of ["#smartorfart", "#iqtest", "#riddles", "#mindgames"]) assert.match(out, new RegExp(tag));
  }
});

test("a hashtag is never rewritten by the prose rule that owns the same word", () => {
  // "#followme" is a tag, not the verb; only the bare verb moves.
  assert.equal(substituteFor("#followme follow me", "youtube"), "#followme subscribe me");
});

test("'link in bio' is Instagram furniture and reads wrong in a YouTube description", () => {
  assert.match(substituteFor("link in bio", "youtube"), /link below/);
  assert.match(substituteFor("link in bio", "instagram"), /link in bio/);
});

// ── THE VANITY LINK ──────────────────────────────────────────────────────────

test("the per-post /go/ tracker is replaced by the platform vanity URL", () => {
  for (const n of ["instagram", "youtube", "tiktok"] as const) {
    const out = captionForNetwork(CANARY, n);
    assert.doesNotMatch(out, /\/go\//, `${n} still carries a /go/ tracker`);
    assert.ok(out.includes(`https://www.smartfellaorfartsmella.com/${n}`), `${n} is missing its vanity URL`);
  }
});

test("the vanity path is the point — never collapsed to the bare apex", () => {
  assert.equal(vanityUrl("instagram"), "https://www.smartfellaorfartsmella.com/instagram");
  assert.equal(vanityUrl("youtube"), "https://www.smartfellaorfartsmella.com/youtube");
  assert.equal(vanityUrl("tiktok"), "https://www.smartfellaorfartsmella.com/tiktok");
});

test("www, not the apex: the apex only 308s to www before anything is attributed", () => {
  for (const n of ["instagram", "youtube", "tiktok"] as const) assert.match(vanityUrl(n), /^https:\/\/www\./);
});

test("the link sits above the trailing hashtag block, where it stays visible", () => {
  const lines = captionForNetwork(CANARY, "youtube").split("\n").filter((l) => l.trim());
  const linkAt = lines.findIndex((l) => l.includes("/youtube"));
  const tagsAt = lines.findIndex((l) => l.trim().startsWith("#"));
  assert.ok(linkAt >= 0 && tagsAt >= 0 && linkAt < tagsAt, "link must precede the hashtags");
});

test("idempotent: the backfill re-reads and rewrites live posts", () => {
  for (const n of ["instagram", "youtube", "tiktok"] as const) {
    const once = captionForNetwork(CANARY, n);
    assert.equal(captionForNetwork(once, n), once);
  }
});

test("re-adapting an already-adapted caption does not stack links", () => {
  const yt = captionForNetwork(CANARY, "youtube");
  const back = captionForNetwork(yt, "instagram");
  assert.equal((back.match(/smartfellaorfartsmella\.com/g) || []).length, 1);
  assert.ok(back.includes("/instagram"));
});

// ── WHAT MUST NOT MOVE ───────────────────────────────────────────────────────

test("the /go/ builder and route stay: published captions still point at them", () => {
  assert.equal(goLink("2026-07-25-v02"), "https://smartfellaorfartsmella.com/go/2026-07-25-v02");
  assert.match(withAttribution("caption\n\n#a #b", "v1"), /\/go\/v1/);
});

test("stripTrackerLinks leaves a URL a human put in the copy alone", () => {
  const kept = "watch the long one at https://example.com/x\n\nhttps://smartfellaorfartsmella.com/go/v1";
  const out = stripTrackerLinks(kept);
  assert.match(out, /example\.com\/x/);
  assert.doesNotMatch(out, /\/go\/v1/);
});

test("withLink is idempotent and still appends when there are no hashtags", () => {
  const once = withLink("just words", "https://x.test/y");
  assert.equal(withLink(once, "https://x.test/y"), once);
  assert.match(once, /just words[\s\S]*https:\/\/x\.test\/y/);
});

test("BRAND RULES survive the substitution: no em dash, at most one emoji", () => {
  for (const n of ["instagram", "youtube", "tiktok"] as const) {
    for (const base of [CANARY, IG_DRAFT]) {
      const out = captionForNetwork(base, n);
      assert.doesNotMatch(out, /\u2014/, "em dash introduced");
      const emoji = (out.match(/\p{Extended_Pictographic}/gu) || []).length;
      assert.ok(emoji <= 1, `${n}: ${emoji} emoji`);
    }
  }
});

test("the nudge survives: a caption that had one still has one on every network", () => {
  for (const n of ["instagram", "youtube", "tiktok"] as const) {
    assert.match(captionForNetwork(CANARY, n), /\b(follow|subscribe) for more\b/);
  }
});

test("nothing but the platform-bound words changes — the hook is untouched", () => {
  const out = captionForNetwork(CANARY, "youtube");
  assert.match(out, /^are you a SMART fella or a FART smella\? comment your answer below/);
});
