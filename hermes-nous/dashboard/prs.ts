/**
 * prs.ts — the CODE-PR VIEW data layer for the software factory.
 *
 * Surfaces, READ-ONLY, the PRs the deployed agent ("software factory") proposed
 * and merged, each joined to:
 *   - the real CI/E2E test status (GitHub check rollup), and
 *   - the two-key auto-merge gate's own record for that branch: the review-agent
 *     verdict (KEY 2) + the harness verdict (KEY 1) + the final MERGE/REFUSE
 *     decision, read from the gate's JSONL ledger (scripts/gate/logs/auto_merge.log).
 *
 * STRICT READ-ONLY: PRs are read via `gh` using ONLY the read subcommands
 * (`pr list` / `pr view`). There is NO code path here that creates, merges,
 * closes, comments on, or otherwise mutates a PR — `runGh()` hard-refuses any
 * non-allowlisted subcommand as defense-in-depth.
 *
 * The parse/correlate helpers are PURE (no IO) so they are unit-tested without a
 * network or a real `gh`.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { CONFIG } from "./config.ts";
import type { GateAttempt, PRRow, PRCiCheck } from "./types.ts";

// Only these `gh` subcommands are ever allowed to run. Anything else (merge,
// create, close, comment, edit, review, ready, api POST, …) is refused.
const ALLOWED_GH = new Set(["pr list", "pr view"]);

// ── pure: gate ledger (JSONL) ─────────────────────────────────────────────────

/**
 * Parse the auto-merge gate ledger (JSONL). Best-effort: non-JSON lines are
 * skipped. Returns one normalized GateAttempt per line, oldest→newest as written.
 */
export function parseGateLedger(text: string): GateAttempt[] {
  const out: GateAttempt[] = [];
  for (const line of String(text || "").split("\n")) {
    const s = line.trim();
    if (!s) continue;
    let obj: any;
    try {
      obj = JSON.parse(s);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== "object") continue;
    const keys = obj.keys || {};
    const decision = obj.decision || {};
    out.push({
      ts: obj.ts,
      source: obj.source,
      target: obj.target,
      mode: obj.mode,
      merged: obj.merged === true,
      merge_commit: obj.merge_commit,
      mergeable: obj.mergeable,
      changed_files: Array.isArray(obj.changed_files) ? obj.changed_files : undefined,
      harness: (keys.harness && keys.harness.verdict) || "?",
      review: (keys.review && keys.review.verdict) || "?",
      reviewSource: keys.review && keys.review.source,
      decision: decision.verdict || (obj.merged ? "MERGE" : "?"),
      reasons: Array.isArray(decision.reasons) ? decision.reasons : undefined,
    });
  }
  return out;
}

/** Keep only the LATEST attempt per source branch (by array order = write order). */
export function latestBySource(attempts: GateAttempt[]): Map<string, GateAttempt> {
  const m = new Map<string, GateAttempt>();
  for (const a of attempts) {
    const key = (a.source || "").replace(/^refs\/heads\//, "");
    if (key) m.set(key, a); // later writes overwrite earlier ⇒ newest wins
  }
  return m;
}

// ── pure: GitHub check rollup → normalized CI status ──────────────────────────

/** Map a single statusCheckRollup entry to PASS/FAIL/PENDING (or null to ignore). */
export function normalizeCheck(entry: any): PRCiCheck | null {
  if (!entry || typeof entry !== "object") return null;
  const name = entry.name || entry.context || entry.workflowName || "check";
  // CheckRun: status(QUEUED/IN_PROGRESS/COMPLETED) + conclusion(SUCCESS/FAILURE/…)
  // StatusContext: state(SUCCESS/FAILURE/PENDING/ERROR)
  const conclusion = String(entry.conclusion || entry.state || "").toUpperCase();
  const status = String(entry.status || "").toUpperCase();
  let result: PRCiCheck["result"];
  if (status && status !== "COMPLETED") {
    result = "PENDING";
  } else if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes(conclusion)) {
    result = "PASS";
  } else if (["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(conclusion)) {
    result = "FAIL";
  } else if (["PENDING", "EXPECTED", "QUEUED", "IN_PROGRESS", "WAITING", "REQUESTED", ""].includes(conclusion)) {
    result = "PENDING";
  } else {
    result = "PENDING";
  }
  return { name: String(name), result };
}

/** Roll a list of statusCheckRollup entries up to one overall CI status. */
export function rollupCi(rollup: any): PRRow["ci"] {
  const arr = Array.isArray(rollup) ? rollup : [];
  const checks: PRCiCheck[] = arr.map(normalizeCheck).filter((c): c is PRCiCheck => !!c);
  if (!checks.length) return { status: "NONE", checks };
  if (checks.some((c) => c.result === "FAIL")) return { status: "FAIL", checks };
  if (checks.some((c) => c.result === "PENDING")) return { status: "PENDING", checks };
  return { status: "PASS", checks };
}

// ── pure: build a unified PR row from a `gh` PR object + the gate ledger ──────

export function toPRRow(pr: any, ledgerBySource: Map<string, GateAttempt>): PRRow {
  const head = pr.headRefName || "";
  const gate = ledgerBySource.get(head);
  return {
    number: pr.number,
    title: pr.title || "",
    url: pr.url || "",
    state: pr.state || "OPEN",
    isDraft: pr.isDraft === true,
    headRefName: head,
    baseRefName: pr.baseRefName || "",
    author: pr.author?.login || pr.author?.name,
    createdAt: pr.createdAt,
    updatedAt: pr.updatedAt,
    mergedAt: pr.mergedAt ?? null,
    additions: pr.additions,
    deletions: pr.deletions,
    changedFiles: pr.changedFiles,
    ci: rollupCi(pr.statusCheckRollup),
    reviewDecision: pr.reviewDecision ?? null,
    gate: gate ? { ...gate, matched: true } : { matched: false },
  };
}

/** Correlate raw `gh` PRs with the gate ledger, returning unified rows +
 *  the ledger attempts that had no matching open/merged PR (nothing hidden). */
export function correlate(
  prs: any[],
  ledger: GateAttempt[],
): { rows: PRRow[]; ledgerOnly: GateAttempt[] } {
  const bySource = latestBySource(ledger);
  const rows = (Array.isArray(prs) ? prs : []).map((p) => toPRRow(p, bySource));
  const seen = new Set(rows.map((r) => r.headRefName));
  // gate attempts whose branch has no corresponding PR row (e.g. direct-ref merges)
  const ledgerOnly = [...bySource.values()].filter((a) => {
    const s = (a.source || "").replace(/^refs\/heads\//, "");
    return s && !seen.has(s);
  });
  return { rows, ledgerOnly };
}

// ── IO: read the gate ledger file (best-effort) ───────────────────────────────

export async function loadGateLedger(path: string = CONFIG.GATE_LOG): Promise<GateAttempt[]> {
  try {
    const text = await readFile(path, "utf8");
    return parseGateLedger(text);
  } catch {
    return []; // missing ledger (e.g. gate never ran here) ⇒ empty, never fatal
  }
}

// ── IO: run `gh` (READ-ONLY, allowlisted) ─────────────────────────────────────

const GH_FIELDS = [
  "number", "title", "url", "state", "isDraft",
  "headRefName", "baseRefName", "author", "createdAt", "updatedAt", "mergedAt",
  "additions", "deletions", "changedFiles", "reviewDecision", "statusCheckRollup",
].join(",");

function runGh(subcmd: string, args: string[]): Promise<{ ok: boolean; stdout: string; error?: string }> {
  if (!ALLOWED_GH.has(subcmd)) {
    // Defense-in-depth: this dashboard must never drive a mutating gh command.
    return Promise.resolve({ ok: false, stdout: "", error: `refused non-read gh subcommand: ${subcmd}` });
  }
  const full = [...subcmd.split(" "), ...args];
  if (CONFIG.GH_REPO) full.push("-R", CONFIG.GH_REPO);
  return new Promise((resolvePromise) => {
    execFile(
      CONFIG.GH_BIN,
      full,
      { timeout: CONFIG.GH_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, cwd: CONFIG.REPO_DIR },
      (err, stdout, stderr) => {
        if (err) {
          resolvePromise({ ok: false, stdout: String(stdout || ""), error: (stderr || err.message || "gh failed").toString().trim().slice(0, 300) });
        } else {
          resolvePromise({ ok: true, stdout: String(stdout || "") });
        }
      },
    );
  });
}

async function ghPrList(state: "open" | "merged"): Promise<{ prs: any[]; error?: string }> {
  const res = await runGh("pr list", ["--state", state, "--limit", String(CONFIG.PR_LIMIT), "--json", GH_FIELDS]);
  if (!res.ok) return { prs: [], error: res.error };
  try {
    const parsed = JSON.parse(res.stdout || "[]");
    return { prs: Array.isArray(parsed) ? parsed : [] };
  } catch (e) {
    return { prs: [], error: `could not parse gh JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export interface PRView {
  ok: boolean;
  repo: string;
  rows: PRRow[];
  ledgerOnly: GateAttempt[];
  counts: { open: number; merged: number; ledger: number };
  error?: string;
  gh_available: boolean;
}

/** Assemble the full PR view: open + merged PRs (gh) correlated to the gate ledger. */
export async function buildPRView(): Promise<PRView> {
  const [openRes, mergedRes, ledger] = await Promise.all([
    ghPrList("open"),
    ghPrList("merged"),
    loadGateLedger(),
  ]);
  const ghErr = openRes.error || mergedRes.error;
  const ghAvailable = !ghErr || (openRes.prs.length + mergedRes.prs.length > 0);
  const prs = [...openRes.prs, ...mergedRes.prs];
  const { rows, ledgerOnly } = correlate(prs, ledger);
  // newest first: open before merged, then by updatedAt/mergedAt desc
  rows.sort((a, b) => {
    const rank = (r: PRRow) => (r.state === "OPEN" ? 0 : 1);
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    const ta = Date.parse(a.mergedAt || a.updatedAt || a.createdAt || "") || 0;
    const tb = Date.parse(b.mergedAt || b.updatedAt || b.createdAt || "") || 0;
    return tb - ta;
  });
  return {
    ok: !ghErr,
    repo: CONFIG.GH_REPO || "(origin remote)",
    rows,
    ledgerOnly,
    counts: { open: openRes.prs.length, merged: mergedRes.prs.length, ledger: ledger.length },
    error: ghErr,
    gh_available: ghAvailable,
  };
}
