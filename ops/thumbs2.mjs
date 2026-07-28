/**
 * thumbs2.mjs — pin an explicit videoThumbnailUrl on every pending reel.
 *
 * WHAT WE LEARNED THE HARD WAY ABOUT METRICOOL'S PUT
 * A cover-only PUT does not update in place. It writes a SECOND row carrying the same
 * uuid and a new numeric id, and leaves the original behind. Worse, resolveId(uuid)
 * keeps returning the ORIGINAL id, so "keep whatever resolveId says and drop the other"
 * is exactly backwards — it discards the row that has the new thumbnail on it.
 *
 * So the duplicate is resolved on CONTENT, not on id: after the PUT, both rows are read
 * and the one actually carrying the thumbnail is kept. The other is retired, and the
 * retire is uuid-verified because Metricool recycles numeric ids — an unverified delete
 * by id destroyed five innocent published rows earlier today.
 *
 * Stills already hosted on static.metricool.com are reused from the ledger rather than
 * re-rendered, so a re-run is cheap and idempotent.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";

const REPO = "/home/ec2-user/sffs-ai-video-pipeline";
const M = await import(`${REPO}/hermes/src/metricool.ts`);
const { uploadToS3 } = await import(`${REPO}/hermes/src/s3.ts`);

const RENDERS = "/home/ec2-user/hermes-data/renders";
const STILLS = "/tmp/thumbs";
const LEDGER = "/home/ec2-user/hermes-data/thumbnail-hosting.json";
const FROM = "2026-07-26T00:00:00", TO = "2026-08-05T23:59:59";
const BATCH = 4;

mkdirSync(STILLS, { recursive: true });
const hosted = existsSync(LEDGER) ? JSON.parse(readFileSync(LEDGER, "utf8")) : {};
const save = () => writeFileSync(LEDGER, JSON.stringify(hosted, null, 2) + "\n");
const idOf = (t) => (/(\d{4}-\d{2}-\d{2}-r\d+)/.exec(String(t || "")) || [])[1] || null;

const board = async () => M.listPosts(FROM, TO);
const pendingOf = (rows) => rows.filter((p) => (p.providers ?? []).some((x) => x.status === "PENDING"));

function still(videoId, coverMs) {
  const mp4 = [`${RENDERS}/${videoId}.instagram.mp4`, `${RENDERS}/${videoId}.tiktok.mp4`].find(existsSync);
  if (!mp4) throw new Error(`no render for ${videoId}`);
  const out = `${STILLS}/${videoId}.jpg`;
  if (!existsSync(out)) {
    execFileSync("/usr/local/bin/ffmpeg",
      ["-y", "-loglevel", "error", "-ss", (coverMs / 1000).toFixed(3), "-i", mp4, "-frames:v", "1", "-q:v", "2", out]);
  }
  return out;
}

/** Park a still on Metricool's own CDN; verify it outlives its throwaway carrier. */
async function hostStill(videoId, path) {
  const src = uploadToS3(path, `thumbs/${videoId}.jpg`);
  const carrier = await M.createPost({
    text: `thumb-host ${videoId} — throwaway`,
    mediaUrl: src,
    publicationDate: { dateTime: "2027-12-01T10:00:00", timezone: "America/Chicago" },
    networks: ["instagram"], draft: true, autoPublish: false,
  });
  const back = await M.getPost(Number(carrier.id));
  const url = (back.media || []).find((u) => String(u).includes("static.metricool.com"));
  await M.deletePost(String(carrier.uuid));
  if (!url) throw new Error("not rehosted");
  const after = await fetch(url, { headers: { Range: "bytes=0-63" } });
  if (!after.ok) throw new Error(`hosted url died with carrier (HTTP ${after.status})`);
  return url;
}

/** Keep the row that carries the thumbnail; retire the duplicate the PUT left behind. */
async function dedupeOn(uuid) {
  const rows = (await board()).filter((p) => String(p.uuid) === String(uuid));
  if (rows.length < 2) return rows[0] ?? null;
  const keep = rows.find((p) => p.videoThumbnailUrl) ?? rows[0];
  for (const p of rows) {
    if (Number(p.id) === Number(keep.id)) continue;
    await M.retireStaleId(Number(p.id), uuid); // uuid-verified: cannot hit another post
  }
  return keep;
}

// ── run ───────────────────────────────────────────────────────────────────────
let rows = await board();
const baseline = rows.length;
const targets = pendingOf(rows).filter((p) => !p.videoThumbnailUrl)
  .sort((a, b) => String(a.publicationDate.dateTime).localeCompare(String(b.publicationDate.dateTime)));
console.log(`board baseline: ${baseline} live / ${new Set(rows.map((p) => String(p.uuid))).size} distinct`);
console.log(`pending needing a thumbnail: ${targets.length}\n`);

let set = 0, failed = 0;
for (let i = 0; i < targets.length; i += BATCH) {
  console.log(`── batch ${Math.floor(i / BATCH) + 1} ──`);
  for (const t of targets.slice(i, i + BATCH)) {
    const vid = idOf(t.text), uuid = String(t.uuid);
    try {
      const url = hosted[vid]?.url ?? (await hostStill(vid, still(vid, Number(t.videoCoverMilliseconds ?? 0))));
      hosted[vid] = { url, coverMs: Number(t.videoCoverMilliseconds ?? 0), uuid }; save();

      const id = await M.resolveId(uuid);
      if (id === null) throw new Error("post vanished");
      const cur = await M.getPost(id);
      await M.putPost(id, M.buildUpdateBody(cur, { videoThumbnailUrl: url }));

      const kept = await dedupeOn(uuid);
      if (!kept?.videoThumbnailUrl) throw new Error("thumbnail did not survive the update");
      console.log(`  ${vid}  ${String(t.publicationDate.dateTime).slice(0, 16)}  ${(Number(t.videoCoverMilliseconds) / 1000).toFixed(1)}s  OK`);
      set++;
    } catch (e) {
      console.log(`  ${vid}  FAILED: ${String(e.message).slice(0, 120)}`);
      failed++;
    }
  }
  rows = await board();
  const distinct = new Set(rows.map((p) => String(p.uuid))).size;
  const pend = pendingOf(rows).length;
  const ok = rows.length === distinct && rows.length >= baseline && pend === 21;
  console.log(`    ledger: ${rows.length} live / ${distinct} distinct / ${pend} pending  ${ok ? "OK" : "!! MISMATCH"}`);
  if (!ok) { console.log("!! stopping rather than continuing"); process.exit(1); }
}

rows = await board();
const withT = pendingOf(rows).filter((p) => p.videoThumbnailUrl).length;
console.log(`\nset this run: ${set}  failed: ${failed}`);
console.log(`pending WITH an explicit thumbnail: ${withT}/${pendingOf(rows).length}`);
