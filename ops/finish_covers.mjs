#!/usr/bin/env node
/**
 * finish_covers.mjs — move the last branded-card posts onto the question-plate cover.
 *
 * These are control-arm reels whose media does not change, so the proven path applies:
 * a cover-only PUT. That is specifically the shape of update Metricool accepts — every
 * update that also carried new `media` returned HTTP 500 and destroyed the post, while
 * cover-only updates succeeded throughout.
 *
 * Same discipline as the recreate: small batches, full ledger verification between each,
 * abort on any disagreement, re-resolve the id before mutating, retire stale rows.
 */
const REPO = "/home/ec2-user/sffs-ai-video-pipeline";
const M = await import(`${REPO}/hermes/src/metricool.ts`);
const G = await import(`${REPO}/hermes/src/publishGate.ts`);
const { coverMomentMs } = await import(`${REPO}/hermes/src/covers.ts`);
const { readJSON, writeJSONAtomic } = await import(`${REPO}/hermes/src/state.ts`);
const { CONFIG } = await import(`${REPO}/hermes/src/config.ts`);
const { join } = await import("node:path");
const { existsSync, readFileSync } = await import("node:fs");

const argv = process.argv.slice(2);
const WRITE = argv.includes("--write");
const BATCH = 4;
const LEDGER = join(CONFIG.DATA_DIR, "metricool-scheduled.json");
const RANGE = ["2026-07-01T00:00:00", "2026-12-31T23:59:59"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const propsFor = (id) => {
  const f = join(CONFIG.RENDERS_DIR, `${id}.tiktok.props.json`);
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null;
};

async function snapshot(led) {
  const rows = await M.listPosts(RANGE[0], RANGE[1]);
  const live = new Set(rows.map((p) => String(p.uuid)));
  const now = Date.now();
  const future = led.posts.filter((r) => new Date(`${r.at}-05:00`).getTime() > now);
  return {
    rows: rows.length, distinct: live.size, duplicates: rows.length - live.size,
    future: future.length,
    missing: future.filter((r) => !live.has(String(r.uuid))).map((r) => r.videoId),
    liveRows: rows,
  };
}
const describe = (s) => `rows=${s.rows} distinct=${s.distinct} dupes=${s.duplicates} future=${s.future} missing=${s.missing.length ? s.missing.join(",") : "none"}`;

const led = readJSON(LEDGER, { posts: [] });
let snap = await snapshot(led);
console.log(`baseline: ${describe(snap)}\n`);
if (snap.missing.length || snap.duplicates) { console.error("ABORT: not starting clean"); process.exit(2); }

const byUuid = new Map(led.posts.map((r) => [String(r.uuid), r]));
const todo = [];
for (const p of snap.liveRows) {
  const rec = byUuid.get(String(p.uuid));
  if (!rec) continue;
  if ((p.providers ?? []).some((x) => String(x.status).toUpperCase() === "PUBLISHED")) continue;
  if (typeof p.videoCoverMilliseconds === "number") continue; // already on the new cover
  todo.push({ post: p, rec });
}
todo.sort((a, b) => String(a.post.publicationDate.dateTime).localeCompare(String(b.post.publicationDate.dateTime)));
console.log(`still on the branded card: ${todo.length}\n`);
if (!WRITE) {
  for (const { post, rec } of todo) {
    const props = propsFor(rec.videoId);
    console.log(`  would set ${post.publicationDate.dateTime} ${rec.videoId} ${rec.opening} coverMs=${props ? coverMomentMs(props) : "?"}`);
  }
  console.log("\n(dry run)"); process.exit(0);
}

let done = 0, failed = 0;
for (let b = 0; b < todo.length; b += BATCH) {
  const batch = todo.slice(b, b + BATCH);
  console.log(`--- batch ${Math.floor(b / BATCH) + 1}: ${batch.map((x) => x.rec.videoId).join(", ")} ---`);
  for (const { post, rec } of batch) {
    const label = `${post.publicationDate.dateTime} ${rec.videoId} ${rec.opening}`;
    try {
      const props = propsFor(rec.videoId);
      if (!props) throw new Error("no props file");
      const ms = coverMomentMs(props);
      const gate = G.publishGate(
        { id: rec.videoId, caption: rec.caption, hashtag_set: rec.hashtag_set, questions: [], explanations: [], cover_ms: ms },
        [],
      );
      if (!gate.pass) throw new Error(`gate refused: ${gate.reason}`);

      const staleId = await M.resolveId(String(post.uuid));
      if (staleId === null) throw new Error("uuid no longer resolves");
      const current = await M.getPost(staleId);
      // Cover only. `media` is deliberately NOT in the patch — that is the difference
      // between an update that works and one that destroys the post.
      const updated = await M.putPost(staleId, M.buildUpdateBody(current, { videoCoverMilliseconds: ms, videoThumbnailUrl: null }));
      const newId = Number(updated?.id);
      if (Number.isFinite(newId) && newId !== staleId) await M.retireStaleId(staleId);

      rec.uuid = String(updated.uuid ?? post.uuid);
      rec.id = newId;
      rec.cover_ms = ms;
      rec.cover_kind = "first-question-plate";
      byUuid.set(String(rec.uuid), rec);
      writeJSONAtomic(LEDGER, { ...led, updated_at: new Date().toISOString() });
      console.log(`  ok ${label}  coverMs=${ms}  ${staleId} -> ${newId}`);
      done++;
    } catch (e) {
      console.log(`  FAIL ${label} — ${e instanceof Error ? e.message : String(e)}`);
      failed++;
    }
  }
  await sleep(1500);
  const after = await snapshot(led);
  console.log(`  verify: ${describe(after)}`);
  if (after.missing.length || after.duplicates || after.future !== snap.future) {
    console.error(`\nABORT: batch verification failed.`); process.exit(3);
  }
  snap = after;
  console.log("");
}
console.log(`covers set ${done}, failed ${failed}`);
