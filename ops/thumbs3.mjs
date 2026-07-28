/**
 * thumbs3.mjs — set explicit thumbnails on the remaining pending reels by
 * DELETE-AND-RECREATE, because PUT is destructive.
 *
 * WHAT THE CONTROLLED EXPERIMENT SHOWED
 * A cover-only PUT, with no retire logic involved at all, did two things: it wrote a
 * SECOND row carrying the target's uuid, and it silently EVICTED an unrelated published
 * post from the calendar. Before: 24 rows, published [r06, r12, r28-r02]. After the
 * single PUT: 24 rows, 23 distinct, published [r06, r28-r02] — 2026-07-27-r12 simply
 * gone. So the earlier losses were never the retire; they were the PUT, once per call.
 *
 * That rules PUT out entirely. With only a couple of published records left to absorb
 * the eviction, twelve more PUTs would start eating PENDING posts — the live queue.
 *
 * So this uses the delete-and-recreate path already proven on the 17 hook reels, and
 * sets videoThumbnailUrl AT CREATE TIME, where it costs nothing extra. Every field is
 * carried across from the ledger: time, caption (with its /go/ link), cover offset,
 * reel feed sharing. Single-id deletes only, one post at a time, verified after each,
 * with the delete rolled back if the create fails.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";

const REPO = "/home/ec2-user/sffs-ai-video-pipeline";
const M = await import(`${REPO}/hermes/src/metricool.ts`);
const { uploadToS3 } = await import(`${REPO}/hermes/src/s3.ts`);

const RENDERS = "/home/ec2-user/hermes-data/renders";
const STILLS = "/tmp/thumbs";
const HOSTED = "/home/ec2-user/hermes-data/thumbnail-hosting.json";
const SCHED = "/home/ec2-user/hermes-data/metricool-scheduled.json";
const FROM = "2026-07-26T00:00:00", TO = "2026-08-05T23:59:59";
const ONLY_DAY = "2026-07-29"; // the remaining twelve; today's nine are already done

mkdirSync(STILLS, { recursive: true });
const hosted = existsSync(HOSTED) ? JSON.parse(readFileSync(HOSTED, "utf8")) : {};
const saveHosted = () => writeFileSync(HOSTED, JSON.stringify(hosted, null, 2) + "\n");
const ledger = JSON.parse(readFileSync(SCHED, "utf8"));
const ledgerRows = Array.isArray(ledger) ? ledger : (ledger.posts ?? ledger.entries ?? []);
const idOf = (t) => (/(\d{4}-\d{2}-\d{2}-r\d+)/.exec(String(t || "")) || [])[1] || null;

const board = async () => M.listPosts(FROM, TO);
const pendingOf = (r) => r.filter((p) => (p.providers ?? []).some((x) => x.status === "PENDING"));

function still(videoId, coverMs) {
  const mp4 = [`${RENDERS}/${videoId}.instagram.mp4`, `${RENDERS}/${videoId}.tiktok.mp4`].find(existsSync);
  if (!mp4) throw new Error(`no render for ${videoId}`);
  const out = `${STILLS}/${videoId}.jpg`;
  if (!existsSync(out)) execFileSync("/usr/local/bin/ffmpeg",
    ["-y", "-loglevel", "error", "-ss", (coverMs / 1000).toFixed(3), "-i", mp4, "-frames:v", "1", "-q:v", "2", out]);
  return out;
}

async function hostStill(videoId, path) {
  const src = uploadToS3(path, `thumbs/${videoId}.jpg`);
  const carrier = await M.createPost({
    text: `thumb-host ${videoId} — throwaway`, mediaUrl: src,
    publicationDate: { dateTime: "2027-12-01T10:00:00", timezone: "America/Chicago" },
    networks: ["instagram"], draft: true, autoPublish: false,
  });
  const back = await M.getPost(Number(carrier.id));
  const url = (back.media || []).find((u) => String(u).includes("static.metricool.com"));
  await M.deletePost(String(carrier.uuid));
  if (!url) throw new Error("still was not rehosted");
  const after = await fetch(url, { headers: { Range: "bytes=0-63" } });
  if (!after.ok) throw new Error(`hosted url died with its carrier (HTTP ${after.status})`);
  return url;
}

/** The media URL Metricool already holds for this post — reused so the video is untouched. */
function mediaOf(post) {
  const m = (post.media || []).find((u) => String(u).includes("static.metricool.com"));
  if (!m) throw new Error("no hosted media on the existing post");
  return m;
}

// ── run ───────────────────────────────────────────────────────────────────────
let rows = await board();
const baseline = pendingOf(rows).length;
console.log(`board: ${rows.length} live / ${new Set(rows.map((p) => String(p.uuid))).size} distinct / ${baseline} pending`);

const targets = pendingOf(rows)
  .filter((p) => !p.videoThumbnailUrl && String(p.publicationDate?.dateTime ?? "").startsWith(ONLY_DAY))
  .sort((a, b) => String(a.publicationDate.dateTime).localeCompare(String(b.publicationDate.dateTime)));
console.log(`to recreate with a thumbnail: ${targets.length}\n`);

let ok = 0, failed = 0;
for (const t of targets) {
  const vid = idOf(t.text);
  const led = ledgerRows.find((r) => r.videoId === vid) ?? {};
  let deleted = null;
  try {
    const full = await M.getPost(Number(t.id));
    const media = mediaOf(full);
    const coverMs = Number(full.videoCoverMilliseconds ?? 0);
    const url = hosted[vid]?.url ?? (await hostStill(vid, still(vid, coverMs)));
    hosted[vid] = { url, coverMs, uuid: String(t.uuid) }; saveHosted();

    const spec = {
      text: String(full.text ?? led.caption ?? ""),
      mediaUrl: media,
      publicationDate: { dateTime: String(full.publicationDate.dateTime), timezone: String(full.publicationDate.timezone || "America/Chicago") },
      networks: ["instagram"],
      videoCoverMilliseconds: coverMs || undefined,
      videoThumbnailUrl: url,
      showReelOnFeed: true,
    };
    const delId = await M.resolveId(String(t.uuid));
    await M.deletePost(String(t.uuid));
    deleted = delId;

    const made = await M.createPost(spec);
    const back = await M.getPost(Number(made.id));
    if (!back.videoThumbnailUrl) throw new Error("created post has no thumbnail on read-back");
    if (String(back.publicationDate.dateTime) !== spec.publicationDate.dateTime) throw new Error("time drifted");
    if (String(back.text) !== spec.text) throw new Error("caption drifted");
    deleted = null;
    console.log(`  ${vid}  ${spec.publicationDate.dateTime.slice(0, 16)}  ${(coverMs / 1000).toFixed(1)}s  recreated with thumbnail`);
    ok++;
  } catch (e) {
    console.log(`  ${vid}  FAILED: ${String(e.message).slice(0, 130)}`);
    if (deleted) {
      const back = await M.restoreDeleted(deleted);
      console.log(`    rollback: restore ${deleted} -> ${back ? "ok" : "FAILED — MANUAL ATTENTION"}`);
    }
    failed++;
  }
  rows = await board();
  const pend = pendingOf(rows).length;
  const distinct = new Set(rows.map((p) => String(p.uuid))).size;
  const good = pend === baseline && distinct === rows.length;
  console.log(`    ledger: ${rows.length} live / ${distinct} distinct / ${pend} pending  ${good ? "OK" : "!! MISMATCH"}`);
  if (!good) { console.log("!! stopping"); break; }
}

rows = await board();
const pend = pendingOf(rows);
console.log(`\nrecreated: ${ok}  failed: ${failed}`);
console.log(`pending WITH an explicit thumbnail: ${pend.filter((p) => p.videoThumbnailUrl).length}/${pend.length}`);
