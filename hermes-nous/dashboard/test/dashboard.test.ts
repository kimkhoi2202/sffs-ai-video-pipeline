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
import { evaluateKillSwitch } from "../data.ts";
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
