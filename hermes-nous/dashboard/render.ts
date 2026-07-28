/**
 * render.ts — pure HTML rendering for the dashboard (data in → HTML string out).
 *
 * Reuses the visual language of the current live dashboard (hermes/src/dashboard.ts):
 * the neobrutalist card style, KPI grid, gate badges, status chips, and analytics
 * tables — so this reads as the same product. Adds two things the rebuilt agent
 * needs: an explicit last/next-run schedule, and the
 * CODE-PR VIEW (software-factory PRs + review-agent verdict + test status).
 *
 * Every function is PURE and escapes all interpolated data. There is NO form,
 * button, or link here that posts, schedules, publishes, or merges anything —
 * this is a display-only surface (guardrail-locked by a test).
 */
import type { RunState, VideoPlan, GateAttempt, PRRow, PromotionProposal, ProposalsQueue, ContentDefaultsFile } from "./types.ts";
import type { KillSwitchState, Schedule, BankStats, BankCoverage, ScheduledView, ReplicationView } from "./data.ts";
import { summarizeExperiment } from "./data.ts";
import type { PRView } from "./prs.ts";
import { computeGoalProgress, GOAL, type GoalProgress, type ScopeProgress, type GoalMetric, type FollowerMetric, type ArmAgg } from "./goal.ts";

// ── html helpers ──────────────────────────────────────────────────────────────
export const esc = (s: unknown): string =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const n = (v: unknown): string => (v === null || v === undefined || v === "" ? "—" : String(v));
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
  // Metricool exposes no stable per-post URL for an unpublished post, so show the
  // planner uuids as PLAIN TEXT rather than a dead deep-link.
  const posts = (v.metricool?.uuids || []).map((id) => esc(id)).join(", ");
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
    <div class="vid-f">${media} ${posts ? `<span class="pub">metricool: ${posts}</span>` : ""}</div>
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
  return `<div class="tblwrap"><table class="tbl">
    <thead><tr><th>platform</th><th>experiment</th><th>reach</th><th>views</th><th>reactions</th><th>comments</th><th>shares</th><th>eng</th><th>as of</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
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
  return `<div class="tblwrap"><table class="tbl"><thead><tr><th>variant family</th><th>posts</th><th>w/ metrics</th><th>median eng</th><th>avg reach</th></tr></thead><tbody>${rows}</tbody></table></div>`;
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
  ${cov.byType.length ? `<div class="tblwrap"><table class="tbl"><thead><tr><th>question type</th><th>usable</th><th>fresh</th></tr></thead><tbody>${rows}</tbody></table></div>` : `<p class="muted">No question-bank entries found.</p>`}
  <p class="muted" style="margin-top:8px">Runway = fresh usable questions ÷ est. burn (${n(cov.perDay)}/day). The near-dup + type-spread guards keep variety; this flags a TYPE running low.</p>
  <p class="muted" style="margin-top:6px"><b>Used-set (honest):</b> reconciled from the usage ledger + the loop's dedup set + every recovered run-state video's exact question sigs (self-heals as new cycles record sigs). <b>Residual uncertainty:</b> the prior usage ledger was partly lost on the box rebuild, and the scheduler stores captions/metrics — never our internal question sigs — so a handful of pre-recovery posts can't be sig-matched. "Used" is therefore a floor and fresh/runway an upper bound (bounded well under ±10% of the ${n(cov.usable)}-question usable pool).</p>`;
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
    <div class="tblwrap"><table class="tbl"><thead><tr><th>#</th><th>arm</th><th>posts</th><th>w/ metrics</th><th>median eng</th><th>avg reach</th></tr></thead><tbody>${rows}</tbody></table></div>`;
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
  return `<p class="muted">${pub.length} published/reconciled post(s). Native id + permalink + posted_at are back-filled by <code>reconcile</code> (matching metricool_uuid → the published post).</p>
    <div class="tblwrap"><table class="tbl"><thead><tr><th>platform</th><th>posted at</th><th>permalink</th><th>arm</th><th>native id</th><th>eng</th></tr></thead><tbody>${rows}</tbody></table></div>`;
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
    ? `<span class="hpill" style="background:#dbe6ff;color:#122a5c;border-color:#122a5c"><b>status</b>paused (maintenance)${kill.reason ? " · " + esc(String(kill.reason).slice(0, 40)) : ""}</span>`
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

/** The reversible autonomous promotion/revert ledger (proposals.json auto_ledger). */
function autoLedgerHtml(q: ProposalsQueue | undefined): string {
  const led: any[] = Array.isArray((q as any)?.auto_ledger) ? (q as any).auto_ledger : [];
  if (!led.length) {
    return `<div class="gscope-h" style="margin-top:14px"><span class="gscope-t">Autonomous promotion ledger</span> <span class="muted">reversible · auto-revert on underperformance</span></div>
      <p class="muted">Ledger empty — no autonomous promotion yet. When an A/B winner clears the stricter auto-gate AND survives a confirmation round of fresh matured samples, Hermes auto-adopts it here (reversible); a promoted default that later underperforms the arm it replaced is auto-reverted. Every promote + revert is logged below.</p>`;
  }
  const rows = led.slice().reverse().slice(0, 30).map((e) => {
    const isRevert = e.action === "auto-revert";
    const cls = isRevert ? "c-warn" : "c-ok";
    const state = e.action === "auto-promote"
      ? (e.active ? '<span class="chip c-ok">active</span>' : '<span class="chip c-idle">reverted</span>')
      : '<span class="chip c-warn">reverted</span>';
    const evidence = e.delta_abs_pp != null
      ? `+${esc(String(e.delta_abs_pp))}pp${e.confirmed_new_samples != null ? ` · confirmed +${esc(String(e.confirmed_new_samples))} samples` : ""}`
      : (e.m_promoted != null ? `${esc(String(e.m_promoted))}% vs ${esc(String(e.m_previous))}%` : "");
    return `<tr><td>${esc(String(e.ts || e.date || "").slice(0, 19).replace("T", " "))}</td><td><span class="chip ${cls}">${esc(String(e.action))}</span></td><td>${esc(String(e.dimension))}</td><td><code>${esc(String(e.from))}</code> → <code>${esc(String(e.to))}</code></td><td class="muted">${evidence}</td><td>${state}</td></tr>`;
  }).join("");
  return `<div class="gscope-h" style="margin-top:14px"><span class="gscope-t">Autonomous promotion ledger</span> <span class="muted">reversible · auto-revert on underperformance</span></div>
    <div class="tblwrap"><table class="tbl"><thead><tr><th>when</th><th>action</th><th>dimension</th><th>change</th><th>evidence</th><th>state</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function defaultPromotions(q: ProposalsQueue | undefined, cd: ContentDefaultsFile | undefined): string {
  const all = Array.isArray(q?.proposals) ? (q!.proposals as PromotionProposal[]) : [];
  const pending = all.filter((p) => p.status === "pending");
  const head = defaultsPills(cd);
  const autoOn = Boolean((cd as any)?.auto_promotion?.enabled);
  const autoNote = `<p class="muted">Autonomous promotion: <b>${autoOn ? "ON" : "OFF"}</b> — a clear A/B winner is auto-adopted ONLY after a confirmation round of fresh matured samples (stricter min_sample than the human gate), every change is logged to the reversible ledger below, and a promoted default that later underperforms the arm it replaced is AUTO-REVERTED. Humans can still approve / reject / override via the <code>sffs_promote_default</code> CLI. Content-only: a promotion flips a whitelisted arm label and NEVER changes posting cadence or the hard guardrails.</p>`;
  const pendingHtml = !pending.length
    ? `<p class="muted">No pending default changes awaiting a human. When an A/B test arm clearly beats the current default (control) on the configured metric with enough samples, a proposal appears here to approve/reject via the <code>sffs_promote_default</code> CLI — or (if enabled) it is auto-adopted after a confirmation round.</p>`
    : `<p class="muted">${pending.length} proposal(s) awaiting a HUMAN decision (auto-adoption still requires a confirmation round). Approving flips the config default (takes effect next design pass); rejecting keeps the arm testing. Display-only — run the CLI in a shell.</p>${pending.map(proposalCard).join("")}`;
  return `${head}${autoNote}${pendingHtml}${autoLedgerHtml(q)}`;
}

// ── REPLICATE: doubling down on a reach outlier ──────────────────────────────

/**
 * The winner-replication panel. Purely a READ of ab-testing/replication.json — the
 * detector, escalation and revert all live in replicate.py on the box; nothing here
 * can open or close a round. The share is always shown against the exploration cap,
 * because "how much of the batch is NOT exploring" is the number that matters.
 */
function replicatePanel(r: ReplicationView | undefined): string {
  if (!r) return `<p class="muted">No replication state yet.</p>`;
  if (!r.enabled) {
    return `<p class="muted">Winner replication is <b>OFF</b> (<code>replication.enabled=false</code> in content-defaults.json). The designer is exploring the full A/B rotation.</p>`;
  }
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const why = `<p class="muted">Reach outliers are what a 500K-view goal actually rides on, and the eng_rate promotion gate cannot see one: a post can 3x the pack on views with an ordinary engagement rate. This engine detects that, holds the winning STYLE constant while varying only secondary knobs (so a repeat win is attributable), then escalates or reverts once the replicas mature. The share can never exceed <b>${pct(r.share_cap)}</b> — an exploration floor, so the loop never stops sampling new styles. Every change is reversible: <code>sffs_replicate --revert</code>.</p>`;

  if (!r.active) {
    const hist = replicateHistory(r);
    return `${why}<p class="muted">No style is being replicated right now — the batch is 100% exploration. A round opens when a style beats its platform's rolling median reach by the configured ratio (<code>sffs_replicate --detect</code>, run by the loop).</p>${hist}`;
  }

  const fp = r.fingerprint || {};
  const ev = r.evidence || {};
  const samples = Array.isArray(ev.samples) ? ev.samples : [];
  const sampleRows = samples
    .map((s: any) => `<tr><td>${esc(s.platform)}</td><td class="num">${esc(Math.round(Number(s.value) || 0))}</td><td class="num">${esc((Number(s.ratio) || 0).toFixed(2))}x</td><td class="mono">${esc(String(s.key || "").slice(0, 44))}</td></tr>`)
    .join("");
  const replicaRows = (r.replicas || [])
    .map((s: any) => `<tr><td>${esc(s.platform)}</td><td class="num">${esc(Math.round(Number(s.value) || 0))}</td><td class="num">${esc((Number(s.ratio) || 0).toFixed(2))}x</td><td class="mono">${esc(String(s.key || "").slice(0, 44))}</td></tr>`)
    .join("");
  const baselines = ev.baselines && typeof ev.baselines === "object"
    ? Object.entries(ev.baselines).map(([k, v]: [string, any]) => `${esc(k)} median ${esc(Math.round(Number(v?.median) || 0))} (n=${esc(v?.n ?? 0)})`).join(" · ")
    : "—";

  return `${why}
  <div class="health" style="margin-bottom:12px">
    <span class="hpill" style="background:var(--green)"><b>replicating</b>${esc(fp.lead_type || r.key || "?")}</span>
    <span class="hpill"><b>share</b>${pct(r.share)} of each batch (cap ${pct(r.share_cap)})</span>
    <span class="hpill"><b>round</b>${esc(r.round ?? 1)} · ${esc(r.status || "active")}</span>
    <span class="hpill"><b>confidence</b>${esc(r.confidence || "—")}</span>
    <span class="hpill"><b>next check</b>${esc(String(r.evaluate_after || "—").slice(0, 16).replace("T", " "))}Z</span>
  </div>
  <p><b>Style held constant:</b> lead question type <code>${esc(fp.lead_type || "?")}</code> · ${esc(fp.num_questions ?? "?")} question(s) · family <code>${esc(fp.family || "?")}</code> · narration <code>${esc(fp.narration || "?")}</code> · ending <code>${esc(fp.ending || "?")}</code></p>
  <p class="muted"><b>Varying only:</b> ${(r.vary_only || []).map((k) => `<code>${esc(k)}</code>`).join(" · ") || "—"} — everything else is pinned so a repeat win is attributable to the style.</p>
  <p class="muted"><b>Baselines at detection:</b> ${baselines}</p>
  ${sampleRows ? `<h3 style="margin:14px 0 6px;font-size:15px">Evidence that opened the round</h3>
  <table class="tbl"><thead><tr><th>platform</th><th class="num">reach</th><th class="num">vs median</th><th>post</th></tr></thead><tbody>${sampleRows}</tbody></table>` : ""}
  ${replicaRows ? `<h3 style="margin:14px 0 6px;font-size:15px">Replicas so far</h3>
  <table class="tbl"><thead><tr><th>platform</th><th class="num">reach</th><th class="num">vs median</th><th>post</th></tr></thead><tbody>${replicaRows}</tbody></table>` : `<p class="muted">No replica has matured yet — the round is judged after the maturity window.</p>`}
  ${replicateHistory(r)}`;
}

function replicateHistory(r: ReplicationView): string {
  if (!r.history?.length) return "";
  const rows = r.history
    .map((h: any) => `<div class="lg"><span class="lt">${esc(String(h.ts || "").slice(0, 16).replace("T", " "))}</span> <span class="ll">${esc(h.event || "?")}</span> ${esc(
      [h.key, h.reason, h.from_share != null ? `${Math.round(h.from_share * 100)}%→${Math.round((h.to_share ?? 0) * 100)}%` : "", h.replica_median_ratio != null ? `${Number(h.replica_median_ratio).toFixed(2)}x` : ""]
        .filter(Boolean).join(" · ").slice(0, 150),
    )}</div>`)
    .join("");
  return `<h3 style="margin:14px 0 6px;font-size:15px">Reversible ledger</h3><div class="logbox">${rows}</div>`;
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
    <div class="tblwrap"><table class="tbl"><thead><tr><th>merge</th><th>tests</th><th>review-agent</th><th>gate</th><th>merged</th><th>at</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
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

// ── ALWAYS-ON software factory: live daemon status ───────────────────────────
function factoryStateChip(state: string): string {
  const s = String(state || "unknown");
  const cls =
    s === "running" ? "c-run"
    : s === "idle-no-goals" || s === "stopped" ? "c-idle"
    : s.startsWith("paused") || s === "error-backoff" ? "c-no"
    : "c-warn";
  return `<span class="chip ${cls}">${esc(s)}</span>`;
}
function factoryPanel(fs: any): string {
  if (!fs || typeof fs !== "object") {
    return `<p class="muted">No factory daemon status yet. The always-on daemon writes <code>factory-status.json</code> each cycle (goals generated, merges, refusals, spend vs cap, kill-switch). If this stays empty, the <code>factory-daemon</code> service may be stopped.</p>`;
  }
  const sp = fs.spend || {};
  const usd = (v: any) => `$${Number(v ?? 0).toFixed(2)}`;
  const int = (v: any) => Number(v ?? 0).toLocaleString("en-US");
  const t = fs.totals || {};
  const lc = fs.last_cycle || {};
  const kill = fs.kill_switch || {};
  const suite = fs.suite || {};
  const cad = fs.cadence || {};
  const killPill = kill.engaged
    ? `<span class="hpill" style="background:#dbe6ff;color:#122a5c;border-color:#122a5c"><b>status</b>paused (maintenance)${kill.reason ? " · " + esc(String(kill.reason).slice(0, 44)) : ""}</span>`
    : `<span class="hpill" style="background:var(--green)"><b>kill-switch</b>clear</span>`;
  const suitePill = `<span class="hpill" ${suite.verdict === "RED" ? 'style="background:var(--coral);color:#fff"' : suite.verdict === "GREEN" ? 'style="background:var(--green)"' : ""}><b>suite</b>${esc(suite.verdict || "?")}${suite.sha ? " · " + short(suite.sha) : ""}</span>`;
  const usdOver = sp.usd_cap && sp.usd >= sp.usd_cap;
  const head = `<div class="health" style="margin-bottom:10px">
    <span class="hpill"><b>state</b>${factoryStateChip(fs.state)}</span>
    <span class="hpill" style="max-width:340px"><b>reason</b>${esc(String(fs.state_reason || "—").slice(0, 70))}</span>
    <span class="hpill"><b>cycle</b>#${esc(fs.cycle)}</span>
    <span class="hpill"><b>hermes-nous tip</b>${short(fs.hermes_nous_tip)}</span>
    ${suitePill}
    ${killPill}
  </div>`;
  const spendRow = `<div class="health" style="margin-bottom:10px">
    <span class="hpill" ${usdOver ? 'style="background:var(--coral);color:#fff"' : ""}><b>spend today / $2k cap</b>${usd(sp.usd)} / ${usd(sp.usd_cap)}</span>
    <span class="hpill"><b>tokens / cap</b>${int(sp.tokens)} / ${int(sp.tokens_cap)}</span>
    <span class="hpill"><b>cadence</b>base ${esc(cad.base_sleep_s)}s · next ${esc(cad.next_sleep_s)}s${cad.backoff_s ? ` · backoff ${esc(cad.backoff_s)}s` : ""}</span>
    <span class="hpill"><b>as of (UTC)</b>${esc(String(fs.ts || "").slice(11, 19))}</span>
  </div>`;
  const totals = `<div class="health" style="margin-bottom:10px">
    <span class="hpill"><b>merged (total)</b>${esc(t.merged ?? 0)}</span>
    <span class="hpill"><b>refused (total)</b>${esc(t.refused ?? 0)}</span>
    <span class="hpill"><b>deferred (total)</b>${esc(t.deferred ?? 0)}</span>
    <span class="hpill"><b>cycles</b>${esc(t.cycles ?? 0)}</span>
    <span class="hpill"><b>no-merge streak</b>${esc(fs.consecutive_no_merge ?? 0)}</span>
  </div>`;
  const bl = fs.backlog || {};
  const backlogPills = Object.keys(bl).length
    ? `<div class="cap"><b>detected backlog (real signals, ranked):</b></div><div class="health" style="margin:6px 0 10px">${Object.entries(bl).map(([k, v]) => `<span class="hpill"><b>${esc(k)}</b>${esc(v)}</span>`).join("")}</div>`
    : "";
  const goals = Array.isArray(fs.recent_goals) && fs.recent_goals.length
    ? `<div class="cap"><b>goals generated this cycle:</b></div><ul class="qs">${fs.recent_goals.map((g: any) => `<li><b>${esc(g.kind)}</b> <span class="muted">score ${esc(g.score)}</span> — ${esc(g.text)}</li>`).join("")}</ul>`
    : `<p class="muted">No goals in the current batch (idle / backed off — nothing high-value pending).</p>`;
  const merged = Array.isArray(lc.merged) ? lc.merged : [];
  const refused = Array.isArray(lc.refused) ? lc.refused : [];
  const deferred = Array.isArray(lc.deferred) ? lc.deferred : [];
  const lastCycle = `<div class="cap" style="margin-top:8px"><b>last cycle #${esc(lc.cycle ?? "—")}</b> — ${merged.length} merged · ${refused.length} refused · ${deferred.length} deferred</div>
    <div style="margin-top:4px">
    ${merged.map((m: any) => `<span class="b b-ok" style="display:inline-block;margin:3px 4px 0 0">MERGE ${short(m.commit)} · ${esc(String(m.goal || "").split("helper ").pop())}</span>`).join("")}
    ${refused.map((m: any) => `<span class="b b-no" style="display:inline-block;margin:3px 4px 0 0">REFUSE · ${esc(String(m.reason || "").slice(0, 52))}</span>`).join("")}
    </div>`;
  const flag = fs.flag_flailing ? `<div class="reject">⚠ FLAG raised — the daemon auto-paused for attention (see FLAILING.flag on the box).</div>` : "";
  const howto = `<p class="muted">STOP instantly: <code>touch /home/ec2-user/hermes-data/FACTORY_STOP</code> (or env <code>SFFS_FACTORY_KILL=1</code>); resume by removing it. Every merge requires the TWO-KEY gate (tests GREEN + independent model review APPROVE); merges land on <code>hermes-nous</code> only; DRAFT-ONLY posting is never touched.</p>`;
  return `${head}${spendRow}${totals}${backlogPills}${goals}${lastCycle}${flag}${howto}`;
}

// ── SUPERVISOR panel (always-on continuous orchestrator; NON-posting) ─────────
function supervisorPanel(s: any): string {
  if (!s || typeof s !== "object") {
    return `<p class="muted">No supervisor status yet. The always-on continuous orchestrator writes <code>supervisor-status.json</code> each cycle (research · knowledge · content-prep · upkeep). If this stays empty, the <code>hermes-nous-supervisor</code> service may be stopped.</p>`;
  }
  const state = esc(String(s.state || "?"));
  const paused = s.kill_switch && s.kill_switch.engaged;
  const chip = paused
    ? `<span class="hpill" style="background:#dbe6ff;color:#122a5c;border-color:#122a5c"><b>state</b>paused (maintenance)</span>`
    : `<span class="chip ${/error/i.test(state) ? "c-no" : /idle/i.test(state) ? "c-idle" : "c-ok"}">${state}</span>`;
  const lastPills = s.last && typeof s.last === "object"
    ? Object.entries(s.last).map(([k, v]) => `<span class="hpill"><b>${esc(k)} last</b>${esc(String(v ? new Date(Number(v) * 1000).toISOString() : "—").slice(0, 16).replace("T", " "))}</span>`).join("")
    : "";
  const lastCycle = s.last_cycle && Array.isArray(s.last_cycle.did) && s.last_cycle.did.length
    ? `<div class="cap"><b>last cycle:</b> ran ${esc(s.last_cycle.did.join(", "))}${s.last_cycle.dry_run ? ' <span class="chip c-warn">dry-run</span>' : ""}</div>`
    : `<p class="muted">No work cycle recorded yet.</p>`;
  const bounded = `<p class="muted"><b>Continuous WORK, bounded POSTING:</b> this orchestrator runs research / knowledge-update / content-prep / upkeep on a converging, cost-governed cadence and <b>never posts or schedules</b>. The hard posting ceiling (≤12/day/platform, 7am–1am CST, jittered, quality-gated) is owned solely by the daily cycle — one scheduler, no double-firing. Coordinates with (does not duplicate) the software factory, which owns code self-improvement.</p>`;
  return `<div class="health" style="margin-bottom:10px">${chip}<span class="hpill"><b>cycle</b>${esc(String(s.cycle ?? 0))}</span>${lastPills}</div>${lastCycle}${bounded}`;
}

// ── Shared card helpers for the SCHEDULED / approval panels (READ-ONLY) ──────
function platformLabel(p: string): string {
  const s = String(p || "").toLowerCase();
  if (s === "instagram" || s === "ig" || s === "ig_business") return "Instagram";
  if (s === "tiktok") return "TikTok";
  return p ? esc(p) : "link";
}

/**
 * Prominent per-card scheduled date/time chip (shown on EVERY video card). Pass the
 * `scheduled_cst` string for a scheduled post; pass null/empty for a draft, which
 * renders a neutral "Not scheduled" state instead of a blank/empty chip.
 */
function scheduleChip(cst?: string | null): string {
  const has = typeof cst === "string" && cst.trim().length > 0;
  if (has) {
    // Time-only: the date/time itself makes it obvious this is the scheduled slot, so
    // the redundant "Scheduled ·" label is dropped. Context is preserved in the tooltip
    // (and the mint styling) for anyone hovering / using assistive tech.
    return `<div class="timechip" title="Scheduled to auto-publish at this time (America/Chicago)"><span class="tc-v">${esc(cst)}</span></div>`;
  }
  return `<div class="timechip timechip-none" title="This is a draft — it is not scheduled to publish"><span class="tc-v">Not scheduled</span></div>`;
}

/**
 * Inline preview for the scheduled/approval cards. Renders the FULL 9:16 frame (CSS
 * object-fit: contain — letterbox, never crop) inside a fixed 9:16 box, enhanced
 * client-side by Plyr (vendored locally).
 *
 * The media points DIRECTLY at static.metricool.com. There used to be a same-origin
 * /api/draft-media proxy here purely because Publer's CDN was Referer-gated and 403'd
 * off-origin; Metricool's is not (verified: HTTP 200 with no Referer, a hostile
 * Referer, and a foreign Origin), so the proxy was removed rather than left as a
 * standing open-proxy surface. `data.ts` still allowlists every url to that exact
 * host with no query string, so an S3 presigned url can never reach this page.
 */
export function cdnDirect(u: unknown): string | null {
  return typeof u === "string" && u.startsWith("https://static.metricool.com/") ? u : null;
}

function videoPreview(_videoKey: string, thumbnail: string | null, mediaUrl: string | null): string {
  const src = cdnDirect(mediaUrl);
  const posterSrc = cdnDirect(thumbnail);
  const posterAttr = posterSrc ? ` poster="${esc(posterSrc)}"` : "";
  if (src) {
    return `<video class="dvid" controls preload="metadata" playsinline${posterAttr}>
        <source src="${esc(src)}" type="video/mp4"/>
      </video>`;
  }
  if (posterSrc) {
    return `<img class="dthumb-img" loading="lazy" src="${esc(posterSrc)}" alt="preview"/>`;
  }
  return `<div class="dthumb-none">no preview</div>`;
}

/** Current promotable defaults (arm labels) the plain-language label reads so it can
 *  say what each video CHANGES vs the baseline. All optional; falls back to shipped. */
export interface AbDefaults { narration?: string; ending?: string; mascot?: string; }

const NARRATION_HUMAN: Record<string, string> = {
  "full": "full voiceover",
  "no-narration": "no voiceover (music only)",
  "no-question-vo": "only the options are read aloud",
  "no-options-vo": "only the question is read aloud",
};
const ENDING_HUMAN: Record<string, string> = {
  "cliffhanger": "cliffhanger (last answer withheld)",
  "full-reveal": "reveals every answer",
  "no-answer": "no answers revealed (comment for answer)",
};
// mascot-prominent is the CURRENT DEFAULT (defaults.ts: mascot: "mascot-prominent"), so
// both other arms have to read as departures FROM it. "standard" is the trap: it is the
// historical look, not today's baseline, and labelling it "standard mascot" next to a
// "(default: ...)" clause would tell the user the opposite of the truth while they approve.
const MASCOT_HUMAN: Record<string, string> = {
  "mascot-standard": "smaller mascot, its original size",
  "mascot-absent": "no mascot on screen at all",
  "mascot-prominent": "enlarged mascot",
};
/** Non-promotable single-axis dimensions: {category, what THIS video does, the default}. */
const OTHER_HUMAN: Record<string, { cat: string; change: string; def: string }> = {
  "progress-counter:progress-hidden": { cat: "Progress counter", change: "counter hidden", def: "counter shown" },
  "progress-counter:progress-verbose": { cat: "Progress counter", change: "verbose 'QUESTION 1 OF 3'", def: "short 'Q1'" },
  "tempo:tempo-fast": { cat: "Tempo", change: "fast 3s countdown", def: "5s" },
  "tempo:tempo-slow": { cat: "Tempo", change: "slow 7s countdown", def: "5s" },
  "length:one-question": { cat: "Length", change: "single question", def: "3 questions" },
  "category-mix:verbal-only": { cat: "Question mix", change: "verbal only (odd-one-out / analogy)", def: "mixed 3" },
  "category-mix:quant-only": { cat: "Question mix", change: "number-series only", def: "mixed 3" },
  "hook:hook-challenge": { cat: "Hook", change: "hard 'ONLY 1% PASS' opener", def: "neutral opener" },
  "type-nonverbal-shapes:shapes": { cat: "Question type", change: "nonverbal shapes (folding / matrices)", def: "mixed text" },
  "type-nonverbal-classic:classic-shapes": { cat: "Question type", change: "classic nonverbal figures", def: "mixed text" },
};

export interface AbLabel { kind: "test" | "control" | "unknown"; tag: string; text: string; }

/**
 * PLAIN-LANGUAGE A/B label for a draft/scheduled card: what THIS video changes + tests
 * vs the current default (e.g. "Narration: no voiceover (default: full voiceover)"),
 * "Control / current defaults" for the baseline, and a neutral "Unknown" when a post
 * can't be linked to a real arm — NEVER the LLM caption. The "default:" text is derived
 * from the LIVE promotable defaults so it stays honest after a promotion. Never fabricates.
 */
export function abTestLabel(dimension?: string, arm?: string, defaults?: AbDefaults): AbLabel {
  const NEUTRAL = new Set(["", "—", "unknown", "variant"]);
  const dim = String(dimension ?? "").trim();
  const a = String(arm ?? "").trim();
  const dLow = dim.toLowerCase();
  const aLow = a.toLowerCase();
  if (dLow === "control" || aLow === "control") return { kind: "control", tag: "Control", text: "current defaults" };
  if (NEUTRAL.has(dLow) && NEUTRAL.has(aLow)) return { kind: "unknown", tag: "Unknown", text: "not linked to a batch variant yet" };
  const def = defaults || {};
  if (dLow === "narration" && NARRATION_HUMAN[a]) {
    return { kind: "test", tag: "A/B", text: `Narration: ${NARRATION_HUMAN[a]} (default: ${NARRATION_HUMAN[def.narration || "full"] || "full voiceover"})` };
  }
  if (dLow === "ending" && ENDING_HUMAN[a]) {
    return { kind: "test", tag: "A/B", text: `Ending: ${ENDING_HUMAN[a]} (default: ${ENDING_HUMAN[def.ending || "cliffhanger"] || "cliffhanger"})` };
  }
  if (dLow === "mascot" && MASCOT_HUMAN[a]) {
    return { kind: "test", tag: "A/B", text: `Mascot: ${MASCOT_HUMAN[a]} (default: ${MASCOT_HUMAN[def.mascot || "mascot-prominent"] || "bigger mascot"})` };
  }
  const other = OTHER_HUMAN[`${dLow}:${aLow}`];
  if (other) return { kind: "test", tag: "A/B", text: `${other.cat}: ${other.change} (default: ${other.def})` };
  if (!NEUTRAL.has(dLow) && !NEUTRAL.has(aLow) && dim !== a) return { kind: "test", tag: "A/B", text: `${dim}: ${a}` };
  const only = !NEUTRAL.has(aLow) ? a : !NEUTRAL.has(dLow) ? dim : "";
  return only ? { kind: "test", tag: "A/B", text: only } : { kind: "unknown", tag: "Unknown", text: "not linked to a batch variant yet" };
}

/** Render the plain-language A/B label as a small tagged line for a card. */
function abLabelHtml(dimension: string, arm: string, defaults?: AbDefaults): string {
  const L = abTestLabel(dimension, arm, defaults);
  const cls = L.kind === "control" ? "ab-control" : L.kind === "unknown" ? "ab-unknown" : "ab-test";
  return `<div class="arm"><span class="abtag ${cls}">${esc(L.tag)}</span> ${esc(L.text)}</div>`;
}

// ── GOAL-PROGRESS (Hermes's 7-day mandate) — front-and-center ─────────────────
const gInt = (v: number | null | undefined): string =>
  v == null ? "—" : Math.round(v).toLocaleString("en-US");
/** compact rate: 1 decimal under 100, whole thousands above (honest, readable). */
function gPace(v: number | null): string {
  if (v == null) return "—";
  if (v <= 0) return "0";
  return v >= 100 ? Math.round(v).toLocaleString("en-US") : String(Math.round(v * 10) / 10);
}
function gPct(p: number | null): string {
  if (p == null) return "—";
  if (p <= 0) return "0%";
  if (p >= 10) return `${Math.round(p)}%`;
  if (p >= 1) return `${Math.round(p * 10) / 10}%`;
  return `${Math.round(p * 100) / 100}%`; // sub-1% cold-start: show 2dp so it isn't a fake 0
}
/** pure CSS/inline-style progress bar (no external assets). `good` tints it green. */
function gBar(pct: number | null, pending = false): string {
  const w = pending || pct == null ? 0 : Math.max(0, Math.min(100, pct));
  const cls = pct != null && pct >= 100 ? "gfill gfill-done" : "gfill";
  const inner = pending ? "" : `<i class="${cls}" style="width:${w.toFixed(2)}%"></i>`;
  return `<div class="gbar${pending ? " gbar-pending" : ""}">${inner}</div>`;
}
function gMetricRow(label: string, m: GoalMetric): string {
  return `<div class="gmetric">
    <div class="gm-h"><span class="gm-l">${esc(label)}</span><span class="gm-v">${gInt(m.value)} <span class="muted">/ ${gInt(m.target)}</span> · <b>${gPct(m.pct)}</b></span></div>
    ${gBar(m.pct)}
  </div>`;
}
function gFollowerRow(label: string, f: FollowerMetric): string {
  if (f.value == null) {
    return `<div class="gmetric">
      <div class="gm-h"><span class="gm-l">${esc(label)}</span><span class="gm-v"><span class="muted">pending / ${gInt(f.target)}</span></span></div>
      ${gBar(null, true)}
    </div>`;
  }
  return `<div class="gmetric">
    <div class="gm-h"><span class="gm-l">${esc(label)}</span><span class="gm-v">${gInt(f.value)} <span class="muted">/ ${gInt(f.target)}</span> · <b>${gPct(f.pct)}</b></span></div>
    ${gBar(f.pct)}
  </div>`;
}
/** observed-vs-needed pace pills; the "needed" pill goes coral when we're behind. */
function gPacePills(observed: number | null, needed: number | null, unit: string, armed: boolean): string {
  const neededTxt = needed == null ? "∞ (window closed)" : `${gPace(needed)}${needed > 0 ? "" : " (met ✓)"}`;
  const behind = needed != null && needed > 0 && (observed == null || observed < needed);
  const obsTxt = observed == null ? (armed ? "0" : "—") : gPace(observed);
  return `<span class="hpill"><b>${esc(unit)}/day observed</b>${esc(obsTxt)}</span>
    <span class="hpill${behind ? " alert" : ""}"><b>${esc(unit)}/day needed</b>${esc(neededTxt)}</span>`;
}
function gScopeBlock(title: string, sp: ScopeProgress, armed: boolean, big = false): string {
  return `<div class="gscope${big ? " gscope-big" : ""}">
    <div class="gscope-h"><span class="gscope-t">${esc(title)}</span> <span class="muted">${sp.posts} post(s) ${armed ? "in window" : "all-time"}</span></div>
    ${gMetricRow("views", sp.views)}
    ${gFollowerRow("followers", sp.followers)}
    <div class="health gpace">
      ${gPacePills(sp.paceViewsPerDay, sp.neededViewsPerDay, "views", armed)}
    </div>
  </div>`;
}
function gArmsTable(caption: string, arms: ArmAgg[], sortLabel: string): string {
  if (!arms.length) {
    return `<p class="muted">${esc(caption)}: no matured ${esc(sortLabel)} on any arm within the window yet.</p>`;
  }
  const rows = arms
    .map(
      (a, i) =>
        `<tr><td>${i + 1}</td><td>${esc(a.arm)}<br><span class="muted">${esc(a.family)}</span></td><td>${gInt(a.views)}</td><td>${gInt(a.posts)}</td></tr>`,
    )
    .join("");
  return `<div class="gcol"><div class="gcol-h">${esc(caption)}</div>
    <div class="tblwrap"><table class="tbl"><thead><tr><th>#</th><th>arm / family</th><th>views</th><th>posts</th></tr></thead><tbody>${rows}</tbody></table></div>
  </div>`;
}

function goalPanel(gp: GoalProgress): string {
  const kickoffChip = gp.armed
    ? `<span class="chip c-ok">KICKOFF ARMED · since ${esc(gp.since)}</span>`
    : `<span class="chip c-warn">KICKOFF PENDING — draft-only</span>`;
  const timeLeft = gp.armed
    ? `${gp.daysLeft}d ${gp.hoursLeft}h left${gp.windowClosed ? " · WINDOW CLOSED" : ""}`
    : `${gp.windowDays}d 0h (not started)`;
  const mandate = `<p class="muted" style="margin:2px 0 12px">TARGET (7 days from kickoff): <b>${gInt(GOAL.views)}</b> views combined, and <b>${gInt(GOAL.followersPerPlatform)}</b> followers on EACH of Instagram &amp; TikTok. Real live trajectory below — no vanity metrics.</p>`;
  const pendingNote = gp.armed
    ? ""
    : `<div class="reject">KICKOFF PENDING — the 7-day clock has not started. It arms when <code>${esc("<DATA_DIR>/KICKOFF_ARMED")}</code> exists and contains the phrase <code>ARM SFFS AUTONOMY</code>; t0 = that file's mtime. Totals shown are running (all posts, all-time); the window is not counting yet. DRAFT-ONLY until a human arms it.</div>`;
  const topBar = `<div class="health" style="margin-bottom:8px">
    ${kickoffChip}
    <span class="hpill"><b>window</b>${esc(String(gp.windowDays))} days</span>
    <span class="hpill"><b>time left</b>${esc(timeLeft)}</span>
    <span class="hpill"><b>followers snapshot</b>${gp.followersPending ? "pending" : "loaded"}</span>
    <span class="hpill"><b>as of (UTC)</b>${esc((gp.now || "").slice(0, 19).replace("T", " "))}</span>
  </div>`;
  const combined = gScopeBlock("Combined (IG + TikTok)", gp.combined, gp.armed, true);
  const perPlatform = `<div class="gtwo">
    ${gScopeBlock("Instagram", gp.instagram, gp.armed)}
    ${gScopeBlock("TikTok", gp.tiktok, gp.armed)}
  </div>`;
  const perPlatNote = `<p class="muted" style="margin:10px 0 4px">Per-platform view bars measure against ½ of the combined mandate (${gInt(GOAL.views / 2)} views each); the combined bars use the full target. Followers are ${gInt(GOAL.followersPerPlatform)} on each platform.</p>`;
  const arms = `<div class="gscope-h" style="margin-top:14px"><span class="gscope-t">What's moving the needle</span> <span class="muted">top arms by views within the window (ab-database variant.arm / family)</span></div>
    ${gArmsTable("Top arms by views", gp.topArmsByViews, "views")}`;
  return `${mandate}${topBar}${pendingNote}${combined}${perPlatNote}${perPlatform}${arms}`;
}

// ── SCHEDULED posts panel (post-KICKOFF) — mirrored LIVE from Metricool ───────
// Read-only table of the posts the loop has auto-scheduled + their times (CST).
// Pulled live from Metricool via the read-only bridge, so this and the Metricool
// calendar show the SAME posts at the SAME times. No publish/schedule control here.
/** One scheduled-post card: FULL 9:16 preview (contain + Plyr) + its scheduled time. */
/** The opening arm under test, as a chip. This is the week's experiment, so it gets
 *  its own visual slot rather than being folded into the generic A/B label. */
function openingChip(opening: string): string {
  if (opening === "motion-hook") {
    return `<span class="abtag ab-test" title="Motion-hook arm: a 2.2s wordless opening, nothing to read in the first three seconds">HOOK</span>`;
  }
  if (opening === "cold-plate") {
    return `<span class="abtag ab-control" title="Control arm: the current cold-open static question plate">CONTROL</span>`;
  }
  return "";
}

/** PUBLISHED vs PENDING for a calendar post, plus the live permalink once it exists.
 *  Named apart from the pre-existing statusChip(), which renders run/gate status. */
function postStatusChip(p: ScheduledPost): string {
  if (p.status === "PUBLISHED") {
    const link = p.public_url
      ? ` <a class="pub-link" href="${esc(p.public_url)}" target="_blank" rel="noopener noreferrer">view live ↗</a>`
      : "";
    return `<span class="stat-pub">PUBLISHED</span>${link}`;
  }
  return `<span class="stat-pend">PENDING</span>`;
}

/**
 * 3-second skip rate for a published reel. `null` means NOT YET SYNCED, never zero:
 * Metricool's analytics land on a nightly cycle up to ~24h behind, and showing a
 * fresh post as 0% would read as a perfect hook, which is the opposite of the truth.
 */
function skipChip(p: ScheduledPost): string {
  if (p.status !== "PUBLISHED") return "";
  if (typeof p.skip_rate !== "number") {
    return `<span class="skip skip-pending" title="Metricool syncs analytics nightly, up to ~24h behind. No data yet — this is NOT 0%.">skip rate: pending</span>`;
  }
  const cls = p.skip_rate >= 78.3 ? "skip-bad" : "skip-good";
  return `<span class="skip ${cls}" title="Share of viewers gone before ~3s. Campaign median is 78.3%; lower is better.">skip ${p.skip_rate.toFixed(1)}%</span>`;
}

function scheduledCard(p: ScheduledPost, defaults?: AbDefaults): string {
  const preview = videoPreview(p.video_key, p.thumbnail, p.media_url);
  // NOTE: p.arm_source ("run" | "ab-database" | "inferred") is intentionally NOT
  // surfaced as a badge — it's an internal data-provenance flag that self-heals as
  // new posts carry an exact draft→variant mapping (kept in the data, not the UI).
  const vid = p.video_id ? `<span class="vidid">${esc(p.video_id)}</span>` : "";
  return `<div class="draftcard">
    <div class="dthumb">${preview}</div>
    <div class="dbody">
      ${scheduleChip(p.scheduled_cst)}
      <div class="vid-h">
        ${openingChip(p.opening)}
        <span class="dplat">${platformLabel(p.platform)}</span>
        ${vid}
      </div>
      <div class="statline">${postStatusChip(p)} ${skipChip(p)}</div>
      ${abLabelHtml(p.dimension, p.arm, defaults)}
      <div class="rationale">${esc(p.hook)}</div>
    </div>
  </div>`;
}

/**
 * The experiment scoreboard: can the human answer "is this on track" without asking?
 * Scored on 3-second skip rate, not watch time — on the 28 non-breakout Instagram
 * reels skip rate predicts reach at -0.51 while watch time manages a non-significant
 * +0.21. Instagram only: Metricool exposes no TikTok watch-time data at all.
 */
function experimentPanel(view?: ScheduledView): string {
  if (!view || !view.ok) return `<p class="muted">Experiment status is unavailable while the schedule cannot be read.</p>`;
  // Tolerate a view without a roll-up (older callers, hand-built fixtures) by deriving
  // it, rather than throwing and taking the whole page down with it.
  const e = view.experiment ?? summarizeExperiment(view.posts || [], 15);
  const pct = e.target > 0 ? Math.min(100, Math.round((e.hook_scheduled / e.target) * 100)) : 0;
  const verdict = e.on_track
    ? `<b class="ok-yes">On track</b> — ${e.hook_scheduled} hook reels are scheduled against the ${e.target} the test needs.`
    : `<b class="ok-no">Short</b> — only ${e.hook_scheduled} hook reels scheduled against the ${e.target} the test needs.`;
  const med = (v: number | null): string => (typeof v === "number" ? `${v.toFixed(1)}%` : "pending");
  return `<p class="muted" style="margin-bottom:10px">${verdict} Scored on <b>3-second skip rate</b> (lower is better), Instagram only — Metricool reports no TikTok watch-time data at all.</p>
  <div class="expbar"><div class="expfill" style="width:${pct}%"></div><span class="expnum">${e.hook_scheduled} / ${e.target} usable hook reels</span></div>
  ${e.hook_excluded ? `<p class="muted" style="margin-top:8px">${e.hook_excluded} further hook reel(s) published on the superseded tilted opening and are <b>excluded</b> — a different treatment, so they are not averaged in.</p>` : ""}
  <div class="grid" style="margin-top:12px">
    <div class="kpi"><div class="v">${e.hook_posted}</div><div class="k">hook reels POSTED</div></div>
    <div class="kpi"><div class="v">${e.control_posted}</div><div class="k">control reels POSTED</div></div>
    <div class="kpi"><div class="v">${e.hook_with_data}</div><div class="k">hook reels with skip data</div></div>
    <div class="kpi"><div class="v">${med(e.hook_median_skip)}</div><div class="k">hook median skip</div></div>
    <div class="kpi"><div class="v">${med(e.control_median_skip)}</div><div class="k">control median skip</div></div>
  </div>
  <p class="muted" style="margin-top:10px">Medians read <b>pending</b> until Metricool's nightly analytics sync lands, which runs up to ~24h behind a post. A freshly published reel showing "pending" has not failed to gather data; it has not been synced yet.</p>`;
}


/**
 * The approval queue. Deliberately loud: if the user does not notice a queue, nothing
 * ships, so an empty queue is a quiet line and a non-empty one is a banner.
 */
function approvalPanel(view?: ScheduledView, defaults?: AbDefaults): string {
  const waiting = (view?.posts ?? []).filter((p) => p.awaiting_approval);
  if (!waiting.length) {
    return `<section class="card"><h2>APPROVAL QUEUE</h2>
      <p class="muted"><b>Nothing awaiting approval.</b> Videos the autonomous loop generates land here as
      drafts and cannot publish until approved. The reels already on the calendar were reviewed before
      scheduling and are exempt.</p></section>`;
  }
  const rows = waiting.map((p) => {
    // Both urls go through the render-side CDN choke point, so an S3 presigned url can
    // never reach the DOM even if the data layer's allowlist ever regressed.
    const src = cdnDirect(p.media_url);
    const poster = cdnDirect(p.thumbnail);
    const name = String(p.video_id || p.post_id || "");
    const when = String(p.scheduled_cst || p.scheduled_at || "");
    const posterImg = poster
      ? `<img class="apr-poster" loading="lazy" src="${esc(poster)}" alt="cover frame"/>`
      : `<span class="apr-noposter">no cover</span>`;
    // Resting state is the poster, not ten autoplaying players. Click loads the real
    // 9:16 Plyr instance in place — same vendored player the scheduled cards use.
    const media = src
      ? `<button type="button" class="apr-play" aria-label="Play this video">${posterImg}<span class="apr-playicon" aria-hidden="true">&#9654;</span></button>`
      : posterImg;
    return `
    <div class="apr-row" data-uuid="${esc(String(p.post_id))}" data-src="${esc(src || "")}" data-poster="${esc(poster || "")}">
      <div class="apr-media">${media}</div>
      <div class="apr-info">
        <div class="apr-top"><b class="apr-vid">${esc(name)}</b><span class="apr-when">${esc(when)}</span><span class="apr-plat">${platformLabel(p.platform)}</span></div>
        ${abLabelHtml(p.dimension, p.arm, defaults)}
        <div class="apr-hook">${esc(String(p.hook || ""))}</div>
      </div>
      <div class="apr-act">
        <button class="apr-yes" data-act="approve">Approve</button>
        <button class="apr-no" data-act="reject">Reject</button>
        <span class="apr-msg"></span>
      </div>
    </div>`;
  }).join("");
  return `<section class="card apr-card"><h2>APPROVAL QUEUE — ${waiting.length} AWAITING</h2>
    <p class="muted">These are loop-generated drafts. They <b>cannot publish</b> until approved:
    they are held as Metricool drafts, so nothing goes out even if this box dies. Rejecting soft-deletes
    (restorable). Anything still unapproved when its slot arrives slides forward automatically.
    <b>Tap a cover to play it</b> full-frame (9:16, uncropped) before you decide.</p>
    ${rows}
    <script>
    (function () {
      var CDN = "https://static.metricool.com/";
      /* Load the real player on demand. Ten autoplaying videos on one page would be
         unusable, so the poster is the resting state and the click pays for the player. */
      function openPlayer(row) {
        if (!row) return;
        var box = row.querySelector(".apr-media");
        if (!box || box.getAttribute("data-loaded") === "1") return;
        var src = row.getAttribute("data-src") || "";
        if (src.indexOf(CDN) !== 0) return;
        box.setAttribute("data-loaded", "1");
        box.classList.add("is-open");
        var v = document.createElement("video");
        v.className = "dvid";
        v.controls = true; v.playsInline = true; v.preload = "metadata";
        var poster = row.getAttribute("data-poster") || "";
        if (poster.indexOf(CDN) === 0) v.poster = poster;
        var s = document.createElement("source");
        s.src = src; s.type = "video/mp4";
        v.appendChild(s);
        box.textContent = "";
        box.appendChild(v);
        try {
          if (typeof Plyr !== "undefined") {
            new Plyr(v, { iconUrl: "/static/plyr.svg", ratio: "9:16", controls: ["play-large","play","progress","current-time","mute","volume","fullscreen"] });
          }
        } catch (e) {}
        var go = v.play();
        if (go && go.catch) go.catch(function () {});
      }
      document.querySelectorAll(".apr-row .apr-play").forEach(function (b) {
        b.addEventListener("click", function () { openPlayer(b.closest(".apr-row")); });
      });
      /* No credential is sent: approve/reject are open by the user's explicit decision.
         The bound that matters is server-side — two verbs, a numeric uuid and nothing
         else, each re-reading the post and refusing anything that is not already an
         unapproved loop draft. */
      document.querySelectorAll(".apr-row button[data-act]").forEach(function (b) {
        b.addEventListener("click", async function () {
          var row = b.closest(".apr-row");
          var msg = row.querySelector(".apr-msg");
          b.disabled = true; msg.textContent = "working...";
          try {
            var opts = {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ uuid: row.dataset.uuid }),
            };
            var r = b.dataset.act === "approve"
              ? await fetch("/api/approve", opts)
              : await fetch("/api/reject", opts);
            var j = await r.json();
            msg.textContent = j.reason || (j.ok ? "done" : "failed");
            if (j.ok) { row.style.opacity = 0.45; row.querySelectorAll("button[data-act]").forEach(function (x) { x.disabled = true; }); }
            else { b.disabled = false; }
          } catch (e) { msg.textContent = "request failed"; b.disabled = false; }
        });
      });
    })();
    </script></section>`;
}

function scheduledPanel(view?: ScheduledView, defaults?: AbDefaults): string {
  if (!view) {
    return `<p class="muted">Scheduled posts appear here once autonomy is ARMED. Until then the loop is DRAFT-ONLY (nothing is scheduled).</p>`;
  }
  if (!view.ok) {
    return `<p class="muted">Couldn't load the schedule right now${view.error ? `: ${esc(view.error)}` : ""}. This panel pulls LIVE from Metricool via the read-only bridge; it retries on the next refresh.</p>`;
  }
  if (!view.posts.length) {
    return `<p class="muted">Nothing on the calendar. Posting runs through the controlled path (<code>ops/resume_posting.mjs</code>); anything it schedules appears here, mirrored LIVE from Metricool.</p>`;
  }
  const byPlat = Object.entries(view.by_platform).map(([k, v]) => `${esc(platformLabel(k))}: ${v}`).join(" · ");
  // Derive rather than trust: a view built by an older caller has no by_status, and
  // taking the page down over a missing tally would be a worse bug than the one this
  // whole change is fixing.
  const tally = view.by_status ?? view.posts.reduce<Record<string, number>>((acc, p) => {
    acc[p.status] = (acc[p.status] || 0) + 1;
    return acc;
  }, {});
  const pub = tally.PUBLISHED || 0;
  const pend = tally.PENDING || 0;
  return `<p class="muted" style="margin-bottom:12px">${view.count} post(s) on the calendar — <b>${pub} published</b>, <b>${pend} pending</b>. Pulled LIVE from Metricool, so these are the SAME posts and times the Metricool planner shows. ${esc(byPlat)}. Each card shows the FULL 9:16 preview (letterboxed, never cropped), played directly from Metricool's public CDN. As of ${esc(view.as_of)}.</p>
  <div class="draftgrid">${view.posts.map((p) => scheduledCard(p, defaults)).join("")}</div>`;
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
  /** always-on factory daemon status (optional; degrades to "no daemon status"). */
  factory?: any;
  /** always-on continuous supervisor status (optional; degrades to "no supervisor status"). */
  supervisor?: any;
  /** SCHEDULED posts post-kickoff, mirrored live from Metricool (optional). */
  scheduled?: ScheduledView;
  /** GOAL-PROGRESS toward Hermes's 7-day mandate (optional; degrades to pending/empty). */
  goal?: GoalProgress;
  /** winner-replication ledger view (optional; degrades to "no replication state"). */
  replication?: ReplicationView;
}

export function page(opts: PageData): string {
  // Surfaced first, before any other panel, because an unnoticed queue ships nothing.
  const awaitingCount = (opts.scheduled?.posts ?? []).filter((p: any) => p.awaiting_approval).length;
  const awaitingBanner = awaitingCount
    ? `<div class="apr-banner"><b>${awaitingCount} video${awaitingCount === 1 ? "" : "s"} awaiting your approval</b>
       — nothing publishes until you decide. <a href="#approval">Review now</a></div>`
    : "";

  const { runs, db, l, bank, schedule, disk, selected, pr, logItems } = opts;
  const cov: BankCoverage =
    opts.coverage ?? { total: 0, usable: bank.usable, fresh: bank.fresh, used: bank.used, freshPct: 0, perDay: 0, runwayDays: null, byType: [] };
  // GOAL-PROGRESS is FRONT-AND-CENTER; default to a "pending" panel so it always renders.
  const goal: GoalProgress = opts.goal ?? computeGoalProgress([], null, null, new Date());
  const cur = selected ? runs.find((r) => r.run_id === selected) || opts.latest : opts.latest;
  const s = cur?.summary || { planned: 0, drafted: 0, rejected: 0, failed: 0 };
  const drafts = (cur?.videos || []).filter((v) => v.status === "drafted");
  const draftTotal = drafts.reduce((a, v) => a + (v.metricool?.uuids?.length || 0), 0);
  // Live cumulative count of posts Metricool currently has SCHEDULED (not this cycle).
  const scheduledCount = opts.scheduled?.ok ? opts.scheduled.count : (opts.scheduled ? opts.scheduled.count : "—");
  const runOpts = runs
    .map((r) => `<option value="${esc(r.run_id)}" ${r.run_id === cur?.run_id ? "selected" : ""}>${esc(r.run_id)} · ${esc(r.status)} · ${r.summary?.drafted ?? 0} drafts</option>`)
    .join("");
  const videos = (cur?.videos || []).map(videoCard).join("") || `<p class="muted">No batch designed yet for this run.</p>`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>SFFS Self-Improving Agentic Marketing Loop</title>
<link rel="stylesheet" href="/static/plyr.css"/>
<style>
:root{--ink:#000;--paper:#fff;--blue:#839aff;--mint:#c6fcd0;--coral:#fd7962;--yellow:#fce552;--cream:#f6f4ee;--green:#63c088}
*{box-sizing:border-box}
html,body{max-width:100%;overflow-x:hidden}
body{margin:0;background:var(--cream);color:var(--ink);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif}
a{color:#1b3bd1}
header{background:var(--blue);border-bottom:5px solid var(--ink);padding:18px 22px;display:flex;flex-wrap:wrap;gap:14px;align-items:center;justify-content:space-between}
header h1{margin:0;font:800 24px/1 "Segoe UI",sans-serif;letter-spacing:.5px}
.tag{background:var(--ink);color:var(--yellow);padding:4px 10px;border-radius:6px;font-weight:800;font-size:12px;letter-spacing:1px}
.tag.ro{background:#0d0d0d;color:var(--mint)}
.wrap{max-width:1120px;margin:0 auto;padding:22px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:14px;margin-bottom:0}
.kpi{background:var(--paper);border:4px solid var(--ink);border-radius:16px;box-shadow:8px 8px 0 0 var(--ink);padding:16px}
.kpi .v{font:800 34px/1 "Segoe UI",sans-serif}
.kpi .k{font-size:12px;text-transform:uppercase;letter-spacing:1px;color:#444;margin-top:6px}
/* group KPIs so per-cycle counters are visually separated from bank/live totals */
.statgroup{margin-bottom:20px}
.statlabel{font:800 12px/1 "Segoe UI",sans-serif;text-transform:uppercase;letter-spacing:1.5px;color:#111;background:var(--yellow);border:3px solid var(--ink);border-radius:9px;display:inline-block;padding:6px 11px;margin-bottom:12px;box-shadow:3px 3px 0 0 var(--ink)}
.statlabel .muted{font-weight:600;letter-spacing:.4px;text-transform:none;color:#333}
.card{background:var(--paper);border:4px solid var(--ink);border-radius:18px;box-shadow:8px 8px 0 0 var(--ink);padding:20px;margin-bottom:22px}
.card h2{margin:0 0 14px;font-size:20px;display:flex;flex-wrap:wrap;gap:10px;align-items:center}
.card h2 .pin{background:var(--coral);border:3px solid var(--ink);border-radius:8px;padding:2px 8px;font-size:12px;font-weight:800}
.card h2 .pin.pr{background:var(--yellow)}
.vid{border:3px solid var(--ink);border-radius:14px;padding:14px;margin-bottom:14px;background:var(--cream)}
.vid-h{display:flex;justify-content:space-between;align-items:center;gap:10px}
.dim{font-weight:800;font-size:17px}.arm{color:#444;line-height:1.55;overflow-wrap:anywhere}.abtag{display:inline-block;font-weight:800;font-size:10px;letter-spacing:.02em;padding:1px 6px;border-radius:6px;margin-right:5px;vertical-align:baseline}.ab-test{background:#e8f0ff;color:#1b47b4}.ab-control{background:#e6f6ec;color:#1c7a3f}.ab-unknown{background:#eee;color:#777}
.rationale{color:#333;margin:6px 0 10px;font-size:14px}
.rationale code{background:#eee;border:1px solid #ccc;border-radius:5px;padding:1px 5px;font-size:12px}
.gates{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}
.b{display:inline-block;vertical-align:middle;font-size:12px;font-weight:700;padding:3px 8px;border-radius:6px;border:2px solid var(--ink)}
.b-ok{background:var(--green)}.b-no{background:var(--coral);color:#fff}.b-na{background:#ddd}
.reject{background:#ffe3de;border:2px solid var(--coral);border-radius:8px;padding:6px 10px;font-size:13px;margin-bottom:8px}
.qs{margin:8px 0;padding-left:18px}.qs .ans{color:var(--green);font-weight:700}
.cap{font-size:13px;color:#333;margin-top:4px}
.vid-f{margin-top:10px;display:flex;flex-wrap:wrap;gap:14px;align-items:center;font-size:13px}
.media{font-weight:700}
.chip{display:inline-block;vertical-align:middle;white-space:nowrap;font-size:12px;font-weight:800;padding:4px 10px;border-radius:20px;border:2px solid var(--ink)}
.c-ok{background:var(--green)}.c-warn{background:var(--yellow)}.c-no{background:var(--coral);color:#fff}.c-run{background:var(--blue)}.c-idle{background:#e5e5e5}
.tbl{width:100%;border-collapse:collapse;font-size:13px;max-width:100%}
.tbl th,.tbl td{border:2px solid var(--ink);padding:6px 8px;text-align:left;overflow-wrap:anywhere}
.tbl th{background:var(--mint)}
.tblwrap{max-width:100%;overflow-x:auto}
.tbl .front{background:var(--yellow)}
.star{font-size:11px;font-weight:800}
.live{background:var(--coral);color:#fff;font-size:10px;padding:1px 5px;border-radius:4px;font-weight:800}
.draft{background:#ddd;font-size:10px;padding:1px 5px;border-radius:4px;font-weight:800}
.muted{color:#3f3f3f}.cell-fam{min-width:120px}
.two{display:grid;grid-template-columns:1fr 1fr;gap:20px}
.log{list-style:none;padding:0;margin:0;font-size:13px}
.log li{padding:6px 0;border-bottom:1px solid #e2e2e2}
.date{font-weight:800;margin-right:6px}
.health{display:flex;flex-wrap:wrap;gap:10px}
.hpill{background:var(--cream);border:3px solid var(--ink);border-radius:10px;padding:8px 12px;font-size:13px;overflow-wrap:anywhere}
.hpill b{display:block;font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#333}
/* "behind pace" alert pill (GOAL panel "…/day needed"): coral needs DARK ink, not
   white — #fff on coral(#fd7962) is ~2.6:1 (fails WCAG AA); #111 on coral is ~7.3:1.
   Darkens BOTH the number AND its label so it reads clearly on the coral background. */
.hpill.alert{background:var(--coral)}
.hpill.alert,.hpill.alert b{color:#111}
.logbox{max-height:340px;overflow:auto;background:#0d0d0d;color:#d6d6d6;border-radius:12px;padding:12px;font:12px/1.5 ui-monospace,Menlo,monospace}
.lg{padding:2px 0;white-space:pre-wrap}.lt{color:#7bd88f}.ll{color:#f5c451;font-weight:700}
.lg-error .ll{color:#ff7a6b}
form.runsel{display:flex;flex-wrap:wrap;gap:8px;align-items:center;min-width:0;max-width:100%;margin-left:auto}
.runsel label{font-weight:800;white-space:nowrap;text-transform:uppercase;letter-spacing:1px;font-size:12px}
/* run picker — SFFS neo-brutalist native <select>: thick ink border, hard offset shadow,
   brand fill, bold type, custom caret (appearance:none). Kept width-bounded + ellipsised so
   long run-id options never reintroduce horizontal page scroll; a native <select> stays fully
   keyboard- and screen-reader-accessible (paired with its <label for="run">). */
.runsel select{flex:0 1 auto;max-width:min(62vw,340px);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;appearance:none;-webkit-appearance:none;-moz-appearance:none;font:800 13px/1 "Segoe UI",sans-serif;color:var(--ink);background-color:var(--mint);background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%23000' stroke-width='3.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 10px center;background-size:15px;border:3px solid var(--ink);border-radius:10px;box-shadow:4px 4px 0 0 var(--ink);padding:8px 34px 8px 12px;cursor:pointer;transition:transform .06s ease,box-shadow .06s ease,background-color .1s ease}
.runsel select:hover{background-color:var(--yellow)}
.runsel select:focus-visible{outline:3px solid var(--blue);outline-offset:2px}
.runsel select:active{transform:translate(2px,2px);box-shadow:2px 2px 0 0 var(--ink)}
.runsel select option{background:var(--paper);color:var(--ink);font-weight:600}
select{padding:6px 8px;border:3px solid var(--ink);border-radius:8px;font-size:13px;background:#fff;min-width:0;max-width:100%}
.foot{color:#333;font-size:12px;text-align:center;padding:14px;line-height:1.6}
details summary{cursor:pointer;font-size:13px;color:#333;margin-top:6px}
code{font:12px/1.4 ui-monospace,Menlo,monospace;overflow-wrap:anywhere}
.draftgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px}
.draftcard{display:flex;flex-direction:column;border:3px solid var(--ink);border-radius:14px;overflow:hidden;background:var(--cream)}
.dthumb{background:#000;border-bottom:3px solid var(--ink);aspect-ratio:9/16;max-height:360px;display:flex;align-items:center;justify-content:center;overflow:hidden;position:relative}
/* full 9:16 frame: contain (letterbox) rather than cover (crop) */
.dthumb-img{width:100%;height:100%;object-fit:contain;display:block}
.dvid{width:100%;height:100%;object-fit:contain;display:block;background:#000}
.dthumb-none{color:#bbb;font-size:12px;font-weight:700}
/* Plyr fills the 9:16 box and letterboxes portrait video (contain) — never crops */
.dthumb .plyr{width:100%;height:100%;--plyr-color-main:#fd7962}
.dthumb .plyr__video-wrapper{height:100%;background:#000}
.dthumb .plyr video{width:100%;height:100%;object-fit:contain;background:#000}
.dbody{padding:12px;display:flex;flex-direction:column;gap:6px}
.draftplatforms{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-top:6px;font-size:13px}
.dplat{display:inline-block;font-weight:800;font-size:12px;border:2px solid var(--ink);border-radius:8px;padding:3px 9px;background:var(--mint);color:#111}
/* status + experiment chips */
.statline{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:6px 0}
.stat-pub{font:700 11px/1 ui-monospace,monospace;background:var(--mint);border:2px solid #000;border-radius:6px;padding:4px 7px}
.stat-pend{font:700 11px/1 ui-monospace,monospace;background:#eee;border:2px solid #000;border-radius:6px;padding:4px 7px}
.pub-link{font:700 11px/1 ui-monospace,monospace;text-decoration:underline}
.skip{font:700 11px/1 ui-monospace,monospace;border:2px solid #000;border-radius:6px;padding:4px 7px}
.skip-good{background:var(--mint)}
.skip-bad{background:var(--coral)}
.skip-pending{background:#eee;color:#555}
.vidid{font:600 10px/1 ui-monospace,monospace;color:#666}
.expbar{position:relative;height:26px;background:#eee;border:3px solid #000;border-radius:8px;overflow:hidden}
.expfill{height:100%;background:var(--mint)}
.expnum{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font:800 12px/1 ui-monospace,monospace}
.ok-yes{color:#1a7f42}
.ok-no{color:#b3261e}
/* prominent per-card scheduled date/time chip (scheduled = mint; draft = neutral grey) */
/* time-only mint pill: hugs its content (align-self) so it reads as a compact chip */
.timechip{display:inline-flex;align-self:flex-start;align-items:center;margin-bottom:4px;border:3px solid var(--ink);border-radius:10px;padding:6px 12px;background:var(--mint);box-shadow:3px 3px 0 0 var(--ink)}
.timechip .tc-v{font-size:15px;font-weight:800;font-variant-numeric:tabular-nums;line-height:1.2;color:var(--ink)}
.timechip-none{background:#e6e6e6;box-shadow:3px 3px 0 0 #555}
.timechip-none .tc-v{color:#555;font-weight:700}
.goalcard{background:linear-gradient(180deg,#fffdf3,var(--paper))}
.gtwo{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px;margin-top:4px}
.gscope{border:3px solid var(--ink);border-radius:14px;padding:14px;background:var(--cream);margin-top:10px}
.gscope-big{background:var(--paper);box-shadow:6px 6px 0 0 var(--ink)}
.gscope-h{display:flex;flex-wrap:wrap;gap:8px;align-items:baseline;margin-bottom:8px}
.gscope-t{font-weight:800;font-size:16px}
.gmetric{margin:8px 0}
.gm-h{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;font-size:13px;margin-bottom:4px}
.gm-l{font-weight:800;text-transform:uppercase;letter-spacing:1px;font-size:11px;color:#333}
.gm-v{font-variant-numeric:tabular-nums}
.gbar{height:16px;border:2px solid var(--ink);border-radius:9px;background:#fff;overflow:hidden;max-width:100%}
.gbar .gfill{display:block;height:100%;background:var(--blue);border-right:2px solid var(--ink);min-width:0;transition:none}
.gbar .gfill-done{background:var(--green)}
.gbar-pending{background:repeating-linear-gradient(45deg,#eee,#eee 6px,#f6f4ee 6px,#f6f4ee 12px)}
.gpace{margin-top:10px}
.gcol-h{font-weight:800;font-size:14px;margin-bottom:6px}

.apr-banner{background:#ffd166;color:#111;padding:14px 18px;border:3px solid #111;font-weight:800;margin:0 0 18px;border-radius:8px}
.apr-banner a{color:#111}
.apr-card{border-color:#ffd166}
.apr-row{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:9px 0;border-top:1px solid #2a2a2a;flex-wrap:wrap}
.apr-meta{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.apr-act{display:flex;gap:8px;align-items:center}
.apr-yes,.apr-no{cursor:pointer;border:2px solid #111;border-radius:6px;padding:6px 14px;font-weight:700}
.apr-yes{background:#8ce99a}.apr-no{background:#ffa8a8}
.apr-yes:disabled,.apr-no:disabled{opacity:.5;cursor:default}
.apr-msg{font-size:12px;opacity:.85}
.apr-row{align-items:flex-start}
.apr-media{flex:0 0 auto;width:92px;background:#000;border:2px solid var(--ink);border-radius:10px;overflow:hidden;aspect-ratio:9/16;display:flex;align-items:center;justify-content:center;position:relative}
.apr-media.is-open{width:190px}
.apr-play{all:unset;cursor:pointer;display:block;width:100%;height:100%;position:relative;box-sizing:border-box}
.apr-poster{width:100%;height:100%;object-fit:contain;display:block;background:#000}
.apr-noposter{color:#bbb;font-size:10px;font-weight:700;text-align:center;padding:4px}
.apr-playicon{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:30px;height:30px;border-radius:50%;background:rgba(17,17,17,.72);color:#fff;font-size:12px;display:flex;align-items:center;justify-content:center;pointer-events:none}
.apr-info{flex:1 1 240px;min-width:0}
.apr-top{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;margin-bottom:3px}
.apr-vid{font-size:14px}
.apr-when{font-variant-numeric:tabular-nums;font-weight:700}
.apr-plat{font-size:11px;font-weight:800;background:#eee;border-radius:6px;padding:1px 6px}
.apr-hook{color:#333;font-size:13px;margin-top:3px;overflow-wrap:anywhere}
.apr-media .plyr{width:100%;height:100%;--plyr-color-main:#fd7962}
.apr-media .plyr__video-wrapper{height:100%;background:#000}
.apr-media .plyr video{width:100%;height:100%;object-fit:contain;background:#000}
@media(max-width:560px){.apr-media{width:74px}.apr-media.is-open{width:150px}}
</style></head>
<body>
<header>
  <h1>SFFS Self-Improving Agentic Marketing Loop</h1>
  <div id="health" class="health"><span class="hpill">checking health…</span></div>
</header>
<div class="wrap">
  <div class="card goalcard">
    <h2><span class="pin" style="background:var(--yellow)">GOAL</span> Hermes mandate — live 7-day trajectory</h2>
    ${goalPanel(goal)}
  </div>

  <div class="statgroup">
    <div class="statlabel">This cycle <span class="muted">· selected run ${esc(cur?.run_id || "—")} (per-run counters, reset each cycle)</span></div>
    <div class="grid">
      <div class="kpi"><div class="v">${s.planned}</div><div class="k">planned (this cycle)</div></div>
      <div class="kpi"><div class="v">${s.drafted}</div><div class="k">videos drafted (this cycle)</div></div>
      <div class="kpi"><div class="v">${draftTotal}</div><div class="k">metricool drafts (this cycle)</div></div>
      <div class="kpi"><div class="v">${s.rejected}</div><div class="k">rejected · gates (this cycle)</div></div>
    </div>
  </div>

  <div class="statgroup">
    <div class="statlabel">Bank &amp; live totals <span class="muted">· cumulative — NOT this cycle</span></div>
    <div class="grid">
      <div class="kpi"><div class="v">${scheduledCount}</div><div class="k">on the calendar (live · metricool)</div></div>
      <div class="kpi"><div class="v">${bank.fresh}</div><div class="k">fresh questions (bank)</div></div>
      <div class="kpi"><div class="v">${cov.runwayDays == null ? "—" : cov.runwayDays}</div><div class="k">days runway (bank est.)</div></div>
    </div>
  </div>

  <div class="card">
    <h2><span class="pin">EXPERIMENT</span> Opening A/B — 3-second skip rate <span class="pin" style="background:var(--yellow)">THIS WEEK</span></h2>
    ${experimentPanel(opts.scheduled)}
  </div>

  <div class="card">
    <h2><span class="pin">SCHEDULED</span> Posts &amp; times <span class="pin" style="background:var(--mint)">LIVE FROM METRICOOL</span></h2>
    ${awaitingBanner}<span id="approval"></span>${approvalPanel(opts.scheduled, opts.defaults?.defaults)}${scheduledPanel(opts.scheduled, opts.defaults?.defaults)}
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
    <h2><span class="pin">SUPERVISOR</span> Always-on continuous orchestrator — research · knowledge · content-prep (NON-posting)</h2>
    ${supervisorPanel(opts.supervisor)}
  </div>

  <div class="card">
    <h2><span class="pin">FACTORY</span> Always-on software factory — live daemon (goals · merges · refusals · spend · kill-switch)</h2>
    ${factoryPanel(opts.factory)}
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
    <h2><span class="pin">REPLICATE</span> Double down on reach outliers <span class="pin" style="background:var(--yellow)">EXPLORATION CAP ${Math.round((opts.replication?.share_cap ?? 0.5) * 100)}%</span></h2>
    ${replicatePanel(opts.replication)}
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
    <h2><span class="pin">GATE</span> Pending default changes <span class="pin" style="background:var(--blue)">AUTONOMOUS</span> <span class="pin" style="background:var(--mint)">HUMAN-APPROVED</span></h2>
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
    <b>SFFS Self-Improving Agentic Marketing Loop</b> · posting 7am–3am CST (≤12/day per platform, jittered, quality- &amp; brand-gated) · goal: 500K views &amp; 500 followers per platform in 7 days · disk: ${esc(disk)} · auto-refresh 60s<br>
    view only — research, content generation, scheduling &amp; code self-improvement run autonomously on the box under hard guardrails.
  </div>
</div>
<script src="/static/plyr.min.js"></script>
<script>
/* Enhance every full-frame preview with Plyr (vendored locally; no external CDN).
   object-fit:contain keeps 9:16 portrait video letterboxed — never cropped. */
(function(){
  if (typeof Plyr === 'undefined') return;
  var vids = document.querySelectorAll('video.dvid');
  for (var i = 0; i < vids.length; i++) {
    try { new Plyr(vids[i], { iconUrl: '/static/plyr.svg', ratio: '9:16', controls: ['play-large','play','progress','current-time','mute','volume','fullscreen'] }); } catch (e) {}
  }
})();
</script>
<script>
(async function(){
  try{
    const r = await fetch('/api/health',{headers:{'accept':'application/json'}});
    const h = await r.json();
    const el = document.getElementById('health');
    const llm = h.llm && h.llm.ok ? '<span class="hpill" style="background:var(--green)"><b>LLM</b>ok · '+ (h.llm.model||'') +'</span>'
      : '<span class="hpill" style="background:'+(h.llm && h.llm.configured===false?'#e5e5e5':'var(--coral)')+';color:'+(h.llm && h.llm.configured===false?'#000':'#fff')+'"><b>LLM</b>'+ (h.llm && h.llm.detail ? String(h.llm.detail).slice(0,42) : 'down') +'</span>';
    const kill = h.kill && h.kill.engaged
      ? '<span class="hpill" style="background:#dbe6ff;color:#122a5c;border-color:#122a5c"><b>factory</b>paused (maintenance)</span>'
      : '<span class="hpill" style="background:var(--green);color:#0d2a19"><b>factory</b>active</span>';
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
