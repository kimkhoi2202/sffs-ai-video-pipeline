/**
 * cycle.ts — the once-per-~24h autonomous DRAFT-ONLY cycle. Idempotent + resumable
 * (re-running the same run_id skips completed per-video steps). Every decision +
 * gate result is logged and persisted to the run state for the dashboard.
 *
 * Flow:
 *   0. preflight (assert draft-only, LLM ping, bank stats)
 *   1. snapshot do-not-touch (existing scheduled + published posts)
 *   (a) pull matured analytics + score + update learnings
 *   (b) plan the batch (up to N videos, each a different A/B dimension)
 *   for each video: dedup gate -> question-validity gate -> mark used ->
 *                   copy gate -> render (Short/FullVideo, ONE per platform with
 *                   its own SAFE ZONES) -> render-sanity gate -> per platform:
 *                   S3 upload -> Publer media import -> createDraftOnly ->
 *                   annotate ab-database
 *   2. verify do-not-touch untouched (proves nothing went live)
 *   3. commit + push data files (best-effort)
 *
 * NOTHING here can publish or schedule. See guardrails.ts / config.ts.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
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
import { snapshotDoNotTouch, verifyDoNotTouch, createDraftOnly } from "./guardrails.ts";
import { kickoffStatus, type KickoffStatus } from "./kickoff.ts";
import { nextSlots } from "./scheduler.ts";
import { goalProgress } from "./goal.ts";
import { pullAndScore } from "./score.ts";
import { reconcile } from "./reconcile.ts";
import { planBatch } from "./design.ts";
import { gateDedup, validateQuestions, gateCopy, gateRenderSanity } from "./gates.ts";
import { markUsed, bankStats } from "./questions.ts";
import { appendTakeaway, formatTakeaway } from "./memory.ts";
import { renderForPlatforms } from "./render.ts";
import { uploadToS3 } from "./s3.ts";
import { importMediaFromUrl, pollJob, listAllPosts, postId } from "./publer.ts";
import { ping } from "./llm.ts";
import { readJSON, writeJSONAtomic } from "./state.ts";

const DRY = process.env.HERMES_DRY_RUN === "1";

/**
 * Per-cycle scheduling context. OFF (default) => draft-only: every video takes the
 * unchanged createDraftOnly path. ARMED (human kickoff) => each platform draft is
 * ALSO scheduled at a policy time (scheduler.ts) via the gated kickoff_schedule.ts.
 */
interface SchedCtx {
  armed: boolean;
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

async function draftForVideo(v: VideoPlan, sched: SchedCtx = DRAFT_ONLY_SCHED): Promise<void> {
  // idempotent: already drafted
  if (v.status === "drafted") return;

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
  // VO is synthesized once and shared across the platform renders.
  const renders = renderForPlatforms(v.id, v.props);
  v.render_path = renders[0]?.path;
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

  if (DRY) {
    info(`${v.id} DRY_RUN: gates passed; skipping upload + draft`);
    v.status = "rendered";
    return;
  }

  // Optional run/validation TAG on the DRAFT caption (env-gated). The live VPS
  // loop leaves HERMES_CAPTION_TAG unset, so real captions are unchanged
  // (behavior-preserving). A supervised hermes-nous validation run sets it (e.g.
  // "[hermes-nous validation]") so the created DRAFTS are clearly labeled and
  // trivial for a human to find + delete. Applied AFTER the copy gate so it can
  // never affect a gate decision, and reflected in the ab-database annotation.
  const captionTag = (process.env.HERMES_CAPTION_TAG || "").trim();
  if (captionTag) v.caption = `${captionTag}\n${v.caption}`;

  // 7-8) per platform: upload its OWN safe-zone render to S3, import the media,
  // and create a DRAFT on that platform's account only (createDraftOnly forces
  // state="draft"; the loop can never publish/schedule). Each platform draft thus
  // carries the render made for that platform's UI-safe zones.
  const results: PlatformDraft[] = [];
  for (const r of renders) {
    const platform = r.platform as "instagram" | "tiktok";
    const account_id = CONFIG.ACCOUNTS[platform];
    const key = `hermes/${todayRunId()}/${v.id}.${platform}.mp4`;
    const url = uploadToS3(r.path, key);
    const { mediaId } = await importMediaFromUrl(url, `${v.id}.${platform}.mp4`);
    // KICKOFF gate: OFF => createDraftOnly (unchanged draft-only path). ARMED =>
    // schedule at a policy time via the gated kickoff_schedule.ts (dynamic-imported
    // ONLY here, so the OFF loop never even loads a module that can schedule).
    let jobId: string;
    let scheduled_at: string | null = null;
    if (sched.armed) {
      scheduled_at = sched.slot(platform, v.index);
      if (!scheduled_at) throw new Error(`no schedule slot for ${platform}#${v.index}`);
      const { createScheduledPostArmed } = await import("./kickoff_schedule.ts");
      jobId = await createScheduledPostArmed({ account_ids: [account_id], text: v.caption, media_ids: [mediaId], type: "video" }, scheduled_at);
    } else {
      jobId = await createDraftOnly({ account_ids: [account_id], text: v.caption, media_ids: [mediaId], type: "video" });
    }
    const job = await pollJob(jobId, { label: `create-${sched.armed ? "scheduled" : "draft"}-${platform}`, timeoutMs: 180_000 });
    // Publer's job_status returns only {status:"complete"} (no post ids), so resolve
    // the created draft post id by matching the (unique) uploaded media id.
    let postIds = extractPostIds(job.payload);
    if (!postIds.length) postIds = await findDraftPostIds(mediaId);
    results.push({ platform, account_id, media_url: url, media_id: mediaId, post_id: postIds[0] ?? null, job_id: jobId, scheduled_at });
  }
  v.media_url = results[0]?.media_url;
  v.status = "uploaded";
  v.publer = {
    job_id: results[0]?.job_id,
    media_id: results[0]?.media_id,
    post_ids: results.map((r) => r.post_id).filter((x): x is string => Boolean(x)),
    permalinks: [],
  };
  v.status = "drafted";
  const anyScheduled = results.some((r) => r.scheduled_at);
  decision(`${anyScheduled ? "SCHEDULED (kickoff armed)" : "DRAFT"} created ${v.id}`, {
    dimension: v.dimension,
    arm: v.arm,
    posts: results.map((r) => ({ platform: r.platform, post_id: r.post_id, scheduled_at: r.scheduled_at })),
  });

  // 9) annotate ab-database.json per platform (best-effort; draft success is what matters)
  try {
    annotateDb(v, results);
  } catch (e) {
    warn(`${v.id} db annotate failed`, { err: e instanceof Error ? e.message : String(e) });
  }
}

/** One platform's rendered+uploaded+drafted result (per-platform SAFE ZONES). */
interface PlatformDraft {
  platform: "instagram" | "tiktok";
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
 * Resolve the draft post ids created for an uploaded media. Publer's job_status
 * payload contains no post ids, so we match the (unique-per-video) media id against
 * the current draft list. Returns one id per account (e.g. TikTok + Instagram).
 */
async function findDraftPostIds(mediaId: string): Promise<string[]> {
  try {
    const drafts = await listAllPosts("draft", 5);
    return drafts
      .filter((p: any) => Array.isArray(p.media) && p.media.some((m: any) => String(m?.id) === String(mediaId)))
      .map(postId)
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Already-scheduled per-platform Publer times (ISO), so a NEW batch can keep the
 * per-platform gap vs posts a PREVIOUS cycle ALREADY scheduled — the cross-batch
 * collision-awareness the scheduler needs (scheduler.ts nextSlots `avoid`). Without
 * this, a later batch (e.g. a front-runner replication cycle) only spaces itself
 * WITHIN its own batch and can land minutes from a post the original armed cycle
 * already placed. Read-only (GET via listAllPosts); best-effort — a lookup failure
 * returns empty (no worse than the previous behavior). Publer `account_id` maps to a
 * platform via CONFIG.ACCOUNTS so ONLY same-platform times feed each platform's gap.
 */
async function scheduledTimesByPlatform(): Promise<Record<"instagram" | "tiktok", string[]>> {
  const byPlat: Record<"instagram" | "tiktok", string[]> = { instagram: [], tiktok: [] };
  try {
    const accountToPlatform = new Map<string, "instagram" | "tiktok">(
      (Object.entries(CONFIG.ACCOUNTS) as ["instagram" | "tiktok", string][]).map(([plat, acct]) => [String(acct), plat]),
    );
    for (const p of await listAllPosts("scheduled")) {
      const at = (p as any)?.scheduled_at;
      const plat = accountToPlatform.get(String((p as any)?.account_id));
      if (at && plat) byPlat[plat].push(String(at));
    }
  } catch (e) {
    warn("scheduled-times lookup failed — scheduling without cross-batch avoidance", {
      err: e instanceof Error ? e.message : String(e),
    });
  }
  return byPlat;
}

function annotateDb(v: VideoPlan, results: PlatformDraft[]): void {
  const db = readJSON<any>(CONFIG.AB_DB, null);
  if (!db || !Array.isArray(db.posts)) return;
  for (const pr of results) {
    const platform = pr.platform;
    const account_id = pr.account_id;
    const publer_post_id = pr.post_id;
    const key = `hermes:${v.id}:${platform}`;
    const existing = db.posts.find((p: any) => p._hermes_key === key);
    const rec = existing ?? {};
    Object.assign(rec, {
      _hermes_key: key,
      publer_post_id,
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

function gitCommitPush(runId: string, summary: RunState["summary"]): { committed: boolean; pushed: boolean; note: string } {
  const files = ["ab-testing/ab-database.json", "ab-testing/learnings.json", "ab-testing/proposals.json", "ab-testing/content-defaults.json", "content/ab-test-usage.json", "tools/upload-media.ts", "remotion/hermes", "hermes"];
  const run = (args: string[]) => spawnSync("git", args, { cwd: CONFIG.REPO_DIR, encoding: "utf8", env: { ...process.env } });
  try {
    run(["add", ...files]);
    const status = run(["status", "--porcelain"]).stdout || "";
    if (!status.trim()) return { committed: false, pushed: false, note: "nothing to commit" };
    const msg = `hermes: cycle ${runId} — ${summary.drafted} drafts, ${summary.rejected} rejected [draft-only]`;
    // -c pins author AND committer identity for THIS commit (belt: also set in box git config).
    const c = run(["-c", `user.name=${BOT_NAME}`, "-c", `user.email=${BOT_EMAIL}`, "commit", "-m", msg]);
    if (c.status !== 0) return { committed: false, pushed: false, note: "commit failed: " + (c.stderr || "").slice(-200) };
    run(["pull", "--rebase", "origin", "main"]);
    const p = run(["push", "origin", "HEAD:main"]);
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
  const target = CONFIG.VIDEOS_PER_DAY;
  setRunLog(join(CONFIG.DATA_DIR, "runs", `${runId}.log`));

  let state = loadRun(runId) ?? newRun(runId, target);
  state.status = "running";
  saveRun(state);
  info(`=== Hermes cycle ${runId} (target ${target}, DRAFT-ONLY${DRY ? ", DRY_RUN" : ""}) ===`);

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

  // (a) score
  try {
    state.scoring = await pullAndScore();
    saveRun(state);
  } catch (e) {
    warn("scoring step failed (continuing)", { err: e instanceof Error ? e.message : String(e) });
    state.errors.push("score: " + (e instanceof Error ? e.message : String(e)));
  }

  // (a2) reconcile — close the A/B learning loop for the agent's OWN posts:
  // back-fill platform_post_id / permalink / posted_at onto ab-database.json by
  // matching publer_post_id -> the native post (Publer GET only; local write only;
  // idempotent). Runs after scoring so each cycle folds in whatever a human has
  // since published. DRAFT-SAFE: reconcile.ts imports zero publish/schedule paths.
  try {
    (state as any).reconcile = await reconcile();
    saveRun(state);
  } catch (e) {
    warn("reconcile step failed (continuing)", { err: e instanceof Error ? e.message : String(e) });
    state.errors.push("reconcile: " + (e instanceof Error ? e.message : String(e)));
  }

  // (b) plan
  if (!state.videos.length) {
    state.videos = await planBatch(runId, target);
    state.summary.planned = state.videos.length;
    saveRun(state);
  }

  // KICKOFF: OFF => draft-only (unchanged). ARMED => build per-platform jittered
  // schedule slots (7am-1am CST window) so each draft is auto-scheduled. DRY never
  // schedules (renders/gates only). Nothing here can publish "now".
  let sched: SchedCtx = DRAFT_ONLY_SCHED;
  if (kickoff.armed && !DRY) {
    const n = state.videos.length;
    // Collision-awareness: read the per-platform times a PREVIOUS cycle already
    // scheduled so THIS batch keeps the per-platform gap vs them too (not only within
    // its own batch). Without this, a replication batch could land minutes from a post
    // the original armed cycle already scheduled (scheduler.ts nextSlots `avoid`).
    const already = await scheduledTimesByPlatform();
    const slots: Record<string, string[]> = {
      instagram: nextSlots(n, { seed: runId, platform: "instagram", avoid: already.instagram }),
      tiktok: nextSlots(n, { seed: runId, platform: "tiktok", avoid: already.tiktok }),
    };
    sched = { armed: true, slot: (platform, index) => slots[platform]?.[index] ?? null };
    info("KICKOFF ARMED — autonomous scheduling ON", {
      videos: n,
      window: "7:00am-1:00am America/Chicago",
      avoiding: { instagram: already.instagram.length, tiktok: already.tiktok.length },
      first: { instagram: slots.instagram[0], tiktok: slots.tiktok[0] },
    });
  }

  // per-video pipeline (resume-safe)
  for (const v of state.videos) {
    if (v.status === "drafted" || v.status === "rejected") continue;
    try {
      await draftForVideo(v, sched);
    } catch (e) {
      v.status = "failed";
      v.errors = [...(v.errors ?? []), e instanceof Error ? e.message : String(e)];
      error(`${v.id} FAILED`, { err: v.errors.at(-1) });
    }
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

  // 3) commit + push data files.
  // HERMES_SKIP_GIT=1 disables the commit/push entirely. The hermes-nous build
  // wrapper (bridge/cycle.ts / sffs_cycle) ALWAYS sets it, so a cycle run from the
  // isolated sandbox can NEVER `git push origin HEAD:main`. The live loop leaves it
  // unset and commits/pushes exactly as before — behavior-preserving.
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
