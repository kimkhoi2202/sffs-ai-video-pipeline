/**
 * restore_lost.mjs — put back the two Monday posts destroyed by the bad cover update.
 *
 * The full-echo PUT returned HTTP 500 ("Type definition error: ...PublicationStatusCode")
 * and was NOT a clean rejection: it destroyed the record. The ids now 404 and the posts
 * are not in the recycle bin, because they were never a user delete and there is nothing
 * to restore. They have to be recreated.
 *
 * Everything needed is in the posting ledger and on disk: the caption (with its /go/
 * attribution link), the arm, the slot time, and the rendered mp4. Recreating from those
 * reproduces the post exactly, including the cover this time.
 */
const REPO = "/home/ec2-user/sffs-ai-video-pipeline";
const M = await import(`${REPO}/hermes/src/metricool.ts`);
const C = await import(`${REPO}/hermes/src/covers.ts`);
const { uploadToS3 } = await import(`${REPO}/hermes/src/s3.ts`);
const { readJSON, writeJSONAtomic } = await import(`${REPO}/hermes/src/state.ts`);
const { CONFIG } = await import(`${REPO}/hermes/src/config.ts`);
const { join } = await import("node:path");
const { existsSync } = await import("node:fs");

const WRITE = process.argv.includes("--write");
const LEDGER = join(CONFIG.DATA_DIR, "metricool-scheduled.json");
const led = readJSON(LEDGER, { posts: [] });

const live = await M.listPosts("2026-07-01T00:00:00", "2026-12-31T23:59:59");
const liveUuids = new Set(live.map((p) => String(p.uuid)));
// future-scheduled only: a post that has already published legitimately drops out of
// the scheduler listing, and recreating it would put the same reel out twice.
const nowMs = Date.now();
const missing = (led.posts ?? [])
  .filter((r) => new Date(`${r.at}-05:00`).getTime() > nowMs)
  .filter((r) => !liveUuids.has(String(r.uuid)));

console.log(`ledger ${led.posts.length} | live distinct ${new Set(live.map((p) => String(p.uuid))).size} | missing ${missing.length}\n`);
for (const m of missing) console.log(`  ${m.at}  ${m.videoId}  arm=${m.opening}`);
if (!missing.length) { console.log("\nnothing to restore"); process.exit(0); }
if (!WRITE) { console.log("\n(dry run; pass --write)"); process.exit(0); }

console.log("");
for (const rec of missing) {
  const render = join(CONFIG.RENDERS_DIR, `${rec.videoId}.tiktok.mp4`);
  if (!existsSync(render)) { console.log(`  SKIP ${rec.videoId} — render missing at ${render}`); continue; }
  const slot = Number(String(rec.videoId).split("-r").pop()) - 1;
  const day = String(rec.at).slice(0, 10);
  const cover = C.hostedCoverUrlFor(day, slot, "instagram");
  if (!cover) { console.log(`  SKIP ${rec.videoId} — no cover available`); continue; }

  const mediaUrl = uploadToS3(render, `hermes/${day}/${rec.videoId}.mp4`);
  const post = await M.createPost({
    text: rec.caption,
    mediaUrl,
    publicationDate: { dateTime: rec.at, timezone: CONFIG.METRICOOL_TZ },
    networks: ["instagram"],
    videoThumbnailUrl: cover.url,
    draft: false,
    autoPublish: true,
    showReelOnFeed: true,
  });
  console.log(`  restored ${rec.videoId} at ${rec.at} arm=${rec.opening} cover=${cover.color} uuid=${post.uuid}`);
  // Re-key the ledger entry onto the new uuid; the old one no longer exists anywhere.
  rec.uuid = String(post.uuid);
  rec.id = post.id;
  rec.cover = cover.color;
  rec.cover_url = cover.url;
  rec.restored_at = new Date().toISOString();
}
led.updated_at = new Date().toISOString();
writeJSONAtomic(LEDGER, led);
console.log("\nledger re-keyed onto the new uuids");
