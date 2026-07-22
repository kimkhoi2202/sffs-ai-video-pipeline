/**
 * dashboard.test.ts — hermetic tests for the READ-ONLY dashboard.
 *
 * No network, no `gh`, no real files: every test drives the PURE data-shaping /
 * rendering / auth functions with in-memory fixtures. Run: `node --test test/`.
 *
 * The most important test is the GUARDRAIL lock (`page` renders no publish/
 * schedule/merge action) — if a future edit adds a mutating control, it goes red.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseGateLedger, latestBySource, normalizeCheck, rollupCi, toPRRow, correlate,
} from "../prs.ts";
import { evaluateKillSwitch, computeBankCoverage } from "../data.ts";
import { esc, page } from "../render.ts";
import { checkBasicAuth, eq } from "../server.ts";
import type { GateAttempt } from "../types.ts";

// ── gate ledger parsing ───────────────────────────────────────────────────────
test("parseGateLedger: parses a real auto_merge line + skips junk", () => {
  const line = JSON.stringify({
    ts: "2026-07-22T01:00:00Z",
    source: "sffs-feature-x",
    target: "hermes-nous",
    mode: "execute",
    merged: true,
    merge_commit: "abcdef1234567890",
    mergeable: true,
    changed_files: ["hermes-nous/sffs/gates.py"],
    keys: {
      harness: { verdict: "GREEN", ok: true },
      review: { verdict: "APPROVE", source: "static+model" },
    },
    decision: { merge: true, verdict: "MERGE", reasons: ["both keys satisfied"] },
  });
  const out = parseGateLedger(`${line}\nnot json here\n{"partial":true}\n`);
  assert.equal(out.length, 2); // the junk line is skipped, the two JSON lines kept
  assert.equal(out[0].source, "sffs-feature-x");
  assert.equal(out[0].harness, "GREEN");
  assert.equal(out[0].review, "APPROVE");
  assert.equal(out[0].decision, "MERGE");
  assert.equal(out[0].merged, true);
  assert.deepEqual(out[0].reasons, ["both keys satisfied"]);
  // the minimal line normalizes missing keys to "?"
  assert.equal(out[1].harness, "?");
  assert.equal(out[1].review, "?");
});

test("latestBySource: newest write per branch wins", () => {
  const attempts: GateAttempt[] = [
    { source: "b1", target: "t", harness: "RED", review: "REJECT", decision: "REFUSE" },
    { source: "b1", target: "t", harness: "GREEN", review: "APPROVE", decision: "MERGE" },
    { source: "refs/heads/b2", target: "t", harness: "GREEN", review: "APPROVE", decision: "MERGE" },
  ];
  const m = latestBySource(attempts);
  assert.equal(m.get("b1")?.decision, "MERGE"); // latest overwrote the earlier RED/REJECT
  assert.ok(m.has("b2")); // refs/heads/ prefix stripped
});

// ── CI rollup mapping ─────────────────────────────────────────────────────────
test("normalizeCheck: CheckRun + StatusContext shapes", () => {
  assert.deepEqual(normalizeCheck({ name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }), { name: "ci", result: "PASS" });
  assert.deepEqual(normalizeCheck({ name: "ci", status: "COMPLETED", conclusion: "FAILURE" }), { name: "ci", result: "FAIL" });
  assert.deepEqual(normalizeCheck({ name: "ci", status: "IN_PROGRESS" }), { name: "ci", result: "PENDING" });
  assert.deepEqual(normalizeCheck({ context: "legacy", state: "SUCCESS" }), { name: "legacy", result: "PASS" });
  assert.deepEqual(normalizeCheck({ context: "legacy", state: "PENDING" }), { name: "legacy", result: "PENDING" });
  assert.equal(normalizeCheck(null), null);
});

test("rollupCi: FAIL dominates, then PENDING, then PASS, else NONE", () => {
  assert.equal(rollupCi([]).status, "NONE");
  assert.equal(rollupCi([{ status: "COMPLETED", conclusion: "SUCCESS" }]).status, "PASS");
  assert.equal(rollupCi([{ status: "COMPLETED", conclusion: "SUCCESS" }, { status: "IN_PROGRESS" }]).status, "PENDING");
  assert.equal(rollupCi([{ status: "COMPLETED", conclusion: "SUCCESS" }, { status: "COMPLETED", conclusion: "FAILURE" }]).status, "FAIL");
});

// ── PR ⇄ ledger correlation ───────────────────────────────────────────────────
test("toPRRow: attaches the gate record for the PR's head branch", () => {
  const ledger = latestBySource([
    { source: "sffs-feature-x", target: "hermes-nous", harness: "GREEN", review: "APPROVE", decision: "MERGE", merged: true },
  ]);
  const row = toPRRow(
    {
      number: 7, title: "add gate", url: "https://x/7", state: "MERGED",
      headRefName: "sffs-feature-x", baseRefName: "hermes-nous",
      author: { login: "sffs-bot" }, mergedAt: "2026-07-22T01:00:00Z",
      statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
    },
    ledger,
  );
  assert.equal(row.number, 7);
  assert.equal(row.author, "sffs-bot");
  assert.equal(row.ci.status, "PASS");
  assert.equal(row.gate.matched, true);
  assert.equal((row.gate as any).review, "APPROVE");
});

test("correlate: unmatched PR + ledger-only attempt are both surfaced", () => {
  const prs = [
    { number: 1, title: "matched", url: "u1", state: "OPEN", headRefName: "branch-a", baseRefName: "hermes-nous", statusCheckRollup: [] },
    { number: 2, title: "no gate", url: "u2", state: "OPEN", headRefName: "branch-nogate", baseRefName: "hermes-nous", statusCheckRollup: [] },
  ];
  const ledger: GateAttempt[] = [
    { source: "branch-a", target: "hermes-nous", harness: "GREEN", review: "APPROVE", decision: "MERGE" },
    { source: "branch-orphan", target: "hermes-nous", harness: "RED", review: "REJECT", decision: "REFUSE" },
  ];
  const { rows, ledgerOnly } = correlate(prs, ledger);
  assert.equal(rows.length, 2);
  assert.equal(rows.find((r) => r.number === 1)!.gate.matched, true);
  assert.equal(rows.find((r) => r.number === 2)!.gate.matched, false);
  assert.equal(ledgerOnly.length, 1);
  assert.equal(ledgerOnly[0].source, "branch-orphan");
});

// ── kill-switch (DISPLAY-ONLY) evaluator ─────────────────────────────────────
test("evaluateKillSwitch: env truthiness + stop-file presence", () => {
  const names = ["SFFS_FACTORY_KILL", "HERMES_SFFS_FACTORY_KILL"] as const;
  const noFiles = () => false;
  assert.equal(evaluateKillSwitch(names, {}, [], noFiles).engaged, false);
  assert.equal(evaluateKillSwitch(names, { SFFS_FACTORY_KILL: "1" }, [], noFiles).engaged, true);
  assert.equal(evaluateKillSwitch(names, { SFFS_FACTORY_KILL: "true" }, [], noFiles).engaged, true);
  assert.equal(evaluateKillSwitch(names, { SFFS_FACTORY_KILL: "0" }, [], noFiles).engaged, false);
  assert.equal(evaluateKillSwitch(names, { HERMES_SFFS_FACTORY_KILL: "yes" }, [], noFiles).engaged, true);
  const withFile = evaluateKillSwitch(names, {}, ["/tmp/STOP"], (p) => p === "/tmp/STOP");
  assert.equal(withFile.engaged, true);
  assert.match(withFile.sources[0], /stop-file/);
});

// ── auth ──────────────────────────────────────────────────────────────────────
test("checkBasicAuth: open when no pass, else verifies user:pass", () => {
  assert.equal(checkBasicAuth(undefined, "hermes", ""), true); // no pass ⇒ open (SG-restricted)
  const header = "Basic " + Buffer.from("hermes:s3cret").toString("base64");
  assert.equal(checkBasicAuth(header, "hermes", "s3cret"), true);
  assert.equal(checkBasicAuth(header, "hermes", "wrong"), false);
  assert.equal(checkBasicAuth("Basic garbage", "hermes", "s3cret"), false);
  assert.equal(checkBasicAuth(undefined, "hermes", "s3cret"), false);
});

test("eq: timing-safe compare handles unequal lengths", () => {
  assert.equal(eq("abc", "abc"), true);
  assert.equal(eq("abc", "abd"), false);
  assert.equal(eq("abc", "abcd"), false);
});

// ── escaping ──────────────────────────────────────────────────────────────────
test("esc: escapes HTML metacharacters", () => {
  assert.equal(esc(`<script>"&'`), "&lt;script&gt;&quot;&amp;&#39;");
  assert.equal(esc(null), "");
  assert.equal(esc(undefined), "");
});

// ── the full page + GUARDRAIL lock ────────────────────────────────────────────
function emptyPageData(overrides: Partial<Parameters<typeof page>[0]> = {}) {
  return {
    latest: null,
    runs: [],
    db: { posts: [] },
    l: {},
    bank: { total: 0, usable: 0, fresh: 0, used: 0 },
    schedule: { last: null, next: "unknown", nextSource: "unknown" as const },
    kill: { engaged: false, sources: [] },
    disk: "n/a",
    selected: null,
    pr: { ok: true, repo: "owner/repo", rows: [], ledgerOnly: [], counts: { open: 0, merged: 0, ledger: 0 }, gh_available: true },
    logItems: [],
    ...overrides,
  };
}

test("page: renders all required sections", () => {
  const html = page(emptyPageData());
  assert.match(html, /Cycle status/);
  assert.match(html, /Software-factory PRs/);
  assert.match(html, /A\/B results/);
  assert.match(html, /Front-runners/);
  assert.match(html, /kill-switch clear/);
  assert.match(html, /READ-ONLY/);
  assert.match(html, /next run/);
});

test("page: kill-switch banner flips when engaged", () => {
  const html = page(emptyPageData({ kill: { engaged: true, sources: ["env SFFS_FACTORY_KILL"] } }));
  assert.match(html, /KILL-SWITCH ENGAGED/);
  assert.match(html, /env SFFS_FACTORY_KILL/);
});

test("GUARDRAIL: page exposes NO publish/schedule/merge action (no POST form)", () => {
  const html = page(
    emptyPageData({
      pr: {
        ok: true, repo: "owner/repo",
        rows: [{
          number: 1, title: "t", url: "u", state: "MERGED", headRefName: "b", baseRefName: "hermes-nous",
          ci: { status: "PASS", checks: [] }, gate: { matched: true, source: "b", target: "hermes-nous", harness: "GREEN", review: "APPROVE", decision: "MERGE", merged: true },
        } as any],
        ledgerOnly: [], counts: { open: 0, merged: 1, ledger: 1 }, gh_available: true,
      },
    }),
  );
  // The only <form> is the GET run-selector; there must be no POST/mutation form.
  assert.doesNotMatch(html, /method\s*=\s*["']post["']/i);
  // No action buttons/inputs that would publish/schedule/merge/post.
  assert.doesNotMatch(html, /<button[^>]*>\s*(publish|schedule|merge|post|go live)/i);
  assert.doesNotMatch(html, /<input[^>]*type\s*=\s*["']submit["'][^>]*(publish|schedule|merge)/i);
});

// ── CONTENT default-promotion card (read-only; approval = human CLI) ──────────
test("page: renders the Pending default changes card + empty state", () => {
  const html = page(emptyPageData());
  assert.match(html, /Pending default changes/);
  assert.match(html, /HUMAN-APPROVED/);
  assert.match(html, /No pending default changes/);
});

test("page: renders a pending default-promotion proposal + human CLI command", () => {
  const html = page(
    emptyPageData({
      defaults: { defaults: { narration: "full", ending: "cliffhanger" }, promotion: { metric: "median_eng_rate", min_sample: 5, min_abs_improvement_pp: 1, min_rel_improvement: 0.2 } },
      proposals: {
        proposals: [
          {
            id: "promote-ending-full-reveal",
            dimension: "ending",
            current_default: "cliffhanger",
            recommended_default: "full-reveal",
            incumbent_label: "control",
            metric: "median_eng_rate",
            challenger: { arm: "full-reveal", median_eng_rate: 6.2, n_with_metrics: 7 },
            incumbent: { arm: "control", median_eng_rate: 3.1, n_with_metrics: 8 },
            delta_abs_pp: 3.1,
            delta_rel: 1.0,
            min_sample: 5,
            confidence: "high",
            status: "pending",
            rationale: "full-reveal beat control clearly",
          },
        ],
      },
    }),
  );
  assert.match(html, /narration default/); // current defaults surfaced
  assert.match(html, /ending default/);
  assert.match(html, /full-reveal/); // the recommended new default
  assert.match(html, /high confidence/);
  assert.match(html, /\+3\.1pp/);
  // the exact HUMAN command (shown as text, not a button)
  assert.match(html, /sffs_promote_default --approve promote-ending-full-reveal/);
});

test("GUARDRAIL: the proposals card adds NO approve/reject button or POST form", () => {
  const html = page(
    emptyPageData({
      proposals: {
        proposals: [
          { id: "promote-narration-no-narration", dimension: "narration", recommended_default: "no-narration", status: "pending", metric: "median_eng_rate", challenger: {}, incumbent: {} } as any,
        ],
      },
    }),
  );
  assert.doesNotMatch(html, /method\s*=\s*["']post["']/i);
  assert.doesNotMatch(html, /<button[^>]*>\s*(approve|reject|promote|apply)/i);
  assert.doesNotMatch(html, /<input[^>]*type\s*=\s*["']submit["']/i);
});

// ── P2: question-bank coverage (pure) ────────────────────────────────────────
test("computeBankCoverage: usable/fresh + per-type + runway (renderable kinds only)", () => {
  const entries = [
    { sig: "a1", kind: "text", tier: "VERBAL ANALOGY" },
    { sig: "a2", kind: "text", tier: "VERBAL ANALOGY" },
    { sig: "a3", kind: "numseries", tier: "NUMBER SERIES" },
    { sig: "a4", kind: "dot", tier: "POSITION" }, // NOT renderable -> excluded from usable
  ];
  const used = new Set<string>(["a1"]); // one used
  const cov = computeBankCoverage(entries, used, 3);
  assert.equal(cov.total, 4);
  assert.equal(cov.usable, 3); // a1,a2,a3 (a4 excluded)
  assert.equal(cov.fresh, 2); // a2,a3 (a1 used)
  assert.equal(cov.used, 1);
  assert.equal(cov.perDay, 3);
  assert.equal(cov.runwayDays, 0); // floor(2/3)
  const verbal = cov.byType.find((t) => t.tier === "VERBAL ANALOGY")!;
  assert.equal(verbal.usable, 2);
  assert.equal(verbal.fresh, 1);
  assert.ok(!cov.byType.some((t) => t.tier === "POSITION")); // non-renderable excluded
});

test("computeBankCoverage: runway null when perDay is 0", () => {
  const cov = computeBankCoverage([{ sig: "x", kind: "text", tier: "T" }], new Set(), 0);
  assert.equal(cov.runwayDays, null);
  assert.equal(cov.freshPct, 100);
});

// ── P2: dashboard panels render ───────────────────────────────────────────────
test("page: renders all four P2 panels (coverage, spend, published map, arm leaderboard)", () => {
  const html = page(emptyPageData());
  assert.match(html, /Question-bank coverage/);
  assert.match(html, /days-of-runway|days runway/);
  assert.match(html, /Cost governor/);
  assert.match(html, /Published posts/);
  assert.match(html, /Per-arm A\/B leaderboard/);
});

test("page: spend panel shows metrics + OVER flag from a snapshot", () => {
  const html = page(
    emptyPageData({
      snapshot: {
        day: "2026-07-22",
        kill_switch: { engaged: false, reason: null },
        metrics: {
          usd: { value: 12.5, ceiling: 75, over: false },
          tokens: { value: 41_000_000, ceiling: 40_000_000, over: true },
          spawns: { value: 3, ceiling: 500, over: false },
          concurrent_children: { value: 1, ceiling: 8, over: false },
        },
        ceiling_reason: "daily token ceiling reached",
      },
    }),
  );
  assert.match(html, /\$12\.50 \/ \$75\.00/);
  assert.match(html, /⛔ OVER/); // tokens over its ceiling
  assert.match(html, /daily token ceiling reached/);
});

test("page: published map lists reconciled posts with permalinks", () => {
  const html = page(
    emptyPageData({
      db: {
        posts: [
          { publer_post_id: 1, platform_post_id: "NAT1", platform: "tiktok", permalink: "https://tiktok.com/@x/video/NAT1", posted_at: "2026-07-20", variant: { arm: "control" }, metrics: { eng_rate: 5.1 } },
          { publer_post_id: 2, platform_post_id: null, permalink: null, post_state: "draft" }, // draft -> excluded
        ],
      },
    }),
  );
  assert.match(html, /https:\/\/tiktok\.com\/@x\/video\/NAT1/);
  assert.match(html, /1 published\/reconciled post/);
});

test("page: arm leaderboard ranks arms by median eng, crowns the leader", () => {
  const html = page(
    emptyPageData({
      l: {
        conventions: { min_n: 3 },
        rollups: {
          by_variant_arm: {
            "full-narration": { n_posts: 5, n_with_metrics: 4, median_eng_rate: 6.4, avg_reach: 120 },
            "no-narration": { n_posts: 5, n_with_metrics: 4, median_eng_rate: 3.2, avg_reach: 90 },
            "tempo-fast": { n_posts: 1, n_with_metrics: 1, median_eng_rate: 9.9, avg_reach: 50 }, // low n -> not crowned
          },
        },
      },
    }),
  );
  assert.match(html, /★ leader/);
  assert.match(html, /full-narration/);
  assert.match(html, /low n/); // tempo-fast shown but flagged
});

test("GUARDRAIL: P2 panels add NO mutating control (populated)", () => {
  const html = page(
    emptyPageData({
      snapshot: { day: "d", kill_switch: { engaged: true, reason: "kill" }, metrics: { usd: { value: 1, ceiling: 75, over: false } } },
      coverage: { total: 10, usable: 8, fresh: 6, used: 2, freshPct: 75, perDay: 30, runwayDays: 0, byType: [{ tier: "T", usable: 8, fresh: 6 }] },
      db: { posts: [{ publer_post_id: 1, platform_post_id: "N", permalink: "https://x/1", posted_at: "d", variant: { arm: "a" }, metrics: {} }] },
    }),
  );
  assert.doesNotMatch(html, /method\s*=\s*["']post["']/i);
  assert.doesNotMatch(html, /<button[^>]*>\s*(publish|schedule|merge|post|go live|approve|reject)/i);
});

test("page: PR view shows the review-agent verdict + CI status", () => {
  const html = page(
    emptyPageData({
      pr: {
        ok: true, repo: "owner/repo",
        rows: [{
          number: 42, title: "add score tool", url: "https://gh/42", state: "MERGED",
          headRefName: "sffs-score", baseRefName: "hermes-nous",
          ci: { status: "PASS", checks: [{ name: "ci", result: "PASS" }] },
          gate: { matched: true, source: "sffs-score", target: "hermes-nous", harness: "GREEN", review: "APPROVE", decision: "MERGE", merged: true },
        } as any],
        ledgerOnly: [], counts: { open: 0, merged: 1, ledger: 1 }, gh_available: true,
      },
    }),
  );
  assert.match(html, /#42/);
  assert.match(html, /review: APPROVE/);
  assert.match(html, /tests: GREEN/);
  assert.match(html, /CI: pass/);
  assert.match(html, /gate: MERGE/);
});
