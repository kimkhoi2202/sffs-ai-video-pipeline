/**
 * server.ts — the always-on hermes-nous READ-ONLY web dashboard.
 *
 * Node built-ins ONLY (no deps). Serves a supervisor UI for the rebuilt
 * DRAFT-ONLY agent: cycle status, A/B results, the software-factory CODE-PR view
 * (review-agent verdict + test status), and loop health + a kill-switch indicator.
 *
 * SECURITY / GUARDRAILS:
 *   - Read-only: there is NO route that posts, schedules, publishes, merges, or
 *     mutates anything. Every route only READS local files / GitHub (via `gh` read
 *     subcommands). The read-only invariant is asserted at boot (assertReadOnly).
 *   - HTTP Basic Auth (timing-safe), exactly like the current live dashboard. If
 *     no password is configured it relies on the network/SG restriction (parity
 *     with hermes/src/dashboard.ts) — set HERMES_DASH_PASS in prod.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { CONFIG, assertReadOnly } from "./config.ts";
import {
  runSummaries, abDb, learnings, bankStats, killSwitch, cycleSchedule, diskInfo, llmPing, runLog,
  proposals, contentDefaults, bankCoverage, costSnapshot,
} from "./data.ts";
import { buildPRView } from "./prs.ts";
import { page } from "./render.ts";

assertReadOnly();

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

    // liveness probe: no data, no auth needed (leaks nothing)
    if (url.pathname === "/healthz") return send(res, 200, "ok", "text/plain");

    if (!authed(req)) {
      res.writeHead(401, { "www-authenticate": 'Basic realm="Hermes-Nous", charset="UTF-8"', "content-type": "text/plain" });
      return res.end("Authentication required");
    }

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
      const pr = await buildPRView();
      return send(
        res, 200,
        page({
          latest,
          runs,
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
    console.log(`[hermes-nous-dashboard] listening on :${port} (read-only; basic auth: ${CONFIG.DASH_PASS ? "on" : "OFF"})`);
  });
}

export { server };
