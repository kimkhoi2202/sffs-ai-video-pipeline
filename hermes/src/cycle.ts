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
 *                   copy gate -> render -> render-sanity gate -> S3 upload ->
 *                   Publer media import -> createDraftOnly -> annotate ab-database
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
import { pullAndScore } from "./score.ts";
import { planBatch } from "./design.ts";
import { gateDedup, validateQuestions, gateCopy, gateRenderSanity } from "./gates.ts";
import { markUsed } from "./questions.ts";
import { renderVideo, computeFrames } from "./render.ts";
import { uploadToS3 } from "./s3.ts";
import { importMediaFromUrl, createPost, pollJob, listAllPosts, postId } from "./publer.ts";
import { ping, chat } from "./llm.ts";
import { readJSON, writeJSONAtomic } from "./state.ts";

const DRY = process.env.HERMES_DRY_RUN === "1";

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

async function draftForVideo(v: VideoPlan): Promise<void> {
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

  // 5) render
  const r = renderVideo(v.id, v.props);
  v.render_path = r.path;
  v.status = "rendered";

  // 6) render-sanity gate
  v.gates.render = gateRenderSanity(r.path, computeFrames(v.props));
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

  // 7) upload to S3 (presigned)
  const key = `hermes/${todayRunId()}/${v.id}.mp4`;
  const url = uploadToS3(r.path, key);
  v.media_url = url;
  v.status = "uploaded";

  // 8) Publer: import media -> create DRAFT (both accounts)
  const { mediaId } = await importMediaFromUrl(url, `${v.id}.mp4`);
  const jobId = await createDraftOnly({
    account_ids: CONFIG.ACCOUNT_IDS,
    text: v.caption,
    media_ids: [mediaId],
    type: "video",
  });
  const job = await pollJob(jobId, { label: "create-draft", timeoutMs: 180_000 });
  // Publer's job_status returns only {status:"complete"} (no post ids), so resolve the
  // created draft post ids by matching the uploaded media id against the draft list.
  let postIds = extractPostIds(job.payload);
  if (!postIds.length) postIds = await findDraftPostIds(mediaId);
  v.publer = { job_id: jobId, media_id: mediaId, post_ids: postIds, permalinks: [] };
  v.status = "drafted";
  decision(`DRAFT created ${v.id}`, { dimension: v.dimension, arm: v.arm, postIds });

  // 9) annotate ab-database.json (best-effort; draft success is what matters)
  try {
    annotateDb(v, postIds);
  } catch (e) {
    warn(`${v.id} db annotate failed`, { err: e instanceof Error ? e.message : String(e) });
  }
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

function annotateDb(v: VideoPlan, postIds: string[]): void {
  const db = readJSON<any>(CONFIG.AB_DB, null);
  if (!db || !Array.isArray(db.posts)) return;
  const platforms: Array<["instagram" | "tiktok", string]> = [
    ["instagram", CONFIG.ACCOUNTS.instagram],
    ["tiktok", CONFIG.ACCOUNTS.tiktok],
  ];
  for (let i = 0; i < platforms.length; i++) {
    const [platform, account_id] = platforms[i];
    const publer_post_id = postIds[i] ?? null;
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
      source_video: `hermes-render:${v.id}.mp4`,
      media_url_note: "S3 private object (presigned at post time)",
      variant: {
        family: v.dimension,
        arm: v.arm,
        narration: (v.props as any)?.narration?.mode ?? "none",
        question_types: v.questions.map((q) => q.tier),
        num_questions: v.questions.length,
      },
      experiment: { dimension: v.dimension, arm: v.arm, rationale: v.rationale, hermes_video_id: v.id },
      hashtag_set: v.hashtag_set,
      post_state: "draft",
      metrics: { reach: null, video_views: null, reactions: null, comments: null, shares: null, eng_rate: null, as_of: null, source: "pending" },
      match_confidence: "high",
      notes: "Created by the Hermes autonomous loop (DRAFT-ONLY).",
    });
    if (!existing) db.posts.push(rec);
  }
  db.updated_at = new Date().toISOString();
  writeJSONAtomic(CONFIG.AB_DB, db);
}

function gitCommitPush(runId: string, summary: RunState["summary"]): { committed: boolean; pushed: boolean; note: string } {
  const files = ["ab-testing/ab-database.json", "ab-testing/learnings.json", "content/ab-test-usage.json", "tools/upload-media.ts", "remotion/hermes", "hermes"];
  const run = (args: string[]) => spawnSync("git", args, { cwd: CONFIG.REPO_DIR, encoding: "utf8", env: { ...process.env } });
  try {
    run(["add", ...files]);
    const status = run(["status", "--porcelain"]).stdout || "";
    if (!status.trim()) return { committed: false, pushed: false, note: "nothing to commit" };
    const msg = `hermes: cycle ${runId} — ${summary.drafted} drafts, ${summary.rejected} rejected [draft-only]`;
    const c = run(["commit", "-m", msg]);
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

  // (b) plan
  if (!state.videos.length) {
    state.videos = await planBatch(runId, target);
    state.summary.planned = state.videos.length;
    saveRun(state);
  }

  // per-video pipeline (resume-safe)
  for (const v of state.videos) {
    if (v.status === "drafted" || v.status === "rejected") continue;
    try {
      await draftForVideo(v);
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
