#!/usr/bin/env node
/**
 * combined_pass.mjs — ONE update sweep that does both pending changes per post.
 *
 * Deliberately combined. Metricool's PUT destroys a post when it errors, so two sweeps
 * over 39 posts is twice the exposure for no benefit. Each post is touched exactly once:
 *
 *   1. HOOK ARM ONLY: swap in the re-rendered video with the new square opening, so the
 *      arm is a single homogeneous treatment. Control-arm media is never touched.
 *   2. BOTH ARMS: replace the branded-card cover with the post's own FIRST QUESTION
 *      PLATE, via videoCoverMilliseconds.
 *
 * WHY videoCoverMilliseconds AND NOT AN UPLOADED STILL
 * It needs no hosting at all. A per-post question still would mean 39 separate uploads
 * to a throwaway host, and the branded cards already had to be parked on Metricool's own
 * CDN because our S3 is private and Publer's CDN is hotlink-protected.
 *
 * AND WHY THIS DOES NOT REINTRODUCE THE CONFOUND I OBJECTED TO EARLIER
 * The earlier objection was to a single FIXED millisecond across both arms: the arms'
 * timelines differ by the 2.2s hook, so one constant would land mid-wipe on the hook arm
 * and mid-question on the control. Here the target is SEMANTIC and computed per render —
 * "one second into the first question's countdown", derived from that render's own
 * measured VO durations and its own opening. Both arms show the same THING at different
 * timestamps, which is the same treatment, not a shared constant.
 *
 * The moment is taken inside the COUNTDOWN segment rather than the read segment on
 * purpose: by then the plate has finished any entrance animation and the timer is
 * running, so it cannot be a transition frame or a partially animated state.
 *
 *   node ops/combined_pass.mjs            # dry run + report the computed cover moments
 *   node ops/combined_pass.mjs --write
 */
const REPO = "/home/ec2-user/sffs-ai-video-pipeline";
const M = await import(`${REPO}/hermes/src/metricool.ts`);
const G = await import(`${REPO}/hermes/src/publishGate.ts`);
const { uploadToS3 } = await import(`${REPO}/hermes/src/s3.ts`);
const { readJSON, writeJSONAtomic } = await import(`${REPO}/hermes/src/state.ts`);
const { CONFIG } = await import(`${REPO}/hermes/src/config.ts`);
const { join } = await import("node:path");
const { existsSync, statSync, readFileSync } = await import("node:fs");
const { spawnSync } = await import("node:child_process");
const { coverMomentMs } = await import(`${REPO}/hermes/src/covers.ts`);

const WRITE = process.argv.includes("--write");
const LEDGER = join(CONFIG.DATA_DIR, "metricool-scheduled.json");
const HOOK_SRC = join(CONFIG.REMOTION_DIR, "src", "scenes", "Hook.tsx");
const FPS = 30;
const HOOK_FRAMES = Math.round(2.2 * FPS);
const LEAD = 0.12, TRAIL = 0.4;


function propsFor(videoId) {
  const f = join(CONFIG.RENDERS_DIR, `${videoId}.tiktok.props.json`);
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null;
}

/** Re-render from the saved props (same questions, same VO — only the Hook changed). */
function rerender(videoId) {
  const propsFile = join(CONFIG.RENDERS_DIR, `${videoId}.tiktok.props.json`);
  const out = join(CONFIG.RENDERS_DIR, `${videoId}.tiktok.mp4`);
  const res = spawnSync("npx", ["remotion", "render", "Short", out, `--props=${propsFile}`, "--log=error", "--concurrency=2"], {
    cwd: CONFIG.REMOTION_DIR, encoding: "utf8", timeout: 10 * 60_000, env: { ...process.env },
  });
  if (res.status !== 0) throw new Error(`render failed: ${(res.stderr || res.stdout || "").slice(-240)}`);
  if (!existsSync(out) || statSync(out).size < 200_000) throw new Error("render produced no/tiny file");
  return out;
}

/**
 * Every ledger entry that is still SCHEDULED must still be live.
 *
 * Entries whose slot has already passed are exempt: once a post publishes it eventually
 * drops out of the scheduler listing, which is normal and not a loss. Treating those as
 * missing would abort the run on a healthy account — 2026-07-26-r01 tripped exactly
 * that after it went live (and it is present in the IG analytics, so it published fine).
 */
/**
 * After a PUT, make sure the post occupies exactly ONE row again.
 *
 * PUT mints a new numeric id and sometimes leaves the old row addressable. The account
 * enforces a hard ceiling on scheduled rows, so a stray row does not merely look untidy
 * — it EVICTS a real pending post, and the evicted post is destroyed rather than
 * soft-deleted, so it is not recoverable from the recycle bin. Two posts were lost that
 * way before this was understood. Retire every id for this uuid except the newest.
 */
async function settleAfterUpdate(uuid, keepId) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const rows = await M.listPosts("2026-07-01T00:00:00", "2026-12-31T23:59:59");
    const mine = rows.filter((p) => String(p.uuid) === String(uuid));
    const strays = mine.filter((p) => Number(p.id) !== Number(keepId));
    if (!strays.length) return true;
    for (const s of strays) await M.retireStaleId(Number(s.id));
    await new Promise((r) => setTimeout(r, 800));
  }
  return false;
}

async function ledgerIntact(led) {
  const rows = await M.listPosts("2026-07-01T00:00:00", "2026-12-31T23:59:59");
  const live = new Set(rows.map((p) => String(p.uuid)));
  const now = Date.now();
  const expected = led.posts.filter((r) => new Date(`${r.at}-05:00`).getTime() > now);
  return { missing: expected.filter((r) => !live.has(String(r.uuid))).map((r) => r.videoId), rows, live };
}

const hookMtime = statSync(HOOK_SRC).mtimeMs;
const led = readJSON(LEDGER, { posts: [] });
const byUuid = new Map(led.posts.map((r) => [String(r.uuid), r]));
let { missing, rows } = await ledgerIntact(led);
if (missing.length) { console.error(`ABORT: ledger already short: ${missing.join(", ")}`); process.exit(2); }
console.log(`ledger intact ${led.posts.length}/${led.posts.length}\n`);

const published = [], todo = [];
for (const p of rows) {
  const rec = byUuid.get(String(p.uuid));
  if (!rec) continue;
  const isPub = (p.providers ?? []).some((x) => String(x.status).toUpperCase() === "PUBLISHED");
  (isPub ? published : todo).push({ post: p, rec });
}
todo.sort((a, b) => String(a.post.publicationDate.dateTime).localeCompare(String(b.post.publicationDate.dateTime)));

const pubHook = published.filter(({ rec }) => rec.opening === "motion-hook");
console.log(`PUBLISHED (cannot change): ${published.length} — of which HOOK arm on the OLD tilted opening: ${pubHook.length}`);
for (const { post, rec } of pubHook) {
  console.log(`   ${post.publicationDate.dateTime}  ${rec.videoId}  ${(post.providers ?? []).find((x) => x.publicUrl)?.publicUrl}`);
}
console.log(`\nPENDING to update: ${todo.length}  (hook ${todo.filter((t) => t.rec.opening === "motion-hook").length}, control ${todo.filter((t) => t.rec.opening === "cold-plate").length})\n`);

let swapped = 0, covered = 0, failed = 0;
for (const { post, rec } of todo) {
  const label = `${post.publicationDate.dateTime} ${rec.videoId} ${rec.opening}`;
  try {
    const props = propsFor(rec.videoId);
    if (!props) { console.log(`  SKIP ${label} — no props file`); failed++; continue; }
    const ms = coverMomentMs(props);
    if (ms === null) { console.log(`  SKIP ${label} — cannot compute a cover moment`); failed++; continue; }

    // The gate must accept a videoCoverMilliseconds cover, not only an uploaded url.
    const gate = G.publishGate(
      { id: rec.videoId, caption: rec.caption, hashtag_set: rec.hashtag_set, questions: [], explanations: [], cover_ms: ms },
      [],
    );
    if (!gate.pass) { console.log(`  SKIP ${label} — gate refused: ${gate.reason}`); failed++; continue; }

    if (!WRITE) { console.log(`  would update ${label}  coverMs=${ms}${rec.opening === "motion-hook" ? "  +media swap" : ""}`); continue; }

    // Hook arm only: make sure the mp4 on disk is the NEW opening, then upload it.
    const patch = { videoCoverMilliseconds: ms, videoThumbnailUrl: null };
    if (rec.opening === "motion-hook") {
      const mp4 = join(CONFIG.RENDERS_DIR, `${rec.videoId}.tiktok.mp4`);
      if (!existsSync(mp4) || statSync(mp4).mtimeMs < hookMtime) rerender(rec.videoId);
      patch.media = [uploadToS3(mp4, `hermes/swap/${rec.videoId}.mp4`)];
    }

    const staleId = await M.resolveId(String(post.uuid));
    if (staleId === null) { console.log(`  SKIP ${label} — uuid no longer resolves`); failed++; continue; }
    const current = await M.getPost(staleId);
    const updated = await M.putPost(staleId, M.buildUpdateBody(current, patch));
    const newId = Number(updated?.id);
    if (Number.isFinite(newId) && newId !== staleId) await M.retireStaleId(staleId);
    // Collapse this uuid back to a single row BEFORE moving on, so the row ceiling is
    // never exceeded and nothing gets evicted.
    await settleAfterUpdate(String(updated.uuid ?? post.uuid), newId);

    // Verify on THIS post, not at the end.
    const check = await ledgerIntact(led);
    if (check.missing.length) { console.error(`\nABORT after ${label}: ledger lost ${check.missing.join(", ")}`); process.exit(3); }

    rec.uuid = String(updated.uuid ?? post.uuid);
    rec.id = newId;
    rec.cover_ms = ms;
    rec.cover_kind = "first-question-plate";
    if (rec.opening === "motion-hook") { rec.hook_version = "square-open"; swapped++; }
    covered++;
    byUuid.set(String(rec.uuid), rec);
    writeJSONAtomic(LEDGER, { ...led, updated_at: new Date().toISOString() });
    console.log(`  ok ${label}  coverMs=${ms}  id ${staleId} -> ${newId}`);
  } catch (e) {
    console.log(`  FAIL ${label} — ${e instanceof Error ? e.message : String(e)}`);
    failed++;
  }
}
console.log(`\ncovers set ${covered}/${todo.length}, hook media swapped ${swapped}, failed ${failed}`);
