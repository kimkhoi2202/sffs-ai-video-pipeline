/**
 * server.ts — the always-on hermes-nous READ-ONLY web dashboard.
 *
 * Node built-ins ONLY (no deps). Serves a supervisor UI for the rebuilt
 * DRAFT-ONLY agent: cycle status, A/B results, the software-factory CODE-PR view
 * (review-agent verdict + test status), and loop health + a kill-switch indicator.
 *
 * SECURITY / GUARDRAILS:
 *   - Read-only WITH ONE EXCEPTION: /api/approve and /api/reject, which flip a
 *     loop-generated Metricool draft to publishable or soft-delete it. No other route
 *     posts, schedules, publishes, merges or mutates anything. That exception is
 *     UNAUTHENTICATED by an explicit user decision, and is bounded instead of gated: it
 *     takes no caller content beyond a post uuid, and refuses any post that is not
 *     already an unapproved draft — so the human-reviewed reels on the calendar are
 *     structurally out of its reach with or without a credential. Every route only READS local files / GitHub (via `gh` read
 *     subcommands) / Metricool (via the read-only metricool-read bridge). The read-only
 *     invariant is asserted at boot (assertReadOnly).
 *   - PUBLIC: served with NO authentication (no login). This is safe because the
 *     surface is strictly read-only and renders NO secrets/credentials/env values
 *     in any HTML or /api/* response. The kill-switch, factory, merges and posting
 *     controls remain box-only (stop-file/env/CLI), never a web action. The
 *     timing-safe basic-auth helpers are retained for tests / optional re-locking
 *     but do NOT gate any request.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { CONFIG, assertReadOnly } from "./config.ts";
import {
  runSummaries, abDb, learnings, bankStats, killSwitch, cycleSchedule, diskInfo, llmPing, runLog,
  proposals, contentDefaults, bankCoverage, costSnapshot, factoryStatus, supervisorStatus,
  goalProgress, scheduledPosts, replication, leadPolicy,
} from "./data.ts";
import { buildPRView } from "./prs.ts";
import { page } from "./render.ts";
import { routeApproval } from "./approve.ts";

assertReadOnly();

// Vendored static assets (Plyr CSS/JS/SVG) served READ-ONLY from ./static.
// Whitelist-only lookup ⇒ no path traversal, no arbitrary file read.
const STATIC_DIR = new URL("./static/", import.meta.url);
const STATIC_TYPES: Record<string, string> = {
  "plyr.css": "text/css; charset=utf-8",
  "plyr.min.js": "text/javascript; charset=utf-8",
  "plyr.svg": "image/svg+xml; charset=utf-8",
};

// ── auth (timing-safe; mirrors hermes/src/dashboard.ts) ──────────────────────
export function eq(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
/** Pure basic-auth check (no CONFIG dependency ⇒ unit-testable). Empty pass ⇒ open. */
export function checkBasicAuth(header: string | undefined, user: string, pass: string): boolean {
  if (!pass) return true; // no password configured -> rely on network/SG
  const m = (header || "").match(/^Basic\s+(.+)$/i);
  if (!m) return false;
  const [u, p] = Buffer.from(m[1], "base64").toString("utf8").split(":");
  return eq(u ?? "", user) && eq(p ?? "", pass);
}
export function authed(req: Pick<IncomingMessage, "headers">): boolean {
  return checkBasicAuth(req.headers.authorization, CONFIG.DASH_USER, CONFIG.DASH_PASS);
}

function send(res: ServerResponse, code: number, body: string, type = "text/html; charset=utf-8"): void {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(body);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    // liveness probe: no data (leaks nothing)
    // THE ONLY MUTATION on this dashboard. Everything else below is a GET that reads.
    // Scoped to approve/reject on one already-unapproved draft; see approve.ts for why
    // that bound is the whole security argument on a public HTTP surface.
    if (await routeApproval(url.pathname, req, res)) return;

    if (url.pathname === "/healthz") return send(res, 200, "ok", "text/plain");

    // Vendored static assets (Plyr) — READ-ONLY, whitelist-only (no traversal, no secrets).
    if (url.pathname.startsWith("/static/")) {
      const name = url.pathname.slice(8);
      const type = STATIC_TYPES[name];
      if (!type) return send(res, 404, "not found", "text/plain");
      try {
        const buf = readFileSync(new URL(name, STATIC_DIR));
        res.writeHead(200, { "content-type": type, "cache-control": "public, max-age=86400", "x-content-type-options": "nosniff" });
        return void res.end(buf);
      } catch {
        return send(res, 404, "not found", "text/plain");
      }
    }

    // PUBLIC: this dashboard is intentionally served with NO authentication.
    // It is safe to expose because it is strictly READ-ONLY (every route only
    // READS local JSON / GitHub via read-only `gh` / a read-only Metricool bridge)
    // and renders NO secrets/credentials/env values. There is deliberately no
    // 401 challenge and no mutating route. The pure basic-auth helpers below
    // (checkBasicAuth/eq/authed) are retained for unit tests / future re-locking
    // but are NOT used to gate any request. Access is open to anyone who can
    // reach the port (network/SG controls the audience).

    if (url.pathname === "/api/health") {
      const [llm, pr] = await Promise.all([llmPing(), buildPRView()]);
      const latest = runSummaries(1)[0] ?? null;
      return send(
        res, 200,
        JSON.stringify({
          llm,
          kill: killSwitch(),
          schedule: cycleSchedule(latest),
          disk: diskInfo(),
          prs: pr.counts,
          now: new Date().toISOString(),
        }),
        "application/json",
      );
    }

    if (url.pathname === "/api/state") {
      const runs = runSummaries();
      return send(
        res, 200,
        JSON.stringify({
          latest: runs[0] ?? null,
          runs: runs.map((r) => ({ run_id: r.run_id, status: r.status, summary: r.summary })),
          bank: bankStats(),
          kill: killSwitch(),
        }),
        "application/json",
      );
    }

    if (url.pathname === "/api/prs") {
      return send(res, 200, JSON.stringify(await buildPRView()), "application/json");
    }

    if (url.pathname === "/api/factory") {
      return send(res, 200, JSON.stringify(factoryStatus() ?? { error: "no factory daemon status" }), "application/json");
    }

    if (url.pathname === "/api/supervisor") {
      // READ-ONLY: always-on continuous (non-posting) supervisor status. No secrets.
      return send(res, 200, JSON.stringify(supervisorStatus() ?? { error: "no supervisor status" }), "application/json");
    }

    if (url.pathname === "/api/goal") {
      // READ-ONLY: live GOAL-PROGRESS toward the 7-day mandate. Pure numbers, no secrets.
      return send(res, 200, JSON.stringify(goalProgress()), "application/json");
    }

    if (url.pathname === "/api/replication") {
      // READ-ONLY: which reach outlier the designer is doubling down on, its share of
      // each batch vs the exploration cap, and the reversible ledger history. Pure
      // read of replication.json — this route never opens, escalates or reverts a
      // round (that is replicate.py's job, from the box). No secrets.
      return send(res, 200, JSON.stringify(replication()), "application/json");
    }

    if (url.pathname === "/api/lead-policy") {
      // READ-ONLY: which opening-question band the designer is weighting toward, the
      // Instagram skip-rate evidence behind it, and the reversible ledger of previous
      // mixes. A pure read of lead-policy.json — the cycle decides, never this route.
      return send(res, 200, JSON.stringify(leadPolicy()), "application/json");
    }

    if (url.pathname === "/api/scheduled") {
      // READ-ONLY: post-kickoff SCHEDULED posts + times (mirrored live from Metricool).
      // Media urls are allowlisted to the public static.metricool.com CDN, which serves
      // without a Referer — so there is no server-side media proxy to hold open. No secrets.
      return send(res, 200, JSON.stringify(await scheduledPosts()), "application/json");
    }

    if (url.pathname === "/api/run") {
      const { loadRun } = await import("./data.ts");
      const id = url.searchParams.get("id") || "";
      const r = loadRun(id);
      return send(res, r ? 200 : 404, JSON.stringify(r ?? { error: "not found" }), "application/json");
    }

    if (url.pathname === "/") {
      const runs = runSummaries();
      const latest = runs[0] ?? null;
      const selected = url.searchParams.get("run");
      const [pr, scheduled] = await Promise.all([buildPRView(), scheduledPosts()]);
      return send(
        res, 200,
        page({
          latest,
          runs,
          scheduled,
          db: abDb(),
          l: learnings(),
          bank: bankStats(),
          schedule: cycleSchedule(latest),
          kill: killSwitch(),
          disk: diskInfo(),
          selected,
          pr,
          logItems: runLog(selected || latest?.run_id || ""),
          proposals: proposals(),
          defaults: contentDefaults(),
          coverage: bankCoverage(),
          snapshot: costSnapshot(),
          factory: factoryStatus(),
          supervisor: supervisorStatus(),
          goal: goalProgress(),
          replication: replication(),
          leadPolicy: leadPolicy(),
          approvalGate: { paused: CONFIG.APPROVAL_PAUSED, restoreCmd: CONFIG.APPROVAL_RESTORE_CMD },
        }),
      );
    }

    return send(res, 404, "not found", "text/plain");
  } catch (e) {
    return send(res, 500, `dashboard error: ${e instanceof Error ? e.message : String(e)}`, "text/plain");
  }
});

// Only start listening when run directly (not when imported by tests).
if (import.meta.main) {
  const port = CONFIG.DASH_PORT;
  server.listen(port, "0.0.0.0", () => {
    // eslint-disable-next-line no-console
    console.log(`[hermes-nous-dashboard] listening on :${port} (READ-ONLY; auth: PUBLIC — no login)`);
  });
}

export { server };
