import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Point the module at a temp manifest BEFORE importing it.
const TMP = mkdtempSync(join(tmpdir(), "covers-"));
const MAN = join(TMP, "covers-manifest.json");
writeFileSync(
  MAN,
  JSON.stringify({
    hosted: {
      yellow: "https://static.metricool.com/planner/202607/y.png",
      coral: "https://static.metricool.com/planner/202607/c.png",
      blue: "https://static.metricool.com/planner/202607/b.png",
      green: "https://static.metricool.com/planner/202607/g.png",
      pink: "https://static.metricool.com/planner/202607/p.png",
    },
    covers: {
      yellow: { id: "y", path: "yp", thumbnail: "yt" },
      coral: { id: "c", path: "cp", thumbnail: "ct" },
      blue: { id: "b", path: "bp", thumbnail: "bt" },
      green: { id: "g", path: "gp", thumbnail: "gt" },
      pink: { id: "p", path: "pp", thumbnail: "pt" },
    },
  }),
);
process.env.HERMES_COVERS_MANIFEST = MAN;

const { COVER_COLOR_ORDER, coverColorFor, coverMediaFor, videoMediaObjectWithCover, loadCoverManifest, hostedCoverUrlFor } = await import(
  "./covers.ts"
);

test("cover colors: the 5 punchy brand colors, in order", () => {
  assert.deepEqual([...COVER_COLOR_ORDER], ["yellow", "coral", "blue", "green", "pink"]);
});

test("coverColorFor: deterministic; platform twins differ; consecutive videos differ; all 5 used", () => {
  const run = "2026-07-24";
  for (let i = 0; i < 7; i++) assert.notEqual(coverColorFor(run, i, "instagram"), coverColorFor(run, i, "tiktok"));
  for (let i = 0; i < 7; i++) assert.notEqual(coverColorFor(run, i, "instagram"), coverColorFor(run, i + 1, "instagram"));
  assert.equal(coverColorFor(run, 3, "tiktok"), coverColorFor(run, 3, "tiktok")); // deterministic
  const set = new Set([0, 1, 2, 3, 4].map((i) => coverColorFor(run, i, "instagram")));
  assert.equal(set.size, 5); // a 5-video IG batch cycles all colors
});

test("videoMediaObjectWithCover: fresh => cover default@0; with existing => appended + made default", () => {
  const cov = { id: "cov1", path: "covpath", thumbnail: "covthumb" };
  const fresh = videoMediaObjectWithCover("vid1", cov);
  assert.equal(fresh.id, "vid1");
  assert.equal(fresh.type, "video");
  assert.deepEqual(fresh.thumbnails, [{ id: "cov1", small: "covthumb", real: "covpath" }]);
  assert.equal(fresh.default_thumbnail, 0);
  const withEx = videoMediaObjectWithCover("vid2", cov, [{ small: "a", real: "A" }, { small: "b", real: "B" }]);
  assert.equal((withEx.thumbnails as unknown[]).length, 3);
  assert.equal(withEx.default_thumbnail, 2);
});

test("coverMediaFor + loadCoverManifest: resolve a real cover from the manifest", () => {
  const c = coverMediaFor("2026-07-24", 0, "instagram");
  assert.ok(c && c.id && c.color);
  assert.ok(loadCoverManifest()?.covers?.yellow?.id);
});


// ── hosted covers (the Metricool path) ───────────────────────────────────────
test("hostedCoverUrlFor: returns a durable PUBLIC url, rotating by the same rule", () => {
  const run = "2026-07-28";
  const seen = new Set<string>();
  for (let i = 0; i < 5; i++) {
    const c = hostedCoverUrlFor(run, i, "instagram");
    assert.ok(c, "every video in a batch must get a cover");
    assert.match(c!.url, /^https:\/\/static\.metricool\.com\//);
    assert.doesNotMatch(c!.url, /X-Amz-Signature|amazonaws/, "never a presigned url — it would expire");
    assert.doesNotMatch(c!.url, /cdn\.publer\.com/, "publer's cdn 403s without its own referer");
    assert.equal(c!.color, coverColorFor(run, i, "instagram"), "same deterministic rotation as the publer era");
    seen.add(c!.url);
  }
  assert.equal(seen.size, 5, "a 5-video batch cycles all five colours");
});

test("hostedCoverUrlFor: the two OPENING ARMS get identical cover treatment", () => {
  // The arms alternate by slot index, so slot i and slot i+1 are opposite arms. What
  // matters is that the cover is chosen by slot alone and knows nothing about the arm:
  // if the hook arm could systematically draw a different KIND of cover, the poster
  // would be a confound for the skip-rate result all over again.
  const run = "2026-07-28";
  for (let i = 0; i < 10; i++) {
    const c = hostedCoverUrlFor(run, i, "instagram");
    assert.ok(c && c.url.startsWith("https://static.metricool.com/"),
      "every slot, on either arm, gets a branded still from the same pool");
  }
});

test("hostedCoverUrlFor: null when the manifest has no hosted block (never a silent bad url)", async () => {
  const { writeFileSync: w, mkdtempSync: mk } = await import("node:fs");
  const { join: j } = await import("node:path");
  const { tmpdir: td } = await import("node:os");
  const dir = mk(j(td(), "covers-nohost-"));
  const man = j(dir, "m.json");
  w(man, JSON.stringify({ covers: { yellow: { id: "y", path: "yp", thumbnail: "yt" } } }));
  process.env.HERMES_COVERS_MANIFEST = man;
  const mod = await import(`./covers.ts?nohost=${Date.now()}`);
  assert.equal(mod.hostedCoverUrlFor("r", 0, "instagram"), null);
});


// ── buildUpdateBody: the guard for the update that DESTROYED posts ───────────
// Echoing a read post straight back into PUT returns HTTP 500
// ("Type definition error: [simple type, class ...PublicationStatusCode]") because the
// read shape carries providers[].status, which the write side cannot deserialize. That
// 500 was NOT a clean rejection — it destroyed the post it was applied to. Six
// scheduled posts were lost before this was understood, and none were recoverable from
// the recycle bin because they were never a user delete. This pins the body shape.
test("buildUpdateBody: strips providers[].status and every server-owned field", async () => {
  const { buildUpdateBody } = await import("./metricool.ts");
  const live = {
    id: 354069312,
    uuid: "4029025266717770035",
    text: "caption",
    publicationDate: { dateTime: "2026-07-28T22:00:00", timezone: "America/Chicago" },
    media: ["https://static.metricool.com/a.mp4"],
    mediaAltText: [],
    autoPublish: true,
    draft: false,
    shortener: false,
    instagramData: { type: "REEL", showReelOnFeed: true },
    // everything below is server-owned and must NOT be echoed back
    providers: [{ network: "instagram", status: "PENDING", detailedStatus: "Pending", publicUrl: null }],
    creationDate: { dateTime: "2026-07-26T18:14:00", timezone: "America/Chicago" },
    creatorUserId: 5094279,
    creatorUserMail: "someone@example.com",
    twitterData: {},
    saveExternalMediaFiles: false,
    hasNotReadNotes: false,
  } as any;

  const body = buildUpdateBody(live, { videoThumbnailUrl: "https://static.metricool.com/cover.png" });

  // the poison field, and the reason a post can be destroyed
  assert.deepEqual(body.providers, [{ network: "instagram" }]);
  for (const p of body.providers as any[]) {
    assert.ok(!("status" in p), "providers[].status is what triggers the 500");
    assert.ok(!("detailedStatus" in p));
    assert.ok(!("publicUrl" in p));
  }
  for (const k of ["creationDate", "creatorUserId", "creatorUserMail", "twitterData", "id"]) {
    assert.ok(!(k in body), `${k} is server-owned and must not be echoed back`);
  }
  // the things that must survive untouched — cover-only means cover-only
  assert.deepEqual(body.publicationDate, live.publicationDate, "the schedule time must not move");
  assert.equal(body.text, "caption", "the caption must not change");
  assert.deepEqual(body.media, live.media, "the media must not change");
  assert.deepEqual(body.instagramData, live.instagramData);
  assert.equal(body.videoThumbnailUrl, "https://static.metricool.com/cover.png");
  assert.equal(body.uuid, live.uuid, "the stable key rides along");
});

test("buildUpdateBody: omits absent optionals rather than sending nulls", async () => {
  const { buildUpdateBody } = await import("./metricool.ts");
  const body = buildUpdateBody({
    uuid: "u", text: "t", publicationDate: { dateTime: "2026-07-28T22:00:00", timezone: "America/Chicago" },
    providers: [{ network: "instagram" }], media: ["m"], tiktokData: null, youtubeData: undefined,
  } as any, {});
  assert.ok(!("tiktokData" in body));
  assert.ok(!("youtubeData" in body));
});
