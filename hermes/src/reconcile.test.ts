/**
 * reconcile.test.ts — the PURE core of the A/B learning-loop reconciler (P0):
 *   - nativeRefsFromInsights / nativeRefsFromRawPosts extraction
 *   - indexRefs first-non-null-wins merge
 *   - backfillAbPosts: fills empty fields, IDEMPOTENT, never overwrites, matches
 *     only on publer_post_id
 *   - indexInsights + matchInsight: native join with a publer_post_id FALLBACK
 *     when platform_post_id is null (the score.ts join fix)
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
  nativeRefsFromInsights,
  nativeRefsFromRawPosts,
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

test("nativeRefsFromInsights maps documented fields + skips empty publer_id", () => {
  const flat: any[] = [
    { publer_id: "P1", post_id: "NATIVE1", post_link: "https://t/1", scheduled_at: "2026-07-01T00:00:00Z", network: "tiktok", account_id: "acc" },
    { publer_id: "", post_id: "X", post_link: "y" }, // skipped (no publer id)
    { publer_id: "P2", post_id: "", post_link: "", scheduled_at: "" }, // nulls for blanks
  ];
  const refs = nativeRefsFromInsights(flat);
  assert.equal(refs.length, 2);
  assert.deepEqual(refs[0], {
    publer_id: "P1",
    platform_post_id: "NATIVE1",
    permalink: "https://t/1",
    posted_at: "2026-07-01T00:00:00Z",
    network: "tiktok",
    account_id: "acc",
  });
  assert.equal(refs[1].platform_post_id, null);
  assert.equal(refs[1].permalink, null);
  assert.equal(refs[1].posted_at, null);
});

test("nativeRefsFromRawPosts digs candidate keys + skips no-id", () => {
  const raw: any[] = [
    { id: "P1", post_id: "N1", url: "https://u/1", posted_at: "2026-07-02T00:00:00Z", provider: "instagram", account_id: "acc" },
    { _id: "P2", external_id: "N2", permalink: "https://u/2", published_at: "2026-07-03" },
    { nope: 1 }, // skipped (no id)
  ];
  const refs = nativeRefsFromRawPosts(raw);
  assert.equal(refs.length, 2);
  assert.equal(refs[0].publer_id, "P1");
  assert.equal(refs[0].platform_post_id, "N1");
  assert.equal(refs[0].permalink, "https://u/1");
  assert.equal(refs[0].posted_at, "2026-07-02T00:00:00Z");
  assert.equal(refs[1].publer_id, "P2");
  assert.equal(refs[1].platform_post_id, "N2");
  assert.equal(refs[1].posted_at, "2026-07-03");
});

test("indexRefs merges first-non-null-wins per field", () => {
  const insights = [{ publer_id: "P1", platform_post_id: "N1", permalink: "L1", posted_at: null, network: "tiktok", account_id: null }];
  const published = [{ publer_id: "P1", platform_post_id: "IGNORED", permalink: null, posted_at: "2026-07-04", network: null, account_id: "acc" }];
  const idx = indexRefs([insights, published]);
  const r = idx.get("P1")!;
  assert.equal(r.platform_post_id, "N1"); // insights won (first)
  assert.equal(r.permalink, "L1");
  assert.equal(r.posted_at, "2026-07-04"); // filled from published (insights had null)
  assert.equal(r.account_id, "acc"); // filled from published
});

test("backfillAbPosts fills empty fields, matches only on publer_post_id", () => {
  const posts: any[] = [
    { publer_post_id: "P1", platform_post_id: null, permalink: null, posted_at: null },
    { publer_post_id: 42, platform_post_id: "ALREADY", permalink: "keep", posted_at: null }, // numeric id + partial
    { publer_post_id: "P9" }, // no matching ref
    { platform_post_id: "N" }, // no publer id -> never matched
  ];
  const idx = indexRefs([[
    { publer_id: "P1", platform_post_id: "N1", permalink: "https://l/1", posted_at: "2026-07-01", network: null, account_id: null },
    { publer_id: "42", platform_post_id: "N42", permalink: "https://l/42", posted_at: "2026-07-02", network: null, account_id: null },
  ]]);
  const res = backfillAbPosts(posts, idx);
  assert.equal(res.records, 4);
  assert.equal(res.matched, 2); // P1 + 42
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
});

test("backfillAbPosts is IDEMPOTENT (second run changes nothing)", () => {
  const posts: any[] = [{ publer_post_id: "P1", platform_post_id: null, permalink: null, posted_at: null }];
  const idx = indexRefs([[{ publer_id: "P1", platform_post_id: "N1", permalink: "L", posted_at: "T", network: null, account_id: null }]]);
  const first = backfillAbPosts(posts, idx);
  assert.equal(first.records_changed, 1);
  const second = backfillAbPosts(posts, idx);
  assert.equal(second.records_changed, 0);
  assert.equal(second.matched, 1); // still matched, just nothing to fill
  assert.equal(second.filled.platform_post_id, 0);
});

test("matchInsight joins on platform_post_id, falls back to publer_post_id when null", () => {
  const flat: any[] = [
    { publer_id: "P1", post_id: "N1", reach: 1 },
    { publer_id: "P2", post_id: "", reach: 2 }, // agent's own post: only a publer id
  ];
  const idx = indexInsights(flat);
  // native id present + found -> native join
  assert.equal(matchInsight({ platform_post_id: "N1", publer_post_id: "P1" }, idx)?.reach, 1);
  // native id present but NOT found -> no fallback (platform_post_id is not null)
  assert.equal(matchInsight({ platform_post_id: "UNKNOWN", publer_post_id: "P1" }, idx), undefined);
  // native id null -> fall back to publer_post_id
  assert.equal(matchInsight({ platform_post_id: null, publer_post_id: "P2" }, idx)?.reach, 2);
  // native id null + publer id unknown -> undefined
  assert.equal(matchInsight({ platform_post_id: null, publer_post_id: "NOPE" }, idx), undefined);
  // neither id -> undefined
  assert.equal(matchInsight({}, idx), undefined);
});
