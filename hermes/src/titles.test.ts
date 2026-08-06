/**
 * titles.test.ts — the three things a post carries that were being DERIVED BADLY or not
 * at all: the standalone title, the media alt text, and the brand corpus the copy judge
 * is calibrated against. All three were regressions rather than gaps, and all three are
 * user-visible.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { titleFromCaption, loadBrandVoice, ruleCheckCopy } from "./brand.ts";
import { CONFIG } from "./config.ts";
import { altTextFor } from "./loopPublish.ts";
import { YT_TITLE_MAX, TIKTOK_TITLE_MAX, buildCreateBody } from "./metricool.ts";

// ── the derived title (the FALLBACK path; a real title is written by makeTitle) ──

test("a derived title stops on a SENTENCE, not on a character count", () => {
  // The shipped failure: YouTube cut at 100 and landed on the word "comment".
  const caption =
    "bet 99% of people mess this up. what's your answer? drop it in the comments and subscribe for more brain teasers\n\n#fyp #quiz";
  const t = titleFromCaption(caption, YT_TITLE_MAX);
  assert.ok(t.length <= YT_TITLE_MAX, `${t.length} > ${YT_TITLE_MAX}`);
  assert.ok(!/\bcomment$/i.test(t), `title ends mid-thought: ${JSON.stringify(t)}`);
  assert.match(t, /[.!?]$/, `a derived title should end on a finished sentence: ${JSON.stringify(t)}`);
});

test("a derived title never carries hashtags, urls or line breaks", () => {
  const caption = "smart fella or fart smella? take the test\n\nhttps://www.smartfellaorfartsmella.com/tiktok\n\n#fyp #quiz";
  const t = titleFromCaption(caption, TIKTOK_TITLE_MAX);
  assert.ok(!t.includes("#"), t);
  assert.ok(!/https?:/.test(t), t);
  assert.ok(!/\n/.test(t), t);
});

test("TikTok no longer gets a raw slice of the whole caption", () => {
  // The shipped failure: `input.text.slice(0, 90)` cut the caption mid-URL and left the
  // title ending on a blank line.
  const caption =
    "only 3% of people get this one right. comment your answer before you scroll and subscribe for more\n\nhttps://www.smartfellaorfartsmella.com/tiktok\n\n#fyp";
  const body = buildCreateBody({
    text: caption,
    mediaUrl: "https://example.com/v.mp4",
    publicationDate: { dateTime: "2026-08-11T12:01:00", timezone: "America/Chicago" },
    networks: ["tiktok"],
  }) as any;
  const title = body.tiktokData.title as string;
  assert.ok(title.length <= TIKTOK_TITLE_MAX, `${title.length} > ${TIKTOK_TITLE_MAX}`);
  assert.ok(!/\n/.test(title), `raw slice leaked a newline: ${JSON.stringify(title)}`);
  assert.ok(!/https?:|smartfellaorfartsmella\.com/.test(title), `raw slice leaked the url: ${JSON.stringify(title)}`);
});

test("a WRITTEN title is used verbatim on both networks, not re-derived", () => {
  const written = "thick is to thin as near is to... 97% blow this one";
  const caption = "something completely different in the caption\n\n#fyp";
  for (const [net, key] of [["youtube", "youtubeData"], ["tiktok", "tiktokData"]] as const) {
    const body = buildCreateBody({
      text: caption,
      mediaUrl: "https://example.com/v.mp4",
      publicationDate: { dateTime: "2026-08-11T12:01:00", timezone: "America/Chicago" },
      networks: [net],
      youtubeTitle: net === "youtube" ? written : undefined,
      tiktokTitle: net === "tiktok" ? written : undefined,
    }) as any;
    assert.equal(body[key].title, written, `${net} re-derived instead of using the written title`);
  }
});

test("an empty caption still yields a title, because both platforms reject an empty one", () => {
  assert.ok(titleFromCaption("", YT_TITLE_MAX).length > 0);
  assert.ok(titleFromCaption("\n\n#fyp #quiz", YT_TITLE_MAX).length > 0);
});

// ── alt text ────────────────────────────────────────────────────────────────

test("alt text describes the QUESTIONS, which is what a viewer cannot see", () => {
  const qs = [
    { sig: "a", hash: "a", kind: "text", category: "c", tier: "ODD ONE OUT", prompt: "WHICH ONE DOES NOT BELONG?", options: ["CHAIR", "DESK", "TABLE", "RED"], answer: "RED" },
    { sig: "b", hash: "b", kind: "text", category: "c", tier: "VERBAL ANALOGY", prompt: "THICK IS TO THIN AS NEAR IS TO ?", options: ["NEW", "FAR"], answer: "FAR" },
  ] as any;
  const alt = altTextFor(qs);
  assert.match(alt, /2 questions/);
  assert.match(alt, /WHICH ONE DOES NOT BELONG\?/);
  assert.match(alt, /CHAIR, DESK, TABLE, RED/);
  // The answers are withheld on screen; leaking them here would give the puzzle away to
  // exactly the users the alt text exists for.
  assert.ok(!/\bRED\.\s*$/.test(alt), "must not end by announcing the answer");
});

test("alt text is never empty, and is trimmed on a sentence when the questions are long", () => {
  assert.ok(altTextFor([] as any).length > 0, "an empty question list still needs alt text");
  const many = Array.from({ length: 8 }, (_, i) => ({
    sig: String(i), hash: String(i), kind: "text", category: "c", tier: "T",
    prompt: `QUESTION ${i} WITH A DELIBERATELY LONG PROMPT THAT GOES ON AND ON AND ON?`,
    options: ["AAAAAAAAAA", "BBBBBBBBBB", "CCCCCCCCCC", "DDDDDDDDDD"], answer: "A",
  })) as any;
  const alt = altTextFor(many);
  assert.ok(alt.length <= 420, `${alt.length} > 420`);
  assert.match(alt, /[.?]$/, "a screen reader should not be cut off mid-word");
});

test("alt text reaches the outbound body, where it used to be an empty array", () => {
  const body = buildCreateBody({
    text: "hello",
    mediaUrl: "https://example.com/v.mp4",
    publicationDate: { dateTime: "2026-08-11T12:01:00", timezone: "America/Chicago" },
    networks: ["instagram"],
    mediaAltText: "Brain-teaser quiz video with 2 questions.",
  }) as any;
  assert.deepEqual(body.mediaAltText, ["Brain-teaser quiz video with 2 questions."]);
});

// ── the brand corpus the judge is calibrated against ────────────────────────

test("the corpus loader hands the judge CAPTIONS, not the file's header metadata", () => {
  const bv = loadBrandVoice();
  assert.ok(bv.examples.length > 0, "no examples reached the judge at all");
  const joined = bv.examples.join("\n");
  // The exact strings the old recursive flatten was passing off as brand voice: the
  // campaign name, a generated_at date, the account handle, and the SOURCE FILENAMES
  // that sit next to each example.
  assert.ok(!bv.examples.includes("SFFS"), "the acronym is metadata, not an example");
  assert.ok(!bv.examples.includes("smartfellaorfartsmella.com"), "the bare domain is metadata");
  assert.ok(!/ready-to-post\/\d+ caption\.txt/.test(joined), "a source filename leaked in as an example");
  assert.ok(!/^\d{4}-\d{2}-\d{2}$/m.test(joined), "a bare date leaked in as an example");
  // And it must actually contain the signature device, which every real example carries.
  assert.match(joined, /SMART|FART/i);
});

// ── the corpus must not contradict the gate it calibrates ───────────────────
//
// The 20 caption examples closed on "comment your score" and "follow for more" while
// HARD_RULES had moved to the free test, so they would have FAILED the very gate they
// exist to calibrate. Two of them were also carrying two emoji beyond the brand glyph
// and had been failing the deterministic rule since before that. This pins the
// deterministic half permanently; the LLM half is checked by hand against the live
// judge, since a unit test cannot reach it.

test("every brand-voice example passes the deterministic rules it calibrates", () => {
  const bv = loadBrandVoice();
  assert.ok(bv.examples.length > 0, "no examples loaded");
  const bad = bv.examples
    .map((e) => ({ e, r: ruleCheckCopy(e) }))
    .filter((x) => !x.r.pass)
    // Legacy WEBSITE strings are preserved verbatim WITH their em dashes on purpose
    // (see the corpus notes); they are not social copy and are not what the gate grades.
    .filter((x) => !x.r.violations.every((v) => v.includes("dash")));
  assert.deepEqual(
    bad.map((x) => `${x.r.violations.join("; ")} :: ${x.e.slice(0, 60)}`),
    [],
    "an example the judge is shown would itself be rejected",
  );
});

test("no caption example asks for a follow, and every one closes on the test", () => {
  const raw = JSON.parse(readFileSync(CONFIG.BRAND_EXAMPLES, "utf8"));
  const caps: string[] = raw.categories.caption.examples.map((e: any) => e.text);
  assert.equal(caps.length, 20, "the caption surface count moved; update the corpus counters too");
  for (const c of caps) {
    assert.ok(!/\bfollow (for more|so you)\b/i.test(c), `still asks for a follow: ${c.slice(0, 70)}`);
    assert.ok(/take the full test/i.test(c), `never closes on the test: ${c.slice(0, 70)}`);
    assert.ok(!/\ball 3\b/i.test(c), `still hard-codes a 3-question format: ${c.slice(0, 70)}`);
  }
});
