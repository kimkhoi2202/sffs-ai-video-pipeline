/**
 * backfill_covers.mjs — put the branded cover on the already-scheduled posts.
 *
 * 41 posts went onto the calendar with no cover, so each falls back to its own first
 * frame. On the motion-hook arm frame one is four blank coloured panels by design, so
 * those reels were showing four rectangles as their poster while the control arm fell
 * back to a readable question plate — the two arms differed in POSTER QUALITY as well
 * as opening, which would have let a thumbnail explain a skip-rate difference.
 *
 * Cover only. The schedule time, caption, providers and media are read from the live
 * post and written straight back, because PUT is a full replace.
 *
 * Single-id operations throughout, no deletes, and nothing is recreated: Metricool
 * supports in-place updates, which is the whole reason this is a backfill rather than
 * a delete-and-repost. An ALREADY-PUBLISHED post is skipped — its cover is fixed on
 * Instagram's side and changing the scheduler record cannot alter the live reel.
 *
 *   node ops/backfill_covers.mjs          # dry run
 *   node ops/backfill_covers.mjs --write  # apply
 */
const REPO = "/home/ec2-user/sffs-ai-video-pipeline";
const M = await import(`${REPO}/hermes/src/metricool.ts`);
const C = await import(`${REPO}/hermes/src/covers.ts`);
const { readJSON, writeJSONAtomic } = await import(`${REPO}/hermes/src/state.ts`);
const { CONFIG } = await import(`${REPO}/hermes/src/config.ts`);
const { join } = await import("node:path");

const WRITE = process.argv.includes("--write");
const LEDGER = join(CONFIG.DATA_DIR, "metricool-scheduled.json");

const rows = await M.listPosts("2026-07-01T00:00:00", "2026-12-31T23:59:59");
console.log(`calendar: ${rows.length} post(s)\n`);

const led = readJSON(LEDGER, { posts: [] });
const byUuid = new Map((led.posts ?? []).map((r) => [String(r.uuid), r]));

const published = [];
const todo = [];
for (const p of rows) {
  const isPub = (p.providers ?? []).some((x) => String(x.status).toUpperCase() === "PUBLISHED");
  if (isPub) { published.push(p); continue; }
  if (p.videoThumbnailUrl) continue; // already covered
  todo.push(p);
}
console.log(`already published (cover is immutable, SKIPPED): ${published.length}`);
for (const p of published) {
  const u = (p.providers ?? []).find((x) => x.publicUrl)?.publicUrl;
  console.log(`  ${p.publicationDate?.dateTime}  uuid=${p.uuid}  ${u}`);
}
console.log(`\nneeding a cover: ${todo.length}\n`);

// Slot index drives the colour rotation, exactly as at create time. Sorting by time
// keeps consecutive posts on different colours.
todo.sort((a, b) => String(a.publicationDate?.dateTime).localeCompare(String(b.publicationDate?.dateTime)));

let ok = 0, failed = 0;
for (let i = 0; i < todo.length; i++) {
  const p = todo[i];
  const day = String(p.publicationDate?.dateTime || "").slice(0, 10);
  const rec = byUuid.get(String(p.uuid));
  // Reuse the ledger's slot number where we have it so a re-run is stable; else index.
  const slot = rec?.videoId ? Number(String(rec.videoId).split("-r").pop()) - 1 : i;
  const cover = C.hostedCoverUrlFor(day, Number.isFinite(slot) ? slot : i, "instagram");
  const label = `${p.publicationDate?.dateTime}  ${rec?.videoId ?? p.uuid}  arm=${rec?.opening ?? "?"}`;
  if (!cover) { console.log(`  SKIP ${label} — no cover in manifest`); failed++; continue; }
  if (!WRITE) { console.log(`  would set ${cover.color.padEnd(6)} ${label}`); continue; }
  try {
    const r = await M.setCover(String(p.uuid), cover.url);
    if (!r.updated) { console.log(`  FAIL ${label} — uuid no longer resolves`); failed++; continue; }
    console.log(`  set ${cover.color.padEnd(6)} ${label}`);
    if (rec) { rec.cover = cover.color; rec.cover_url = cover.url; }
    ok++;
  } catch (e) {
    console.log(`  FAIL ${label} — ${e instanceof Error ? e.message : String(e)}`);
    failed++;
  }
}

if (WRITE) {
  led.updated_at = new Date().toISOString();
  writeJSONAtomic(LEDGER, led);
  console.log(`\nupdated ${ok}, failed ${failed}`);
} else {
  console.log(`\n(dry run; pass --write to apply)`);
}
