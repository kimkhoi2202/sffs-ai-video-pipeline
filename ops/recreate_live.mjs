#!/usr/bin/env node
/**
 * recreate_live.mjs — put the corrected caption on the twenty remaining scheduled posts
 * by DELETE-AND-RECREATE, and bring the ten Instagram drafts up LIVE in the same write.
 *
 * WHY NOT PUT. An in-place PUT destroyed two published Instagram rows earlier tonight:
 * Metricool reassigns the numeric post id BRAND-WIDE on every write, so a delete aimed
 * at a previously-read id can land on an unrelated post, and one write evicted a
 * published row with no delete issued at all. Delete-and-recreate is the path with a
 * clean record on this account (the APT swap did 10 deletes + 10 creates with the board
 * stable and zero evictions).
 *
 * WHY DELETE FIRST, THEN CREATE. The account enforces a hard ceiling on scheduled rows
 * and exceeding it EVICTS a real post — destroyed, not soft-deleted. Deleting first
 * keeps the row count flat or below at every instant. Metricool's delete is SOFT, so a
 * create that fails is rolled back by restoring the original from the recycle bin.
 *
 * ONE WRITE PER POST, NOT TWO. The Instagram drafts are recreated already live
 * (draft:false, autoPublish:true) rather than recreated as drafts and then flipped.
 * Fewer writes is directly fewer chances to evict a row.
 *
 * THE CENSUS GUARD IS SET-BASED, NOT COUNT-BASED. A count-only census provably missed
 * an eviction tonight, because a duplicate was minted at the same moment a row was
 * destroyed and the two cancelled out. So this diffs the full uuid SET after every
 * single write, and holds the set of PUBLISHED uuids as an absolute invariant: a
 * published uuid that disappears halts the run on the spot. The published set is
 * allowed to GROW — a pending post reaching its slot is normal and expected.
 *
 * THE COVER COMES FROM THE MANIFEST, NOT THE THUMBNAIL. Reading the cover back off the
 * live row is how a cover was silently lost during the mascot re-render: a stale URL
 * copies forward looking fine. The colour is recomputed from the tracked
 * covers-manifest.json via the same deterministic rotation that placed it.
 *
 *   node ops/recreate_live.mjs --bucket ig            # dry run
 *   node ops/recreate_live.mjs --bucket ig --apply --limit 1
 */
const REPO = "/home/ec2-user/sffs-ai-video-pipeline";
const M = await import(`${REPO}/hermes/src/metricool.ts`);
const { captionForNetwork, vanityUrl } = await import(`${REPO}/hermes/src/platformCaption.ts`);
const { withLink, stripTrackerLinks } = await import(`${REPO}/hermes/src/attribution.ts`);
const { hostedCoverUrlFor, loadCoverManifest } = await import(`${REPO}/hermes/src/covers.ts`);
const { readJSON, writeJSONAtomic } = await import(`${REPO}/hermes/src/state.ts`);
const fs = await import("node:fs");

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const APPLY = argv.includes("--apply");
const BUCKET = flag("--bucket", "all");
const LIMIT = Number(flag("--limit", "999"));

const WIDE = ["2020-01-01T00:00:00", "2030-12-31T23:59:59"];
const RUN_STATE = "/home/ec2-user/hermes-data/runs/2026-07-28.json";
const AB_DB = `${REPO}/ab-testing/ab-database.json`;
const LEDGER = "/home/ec2-user/hermes-work/recreate_live_ledger.json";

const netsOf = (p) => (p.providers ?? []).map((x) => x.network);
const isPub = (p) => (p.providers ?? []).some((x) => String(x.status).toUpperCase() === "PUBLISHED");
const statOf = (p) => (p.providers ?? []).map((x) => x.status ?? "?").join("+");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function HALT(msg, extra) {
  console.error(`\n${"!".repeat(72)}`);
  console.error(`HALT: ${msg}`);
  if (extra) console.error(extra);
  console.error(`${"!".repeat(72)}`);
  process.exit(2);
}

async function census() {
  const rows = await M.listPosts(...WIDE);
  return {
    rows,
    n: rows.length,
    all: new Set(rows.map((p) => String(p.uuid))),
    published: new Set(rows.filter(isPub).map((p) => String(p.uuid))),
  };
}
const minus = (a, b) => [...a].filter((x) => !b.has(x)).sort();

/**
 * The guard. Diffs SETS, not counts, and treats the published set as sacred.
 * `expAdd`/`expRem` are the exact uuids this write was allowed to move.
 */
function assertCensus(before, after, expAdd, expRem, label) {
  const pubLost = minus(before.published, after.published);
  if (pubLost.length) {
    HALT(`a PUBLISHED post disappeared after ${label}`,
      `  lost published uuid(s): ${pubLost.join(", ")}\n` +
      `  published before=${before.published.size} after=${after.published.size}\n` +
      `  rows before=${before.n} after=${after.n}`);
  }
  const pubGained = minus(after.published, before.published);
  if (pubGained.length) console.log(`      note: published set grew (a slot came due, expected): +${pubGained.join(", ")}`);

  const added = minus(after.all, before.all);
  const removed = minus(before.all, after.all);
  const wantAdd = [...expAdd].sort();
  const wantRem = [...expRem].sort();
  if (added.join("|") !== wantAdd.join("|")) {
    HALT(`unexpected uuid ADDITION(S) after ${label}`,
      `  expected added: [${wantAdd.join(", ")}]\n  actually added: [${added.join(", ")}]\n  rows ${before.n} -> ${after.n}`);
  }
  if (removed.join("|") !== wantRem.join("|")) {
    HALT(`unexpected uuid REMOVAL(S) after ${label}`,
      `  expected removed: [${wantRem.join(", ")}]\n  actually removed: [${removed.join(", ")}]\n  rows ${before.n} -> ${after.n}`);
  }
}

/** Byte length of the media behind a URL — the honest "media identical" check. */
async function mediaSize(url) {
  try {
    const r = await fetch(url, { method: "HEAD", redirect: "follow" });
    if (!r.ok) return -1;
    return Number(r.headers.get("content-length") || 0);
  } catch { return -1; }
}

// ── Build the work list ──────────────────────────────────────────────────────
const run = JSON.parse(fs.readFileSync(RUN_STATE, "utf8"));
const RUN_ID = String(run.run_id);
const metaByUuid = new Map();
for (const v of run.videos ?? []) {
  for (const u of (v.metricool?.uuids ?? [])) metaByUuid.set(String(u), { index: v.index, videoId: v.id, arm: v.arm });
}
const manifest = loadCoverManifest();
if (!manifest || !manifest.hosted) HALT("cover manifest missing or has no hosted covers — refusing to post uncovered");
const hostedUrls = new Set(Object.values(manifest.hosted));

const base = await census();
console.log(`BASELINE  rows=${base.n}  distinct=${base.all.size}  published=${base.published.size}`);
if (base.all.size !== base.n) HALT(`baseline already has duplicate uuids (rows=${base.n} distinct=${base.all.size})`);

const igRows = base.rows
  .filter((p) => netsOf(p).includes("instagram") && p.draft === true && p.autoPublish === false)
  .sort((a, b) => String(a.publicationDate?.dateTime).localeCompare(String(b.publicationDate?.dateTime)));
const ytRows = base.rows
  .filter((p) => netsOf(p).includes("youtube") && statOf(p) === "PENDING")
  .sort((a, b) => String(a.publicationDate?.dateTime).localeCompare(String(b.publicationDate?.dateTime)));

// RESUMABLE, WITHOUT LOOSENING THE INVARIANT. A recreated Instagram post is live, so
// it leaves the draft filter; the ledger says how many have already been done and the
// two must still add up to the ten we started from.
const already = fs.existsSync(LEDGER) ? JSON.parse(fs.readFileSync(LEDGER, "utf8")).entries ?? [] : [];
const igDone = already.filter((e) => e.bucket === "ig").length;
if (igRows.length + igDone !== 10) HALT(`Instagram drafts do not add up: ${igRows.length} still drafts + ${igDone} already recreated != 10`);
// YouTube rows stay PENDING after recreation, so the count must hold at 12 throughout;
// the ones already fixed drop out of the plan below because their caption is correct.
if (ytRows.length !== 12) HALT(`expected 12 pending YouTube posts, found ${ytRows.length}`);

const plan = [];
for (const p of igRows) {
  const meta = metaByUuid.get(String(p.uuid));
  if (!meta) HALT(`Instagram draft ${p.uuid} has no run-state record — cannot resolve its cover colour from the manifest`);
  const cover = hostedCoverUrlFor(RUN_ID, meta.index, "instagram");
  if (!cover) HALT(`no manifest cover for ${meta.videoId} (index ${meta.index})`);
  if (!hostedUrls.has(cover.url)) HALT(`cover url for ${meta.videoId} is not one of the manifest's hosted covers`);
  plan.push({
    bucket: "ig", post: p, meta, cover,
    next: withLink(stripTrackerLinks(String(p.text ?? "")), vanityUrl("instagram")),
  });
}
for (const p of ytRows) {
  const next = captionForNetwork(String(p.text ?? ""), "youtube");
  if (String(p.text ?? "") === next) continue;   // two are already correct; leave them untouched
  plan.push({ bucket: "yt", post: p, meta: null, cover: null, next });
}

const work = plan.filter((w) => BUCKET === "all" || w.bucket === BUCKET).slice(0, LIMIT);
console.log(`\nPLAN: ${plan.filter((w) => w.bucket === "ig").length} instagram + ${plan.filter((w) => w.bucket === "yt").length} youtube needing change`);
console.log(`THIS RUN: ${work.length}  (bucket=${BUCKET} limit=${LIMIT})  ${APPLY ? "APPLY" : "DRY RUN"}\n`);

for (const w of work) {
  const p = w.post;
  console.log(`[${w.bucket}] ${p.publicationDate?.dateTime} ${p.publicationDate?.timezone}  uuid=${p.uuid} id=${p.id}`);
  console.log(`      cover: ${w.cover ? `${w.cover.color} (manifest)` : "none (YouTube rows carry none)"}`);
  console.log(`      media: ${(p.media ?? [])[0]}`);
  console.log(`      text : ${JSON.stringify(String(p.text ?? "")).slice(0, 150)}`);
  console.log(`         -> ${JSON.stringify(w.next).slice(0, 150)}`);
}
if (!APPLY) { console.log("\n(dry run — nothing written)"); process.exit(0); }

// ── Apply ────────────────────────────────────────────────────────────────────
const ledger = fs.existsSync(LEDGER) ? JSON.parse(fs.readFileSync(LEDGER, "utf8")) : { entries: [] };
let prev = base;
let done = 0;

for (const w of work) {
  const p0 = w.post;
  const oldUuid = String(p0.uuid);
  const label = `${w.bucket} ${p0.publicationDate?.dateTime} ${w.meta?.videoId ?? "yt"}`;
  console.log(`\n${"─".repeat(72)}\n${label}  (old uuid ${oldUuid})`);

  // 1. RE-READ IMMEDIATELY BEFORE THE DELETE. The numeric id is reassigned brand-wide
  //    on every write, so anything read earlier in this run is stale by default.
  const idNow = await M.resolveId(oldUuid);
  if (idNow === null) HALT(`${oldUuid} no longer resolves on the board — refusing to delete anything`);
  const live = await M.getPost(idNow);
  if (String(live.uuid) !== oldUuid) HALT(`id ${idNow} resolves to uuid ${live.uuid}, not ${oldUuid} — the board moved under the read`);
  if (isPub(live)) HALT(`${oldUuid} is PUBLISHED — refusing to touch it`);
  const mediaUrl = (live.media ?? [])[0];
  if (!mediaUrl) HALT(`${oldUuid} has no media`);
  const sizeBefore = await mediaSize(mediaUrl);
  if (sizeBefore <= 0) HALT(`could not size the media behind ${mediaUrl} — refusing to recreate blind`);
  const when = { dateTime: live.publicationDate.dateTime, timezone: live.publicationDate.timezone };
  console.log(`  read  id=${idNow} at=${when.dateTime} ${when.timezone} media=${sizeBefore}B draft=${live.draft} auto=${live.autoPublish}`);

  const input = {
    text: w.next,
    mediaUrl,
    publicationDate: when,
    networks: netsOf(live),
    draft: false,
    autoPublish: true,
  };
  if (w.bucket === "ig") {
    input.videoThumbnailUrl = w.cover.url;                         // FROM THE MANIFEST
    if (typeof live.videoCoverMilliseconds === "number") input.videoCoverMilliseconds = live.videoCoverMilliseconds;
    input.showReelOnFeed = live.instagramData?.showReelOnFeed ?? true;
  } else {
    input.youtubeTitle = String(live.youtubeData?.title ?? "");    // preserved verbatim
    if (live.videoThumbnailUrl) input.videoThumbnailUrl = live.videoThumbnailUrl;
    if (typeof live.videoCoverMilliseconds === "number") input.videoCoverMilliseconds = live.videoCoverMilliseconds;
  }

  // 2. DELETE — single id, by uuid, response must name the id we just read.
  const del = await M.deletePost(oldUuid);
  if (!del.deleted) HALT(`delete of ${oldUuid} did not take`);
  if (del.id !== idNow) HALT(`delete named id ${del.id} but the read named ${idNow} — the board moved between read and delete`);
  console.log(`  del   id=${del.id} (soft, restorable)`);

  const afterDel = await census();
  assertCensus(prev, afterDel, [], [oldUuid], `DELETE of ${oldUuid}`);
  console.log(`  guard rows ${prev.n}->${afterDel.n} published ${afterDel.published.size} (set diff = exactly this delete)`);

  // 3. CREATE — one write, already live.
  let created;
  try {
    created = await M.createPost(input);
    if (!created?.uuid) throw new Error("create returned no uuid");
  } catch (e) {
    console.error(`  CREATE FAILED: ${e instanceof Error ? e.message : String(e)}`);
    const back = await M.restoreDeleted(del.id);
    console.error(`  rolled back: original ${del.id} restored = ${back}`);
    HALT(`create failed for ${label}; the original was ${back ? "restored from the recycle bin" : "NOT restorable — recover by hand"}`);
  }
  const newUuid = String(created.uuid);
  console.log(`  new   uuid=${newUuid} id=${created.id}`);

  const afterCre = await census();
  assertCensus(afterDel, afterCre, [newUuid], [], `CREATE of ${newUuid}`);
  console.log(`  guard rows ${afterDel.n}->${afterCre.n} published ${afterCre.published.size} (set diff = exactly this create)`);

  // 4. RE-READ AND ASSERT.
  const vid = await M.resolveId(newUuid);
  if (vid === null) HALT(`${newUuid} does not resolve after its own create`);
  const back = await M.getPost(vid);
  const problems = [];
  if (String(back.text ?? "") !== w.next) problems.push("caption did not take");
  if (back.publicationDate?.dateTime !== when.dateTime) problems.push(`time moved ${when.dateTime} -> ${back.publicationDate?.dateTime}`);
  if (back.publicationDate?.timezone !== when.timezone) problems.push(`timezone moved ${when.timezone} -> ${back.publicationDate?.timezone}`);
  if (back.draft !== false) problems.push(`draft=${back.draft}, expected false`);
  if (back.autoPublish !== true) problems.push(`autoPublish=${back.autoPublish}, expected true`);
  if (netsOf(back).join("+") !== netsOf(live).join("+")) problems.push(`networks ${netsOf(live).join("+")} -> ${netsOf(back).join("+")}`);
  if ((back.media ?? []).length !== 1) problems.push(`media count ${(back.media ?? []).length}, expected 1`);
  const sizeAfter = await mediaSize((back.media ?? [])[0]);
  if (sizeAfter !== sizeBefore) problems.push(`media size ${sizeBefore}B -> ${sizeAfter}B`);
  if (w.bucket === "ig") {
    if (String(back.videoThumbnailUrl ?? "") !== w.cover.url) problems.push(`cover missing/wrong: ${back.videoThumbnailUrl}`);
    if (back.instagramData?.showReelOnFeed !== (live.instagramData?.showReelOnFeed ?? true)) problems.push("showReelOnFeed changed");
  } else {
    if (String(back.youtubeData?.title ?? "") !== String(live.youtubeData?.title ?? "")) problems.push("youtube title changed");
    if (String(back.youtubeData?.type ?? "") !== String(live.youtubeData?.type ?? "")) problems.push("youtube type changed");
    if (String(back.youtubeData?.privacy ?? "") !== String(live.youtubeData?.privacy ?? "")) problems.push("youtube privacy changed");
    if (back.youtubeData?.madeForKids !== live.youtubeData?.madeForKids) problems.push("madeForKids changed");
  }
  if (problems.length) HALT(`verification failed for ${label}`, "  - " + problems.join("\n  - "));
  console.log(`  verify caption=ok time=${back.publicationDate.dateTime} ${back.publicationDate.timezone} media=${sizeAfter}B cover=${w.bucket === "ig" ? w.cover.color : "n/a"} draft=false autoPublish=true`);

  // 5. RE-POINT ARM LINKAGE (Instagram only — the A/B campaign runs there).
  let repointed = { runState: 0, abDb: 0 };
  if (w.bucket === "ig") {
    const rs = JSON.parse(fs.readFileSync(RUN_STATE, "utf8"));
    for (const v of rs.videos ?? []) {
      const mc = v.metricool; if (!mc) continue;
      const arr = mc.uuids ?? [];
      for (let i = 0; i < arr.length; i++) {
        if (String(arr[i]) === oldUuid) { arr[i] = newUuid; repointed.runState++; mc.media_id = String(created.id); }
      }
    }
    rs.updated_at = new Date().toISOString();
    writeJSONAtomic(RUN_STATE, rs);

    const ab = JSON.parse(fs.readFileSync(AB_DB, "utf8"));
    for (const rec of ab.posts ?? []) {
      if (String(rec.metricool_uuid) !== oldUuid) continue;
      rec.metricool_uuid = newUuid;
      rec.caption = w.next;                       // the caption that is actually live now
      rec.post_state = "scheduled";
      rec.notes = "Created by the Hermes autonomous loop; recreated live (approval gate retired) with the per-network caption fix.";
      repointed.abDb++;
    }
    ab.updated_at = new Date().toISOString();
    writeJSONAtomic(AB_DB, ab);
    if (repointed.runState !== 1 || repointed.abDb !== 1) HALT(`arm re-point touched ${repointed.runState} run-state and ${repointed.abDb} ab-db records, expected 1 and 1`);
    console.log(`  arm   run-state + ab-database re-pointed ${oldUuid} -> ${newUuid}`);
  }

  ledger.entries.push({
    bucket: w.bucket, videoId: w.meta?.videoId ?? null, arm: w.meta?.arm ?? null,
    at: when.dateTime, tz: when.timezone,
    oldUuid, oldId: idNow, newUuid, newId: created.id,
    cover: w.cover?.color ?? null, coverUrl: w.cover?.url ?? null,
    mediaBytes: sizeAfter, draft: false, autoPublish: true,
    rowsAfter: afterCre.n, publishedAfter: afterCre.published.size,
    repointed, done_at: new Date().toISOString(),
  });
  fs.writeFileSync(LEDGER, JSON.stringify(ledger, null, 1));

  prev = afterCre;
  done++;
  await sleep(800);
}

const fin = await census();
console.log(`\n${"═".repeat(72)}`);
console.log(`DONE ${done}/${work.length}   rows ${base.n} -> ${fin.n}   published ${base.published.size} -> ${fin.published.size}`);
const lost = minus(base.published, fin.published);
console.log(`published uuids lost across the whole run: ${lost.length ? lost.join(", ") : "NONE"}`);
if (lost.length) HALT("published rows were lost across the run");
console.log("OK");
