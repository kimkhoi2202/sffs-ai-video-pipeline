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
import {
  evaluateKillSwitch, computeBankCoverage, redactRunForPublic,
  resolveScheduledMediaUrl, sanitizeScheduledForPublic,
  resolveReplicationView, REPLICATION_HARD_CAP,
  buildVariantMap, projectScheduledPosts, resolvePostVariant, idKey,
  summarizeSkipRate, SKIP_TARGET_PCT,
  requiredSkipBand, SKIP_VIEW_PROJECTIONS,
} from "../data.ts";
import { computeGoalProgress, GOAL, WINDOW_START, goalWindowStart } from "../goal.ts";
import { esc, page, abTestLabel } from "../render.ts";
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
  // The "Front-runners" panel is retired: it crowned a nightly winner on median
  // engagement rate, a metric the content policy had already abandoned for this
  // account, often at n<5. It is replaced by a statement of the pinned format.
  assert.match(html, /Production format/);
  assert.doesNotMatch(html, /Front-runners/);
  assert.match(html, /Double down on reach outliers/);
  assert.match(html, /next run/);
});

test("page: branded as the SFFS loop — no HERMES-NOUS / DRAFT-ONLY / READ-ONLY chrome", () => {
  // COSMETIC ONLY. The dashboard is public and unauthenticated, so it carries the
  // product name rather than the internal codename and the two internal-state
  // badges. This asserts the LABELS are gone; the DRAFT_ONLY posting guard and the
  // READ_ONLY server invariant are untouched (see the guardrail tests below, and
  // config.assertReadOnly / hermes config.assertDraftOnly).
  const html = page(emptyPageData());
  assert.match(html, /<title>SFFS Self-Improving Agentic Marketing Loop<\/title>/);
  assert.match(html, /<h1>SFFS Self-Improving Agentic Marketing Loop<\/h1>/);
  assert.doesNotMatch(html, /HERMES-NOUS/);
  assert.doesNotMatch(html, /Hermes-Nous/);
  // no badge/pill chrome carrying either internal state label
  assert.doesNotMatch(html, /<span class="tag[^"]*">\s*DRAFT-ONLY\s*<\/span>/);
  assert.doesNotMatch(html, /<span class="tag[^"]*">\s*READ-ONLY\s*<\/span>/);
  assert.doesNotMatch(html, /<span class="pin"[^>]*>\s*READ-ONLY\s*<\/span>/);
  // the footer carries the product name and the CURRENT posting window
  assert.match(html, /SFFS Self-Improving Agentic Marketing Loop<\/b> · posting 7am–3am CST/);
});

// ── REPLICATE panel + the exploration cap ────────────────────────────────────

const activeLedger = (over: Record<string, unknown> = {}) => ({
  updated_at: "2026-07-25T20:00:00Z",
  active: {
    key: "odd-one-out|3|standard|full|cliffhanger",
    status: "active",
    share: 0.25,
    share_cap: 0.5,
    round: 1,
    confidence: "high",
    opened_at: "2026-07-25T20:00:00Z",
    evaluate_after: "2026-07-26T20:00:00Z",
    vary_only: ["hashtag_set", "tempo", "time_of_day"],
    fingerprint: { key: "odd-one-out|3|standard|full|cliffhanger", lead_type: "odd-one-out", num_questions: 3, family: "standard", narration: "full", ending: "cliffhanger" },
    evidence: { n: 2, median_ratio: 2.57, samples: [{ key: "hermes:a:tiktok", platform: "tiktok", value: 996, ratio: 3.31 }], baselines: { tiktok: { median: 301, n: 9 } } },
    replicas: [],
    ...over,
  },
  history: [{ ts: "2026-07-25T20:00:00Z", event: "detect_winner", key: "odd-one-out|3|standard|full|cliffhanger", median_ratio: 2.57 }],
});

test("replication view: clamps the batch share to the exploration cap", () => {
  // The cap is an EXPLORATION FLOOR, so a ledger (or a config edit) claiming a
  // bigger share must never be honoured — half the batch always keeps exploring.
  const greedy = resolveReplicationView(activeLedger({ share: 0.95, share_cap: 0.95 }), { replication: { winner_share_cap: 0.95 } });
  assert.ok(greedy.share <= REPLICATION_HARD_CAP, `share ${greedy.share} must be <= ${REPLICATION_HARD_CAP}`);
  assert.equal(greedy.share_cap, REPLICATION_HARD_CAP);

  const normal = resolveReplicationView(activeLedger(), {});
  assert.equal(normal.active, true);
  assert.equal(normal.share, 0.25);
  assert.equal(normal.key, "odd-one-out|3|standard|full|cliffhanger");
});

test("replication view: disabled config and closed rounds both read as inactive", () => {
  assert.equal(resolveReplicationView(activeLedger(), { replication: { enabled: false } }).active, false);
  assert.equal(resolveReplicationView(activeLedger({ status: "reverted" }), {}).active, false);
  assert.equal(resolveReplicationView(null, {}).active, false);
});

test("page: REPLICATE panel shows the replicated style, its share and the cap", () => {
  const html = page(emptyPageData({ replication: resolveReplicationView(activeLedger(), {}) }));
  assert.match(html, /Double down on reach outliers/);
  assert.match(html, /EXPLORATION CAP 50%/);
  assert.match(html, /odd-one-out/);
  assert.match(html, /25% of each batch \(cap 50%\)/);
  assert.match(html, /Varying only:/);
  // the detection evidence that justified the round is shown, not just the verdict
  assert.match(html, /3\.31x/);
});

test("page: REPLICATE panel says so plainly when nothing is being replicated", () => {
  const html = page(emptyPageData({ replication: resolveReplicationView(null, {}) }));
  assert.match(html, /batch is 100% exploration/);
});

test("page: the display-only kill-switch STATUS BANNER is fully removed (helper + markup + CSS)", () => {
  // The green "kill-switch clear — factory auto-merge is armed" strip (and its
  // paused variant) were removed at the user's request; the factory kill-switch
  // state still lives in the FACTORY panel + the top health widget.
  const clear = page(emptyPageData({ kill: { engaged: false, sources: [] } }));
  const engaged = page(emptyPageData({ kill: { engaged: true, sources: ["env SFFS_FACTORY_KILL"] } }));
  for (const html of [clear, engaged]) {
    assert.doesNotMatch(html, /kill-switch clear/);
    assert.doesNotMatch(html, /auto-merge is armed/);
    assert.doesNotMatch(html, /Display-only indicator/);
    assert.doesNotMatch(html, /class="kill /);      // no .kill / .kill-off / .kill-paused banner
    assert.doesNotMatch(html, /class="kill-dot"/);
  }
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
  // NARROWED, NOT WEAKENED. The dashboard now has exactly ONE mutation — approve/reject
  // on a queued draft — and these assertions still forbid everything else. There is
  // still no <form method=post> anywhere; the approval control is a scoped fetch to two
  // named endpoints, so a stray mutating form remains a test failure.
  assert.doesNotMatch(html, /method\s*=\s*["']post["']/i);
  // Still no control that would publish/schedule/merge/post arbitrary content.
  assert.doesNotMatch(html, /<button[^>]*>\s*(publish|schedule|merge|post|go live)/i);
  assert.doesNotMatch(html, /<input[^>]*type\s*=\s*["']submit["'][^>]*(publish|schedule|merge)/i);
  // Every endpoint the page can reach, as an explicit allowlist. A new fetch target is a
  // test failure until someone adds it here deliberately, which is the point: this is the
  // line that stops the surface widening by accident.
  const ALLOWED_FETCH = new Set(["/api/health", "/api/approve", "/api/reject"]);
  for (const m of html.matchAll(/fetch\(\s*["'`]([^"'`]+)["'`]/g)) {
    assert.ok(ALLOWED_FETCH.has(m[1]), `unexpected fetch target ${m[1]}`);
  }
  // POST is the only verb the page may use; PUT/PATCH/DELETE must never appear. PUT in
  // particular is destructive on this account — it evicted ten published rows on 07-28.
  assert.doesNotMatch(html, /method:\s*["'](PUT|PATCH|DELETE)["']/i);
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
          { metricool_uuid: "1", platform_post_id: "NAT1", platform: "tiktok", permalink: "https://tiktok.com/@x/video/NAT1", posted_at: "2026-07-20", variant: { arm: "control" }, metrics: { eng_rate: 5.1 } },
          { metricool_uuid: "2", platform_post_id: null, permalink: null, post_state: "draft" }, // draft -> excluded
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
      db: { posts: [{ metricool_uuid: "1", platform_post_id: "N", permalink: "https://x/1", posted_at: "d", variant: { arm: "a" }, metrics: {} }] },
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

test("SECURITY: redactRunForPublic strips the presigned media_url from every video", () => {
  const run = {
    run_id: "r", started_at: "", updated_at: "", status: "success",
    videos: [
      { id: "v1", index: 0, dimension: "d", arm: "a", rationale: "", status: "drafted", media_url: "https://b.s3.amazonaws.com/o?X-Amz-Signature=abc&X-Amz-Credential=ASIA" },
      { id: "v2", index: 1, dimension: "d", arm: "a", rationale: "", status: "drafted" },
    ],
  } as any;
  const out = redactRunForPublic(run)!;
  assert.ok(!("media_url" in out.videos[0]));
  assert.doesNotMatch(JSON.stringify(out), /X-Amz-Signature|X-Amz-Credential/);
  assert.equal(out.videos.length, 2);
});

test("GUARDRAIL: cycle-status batch shows Metricool uuids as plain text (never a deep-link)", () => {
  const run = {
    run_id: "2026-07-22", started_at: "s", updated_at: "u", status: "success",
    summary: { planned: 1, drafted: 1, rejected: 0, failed: 0 },
    videos: [{
      id: "v1", index: 0, dimension: "cliffhanger", arm: "last-hidden", rationale: "r",
      status: "drafted", caption: "c", hashtag_set: "A",
      // a negative uuid is the realistic case: Metricool's uuid is a signed 64-bit int
      metricool: { uuids: ["8259645875429329828", "-6297496666514044627"] },
    }],
  } as any;
  const html = page(emptyPageData({ latest: run, runs: [run] }));
  assert.match(html, /8259645875429329828/); // uuids still shown for reference …
  assert.match(html, /-6297496666514044627/);
  assert.doesNotMatch(html, /<a[^>]*>[^<]*8259645875429329828/); // … but NOT as a link
});

test("LAYOUT: page guards horizontal scroll (overflow-x hidden + wrapped tables + inline-block chips)", () => {
  const pr = {
    ok: true, repo: "owner/repo", rows: [], gh_available: true,
    counts: { open: 0, merged: 0, ledger: 1 },
    ledgerOnly: [{
      source: "sffs-factory/safe-add-tested-clamp-helper-alpha-191124-really-long-unbreakable-branch",
      target: "hermes-nous", harness: "GREEN", review: "APPROVE", decision: "MERGE", merged: false, ts: "2026-07-22T19:09:04Z",
    }],
  };
  const html = page(emptyPageData({ pr: pr as any }));
  // page-level guard: the document body must never scroll horizontally
  assert.match(html, /html,body\{[^}]*overflow-x:hidden/);
  // chips render as ONE crisp single-line box (inline-block + nowrap ⇒ no fragmentation)
  assert.match(html, /\.chip\{[^}]*display:inline-block/);
  assert.match(html, /\.chip\{[^}]*white-space:nowrap/);
  // wide tables live inside their own horizontal-scroll container …
  assert.match(html, /\.tblwrap\{[^}]*overflow-x:auto/);
  assert.match(html, /<div class="tblwrap"><table class="tbl">/);
  // … and long unbreakable branch names can wrap instead of overflowing the page
  assert.match(html, /overflow-wrap:anywhere/);
  assert.match(html, /safe-add-tested-clamp-helper-alpha-191124-really-long-unbreakable-branch/);
  // the run-selector must be able to shrink (not overflow the viewport) on narrow screens
  assert.match(html, /select\{[^}]*max-width:100%/);
  assert.match(html, /\.card h2\{[^}]*flex-wrap:wrap/);
});

// ── GOAL-PROGRESS (Hermes's 14-day mandate) — pure math ──────────────────────
const goalPosts = [
  { platform: "instagram", posted_at: "2026-07-20T10:00:00Z", metrics: { video_views: 100, reactions: 10 }, variant: { arm: "hook-a", family: "hook" } },
  { platform: "tiktok", posted_at: "2026-07-20T11:00:00Z", metrics: { video_views: 200, reactions: 20 }, variant: { arm: "hook-b", family: "hook" } },
  { platform: "instagram", posted_at: "2026-07-21T10:00:00Z", metrics: { video_views: 400, reactions: 5 }, variant: { arm: "hook-a", family: "hook" } },
];

test("computeGoalProgress: BEFORE kickoff ⇒ pending, full window clock, running totals, followers pending", () => {
  const gp = computeGoalProgress(goalPosts, null, null, new Date("2026-07-22T00:00:00Z"));
  // pending: not armed, no t0, clock reads the full window, not started
  assert.equal(gp.armed, false);
  assert.equal(gp.since, null);
  assert.equal(gp.daysLeft, GOAL.windowDays);
  assert.equal(gp.hoursLeft, 0);
  assert.equal(gp.windowClosed, false);
  // running totals over ALL posts (t0 null)
  assert.equal(gp.instagram.views.value, 500); // 100 + 400
  assert.equal(gp.tiktok.views.value, 200);
  assert.equal(gp.combined.views.value, 700);
  assert.equal(gp.combined.posts, 3);
  // mandate targets (combined full; per-platform a THIRD each now that YouTube is in
  // the views universe; followers 500 each / 1k combined, IG + TikTok only). Likes dropped.
  assert.equal(gp.combined.views.target, 200_000);
  assert.equal(gp.instagram.views.target, 200_000 / 3);
  assert.equal(gp.youtube.views.target, 200_000 / 3);
  assert.equal(gp.instagram.followers.target, 500);
  assert.equal(gp.youtube.followers.target, 0, "there is no YouTube follower goal");
  assert.equal(gp.youtube.followers.value, null, "and it reads pending, never a fake 0/500");
  assert.equal(gp.combined.followers.target, 1_000);
  // likes removed from the goal shape entirely
  assert.equal((gp.combined as Record<string, unknown>).likes, undefined);
  // followers absent ⇒ pending (null), NOT 0/fake
  assert.equal(gp.followersPending, true);
  assert.equal(gp.instagram.followers.value, null);
  assert.equal(gp.combined.followers.value, null);
  // no observed pace before kickoff, but the honest "needed/day" mountain is finite
  assert.equal(gp.instagram.paceViewsPerDay, null);
  assert.equal(gp.combined.neededViewsPerDay, (GOAL.views - 700) / GOAL.windowDays);
  // The retarget's whole point: a pace a batch can plausibly reach, not 35,700/day.
  assert.equal(Math.round(gp.combined.neededViewsPerDay!), 14_236, "cold account, 200k over 14 days");
  // "what's moving the needle": arms aggregated by views
  assert.equal(gp.topArmsByViews[0].arm, "hook-a");
  assert.equal(gp.topArmsByViews[0].views, 500);
  assert.equal(gp.topArmsByViews[0].family, "hook");
});

test("computeGoalProgress: AFTER kickoff ⇒ windowed per-platform aggregation + days-left + observed/needed pace", () => {
  const t0 = "2026-07-20T10:30:00Z"; // between post1 (10:00, excluded) and post3
  const gp = computeGoalProgress(
    goalPosts,
    t0,
    { instagram: { followers: 120 }, tiktok: { followers: 340 } },
    new Date("2026-07-22T10:30:00Z"), // exactly 2 days after t0
  );
  assert.equal(gp.armed, true);
  assert.equal(gp.since, new Date(t0).toISOString());
  assert.equal(gp.daysLeft, 12); // 14 - 2
  assert.equal(gp.hoursLeft, 0);
  assert.equal(gp.windowClosed, false);
  // windowing: the pre-t0 IG post (10:00) is excluded; only post3 (IG) + post2 (TikTok) count
  assert.equal(gp.instagram.views.value, 400);
  assert.equal(gp.instagram.posts, 1);
  assert.equal(gp.tiktok.views.value, 200);
  assert.equal(gp.combined.views.value, 600);
  assert.equal(gp.combined.posts, 2);
  // observed pace over the 2 elapsed days
  assert.equal(gp.combined.paceViewsPerDay, 300); // 600 / 2
  // needed pace over the remaining 12 days
  assert.equal(gp.combined.neededViewsPerDay, (GOAL.views - 600) / 12);
  // followers now come from the snapshot (not pending)
  assert.equal(gp.followersPending, false);
  assert.equal(gp.instagram.followers.value, 120);
  assert.equal(gp.tiktok.followers.value, 340);
  assert.equal(gp.combined.followers.value, 460);
});

test("computeGoalProgress: window closed unmet ⇒ needed=null (∞); target met ⇒ needed=0", () => {
  const t0 = "2026-07-20T00:00:00Z";
  const closed = computeGoalProgress(goalPosts, t0, null, new Date("2026-08-04T00:00:00Z")); // 15d > 14d
  assert.equal(closed.windowClosed, true);
  assert.equal(closed.daysLeft, 0);
  assert.equal(closed.combined.neededViewsPerDay, null); // unmet + closed ⇒ impossible
  // a post that blows past the target ⇒ needed drops to 0 (already met)
  const met = computeGoalProgress(
    [{ platform: "tiktok", posted_at: "2026-07-21T00:00:00Z", metrics: { video_views: 2_000_000, reactions: 300_000 } }],
    t0, null, new Date("2026-07-22T00:00:00Z"),
  );
  assert.equal(met.combined.neededViewsPerDay, 0);
  assert.ok(met.combined.views.pct >= 100);
});

test("computeGoalProgress: the window anchor and the kickoff instant are carried separately", () => {
  // Since 2026-08-03 these are two different facts: when a human armed autonomy, and
  // when the mandate's clock starts. The panel shows both, so a re-anchored window can
  // never look like someone quietly re-armed the loop.
  assert.equal(WINDOW_START, "2026-08-03T22:00:00.000Z");
  const kickoff = "2026-07-23T17:12:15.000Z";
  assert.equal(goalWindowStart(kickoff), WINDOW_START, "armed => the explicit anchor wins");
  assert.equal(goalWindowStart(null), null, "un-armed => no window, whatever the anchor says");
  const gp = computeGoalProgress([], goalWindowStart(kickoff), null, new Date("2026-08-04T22:00:00.000Z"), null, kickoff);
  assert.equal(gp.since, WINDOW_START);
  assert.equal(gp.kickoffSince, kickoff);
  assert.equal(gp.daysLeft, 13);
});

// ── THE HEADLINE: median skip rate against the threshold the goal needs ──────
const reel = (skipRate: number | null, daysAgo: number, reach = 150, views = 175) => ({
  skipRate,
  reach,
  views,
  publishedAt: { dateTime: new Date(Date.parse("2026-08-03T12:00:00Z") - daysAgo * 864e5).toISOString().slice(0, 19), timezone: "UTC" },
});
const NOW_SKIP = new Date("2026-08-03T12:00:00Z");

test("summarizeSkipRate: the median is the current window's, and the trend is the one before it", () => {
  const sk = summarizeSkipRate(
    [
      reel(70, 1), reel(72, 2), reel(74, 3), // current 7d
      reel(80, 9), reel(82, 10), // prior 7d
    ],
    NOW_SKIP,
  );
  assert.equal(sk.median, 72);
  assert.equal(sk.n, 3);
  assert.equal(sk.priorMedian, 81);
  assert.equal(sk.priorN, 2);
  assert.equal(sk.delta, -9, "negative delta is an IMPROVEMENT — lower skip is better");
  assert.equal(sk.threshold, SKIP_TARGET_PCT);
  assert.equal(sk.meetingTarget, false);
});

test("summarizeSkipRate: a reel with no skip rate is PENDING, never counted as a perfect 0%", () => {
  // Metricool syncs analytics up to ~24h behind. Scoring a pending reel as 0 would read
  // as a flawless hook and drag the headline below the threshold on no evidence at all.
  const sk = summarizeSkipRate([reel(null, 1), reel(null, 2), reel(80, 3)], NOW_SKIP);
  assert.equal(sk.n, 1);
  assert.equal(sk.median, 80);
  const none = summarizeSkipRate([reel(null, 1)], NOW_SKIP);
  assert.equal(none.median, null);
  assert.equal(none.n, 0);
  assert.equal(none.meetingTarget, false, "no data is not the same as meeting the target");
});

test("summarizeSkipRate: 55% is the wall the mandate needs, and at-or-under counts as met", () => {
  assert.equal(SKIP_TARGET_PCT, 55);
  assert.equal(summarizeSkipRate([reel(55, 1)], NOW_SKIP).meetingTarget, true);
  assert.equal(summarizeSkipRate([reel(55.1, 1)], NOW_SKIP).meetingTarget, false);
  // No prior sample ⇒ no fabricated trend.
  assert.equal(summarizeSkipRate([reel(55, 1)], NOW_SKIP).delta, null);
});

// ── THE TARGET'S DEPENDENCY: which band 200,000 actually needs ───────────────
test("requiredSkipBand: picks the LEAST demanding measured band that still reaches the target", () => {
  // 200,000 clears 50-55% (215,000) and does NOT clear 55-60% (181,000), so the
  // required band is 50-55% — not the best band on the table, the cheapest one that works.
  const band = requiredSkipBand(200_000);
  assert.equal(band?.label, "50–55%");
  assert.equal(band?.to, 55);
  assert.equal(band?.projectedViews, 215_000);
  // A softer target resolves to a softer band rather than over-demanding.
  assert.equal(requiredSkipBand(150_000)?.label, "55–60%");
  assert.equal(requiredSkipBand(30_000)?.label, "~70%");
  // And a target that only the best band reaches resolves to the best band.
  assert.equal(requiredSkipBand(250_000)?.label, "under 50%");
});

test("requiredSkipBand: an unreachable target is NULL, not the best band", () => {
  // This is the finding that produced the retarget. 500,000 was above every band the
  // account has ever measured, so there is no skip rate that reaches it — and saying
  // "get under 50%" would have implied the target was merely hard. It was not available.
  assert.equal(requiredSkipBand(500_000), null);
  const best = Math.max(...SKIP_VIEW_PROJECTIONS.map((b) => b.projectedViews));
  assert.equal(requiredSkipBand(best + 1), null);
  assert.ok(GOAL.views <= best, "the live target must be reachable from some measured band");
});

test("requiredSkipBand: the band the live target needs is the band the headline enforces", () => {
  // The headline tracks the median against SKIP_TARGET_PCT while the goal card states
  // the band the target depends on. If those two ever disagree the page is arguing with
  // itself — one number to hit, a different one being measured against.
  assert.equal(requiredSkipBand(GOAL.views)?.to, SKIP_TARGET_PCT);
});

test("page: the goal card states the target's dependency — band, projection, live gap", () => {
  // A view target with no lever beside it is weather. The number, the skip rate it
  // requires, and where the median actually sits have to be readable in one glance.
  const data = emptyPageData();
  (data as any).scheduled = {
    ok: true, posts: [], count: 0, by_platform: {}, by_status: {},
    experiment: { target: 0, hook_scheduled: 0, hook_excluded: 0, hook_posted: 0, control_scheduled: 0, control_posted: 0, hook_with_data: 0, hook_median_skip: null, control_median_skip: null, on_track: false },
    skip: summarizeSkipRate([reel(69.3, 1)], NOW_SKIP),
    source: "test", as_of: "2026-08-03T12:00:00Z",
  };
  const html = page(data);
  assert.match(html, /Requires a median 3s skip rate in the <b>50–55%<\/b> band/);
  assert.match(html, /projects <b>215,000<\/b> views over the 14-day window/);
  assert.match(html, /Current median <b>69\.3%<\/b> is <b>14\.3 points<\/b> above the <b>55%<\/b>/);
  // it sits with the target, not off in its own panel
  const mandateIdx = html.indexOf("200,000</b> views combined");
  const depIdx = html.indexOf("Requires a median 3s skip rate");
  assert.ok(mandateIdx > -1 && depIdx > mandateIdx, "the dependency reads directly under the target");
  assert.ok(depIdx < html.indexOf("Posts &amp; times"));
});

test("page: a median inside the band reads as met, not as a gap", () => {
  const data = emptyPageData();
  (data as any).scheduled = {
    ok: true, posts: [], count: 0, by_platform: {}, by_status: {},
    experiment: { target: 0, hook_scheduled: 0, hook_excluded: 0, hook_posted: 0, control_scheduled: 0, control_posted: 0, hook_with_data: 0, hook_median_skip: null, control_median_skip: null, on_track: false },
    skip: summarizeSkipRate([reel(52, 1)], NOW_SKIP),
    source: "test", as_of: "2026-08-03T12:00:00Z",
  };
  const html = page(data);
  assert.match(html, /Current median <b>52\.0%<\/b> is under the <b>55%<\/b> that band needs/);
  assert.match(html, /class="gdep gdep-good"/);
  assert.doesNotMatch(html, /points<\/b> above the/);
});

test("page: with no matured reels the dependency states the band but NOT a fabricated gap", () => {
  // The band is a property of the target and is knowable with zero data. The gap is not.
  const html = page(emptyPageData());
  assert.match(html, /Requires a median 3s skip rate in the <b>50–55%<\/b> band/);
  assert.match(html, /Current median is <b>pending<\/b>/);
  assert.doesNotMatch(html, /is <b>0\.0 points<\/b> above/);
});

test("page: the HEADLINE is skip rate against the threshold, above the view bars", () => {
  // Views are the goal, skip rate is the lever. An operator staring at a view counter
  // has nothing to act on, so the number at the top of the page has to be the lever.
  const data = emptyPageData();
  (data as any).scheduled = {
    ok: true, posts: [], count: 0, by_platform: {}, by_status: {},
    experiment: { target: 0, hook_scheduled: 0, hook_excluded: 0, hook_posted: 0, control_scheduled: 0, control_posted: 0, hook_with_data: 0, hook_median_skip: null, control_median_skip: null, on_track: false },
    skip: summarizeSkipRate([reel(70, 1), reel(72, 2), reel(80, 9)], NOW_SKIP),
    source: "test", as_of: "2026-08-03T12:00:00Z",
  };
  const html = page(data);
  assert.match(html, /MEDIAN 3s SKIP RATE/);
  assert.match(html, /71\.0%/, "the live median is the headline figure");
  assert.match(html, /target &le;55%/);
  assert.match(html, /16\.0 pts<\/b> above target/, "the gap to the threshold is stated, not left to arithmetic");
  // It is ABOVE the view bars, and above everything else on the page.
  const skipIdx = html.indexOf("MEDIAN 3s SKIP RATE");
  assert.ok(skipIdx > -1);
  assert.ok(skipIdx < html.indexOf("200,000</b> views combined"), "the lever leads the goal card");
  assert.ok(skipIdx < html.indexOf("Posts &amp; times"));
});

test("page: with no matured reels the headline reads pending, not 0%", () => {
  const html = page(emptyPageData());
  assert.match(html, /MEDIAN 3s SKIP RATE/);
  assert.match(html, /this is NOT 0%/);
});

// ── GOAL-PROGRESS panel renders FRONT-AND-CENTER ─────────────────────────────
test("page: GOAL panel renders FRONT-AND-CENTER with the exact mandate targets + pure-CSS bars", () => {
  const html = page(emptyPageData());
  assert.match(html, /Hermes mandate — live 14-day trajectory/);
  assert.match(html, /KICKOFF PENDING/); // no goal data ⇒ pending panel
  // the exact mandate numbers are on the page (200k views + 500 followers each; NO likes)
  assert.match(html, /200,000<\/b> views combined/);
  assert.match(html, /500<\/b> followers on EACH/);
  assert.doesNotMatch(html, /likes combined/i); // likes removed from the mandate line
  // 200,000 was the OLD LIKES target and this line used to ban the digits outright. It
  // is now the VIEWS target, so the guard names what it was really protecting: no
  // like/engagement target on the page, whatever number it would have been written as.
  assert.doesNotMatch(html, /likes (?:target|goal)/i);
  assert.doesNotMatch(html, /<b>[\d,]+<\/b> likes/i);
  // FRONT-AND-CENTER: the GOAL card comes before SCHEDULED and Cycle status
  const goalIdx = html.indexOf("Hermes mandate");
  const schedIdx = html.indexOf("Posts &amp; times");
  const cycleIdx = html.indexOf("Cycle status");
  assert.ok(goalIdx > -1 && schedIdx > goalIdx, "GOAL panel must render before SCHEDULED");
  assert.ok(cycleIdx > goalIdx, "GOAL panel must render before Cycle status");
  // pure CSS/inline-style progress bars, no external assets
  assert.match(html, /class="gbar"/);
  assert.match(html, /class="gfill" style="width:/);
});

test("page: GOAL panel shows ARMED state, honest pace gap, snapshot followers, and top arms", () => {
  const goal = computeGoalProgress(
    [
      { platform: "instagram", posted_at: "2026-07-21T00:00:00Z", metrics: { video_views: 500, reactions: 15 }, variant: { arm: "hook-a", family: "hook" } },
      { platform: "tiktok", posted_at: "2026-07-21T00:00:00Z", metrics: { video_views: 993, reactions: 40 }, variant: { arm: "speed-fast", family: "speed" } },
    ],
    "2026-07-20T00:00:00Z",
    { instagram: { followers: 120 }, tiktok: { followers: 88 } },
    new Date("2026-07-22T00:00:00Z"),
  );
  const html = page(emptyPageData({ goal }));
  assert.match(html, /KICKOFF ARMED/);
  assert.match(html, /views\/day observed/);
  assert.match(html, /views\/day needed/); // the honest gap is surfaced
  assert.match(html, /hook-a/);
  assert.match(html, /speed-fast/); // top arms by views/likes
  assert.doesNotMatch(html, /followers snapshot<\/b>pending/); // snapshot loaded ⇒ not pending
});

test("GUARDRAIL: GOAL panel adds NO mutating control and leaks NO secrets", () => {
  const goal = computeGoalProgress(goalPosts, "2026-07-20T00:00:00Z", { instagram: { followers: 5 }, tiktok: { followers: 9 } }, new Date("2026-07-22T00:00:00Z"));
  const html = page(emptyPageData({ goal }));
  assert.doesNotMatch(html, /method\s*=\s*["']post["']/i);
  assert.doesNotMatch(html, /<button[^>]*>\s*(publish|schedule|merge|post|go live|approve|reject|arm)/i);
  assert.doesNotMatch(html, /<input[^>]*type\s*=\s*["']submit["']/i);
  // no secrets / no S3 presigned material introduced by this panel
  assert.doesNotMatch(html, /X-Amz-|amazonaws\.com|Bearer\s|api[_-]?key/i);
});

// ── (D) DASHBOARD POLISH ─────────────────────────────────────────────────────
const schedFixture = {
  ok: true, source: "metricool (live, read-only bridge)", as_of: "2026-07-23T22:00:00Z",
  count: 1, by_platform: { tiktok: 1 }, by_status: { PENDING: 1 },
  experiment: { target: 15, hook_scheduled: 0, hook_posted: 0, control_scheduled: 1, control_posted: 0,
    hook_with_data: 0, hook_median_skip: null, control_median_skip: null, on_track: false },
  posts: [{
    post_id: "s1", platform: "tiktok",
    scheduled_at: "2026-07-24T02:17:00Z", scheduled_cst: "Wed Jul 23, 9:17 PM CDT",
    hook: "smart or fart?", arm: "control", arm_source: "run" as const,
    video_key: "sm1",
    thumbnail: null,
    media_url: "https://static.metricool.com/planner/202607/6617222-file-1738.mp4",
    status: "PENDING", public_url: null, opening: "cold-plate", video_id: "2026-07-23-r01", skip_rate: null,
  }],
};

test("D3: video previews are FULL-FRAME (object-fit:contain, never cover)", () => {
  const html = page(emptyPageData({ scheduled: schedFixture as any }));
  assert.match(html, /\.dvid\{[^}]*object-fit:contain/);
  assert.match(html, /\.dthumb-img\{[^}]*object-fit:contain/);
  assert.doesNotMatch(html, /object-fit:cover/); // no crop anywhere
});

test("D3: Plyr is vendored locally (no external CDN at runtime) and initialised on previews", () => {
  const html = page(emptyPageData({ scheduled: schedFixture as any }));
  assert.match(html, /<link rel="stylesheet" href="\/static\/plyr\.css"\/>/);
  assert.match(html, /<script src="\/static\/plyr\.min\.js"><\/script>/);
  assert.match(html, /new Plyr\(/);
  assert.match(html, /iconUrl: '\/static\/plyr\.svg'/);
  assert.doesNotMatch(html, /cdn\.plyr\.io|cdn\.jsdelivr\.net|unpkg\.com/); // never a runtime CDN
});

test("D3: SCHEDULED panel plays Metricool media DIRECTLY (its CDN is public — no proxy)", () => {
  const html = page(emptyPageData({ scheduled: schedFixture as any }));
  assert.match(html, /9:17 PM CDT/); // the scheduled time is still prominent
  assert.match(html, /<video[^>]*\bcontrols\b/);
  // static.metricool.com serves the asset with no Referer, a hostile Referer and a
  // foreign Origin (verified live, HTTP 200 every way), so the <video> points straight
  // at it. The same-origin media proxy that a Referer-gated CDN once required is gone.
  assert.match(html, /src="https:\/\/static\.metricool\.com\/[^"]+\.mp4"/);
  assert.doesNotMatch(html, /\/api\/draft-media/);
  assert.doesNotMatch(html, /amazonaws|X-Amz-/); // no S3-signed leak
});

// ── A/B arm label = REAL dimension:arm (not the LLM caption opener) ───────────
test("abTestLabel: plain-language change vs default, control + neutral unknown (never the caption)", () => {
  const d = { narration: "full", ending: "cliffhanger", mascot: "mascot-prominent" };
  const nar = abTestLabel("narration", "no-narration", d);
  assert.equal(nar.tag, "A/B");
  assert.match(nar.text, /no voiceover/);
  assert.match(nar.text, /default: full voiceover/);
  const mas = abTestLabel("mascot", "mascot-absent", d);
  assert.match(mas.text, /no mascot/);
  // mascot-prominent is the default, and the label has to name it as something a human
  // reads as "more mascot than usual" rather than as a neutral baseline.
  assert.match(mas.text, /default: enlarged mascot/);
  assert.match(abTestLabel("tempo", "tempo-fast", d).text, /fast 3s countdown/);
  assert.equal(abTestLabel("control", "control", d).kind, "control");
  assert.equal(abTestLabel("unknown", "unknown", d).kind, "unknown");
  assert.equal(abTestLabel("", "", d).kind, "unknown");
  assert.equal(abTestLabel(undefined, undefined, d).kind, "unknown");
  assert.doesNotMatch(nar.text, /think-you-got|bet-you/);
});

test("SCHEDULED cards render PLAIN-LANGUAGE change-vs-default (never the caption opener); neutral when unmatched", () => {
  const sched = {
    ok: true, source: "t", as_of: "t", count: 2, by_platform: { tiktok: 2 },
    posts: [
      { post_id: "s1", platform: "tiktok", scheduled_at: "2026-07-24T02:17:00Z", scheduled_cst: "t1",
        hook: "think you got this", dimension: "narration", arm: "no-narration", arm_source: "run",
        video_key: "k1", thumbnail: null, media_url: null,
        status: "PENDING", public_url: null, opening: "", video_id: "", skip_rate: null },
      { post_id: "s2", platform: "tiktok", scheduled_at: "2026-07-24T03:17:00Z", scheduled_cst: "t2",
        hook: "bet you cant solve this", dimension: "unknown", arm: "unknown", arm_source: "inferred",
        video_key: "k2", thumbnail: null, media_url: null,
        status: "PENDING", public_url: null, opening: "", video_id: "", skip_rate: null },
    ],
  };
  const html = page(emptyPageData({ scheduled: sched as any }));
  assert.match(html, /no voiceover/);                          // plain-language change (not jargon)
  assert.match(html, /default: full voiceover/);               // vs the current default
  assert.match(html, /not linked to a batch variant/);         // neutral fallback for an unmatched post
  assert.doesNotMatch(html, /think-you-got-this|bet-you-cant/); // NEVER the caption-opener slug
});

test("Item 1: per-card schedule chip shows TIME-ONLY (no redundant 'Scheduled' label)", () => {
  const sHtml = page(emptyPageData({ scheduled: schedFixture as any }));
  assert.match(sHtml, /class="timechip"/);           // prominent mint pill present
  assert.match(sHtml, /Wed Jul 23, 9:17 PM CDT/);    // uses scheduled_cst (the date/time itself)
  assert.doesNotMatch(sHtml, /class="tc-k"/);        // redundant "Scheduled ·" label REMOVED
});

test("Item 5: KPIs are split into labelled 'This cycle' vs 'Bank & live totals' groups", () => {
  const html = page(emptyPageData());
  assert.match(html, /class="statlabel"[^>]*>This cycle/);
  assert.match(html, /Bank &amp; live totals/);
  assert.match(html, /\(this cycle\)/);
  assert.match(html, /fresh questions \(bank\)/);
  assert.match(html, /days runway \(bank est\.\)/);
});

test("Item 2: BANK panel surfaces the honest reconciled used-set method + residual uncertainty", () => {
  const html = page(emptyPageData());
  assert.match(html, /Used-set \(honest\)/);
  assert.match(html, /Residual uncertainty/);
});

test("D3: resolveScheduledMediaUrl resolves by video_key, allowlist-guarded (no S3)", () => {
  // ONLY the public Metricool CDN resolves. Everything else — a pre-migration asset on
  // a retired CDN, and above all an S3 presigned url — resolves to null, so a signed url
  // can never reach the page.
  const MC = "https://static.metricool.com/planner/202607/6617222-file-1738.mp4";
  const view = { ...schedFixture, posts: [
    schedFixture.posts[0],
    { ...schedFixture.posts[0], video_key: "legacy", thumbnail: "https://cdn.retired-scheduler.example/photos/s.jpg",
      media_url: "https://cdn.retired-scheduler.example/videos/sm1/v.mp4" },
    { ...schedFixture.posts[0], video_key: "bad", thumbnail: null, media_url: "https://bkt.s3.amazonaws.com/v.mp4?X-Amz-Signature=z" },
  ]} as any;
  assert.equal(resolveScheduledMediaUrl(view, "sm1", "video"), MC);
  assert.equal(resolveScheduledMediaUrl(view, "sm1", "thumb"), null); // fixture has no poster
  assert.equal(resolveScheduledMediaUrl(view, "legacy", "video"), null); // off-host ⇒ rejected
  assert.equal(resolveScheduledMediaUrl(view, "legacy", "thumb"), null);
  assert.equal(resolveScheduledMediaUrl(view, "bad", "video"), null); // S3-signed ⇒ rejected
  assert.equal(resolveScheduledMediaUrl(view, "nope", "video"), null);
  assert.equal(resolveScheduledMediaUrl(null, "sm1", "video"), null);
});

test("SECURITY: sanitizeScheduledForPublic nulls any non-public-CDN scheduled media", () => {
  const view = { ok: true, source: "t", as_of: "t", count: 1, by_platform: {}, posts: [
    { post_id: "s", platform: "tiktok", scheduled_at: "", scheduled_cst: "", hook: "", arm: "", arm_source: "run",
      video_key: "k", thumbnail: "https://bkt.s3.amazonaws.com/t.jpg?X-Amz-Signature=z",
      media_url: "https://bkt.s3.amazonaws.com/v.mp4?X-Amz-Signature=z&X-Amz-Credential=ASIA" },
  ]} as any;
  const out = sanitizeScheduledForPublic(view);
  assert.equal(out.posts[0].media_url, null);
  assert.equal(out.posts[0].thumbnail, null);
  assert.doesNotMatch(JSON.stringify(out), /X-Amz-|amazonaws\.com/);
});

test("D4: the run picker is width-bounded + ellipsised so it can't overlap the panel title", () => {
  const runs = [{ run_id: "complete-hermes-showcase-20260723T024825Z", status: "success", summary: { drafted: 3 } }] as any;
  const html = page(emptyPageData({ runs, latest: runs[0] }));
  assert.match(html, /\.runsel select\{[^}]*max-width/);
  assert.match(html, /\.runsel select\{[^}]*text-overflow:ellipsis/);
});

test("D4b: run picker is restyled to the neo-brutalist system + stays an accessible native <select>", () => {
  const runs = [{ run_id: "complete-hermes-showcase-20260723T024825Z", status: "success", summary: { drafted: 3 } }] as any;
  const html = page(emptyPageData({ runs, latest: runs[0] }));
  // ACCESSIBILITY: still a native <select> paired with its <label for="run"> (keyboard + SR)
  assert.match(html, /<label for="run">/);
  assert.match(html, /<select id="run" name="run"/);
  // NEO-BRUTALIST: appearance reset + custom caret + thick ink border + hard offset shadow + brand fill
  assert.match(html, /\.runsel select\{[^}]*appearance:none/);
  assert.match(html, /\.runsel select\{[^}]*background-image:url\(/);
  assert.match(html, /\.runsel select\{[^}]*border:3px solid var\(--ink\)/);
  assert.match(html, /\.runsel select\{[^}]*box-shadow:4px 4px 0 0 var\(--ink\)/);
  assert.match(html, /\.runsel select\{[^}]*background-color:var\(--mint\)/);
  // interactive states, incl. a visible keyboard-focus indicator
  assert.match(html, /\.runsel select:hover\{/);
  assert.match(html, /\.runsel select:focus-visible\{/);
  // still width-bounded (no horizontal-scroll regression)
  assert.match(html, /\.runsel select\{[^}]*max-width:min\(62vw,340px\)/);
});

test("D5: footer reflects the LIVE autonomous state (no stale draft-only/human-action copy)", () => {
  const html = page(emptyPageData());
  // The footer now leads with the product name (the public rebrand) rather than the
  // internal codename, but must still describe the LIVE autonomous state.
  assert.match(html, /SFFS Self-Improving Agentic Marketing Loop<\/b> · posting/);
  assert.match(html, /run autonomously on the box under hard guardrails/);
  assert.match(html, /goal: 500K views/);
  assert.doesNotMatch(html, /the loop can ONLY create Publer drafts/);
  assert.doesNotMatch(html, /going live \+ merging code are human actions/);
  assert.doesNotMatch(html, /next run once a day/);
});

// ── (A) CONTINUOUS SUPERVISOR panel ──────────────────────────────────────────
test("A: SUPERVISOR panel renders the continuous orchestrator + the bounded-posting invariant", () => {
  const supervisor = {
    state: "working", state_reason: "ran knowledge", cycle: 7,
    last: { knowledge: 1_000_000, research: 999_000 },
    last_cycle: { did: ["knowledge", "content_prep"], dry_run: false },
    kill_switch: { engaged: false, reason: null },
  };
  const html = page(emptyPageData({ supervisor } as any));
  assert.match(html, /Always-on continuous orchestrator/);
  assert.match(html, /Continuous WORK, bounded POSTING/);
  assert.match(html, /never posts or schedules/);
  assert.match(html, /ran knowledge, content_prep/);
});

test("A: SUPERVISOR panel shows a calm paused state + empty state", () => {
  const paused = page(emptyPageData({ supervisor: { state: "paused-kill", cycle: 3, kill_switch: { engaged: true, reason: "stop-file" } } } as any));
  assert.match(paused, /paused \(maintenance\)/);
  assert.doesNotMatch(paused, /class="kill kill-on"/); // no red alarm styling
  const empty = page(emptyPageData());
  assert.match(empty, /No supervisor status yet/);
});

// ── (B) AUTONOMOUS default-promotion ledger + note (human view kept) ─────────
test("B: default-promotion panel shows the autonomous ledger + auto-gate note", () => {
  const proposals = {
    proposals: [], decisions_log: [],
    auto_ledger: [
      { ts: "2026-07-24T01:00:00Z", action: "auto-promote", dimension: "ending", from: "cliffhanger", to: "full-reveal", delta_abs_pp: 3.1, confirmed_new_samples: 6, active: true },
      { ts: "2026-07-25T01:00:00Z", action: "auto-revert", dimension: "ending", from: "full-reveal", to: "cliffhanger", m_promoted: 2.0, m_previous: 6.0, active: false },
    ],
  };
  const defaults = { defaults: { narration: "full", ending: "cliffhanger" }, auto_promotion: { enabled: true } };
  const html = page(emptyPageData({ proposals, defaults } as any));
  assert.match(html, /Autonomous promotion ledger/);
  assert.match(html, /auto-promote/);
  assert.match(html, /auto-revert/);
  assert.match(html, /Autonomous promotion: <b>ON<\/b>/);
  assert.match(html, /auto-adopted ONLY after a confirmation round/i);
  assert.match(html, /AUTONOMOUS/); // the panel pin
  // still read-only — no approve/reject/promote/revert buttons or POST form
  assert.doesNotMatch(html, /<button[^>]*>\s*(approve|reject|promote|revert)/i);
  assert.doesNotMatch(html, /method\s*=\s*["']post["']/i);
});

test("B: autonomous promotion OFF renders the human-only note", () => {
  const defaults = { defaults: { narration: "full", ending: "cliffhanger" }, auto_promotion: { enabled: false } };
  const html = page(emptyPageData({ defaults } as any));
  assert.match(html, /Autonomous promotion: <b>OFF<\/b>/);
  assert.match(html, /No pending default changes/); // human view preserved
});


// ── Metricool read path ──────────────────────────────────────────────────────
// The previous scheduler began returning HTTP 403 on every content endpoint, so
// /api/scheduled served an empty board while 41 posts sat on the calendar. An empty
// dashboard and a blind dashboard look identical to the reader, which is why these
// assertions are pinned.

test("publicMetricoolCdnUrl: accepts a clean static.metricool.com asset, rejects everything else", async () => {
  const { publicMetricoolCdnUrl } = await import("../data.ts");
  const good = "https://static.metricool.com/planner/202607/6617222-file-1738.mp4";
  assert.equal(publicMetricoolCdnUrl(good), good);
  // an S3 presigned url is structurally excluded: wrong host AND it carries a query
  assert.equal(publicMetricoolCdnUrl("https://hermes-sffs-media.s3.us-east-1.amazonaws.com/a.mp4?X-Amz-Signature=abc"), null);
  assert.equal(publicMetricoolCdnUrl("https://static.metricool.com/a.mp4?X-Amz-Signature=abc"), null);
  assert.equal(publicMetricoolCdnUrl("http://static.metricool.com/a.mp4"), null);  // not https
  assert.equal(publicMetricoolCdnUrl("https://evil.example/a.mp4"), null);
  assert.equal(publicMetricoolCdnUrl("https://user:pw@static.metricool.com/a.mp4"), null);
  assert.equal(publicMetricoolCdnUrl(null), null);
});

test("SECURITY: sanitizeScheduledForPublic nulls anything that is not a PUBLIC CDN asset", async () => {
  const { sanitizeScheduledForPublic } = await import("../data.ts");
  const view: any = { ok: true, count: 1, posts: [{
    post_id: "u1", platform: "instagram", scheduled_at: "2026-07-27T12:00:00Z", scheduled_cst: "x",
    hook: "h", dimension: "opening", arm: "motion-hook", arm_source: "inferred", video_key: "u1:instagram",
    thumbnail: "https://hermes-sffs-media.s3.us-east-1.amazonaws.com/t.jpg?X-Amz-Signature=abc",
    media_url: "https://hermes-sffs-media.s3.us-east-1.amazonaws.com/v.mp4?X-Amz-Signature=abc",
    status: "PENDING", public_url: null, opening: "motion-hook", video_id: "v1", skip_rate: null,
  }] };
  sanitizeScheduledForPublic(view);
  assert.equal(view.posts[0].media_url, null, "a presigned S3 url must never survive the choke point");
  assert.equal(view.posts[0].thumbnail, null);
});

test("GUARDRAIL: the Metricool read bridge imports NO write symbol", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../../bridge/metricool-read.ts", import.meta.url), "utf8");
  // The client also exports createPost / reschedule / deletePost. The bridge is the
  // only thing that touches it, and it may import ONLY the read functions.
  const imports = /import\s*\{([^}]*)\}\s*from\s*"[^"]*metricool\.ts"/.exec(src);
  assert.ok(imports, "bridge must import from the metricool client");
  const named = imports[1].split(",").map((x) => x.trim()).filter(Boolean);
  assert.deepEqual(named.sort(), ["instagramReels", "listPosts"]);
  // Strip comments first: the file's own header EXPLAINS why it must not import the
  // write functions, and naming them in prose is not the same as calling them.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const forbidden of ["createPost", "deletePost", "reschedule", "buildCreateBody"]) {
    assert.ok(!code.includes(forbidden), `bridge must not reference ${forbidden} in code`);
  }
});

test("GUARDRAIL: the dashboard never imports the Metricool client directly", async () => {
  const { readFileSync } = await import("node:fs");
  for (const f of ["../data.ts", "../server.ts", "../render.ts", "../config.ts"]) {
    const src = readFileSync(new URL(f, import.meta.url), "utf8");
    assert.ok(!/from\s*"[^"]*hermes\/src\/metricool\.ts"/.test(src),
      `${f} must reach Metricool only via the spawned read-only bridge`);
    for (const forbidden of ["createPost(", "deletePost(", "reschedule("]) {
      assert.ok(!src.includes(forbidden), `${f} must not call ${forbidden}`);
    }
  }
});

test("summarizeExperiment: counts arms, and reports medians only from posts WITH data", async () => {
  const { summarizeExperiment } = await import("../data.ts");
  const mk = (opening: string, status: string, skip: number | null) => ({
    post_id: Math.random().toString(36), platform: "instagram", scheduled_at: "2026-07-27T12:00:00Z",
    scheduled_cst: "x", hook: "h", dimension: "opening", arm: opening, arm_source: "inferred",
    video_key: "k" + Math.random(), thumbnail: null, media_url: null,
    status, public_url: null, opening, video_id: "", skip_rate: skip,
  });
  const e = summarizeExperiment([
    mk("motion-hook", "PUBLISHED", 60),
    mk("motion-hook", "PUBLISHED", 70),
    mk("motion-hook", "PUBLISHED", null),   // posted but not synced yet
    mk("motion-hook", "PENDING", null),
    mk("cold-plate", "PUBLISHED", 80),
    mk("cold-plate", "PENDING", null),
  ] as any, 15);
  assert.equal(e.hook_scheduled, 4);
  assert.equal(e.hook_posted, 3);
  assert.equal(e.control_posted, 1);
  assert.equal(e.hook_with_data, 2, "the unsynced post must not count as data");
  assert.equal(e.hook_median_skip, 65);
  assert.equal(e.control_median_skip, 80);
  assert.equal(e.on_track, false, "4 hook reels is short of 15");
  assert.equal(summarizeExperiment(Array.from({ length: 15 }, () => mk("motion-hook", "PENDING", null)) as any, 15).on_track, true);
});

test("page: EXPERIMENT panel shows the hook counter, arm chips and the live permalink", () => {
  const posts = [
    { post_id: "u1", platform: "instagram", scheduled_at: "2026-07-26T22:00:00Z", scheduled_cst: "Sun Jul 26, 5:00 PM CDT",
      hook: "how many did you get", dimension: "opening", arm: "cold-plate", arm_source: "inferred",
      video_key: "u1:instagram", thumbnail: null, media_url: null, status: "PUBLISHED",
      public_url: "https://www.instagram.com/reel/DbRalCfk3DY/", opening: "cold-plate", video_id: "2026-07-26-r01", skip_rate: null },
    { post_id: "u2", platform: "instagram", scheduled_at: "2026-07-26T23:12:00Z", scheduled_cst: "Sun Jul 26, 6:12 PM CDT",
      hook: "bet you get this wrong", dimension: "opening", arm: "motion-hook", arm_source: "inferred",
      video_key: "u2:instagram", thumbnail: null, media_url: null, status: "PENDING",
      public_url: null, opening: "motion-hook", video_id: "2026-07-26-r02", skip_rate: null },
  ];
  const view: any = { ok: true, posts, count: 2, by_platform: { instagram: 2 }, by_status: { PUBLISHED: 1, PENDING: 1 },
    experiment: { target: 15, hook_scheduled: 1, hook_posted: 0, control_scheduled: 1, control_posted: 1,
      hook_with_data: 0, hook_median_skip: null, control_median_skip: null, on_track: false },
    source: "metricool (live, read-only bridge)", as_of: "2026-07-26T22:30:00Z" };
  const html = page(emptyPageData({ scheduled: view }));
  assert.match(html, /1 \/ 15 usable hook reels/);                 // the counter the human reads
  assert.match(html, />HOOK</);                             // per-card arm chip
  assert.match(html, />CONTROL</);
  assert.match(html, /PUBLISHED/);
  assert.match(html, /instagram\.com\/reel\/DbRalCfk3DY/); // live permalink surfaced
  assert.match(html, /LIVE FROM METRICOOL/);
  assert.match(html, /1 published/);
  assert.match(html, /1 pending/);
});

test("skip rate renders as PENDING, never as a misleading 0%", () => {
  const mkPost = (skip: number | null) => ({
    post_id: "u1", platform: "instagram", scheduled_at: "2026-07-26T22:00:00Z", scheduled_cst: "x",
    hook: "h", dimension: "opening", arm: "motion-hook", arm_source: "inferred", video_key: "u1:instagram",
    thumbnail: null, media_url: null, status: "PUBLISHED", public_url: null,
    opening: "motion-hook", video_id: "v", skip_rate: skip,
  });
  const view = (skip: number | null): any => ({ ok: true, posts: [mkPost(skip)], count: 1,
    by_platform: { instagram: 1 }, by_status: { PUBLISHED: 1 },
    experiment: { target: 15, hook_scheduled: 1, hook_posted: 1, control_scheduled: 0, control_posted: 0,
      hook_with_data: skip === null ? 0 : 1, hook_median_skip: skip, control_median_skip: null, on_track: false },
    source: "t", as_of: "t" });
  const pending = page(emptyPageData({ scheduled: view(null) }));
  assert.match(pending, /skip rate: pending/);
  assert.doesNotMatch(pending, /skip 0\.0%/, "an unsynced post must never render as a perfect hook");
  const synced = page(emptyPageData({ scheduled: view(64.2) }));
  assert.match(synced, /skip 64\.2%/);
});

test("GUARDRAIL: the rewired SCHEDULED + EXPERIMENT panels add NO mutating control", () => {
  const view: any = { ok: true, count: 1, by_platform: { instagram: 1 }, by_status: { PUBLISHED: 1 },
    experiment: { target: 15, hook_scheduled: 1, hook_posted: 1, control_scheduled: 0, control_posted: 0,
      hook_with_data: 0, hook_median_skip: null, control_median_skip: null, on_track: false },
    source: "t", as_of: "t",
    posts: [{ post_id: "u1", platform: "instagram", scheduled_at: "2026-07-26T22:00:00Z", scheduled_cst: "x",
      hook: "h", dimension: "opening", arm: "motion-hook", arm_source: "inferred", video_key: "u1:instagram",
      thumbnail: null, media_url: null, status: "PUBLISHED",
      public_url: "https://www.instagram.com/reel/DbRalCfk3DY/", opening: "motion-hook", video_id: "v", skip_rate: 61.1 }] };
  const before = page(emptyPageData());
  const after = page(emptyPageData({ scheduled: view }));
  const count = (h: string, re: RegExp): number => (h.match(re) || []).length;
  // Measure what THESE panels ADD. Other panels on the page legitimately contain a
  // form; the invariant that matters is that rewiring the read path introduced no
  // new control of any kind.
  assert.equal(count(after, /<form/gi), count(before, /<form/gi), "no new form");
  assert.equal(count(after, /<button/gi), count(before, /<button/gi), "no new button");
  assert.equal(count(after, /<input/gi), count(before, /<input/gi), "no new input");
  assert.doesNotMatch(after, /method=["\x27]?post/i);
  // the only outbound link the panels add is the READ-ONLY public permalink
  assert.doesNotMatch(after, /app\.metricool\.com/, "no deep link into the writable planner");
  assert.match(after, /instagram\.com\/reel\//);
});


test("summarizeExperiment: excluded reels are not counted toward the target", async () => {
  const { summarizeExperiment } = await import("../data.ts");
  const mk = (opening: string, status: string, excluded: boolean) => ({
    post_id: Math.random().toString(36), platform: "instagram", scheduled_at: "2026-07-27T12:00:00Z",
    scheduled_cst: "x", hook: "h", dimension: "opening", arm: opening, arm_source: "inferred",
    video_key: "k" + Math.random(), thumbnail: null, media_url: null,
    status, public_url: null, opening, video_id: "", excluded, skip_rate: null,
  });
  const e = summarizeExperiment([
    mk("motion-hook", "PUBLISHED", true),   // old tilted opening — a different treatment
    mk("motion-hook", "PUBLISHED", true),
    mk("motion-hook", "PENDING", false),
    mk("motion-hook", "PENDING", false),
    mk("cold-plate", "PENDING", false),
  ] as any, 15);
  assert.equal(e.hook_scheduled, 2, "only usable hook reels count");
  assert.equal(e.hook_excluded, 2, "the superseded ones are reported, not hidden");
  assert.equal(e.hook_posted, 0, "an excluded reel is not a posted data point either");
  assert.equal(e.control_scheduled, 1);
});


// ── the approval gate: the dashboard's ONLY mutation ─────────────────────────
// These tests exist to keep the blast radius where it is. The dashboard is public over
// plain HTTP behind one shared word, so the security argument is not "nobody will guess
// it" — it is "guessing it gets you approve/reject on a queued draft and nothing else".
test("GUARDRAIL: only /api/approve and /api/reject may mutate", async () => {
  const A = await import("../approve.ts");
  assert.deepEqual([...A.MUTATING_ROUTES], ["/api/approve", "/api/reject"]);
});

test("approval: a GET is refused", async () => {
  const { handleApproval } = await import("../approve.ts");
  const out = await handleApproval("approve", { method: "GET" } as any, stubAct());
  assert.equal(out.status, 405);
});

// The password was removed at the user's explicit request. That removed AUTHENTICATION,
// not the blast-radius bound, and the bound is the part that actually protects the
// account. These tests pin it: with NO credential at all, the only thing reachable is
// approve/reject on something that is ALREADY an unapproved loop draft.
test("approval: NO credential is required — the bound is what the verb may touch, not who calls", async () => {
  const { handleApproval } = await import("../approve.ts");
  const act = stubAct();
  const out = await handleApproval("approve", bodyReq({ uuid: "123" }), act);
  assert.equal(out.status, 200, "an approve with no password must work");
  assert.deepEqual(act.calls, [["approve", "123"]]);
});

test("approval: with no auth, an ALREADY-APPROVED post is still refused", async () => {
  const { handleApproval } = await import("../approve.ts");
  // This is what hermes/src/approval.ts does on a non-draft: re-read, then refuse.
  const act = refusingAct("not an unapproved draft — nothing to approve");
  const out = await handleApproval("approve", bodyReq({ uuid: "8357829085189587553" }), act);
  assert.equal(out.status, 409, "a refusal must surface as a conflict, not a success");
  assert.equal(out.body.ok, false);
  assert.match(String(out.body.reason), /not an unapproved draft/);
});

test("approval: with no auth, a PUBLISHED post is still refused by both verbs", async () => {
  const { handleApproval } = await import("../approve.ts");
  for (const verb of ["approve", "reject"] as const) {
    const act = refusingAct("not an unapproved draft — refusing to touch a live post");
    const out = await handleApproval(verb, bodyReq({ uuid: "-6297496666514044627" }), act);
    assert.equal(out.status, 409, `${verb} must refuse a live post`);
    assert.equal(out.body.ok, false);
  }
});

test("approval: with no auth, a bogus uuid never reaches the account", async () => {
  const { handleApproval } = await import("../approve.ts");
  const act = stubAct();
  const out = await handleApproval("approve", bodyReq({ uuid: "999999999999999999" }), refusingAct("no such scheduled post"));
  assert.equal(out.status, 409);
  // and a uuid that is not even an integer is rejected before any call is made
  const bad = await handleApproval("approve", bodyReq({ uuid: "not-a-uuid" }), act);
  assert.equal(bad.status, 400);
  assert.equal(act.calls.length, 0);
});

test("approval: a caller cannot smuggle content alongside the uuid", async () => {
  const { handleApproval } = await import("../approve.ts");
  const act = stubAct();
  const out = await handleApproval("approve", bodyReq({
    uuid: "42", text: "buy my thing", publicationDate: { dateTime: "2026-01-01T00:00:00" },
    draft: false, autoPublish: true, media: ["https://evil.example/x.mp4"],
  }), act);
  assert.equal(out.status, 200);
  // the uuid is the ONLY thing that crosses the boundary — every other field is dropped
  assert.deepEqual(act.calls, [["approve", "42"]]);
});

test("approval: a non-numeric uuid is refused — nothing else fits the id slot", async () => {
  const { handleApproval } = await import("../approve.ts");
  const act = stubAct();
  for (const bad of ["", "abc", "1; DROP", "../../etc", "1 OR 1=1"]) {
    const out = await handleApproval("approve", bodyReq({ uuid: bad }), act);
    assert.equal(out.status, 400, `should refuse ${JSON.stringify(bad)}`);
  }
  assert.equal(act.calls.length, 0);
});

test("approval: a correct request approves exactly the one post named", async () => {
  const { handleApproval } = await import("../approve.ts");
  const act = stubAct();
  const out = await handleApproval("approve", bodyReq({ uuid: "-7965738052010884196" }), act);
  assert.equal(out.status, 200);
  assert.equal(out.body.ok, true);
  assert.deepEqual(act.calls, [["approve", "-7965738052010884196"]]);
});

test("approval: reject routes to reject, not to a delete of anything else", async () => {
  const { handleApproval } = await import("../approve.ts");
  const act = stubAct();
  await handleApproval("reject", bodyReq({ uuid: "42" }), act);
  assert.deepEqual(act.calls, [["reject", "42"]]);
});

test("approval: an oversized body is refused before it is parsed", async () => {
  const { handleApproval } = await import("../approve.ts");
  const out = await handleApproval("approve", bigReq(), stubAct());
  assert.equal(out.status, 413);
});

/** The gate as it behaves once restored, and as it ships. */
const GATE_IN_FORCE = { paused: false, restoreCmd: "HERMES_APPROVAL_PAUSED=false" };
const GATE_RETIRED = { paused: true, restoreCmd: "HERMES_APPROVAL_PAUSED=false" };
const twoWaiting = { ok: true, count: 2, by_status: {}, by_platform: {}, posts: [
  { post_id: "-1", video_id: "2026-07-30-v01", awaiting_approval: true, opening: "motion-hook", scheduled_cst: "Thu 08:12" },
  { post_id: "-2", video_id: "2026-07-30-v02", awaiting_approval: true, opening: "cold-plate", scheduled_cst: "Thu 09:40" },
] } as any;
const noneWaiting = { ok: true, count: 0, by_status: {}, by_platform: {}, posts: [] } as any;

test("page: with the gate RESTORED, the awaiting-approval count is impossible to miss", () => {
  const html = page(emptyPageData({ scheduled: twoWaiting, approvalGate: GATE_IN_FORCE }));
  assert.match(html, /2 videos awaiting your approval/i);
  assert.match(html, /APPROVAL QUEUE \u2014 2 AWAITING/);
  assert.match(html, /2026-07-30-v01/);
  // One Approve and one Reject per waiting row, not one pair for the panel.
  assert.equal(html.match(/data-act="approve"/g)?.length, 2);
  assert.equal(html.match(/data-act="reject"/g)?.length, 2);
});

test("page: with the gate RETIRED, drafts left over from before it read as leftovers, not as a queue", () => {
  const html = page(emptyPageData({ scheduled: twoWaiting, approvalGate: GATE_RETIRED }));
  // The promise that made the old banner urgent is no longer true of new posts.
  assert.doesNotMatch(html, /awaiting your approval/i);
  assert.doesNotMatch(html, /nothing publishes until you decide/i);
  // But these particular rows ARE real unapproved drafts, so they stay actionable —
  // degrading honestly is not the same as hiding work that still exists.
  assert.match(html, /2 leftover drafts/i);
  assert.match(html, /APPROVAL QUEUE \u2014 2 LEFTOVER DRAFTS/);
  assert.match(html, /2026-07-30-v01/);
  assert.match(html, /fetch\("\/api\/approve"/, "approve still works on a genuine leftover draft");
  assert.equal(html.match(/data-act="approve"/g)?.length, 2);
  assert.equal(html.match(/data-act="reject"/g)?.length, 2);
});

/**
 * NOTHING AWAITING APPROVAL MEANS NOTHING ON THE PAGE.
 *
 * The build before this asserted an "APPROVAL QUEUE — RETIRED" panel here: a tombstone
 * that took the top of the page to explain a step that does not happen, and to carry the
 * line that brings the gate back. Both are gone from the screen. The restore line now
 * lives only in /etc/hermes/hermes.env, next to the commented-out HERMES_APPROVAL_PAUSED.
 *
 * Class names are checked as MARKUP, not as bare strings: the stylesheet always ships
 * `.apr-card` / `.apr-banner` / `.apr-row` rules, so `/apr-card/` would match a page that
 * renders no panel at all and the assertion would prove nothing.
 */
function assertApprovalPanelSilent(html: string, label: string): void {
  assert.doesNotMatch(html, /APPROVAL QUEUE/, `${label}: no heading`);
  assert.doesNotMatch(html, /<section class="card apr-card">/, `${label}: no panel container`);
  assert.doesNotMatch(html, /<div class="apr-banner">/, `${label}: no banner above it`);
  assert.doesNotMatch(html, /<div class="apr-row"/, `${label}: no rows`);
  assert.doesNotMatch(html, /There is no approval step/i, `${label}: no explanatory paragraph`);
  assert.doesNotMatch(html, /Nothing awaiting approval/i, `${label}: no empty state`);
  assert.doesNotMatch(html, /awaiting your approval/i, `${label}: no count`);
  assert.doesNotMatch(html, /HERMES_APPROVAL_PAUSED/, `${label}: restore line is not on screen`);
  // A control that can never do anything is worse than no control.
  assert.doesNotMatch(html, /data-act="approve"/, `${label}: no dead Approve`);
  assert.doesNotMatch(html, /data-act="reject"/, `${label}: no dead Reject`);
  // The anchor stays (the banner links to it when a queue exists) but must stay empty.
  assert.match(html, /<span id="approval"><\/span>/, `${label}: anchor is empty, not an orphan container`);
}

test("page: with the gate RESTORED but nothing queued, the queue is silent, not an empty state", () => {
  const html = page(emptyPageData({ scheduled: noneWaiting, approvalGate: GATE_IN_FORCE }));
  assertApprovalPanelSilent(html, "gate in force");
});

test("page: with the gate RETIRED and nothing queued, nothing at all renders where the panel was", () => {
  const html = page(emptyPageData({ scheduled: noneWaiting, approvalGate: GATE_RETIRED }));
  assertApprovalPanelSilent(html, "gate retired");
});

test("page: the SHIPPED DEFAULT is the retired gate, so an unconfigured dashboard renders no queue", () => {
  const html = page(emptyPageData({ scheduled: noneWaiting }));
  assertApprovalPanelSilent(html, "shipped default");
});

test("page: a SINGLE draft brings the whole queue back, controls and all", () => {
  // The restore path that must not rot. The panel is CONDITIONAL, not deleted: one draft
  // appearing — because the gate came back, or for any other reason — is enough to make
  // the queue and its per-row Approve/Reject controls reappear, under either gate state.
  const oneWaiting = { ok: true, count: 1, by_status: {}, by_platform: {}, posts: [
    { post_id: "-7", video_id: "2026-07-30-v09", awaiting_approval: true, opening: "motion-hook", scheduled_cst: "Thu 11:05" },
  ] } as any;
  for (const [label, gate] of [["restored", GATE_IN_FORCE], ["retired", GATE_RETIRED]] as const) {
    const html = page(emptyPageData({ scheduled: oneWaiting, approvalGate: gate }));
    assert.match(html, /APPROVAL QUEUE/, `${label}: heading is back`);
    assert.match(html, /<section class="card apr-card">/, `${label}: panel is back`);
    assert.match(html, /2026-07-30-v09/, `${label}: the draft is listed`);
    assert.ok(html.includes('data-uuid="-7"'), `${label}: the row carries its uuid`);
    assert.equal(html.match(/data-act="approve"/g)?.length, 1, `${label}: exactly one Approve`);
    assert.equal(html.match(/data-act="reject"/g)?.length, 1, `${label}: exactly one Reject`);
    assert.match(html, /fetch\("\/api\/approve"/, `${label}: Approve is wired to the endpoint`);
    assert.match(html, /fetch\("\/api\/reject"/, `${label}: Reject is wired to the endpoint`);
    assert.doesNotMatch(html, /1 LEFTOVER DRAFTS/, `${label}: singular, not "1 drafts"`);
  }
});

/** A stub shaped like hermes/src/approval.ts when its `isUnapproved` re-read says no. */
function refusingAct(reason: string) {
  const calls: string[][] = [];
  return {
    calls,
    approve: async (u: string) => { calls.push(["approve", u]); return { ok: false, reason }; },
    reject: async (u: string) => { calls.push(["reject", u]); return { ok: false, reason }; },
  };
}
function stubAct() {
  const calls: string[][] = [];
  return {
    calls,
    approve: async (u: string) => { calls.push(["approve", u]); return { ok: true, reason: "approved" }; },
    reject: async (u: string) => { calls.push(["reject", u]); return { ok: true, reason: "rejected" }; },
  };
}
function bodyReq(obj: Record<string, unknown>) {
  const raw = Buffer.from(JSON.stringify(obj));
  return { method: "POST", async *[Symbol.asyncIterator]() { yield raw; } } as any;
}
function bigReq() {
  const raw = Buffer.alloc(4096, 0x61);
  return { method: "POST", async *[Symbol.asyncIterator]() { yield raw; } } as any;
}


// ── A/B ARM RESOLUTION: the join, driven through the REAL projection ─────────
//
// WHY THIS TEST IS SHAPED LIKE THIS. This exact bug shipped twice. The second time, 80
// tests were green while every freshly created post resolved to "unknown", because the
// suite exercised the resolver in isolation with hand-made inputs that happened to use
// the key the resolver was reading. So this drives `buildVariantMap` + the REAL
// `projectScheduledPosts` with rows shaped exactly like `bridge/metricool-read.ts`
// emits them (stable string `uuid`, a SEPARATE mutable numeric `id`, `media` as bare CDN
// url strings) against run-state shaped exactly like the loop writes it — and asserts
// the resolved dimension/arm equal the RUN-STATE values, not merely that something came back.

/** Run-state exactly as hermes writes it: uuids are TEXT and three of ten are NEGATIVE. */
const runFixture = {
  run_id: "2026-07-28",
  started_at: "", updated_at: "", status: "success",
  summary: { planned: 12, drafted: 10, rejected: 2, failed: 0 },
  videos: [
    { id: "2026-07-28-v01", index: 1, dimension: "mascot", arm: "mascot-absent", rationale: "", status: "drafted",
      caption: "bet you can't get this one right. v01", metricool: { media_id: "354994532", uuids: ["8357829085189587553"], permalinks: [] } },
    { id: "2026-07-28-v02", index: 2, dimension: "mascot", arm: "mascot-standard", rationale: "", status: "drafted",
      caption: "think you got this one? v02", metricool: { media_id: "354994600", uuids: ["-8392679256942752031"], permalinks: [] } },
    { id: "2026-07-28-v07", index: 7, dimension: "narration", arm: "no-options-vo", rationale: "", status: "drafted",
      caption: "bet you can't guess this one. v07", metricool: { media_id: "354994934", uuids: ["7157047660485296936"], permalinks: [] } },
    { id: "2026-07-28-v12", index: 12, dimension: "category-mix", arm: "quant-only", rationale: "", status: "drafted",
      caption: "think you're built different? v12", metricool: { media_id: "354995087", uuids: ["-6297496666514044627"], permalinks: [] } },
    // rejected before scheduling: no metricool block at all, so it must never match anything
    { id: "2026-07-28-v08", index: 8, dimension: "type-nonverbal-shapes", arm: "shapes", rationale: "", status: "rejected",
      caption: "which one's the imposter? v08" },
  ],
} as any;

/** Rows exactly as bridge/metricool-read.ts emits them. Note `id` is a NUMBER and is a
 *  different identity from `uuid` — conflating the two is the bug this test exists for. */
function bridgeRow(uuid: string, id: number, text: string, extra: Record<string, unknown> = {}) {
  return {
    uuid, id, text,
    dateTime: "2026-07-29T08:12:00", timezone: "America/Chicago",
    draft: true, auto_publish: false,
    media: ["https://static.metricool.com/planner/202607/6617222-file-1449.mp4"],
    thumbnail: "https://static.metricool.com/planner/202607/6617222-file-1825.png",
    providers: [{ network: "instagram", status: "PENDING", publicUrl: null }],
    ...extra,
  };
}

test("ARM JOIN: every freshly created draft resolves to its REAL run-state dimension + arm", () => {
  const idx = buildVariantMap([runFixture], []);
  const rows = [
    bridgeRow("8357829085189587553", 354994532, "bet you can't get this one right. v01"),
    bridgeRow("-8392679256942752031", 354994600, "think you got this one? v02"),
    bridgeRow("7157047660485296936", 354994934, "bet you can't guess this one. v07"),
    bridgeRow("-6297496666514044627", 354995087, "think you're built different? v12"),
  ];
  const posts = projectScheduledPosts(rows, { variantIdx: idx });
  assert.equal(posts.length, 4);

  // Assert against the RUN-STATE values, not "something non-empty came back".
  const want: Record<string, [string, string, string]> = {
    "8357829085189587553": ["mascot", "mascot-absent", "2026-07-28-v01"],
    "-8392679256942752031": ["mascot", "mascot-standard", "2026-07-28-v02"],
    "7157047660485296936": ["narration", "no-options-vo", "2026-07-28-v07"],
    "-6297496666514044627": ["category-mix", "quant-only", "2026-07-28-v12"],
  };
  for (const p of posts) {
    const w = want[p.post_id];
    assert.ok(w, `unexpected post_id ${p.post_id}`);
    assert.equal(p.dimension, w[0], `dimension for ${p.post_id}`);
    assert.equal(p.arm, w[1], `arm for ${p.post_id}`);
    assert.equal(p.video_id, w[2], `video_id for ${p.post_id}`);
    assert.equal(p.arm_source, "run", "must be sourced from run-state, never inferred");
  }
  assert.equal(posts.filter((p) => p.dimension === "unknown" || p.arm === "unknown").length, 0, "zero unknowns");
  // and the field that was silently never assigned once before is still assigned here
  assert.equal(posts.filter((p) => p.awaiting_approval).length, 4);
});

test("ARM JOIN: a NEGATIVE uuid resolves — it is text end-to-end and never a JS number", () => {
  const idx = buildVariantMap([runFixture], []);
  const [p] = projectScheduledPosts([bridgeRow("-8392679256942752031", 354994600, "x")], { variantIdx: idx });
  assert.equal(p.post_id, "-8392679256942752031");
  assert.equal(p.dimension, "mascot");
  assert.equal(p.arm, "mascot-standard");
});

test("ARM JOIN: the numeric `id` is NOT the uuid — matching it against a uuid must miss", () => {
  // The regression itself: probing the uuid-keyed index with Metricool's mutable numeric
  // id. A row whose uuid is unknown must resolve to unknown even though its numeric id
  // is a perfectly valid integer, i.e. the fix must not degrade into "try any number".
  const idx = buildVariantMap([runFixture], []);
  const orphan = bridgeRow("111222333444555666", 999999999, "a caption nothing in run-state has");
  const [p] = projectScheduledPosts([orphan], { variantIdx: idx });
  assert.equal(p.dimension, "unknown");
  assert.equal(p.arm, "unknown");
});

test("ARM JOIN: a uuid whose digits were lost to float parsing must NOT match", () => {
  // 8357829085189587553 as a double comes back 8357829085189587000. If anything upstream
  // ever parses the uuid as a number, this must surface as "unknown" rather than as a
  // near-miss silently joined to the wrong video.
  const idx = buildVariantMap([runFixture], []);
  const lossy = bridgeRow(String(8357829085189587553), 354994532, "z");
  assert.notEqual(String(8357829085189587553), "8357829085189587553", "precondition: the double really does lose digits");
  const hit = resolvePostVariant({ uuid: String(8357829085189587553) }, idx);
  assert.equal(hit, null, "a precision-damaged uuid is not a match");
  void lossy;
});

test("idKey: keeps 64-bit ids exact, refuses anything that already lost precision", () => {
  assert.equal(idKey("8357829085189587553"), "8357829085189587553");
  assert.equal(idKey("-8392679256942752031"), "-8392679256942752031");
  assert.equal(idKey(354994532), "354994532");
  assert.equal(idKey(8357829085189587553), "", "an unsafe integer has already lost digits");
  assert.equal(idKey(null), "");
  assert.equal(idKey("abc"), "");
  assert.equal(idKey(""), "");
});

test("ARM JOIN: an unresolvable post says unknown and NEVER infers the arm from the caption", () => {
  const idx = buildVariantMap([runFixture], []);
  // A caption that is *word for word* a real variant's caption still must not be used to
  // fabricate an arm when it is ambiguous, and a rejected video (no metricool block) must
  // never be reachable at all.
  const rows = [
    bridgeRow("555000111222333444", 1, "which one's the imposter? v08"), // the REJECTED video's caption
  ];
  const [p] = projectScheduledPosts(rows, { variantIdx: idx });
  // v08 has no uuid/media id, so only the caption could match it — and a caption match is
  // allowed ONLY because it is exact and collision-free. What must never happen is an
  // arm invented from the caption's opening words.
  assert.ok(p.arm === "shapes" || p.arm === "unknown", `arm was ${p.arm}`);
  assert.notEqual(p.arm, "which");
  assert.notEqual(p.dimension, "which one's the imposter? v08");
});

test("ARM JOIN: two videos sharing a caption with DIFFERENT arms resolve to unknown, not a coin flip", () => {
  const ambiguous = {
    ...runFixture,
    videos: [
      { id: "a", index: 1, dimension: "tempo", arm: "tempo-slow", rationale: "", status: "drafted", caption: "same words" },
      { id: "b", index: 2, dimension: "ending", arm: "no-answer", rationale: "", status: "drafted", caption: "same words" },
    ],
  } as any;
  const idx = buildVariantMap([ambiguous], []);
  const [p] = projectScheduledPosts([bridgeRow("777", 7, "same words")], { variantIdx: idx });
  assert.equal(p.arm, "unknown");
  assert.equal(p.dimension, "unknown");
});

// ── plain-language labels ────────────────────────────────────────────────────
test("LABELS: mascot arms read as departures from the mascot-prominent DEFAULT", () => {
  // mascot-prominent is today's default. Labelling mascot-standard as "standard" would
  // tell the user it IS the baseline, which is backwards and would mislead an approval.
  const absent = abTestLabel("mascot", "mascot-absent");
  const standard = abTestLabel("mascot", "mascot-standard");
  for (const L of [absent, standard]) {
    assert.equal(L.kind, "test");
    assert.equal(L.tag, "A/B");
    assert.match(L.text, /\(default: enlarged mascot\)/, "the default named must be the prominent arm");
  }
  assert.match(absent.text, /no mascot on screen at all/);
  assert.match(standard.text, /smaller mascot/);
  assert.doesNotMatch(standard.text, /^Mascot: standard mascot/, "must not read as the baseline");
  // and the default arm itself is still describable
  assert.match(abTestLabel("mascot", "mascot-prominent").text, /enlarged mascot/);
});

test("LABELS: every arm in today's batch has a plain-language string", () => {
  const batch: Array<[string, string, RegExp]> = [
    ["mascot", "mascot-absent", /no mascot on screen at all/],
    ["mascot", "mascot-standard", /smaller mascot/],
    ["narration", "no-options-vo", /only the question is read aloud/],
    ["narration", "no-question-vo", /only the options are read aloud/],
    ["narration", "no-narration", /no voiceover/],
    ["ending", "no-answer", /no answers revealed/],
    ["tempo", "tempo-slow", /slow 7s countdown/],
    ["category-mix", "quant-only", /number-series only/],
    ["hook", "hook-challenge", /ONLY 1% PASS/],
  ];
  for (const [dim, arm, re] of batch) {
    const L = abTestLabel(dim, arm);
    assert.equal(L.kind, "test", `${dim}/${arm} should be a test arm`);
    assert.match(L.text, re, `${dim}/${arm}`);
    assert.match(L.text, /\(default: /, `${dim}/${arm} must name what it departs from`);
  }
  assert.equal(abTestLabel("control", "control").kind, "control");
  assert.equal(abTestLabel("unknown", "unknown").kind, "unknown");
  assert.match(abTestLabel("unknown", "unknown").text, /not linked to a batch variant yet/);
});

// ── the approval queue is actually reviewable ────────────────────────────────
const queueFixture = {
  ok: true, source: "metricool (live, read-only bridge)", as_of: "2026-07-28T22:00:00Z",
  count: 2, by_platform: { instagram: 2 }, by_status: { PENDING: 2 }, awaiting_approval: 2,
  posts: [
    { post_id: "8357829085189587553", video_id: "2026-07-28-v01", awaiting_approval: true, platform: "instagram",
      scheduled_at: "2026-07-29T13:12:00Z", scheduled_cst: "Wed Jul 29, 8:12 AM CDT",
      hook: "bet you can't get this one right", dimension: "mascot", arm: "mascot-absent", arm_source: "run" as const,
      video_key: "k1", thumbnail: "https://static.metricool.com/planner/202607/cover1.png",
      media_url: "https://static.metricool.com/planner/202607/v1.mp4",
      status: "PENDING", public_url: null, opening: "", excluded: false, skip_rate: null },
    { post_id: "-6297496666514044627", video_id: "2026-07-28-v12", awaiting_approval: true, platform: "instagram",
      scheduled_at: "2026-07-29T15:40:00Z", scheduled_cst: "Wed Jul 29, 10:40 AM CDT",
      hook: "think you're built different?", dimension: "category-mix", arm: "quant-only", arm_source: "run" as const,
      video_key: "k2", thumbnail: "https://static.metricool.com/planner/202607/cover2.png",
      media_url: "https://static.metricool.com/planner/202607/v2.mp4",
      status: "PENDING", public_url: null, opening: "", excluded: false, skip_rate: null },
  ],
} as any;

test("QUEUE: the password field and all client-side password plumbing are GONE", () => {
  const html = page(emptyPageData({ scheduled: queueFixture }));
  assert.doesNotMatch(html, /type\s*=\s*["']password["']/i);
  assert.doesNotMatch(html, /apr-pass/);
  assert.doesNotMatch(html, /enter the password/i);
  assert.doesNotMatch(html, /"password"\s*:/);
  assert.doesNotMatch(html, /password:\s*pass/);
  // the two verbs still go exactly where they went before
  assert.match(html, /fetch\("\/api\/approve"/);
  assert.match(html, /fetch\("\/api\/reject"/);
});

test("QUEUE: every row is reviewable — poster, player source, plain-language test, hook, time", () => {
  const html = page(emptyPageData({ scheduled: queueFixture, approvalGate: GATE_IN_FORCE }));
  assert.match(html, /APPROVAL QUEUE \u2014 2 AWAITING/);
  for (const p of queueFixture.posts) {
    assert.ok(html.includes(`data-uuid="${p.post_id}"`), `row for ${p.post_id}`);
    assert.ok(html.includes(`data-src="${p.media_url}"`), `playable source for ${p.post_id}`);
    assert.ok(html.includes(`data-poster="${p.thumbnail}"`), `poster for ${p.post_id}`);
    assert.ok(html.includes(p.video_id), `video id for ${p.post_id}`);
    assert.ok(html.includes(esc(p.scheduled_cst)), `time for ${p.post_id}`);
    assert.ok(html.includes(esc(p.hook)), `hook for ${p.post_id}`);
  }
  // the plain-language label, identical in wording to the scheduled cards
  assert.match(html, /Mascot: no mascot on screen at all \(default: enlarged mascot\)/);
  assert.match(html, /Question mix: number-series only \(default: mixed 3\)/);
  // click-to-load, so ten videos do not all start buffering at once
  assert.match(html, /class="apr-play"/);
  assert.match(html, /new Plyr\(v,/);
  assert.doesNotMatch(html, /<video[^>]*autoplay/i);
});

test("QUEUE: an unresolved row says Unknown and shows no invented arm", () => {
  const unresolved = { ...queueFixture, posts: [{ ...queueFixture.posts[0], dimension: "unknown", arm: "unknown" }] };
  const html = page(emptyPageData({ scheduled: unresolved }));
  assert.match(html, /Unknown<\/span> not linked to a batch variant yet/);
  assert.doesNotMatch(html, /A\/B<\/span> bet you can't/, "the caption must never become the arm");
});

test("SECURITY: the approval queue never emits an S3 presigned url", () => {
  const leaky = { ...queueFixture, posts: [{ ...queueFixture.posts[0],
    thumbnail: "https://bkt.s3.amazonaws.com/t.jpg?X-Amz-Signature=z",
    media_url: "https://bkt.s3.amazonaws.com/v.mp4?X-Amz-Signature=z&X-Amz-Credential=ASIA" }] };
  const html = page(emptyPageData({ scheduled: leaky }));
  assert.doesNotMatch(html, /X-Amz-|amazonaws\.com/);
  assert.match(html, /data-src=""/, "an off-CDN url resolves to no player at all");
});

test("QUEUE: the yellow awaiting banner still renders (regression lock on ee8cd1e)", () => {
  const html = page(emptyPageData({ scheduled: queueFixture, approvalGate: GATE_IN_FORCE }));
  assert.match(html, /apr-banner/);
  assert.match(html, /2 videos awaiting your approval/i);
});

test("QUEUE: the banner survives the retired gate but stops claiming a decision is owed", () => {
  // ee8cd1e was a banner that silently vanished. It must still render for leftover
  // drafts — just without the line that is no longer true.
  const html = page(emptyPageData({ scheduled: queueFixture, approvalGate: GATE_RETIRED }));
  assert.match(html, /apr-banner/);
  assert.match(html, /2 leftover drafts/i);
  assert.doesNotMatch(html, /awaiting your approval/i);
});


test("QUEUE: the endpoint allowlist holds on a page that ACTUALLY renders the queue", () => {
  // The pre-existing allowlist test runs against a page with an EMPTY queue, so the
  // approval script it is meant to police was never in the html it scanned. This scans
  // the rendered queue itself.
  const html = page(emptyPageData({ scheduled: queueFixture }));
  assert.match(html, /class="apr-row"/, "precondition: the queue really is rendered here");
  const ALLOWED_FETCH = new Set(["/api/health", "/api/approve", "/api/reject"]);
  const seen: string[] = [];
  for (const m of html.matchAll(/fetch\(\s*["'`]([^"'`]+)["'`]/g)) {
    seen.push(m[1]);
    assert.ok(ALLOWED_FETCH.has(m[1]), `unexpected fetch target ${m[1]}`);
  }
  assert.ok(seen.includes("/api/approve") && seen.includes("/api/reject"));
  assert.doesNotMatch(html, /method:\s*["'](PUT|PATCH|DELETE)["']/i);
  assert.doesNotMatch(html, /method\s*=\s*["']post["']/i);
  // the player is the vendored one; no third-party CDN may creep in
  assert.doesNotMatch(html, /src="https?:\/\/(?!static\.metricool\.com)[^"]*\.js"/);
  assert.match(html, /src="\/static\/plyr\.min\.js"/);
});

test("QUEUE: layout guards that keep ten rows from scrolling sideways at 500px", () => {
  // The dashboard has regressed into horizontal scroll before. These are the four CSS
  // properties that prevent it; losing any one of them is what causes it.
  const html = page(emptyPageData({ scheduled: queueFixture }));
  assert.match(html, /html,body\{max-width:100%;overflow-x:hidden\}/);
  assert.match(html, /\.apr-row\{[^}]*flex-wrap:wrap/, "rows must wrap rather than overflow");
  assert.match(html, /\.apr-info\{[^}]*min-width:0/, "a flex child needs min-width:0 or long text pushes the row wide");
  assert.match(html, /\.apr-hook\{[^}]*overflow-wrap:anywhere/, "captions must be able to break");
  // the poster/player column is width-bounded in both states, and tighter on small screens
  assert.match(html, /\.apr-media\{[^}]*width:92px/);
  assert.match(html, /\.apr-media\.is-open\{width:190px\}/);
  assert.match(html, /@media\(max-width:560px\)\{\.apr-media\{width:74px\}\.apr-media\.is-open\{width:150px\}\}/);
  // 9:16, contained — the preview must never crop a 1080x1920 render
  assert.match(html, /\.apr-media\{[^}]*aspect-ratio:9\/16/);
  assert.match(html, /\.apr-poster\{[^}]*object-fit:contain/);
  assert.match(html, /\.apr-media \.plyr video\{[^}]*object-fit:contain/);
});


test("LABELS: the opening experiment reads as English, and cold-plate is the CONTROL", () => {
  const hook = abTestLabel("opening", "motion-hook");
  assert.equal(hook.kind, "test");
  assert.match(hook.text, /2\.2s wordless motion hook/);
  assert.match(hook.text, /\(default: static question plate\)/);
  const plate = abTestLabel("opening", "cold-plate");
  assert.equal(plate.kind, "control", "cold-plate is the baseline, not another arm");
  assert.equal(plate.tag, "Control");
  assert.match(plate.text, /current defaults/);
  // and the raw arm slug must not survive to the page
  assert.doesNotMatch(hook.text, /^opening: motion-hook$/);
});

// ── LLM DEGRADATION IS VISIBLE ───────────────────────────────────────────────
//
// The 2026-08-03 outage was invisible for a day because a degraded gate and a passing
// gate render identically. These pin the panel that separates them. If the KPI ever
// stops distinguishing the two, the dashboard is quietly lying again.

function runWithDegraded(degraded: unknown) {
  return {
    run_id: "2026-08-05",
    started_at: "2026-08-05T14:00:00Z",
    updated_at: "2026-08-05T15:00:00Z",
    status: "partial",
    summary: { planned: 12, drafted: 11, rejected: 1, failed: 0, ...(degraded ? { degraded } : {}) },
    videos: [],
  } as any;
}

test("degradation KPI: a healthy cycle reads 0 and raises no banner", () => {
  const run = runWithDegraded({ llm_failed_calls: 0, caption_fallbacks: 0, copy_gate_unjudged: 0, questions_unjudged: 0 });
  const html = page(emptyPageData({ latest: run, runs: [run] }));
  assert.match(html, /unjudged · LLM degraded \(this cycle\)/);
  assert.doesNotMatch(html, /<b>LLM degraded\.<\/b>/, "a healthy cycle must not cry wolf");
});

test("degradation KPI: unjudged videos are counted, coloured and explained", () => {
  const run = runWithDegraded({ llm_failed_calls: 9, caption_fallbacks: 2, copy_gate_unjudged: 3, questions_unjudged: 1 });
  const html = page(emptyPageData({ latest: run, runs: [run] }));
  // 2 + 3 + 1 unjudged pieces of work, shown as the headline number
  assert.match(html, /<div class="v" style="color:var\(--coral\)">6<\/div>\s*<div class="k">unjudged · LLM degraded/);
  // the breakdown, so the number is actionable rather than just alarming
  assert.match(html, /9 failed gateway call\(s\)/);
  assert.match(html, /2 template caption\(s\)/);
  assert.match(html, /3 unjudged copy gate\(s\)/);
  assert.match(html, /1 unjudged validity gate\(s\)/);
  assert.match(html, /<b>LLM degraded\.<\/b>/, "the banner is the part that gets noticed");
});

test("degradation KPI: failed gateway calls alone still raise the alarm", () => {
  // Every video recovered on the fallback, so nothing shipped unjudged — but the
  // primary was failing and that is worth seeing BEFORE the day it is not recovered.
  const run = runWithDegraded({ llm_failed_calls: 12, caption_fallbacks: 0, copy_gate_unjudged: 0, questions_unjudged: 0 });
  const html = page(emptyPageData({ latest: run, runs: [run] }));
  assert.match(html, /<b>LLM degraded\.<\/b>/);
  assert.match(html, /12 failed gateway call\(s\)/);
});

test("degradation KPI: a run from before the counter says so instead of claiming zero", () => {
  const run = runWithDegraded(null);
  const html = page(emptyPageData({ latest: run, runs: [run] }));
  assert.match(html, /This run predates the degradation counter/);
  assert.doesNotMatch(html, /<b>LLM degraded\.<\/b>/, "unknown is not the same as clean, but it is not an alarm either");
});
