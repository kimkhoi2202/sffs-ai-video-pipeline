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
  publicPublerCdnUrl, sanitizeDraftsForPublic, resolveDraftMediaUrl,
  resolveScheduledMediaUrl, sanitizeScheduledForPublic,
  resolveReplicationView, REPLICATION_HARD_CAP,
} from "../data.ts";
import { computeGoalProgress, GOAL } from "../goal.ts";
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
  assert.match(html, /Front-runners/);
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

// ── Drafts awaiting review (READ-ONLY) ───────────────────────────────────────
const draftsFixture = {
  ok: true,
  as_of: "2026-07-22T21:00:00Z",
  source: "publer (live, read-only bridge)",
  count_videos: 2,
  count_drafts: 3,
  videos: [
    {
      video_key: "m1",
      hook: "bet you got this one wrong lol",
      caption: "bet you got this one wrong lol #quiz",
      thumbnail: "https://cdn.publer.com/uploads/photos/x.jpg",
      media_url: "https://cdn.publer.com/uploads/videos/m1/259e8a.mp4",
      dimension: "cliffhanger",
      arm: "last-hidden",
      variant_source: "run" as const,
      question_types: ["VERBAL ANALOGY", "NUMBER SERIES"],
      run_id: "2026-07-22",
      drafts: [
        { platform: "instagram", publer_id: "IG1" },
        { platform: "tiktok", publer_id: "TT1" },
      ],
    },
    {
      video_key: "m2",
      hook: "which one are you picking?",
      caption: "which one are you picking? #quiz",
      thumbnail: null,
      media_url: null,
      dimension: "hook",
      arm: "which-one-are-you",
      variant_source: "inferred" as const,
      question_types: [],
      drafts: [{ platform: "tiktok", publer_id: "TT2" }],
    },
  ],
};

test("page: renders the Older drafts (pre-autonomy) panel + empty state", () => {
  const html = page(emptyPageData());
  assert.match(html, /Older drafts \(pre-autonomy\)/);
  assert.match(html, /None loaded yet|No leftover drafts/);
});

test("page: drafts panel shows variant, question types, inline video preview + platform labels", () => {
  const html = page(emptyPageData({ drafts: draftsFixture as any }));
  assert.match(html, /Older drafts \(pre-autonomy\)/);
  assert.match(html, /cliffhanger/);
  assert.match(html, /last-hidden/);
  assert.match(html, /VERBAL ANALOGY/);
  // inline <video> preview streamed via the SAME-ORIGIN read-only proxy
  assert.match(html, /<video[^>]*\bcontrols\b/);
  assert.match(html, /preload="metadata"/);
  assert.match(html, /playsinline/);
  assert.match(html, /src="\/api\/draft-media\?v=m1&amp;kind=video"/);
  assert.match(html, /poster="\/api\/draft-media\?v=m1&amp;kind=thumb"/);
  // platform labels present as plain text (dead Publer deep-links removed)
  assert.match(html, /Instagram/);
  assert.match(html, /TikTok/);
  // Item 3: the internal "inferred" provenance flag is NO LONGER surfaced as a
  // user-facing badge; a subtle positive "from <source>" chip shows ONLY when a
  // real record matched (video m1 = variant_source "run").
  assert.doesNotMatch(html, /\binferred\b/i);
  assert.match(html, /from run/);
  // Item 1: every draft card shows a prominent neutral "Not scheduled" chip.
  assert.match(html, /Not scheduled/);
  // the second video has no playable media_url ⇒ graceful "no preview"
  assert.match(html, /no preview/);
});

test("GUARDRAIL: drafts panel adds NO publish/schedule control (inline preview, no POST, no dead links)", () => {
  const html = page(emptyPageData({ drafts: draftsFixture as any }));
  assert.doesNotMatch(html, /method\s*=\s*["']post["']/i);
  assert.doesNotMatch(html, /<button[^>]*>\s*(publish|schedule|merge|post|go live|approve|reject)/i);
  assert.doesNotMatch(html, /<input[^>]*type\s*=\s*["']submit["']/i);
  // the review surface is a read-only <video>; the dead Publer deep-links are gone
  assert.match(html, /<video[^>]*\bcontrols\b/);
  assert.doesNotMatch(html, /app\.publer\.com/);
  assert.doesNotMatch(html, /class="draftlink"/);
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

// ── Inline draft video preview: PUBLIC-CDN-only + same-origin proxy (SECURITY) ─
test("publicPublerCdnUrl: accepts clean cdn.publer.com asset; rejects S3-signed / off-host / query / non-https", () => {
  const mp4 = "https://cdn.publer.com/uploads/videos/abc/def.mp4";
  const jpg = "https://cdn.publer.com/uploads/photos/x.jpg";
  assert.equal(publicPublerCdnUrl(mp4), mp4);
  assert.equal(publicPublerCdnUrl(jpg), jpg);
  // the FORBIDDEN one: an S3 presigned url (amazonaws host + X-Amz-* query/tokens)
  assert.equal(publicPublerCdnUrl("https://bkt.s3.amazonaws.com/o.mp4?X-Amz-Signature=a&X-Amz-Credential=ASIA"), null);
  assert.equal(publicPublerCdnUrl("https://cdn.publer.com/x.mp4?X-Amz-Signature=a"), null); // cdn host but query ⇒ reject
  assert.equal(publicPublerCdnUrl("http://cdn.publer.com/x.mp4"), null); // not https
  assert.equal(publicPublerCdnUrl("https://evil.com/x.mp4"), null); // wrong host
  assert.equal(publicPublerCdnUrl("https://cdn.publer.com.evil.com/x.mp4"), null); // suffix host spoof
  assert.equal(publicPublerCdnUrl("https://user:pass@cdn.publer.com/x.mp4"), null); // userinfo
  assert.equal(publicPublerCdnUrl(null), null);
  assert.equal(publicPublerCdnUrl(""), null);
  assert.equal(publicPublerCdnUrl(123 as any), null);
});

test("SECURITY: sanitizeDraftsForPublic forces media_url/thumbnail to PUBLIC-CDN-only (nulls S3-signed)", () => {
  const view = {
    ok: true, source: "t", as_of: "t", count_videos: 2, count_drafts: 0,
    videos: [
      { video_key: "a", hook: "", caption: "", thumbnail: "https://cdn.publer.com/uploads/photos/a.jpg",
        media_url: "https://cdn.publer.com/uploads/videos/a/a.mp4", dimension: "d", arm: "a",
        variant_source: "run", question_types: [], drafts: [] },
      { video_key: "b", hook: "", caption: "",
        thumbnail: "https://bkt.s3.amazonaws.com/t.jpg?X-Amz-Signature=z",
        media_url: "https://bkt.s3.amazonaws.com/v.mp4?X-Amz-Signature=z&X-Amz-Credential=ASIA",
        dimension: "d", arm: "b", variant_source: "inferred", question_types: [], drafts: [] },
    ],
  } as any;
  const out = sanitizeDraftsForPublic(view);
  assert.equal(out.videos[0].media_url, "https://cdn.publer.com/uploads/videos/a/a.mp4"); // clean kept
  assert.equal(out.videos[0].thumbnail, "https://cdn.publer.com/uploads/photos/a.jpg");
  assert.equal(out.videos[1].media_url, null); // S3-signed nulled
  assert.equal(out.videos[1].thumbnail, null);
  assert.doesNotMatch(JSON.stringify(out), /X-Amz-Signature|X-Amz-Credential|amazonaws\.com/);
});

test("resolveDraftMediaUrl: resolves by video_key+kind to a validated cdn url, else null", () => {
  const view = {
    ok: true, source: "t", as_of: "t", count_videos: 2, count_drafts: 0,
    videos: [
      { video_key: "m1", hook: "", caption: "", thumbnail: "https://cdn.publer.com/uploads/photos/p.jpg",
        media_url: "https://cdn.publer.com/uploads/videos/m1/v.mp4", dimension: "d", arm: "a",
        variant_source: "run", question_types: [], drafts: [] },
      { video_key: "bad", hook: "", caption: "", thumbnail: null,
        media_url: "https://bkt.s3.amazonaws.com/v.mp4?X-Amz-Signature=z", dimension: "d", arm: "a",
        variant_source: "run", question_types: [], drafts: [] },
    ],
  } as any;
  assert.equal(resolveDraftMediaUrl(view, "m1", "video"), "https://cdn.publer.com/uploads/videos/m1/v.mp4");
  assert.equal(resolveDraftMediaUrl(view, "m1", "thumb"), "https://cdn.publer.com/uploads/photos/p.jpg");
  assert.equal(resolveDraftMediaUrl(view, "nope", "video"), null); // unknown key
  assert.equal(resolveDraftMediaUrl(view, "bad", "video"), null); // S3-signed ⇒ rejected by allowlist
  assert.equal(resolveDraftMediaUrl(null, "m1", "video"), null);
});

test("SECURITY: rendered drafts page proxies media (no raw CDN url, no S3-signed url in HTML)", () => {
  const html = page(emptyPageData({ drafts: draftsFixture as any }));
  // preview src goes through the same-origin proxy …
  assert.match(html, /src="\/api\/draft-media\?v=m1&amp;kind=video"/);
  // … so the raw cdn.publer.com url and any S3 signing material never appear in the HTML
  assert.doesNotMatch(html, /cdn\.publer\.com/);
  assert.doesNotMatch(html, /amazonaws|X-Amz-/);
});

test("GUARDRAIL: cycle-status batch shows Publer post ids as plain text (no dead app.publer.com deep-link)", () => {
  const run = {
    run_id: "2026-07-22", started_at: "s", updated_at: "u", status: "success",
    summary: { planned: 1, drafted: 1, rejected: 0, failed: 0 },
    videos: [{
      id: "v1", index: 0, dimension: "cliffhanger", arm: "last-hidden", rationale: "r",
      status: "drafted", caption: "c", hashtag_set: "A",
      publer: { post_ids: ["PUB123", "PUB456"] },
    }],
  } as any;
  const html = page(emptyPageData({ latest: run, runs: [run] }));
  assert.match(html, /PUB123/); // ids still shown for reference …
  assert.match(html, /PUB456/);
  assert.doesNotMatch(html, /app\.publer\.com/); // … but NOT as a dead deep-link
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

// ── GOAL-PROGRESS (Hermes's 7-day mandate) — pure math ───────────────────────
const goalPosts = [
  { platform: "instagram", posted_at: "2026-07-20T10:00:00Z", metrics: { video_views: 100, reactions: 10 }, variant: { arm: "hook-a", family: "hook" } },
  { platform: "tiktok", posted_at: "2026-07-20T11:00:00Z", metrics: { video_views: 200, reactions: 20 }, variant: { arm: "hook-b", family: "hook" } },
  { platform: "instagram", posted_at: "2026-07-21T10:00:00Z", metrics: { video_views: 400, reactions: 5 }, variant: { arm: "hook-a", family: "hook" } },
];

test("computeGoalProgress: BEFORE kickoff ⇒ pending, full 7d clock, running totals, followers pending", () => {
  const gp = computeGoalProgress(goalPosts, null, null, new Date("2026-07-22T00:00:00Z"));
  // pending: not armed, no t0, clock reads the full 7 days, not started
  assert.equal(gp.armed, false);
  assert.equal(gp.since, null);
  assert.equal(gp.daysLeft, 7);
  assert.equal(gp.hoursLeft, 0);
  assert.equal(gp.windowClosed, false);
  // running totals over ALL posts (t0 null)
  assert.equal(gp.instagram.views.value, 500); // 100 + 400
  assert.equal(gp.tiktok.views.value, 200);
  assert.equal(gp.combined.views.value, 700);
  assert.equal(gp.combined.posts, 3);
  // mandate targets (combined full; per-platform half; followers 500 each / 1k combined). Likes dropped.
  assert.equal(gp.combined.views.target, 500_000);
  assert.equal(gp.instagram.views.target, 250_000);
  assert.equal(gp.instagram.followers.target, 500);
  assert.equal(gp.combined.followers.target, 1_000);
  // likes removed from the goal shape entirely
  assert.equal((gp.combined as Record<string, unknown>).likes, undefined);
  // followers absent ⇒ pending (null), NOT 0/fake
  assert.equal(gp.followersPending, true);
  assert.equal(gp.instagram.followers.value, null);
  assert.equal(gp.combined.followers.value, null);
  // no observed pace before kickoff, but the honest "needed/day" mountain is finite over 7d
  assert.equal(gp.instagram.paceViewsPerDay, null);
  assert.equal(gp.combined.neededViewsPerDay, (GOAL.views - 700) / 7);
  assert.ok(gp.combined.neededViewsPerDay > 70_000); // cold account ⇒ big daily pace toward 500k
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
  assert.equal(gp.daysLeft, 5); // 7 - 2
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
  // needed pace over the remaining 5 days
  assert.equal(gp.combined.neededViewsPerDay, (GOAL.views - 600) / 5);
  // followers now come from the snapshot (not pending)
  assert.equal(gp.followersPending, false);
  assert.equal(gp.instagram.followers.value, 120);
  assert.equal(gp.tiktok.followers.value, 340);
  assert.equal(gp.combined.followers.value, 460);
});

test("computeGoalProgress: window closed unmet ⇒ needed=null (∞); target met ⇒ needed=0", () => {
  const t0 = "2026-07-20T00:00:00Z";
  const closed = computeGoalProgress(goalPosts, t0, null, new Date("2026-07-28T00:00:00Z")); // 8d > 7d
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

// ── GOAL-PROGRESS panel renders FRONT-AND-CENTER ─────────────────────────────
test("page: GOAL panel renders FRONT-AND-CENTER with the exact mandate targets + pure-CSS bars", () => {
  const html = page(emptyPageData());
  assert.match(html, /Hermes mandate — live 7-day trajectory/);
  assert.match(html, /KICKOFF PENDING/); // no goal data ⇒ pending panel
  // the exact mandate numbers are on the page (500k views + 500 followers each; NO likes)
  assert.match(html, /500,000<\/b> views combined/);
  assert.match(html, /500<\/b> followers on EACH/);
  assert.doesNotMatch(html, /likes combined/i); // likes removed from the mandate line
  assert.doesNotMatch(html, /200,000/); // old likes target gone
  // FRONT-AND-CENTER: the GOAL card comes before DRAFTS and Cycle status
  const goalIdx = html.indexOf("Hermes mandate");
  const draftsIdx = html.indexOf("Older drafts (pre-autonomy)");
  const cycleIdx = html.indexOf("Cycle status");
  assert.ok(goalIdx > -1 && draftsIdx > goalIdx, "GOAL panel must render before DRAFTS");
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
  ok: true, source: "publer (live, read-only bridge)", as_of: "2026-07-23T22:00:00Z",
  count: 1, by_platform: { tiktok: 1 },
  posts: [{
    post_id: "s1", platform: "tiktok",
    scheduled_at: "2026-07-24T02:17:00Z", scheduled_cst: "Wed Jul 23, 9:17 PM CDT",
    hook: "smart or fart?", arm: "control", arm_source: "run" as const,
    video_key: "sm1",
    thumbnail: "https://cdn.publer.com/uploads/photos/s.jpg",
    media_url: "https://cdn.publer.com/uploads/videos/sm1/v.mp4",
  }],
};

test("D3: video previews are FULL-FRAME (object-fit:contain, never cover) in both panels", () => {
  const html = page(emptyPageData({ drafts: draftsFixture as any }));
  assert.match(html, /\.dvid\{[^}]*object-fit:contain/);
  assert.match(html, /\.dthumb-img\{[^}]*object-fit:contain/);
  assert.doesNotMatch(html, /object-fit:cover/); // no crop anywhere
});

test("D3: Plyr is vendored locally (no external CDN at runtime) and initialised on previews", () => {
  const html = page(emptyPageData({ drafts: draftsFixture as any }));
  assert.match(html, /<link rel="stylesheet" href="\/static\/plyr\.css"\/>/);
  assert.match(html, /<script src="\/static\/plyr\.min\.js"><\/script>/);
  assert.match(html, /new Plyr\(/);
  assert.match(html, /iconUrl: '\/static\/plyr\.svg'/);
  assert.doesNotMatch(html, /cdn\.plyr\.io|cdn\.jsdelivr\.net|unpkg\.com/); // never a runtime CDN
});

test("D3: SCHEDULED panel shows full-frame previews via the same-origin proxy (both panels fixed)", () => {
  const html = page(emptyPageData({ scheduled: schedFixture as any }));
  assert.match(html, /9:17 PM CDT/); // the scheduled time is still prominent
  assert.match(html, /<video[^>]*\bcontrols\b/);
  assert.match(html, /src="\/api\/draft-media\?v=sm1&amp;kind=video"/);
  assert.match(html, /poster="\/api\/draft-media\?v=sm1&amp;kind=thumb"/);
  assert.doesNotMatch(html, /cdn\.publer\.com/);   // proxied — no raw CDN url in HTML
  assert.doesNotMatch(html, /amazonaws|X-Amz-/);   // no S3-signed leak
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
  assert.match(mas.text, /default: bigger mascot/);
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
        video_key: "k1", thumbnail: null, media_url: null },
      { post_id: "s2", platform: "tiktok", scheduled_at: "2026-07-24T03:17:00Z", scheduled_cst: "t2",
        hook: "bet you cant solve this", dimension: "unknown", arm: "unknown", arm_source: "inferred",
        video_key: "k2", thumbnail: null, media_url: null },
    ],
  };
  const html = page(emptyPageData({ scheduled: sched as any }));
  assert.match(html, /no voiceover/);                          // plain-language change (not jargon)
  assert.match(html, /default: full voiceover/);               // vs the current default
  assert.match(html, /not linked to a batch variant/);         // neutral fallback for an unmatched post
  assert.doesNotMatch(html, /think-you-got-this|bet-you-cant/); // NEVER the caption-opener slug
});

test("Item 1: per-card schedule chip shows TIME-ONLY (no redundant 'Scheduled' label); drafts show 'Not scheduled'", () => {
  const sHtml = page(emptyPageData({ scheduled: schedFixture as any }));
  assert.match(sHtml, /class="timechip"/);           // prominent mint pill present
  assert.match(sHtml, /Wed Jul 23, 9:17 PM CDT/);    // uses scheduled_cst (the date/time itself)
  assert.doesNotMatch(sHtml, /class="tc-k"/);        // redundant "Scheduled ·" label REMOVED
  const dHtml = page(emptyPageData({ drafts: draftsFixture as any }));
  assert.match(dHtml, /timechip-none/);              // neutral state (never blank)
  assert.match(dHtml, /Not scheduled/);
  assert.doesNotMatch(dHtml, /class="tc-k"/);        // no redundant label on the draft variant either
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
  const view = { ...schedFixture, posts: [
    schedFixture.posts[0],
    { ...schedFixture.posts[0], video_key: "bad", thumbnail: null, media_url: "https://bkt.s3.amazonaws.com/v.mp4?X-Amz-Signature=z" },
  ]} as any;
  assert.equal(resolveScheduledMediaUrl(view, "sm1", "video"), "https://cdn.publer.com/uploads/videos/sm1/v.mp4");
  assert.equal(resolveScheduledMediaUrl(view, "sm1", "thumb"), "https://cdn.publer.com/uploads/photos/s.jpg");
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
