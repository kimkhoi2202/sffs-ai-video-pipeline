/**
 * reconcile.test.ts — the PURE core of the A/B learning-loop reconciler (P0):
 *   - normalizePermalink canonicalisation (the join key both Metricool APIs share)
 *   - nativeRefsFromBoard: planner published posts joined to analytics on permalink
 *   - indexRefs first-non-null-wins merge
 *   - backfillAbPosts: fills empty fields, IDEMPOTENT, never overwrites, matches
 *     only on metricool_uuid
 *   - indexInsights + matchInsight: the native platform_post_id join score.ts uses
 *
 * Hermetic: points config at a tmp dir BEFORE importing the module and calls only
 * the pure (network-free) functions — reconcile() itself (the live orchestrator)
 * is exercised via the tool/bridge dry-run + test_reconcile.py.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "hermes-reconcile-"));
process.env.HERMES_ENV_FILE = join(TMP, "nonexistent.env");
process.env.HERMES_REPO_DIR = TMP;
process.env.HERMES_DATA_DIR = TMP;

const {
  idStr,
  isEmptyField,
  normalizePermalink,
  nativeRefsFromBoard,
  indexRefs,
  backfillAbPosts,
  indexInsights,
  matchInsight,
} = await import("./reconcile.ts");

test("idStr normalizes ids to trimmed strings", () => {
  assert.equal(idStr(null), "");
  assert.equal(idStr(undefined), "");
  assert.equal(idStr(123), "123");
  assert.equal(idStr("  x  "), "x");
  assert.equal(idStr(""), "");
});

test("isEmptyField true for null/undefined/blank only", () => {
  assert.equal(isEmptyField(null), true);
  assert.equal(isEmptyField(undefined), true);
  assert.equal(isEmptyField("   "), true);
  assert.equal(isEmptyField("x"), false);
  assert.equal(isEmptyField(0), false); // a real value
});

test("normalizePermalink strips trailing slash, query and case", () => {
  assert.equal(
    normalizePermalink("https://www.instagram.com/reel/ABC/"),
    normalizePermalink("https://www.instagram.com/reel/ABC"),
  );
  assert.equal(
    normalizePermalink("https://www.instagram.com/reel/ABC?igsh=x"),
    "https://www.instagram.com/reel/abc",
  );
  assert.equal(normalizePermalink(null), "");
  assert.equal(normalizePermalink("  "), "");
});

test("nativeRefsFromBoard joins published planner posts to analytics on permalink", () => {
  const board: any[] = [
    {
      uuid: "-6297496666514044627", // negative uuid: must survive as TEXT
      publicationDate: { dateTime: "2026-07-27T22:00:00" },
      providers: [{ network: "instagram", status: "PUBLISHED", publicUrl: "https://www.instagram.com/reel/AAA/" }],
    },
    {
      uuid: "222",
      publicationDate: { dateTime: "2026-07-28T10:00:00" },
      // published, but analytics has not caught up yet -> ref with no native id
      providers: [{ network: "tiktok", status: "PUBLISHED", publicUrl: "https://www.tiktok.com/@x/video/BBB" }],
    },
    {
      uuid: "333",
      providers: [{ network: "instagram", status: "PENDING", publicUrl: null }], // not published -> skipped
    },
    { uuid: "", providers: [{ status: "PUBLISHED", publicUrl: "https://x/1" }] }, // no uuid -> skipped
  ];
  const insights: any[] = [
    { post_id: "NATIVE_A", post_link: "https://www.instagram.com/reel/AAA", network: "instagram" },
  ];
  const refs = nativeRefsFromBoard(board, insights);
  assert.equal(refs.length, 2);

  assert.equal(refs[0].metricool_uuid, "-6297496666514044627");
  assert.equal(refs[0].platform_post_id, "NATIVE_A"); // matched despite the trailing slash
  assert.equal(refs[0].permalink, "https://www.instagram.com/reel/AAA/");
  assert.equal(refs[0].posted_at, "2026-07-27T22:00:00");
  assert.equal(refs[0].network, "instagram");

  assert.equal(refs[1].metricool_uuid, "222");
  assert.equal(refs[1].platform_post_id, null); // no analytics row yet
  assert.equal(refs[1].posted_at, "2026-07-28T10:00:00");
});

test("indexRefs merges first-non-null-wins per field", () => {
  const primary = [
    { metricool_uuid: "U1", platform_post_id: "N1", permalink: "L1", posted_at: null, network: "tiktok", account_id: null },
  ];
  const filler = [
    { metricool_uuid: "U1", platform_post_id: "IGNORED", permalink: null, posted_at: "2026-07-04", network: null, account_id: "acc" },
  ];
  const idx = indexRefs([primary, filler]);
  const r = idx.get("U1")!;
  assert.equal(r.platform_post_id, "N1"); // primary won (first)
  assert.equal(r.permalink, "L1");
  assert.equal(r.posted_at, "2026-07-04"); // filled from the gap-filler
  assert.equal(r.account_id, "acc");
});

test("backfillAbPosts fills empty fields, matches only on metricool_uuid", () => {
  const posts: any[] = [
    { metricool_uuid: "U1", platform_post_id: null, permalink: null, posted_at: null },
    { metricool_uuid: "-42", platform_post_id: "ALREADY", permalink: "keep", posted_at: null }, // negative uuid + partial
    { metricool_uuid: "U9" }, // no matching ref
    { platform_post_id: "N" }, // no uuid -> never matched
    { metricool_uuid: null, legacy_publer_post_id: "6a5ff4e8324fde90b165a22e" }, // legacy row -> never matched
  ];
  const idx = indexRefs([[
    { metricool_uuid: "U1", platform_post_id: "N1", permalink: "https://l/1", posted_at: "2026-07-01", network: null, account_id: null },
    { metricool_uuid: "-42", platform_post_id: "N42", permalink: "https://l/42", posted_at: "2026-07-02", network: null, account_id: null },
  ]]);
  const res = backfillAbPosts(posts, idx);
  assert.equal(res.records, 5);
  assert.equal(res.matched, 2); // U1 + -42
  assert.equal(res.records_changed, 2);
  assert.equal(posts[0].platform_post_id, "N1");
  assert.equal(posts[0].permalink, "https://l/1");
  assert.equal(posts[0].posted_at, "2026-07-01");
  // existing values are NEVER overwritten; only the empty posted_at is filled
  assert.equal(posts[1].platform_post_id, "ALREADY");
  assert.equal(posts[1].permalink, "keep");
  assert.equal(posts[1].posted_at, "2026-07-02");
  assert.equal(res.filled.platform_post_id, 1);
  assert.equal(res.filled.permalink, 1);
  assert.equal(res.filled.posted_at, 2);
  // a legacy Publer-era row is untouched, never dropped
  assert.equal(posts[4].legacy_publer_post_id, "6a5ff4e8324fde90b165a22e");
});

test("backfillAbPosts is IDEMPOTENT (second run changes nothing)", () => {
  const posts: any[] = [{ metricool_uuid: "U1", platform_post_id: null, permalink: null, posted_at: null }];
  const idx = indexRefs([[{ metricool_uuid: "U1", platform_post_id: "N1", permalink: "L", posted_at: "T", network: null, account_id: null }]]);
  const first = backfillAbPosts(posts, idx);
  assert.equal(first.records_changed, 1);
  const second = backfillAbPosts(posts, idx);
  assert.equal(second.records_changed, 0);
  assert.equal(second.matched, 1); // still matched, just nothing to fill
  assert.equal(second.filled.platform_post_id, 0);
});

test("matchInsight joins on platform_post_id and nothing else", () => {
  const flat: any[] = [
    { post_id: "N1", reach: 1 },
    { post_id: "N2", reach: 2 },
  ];
  const idx = indexInsights(flat);
  assert.equal(matchInsight({ platform_post_id: "N1" }, idx)?.reach, 1);
  assert.equal(matchInsight({ platform_post_id: "UNKNOWN" }, idx), undefined);
  // a record still awaiting reconcile has no native id, so it simply does not join
  assert.equal(matchInsight({ platform_post_id: null, metricool_uuid: "U9" }, idx), undefined);
  assert.equal(matchInsight({}, idx), undefined);
});
