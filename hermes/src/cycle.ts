/**
 * cycle.ts — the once-per-~24h autonomous DRAFT-ONLY cycle. Idempotent + resumable
 * (re-running the same run_id skips completed per-video steps). Every decision +
 * gate result is logged and persisted to the run state for the dashboard.
 *
 * Flow:
 *   0. preflight (assert draft-only, LLM ping, bank stats)
 *   1. snapshot do-not-touch (existing scheduled + published posts)
 *   (a) pull matured analytics + score + update learnings
 *   (b) plan the batch (up to VIDEOS_PER_DAY videos, each a different A/B dimension)
 *   then, per WAVE:
 *     PREPARE each video: dedup gate -> question-validity gate -> mark used ->
 *                   copy gate -> render (Short/FullVideo, ONE per platform with
 *                   its own SAFE ZONES) -> render-sanity gate
 *     PUBLISH the survivors: allocate schedule slots sized to how many ACTUALLY
 *                   survived, then per platform: S3 upload -> Metricool draft
 *                   (draft:true, autoPublish:false) -> annotate ab-database
 *     TOP UP if the day landed under VIDEOS_FLOOR and the ceiling still has room
 *   2. verify do-not-touch untouched (proves nothing went live)
 *   3. commit data files locally (best-effort; pushing is opt-in, see gitCommitPush)
 *
 * PREPARE and PUBLISH are split so slots are allocated against the SURVIVING count,
 * in completion order. Allocating by PLANNED index is what tail-bunched 2026-07-25:
 * 9 of 10 videos died at a gate, and the lone survivor (planned index 9) inherited
 * the LAST slot of a 10-slot grid — 11:39pm/12:19am — instead of the first.
 *
 * NOTHING here can publish or schedule. See guardrails.ts / config.ts.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CONFIG, assertPostState } from "./config.ts";
import { setRunLog, info, warn, error, decision, gate } from "./log.ts";
import {
  loadRun,
  saveRun,
  runPath,
  todayRunId,
  type RunState,
  type VideoPlan,
} from "./state.ts";
import { snapshotDoNotTouch, verifyDoNotTouch } from "./guardrails.ts";
import { kickoffStatus, type KickoffStatus } from "./kickoff.ts";
import { nextSlots, WINDOW_OPEN_HOUR, WINDOW_CLOSE_HOUR, instantFromWallClock } from "./scheduler.ts";
import { goalProgress } from "./goal.ts";
import { pullAndScore } from "./score.ts";
import { reconcile } from "./reconcile.ts";
import { planBatch } from "./design.ts";
import { runLeadPromotion, leadStamp } from "./leadPromotion.ts";
import { topUpBank } from "./generate.ts";
import { gateDedup, validateQuestions, gateCopy, gateRenderSanity } from "./gates.ts";
import { markUsed, markRejected, bankStats } from "./questions.ts";
import { appendTakeaway, formatTakeaway } from "./memory.ts";
import { renderForPlatforms } from "./render.ts";
import { uploadToS3 } from "./s3.ts";
// Publishing goes through Metricool, reusing the modules the controlled path already
// proved against the live account.
import { publishAsDraft, planSlots, calendarRows, allocatable, localDay, type LoopDraft } from "./loopPublish.ts";
import { NETWORKS, monthlyRecords, exhaustionForecast, type Network } from "./postingPolicy.ts";
import { budget, type McPost } from "./metricool.ts";
import { toNaive } from "./approval.ts";
import { ping, pingConfiguredModels, logLlmUsage, llmUsageReport } from "./llm.ts";
import { readJSON, writeJSONAtomic } from "./state.ts";

const DRY = process.env.HERMES_DRY_RUN === "1";

/**
 * Most PREPARE+PUBLISH passes one cycle will make. Wave 1 works the oversampled
 * batch; later waves only exist to top the day up to VIDEOS_FLOOR when rejections
 * or transient failures ate too much of it. Bounded so a persistently unhealthy
 * cycle can never loop.
 */
const MAX_WAVES = 3;
/** Extra videos a top-up wave plans beyond the bare shortfall, to absorb its own
 *  rejections without needing yet another wave. */
const TOPUP_SLACK = 2;
/** Attempts for the two steps that historically lost a whole video to a transient. */
const RENDER_ATTEMPTS = 2;
const MEDIA_IMPORT_ATTEMPTS = 3;
const JOB_POLL_ATTEMPTS = 3;
/** Pause between videos in the publish phase, to stay under the API rate limit. */
const PUBLISH_PACE_MS = Number(process.env.HERMES_PUBLISH_PACE_MS || 6_000);
/** Per-attempt backoff once the API says we are over quota (see isRateLimited). */
const RATE_LIMIT_BACKOFF_MS = Number(process.env.HERMES_RATE_LIMIT_BACKOFF_MS || 30_000);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Does this error mean "you are going too fast" rather than "something broke"?
 * The API answers a quota breach with 429 ("Rate limit exceeded") and, once tripped
 * hard, a 403 whose body is an upsell ("Please upgrade to Business to access our
 * API") — the same signal wearing a different status code. Both need tens of
 * seconds to clear, so they get a much longer backoff than a network blip.
 */
export function isRateLimited(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e);
  return /HTTP 429|rate limit|too many requests|upgrade to Business/i.test(m);
}

/**
 * Run `fn`, retrying a TRANSIENT failure. Used ONLY for idempotent steps — the
 * render, and the upload — where a one-off flake used to
 * cost the day a whole video (2026-07-24 lost one to a media-import timeout;
 * 2026-07-25 lost two to a rate limit). This never re-runs or softens a GATE:
 * a gate verdict is a decision, not a transient. Post CREATION is deliberately not
 * retried here — a retried create can double-post.
 */
async function withRetry<T>(label: string, attempts: number, fn: () => Promise<T> | T): Promise<T> {
  let last: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (attempt < attempts) {
        const backoff = attempt * (isRateLimited(e) ? RATE_LIMIT_BACKOFF_MS : 5_000);
        warn(`${label} attempt ${attempt}/${attempts} failed — retrying in ${Math.round(backoff / 1000)}s`, {
          err: e instanceof Error ? e.message : String(e),
          rateLimited: isRateLimited(e),
        });
        await sleep(backoff);
      }
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

/**
 * Per-cycle scheduling context. OFF (default) => draft-only: every video takes the
 * unchanged draft-only path. ARMED (human kickoff) => each platform draft is
 * ALSO scheduled at a policy time (scheduler.ts) by the gated loop publish path.
 */
interface SchedCtx {
  armed: boolean;
  /** `index` is the video's position among the batch's SURVIVORS, not its planned index. */
  slot: (platform: string, index: number) => string | null;
}
const DRAFT_ONLY_SCHED: SchedCtx = { armed: false, slot: () => null };

function newRun(runId: string, target: number): RunState {
  return {
    run_id: runId,
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    status: "running",
    cadence: "24h",
    target_count: target,
    do_not_touch: { scheduled_ids: [], published_ids: [], captured_at: "" },
    scoring: {},
    videos: [],
    summary: { planned: 0, drafted: 0, rejected: 0, failed: 0 },
    errors: [],
  };
}

/**
 * Roles whose primary model IS the designated fallback — i.e. roles with no
 * cross-model safety net at all.
 *
 * chat() refuses to retry a model against itself (`fb === model` throws), which is
 * right, and which also means this misconfiguration does not degrade the net — it
 * DELETES it, silently. That is the exact shape of the 2026-08-03 defect: the judge
 * fallback named claude-haiku-4-5 while haiku was the thing failing. Cheap to state
 * at the top of a run; expensive to discover during an outage.
 */
export function rolesWithoutFallback(model: string, captionModel: string, fallbackModel: string): string[] {
  const roles: Array<[string, string]> = [
    ["reasoning", model],
    ["caption", captionModel],
  ];
  return roles.filter(([, m]) => m === fallbackModel).map(([role]) => role);
}

/**
 * Count the work that SHIPPED without the model that was supposed to do it.
 *
 * Separate from runCycle and exported on purpose: this tally is the only thing that
 * distinguishes "twelve judged videos" from "twelve unjudged ones", and a number that
 * important should be checkable without standing up a whole cycle.
 */
export function summarizeDegradation(
  videos: Array<{ caption_source?: string; gates?: Record<string, { degraded?: boolean } | undefined> }>,
  llmFailedCalls: number,
): { llm_failed_calls: number; caption_fallbacks: number; copy_gate_unjudged: number; questions_unjudged: number } {
  return {
    llm_failed_calls: llmFailedCalls,
    caption_fallbacks: videos.filter((v) => v.caption_source === "fallback").length,
    copy_gate_unjudged: videos.filter((v) => v.gates?.copy?.degraded === true).length,
    questions_unjudged: videos.filter((v) => v.gates?.questions?.degraded === true).length,
  };
}

/**
 * PREPARE phase — every gate plus the render, i.e. everything that can reject or
 * fail a video WITHOUT touching the board. Ends at status "rendered" (ready to publish)
 * or "rejected". Deliberately does no scheduling: slots can only be spread correctly
 * once the whole batch has been prepared and the surviving count is known.
 */
async function prepareVideo(v: VideoPlan): Promise<void> {
  // idempotent: already prepared or published
  if (v.status === "drafted" || v.status === "rendered") return;
  // RESUME: a video that already rendered and passed its gates must NOT be re-gated —
  // it has nothing left to prove and re-running the LLM gates would only spend budget.
  // A video that died at the PUBLISH step (e.g. a rate limit) resumes at publish.
  if (v.renders?.length && v.gates.render?.pass) {
    info(`${v.id} resuming at publish (already rendered + gated)`);
    v.status = "rendered";
    return;
  }

  // 1) dedup gate. Scoped to THIS video: markUsed() below runs before the render, so a
  // video that died between here and a passing render is already in the used ledger and
  // would otherwise be rejected as a duplicate of itself on the retry.
  const claimed = new Set<string>();
  v.gates.dedup = gateDedup(v.questions, claimed, v.id);
  gate(`${v.id} dedup: ${v.gates.dedup.reason}`);
  if (!v.gates.dedup.pass) {
    v.status = "rejected";
    v.reject_reason = "dedup: " + v.gates.dedup.reason;
    return;
  }

  // 2) question validity gate
  const val = await validateQuestions(v.questions);
  v.gates.questions = val.gate;
  gate(`${v.id} question-validity: ${val.gate.reason}`, val.gate.detail);
  if (!val.gate.pass) {
    v.status = "rejected";
    v.reject_reason = "invalid question(s): " + val.gate.reason;
    // QUARANTINE the offending questions. They are not "used" (nothing published),
    // but they must leave the candidate pool or the next video is handed the same
    // item and dies the same way — which is exactly what happened on 2026-08-02,
    // when one question failed twice in one run and cost two slots. Only the
    // questions that actually FAILED are quarantined; the rest of the video's
    // questions were never at fault and go back in the pool.
    //
    // AN UNJUDGED QUESTION IS NOT A FAILED ONE. When no model could be reached the
    // gate holds the question back without forming an opinion about it (gates.ts,
    // QVerdict.unjudged). Quarantine is PERMANENT, so treating those as failures
    // would let a single shared-budget 429 storm bury the bank: 28 of 29 questions
    // on 2026-07-25, 20 of 21 on 2026-07-29. The storm costs a day of posting. It
    // must not cost the content.
    const bad = v.questions.filter((q) => {
      const r = val.results[q.sig];
      return r && !r.valid && !r.unjudged;
    });
    markRejected(v.id, bad, Object.fromEntries(bad.map((q) => [q.sig, val.results[q.sig]?.reason ?? ""])));
    return;
  }

  // 3) mark used (only after validity) — the strong never-repeat guarantee
  markUsed(v.id, v.dimension, v.arm, v.questions);

  // 4) copy gate (caption + on-screen)
  v.gates.copy = await gateCopy([
    { label: "caption", text: v.caption },
    { label: "title", text: String(v.props.title ?? "") },
    { label: "subtitle", text: String(v.props.subtitle ?? "") },
    { label: "outro", text: String(v.props.outro ?? "") },
  ]);
  gate(`${v.id} copy: ${v.gates.copy.reason}`);
  if (!v.gates.copy.pass) {
    v.status = "rejected";
    v.reject_reason = "copy gate: " + v.gates.copy.reason;
    return;
  }

  // 5) render — the REAL Short/FullVideo composition, ONE render per platform so
  // each draft carries that platform's SAFE ZONES (TikTok transform vs IG box).
  // VO is synthesized once and shared across the platform renders. Retried once:
  // renderForPlatforms is idempotent (it reuses a good per-platform file), so a
  // retry only re-does what actually failed.
  const renders = await withRetry(`${v.id} render`, RENDER_ATTEMPTS, () => renderForPlatforms(v.id, v.props));
  v.render_path = renders[0]?.path;
  v.renders = renders.map((r) => ({ platform: r.platform, path: r.path, frames: r.frames }));
  v.status = "rendered";

  // 6) render-sanity gate — EVERY platform render must pass (1080x1920 + audio +
  // duration matches the composition's computed frames).
  {
    const problems: string[] = [];
    for (const r of renders) {
      const g = gateRenderSanity(r.path, r.frames);
      if (!g.pass) problems.push(`${r.platform}: ${g.reason}`);
    }
    v.gates.render = problems.length
      ? { pass: false, reason: problems.join("; ") }
      : { pass: true, reason: `ok ${renders.map((r) => r.platform).join("+")} 1080x1920 video+audio` };
  }
  if (!v.gates.render.pass) {
    v.status = "rejected";
    v.reject_reason = "render sanity: " + v.gates.render.reason;
    return;
  }
  v.status = "rendered";
}

/**
 * PUBLISH phase — upload each platform's render, create its Metricool draft, annotate
 * the A/B database. `slotIndex` is the video's position among the batch's ACTUAL
 * survivors (not its planned index), which is what keeps a short batch spread across
 * the window instead of clustered at whichever slots its planned indexes happened to
 * own. Only ever reached by a video that passed every gate.
 */
async function publishVideo(v: VideoPlan, sched: SchedCtx, slotIndex: number): Promise<PlatformDraft[]> {
  if (v.status === "drafted") return []; // idempotent: already published
  const renders = v.renders ?? [];
  if (!renders.length) throw new Error(`${v.id}: no renders recorded — cannot publish`);

  const captionTag = (process.env.HERMES_CAPTION_TAG || "").trim();
  if (captionTag) v.caption = `${captionTag}\n${v.caption}`;

  // The loop only ever publishes to networks the POLICY allows. A paused network
  // (TikTok, right now) takes no slots, so the loop cannot quietly undo a human hold.
  const results: PlatformDraft[] = [];
  for (const r of renders) {
    const platform = r.platform as Network;
    const whenLocal = sched.slot(platform, slotIndex);
    if (!whenLocal) {
      info(`${v.id} ${platform}: no slot allocated (network paused or out of room) — skipping this platform`);
      continue;
    }
    const propsFile = join(CONFIG.RENDERS_DIR, `${v.id}.${platform}.props.json`);
    const renderProps = readJSON<Record<string, unknown>>(propsFile, {});
    const mapped = (v.props as any)?.__mapped ?? {};
    const draft: LoopDraft = await publishAsDraft({
      runId: todayRunId(),
      videoId: v.id,
      index: v.index,
      caption: v.caption,
      hashtagSet: v.hashtag_set,
      questions: v.questions,
      explanations: mapped.explanations ?? [],
      answerLabels: mapped.answerLabels ?? [],
      renderPath: r.path,
      renderProps,
      whenLocal,
      network: platform,
    });
    results.push({
      platform,
      account_id: CONFIG.ACCOUNTS[platform],
      media_url: "",
      media_id: String(draft.id),
      post_id: draft.uuid,
      job_id: String(draft.id),
      scheduled_at: whenLocal,
    });
  }
  if (!results.length) throw new Error(`${v.id}: no network accepted this video (all paused or full)`);

  v.media_url = results[0]?.media_url;
  v.status = "uploaded";
  v.metricool = {
    media_id: results[0]?.media_id,
    // Metricool's STABLE planner uuids. The numeric id is reassigned on every update,
    // so it is deliberately never persisted as a key. uuid is a signed 64-bit int
    // rendered as a string and can be negative — it stays TEXT everywhere.
    uuids: results.map((r) => r.post_id).filter((x): x is string => Boolean(x)),
    permalinks: [],
  };
  v.status = "drafted";
  decision(CONFIG.DRAFT_ONLY ? `AWAITING APPROVAL — draft created ${v.id}` : `SCHEDULED LIVE — ${v.id} publishes at its slot`, {
    dimension: v.dimension,
    arm: v.arm,
    posts: results.map((r) => ({ platform: r.platform, post_id: r.post_id, scheduled_at: r.scheduled_at })),
  });

  try {
    annotateDb(v, results);
  } catch (e) {
    warn(`${v.id} db annotate failed`, { err: e instanceof Error ? e.message : String(e) });
  }
  return results;
}

/** Point one ab-database row at its Metricool planner uuid. */
function setDbPostId(hermesKey: string, metricoolUuid: string): void {
  const db = readJSON<any>(CONFIG.AB_DB, null);
  if (!db || !Array.isArray(db.posts)) return;
  const rec = db.posts.find((p: any) => p._hermes_key === hermesKey);
  if (!rec || rec.metricool_uuid === metricoolUuid) return;
  rec.metricool_uuid = metricoolUuid;
  db.updated_at = new Date().toISOString();
  writeJSONAtomic(CONFIG.AB_DB, db);
}

/** One platform's rendered+uploaded+drafted result (per-platform SAFE ZONES). */
interface PlatformDraft {
  platform: Network;
  account_id: string;
  media_url: string;
  media_id: string;
  post_id: string | null;
  job_id: string;
  /** set only when kickoff is armed (autonomous scheduling); null = draft-only. */
  scheduled_at: string | null;
}

function extractPostIds(payload: any): string[] {
  const ids: string[] = [];
  const walk = (o: any) => {
    if (!o) return;
    if (Array.isArray(o)) return o.forEach(walk);
    if (typeof o === "object") {
      if (o.id) ids.push(String(o.id));
      for (const v of Object.values(o)) if (v && typeof v === "object") walk(v);
    }
  };
  walk(payload);
  return [...new Set(ids)];
}

/**
 * Already-scheduled per-platform times (ISO), so a NEW batch can keep the
 * per-platform gap vs posts a PREVIOUS cycle ALREADY scheduled — the cross-batch
 * collision-awareness the scheduler needs (scheduler.ts nextSlots `avoid`). Without
 * this, a later batch (e.g. a front-runner replication cycle) only spaces itself
 * WITHIN its own batch and can land minutes from a post the original armed cycle
 * already placed. Read-only (GET via listAllPosts); best-effort — a lookup failure
 * returns empty (no worse than the previous behavior). `account_id` maps to a
 * platform via CONFIG.ACCOUNTS so ONLY same-platform times feed each platform's gap.
 */
/**
 * Build this wave's slot allocator from the LIVE Metricool calendar.
 *
 * Two things this fixes over the original version. It asks the posting policy how many
 * slots each network may take, so a paused network (TikTok) simply gets none. And it
 * places the batch on the FIRST DAY WITH ROOM rather than allocating forward from
 * "now" — a run fired on a day whose quota is already spent used to stack its whole
 * batch on top of that day and leave the next one empty, which is exactly how Thursday
 * came to be empty while Wednesday was full.
 */
/**
 * The live Metricool monthly headroom this wave may actually spend.
 *
 * This used to be `Number.MAX_SAFE_INTEGER`, which handed decide() infinite budget and
 * meant the fail-closed guard metricool.ts budget() documents was never once consulted
 * by the autonomous path — the only caller was ops/resume_posting.mjs, a script a human
 * runs by hand. Breaching Metricool's Fair Use ceiling does not return a 429; it puts
 * the brand under manual review, during which nothing can post at all. Sailing into
 * that silently is the one failure this loop cannot recover from on its own.
 *
 * FAILS OPEN ON A LOOKUP ERROR, DELIBERATELY. If Metricool cannot be reached the answer
 * is unknown, not zero, and refusing to post on an unknown would let one API blip cost a
 * whole day. The blind spot is logged at WARN so it is visible rather than assumed.
 */
async function liveHeadroom(rows: McPost[]): Promise<number> {
  const { perDay } = monthlyRecords();
  let b: Awaited<ReturnType<typeof budget>>;
  try {
    b = await budget();
  } catch (e) {
    warn("metricool budget unreadable — scheduling WITHOUT the monthly guard this wave", {
      err: e instanceof Error ? e.message.slice(0, 200) : String(e),
    });
    return Number.MAX_SAFE_INTEGER;
  }
  // Rows already on the calendar and not yet published are spent in every sense that
  // matters; the counter just has not caught up. See exhaustionForecast.
  const nowMs = Date.now();
  const committed = rows.filter((p) => {
    const dt = p.publicationDate?.dateTime;
    if (!dt) return false;
    const ms = instantFromWallClock(dt, p.publicationDate?.timezone || CONFIG.METRICOOL_TZ);
    return Number.isFinite(ms) && ms > nowMs;
  }).length;

  const f = exhaustionForecast(b.used, committed, perDay, localDay(0));
  info("metricool monthly budget", {
    used: b.used, committed, budget: b.budget, headroom: f.headroom,
    per_day: f.perDay, days_left: f.daysLeft, exhausts_on: f.exhaustsOn,
  });
  if (f.headroom <= 0) {
    decision(
      `METRICOOL BUDGET EXHAUSTED — refusing to schedule. ${f.reason}. ` +
        `Posting resumes when the counter rolls over at the start of next month, or sooner if the ` +
        `per-network daily rate is cut. This is the guard failing closed on purpose: the alternative ` +
        `is breaching Fair Use (${b.hardCap}) and having the brand put under manual review.`,
    );
  } else if (f.warn) {
    decision(
      `METRICOOL BUDGET RUNWAY: ${f.daysLeft} day(s) left at ${f.perDay} records/day — the guard starts ` +
        `refusing on ${f.exhaustsOn}. ${f.reason}. Cutting a network or a daily rate is the only lever; ` +
        `see postingPolicy.ts monthlyRecords().`,
    );
  }
  return f.headroom;
}

async function armedSchedule(runId: string, wave: number, count: number): Promise<SchedCtx> {
  const rows = await calendarRows();
  const seed = wave === 0 ? runId : `${runId}-t${wave}`;
  const allowed = await allocatable(await liveHeadroom(rows));
  // Keyed off NETWORKS: a network absent from this map silently gets no slots at
  // all, which in the logs is indistinguishable from a deliberate pause.
  const slots: Record<string, string[]> = Object.fromEntries(NETWORKS.map((n) => [n, [] as string[]]));
  for (const a of allowed) {
    if (a.slots <= 0) continue;
    // a.slots is the per-day cap; the batch itself may legitimately span days, so the
    // request is for the whole batch and planSlots decides how it spreads.
    const plan = planSlots(count, a.network, rows, seed);
    slots[a.network] = plan.times.map(toNaive);
    info(`loop scheduling ${a.network}`, {
      placed: plan.times.length,
      across: plan.spread.map((x) => `${x.day}:${x.placed}`).join(" "),
      first: slots[a.network][0], last: slots[a.network].at(-1),
    });
  }
  return { armed: true, slot: (platform, index) => slots[platform]?.[index] ?? null };
}

function annotateDb(v: VideoPlan, results: PlatformDraft[]): void {
  const db = readJSON<any>(CONFIG.AB_DB, null);
  if (!db || !Array.isArray(db.posts)) return;
  for (const pr of results) {
    const platform = pr.platform;
    const account_id = pr.account_id;
    const metricool_uuid = pr.post_id;
    const key = `hermes:${v.id}:${platform}`;
    const existing = db.posts.find((p: any) => p._hermes_key === key);
    const rec = existing ?? {};
    Object.assign(rec, {
      _hermes_key: key,
      metricool_uuid,
      platform_post_id: null, // drafts have no native id until published
      platform,
      account_id,
      account_handle: "@smartfellafartsmellatest",
      permalink: null,
      caption: v.caption,
      source_video: `hermes-render:${v.id}.${platform}.mp4`,
      media_url_note: "S3 private object (presigned at post time)",
      variant: {
        // NOT AN ARM ANY MORE. Every post is the pinned production format, so these
        // three fields record WHAT SHIPPED rather than which experiment it belonged
        // to; the rollups keyed on them collapse to a single cell, which is the
        // honest shape of a batch that is no longer testing anything.
        family: v.dimension,
        arm: v.arm,
        label: v.arm,
        narration: (v.props as any)?.narration?.mode ?? "none",
        // The ENDING arm this video used (cliffhanger | full-reveal | no-answer),
        // so the dashboard + promotion read-side can see the ending axis directly.
        ending: (v.props as any)?.ending ?? null,
        question_types: v.questions.map((q) => q.tier),
        num_questions: v.questions.length,
        // THE OPENING QUESTION, recorded as what it IS rather than left to be
        // reconstructed later. Prompt length is the only property of question one that
        // measurably tracks the 3-second skip rate (leadPolicy.ts), so it is the
        // evidence the next cycle's promotion step reads. It was recoverable before
        // this — via the usage ledger and the bank — but only for posts whose run
        // records still existed, which is how the account's best reels ended up with no
        // attribution at all. Stamping it costs nothing and makes the loop's own
        // learning independent of archaeology.
        ...leadStamp(v.questions[0]),
      },
      experiment: { dimension: v.dimension, arm: v.arm, rationale: v.rationale, hermes_video_id: v.id },
      hashtag_set: v.hashtag_set,
      post_state: pr.scheduled_at ? "scheduled" : "draft",
      scheduled_at: pr.scheduled_at ?? null,
      metrics: { reach: null, video_views: null, reactions: null, comments: null, shares: null, eng_rate: null, as_of: null, source: "pending" },
      match_confidence: "high",
      notes: CONFIG.DRAFT_ONLY
        ? "Created by the Hermes autonomous loop (DRAFT-ONLY)."
        : "Created by the Hermes autonomous loop and scheduled LIVE (approval gate retired).",
    });
    if (!existing) db.posts.push(rec);
  }
  db.updated_at = new Date().toISOString();
  writeJSONAtomic(CONFIG.AB_DB, db);
}

// The loop's auto-commit identity. Pinned to a BOT here (NOT the box's ambient
// git user) so the daily data commits are never authored as a human's personal
// account — deterministic regardless of box/global git config. (Existing history
// authored under a personal email can't be safely rewritten; only future commits.)
const BOT_NAME = "SFFS Hermes Bot";
const BOT_EMAIL = "deploy@sffs.local";

/**
 * The cycle's commit subject. Pure, and takes the posting mode as an argument rather
 * than reading CONFIG, so the restore path is testable in-process: CONFIG is frozen at
 * import time and an env flip cannot be observed by a test that already imported it.
 */
export function cycleCommitMessage(
  runId: string,
  summary: { drafted: number; rejected: number },
  draftOnly: boolean,
): string {
  const what = draftOnly ? "drafts" : "scheduled live";
  return `hermes: cycle ${runId} — ${summary.drafted} ${what}, ${summary.rejected} rejected [${draftOnly ? "draft-only" : "live"}]`;
}

export function gitCommitPush(runId: string, summary: RunState["summary"]): { committed: boolean; pushed: boolean; note: string } {
  // lead-policy.json is in here for the same reason the other ledgers are: it is the
  // day's DECISION and its evidence, and a decision nobody can go back and read is the
  // failure the previous promotion engine died of. Leaving it uncommitted would also
  // leave the working tree permanently dirty, since the cycle rewrites it every run.
  const candidates = ["ab-testing/ab-database.json", "ab-testing/learnings.json", "ab-testing/proposals.json", "ab-testing/content-defaults.json", "ab-testing/replication.json", "ab-testing/lead-policy.json", "content/ab-test-usage.json", "tools/upload-media.ts", "remotion/hermes", "hermes"];
  // `git add` is ATOMIC over its pathspecs: one path that doesn't exist aborts the
  // whole add (exit 128) and stages NOTHING, after which `git commit` fails with
  // "nothing to commit" on STDOUT — which surfaced as the empty `commit failed: `
  // note on the rebuilt box, where remotion/hermes doesn't exist. Only pass paths
  // that are actually present so a layout difference can't silently stop the daily
  // A/B data from being committed.
  const files = candidates.filter((f) => existsSync(join(CONFIG.REPO_DIR, f)));
  const missing = candidates.filter((f) => !files.includes(f));
  const run = (args: string[]) => spawnSync("git", args, { cwd: CONFIG.REPO_DIR, encoding: "utf8", env: { ...process.env } });
  try {
    if (!files.length) return { committed: false, pushed: false, note: "no data paths present to commit" };
    const add = run(["add", ...files]);
    if (add.status !== 0) return { committed: false, pushed: false, note: "add failed: " + (add.stderr || "").slice(-200) };
    if (missing.length) info("git: skipping absent paths", { missing });
    const status = run(["status", "--porcelain"]).stdout || "";
    if (!status.trim()) return { committed: false, pushed: false, note: "nothing to commit" };
    const msg = cycleCommitMessage(runId, summary, CONFIG.DRAFT_ONLY);
    // -c pins author AND committer identity for THIS commit (belt: also set in box git config).
    const c = run(["-c", `user.name=${BOT_NAME}`, "-c", `user.email=${BOT_EMAIL}`, "commit", "-m", msg]);
    // git reports "nothing to commit" on STDOUT, so fall back to it when stderr is
    // empty — an empty `commit failed: ` note is useless for diagnosis.
    if (c.status !== 0) {
      const why = ((c.stderr || "").trim() || (c.stdout || "").trim() || `exit ${c.status}`).slice(-200);
      return { committed: false, pushed: false, note: "commit failed: " + why };
    }
    // REMOTE SYNC IS OPT-IN. The loop's job here is DURABILITY — get the day's A/B
    // data into a commit. Pushing is a separate concern with a far worse failure
    // mode on this box: the live branch is `hermes-nous`, hundreds of commits
    // divergent from origin/main, so `pull --rebase origin main` replays main's
    // history underneath it. On 2026-07-25 that left the repo DETACHED mid-rebase
    // (working tree reverted to another worker's commit, the day's fix gone from
    // disk) and the follow-on `push origin HEAD:main` pushed the rebase's detached
    // HEAD. Had the rebase succeeded it would instead have published every
    // unpushed local commit to main. Neither is something a content cycle should do.
    if (process.env.HERMES_GIT_PUSH !== "1") {
      return { committed: true, pushed: false, note: "committed locally (push is opt-in via HERMES_GIT_PUSH=1)" };
    }
    const p = run(["push", "origin", `HEAD:${process.env.HERMES_GIT_PUSH_REF || "main"}`]);
    const pushed = p.status === 0;
    return { committed: true, pushed, note: pushed ? "pushed" : "push failed: " + (p.stderr || "").slice(-200) };
  } catch (e) {
    return { committed: false, pushed: false, note: "git error: " + (e instanceof Error ? e.message : String(e)) };
  }
}

export async function runCycle(): Promise<RunState> {
  assertPostState();
  mkdirSync(CONFIG.DATA_DIR, { recursive: true });
  mkdirSync(CONFIG.RUNS_DIR, { recursive: true });
  const runId = process.env.HERMES_RUN_ID || todayRunId();
  const ceiling = CONFIG.VIDEOS_PER_DAY; // most videos (== posts/platform) one day may schedule
  const floor = Math.min(CONFIG.VIDEOS_FLOOR, ceiling); // fewest a healthy cycle must land
  setRunLog(join(CONFIG.DATA_DIR, "runs", `${runId}.log`));

  let state = loadRun(runId) ?? newRun(runId, ceiling);
  state.status = "running";
  saveRun(state);
  info(`=== Hermes cycle ${runId} (floor ${floor}, ceiling ${ceiling}, ${CONFIG.DRAFT_ONLY ? "DRAFT-ONLY" : "LIVE — approval gate retired"}${DRY ? ", DRY_RUN" : ""}) ===`);

  // preflight
  const health = await ping();
  info("LLM ping", health);

  // EVERY configured model, not just the reasoning one — a dead caption model or a dead
  // judge fallback is invisible in the summary line but shows up in what ships.
  const models = await pingConfiguredModels();
  info("LLM models reachable", Object.fromEntries(models.map((m) => [m.role, `${m.model}: ${m.ok ? "ok" : "UNREACHABLE"}`])));

  // The net has to be made of different rope than the thing it is catching.
  const netless = rolesWithoutFallback(CONFIG.MODEL, CONFIG.CAPTION_MODEL, CONFIG.JUDGE_FALLBACK_MODEL);
  if (netless.length) {
    warn(
      `NO CROSS-MODEL FALLBACK for ${netless.join(" + ")}: the fallback is ${CONFIG.JUDGE_FALLBACK_MODEL}, the same ` +
        `model it is meant to rescue, so chat() has nothing to fail over to. One 429 degrades those paths outright.`,
      { fallback: CONFIG.JUDGE_FALLBACK_MODEL, reasoning: CONFIG.MODEL, caption: CONFIG.CAPTION_MODEL },
    );
  }
  const dead = models.filter((m) => !m.ok);
  (state as any).llm_models = models;
  for (const m of dead) {
    decision(
      `MODEL UNREACHABLE — ${m.role} is configured as ${m.model} and did not answer a one-word health check. ` +
        (m.role === "caption"
          ? "Every video this cycle will ship the hardcoded fallback caption instead of a written one."
          : m.role === "judge-fallback"
            ? "The question-validity gate has no second opinion: if the reasoning model is rate-limited, the whole batch is held back."
            : "The cycle cannot plan or judge without it.") +
        ` Error: ${m.error ?? "unknown"}`,
    );
  }

  // KICKOFF + GOAL surfacing (logged every cycle; the read-only dashboard reads
  // these). OFF => draft-only; ARMED => autonomous scheduling in the window.
  const kickoff: KickoffStatus = kickoffStatus();
  (state as any).kickoff = kickoff;
  info(kickoff.armed ? "KICKOFF: ARMED — autonomy ON" : "KICKOFF: OFF — draft-only", { source: kickoff.source, since: kickoff.since, note: kickoff.note });
  try {
    const goal = goalProgress();
    (state as any).goal = goal;
    info("GOAL trajectory", { started: goal.started, views: goal.totals.views, days_left: goal.days_left, on_track_views: goal.pace.on_track_views, note: goal.note });
  } catch (e) {
    warn("goal progress failed (continuing)", { err: e instanceof Error ? e.message : String(e) });
  }

  // 1) do-not-touch snapshot
  try {
    const snap = await snapshotDoNotTouch();
    state.do_not_touch = snap;
    saveRun(state);
  } catch (e) {
    warn("do-not-touch snapshot failed (continuing without draft creation would be unsafe); aborting drafts", {
      err: e instanceof Error ? e.message : String(e),
    });
    state.errors.push("snapshot failed: " + (e instanceof Error ? e.message : String(e)));
  }

  // (a1) reconcile — close the A/B learning loop for the agent's OWN posts: back-fill
  // platform_post_id / permalink / posted_at onto ab-database.json by matching
  // metricool_uuid -> the published post (Metricool GET only; local write only;
  // idempotent). DRAFT-SAFE: reconcile.ts imports zero publish/schedule paths.
  //
  // This runs BEFORE scoring, which is a deliberate change from the Publer era. Publer's
  // analytics reported its own post id, so scoring could fall back to it and attach
  // metrics to a just-published post in the same cycle. Metricool's analytics expose no
  // planner uuid, so the only join is the native platform_post_id — which is precisely
  // what reconcile fills in. Scoring first would cost a day of learning on every post a
  // human published since the last run.
  try {
    (state as any).reconcile = await reconcile();
    saveRun(state);
  } catch (e) {
    warn("reconcile step failed (continuing)", { err: e instanceof Error ? e.message : String(e) });
    state.errors.push("reconcile: " + (e instanceof Error ? e.message : String(e)));
  }

  // (a2) score
  try {
    state.scoring = await pullAndScore();
    saveRun(state);
  } catch (e) {
    warn("scoring step failed (continuing)", { err: e instanceof Error ? e.message : String(e) });
    state.errors.push("score: " + (e instanceof Error ? e.message : String(e)));
  }

  // (a3) PROMOTE WHAT RETAINS — turn the refreshed metrics into the next batch's
  // opening mix. Runs HERE, between scoring and planning, so it always judges on
  // metrics that arrived this cycle and the batch below always uses the verdict.
  //
  // This is the step that closes the loop. The A/B promotion engine that used to sit in
  // this slot was stood down in the exploitation pivot because it compared arms and
  // there are no arms left; nothing replaced it, so measurement stopped turning into a
  // decision. Its real failure was never being invoked at all — so this is a direct
  // call on the cycle's own path, not a skill something has to remember to run, and it
  // records a verdict into the run state on every cycle whether it moved anything or
  // not. See leadPromotion.ts.
  try {
    (state as any).lead_policy = runLeadPromotion(runId);
    saveRun(state);
  } catch (e) {
    warn("lead-opening promotion failed (continuing on an even draw)", { err: e instanceof Error ? e.message : String(e) });
    state.errors.push("lead promotion: " + (e instanceof Error ? e.message : String(e)));
  }

  // Re-read the goal now that scoring has refreshed the LIVE analytics snapshot. The
  // preflight read above ran against the PREVIOUS cycle's numbers, which is fine as a
  // "where we started today" line but is a day stale for the run state, the dashboard
  // and the memory takeaway that all read this field.
  try {
    const goal = goalProgress();
    (state as any).goal = goal;
    info("GOAL trajectory (post-score, live analytics)", {
      views: goal.totals.views,
      per_platform: goal.per_platform.map((p) => `${p.platform}:${p.views}/${p.posts}`).join(" "),
      days_left: goal.days_left,
    });
    saveRun(state);
  } catch (e) {
    warn("goal refresh failed (continuing)", { err: e instanceof Error ? e.message : String(e) });
  }

  // (a4) TOP UP THE BANK, if the runway is short. Before planning, so anything written
  // this cycle is drawable by the batch below rather than a day later.
  //
  // TRIGGERED ON RUNWAY, NOT ON A SCHEDULE. The bank is a fixed resource being consumed
  // daily and the drawable pool is far smaller than the raw count suggests — 660 of
  // 1,544, because the near-duplicate guard has retired every number series and the
  // figure kinds sit outside the pinned format's filter. Generating nightly regardless
  // would burn tokens producing questions nobody needs; generating on the day it runs
  // out is too late, because the gates reject some of what comes back. See generate.ts.
  //
  // The burn is questions, not videos: a video is three, and a video the validity judge
  // REJECTS spends them too (16 planned videos cost 48 questions to ship 8 on
  // 2026-08-01), so the estimate is deliberately the ceiling rather than the floor.
  try {
    const perDay = CONFIG.VIDEOS_PER_DAY * 3;
    (state as any).bank_topup = await topUpBank(perDay);
    saveRun(state);
  } catch (e) {
    // Generation is an optimiser. A cycle that cannot generate still posts today's
    // videos from the stock it has, and posts fewer tomorrow — it never repeats.
    warn("bank top-up failed (continuing on existing stock)", { err: e instanceof Error ? e.message : String(e) });
    state.errors.push("bank top-up: " + (e instanceof Error ? e.message : String(e)));
  }

  // (b) plan wave 1 at the CEILING. Planning the ceiling rather than the floor is
  // the OVERSAMPLE: gate rejections and transient failures come out of the headroom
  // instead of out of the day's floor. It cannot breach the per-day/platform cap —
  // only a video that clears every gate becomes a post.
  //
  // WHEN THE BANK RUNS THIN THIS SHIPS FEWER VIDEOS, and that is the designed
  // behaviour rather than a shortfall to paper over: candidateQuestions() filters
  // against the used-sigs ledger, so the loop CANNOT re-serve a published question.
  // Degrading to a smaller batch is the graceful end of that guarantee; repeating
  // would be the failure it exists to prevent.
  if (!state.videos.length) {
    state.videos = await planBatch(runId, ceiling);
    state.summary.planned = state.videos.length;
    saveRun(state);
  }

  const draftedCount = (): number => state.videos.filter((v) => v.status === "drafted").length;
  // Videos this PROCESS has already put through PREPARE. A failure inside one wave
  // must not be retried by the next (its questions may already be marked used, so a
  // retry would only dedup-reject); topping up with FRESH videos is the real remedy.
  // A brand-new invocation starts empty, so resuming a run still retries them.
  const attempted = new Set<string>();

  for (let wave = 0; wave < MAX_WAVES; wave++) {
    // ── PREPARE: gates + render for everything still pending ──────────────────
    for (const v of state.videos) {
      if (v.status === "drafted" || v.status === "rejected" || v.status === "rendered") continue;
      if (attempted.has(v.id)) continue;
      attempted.add(v.id);
      try {
        await prepareVideo(v);
      } catch (e) {
        v.status = "failed";
        v.errors = [...(v.errors ?? []), e instanceof Error ? e.message : String(e)];
        error(`${v.id} FAILED`, { err: v.errors.at(-1) });
      }
      saveRun(state);
    }

    // ── PUBLISH: slots sized to the SURVIVORS, handed out in order ─────────────
    // Hold back anything over the ceiling: a resumed run can arrive with more
    // rendered videos than the day has room for (renders are cheap to keep, posts
    // are capped), and the per-day/platform cap is a hard promise.
    const rendered = state.videos.filter((v) => v.status === "rendered");
    const room = Math.max(0, ceiling - draftedCount());
    const ready = rendered.slice(0, room);
    if (rendered.length > ready.length) {
      info("holding videos back at the daily ceiling", { rendered: rendered.length, publishing: ready.length, ceiling });
    }
    if (ready.length && !DRY) {
      const sched = kickoff.armed ? await armedSchedule(runId, wave, ready.length) : DRAFT_ONLY_SCHED;
      for (let i = 0; i < ready.length; i++) {
        const v = ready[i];
        try {
          // Metricool returns the planner uuid synchronously from the create, so there is
          // nothing left to resolve afterwards. Publer's job payload carried no post ids,
          // which is why this used to collect a pending list and page for them.
          await publishVideo(v, sched, i);
        } catch (e) {
          v.status = "failed";
          v.errors = [...(v.errors ?? []), e instanceof Error ? e.message : String(e)];
          error(`${v.id} FAILED`, { err: v.errors.at(-1) });
        }
        saveRun(state);
        // Pace the writes. A full batch is ~4 API calls per video back to
        // back; unpaced, that rate-limited the account mid-batch on 2026-07-25.
        if (i + 1 < ready.length) await sleep(PUBLISH_PACE_MS);
      }
      saveRun(state);
    } else if (ready.length && DRY) {
      info(`DRY_RUN: ${ready.length} video(s) passed every gate; skipping upload + draft`);
      break;
    }

    // ── TOP UP: only if the day is still under the floor and the ceiling allows ─
    const have = draftedCount();
    if (have >= floor || have >= ceiling || wave + 1 >= MAX_WAVES) {
      if (have < floor) {
        warn("cycle finished UNDER the daily floor", { drafted: have, floor, ceiling, waves: wave + 1 });
      }
      break;
    }
    const want = Math.min(floor - have + TOPUP_SLACK, ceiling - have);
    info("below daily floor — planning a top-up wave", { drafted: have, floor, want, wave: wave + 2 });
    const extra = await planBatch(`${runId}-t${wave + 1}`, want);
    if (!extra.length) {
      warn("top-up produced no videos (bank or dimension catalog exhausted)", { drafted: have, floor });
      break;
    }
    const base = state.videos.length; // keep indexes unique across waves (cover rotation reads them)
    extra.forEach((e, i) => (e.index = base + i));
    state.videos.push(...extra);
    state.summary.planned = state.videos.length;
    saveRun(state);
  }

  // summary
  state.summary.drafted = state.videos.filter((v) => v.status === "drafted").length;
  state.summary.rejected = state.videos.filter((v) => v.status === "rejected").length;
  state.summary.failed = state.videos.filter((v) => v.status === "failed").length;

  // 2) verify do-not-touch
  if (!DRY && state.do_not_touch.captured_at) {
    try {
      await verifyDoNotTouch(state.do_not_touch);
      state.scoring.note = (state.scoring.note ?? "") + " | do-not-touch verified";
    } catch (e) {
      state.errors.push("VERIFY: " + (e instanceof Error ? e.message : String(e)));
      error("do-not-touch verification FAILED", { err: e instanceof Error ? e.message : String(e) });
    }
  }

  // 3) commit the day's data files LOCALLY (push is opt-in; see gitCommitPush).
  // HERMES_SKIP_GIT=1 disables the commit entirely. The hermes-nous build wrapper
  // (bridge/cycle.ts / sffs_cycle) ALWAYS sets it, so a cycle run from the isolated
  // sandbox can never touch git at all.
  const SKIP_GIT = process.env.HERMES_SKIP_GIT === "1";
  if (!DRY && !SKIP_GIT) {
    const git = gitCommitPush(runId, state.summary);
    (state as any).git = git;
    info("git", git);
  } else if (SKIP_GIT) {
    (state as any).git = { committed: false, pushed: false, note: "skipped (HERMES_SKIP_GIT=1)" };
    info("git", (state as any).git);
  }

  // ── DEGRADATION, COUNTED BEFORE THE VERDICT ────────────────────────────────
  // A cycle that shipped template captions and skipped its judge produces exactly the
  // same drafted/rejected/failed line as a healthy one. That is not a reporting nicety:
  // on 2026-08-03 twelve videos went out unjudged behind a clean-looking summary and it
  // took a day to notice. These counters are the difference, and a non-zero one costs
  // the run its "success" so the dashboard chip stops saying everything is fine.
  const degraded = summarizeDegradation(state.videos, llmUsageReport().total.failedCalls);
  state.summary.degraded = degraded;
  const unjudged = degraded.caption_fallbacks + degraded.copy_gate_unjudged + degraded.questions_unjudged;
  if (unjudged > 0 || degraded.llm_failed_calls > 0) {
    error(
      `LLM DEGRADED — ${degraded.llm_failed_calls} gateway call(s) failed after retries; ` +
        `${degraded.caption_fallbacks} caption(s) fell back to the hardcoded template, ` +
        `${degraded.copy_gate_unjudged} copy gate(s) and ${degraded.questions_unjudged} validity gate(s) ` +
        `reached a verdict with no model behind it. Those videos shipped UNJUDGED.`,
      degraded,
    );
    state.errors.push(
      `llm degraded: ${degraded.llm_failed_calls} failed call(s), ${degraded.caption_fallbacks} template caption(s), ` +
        `${degraded.copy_gate_unjudged} unjudged copy gate(s), ${degraded.questions_unjudged} unjudged validity gate(s)`,
    );
  }

  state.status = state.summary.failed > 0 || state.errors.length ? (state.summary.drafted > 0 ? "partial" : "failed") : "success";

  // (P3) memory hygiene: append a bounded one-line takeaway to MEMORY.md so the
  // agent keeps the narrative (not just the numbers) across cycles. Best-effort —
  // a memory note must NEVER break a cycle.
  try {
    const learn = readJSON<any>(CONFIG.LEARNINGS, {});
    const rec = (state as any).reconcile;
    const bank = bankStats();
    const line = formatTakeaway({
      run_id: runId,
      drafted: state.summary.drafted,
      rejected: state.summary.rejected,
      failed: state.summary.failed,
      format: learn?.pinned_format?.arm ?? null,
      liveViews: (state as any).goal?.totals?.views ?? null,
      freshQuestions: bank.fresh,
      quarantined: bank.quarantined,
      reconciled: rec && typeof rec.records_changed === "number" ? rec.records_changed : null,
    });
    const mem = appendTakeaway(line);
    (state as any).memory = { appended: mem.ok, path: mem.path, line };
    info("memory takeaway", (state as any).memory);
  } catch (e) {
    warn("memory takeaway failed (continuing)", { err: e instanceof Error ? e.message : String(e) });
  }

  // What this cycle actually spent at the gateway, per model. Recorded on the run so
  // "is the agent thinking, or just running deterministic paths?" is answerable from
  // the run state instead of from an afternoon of log archaeology.
  (state as any).llm = logLlmUsage();

  state.finished_at = new Date().toISOString();
  saveRun(state);
  info(
    `=== cycle ${runId} done: ${state.summary.drafted} drafted, ${state.summary.rejected} rejected, ` +
      `${state.summary.failed} failed` +
      (unjudged > 0 || degraded.llm_failed_calls > 0
        ? `, DEGRADED (${degraded.llm_failed_calls} failed llm call(s), ${degraded.caption_fallbacks} template caption(s), ` +
          `${degraded.copy_gate_unjudged + degraded.questions_unjudged} unjudged gate(s))`
        : "") +
      " ===",
  );
  return state;
}

// Run as CLI
const invokedDirectly = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  runCycle()
    .then((s) => process.exit(s.status === "failed" ? 1 : 0))
    .catch((e) => {
      error("cycle crashed", { err: e instanceof Error ? e.stack : String(e) });
      process.exit(1);
    });
}
