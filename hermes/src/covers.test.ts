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

const { COVER_COLOR_ORDER, coverColorFor, coverMediaFor, videoMediaObjectWithCover, loadCoverManifest } = await import(
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
