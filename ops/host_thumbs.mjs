/**
 * host_thumbs.mjs — give every pending reel an EXPLICIT videoThumbnailUrl showing its
 * own first question plate.
 *
 * WHY THIS EXISTS
 * We set videoCoverMilliseconds on all 33 posts and verified by read-back that the field
 * persisted and resolved to a complete question plate. It does persist. Instagram just
 * ignores it on this path and serves frame zero instead — pixel comparison put frame zero
 * ahead on 9 of 9 published reels, decisively on the hook arm (0.0010 vs 0.24), where
 * frame zero is a bare four-colour grid with no text. Persisting and being HONOURED are
 * different properties and only the first was ever tested.
 *
 * An explicit videoThumbnailUrl IS honoured: six reels carried one on Sunday and Instagram
 * used it. So each pending reel gets a still of its own configured cover moment, hosted
 * durably, pinned explicitly. videoCoverMilliseconds is left exactly as it is — harmless,
 * and correct wherever it is honoured.
 *
 * HOSTING
 * Same trick as the branded covers, for the same reason: Metricool stores
 * videoThumbnailUrl VERBATIM rather than rehosting it, our S3 bucket is private with
 * expiring role-signed URLs, and cdn.publer.com hotlink-403s. So each still is uploaded
 * as the media of a throwaway 2027 draft, which Metricool DOES copy onto
 * static.metricool.com, and the carrier is then deleted. The URL is re-fetched after the
 * delete before it is trusted, because a cover that dies with its carrier is worthless.
 *
 * SAFETY
 * Cover-only PUTs through the whitelist body. The 500-destroys-the-post trap was specific
 * to updates carrying new `media`; these carry none, and this is the same path already
 * proved on 9 control reels. Ledger verification runs between batches, not at the end, so
 * a divergence stops the run instead of being discovered thirty posts later.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";

const REPO = "/home/ec2-user/sffs-ai-video-pipeline";
const M = await import(`${REPO}/hermes/src/metricool.ts`);
const { uploadToS3 } = await import(`${REPO}/hermes/src/s3.ts`);

const RENDERS = "/home/ec2-user/hermes-data/renders";
const STILLS = "/tmp/thumbs";
const LEDGER = "/home/ec2-user/hermes-data/thumbnail-hosting.json";
const BATCH = 5;
const FROM = "2026-07-26T00:00:00";
const TO = "2026-08-05T23:59:59";
/**
 * The board is checked RELATIVELY, not against a constant. A hardcoded expectation is
 * wrong the moment a post publishes or an earlier incident removes a row, and — worse —
 * it tells you nothing about the invariant that actually matters here, which is that
 * THIS RUN must not shrink the board. Captured at start, asserted after every batch.
 */
let EXPECT_LIVE = 0;

mkdirSync(STILLS, { recursive: true });
const done = existsSync(LEDGER) ? JSON.parse(readFileSync(LEDGER, "utf8")) : {};
const save = () => writeFileSync(LEDGER, JSON.stringify(done, null, 2) + "\n");

const idOf = (t) => (/(\d{4}-\d{2}-\d{2}-r\d+)/.exec(String(t || "")) || [])[1] || null;

/** Every post still awaiting publication, with the render it came from. */
async function pending() {
  const rows = await M.listPosts(FROM, TO);
  return rows
    .filter((p) => (p.providers ?? []).some((x) => x.status === "PENDING"))
    .map((p) => ({
      uuid: String(p.uuid),
      videoId: idOf(p.text),
      coverMs: Number(p.videoCoverMilliseconds ?? 0),
      at: String(p.publicationDate?.dateTime ?? ""),
      thumb: p.videoThumbnailUrl ?? null,
    }))
    .sort((a, b) => a.at.localeCompare(b.at));
}

/** Ledger check: the live board must still hold exactly what we expect. */
async function verifyBoard(expectPending) {
  const rows = await M.listPosts(FROM, TO);
  const live = rows.length;
  const pend = rows.filter((p) => (p.providers ?? []).some((x) => x.status === "PENDING")).length;
  const uuids = new Set(rows.map((p) => String(p.uuid)));
  const ok = live === EXPECT_LIVE && pend === expectPending && uuids.size === live;
  console.log(`    ledger: ${live} live / ${uuids.size} distinct / ${pend} pending  ${ok ? "OK" : "!! MISMATCH"}`);
  return ok;
}

/** Pull the reel's own cover frame out of its render. */
function extractStill(videoId, coverMs) {
  const mp4 = [`${RENDERS}/${videoId}.instagram.mp4`, `${RENDERS}/${videoId}.tiktok.mp4`].find(existsSync);
  if (!mp4) throw new Error(`no render for ${videoId}`);
  const out = `${STILLS}/${videoId}.jpg`;
  execFileSync("/usr/local/bin/ffmpeg", [
    "-y", "-loglevel", "error",
    "-ss", (coverMs / 1000).toFixed(3),
    "-i", mp4,
    "-frames:v", "1", "-q:v", "2",
    out,
  ]);
  return out;
}

/** Park a still on static.metricool.com and confirm it outlives its carrier. */
async function host(videoId, stillPath) {
  const src = uploadToS3(stillPath, `thumbs/${videoId}.jpg`);
  const carrier = await M.createPost({
    text: `thumb-host ${videoId} — throwaway, deleted immediately`,
    mediaUrl: src,
    publicationDate: { dateTime: "2027-12-01T10:00:00", timezone: "America/Chicago" },
    networks: ["instagram"],
    draft: true,
    autoPublish: false,
  });
  const back = await M.getPost(Number(carrier.id));
  const hosted = (back.media || []).find((u) => String(u).includes("static.metricool.com"));
  await M.deletePost(String(carrier.uuid));
  if (!hosted) throw new Error(`${videoId}: not rehosted (media=${JSON.stringify(back.media)})`);
  const after = await fetch(hosted, { method: "GET", headers: { Range: "bytes=0-63" } });
  if (!after.ok) throw new Error(`${videoId}: hosted url died with its carrier (HTTP ${after.status})`);
  return hosted;
}

// ── run ───────────────────────────────────────────────────────────────────────
const targets = (await pending()).filter((p) => !p.thumb);
EXPECT_LIVE = (await M.listPosts(FROM, TO)).length;
console.log(`board baseline: ${EXPECT_LIVE} live`);
console.log(`pending without an explicit thumbnail: ${targets.length}`);
if (!(await verifyBoard((await pending()).length))) process.exit(1);

let set = 0, failed = 0;
for (let i = 0; i < targets.length; i += BATCH) {
  const batch = targets.slice(i, i + BATCH);
  console.log(`\n── batch ${Math.floor(i / BATCH) + 1} (${batch.length}) ──`);
  for (const t of batch) {
    try {
      if (!t.videoId) throw new Error("no video id in caption");
      const url = done[t.videoId]?.url ?? (await host(t.videoId, extractStill(t.videoId, t.coverMs)));
      done[t.videoId] = { url, coverMs: t.coverMs, uuid: t.uuid }; save();

      // Cover-only PUT: whitelist body, no media, re-resolved id, stale id retired.
      const id = await M.resolveId(t.uuid);
      if (id === null) throw new Error("post vanished before update");
      const cur = await M.getPost(id);
      const upd = await M.putPost(id, M.buildUpdateBody(cur, { videoThumbnailUrl: url }));
      const newId = Number(upd?.id);
      // PUT leaves the pre-PUT row behind as a duplicate, so it does have to be retired —
      // but ONLY after re-reading it and confirming it still carries this post's uuid.
      // Metricool reassigns numeric ids, and retiring one unverified deleted five innocent
      // published rows earlier today.
      if (Number.isFinite(newId) && newId !== id) await M.retireStaleId(id, t.uuid);
      const check = await M.getPost(Number.isFinite(newId) && newId ? newId : id);
      if (!check.videoThumbnailUrl) throw new Error("read-back still null");
      console.log(`  ${t.videoId}  ${t.at.slice(0, 16)}  ${(t.coverMs / 1000).toFixed(1)}s -> ${url.slice(-42)}`);
      set++;
    } catch (e) {
      console.log(`  ${t.videoId}  FAILED: ${String(e.message).slice(0, 140)}`);
      failed++;
    }
  }
  if (!(await verifyBoard((await pending()).length))) {
    console.log("!! ledger disagreed — stopping rather than continuing");
    process.exit(1);
  }
}
console.log(`\nthumbnails set: ${set}  failed: ${failed}`);
const left = (await pending()).filter((p) => !p.thumb).length;
console.log(`pending still without an explicit thumbnail: ${left}`);
