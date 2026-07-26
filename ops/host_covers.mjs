/**
 * host_covers.mjs — get the 5 branded covers onto a DURABLE PUBLIC host.
 *
 * The problem this solves. Metricool stores `videoThumbnailUrl` VERBATIM — verified by
 * read-back, it does NOT rehost the way it rehosts `media`. So the cover URL has to
 * stay valid for as long as the post is scheduled. Neither existing option works:
 *   - cdn.publer.com (where the Publer-era covers live) is hotlink-protected and 403s
 *     without Publer's own Referer, so Metricool and Instagram cannot fetch it;
 *   - our S3 bucket is private and blocks public reads, and a presigned URL signed by
 *     an instance role dies with the role's session, well before Wednesday's posts run.
 *
 * The one durable public host we have is static.metricool.com, and Metricool WILL copy
 * bytes onto it — for `media`, unconditionally, at schedule time. So each cover is
 * uploaded as the media of a throwaway 2027 draft, the rehosted static.metricool.com
 * URL is read back, and the draft is deleted. Metricool's delete is soft and the media
 * survives it (confirmed in the migration testing), and this verifies the URL still
 * serves AFTER the delete before trusting it.
 *
 * Writes the resulting URLs into ab-testing/covers-manifest.json under `hosted`, so the
 * posting path has a stable, tracked source of truth and this never has to run again.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const REPO = "/home/ec2-user/sffs-ai-video-pipeline";
const M = await import(`${REPO}/hermes/src/metricool.ts`);
const { uploadToS3 } = await import(`${REPO}/hermes/src/s3.ts`);

const COLORS = ["yellow", "coral", "blue", "green", "pink"];
const MANIFEST = join(REPO, "ab-testing", "covers-manifest.json");
const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
manifest.hosted = manifest.hosted || {};

for (const color of COLORS) {
  if (manifest.hosted[color]) {
    const r = await fetch(manifest.hosted[color], { method: "GET", headers: { Range: "bytes=0-63" } });
    if (r.ok) { console.log(`  ${color}: already hosted, still serving (HTTP ${r.status})`); continue; }
    console.log(`  ${color}: recorded url no longer serves (HTTP ${r.status}) — re-hosting`);
  }
  // Presign is fine HERE: it only has to survive the few seconds of the create call,
  // because Metricool copies media bytes onto its own CDN immediately.
  const src = uploadToS3(`/tmp/covers/${color}.png`, `covers/sffs-cover-${color}.png`);
  const post = await M.createPost({
    text: `cover-host ${color} — throwaway, deleted immediately`,
    mediaUrl: src,
    publicationDate: { dateTime: "2027-12-01T10:00:00", timezone: "America/Chicago" },
    networks: ["instagram"],
    draft: true,
    autoPublish: false,
  });
  const back = await M.getPost(Number(post.id));
  const hosted = (back.media || []).find((u) => String(u).includes("static.metricool.com"));
  if (!hosted) { console.log(`  ${color}: FAILED — not rehosted; media=${JSON.stringify(back.media)}`); continue; }
  await M.deletePost(String(post.uuid));
  // The URL must survive the delete, or it is worthless as a cover.
  const after = await fetch(hosted, { method: "GET", headers: { Range: "bytes=0-63" } });
  console.log(`  ${color}: ${after.ok ? "OK" : "BROKEN"} after delete (HTTP ${after.status})  ${hosted}`);
  if (after.ok) manifest.hosted[color] = hosted;
}

manifest.hosted_note =
  "Durable PUBLIC cover URLs on static.metricool.com. Metricool stores videoThumbnailUrl " +
  "verbatim (it does NOT rehost it, unlike media), so the cover URL must stay valid for the " +
  "life of the scheduled post. cdn.publer.com 403s without Publer's Referer and our S3 bucket " +
  "is private with role-signed URLs that expire, so the covers are parked on Metricool's own " +
  "public CDN by uploading each as throwaway media. Written by tools/host_covers.mjs.";
manifest.hosted_at = new Date().toISOString();
writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
console.log(`\nhosted ${Object.keys(manifest.hosted).length}/5 covers -> ${MANIFEST}`);
