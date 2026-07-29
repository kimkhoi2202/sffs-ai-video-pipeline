/**
 * caption_platform_fix.mjs — bring the captions ALREADY on the board in line with the
 * per-platform substitution layer (hermes/src/platformCaption.ts).
 *
 * TWO BUCKETS, TWO DIFFERENT TRANSFORMS, deliberately.
 *
 *   - The 12 pending YOUTUBE posts get the FULL adaptation: follow -> subscribe, the
 *     TikTok-native hashtags mapped to their YouTube counterparts, and the per-post
 *     /go/ tracker replaced by the /youtube vanity URL.
 *   - The 10 pending INSTAGRAM drafts get the URL CHANGE ONLY. "Follow" is the right
 *     verb on Instagram and the base caption is written in the Instagram voice, so
 *     nothing else about their wording is in scope. This is not laziness, it is the
 *     narrower instruction: those ten are the most protected objects on the board.
 *
 * WHY IN PLACE AND NOT DELETE-AND-RECREATE. `text` is in metricool.ts's PUT_WRITABLE
 * whitelist and a PUT whose `media` is unchanged returns 200 (a PUT that CHANGES media
 * returns 500). setText() builds the body from the live row, so media is byte-identical
 * by construction, and it retires the stale numeric id the PUT leaves behind.
 *
 * THE TWO THINGS THAT WENT WRONG BEFORE, AND WHAT GUARDS THEM HERE:
 *   1. THE BOARD CAN MOVE UNDER A WRITE. The first run of this script proved it the
 *      expensive way: the PUT itself replaced its record in place (46 rows -> 46), but
 *      the stale-id retirement that followed deleted a PUBLISHED Instagram reel whose
 *      numeric id had been reassigned onto the id being retired. setText no longer
 *      deletes anything (see metricool.ts), and the board is censused before and after
 *      EVERY write here as an independent check, halting on any movement in either
 *      direction rather than carrying on.
 *   2. The numeric id is REASSIGNED on every update while the uuid is stable, so every
 *      operation re-reads by uuid and nothing caches an id across a write.
 *
 * Usage:  node ops/caption_platform_fix.mjs [--apply]
 *         Default is a DRY RUN that prints every before/after and writes nothing.
 */
import { listPosts, setText, getPost, resolveId } from "../hermes/src/metricool.ts";
import { captionForNetwork, vanityUrl } from "../hermes/src/platformCaption.ts";
import { withLink, stripTrackerLinks } from "../hermes/src/attribution.ts";

const APPLY = process.argv.includes("--apply");
const WIDE = ["2020-01-01T00:00:00", "2030-12-31T23:59:59"];
const netsOf = (p) => (p.providers ?? []).map((x) => x.network);
const statusOf = (p) => (p.providers ?? []).map((x) => x.status ?? "?").join("+");

/** The whole board, plus the shape we halt on if it moves. */
async function census() {
  const rows = await listPosts(...WIDE);
  return { rows, n: rows.length, uuids: new Set(rows.map((p) => String(p.uuid))) };
}

/** Everything about a post that this repair must NOT change. */
function invariants(p) {
  return JSON.stringify({
    when: p.publicationDate?.dateTime ?? null,
    tz: p.publicationDate?.timezone ?? null,
    media: p.media ?? [],
    thumb: p.videoThumbnailUrl ?? null,
    coverMs: p.videoCoverMilliseconds ?? null,
    draft: !!p.draft,
    autoPublish: !!p.autoPublish,
    networks: netsOf(p),
  });
}

const fail = (msg) => { console.error(`\nHALT: ${msg}`); process.exit(2); };

const base = await census();
console.log(`BOARD CENSUS (baseline): ${base.n} rows`);

const youtube = base.rows.filter((p) => netsOf(p).includes("youtube") && statusOf(p) === "PENDING");
const igDrafts = base.rows.filter((p) => netsOf(p).includes("instagram") && p.draft === true && p.autoPublish === false);
console.log(`  youtube pending : ${youtube.length}`);
console.log(`  instagram drafts: ${igDrafts.length}`);
if (youtube.length !== 12) fail(`expected 12 pending YouTube posts, found ${youtube.length}`);
if (igDrafts.length !== 10) fail(`expected 10 Instagram drafts, found ${igDrafts.length}`);

// The two transforms. Instagram is URL-only ON PURPOSE (see the header).
const plan = [
  ...youtube.map((p) => ({ p, bucket: "youtube", next: captionForNetwork(String(p.text ?? ""), "youtube") })),
  ...igDrafts.map((p) => ({ p, bucket: "instagram(url-only)", next: withLink(stripTrackerLinks(String(p.text ?? "")), vanityUrl("instagram")) })),
];

console.log(`\n${"=".repeat(78)}\nPLANNED CHANGES${APPLY ? "" : "  (DRY RUN — nothing is written)"}\n${"=".repeat(78)}`);
for (const item of plan) {
  const changed = String(item.p.text ?? "") !== item.next;
  console.log(`\n[${item.bucket}] ${item.p.publicationDate?.dateTime}  uuid=${item.p.uuid}  ${changed ? "CHANGED" : "no change"}`);
  if (changed) {
    console.log("  BEFORE: " + JSON.stringify(String(item.p.text ?? "")));
    console.log("  AFTER : " + JSON.stringify(item.next));
  }
}

if (!APPLY) {
  console.log(`\nDRY RUN complete. ${plan.filter((i) => String(i.p.text ?? "") !== i.next).length} of ${plan.length} would change. Re-run with --apply.`);
  process.exit(0);
}

console.log(`\n${"=".repeat(78)}\nAPPLYING\n${"=".repeat(78)}`);
let expected = base.n;
const results = [];
for (const item of plan) {
  const uuid = String(item.p.uuid);
  if (String(item.p.text ?? "") === item.next) { results.push({ uuid, bucket: item.bucket, skipped: true }); continue; }

  // Re-read by uuid: the numeric id is reassigned on every update.
  const idNow = await resolveId(uuid);
  if (idNow === null) fail(`${uuid} vanished from the board before its write`);
  const pre = await getPost(idNow);
  const preInv = invariants(pre);

  const res = await setText(uuid, item.next);
  if (!res.updated) fail(`${uuid} setText reported no update`);

  // CENSUS AFTER EVERY WRITE. setText censuses internally and throws rather than
  // deleting anything; this is the independent second look. A PUT that moves the row
  // COUNT in either direction is a stop condition: one fewer means a row was
  // destroyed, one more means a stray row is now evicting a real pending post.
  const after = await census();
  if (after.n !== expected) fail(`board moved ${expected} -> ${after.n} rows after writing ${uuid}`);
  if (!after.uuids.has(uuid)) fail(`${uuid} is no longer on the board after its own write`);

  const post = await getPost(await resolveId(uuid));
  if (invariants(post) !== preInv) {
    console.error("  before: " + preInv + "\n  after : " + invariants(post));
    fail(`${uuid} changed something it must not have`);
  }
  if (String(post.text ?? "") !== item.next) fail(`${uuid} text did not take`);

  // The Instagram drafts carry extra protection: they are awaiting human approval.
  if (item.bucket.startsWith("instagram")) {
    if (post.draft !== true || post.autoPublish !== false) fail(`${uuid} left the draft state (draft=${post.draft} autoPublish=${post.autoPublish})`);
    if (!post.videoThumbnailUrl) fail(`${uuid} lost its cover`);
  } else {
    if (post.draft !== false || post.autoPublish !== true) fail(`${uuid} left the live-scheduled state`);
  }

  console.log(`  ok  [${item.bucket}] ${post.publicationDate?.dateTime} uuid=${uuid} id=${res.id} rows=${after.n}`);
  results.push({ uuid, bucket: item.bucket, id: res.id });
}

const final = await census();
console.log(`\nBOARD CENSUS (final): ${final.n} rows (baseline ${base.n})`);
if (final.n !== base.n) fail(`board census moved ${base.n} -> ${final.n}`);
console.log(`written: ${results.filter((r) => !r.skipped).length}, skipped (already correct): ${results.filter((r) => r.skipped).length}`);
console.log("OK");
