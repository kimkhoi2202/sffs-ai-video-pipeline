/**
 * render.ts — pure HTML rendering for the dashboard (data in → HTML string out).
 *
 * Reuses the visual language of the current live dashboard (hermes/src/dashboard.ts):
 * the neobrutalist card style, KPI grid, gate badges, status chips, and analytics
 * tables — so this reads as the same product. Adds three things the rebuilt agent
 * needs: a kill-switch banner, an explicit last/next-run schedule, and the
 * CODE-PR VIEW (software-factory PRs + review-agent verdict + test status).
 *
 * Every function is PURE and escapes all interpolated data. There is NO form,
 * button, or link here that posts, schedules, publishes, or merges anything —
 * this is a display-only surface (guardrail-locked by a test).
 */
import type { RunState, VideoPlan, GateAttempt, PRRow, PromotionProposal, ProposalsQueue, ContentDefaultsFile } from "./types.ts";
import type { KillSwitchState, Schedule, BankStats, BankCoverage } from "./data.ts";
import type { PRView } from "./prs.ts";

// ── html helpers ──────────────────────────────────────────────────────────────
export const esc = (s: unknown): string =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const n = (v: unknown): string => (v === null || v === undefined || v === "" ? "—" : String(v));
const publerPostUrl = (id: string): string => `https://app.publer.com/#/scheduler/posts/${encodeURIComponent(id)}`;
const short = (s: string | undefined, len = 10): string => (s ? esc(String(s).slice(0, len)) : "—");

function badge(pass: boolean | undefined, label: string): string {
  if (pass === undefined) return `<span class="b b-na">${esc(label)}: —</span>`;
  return `<span class="b ${pass ? "b-ok" : "b-no"}">${esc(label)}: ${pass ? "pass" : "FAIL"}</span>`;
}
function statusChip(s: string): string {
  const cls =
    s === "drafted" || s === "success" ? "c-ok"
    : s === "rejected" || s === "partial" ? "c-warn"
    : s === "failed" ? "c-no"
    : s === "running" ? "c-run" : "c-idle";
  return `<span class="chip ${cls}">${esc(s)}</span>`;
}

// ── cycle: per-video A/B + quality gates ─────────────────────────────────────
function videoCard(v: VideoPlan): string {
  const g = v.gates || {};
  const gates = [
    badge(g.dedup?.pass, "dedup"),
    badge((g.questions || g.validity)?.pass, "questions"),
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

// ── A/B analytics + rollups ───────────────────────────────────────────────────
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

function frontRunners(l: any): string {
  const fr = l?.front_runners;
  if (!fr || typeof fr !== "object") return "";
  const pill = (k: string, v: unknown) =>
    v == null || v === "" ? "" : `<span class="hpill"><b>${esc(k)}</b>${esc(v)}</span>`;
  const pills = [
    pill("variant family", fr.variant_family),
    pill("platform", fr.platform),
    pill("hashtag set", fr.hashtag_set),
    pill("time bucket", fr.time_bucket),
    pill("confidence", fr.confidence),
    pill("as of", fr.as_of),
  ].join("");
  const notes = fr.notes ? `<p class="muted" style="margin-top:8px">${esc(fr.notes)}</p>` : "";
  return `<div class="health" style="margin-bottom:8px">${pills}</div>${notes}`;
}

function decisionsList(l: any): string {
  const dec: any[] = Array.isArray(l?.decisions_log) ? l.decisions_log : [];
  const sco: any[] = Array.isArray(l?.scoring_log) ? l.scoring_log : [];
  const decHtml = dec.length
    ? dec.slice(-20).reverse().map((d) => `<li><span class="date">${esc(d.date)}</span> ${esc(d.decision)} <span class="muted">(${esc(d.status || "auto")})</span></li>`).join("")
    : `<li class="muted">No auto-decisions yet.</li>`;
  const scoHtml = sco.length
    ? sco.slice(-8).reverse().map((s) => `<li><span class="date">${esc(s.date)}</span> pulled ${n(s.pulled)}, updated ${n(s.updated)}, w/metrics ${n(s.n_with_metrics)}</li>`).join("")
    : `<li class="muted">No scoring runs yet.</li>`;
  return `<div class="two"><div><h3>Decisions</h3><ul class="log">${decHtml}</ul></div><div><h3>Scoring log</h3><ul class="log">${scoHtml}</ul></div></div>`;
}

// ── question-bank COVERAGE + days-of-runway (P2) ──────────────────────────────
function bankCoverageCard(cov: BankCoverage): string {
  const rows = cov.byType
    .map((t) => {
      const low = t.fresh <= 5;
      return `<tr class="${low ? "front" : ""}"><td>${esc(t.tier)}${low ? ' <span class="star">⚠ low</span>' : ""}</td><td>${n(t.usable)}</td><td>${n(t.fresh)}</td></tr>`;
    })
    .join("");
  const runway = cov.runwayDays == null ? "—" : `${cov.runwayDays} day${cov.runwayDays === 1 ? "" : "s"}`;
  const runwayCls =
    cov.runwayDays != null && cov.runwayDays <= 7 ? "c-no" : cov.runwayDays != null && cov.runwayDays <= 21 ? "c-warn" : "c-ok";
  return `<div class="health" style="margin-bottom:12px">
    <span class="hpill"><b>usable</b>${n(cov.usable)} / ${n(cov.total)}</span>
    <span class="hpill"><b>fresh (never used)</b>${n(cov.fresh)} (${esc(cov.freshPct)}%)</span>
    <span class="hpill"><b>used</b>${n(cov.used)}</span>
    <span class="hpill"><b>days of runway</b><span class="chip ${runwayCls}">${esc(runway)}</span></span>
    <span class="hpill"><b>est. burn</b>~${n(cov.perDay)} q/day</span>
  </div>
  ${cov.byType.length ? `<table class="tbl"><thead><tr><th>question type</th><th>usable</th><th>fresh</th></tr></thead><tbody>${rows}</tbody></table>` : `<p class="muted">No question-bank entries found.</p>`}
  <p class="muted" style="margin-top:8px">Runway = fresh usable questions ÷ est. burn (${n(cov.perDay)}/day). The near-dup + type-spread guards keep variety; this flags a TYPE running low.</p>`;
}

// ── per-ARM A/B leaderboard (P2) ──────────────────────────────────────────────
function armLeaderboard(l: any): string {
  const arms = l?.rollups?.by_variant_arm || {};
  const keys = Object.keys(arms);
  if (!keys.length) return `<p class="muted">No per-arm rollups yet (need matured metrics; run scoring).</p>`;
  const minN = l?.conventions?.min_n ?? 3;
  const ranked = keys
    .map((k) => ({ arm: k, ...(arms[k] || {}) }))
    .sort((a: any, b: any) => {
      const am = a.median_eng_rate;
      const bm = b.median_eng_rate;
      if (am == null && bm == null) return (b.n_with_metrics ?? 0) - (a.n_with_metrics ?? 0);
      if (am == null) return 1;
      if (bm == null) return -1;
      return bm - am;
    });
  const leader = ranked.find((r: any) => (r.n_with_metrics ?? 0) >= minN && r.median_eng_rate != null);
  const rows = ranked
    .map((r: any, i: number) => {
      const isLeader = !!leader && r.arm === leader.arm;
      const enough = (r.n_with_metrics ?? 0) >= minN;
      return `<tr class="${isLeader ? "front" : ""}"><td>${i + 1}</td><td>${esc(r.arm)}${isLeader ? ' <span class="star">★ leader</span>' : ""}${!enough ? ' <span class="muted">(low n)</span>' : ""}</td>
        <td>${n(r.n_posts)}</td><td>${n(r.n_with_metrics)}</td><td>${r.median_eng_rate != null ? esc(r.median_eng_rate) + "%" : "—"}</td><td>${n(r.avg_reach)}</td></tr>`;
    })
    .join("");
  return `<p class="muted">Ranked by median engagement rate (arms with n≥${esc(minN)} matured posts lead; "low n" arms are shown but not crowned). This ARM-level cut is what the default-promotion engine compares against the control.</p>
    <table class="tbl"><thead><tr><th>#</th><th>arm</th><th>posts</th><th>w/ metrics</th><th>median eng</th><th>avg reach</th></tr></thead><tbody>${rows}</tbody></table>`;
}

// ── published-post map — off the reconcile-backfilled native ids/permalinks ────
function publishedMap(db: any): string {
  const posts: any[] = Array.isArray(db?.posts) ? db.posts : [];
  const pub = posts.filter((p) => p && (p.platform_post_id || p.permalink || (p.post_state && p.post_state !== "draft")));
  if (!pub.length) {
    return `<p class="muted">No published posts mapped yet. Once a human publishes a draft, <code>sffs_reconcile</code> back-fills its native id + permalink + posted_at here (off ab-database.json) — the data that closes the A/B learning loop for the agent's own posts.</p>`;
  }
  const rows = pub
    .slice(-80)
    .reverse()
    .map((p) => {
      const m = p.metrics || {};
      const link = p.permalink ? `<a href="${esc(p.permalink)}" target="_blank" rel="noopener">link</a>` : "—";
      const arm = p.variant?.arm || p.variant?.label || p.experiment?.arm || "—";
      return `<tr>
        <td>${esc(p.platform || "—")}</td>
        <td class="muted">${esc(p.posted_at || "—")}</td>
        <td>${link}</td>
        <td>${esc(arm)}</td>
        <td class="muted">${esc(String(p.platform_post_id ?? "—")).slice(0, 20)}</td>
        <td>${m.eng_rate != null ? esc(m.eng_rate) + "%" : "—"}</td>
      </tr>`;
    })
    .join("");
  return `<p class="muted">${pub.length} published/reconciled post(s). Native id + permalink + posted_at are back-filled by <code>sffs_reconcile</code> (matching publer_post_id → the published post).</p>
    <table class="tbl"><thead><tr><th>platform</th><th>posted at</th><th>permalink</th><th>arm</th><th>native id</th><th>eng</th></tr></thead><tbody>${rows}</tbody></table>`;
}

// ── spend / cost-governor snapshot (P2; read-only) ────────────────────────────
function spendMetric(label: string, m: any, fmt: (v: any) => string): string {
  if (!m || typeof m !== "object") return `<span class="hpill"><b>${esc(label)}</b>—</span>`;
  const over = m.over === true;
  const ceil = m.ceiling ? fmt(m.ceiling) : "∞";
  return `<span class="hpill" ${over ? 'style="background:var(--coral);color:#fff"' : ""}><b>${esc(label)}${over ? " ⛔ OVER" : ""}</b>${fmt(m.value)} / ${esc(ceil)}</span>`;
}
function spendPanel(snap: any): string {
  if (!snap || typeof snap !== "object" || !snap.metrics) {
    return `<p class="muted">No spend snapshot yet. The cost governor writes <code>snapshot.json</code> during LLM/subagent activity; this panel shows the day's estimated $/tokens/spawns + concurrency vs their HIGH-but-finite ceilings. Spend brake only — DRAFT-ONLY posting is unaffected.</p>`;
  }
  const met = snap.metrics || {};
  const usd = (v: any) => `$${Number(v ?? 0).toFixed(2)}`;
  const int = (v: any) => Number(v ?? 0).toLocaleString("en-US");
  const kill = snap.kill_switch || {};
  const killPill = kill.engaged
    ? `<span class="hpill" style="background:var(--coral);color:#fff"><b>kill-switch</b>ENGAGED${kill.reason ? " · " + esc(String(kill.reason).slice(0, 40)) : ""}</span>`
    : `<span class="hpill" style="background:var(--green)"><b>kill-switch</b>clear</span>`;
  const ceilNote = snap.ceiling_reason ? `<div class="reject">ceiling: ${esc(snap.ceiling_reason)}</div>` : "";
  return `<div class="health" style="margin-bottom:8px">
    ${spendMetric("est. spend (day)", met.usd, usd)}
    ${spendMetric("tokens (day)", met.tokens, int)}
    ${spendMetric("subagent spawns (day)", met.spawns, int)}
    ${spendMetric("concurrent children", met.concurrent_children, int)}
    ${killPill}
    <span class="hpill"><b>as of</b>${esc(snap.day || "—")}</span>
  </div>${ceilNote}
  <p class="muted">Estimated (the gateway doesn't surface exact usage); the spawn/concurrency caps + kill-switch are exact. A SPEND brake only — orthogonal to the DRAFT-ONLY posting lock.</p>`;
}

// ── CONTENT default-promotion view (read-only; approval is a HUMAN CLI action) ─
function defaultsPills(cd: ContentDefaultsFile | undefined): string {
  const d = cd?.defaults || {};
  const p = (cd?.promotion || {}) as Record<string, unknown>;
  const pill = (k: string, v: unknown) => (v == null || v === "" ? "" : `<span class="hpill"><b>${esc(k)}</b>${esc(v)}</span>`);
  const rel = p.min_rel_improvement != null ? `${Number(p.min_rel_improvement) * 100}%` : "—";
  const policy = `min sample ${n(p.min_sample)} · +${n(p.min_abs_improvement_pp)}pp abs · +${rel} rel · metric ${esc(p.metric || "median_eng_rate")}`;
  return `<div class="health" style="margin-bottom:10px">
    ${pill("narration default", d.narration)}
    ${pill("ending default", d.ending)}
    <span class="hpill"><b>promotion policy</b>${esc(policy)}</span>
  </div>`;
}

function proposalCard(p: PromotionProposal): string {
  const metric = p.metric || "median_eng_rate";
  const chal = (p.challenger || {}) as Record<string, unknown>;
  const inc = (p.incumbent || {}) as Record<string, unknown>;
  const chalM = chal[metric];
  const incM = inc[metric];
  const rel = p.delta_rel == null ? "∞" : `${(Number(p.delta_rel) * 100).toFixed(1)}%`;
  const conf = (p.confidence || "").toLowerCase();
  const confCls = conf === "high" ? "c-ok" : conf === "medium" ? "c-warn" : "c-idle";
  // READ-ONLY: the exact HUMAN commands are shown as copyable text, NOT buttons —
  // this dashboard never approves/applies anything (guardrail-locked by a test).
  const approveCmd = `sffs_promote_default --approve ${p.id}`;
  const rejectCmd = `sffs_promote_default --reject ${p.id} --reason "…"`;
  return `<div class="vid">
    <div class="vid-h">
      <div><span class="dim">${esc(p.dimension)}</span> <span class="arm">→ ${esc(p.recommended_default)}</span></div>
      <span class="chip ${confCls}">${esc(p.confidence || "?")} confidence</span>
    </div>
    <div class="rationale">
      current default <code>${esc(p.current_default)}</code> → proposed <code>${esc(p.recommended_default)}</code>
      · ${esc(metric)} ${incM != null ? esc(incM) + "%" : "—"} (control) → ${chalM != null ? esc(chalM) + "%" : "—"} (arm)
      · <b>+${n(p.delta_abs_pp)}pp</b> / +${esc(rel)}
      · n=${n((chal as any).n_with_metrics)}/${n((inc as any).n_with_metrics)} (min ${n(p.min_sample)})
    </div>
    ${p.rationale ? `<div class="cap">${esc(p.rationale)}</div>` : ""}
    <div class="cap"><b>human approve:</b> <code>${esc(approveCmd)}</code></div>
    <div class="cap"><b>human reject:</b> <code>${esc(rejectCmd)}</code></div>
  </div>`;
}

function defaultPromotions(q: ProposalsQueue | undefined, cd: ContentDefaultsFile | undefined): string {
  const all = Array.isArray(q?.proposals) ? (q!.proposals as PromotionProposal[]) : [];
  const pending = all.filter((p) => p.status === "pending");
  const head = defaultsPills(cd);
  if (!pending.length) {
    return `${head}<p class="muted">No pending default changes. When an A/B test arm clearly beats the current default (control) on the configured metric with enough samples, a proposal appears here for a human to approve/reject via the <code>sffs_promote_default</code> CLI. The loop never flips a default on its own.</p>`;
  }
  const cards = pending.map(proposalCard).join("");
  return `${head}<p class="muted">${pending.length} proposal(s) awaiting a HUMAN decision. Approving flips the config default (takes effect next design pass); rejecting keeps the arm testing. Display-only — run the CLI in a shell.</p>${cards}`;
}

function logStream(runId: string | null, items: any[]): string {
  if (!runId) return "";
  const filtered = items.filter((r) => r.level === "decision" || r.level === "gate" || r.level === "error");
  if (!filtered.length) return `<p class="muted">No decision/gate log for ${esc(runId)} yet.</p>`;
  const rows = filtered
    .slice(-120)
    .reverse()
    .map((r) => `<div class="lg lg-${esc(r.level)}"><span class="lt">${esc((r.ts || "").slice(11, 19))}</span> <span class="ll">${esc(r.level)}</span> ${esc(r.msg)}</div>`)
    .join("");
  return `<div class="logbox">${rows}</div>`;
}

// ── CODE-PR VIEW (software factory) ───────────────────────────────────────────
function ciChip(ci: PRRow["ci"]): string {
  const cls = ci.status === "PASS" ? "c-ok" : ci.status === "FAIL" ? "c-no" : ci.status === "PENDING" ? "c-run" : "c-idle";
  const label = ci.status === "NONE" ? "no checks" : ci.status.toLowerCase();
  const count = ci.checks.length ? ` (${ci.checks.filter((c) => c.result === "PASS").length}/${ci.checks.length})` : "";
  return `<span class="chip ${cls}">CI: ${esc(label)}${esc(count)}</span>`;
}
function verdictChip(v: string, kind: "review" | "harness" | "gate"): string {
  const up = String(v || "?").toUpperCase();
  const ok = up === "APPROVE" || up === "GREEN" || up === "MERGE";
  const bad = up === "REJECT" || up === "RED" || up === "REFUSE";
  const cls = ok ? "c-ok" : bad ? "c-no" : up === "SKIPPED" ? "c-idle" : "c-warn";
  const prefix = kind === "review" ? "review" : kind === "harness" ? "tests" : "gate";
  return `<span class="chip ${cls}">${prefix}: ${esc(up)}</span>`;
}

function prRowHtml(r: PRRow): string {
  const stateCls = r.state === "MERGED" ? "c-ok" : r.state === "OPEN" ? "c-run" : "c-idle";
  const gate = r.gate.matched ? (r.gate as GateAttempt & { matched: true }) : null;
  const reviewChip = gate ? verdictChip(gate.review, "review") : `<span class="chip c-idle">review: —</span>`;
  const harnessChip = gate ? verdictChip(gate.harness, "harness") : "";
  const gateChip = gate ? verdictChip(gate.decision, "gate") : "";
  const diffstat =
    r.additions != null || r.deletions != null
      ? `<span class="muted">+${n(r.additions)}/-${n(r.deletions)} · ${n(r.changedFiles)} files</span>`
      : "";
  const reasons = gate?.reasons?.length
    ? `<details><summary>gate reasons (${gate.reasons.length})</summary><ul class="qs">${gate.reasons.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></details>`
    : "";
  const ghReview = r.reviewDecision ? `<span class="muted"> · gh review: ${esc(r.reviewDecision)}</span>` : "";
  return `<div class="vid">
    <div class="vid-h">
      <div><a href="${esc(r.url)}" target="_blank" rel="noopener"><b>#${esc(r.number)}</b></a> ${esc(r.title)}${r.isDraft ? ' <span class="draft">draft PR</span>' : ""}</div>
      <span class="chip ${stateCls}">${esc(r.state)}</span>
    </div>
    <div class="rationale"><code>${esc(r.headRefName)}</code> → <code>${esc(r.baseRefName)}</code> ${diffstat}${ghReview}
      ${r.mergedAt ? `<span class="muted"> · merged ${esc(r.mergedAt)}</span>` : r.createdAt ? `<span class="muted"> · opened ${esc(r.createdAt)}</span>` : ""}</div>
    <div class="gates">${ciChip(r.ci)} ${reviewChip} ${harnessChip} ${gateChip}
      ${gate?.merge_commit ? `<span class="b b-na">merge ${short(gate.merge_commit)}</span>` : ""}
      ${gate ? "" : '<span class="b b-na">no gate record for this branch</span>'}</div>
    ${reasons}
  </div>`;
}

function ledgerOnlyHtml(attempts: GateAttempt[]): string {
  if (!attempts.length) return "";
  const rows = attempts
    .map(
      (a) => `<tr>
      <td><code>${esc(a.source || "—")}</code> → <code>${esc(a.target || "—")}</code></td>
      <td>${verdictChip(a.harness, "harness")}</td>
      <td>${verdictChip(a.review, "review")}</td>
      <td>${verdictChip(a.decision, "gate")}</td>
      <td>${a.merged ? '<span class="chip c-ok">merged</span>' : '<span class="chip c-idle">no</span>'}</td>
      <td class="muted">${esc(a.ts || "")}</td>
    </tr>`,
    )
    .join("");
  return `<h3 style="margin-top:16px">Gate attempts with no matching open/merged PR</h3>
    <table class="tbl"><thead><tr><th>merge</th><th>tests</th><th>review-agent</th><th>gate</th><th>merged</th><th>at</th></tr></thead>
    <tbody>${rows}</tbody></table>`;
}

function prView(pv: PRView): string {
  const head = `<p class="muted">repo: ${esc(pv.repo)} · open ${pv.counts.open} · merged ${pv.counts.merged} · gate records ${pv.counts.ledger}</p>`;
  if (!pv.gh_available && !pv.rows.length && !pv.ledgerOnly.length) {
    return `${head}<div class="reject">GitHub CLI (\`gh\`) not available or not authenticated${pv.error ? `: ${esc(pv.error)}` : ""}. The PR view shows the software factory's open + merged PRs with each PR's review-agent verdict + CI status; it needs a read-only \`gh\` login (or set SFFS_GH_REPO). The gate ledger view still works from ${esc("scripts/gate/logs/auto_merge.log")} when present.</div>`;
  }
  const errNote = pv.error ? `<div class="reject">gh warning: ${esc(pv.error)}</div>` : "";
  const rows = pv.rows.length ? pv.rows.map(prRowHtml).join("") : `<p class="muted">No open or merged PRs found for this repo yet.</p>`;
  return `${head}${errNote}${rows}${ledgerOnlyHtml(pv.ledgerOnly)}`;
}

// ── kill-switch banner ────────────────────────────────────────────────────────
function killBanner(k: KillSwitchState): string {
  if (k.engaged) {
    return `<div class="kill kill-on">⛔ FACTORY KILL-SWITCH ENGAGED — auto-merge halted. Sources: ${esc(k.sources.join(", "))}</div>`;
  }
  return `<div class="kill kill-off">✅ kill-switch clear — factory auto-merge is armed (two-key gate). Display-only indicator.</div>`;
}

// ── the page ──────────────────────────────────────────────────────────────────
export interface PageData {
  latest: RunState | null;
  runs: RunState[];
  db: any;
  l: any;
  bank: BankStats;
  schedule: Schedule;
  kill: KillSwitchState;
  disk: string;
  selected: string | null;
  pr: PRView;
  logItems: any[];
  /** default-promotion queue + current content defaults (optional; degrades to empty). */
  proposals?: ProposalsQueue;
  defaults?: ContentDefaultsFile;
  /** question-bank coverage + days-of-runway (optional; degrades to empty). */
  coverage?: BankCoverage;
  /** cost-governor spend snapshot (optional; degrades to "no snapshot"). */
  snapshot?: any;
}

export function page(opts: PageData): string {
  const { runs, db, l, bank, schedule, kill, disk, selected, pr, logItems } = opts;
  const cov: BankCoverage =
    opts.coverage ?? { total: 0, usable: bank.usable, fresh: bank.fresh, used: bank.used, freshPct: 0, perDay: 0, runwayDays: null, byType: [] };
  const cur = selected ? runs.find((r) => r.run_id === selected) || opts.latest : opts.latest;
  const s = cur?.summary || { planned: 0, drafted: 0, rejected: 0, failed: 0 };
  const drafts = (cur?.videos || []).filter((v) => v.status === "drafted");
  const draftTotal = drafts.reduce((a, v) => a + (v.publer?.post_ids?.length || 0), 0);
  const runOpts = runs
    .map((r) => `<option value="${esc(r.run_id)}" ${r.run_id === cur?.run_id ? "selected" : ""}>${esc(r.run_id)} · ${esc(r.status)} · ${r.summary?.drafted ?? 0} drafts</option>`)
    .join("");
  const videos = (cur?.videos || []).map(videoCard).join("") || `<p class="muted">No batch designed yet for this run.</p>`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Hermes-Nous · SFFS draft-only loop (read-only)</title>
<style>
:root{--ink:#000;--paper:#fff;--blue:#839aff;--mint:#c6fcd0;--coral:#fd7962;--yellow:#fce552;--cream:#f6f4ee;--green:#63c088}
*{box-sizing:border-box}
body{margin:0;background:var(--cream);color:var(--ink);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif}
a{color:#1b3bd1}
header{background:var(--blue);border-bottom:5px solid var(--ink);padding:18px 22px;display:flex;flex-wrap:wrap;gap:14px;align-items:center;justify-content:space-between}
header h1{margin:0;font:800 24px/1 "Segoe UI",sans-serif;letter-spacing:.5px}
.tag{background:var(--ink);color:var(--yellow);padding:4px 10px;border-radius:6px;font-weight:800;font-size:12px;letter-spacing:1px}
.tag.ro{background:#0d0d0d;color:var(--mint)}
.wrap{max-width:1120px;margin:0 auto;padding:22px}
.kill{max-width:1120px;margin:16px auto 0;padding:12px 18px;border:4px solid var(--ink);border-radius:14px;font-weight:800;box-shadow:6px 6px 0 0 var(--ink)}
.kill-on{background:var(--coral);color:#fff}
.kill-off{background:var(--green)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:14px;margin-bottom:22px}
.kpi{background:var(--paper);border:4px solid var(--ink);border-radius:16px;box-shadow:8px 8px 0 0 var(--ink);padding:16px}
.kpi .v{font:800 34px/1 "Segoe UI",sans-serif}
.kpi .k{font-size:12px;text-transform:uppercase;letter-spacing:1px;color:#444;margin-top:6px}
.card{background:var(--paper);border:4px solid var(--ink);border-radius:18px;box-shadow:8px 8px 0 0 var(--ink);padding:20px;margin-bottom:22px}
.card h2{margin:0 0 14px;font-size:20px;display:flex;gap:10px;align-items:center}
.card h2 .pin{background:var(--coral);border:3px solid var(--ink);border-radius:8px;padding:2px 8px;font-size:12px;font-weight:800}
.card h2 .pin.pr{background:var(--yellow)}
.vid{border:3px solid var(--ink);border-radius:14px;padding:14px;margin-bottom:14px;background:var(--cream)}
.vid-h{display:flex;justify-content:space-between;align-items:center;gap:10px}
.dim{font-weight:800;font-size:17px}.arm{color:#555}
.rationale{color:#333;margin:6px 0 10px;font-size:14px}
.rationale code{background:#eee;border:1px solid #ccc;border-radius:5px;padding:1px 5px;font-size:12px}
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
code{font:12px/1.4 ui-monospace,Menlo,monospace}
</style></head>
<body>
<header>
  <h1>HERMES-NOUS <span class="tag">DRAFT-ONLY</span> <span class="tag ro">READ-ONLY</span></h1>
  <div id="health" class="health"><span class="hpill">checking health…</span></div>
</header>
${killBanner(kill)}
<div class="wrap">
  <div class="grid">
    <div class="kpi"><div class="v">${s.planned}</div><div class="k">planned</div></div>
    <div class="kpi"><div class="v">${s.drafted}</div><div class="k">videos drafted</div></div>
    <div class="kpi"><div class="v">${draftTotal}</div><div class="k">publer drafts</div></div>
    <div class="kpi"><div class="v">${s.rejected}</div><div class="k">rejected (gates)</div></div>
    <div class="kpi"><div class="v">${bank.fresh}</div><div class="k">fresh questions</div></div>
    <div class="kpi"><div class="v">${cov.runwayDays == null ? "—" : cov.runwayDays}</div><div class="k">days runway</div></div>
  </div>

  <div class="card">
    <h2><span class="pin">RUN</span> Cycle status
      <form class="runsel" method="get" style="margin-left:auto">
        <label for="run">run:</label>
        <select id="run" name="run" onchange="this.form.submit()">${runOpts || `<option>none</option>`}</select>
      </form>
    </h2>
    <div class="health" style="margin-bottom:12px">
      <span class="hpill"><b>last run</b>${schedule.last ? `${esc(schedule.last.run_id)} · ${esc(schedule.last.status)} · ${esc(schedule.last.drafted)} drafts` : "none yet"}</span>
      <span class="hpill"><b>last at</b>${schedule.last?.at ? esc(schedule.last.at) : "—"}</span>
      <span class="hpill"><b>next run (${esc(schedule.nextSource)})</b>${esc(schedule.next)}</span>
    </div>
    <p>${cur ? `<b>${esc(cur.run_id)}</b> · ${statusChip(cur.status)} · started ${esc(cur.started_at)} · updated ${esc(cur.updated_at)}${cur.finished_at ? " · finished " + esc(cur.finished_at) : ""}` : "No runs yet. The cron (sffs-nightly) will create the first cycle, or run it manually."}</p>
    ${cur?.do_not_touch?.captured_at ? `<p class="muted">do-not-touch snapshot: ${cur.do_not_touch.scheduled_ids.length} scheduled + ${cur.do_not_touch.published_ids.length} published captured @ ${esc(cur.do_not_touch.captured_at)} — the loop verifies these are untouched after every cycle.</p>` : ""}
    ${cur?.errors?.length ? `<div class="reject">run errors: ${esc(cur.errors.join(" | "))}</div>` : ""}
  </div>

  <div class="card">
    <h2><span class="pin">BANK</span> Question-bank coverage &amp; days-of-runway</h2>
    ${bankCoverageCard(cov)}
  </div>

  <div class="card">
    <h2><span class="pin">A/B</span> Designed batch &amp; quality gates</h2>
    ${videos}
  </div>

  <div class="card">
    <h2><span class="pin pr">CODE</span> Software-factory PRs · review-agent verdict + test status</h2>
    ${prView(pr)}
  </div>

  <div class="card">
    <h2><span class="pin">SPEND</span> Cost governor — daily spend vs ceilings</h2>
    ${spendPanel(opts.snapshot)}
  </div>

  <div class="card">
    <h2><span class="pin">DATA</span> A/B results — analytics per post</h2>
    ${analyticsTable(db)}
  </div>

  <div class="card">
    <h2><span class="pin">MAP</span> Published posts — permalinks &amp; native ids (reconciled)</h2>
    ${publishedMap(db)}
  </div>

  <div class="card">
    <h2><span class="pin">LEARN</span> Front-runners &amp; variant-family rollups</h2>
    ${frontRunners(l)}
    ${rollupTable(l)}
  </div>

  <div class="card">
    <h2><span class="pin">ARM</span> Per-arm A/B leaderboard</h2>
    ${armLeaderboard(l)}
  </div>

  <div class="card">
    <h2><span class="pin">GATE</span> Pending default changes <span class="pin" style="background:var(--mint)">HUMAN-APPROVED</span></h2>
    ${defaultPromotions(opts.proposals, opts.defaults)}
  </div>

  <div class="card">
    <h2><span class="pin">LOG</span> Learnings &amp; decisions</h2>
    ${decisionsList(l)}
  </div>

  <div class="card">
    <h2><span class="pin">TRACE</span> Loop decision/gate stream — ${esc(cur?.run_id || "—")}</h2>
    ${logStream(cur?.run_id || null, logItems)}
  </div>

  <div class="foot">
    next run: ${esc(schedule.next)} · disk: ${esc(disk)} · auto-refresh 60s ·
    read-only supervisor — the loop can ONLY create Publer drafts; going live + merging code are human actions.
  </div>
</div>
<script>
(async function(){
  try{
    const r = await fetch('/api/health',{headers:{'accept':'application/json'}});
    const h = await r.json();
    const el = document.getElementById('health');
    const llm = h.llm && h.llm.ok ? '<span class="hpill" style="background:var(--green)"><b>LLM</b>ok · '+ (h.llm.model||'') +'</span>'
      : '<span class="hpill" style="background:'+(h.llm && h.llm.configured===false?'#e5e5e5':'var(--coral)')+';color:'+(h.llm && h.llm.configured===false?'#000':'#fff')+'"><b>LLM</b>'+ (h.llm && h.llm.detail ? String(h.llm.detail).slice(0,42) : 'down') +'</span>';
    const kill = h.kill && h.kill.engaged
      ? '<span class="hpill" style="background:var(--coral);color:#fff"><b>kill-switch</b>ENGAGED</span>'
      : '<span class="hpill" style="background:var(--green)"><b>kill-switch</b>clear</span>';
    el.innerHTML = llm + kill
      + '<span class="hpill"><b>next run</b>'+ (h.schedule?String(h.schedule.next).slice(0,32):'?') +'</span>'
      + '<span class="hpill"><b>disk</b>'+ (h.disk||'?') +'</span>'
      + '<span class="hpill"><b>server</b>'+ new Date().toISOString().slice(11,19) +'Z</span>';
  }catch(e){ document.getElementById('health').innerHTML='<span class="hpill" style="background:var(--coral);color:#fff">health check failed</span>'; }
})();
setTimeout(()=>location.reload(), 60000);
</script>
</body></html>`;
}
