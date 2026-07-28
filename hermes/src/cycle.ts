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
import { CONFIG, assertDraftOnly } from "./config.ts";
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
import { nextSlots, WINDOW_OPEN_HOUR, WINDOW_CLOSE_HOUR } from "./scheduler.ts";
import { goalProgress } from "./goal.ts";
import { pullAndScore } from "./score.ts";
import { reconcile } from "./reconcile.ts";
import { planBatch } from "./design.ts";
import { gateDedup, validateQuestions, gateCopy, gateRenderSanity } from "./gates.ts";
import { markUsed, bankStats } from "./questions.ts";
import { appendTakeaway, formatTakeaway } from "./memory.ts";
import { renderForPlatforms } from "./render.ts";
import { uploadToS3 } from "./s3.ts";
// Publishing goes through Metricool, reusing the modules the controlled path already
// proved against the live account.
import { publishAsDraft, planSlots, calendarRows, allocatable, type LoopDraft } from "./loopPublish.ts";
import { NETWORKS, type Network } from "./postingPolicy.ts";
import { toNaive } from "./approval.ts";
import { ping } from "./llm.ts";
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
 * PREPARE phase — every gate plus the render, i.e. everything that can reject or
 * fail a video WITHOUT touching the board. Ends at status "rendered" (ready to publish)
 * or "rejected". Deliberately does no scheduling: slots can only be spread correctly
 * once the whole batch has been prepared and the surviving count is known.
 */
async function prepareVideo(v: VideoPlan): Promise<void> {
  // idempotent: already prepared or published
  if (v.status === "drafted" || v.status === "rendered") return;
  // RESUME: a video that already rendered and passed its gates must NOT be re-gated.
  // markUsed() runs BEFORE the render, so its questions are already in the used
  // ledger and the dedup gate below would now reject the video against itself. A
  // video that died at the PUBLISH step (e.g. a rate limit) therefore has to
  // resume at publish, not from the top.
  if (v.renders?.length && v.gates.render?.pass) {
    info(`${v.id} resuming at publish (already rendered + gated)`);
    v.status = "rendered";
    return;
  }

  // 1) dedup gate
  const claimed = new Set<string>();
  v.gates.dedup = gateDedup(v.questions, claimed);
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
    return; // questions NOT marked used -> stay available
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
  decision(`AWAITING APPROVAL — draft created ${v.id}`, {
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
async function armedSchedule(runId: string, wave: number, count: number): Promise<SchedCtx> {
  const rows = await calendarRows();
  const seed = wave === 0 ? runId : `${runId}-t${wave}`;
  const allowed = await allocatable(Number.MAX_SAFE_INTEGER);
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
        family: v.dimension,
        arm: v.arm,
        // Canonical arm ROLLUP LABEL (== v.arm) — the key score.ts aggregates
        // by_variant_arm on, and the key the default-promotion engine compares
        // against the incumbent "control". Kept explicit so a future arm rename
        // never silently breaks the promotion read-side.
        label: v.arm,
        narration: (v.props as any)?.narration?.mode ?? "none",
        // The ENDING arm this video used (cliffhanger | full-reveal | no-answer),
        // so the dashboard + promotion read-side can see the ending axis directly.
        ending: (v.props as any)?.ending ?? null,
        question_types: v.questions.map((q) => q.tier),
        num_questions: v.questions.length,
      },
      experiment: { dimension: v.dimension, arm: v.arm, rationale: v.rationale, hermes_video_id: v.id },
      hashtag_set: v.hashtag_set,
      post_state: pr.scheduled_at ? "scheduled" : "draft",
      scheduled_at: pr.scheduled_at ?? null,
      metrics: { reach: null, video_views: null, reactions: null, comments: null, shares: null, eng_rate: null, as_of: null, source: "pending" },
      match_confidence: "high",
      notes: "Created by the Hermes autonomous loop (DRAFT-ONLY).",
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

export function gitCommitPush(runId: string, summary: RunState["summary"]): { committed: boolean; pushed: boolean; note: string } {
  const candidates = ["ab-testing/ab-database.json", "ab-testing/learnings.json", "ab-testing/proposals.json", "ab-testing/content-defaults.json", "ab-testing/replication.json", "content/ab-test-usage.json", "tools/upload-media.ts", "remotion/hermes", "hermes"];
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
    const msg = `hermes: cycle ${runId} — ${summary.drafted} drafts, ${summary.rejected} rejected [draft-only]`;
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
  assertDraftOnly();
  mkdirSync(CONFIG.DATA_DIR, { recursive: true });
  mkdirSync(CONFIG.RUNS_DIR, { recursive: true });
  const runId = process.env.HERMES_RUN_ID || todayRunId();
  const ceiling = CONFIG.VIDEOS_PER_DAY; // most videos (== posts/platform) one day may schedule
  const floor = Math.min(CONFIG.VIDEOS_FLOOR, ceiling); // fewest a healthy cycle must land
  setRunLog(join(CONFIG.DATA_DIR, "runs", `${runId}.log`));

  let state = loadRun(runId) ?? newRun(runId, ceiling);
  state.status = "running";
  saveRun(state);
  info(`=== Hermes cycle ${runId} (floor ${floor}, ceiling ${ceiling}, DRAFT-ONLY${DRY ? ", DRY_RUN" : ""}) ===`);

  // preflight
  const health = await ping();
  info("LLM ping", health);

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

  // (b) plan wave 1 at the CEILING. Planning the ceiling rather than the floor is
  // the OVERSAMPLE: gate rejections and transient failures come out of the headroom
  // instead of out of the day's floor. It cannot breach the per-day/platform cap —
  // only a video that clears every gate becomes a post.
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

  state.status = state.summary.failed > 0 || state.errors.length ? (state.summary.drafted > 0 ? "partial" : "failed") : "success";

  // (P3) memory hygiene: append a bounded one-line takeaway to MEMORY.md so the
  // agent keeps the narrative (not just the numbers) across cycles. Best-effort —
  // a memory note must NEVER break a cycle.
  try {
    const learn = readJSON<any>(CONFIG.LEARNINGS, {});
    const rec = (state as any).reconcile;
    const line = formatTakeaway({
      run_id: runId,
      drafted: state.summary.drafted,
      rejected: state.summary.rejected,
      failed: state.summary.failed,
      frontFamily: learn?.front_runners?.variant_family ?? null,
      frontTimeBucket: learn?.front_runners?.time_bucket ?? null,
      freshQuestions: bankStats().fresh,
      reconciled: rec && typeof rec.records_changed === "number" ? rec.records_changed : null,
    });
    const mem = appendTakeaway(line);
    (state as any).memory = { appended: mem.ok, path: mem.path, line };
    info("memory takeaway", (state as any).memory);
  } catch (e) {
    warn("memory takeaway failed (continuing)", { err: e instanceof Error ? e.message : String(e) });
  }

  state.finished_at = new Date().toISOString();
  saveRun(state);
  info(`=== cycle ${runId} done: ${state.summary.drafted} drafted, ${state.summary.rejected} rejected, ${state.summary.failed} failed ===`);
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
