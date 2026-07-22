/**
 * dashboard.ts — the always-on Hermes web dashboard (Node built-ins ONLY, no deps).
 *
 * Shows everything a human needs to supervise the DRAFT-ONLY loop:
 *   - loop health (LLM ping, last/next run, systemd timer, bank freshness)
 *   - the day's designed A/B batch: each video's dimension/arm/rationale + status
 *   - quality-gate results per video (dedup / question-validity / copy / render sanity)
 *   - the drafts created (Publer post ids + the presigned S3 media URL to preview)
 *   - analytics per post (from ab-database.json) + variant-family rollups (learnings)
 *   - the decisions/scoring log
 *
 * It is READ-ONLY: it never posts, schedules, renders, or mutates anything. It only
 * reads run-state JSON + repo data files. Secured by HTTP Basic Auth (and the SG
 * already restricts the port to the operator's IP).
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, statSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { CONFIG } from "./config.ts";
import { listRuns, loadRun, readJSON, type RunState, type VideoPlan } from "./state.ts";
import { bankStats } from "./questions.ts";

// ── auth ────────────────────────────────────────────────────────────────────
function eq(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
function authed(req: IncomingMessage): boolean {
  if (!CONFIG.DASH_PASS) return true; // no password configured -> rely on SG
  const h = req.headers.authorization || "";
  const m = h.match(/^Basic\s+(.+)$/i);
  if (!m) return false;
  const [u, p] = Buffer.from(m[1], "base64").toString("utf8").split(":");
  return eq(u ?? "", CONFIG.DASH_USER) && eq(p ?? "", CONFIG.DASH_PASS);
}

// ── data loaders (all best-effort; a missing file never crashes the page) ─────
function abDb(): any {
  return readJSON<any>(CONFIG.AB_DB, { posts: [] });
}
function learnings(): any {
  return readJSON<any>(CONFIG.LEARNINGS, {});
}
function runSummaries(limit = 30): RunState[] {
  return listRuns()
    .slice(0, limit)
    .map((id) => loadRun(id))
    .filter((r): r is RunState => !!r);
}
function safeBankStats(): { total: number; usable: number; fresh: number; used: number } {
  try {
    return bankStats();
  } catch {
    return { total: 0, usable: 0, fresh: 0, used: 0 };
  }
}
function timerInfo(): { enabled: string; next: string; last: string } {
  try {
    const out = execFileSync(
      "systemctl",
      ["show", "hermes-loop.timer", "--property=NextElapseUSecRealtime,LastTriggerUSec,ActiveState,UnitFileState", "--no-pager"],
      { encoding: "utf8", timeout: 4000 },
    );
    const kv: Record<string, string> = {};
    for (const line of out.trim().split("\n")) {
      const i = line.indexOf("=");
      if (i > 0) kv[line.slice(0, i)] = line.slice(i + 1);
    }
    return {
      enabled: `${kv.UnitFileState ?? "?"} / ${kv.ActiveState ?? "?"}`,
      next: kv.NextElapseUSecRealtime || "n/a",
      last: kv.LastTriggerUSec || "n/a",
    };
  } catch {
    return { enabled: "unknown (systemd not queryable)", next: "n/a", last: "n/a" };
  }
}
function diskInfo(): string {
  try {
    const out = execFileSync("df", ["-h", "/"], { encoding: "utf8", timeout: 4000 }).trim().split("\n").pop() || "";
    const c = out.split(/\s+/);
    return `${c[2]} used / ${c[1]} (${c[4]})`;
  } catch {
    return "n/a";
  }
}
async function llmPing(): Promise<{ ok: boolean; model: string; reply?: string; error?: string }> {
  try {
    const mod = await import("./llm.ts");
    return await mod.ping();
  } catch (e) {
    return { ok: false, model: CONFIG.MODEL, error: e instanceof Error ? e.message : String(e) };
  }
}
function runLog(runId: string, maxLines = 400): any[] {
  const path = `${CONFIG.RUNS_DIR}/${runId}.log`;
  if (!existsSync(path)) return [];
  try {
    const lines = readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
    return lines.slice(-maxLines).map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return { ts: "", level: "raw", msg: l };
      }
    });
  } catch {
    return [];
  }
}

// ── html helpers ──────────────────────────────────────────────────────────────
const esc = (s: unknown): string =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const n = (v: unknown): string => (v === null || v === undefined || v === "" ? "—" : String(v));
const publerPostUrl = (id: string): string => `https://app.publer.com/#/scheduler/posts/${encodeURIComponent(id)}`;

function badge(pass: boolean | undefined, label: string): string {
  if (pass === undefined) return `<span class="b b-na">${esc(label)}: —</span>`;
  return `<span class="b ${pass ? "b-ok" : "b-no"}">${esc(label)}: ${pass ? "pass" : "FAIL"}</span>`;
}
function statusChip(s: string): string {
  const cls =
    s === "drafted" ? "c-ok" : s === "rejected" ? "c-warn" : s === "failed" ? "c-no" : s === "running" ? "c-run" : "c-idle";
  return `<span class="chip ${cls}">${esc(s)}</span>`;
}

function videoCard(v: VideoPlan): string {
  const g = v.gates || {};
  const gates = [
    badge(g.dedup?.pass, "dedup"),
    badge(g.questions?.pass, "questions"),
    badge(g.copy?.pass, "copy"),
    badge(g.render?.pass, "render"),
  ].join(" ");
  const posts = (v.publer?.post_ids || [])
    .map((id) => `<a href="${publerPostUrl(id)}" target="_blank" rel="noopener">${esc(id)}</a>`)
    .join(", ");
  const media = v.media_url
    ? `<a class="media" href="${esc(v.media_url)}" target="_blank" rel="noopener">▶ preview rendered mp4 (presigned)</a>`
    : "";
  const reject = v.reject_reason ? `<div class="reject">rejected: ${esc(v.reject_reason)}</div>` : "";
  const qs = (v.questions || [])
    .map((q) => `<li><b>${esc(q.tier)}</b> — ${esc(q.prompt)} <span class="ans">→ ${esc(q.answer)}</span></li>`)
    .join("");
  return `<div class="vid">
    <div class="vid-h">
      <div><span class="dim">${esc(v.dimension)}</span> <span class="arm">/ ${esc(v.arm)}</span></div>
      ${statusChip(v.status)}
    </div>
    <div class="rationale">${esc(v.rationale)}</div>
    <div class="gates">${gates}</div>
    ${reject}
    <details><summary>${(v.questions || []).length} question(s) · caption · props</summary>
      <ul class="qs">${qs}</ul>
      <div class="cap"><b>caption:</b> ${esc(v.caption)}</div>
      <div class="cap"><b>hashtags:</b> set ${esc(v.hashtag_set)}</div>
    </details>
    <div class="vid-f">${media} ${posts ? `<span class="pub">publer: ${posts}</span>` : ""}</div>
  </div>`;
}

function analyticsTable(db: any): string {
  const posts: any[] = Array.isArray(db?.posts) ? db.posts : [];
  if (!posts.length) return `<p class="muted">No posts tracked in ab-database.json yet.</p>`;
  const rows = posts
    .slice(-60)
    .reverse()
    .map((p) => {
      const m = p.metrics || {};
      const live = p.post_state && p.post_state !== "draft";
      return `<tr>
        <td>${esc(p.platform || "—")}${live ? ' <span class="live">LIVE</span>' : ' <span class="draft">draft</span>'}</td>
        <td class="cell-fam">${esc(p.variant?.family || p.experiment?.dimension || "—")}<br><span class="muted">${esc(p.variant?.arm || p.experiment?.arm || "")}</span></td>
        <td>${n(m.reach)}</td>
        <td>${n(m.video_views)}</td>
        <td>${n(m.reactions)}</td>
        <td>${n(m.comments)}</td>
        <td>${n(m.shares)}</td>
        <td>${m.eng_rate != null ? esc(m.eng_rate) + "%" : "—"}</td>
        <td class="muted">${esc(m.as_of || m.source || "pending")}</td>
      </tr>`;
    })
    .join("");
  return `<table class="tbl">
    <thead><tr><th>platform</th><th>experiment</th><th>reach</th><th>views</th><th>reactions</th><th>comments</th><th>shares</th><th>eng</th><th>as of</th></tr></thead>
    <tbody>${rows}</tbody></table>`;
}

function rollupTable(l: any): string {
  const fam = l?.rollups?.by_variant_family || {};
  const keys = Object.keys(fam);
  if (!keys.length) return `<p class="muted">No variant-family rollups yet (need matured metrics).</p>`;
  const front = l?.front_runners?.variant_family;
  const rows = keys
    .map((k) => {
      const v = fam[k] || {};
      const isFront = k === front;
      return `<tr class="${isFront ? "front" : ""}"><td>${esc(k)}${isFront ? ' <span class="star">★ front-runner</span>' : ""}</td>
        <td>${n(v.n_posts)}</td><td>${n(v.n_with_metrics)}</td><td>${v.median_eng_rate != null ? esc(v.median_eng_rate) + "%" : "—"}</td><td>${n(v.avg_reach)}</td></tr>`;
    })
    .join("");
  return `<table class="tbl"><thead><tr><th>variant family</th><th>posts</th><th>w/ metrics</th><th>median eng</th><th>avg reach</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function decisionsList(l: any): string {
  const dec: any[] = Array.isArray(l?.decisions_log) ? l.decisions_log : [];
  const sco: any[] = Array.isArray(l?.scoring_log) ? l.scoring_log : [];
  const decHtml = dec.length
    ? dec
        .slice(-20)
        .reverse()
        .map((d) => `<li><span class="date">${esc(d.date)}</span> ${esc(d.decision)} <span class="muted">(${esc(d.status || "auto")})</span></li>`)
        .join("")
    : `<li class="muted">No auto-decisions yet.</li>`;
  const scoHtml = sco.length
    ? sco
        .slice(-8)
        .reverse()
        .map((s) => `<li><span class="date">${esc(s.date)}</span> pulled ${n(s.pulled)}, updated ${n(s.updated)}, w/metrics ${n(s.n_with_metrics)}</li>`)
        .join("")
    : `<li class="muted">No scoring runs yet.</li>`;
  return `<div class="two"><div><h3>Decisions</h3><ul class="log">${decHtml}</ul></div><div><h3>Scoring log</h3><ul class="log">${scoHtml}</ul></div></div>`;
}

function logStream(runId: string | null): string {
  if (!runId) return "";
  const items = runLog(runId).filter((r) => r.level === "decision" || r.level === "gate" || r.level === "error");
  if (!items.length) return `<p class="muted">No decision/gate log for ${esc(runId)} yet.</p>`;
  const rows = items
    .slice(-120)
    .reverse()
    .map((r) => `<div class="lg lg-${esc(r.level)}"><span class="lt">${esc((r.ts || "").slice(11, 19))}</span> <span class="ll">${esc(r.level)}</span> ${esc(r.msg)}</div>`)
    .join("");
  return `<div class="logbox">${rows}</div>`;
}

function page(opts: { latest: RunState | null; runs: RunState[]; db: any; l: any; bank: any; timer: any; disk: string; selected: string | null }): string {
  const { latest, runs, db, l, bank, timer, disk, selected } = opts;
  const cur = selected ? runs.find((r) => r.run_id === selected) || latest : latest;
  const s = cur?.summary || { planned: 0, drafted: 0, rejected: 0, failed: 0 };
  const drafts = (cur?.videos || []).filter((v) => v.status === "drafted");
  const draftTotal = drafts.reduce((a, v) => a + (v.publer?.post_ids?.length || 0), 0);
  const runOpts = runs
    .map((r) => `<option value="${esc(r.run_id)}" ${r.run_id === cur?.run_id ? "selected" : ""}>${esc(r.run_id)} · ${esc(r.status)} · ${r.summary?.drafted ?? 0} drafts</option>`)
    .join("");
  const videos = (cur?.videos || []).map(videoCard).join("") || `<p class="muted">No batch designed yet for this run.</p>`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Hermes · SFFS draft-only loop</title>
<style>
:root{--ink:#000;--paper:#fff;--blue:#839aff;--mint:#c6fcd0;--coral:#fd7962;--yellow:#fce552;--cream:#f6f4ee;--green:#63c088}
*{box-sizing:border-box}
body{margin:0;background:var(--cream);color:var(--ink);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif}
a{color:#1b3bd1}
header{background:var(--blue);border-bottom:5px solid var(--ink);padding:18px 22px;display:flex;flex-wrap:wrap;gap:14px;align-items:center;justify-content:space-between}
header h1{margin:0;font:800 24px/1 "Segoe UI",sans-serif;letter-spacing:.5px}
.tag{background:var(--ink);color:var(--yellow);padding:4px 10px;border-radius:6px;font-weight:800;font-size:12px;letter-spacing:1px}
.wrap{max-width:1120px;margin:0 auto;padding:22px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:14px;margin-bottom:22px}
.kpi{background:var(--paper);border:4px solid var(--ink);border-radius:16px;box-shadow:8px 8px 0 0 var(--ink);padding:16px}
.kpi .v{font:800 34px/1 "Segoe UI",sans-serif}
.kpi .k{font-size:12px;text-transform:uppercase;letter-spacing:1px;color:#444;margin-top:6px}
.card{background:var(--paper);border:4px solid var(--ink);border-radius:18px;box-shadow:8px 8px 0 0 var(--ink);padding:20px;margin-bottom:22px}
.card h2{margin:0 0 14px;font-size:20px;display:flex;gap:10px;align-items:center}
.card h2 .pin{background:var(--coral);border:3px solid var(--ink);border-radius:8px;padding:2px 8px;font-size:12px;font-weight:800}
.vid{border:3px solid var(--ink);border-radius:14px;padding:14px;margin-bottom:14px;background:var(--cream)}
.vid-h{display:flex;justify-content:space-between;align-items:center;gap:10px}
.dim{font-weight:800;font-size:17px}.arm{color:#555}
.rationale{color:#333;margin:6px 0 10px;font-size:14px}
.gates{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}
.b{font-size:12px;font-weight:700;padding:3px 8px;border-radius:6px;border:2px solid var(--ink)}
.b-ok{background:var(--green)}.b-no{background:var(--coral);color:#fff}.b-na{background:#ddd}
.reject{background:#ffe3de;border:2px solid var(--coral);border-radius:8px;padding:6px 10px;font-size:13px;margin-bottom:8px}
.qs{margin:8px 0;padding-left:18px}.qs .ans{color:var(--green);font-weight:700}
.cap{font-size:13px;color:#333;margin-top:4px}
.vid-f{margin-top:10px;display:flex;flex-wrap:wrap;gap:14px;align-items:center;font-size:13px}
.media{font-weight:700}
.chip{font-size:12px;font-weight:800;padding:4px 10px;border-radius:20px;border:2px solid var(--ink)}
.c-ok{background:var(--green)}.c-warn{background:var(--yellow)}.c-no{background:var(--coral);color:#fff}.c-run{background:var(--blue)}.c-idle{background:#e5e5e5}
.tbl{width:100%;border-collapse:collapse;font-size:13px}
.tbl th,.tbl td{border:2px solid var(--ink);padding:6px 8px;text-align:left}
.tbl th{background:var(--mint)}
.tbl .front{background:var(--yellow)}
.star{font-size:11px;font-weight:800}
.live{background:var(--coral);color:#fff;font-size:10px;padding:1px 5px;border-radius:4px;font-weight:800}
.draft{background:#ddd;font-size:10px;padding:1px 5px;border-radius:4px;font-weight:800}
.muted{color:#777}.cell-fam{min-width:120px}
.two{display:grid;grid-template-columns:1fr 1fr;gap:20px}
.log{list-style:none;padding:0;margin:0;font-size:13px}
.log li{padding:6px 0;border-bottom:1px solid #e2e2e2}
.date{font-weight:800;margin-right:6px}
.health{display:flex;flex-wrap:wrap;gap:10px}
.hpill{background:var(--cream);border:3px solid var(--ink);border-radius:10px;padding:8px 12px;font-size:13px}
.hpill b{display:block;font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#555}
.logbox{max-height:340px;overflow:auto;background:#0d0d0d;color:#d6d6d6;border-radius:12px;padding:12px;font:12px/1.5 ui-monospace,Menlo,monospace}
.lg{padding:2px 0;white-space:pre-wrap}.lt{color:#7bd88f}.ll{color:#f5c451;font-weight:700}
.lg-error .ll{color:#ff7a6b}
form.runsel{display:flex;gap:8px;align-items:center}
select{padding:6px 8px;border:3px solid var(--ink);border-radius:8px;font-size:13px;background:#fff}
.foot{color:#666;font-size:12px;text-align:center;padding:14px}
details summary{cursor:pointer;font-size:13px;color:#333;margin-top:6px}
</style></head>
<body>
<header>
  <h1>HERMES <span class="tag">DRAFT-ONLY</span></h1>
  <div id="health" class="health"><span class="hpill">checking health…</span></div>
</header>
<div class="wrap">
  <div class="grid">
    <div class="kpi"><div class="v">${s.planned}</div><div class="k">planned</div></div>
    <div class="kpi"><div class="v">${s.drafted}</div><div class="k">videos drafted</div></div>
    <div class="kpi"><div class="v">${draftTotal}</div><div class="k">publer drafts</div></div>
    <div class="kpi"><div class="v">${s.rejected}</div><div class="k">rejected (gates)</div></div>
    <div class="kpi"><div class="v">${bank.fresh}</div><div class="k">fresh questions</div></div>
  </div>

  <div class="card">
    <h2><span class="pin">RUN</span> Cycle
      <form class="runsel" method="get" style="margin-left:auto">
        <label for="run">run:</label>
        <select id="run" name="run" onchange="this.form.submit()">${runOpts || `<option>none</option>`}</select>
      </form>
    </h2>
    <p>${cur ? `<b>${esc(cur.run_id)}</b> · ${statusChip(cur.status)} · started ${esc(cur.started_at)} · updated ${esc(cur.updated_at)}${cur.finished_at ? " · finished " + esc(cur.finished_at) : ""}` : "No runs yet. The loop timer will create the first cycle, or run it manually."}</p>
    ${cur?.do_not_touch?.captured_at ? `<p class="muted">do-not-touch snapshot: ${cur.do_not_touch.scheduled_ids.length} scheduled + ${cur.do_not_touch.published_ids.length} published captured @ ${esc(cur.do_not_touch.captured_at)} — the loop verifies these are untouched after every cycle.</p>` : ""}
    ${cur?.errors?.length ? `<div class="reject">run errors: ${esc(cur.errors.join(" | "))}</div>` : ""}
  </div>

  <div class="card">
    <h2><span class="pin">A/B</span> Designed batch &amp; quality gates</h2>
    ${videos}
  </div>

  <div class="card">
    <h2><span class="pin">DATA</span> Analytics per post</h2>
    ${analyticsTable(db)}
  </div>

  <div class="card">
    <h2><span class="pin">LEARN</span> Variant-family rollups</h2>
    ${rollupTable(l)}
  </div>

  <div class="card">
    <h2><span class="pin">LOG</span> Learnings &amp; decisions</h2>
    ${decisionsList(l)}
  </div>

  <div class="card">
    <h2><span class="pin">TRACE</span> Loop decision/gate stream — ${esc(cur?.run_id || "—")}</h2>
    ${logStream(cur?.run_id || null)}
  </div>

  <div class="foot">
    timer: ${esc(timer.enabled)} · next: ${esc(timer.next)} · disk: ${esc(disk)} · auto-refresh 60s ·
    the loop can ONLY create Publer drafts. Going live is a human action.
  </div>
</div>
<script>
(async function(){
  try{
    const r = await fetch('/api/health',{headers:{'accept':'application/json'}});
    const h = await r.json();
    const el = document.getElementById('health');
    const llm = h.llm && h.llm.ok ? '<span class="hpill" style="background:var(--green)"><b>LLM</b>ok · '+ (h.llm.model||'') +'</span>'
                                  : '<span class="hpill" style="background:var(--coral);color:#fff"><b>LLM</b>'+ (h.llm && h.llm.error ? String(h.llm.error).slice(0,40) : 'down') +'</span>';
    el.innerHTML = llm
      + '<span class="hpill"><b>timer</b>'+ (h.timer?h.timer.enabled:'?') +'</span>'
      + '<span class="hpill"><b>next run</b>'+ (h.timer?h.timer.next:'?') +'</span>'
      + '<span class="hpill"><b>disk</b>'+ (h.disk||'?') +'</span>'
      + '<span class="hpill"><b>server</b>'+ new Date().toISOString().slice(11,19) +'Z</span>';
  }catch(e){ document.getElementById('health').innerHTML='<span class="hpill" style="background:var(--coral);color:#fff">health check failed</span>'; }
})();
setTimeout(()=>location.reload(), 60000);
</script>
</body></html>`;
}

// ── server ────────────────────────────────────────────────────────────────────
function send(res: ServerResponse, code: number, body: string, type = "text/html; charset=utf-8"): void {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}

const server = createServer(async (req, res) => {
  try {
    if (!authed(req)) {
      res.writeHead(401, { "www-authenticate": 'Basic realm="Hermes", charset="UTF-8"', "content-type": "text/plain" });
      return res.end("Authentication required");
    }
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (url.pathname === "/api/health") {
      const [llm] = await Promise.all([llmPing()]);
      return send(res, 200, JSON.stringify({ llm, timer: timerInfo(), disk: diskInfo(), now: new Date().toISOString() }), "application/json");
    }
    if (url.pathname === "/api/state") {
      const runs = runSummaries();
      return send(
        res,
        200,
        JSON.stringify({ latest: runs[0] ?? null, runs: runs.map((r) => ({ run_id: r.run_id, status: r.status, summary: r.summary })), bank: safeBankStats() }),
        "application/json",
      );
    }
    if (url.pathname === "/api/run") {
      const id = url.searchParams.get("id") || "";
      const r = loadRun(id);
      return send(res, r ? 200 : 404, JSON.stringify(r ?? { error: "not found" }), "application/json");
    }
    if (url.pathname === "/healthz") {
      return send(res, 200, "ok", "text/plain");
    }
    if (url.pathname === "/") {
      const runs = runSummaries();
      const selected = url.searchParams.get("run");
      return send(res, 200, page({ latest: runs[0] ?? null, runs, db: abDb(), l: learnings(), bank: safeBankStats(), timer: timerInfo(), disk: diskInfo(), selected }));
    }
    return send(res, 404, "not found", "text/plain");
  } catch (e) {
    return send(res, 500, `dashboard error: ${e instanceof Error ? e.message : String(e)}`, "text/plain");
  }
});

const port = CONFIG.DASH_PORT;
server.listen(port, "0.0.0.0", () => {
  // eslint-disable-next-line no-console
  console.log(`[hermes-dashboard] listening on :${port} (basic auth: ${CONFIG.DASH_PASS ? "on" : "OFF"})`);
});
