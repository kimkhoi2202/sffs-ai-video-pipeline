#!/usr/bin/env node
/**
 * recreate_hook.mjs — move the pending motion-hook reels onto the new square opening.
 *
 * WHY DELETE-AND-RECREATE AND NOT AN UPDATE
 * PUT cannot carry new media: every hook-arm update returns HTTP 500, and that 500
 * DESTROYS the post rather than rejecting it. Two separate runs confirmed it, and the
 * cover-only updates in the same runs succeeded, so it is specifically the media change
 * PUT will not take. Recreating is the only route.
 *
 * WHY DELETE FIRST, THEN CREATE
 * The account enforces a hard ceiling on scheduled rows, and exceeding it EVICTS a real
 * post — destroyed, not soft-deleted, so the recycle bin cannot get it back. That is how
 * posts were lost earlier today. Creating first would put two rows in one slot and risk
 * exactly that. Deleting first keeps the row count flat or below at every instant, and
 * the delete is SOFT, so if the create then fails the original is restorable from the
 * recycle bin — which this script does automatically.
 *
 * DISCIPLINE, kept deliberately slow:
 *   - single-id delete only, never a bulk route (none exists, and it stays that way)
 *   - small batches with a full ledger verification between each
 *   - abort the moment a count disagrees, rather than pushing through
 *   - extendedRange stays OFF; that flag turning a narrow query into a whole-day query
 *     is what caused 13 posts to be deleted as "duplicates"
 *
 * Preserved exactly per post: scheduled time, caption (including its /go/ attribution
 * link), arm, Instagram reel settings including feed sharing, and the question-plate
 * cover — which is applied AT CREATE TIME here, so these 17 never need a second mutation.
 *
 *   node ops/recreate_hook.mjs                 # dry run
 *   node ops/recreate_hook.mjs --write         # go
 *   node ops/recreate_hook.mjs --write --batch 3 --limit 6
 */
const REPO = "/home/ec2-user/sffs-ai-video-pipeline";
const M = await import(`${REPO}/hermes/src/metricool.ts`);
const G = await import(`${REPO}/hermes/src/publishGate.ts`);
const { coverMomentMs } = await import(`${REPO}/hermes/src/covers.ts`);
const { uploadToS3 } = await import(`${REPO}/hermes/src/s3.ts`);
const { readJSON, writeJSONAtomic } = await import(`${REPO}/hermes/src/state.ts`);
const { CONFIG } = await import(`${REPO}/hermes/src/config.ts`);
const { join } = await import("node:path");
const { existsSync, statSync, readFileSync } = await import("node:fs");
const { spawnSync } = await import("node:child_process");

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const WRITE = argv.includes("--write");
const BATCH = Number(flag("--batch", "3"));
const LIMIT = Number(flag("--limit", "999"));
const LEDGER = join(CONFIG.DATA_DIR, "metricool-scheduled.json");
const HOOK_SRC = join(CONFIG.REMOTION_DIR, "src", "scenes", "Hook.tsx");
const RANGE = ["2026-07-01T00:00:00", "2026-12-31T23:59:59"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const propsFor = (id) => {
  const f = join(CONFIG.RENDERS_DIR, `${id}.tiktok.props.json`);
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null;
};

function rerenderIfStale(videoId, hookMtime) {
  const mp4 = join(CONFIG.RENDERS_DIR, `${videoId}.tiktok.mp4`);
  if (existsSync(mp4) && statSync(mp4).mtimeMs >= hookMtime) return { mp4, rerendered: false };
  const propsFile = join(CONFIG.RENDERS_DIR, `${videoId}.tiktok.props.json`);
  const res = spawnSync("npx", ["remotion", "render", "Short", mp4, `--props=${propsFile}`, "--log=error", "--concurrency=2"], {
    cwd: CONFIG.REMOTION_DIR, encoding: "utf8", timeout: 10 * 60_000, env: { ...process.env },
  });
  if (res.status !== 0) throw new Error(`render failed: ${(res.stderr || res.stdout || "").slice(-200)}`);
  if (!existsSync(mp4) || statSync(mp4).size < 200_000) throw new Error("render produced no/tiny file");
  return { mp4, rerendered: true };
}

/** Full-state snapshot used as the between-batch gate. */
async function snapshot(led) {
  const rows = await M.listPosts(RANGE[0], RANGE[1]);
  const live = new Set(rows.map((p) => String(p.uuid)));
  const now = Date.now();
  const future = led.posts.filter((r) => new Date(`${r.at}-05:00`).getTime() > now);
  return {
    rows: rows.length,
    distinct: live.size,
    duplicates: rows.length - live.size,
    future: future.length,
    missing: future.filter((r) => !live.has(String(r.uuid))).map((r) => r.videoId),
    liveRows: rows,
  };
}

function describe(s) {
  return `rows=${s.rows} distinct=${s.distinct} dupes=${s.duplicates} future=${s.future} missing=${s.missing.length ? s.missing.join(",") : "none"}`;
}

const hookMtime = statSync(HOOK_SRC).mtimeMs;
const led = readJSON(LEDGER, { posts: [] });
let snap = await snapshot(led);
console.log(`baseline: ${describe(snap)}\n`);
if (snap.missing.length || snap.duplicates) { console.error("ABORT: not starting from a clean state"); process.exit(2); }

const byUuid = new Map(led.posts.map((r) => [String(r.uuid), r]));
const todo = [];
for (const p of snap.liveRows) {
  const rec = byUuid.get(String(p.uuid));
  if (!rec || rec.opening !== "motion-hook") continue;
  if ((p.providers ?? []).some((x) => String(x.status).toUpperCase() === "PUBLISHED")) continue;
  todo.push({ post: p, rec });
}
todo.sort((a, b) => String(a.post.publicationDate.dateTime).localeCompare(String(b.post.publicationDate.dateTime)));
const work = todo.slice(0, LIMIT);
console.log(`pending hook reels to recreate: ${todo.length}${LIMIT < todo.length ? ` (this run: ${work.length})` : ""}\n`);
if (!WRITE) {
  for (const { post, rec } of work) {
    const props = propsFor(rec.videoId);
    console.log(`  would recreate ${post.publicationDate.dateTime} ${rec.videoId} coverMs=${props ? coverMomentMs(props) : "?"}`);
  }
  console.log("\n(dry run)");
  process.exit(0);
}

let done = 0, failed = 0;
for (let b = 0; b < work.length; b += BATCH) {
  const batch = work.slice(b, b + BATCH);
  console.log(`--- batch ${Math.floor(b / BATCH) + 1}: ${batch.map((x) => x.rec.videoId).join(", ")} ---`);

  for (const { post, rec } of batch) {
    const label = `${post.publicationDate.dateTime} ${rec.videoId}`;
    let deletedId = null;
    try {
      const props = propsFor(rec.videoId);
      if (!props) throw new Error("no props file");
      const ms = coverMomentMs(props);
      const gate = G.publishGate(
        { id: rec.videoId, caption: rec.caption, hashtag_set: rec.hashtag_set, questions: [], explanations: [], cover_ms: ms },
        [],
      );
      if (!gate.pass) throw new Error(`gate refused: ${gate.reason}`);

      const { mp4, rerendered } = rerenderIfStale(rec.videoId, hookMtime);
      const mediaUrl = uploadToS3(mp4, `hermes/square/${rec.videoId}.mp4`);

      // Re-resolve immediately before mutating: the numeric id is reassigned on update
      // and any stored one is stale by default.
      const id = await M.resolveId(String(post.uuid));
      if (id === null) throw new Error("uuid no longer resolves");

      // Delete FIRST (soft, single id) so the row count never goes above the ceiling.
      const del = await M.deletePost(String(post.uuid));
      if (!del.deleted) throw new Error("delete did not take");
      deletedId = del.id;

      const created = await M.createPost({
        text: rec.caption,                       // carries the /go/ attribution link
        mediaUrl,
        publicationDate: { dateTime: rec.at, timezone: CONFIG.METRICOOL_TZ },
        networks: ["instagram"],
        videoCoverMilliseconds: ms,              // question-plate cover, free at create time
        draft: false,
        autoPublish: true,
        showReelOnFeed: true,                    // IG reel + share to feed, as before
      });

      rec.uuid = String(created.uuid);
      rec.id = created.id;
      rec.cover_ms = ms;
      rec.cover_kind = "first-question-plate";
      rec.hook_version = "square-open";
      rec.recreated_at = new Date().toISOString();
      byUuid.set(String(rec.uuid), rec);
      writeJSONAtomic(LEDGER, { ...led, updated_at: new Date().toISOString() });
      console.log(`  ok ${label}  coverMs=${ms}${rerendered ? " (re-rendered)" : ""}  ${deletedId} -> ${created.id}`);
      done++;
    } catch (e) {
      console.log(`  FAIL ${label} — ${e instanceof Error ? e.message : String(e)}`);
      failed++;
      // The delete is soft; if the create never happened, put the original back.
      if (deletedId !== null) {
        const back = await M.restoreDeleted(deletedId);
        console.log(`       original ${deletedId} restored: ${back}`);
      }
    }
  }

  await sleep(1500);
  const after = await snapshot(led);
  console.log(`  verify: ${describe(after)}`);
  if (after.missing.length || after.duplicates) {
    console.error(`\nABORT: batch verification failed (${describe(after)}). Nothing further will be touched.`);
    process.exit(3);
  }
  if (after.future !== snap.future) {
    console.error(`\nABORT: future-post count moved ${snap.future} -> ${after.future}.`);
    process.exit(3);
  }
  snap = after;
  console.log("");
}
console.log(`recreated ${done}, failed ${failed}`);
