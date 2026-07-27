#!/usr/bin/env node
/**
 * swap_hook.mjs — re-render every PENDING motion-hook reel with the new square opening
 * and swap the media in place, so the hook arm is one homogeneous treatment.
 *
 * WHY THE WHOLE ARM AND NOT JUST NEW POSTS
 * The arm exists to measure one thing: does a wordless motion opening beat a static
 * question plate on 3-second skip rate. If half the arm ships the tilted opening and
 * half ships the square one, the arm is two treatments and the comparison measures
 * nothing. Any reel that has ALREADY published carries the old opening for good and is
 * called out for exclusion instead of being quietly averaged in.
 *
 * WHY IT RE-RENDERS FROM THE SAVED PROPS
 * Each render leaves <id>.<platform>.props.json beside its mp4, holding the exact
 * mapped questions, measured VO durations and variant toggles. Re-rendering from that
 * file reproduces the SAME video with only the new Hook component swapped in — it does
 * not re-pick questions, re-synthesize VO, or risk drawing a different question than
 * the caption and cover were built for.
 *
 * THE TRAPS, ALL OF WHICH HAVE ALREADY BITTEN ONCE
 *   - PUT on an echoed-back post returns HTTP 500 and DESTROYS it. The body is built
 *     by buildUpdateBody's writable whitelist, never from the raw read.
 *   - PUT mints a new numeric id and can leave the old row addressable; the account has
 *     a hard ceiling on scheduled rows and a stray row EVICTS a real post. setCover-
 *     style stale-id retirement applies here too.
 *   - The ledger is verified after EVERY post, not at the end, so a loss is caught on
 *     the post that caused it instead of 18 posts later.
 *   - The cover must survive: it is read off the live post and written back explicitly.
 *
 *   node ops/swap_hook.mjs            # dry run
 *   node ops/swap_hook.mjs --write    # re-render + swap
 */
const REPO = "/home/ec2-user/sffs-ai-video-pipeline";
const M = await import(`${REPO}/hermes/src/metricool.ts`);
const G = await import(`${REPO}/hermes/src/publishGate.ts`);
const { uploadToS3 } = await import(`${REPO}/hermes/src/s3.ts`);
const { readJSON, writeJSONAtomic } = await import(`${REPO}/hermes/src/state.ts`);
const { CONFIG } = await import(`${REPO}/hermes/src/config.ts`);
const { join } = await import("node:path");
const { existsSync, statSync } = await import("node:fs");
const { spawnSync } = await import("node:child_process");

const WRITE = process.argv.includes("--write");
const LEDGER = join(CONFIG.DATA_DIR, "metricool-scheduled.json");

/** Re-render one id from its saved props. Returns the output path. */
function rerender(videoId) {
  const propsFile = join(CONFIG.RENDERS_DIR, `${videoId}.tiktok.props.json`);
  const out = join(CONFIG.RENDERS_DIR, `${videoId}.tiktok.mp4`);
  if (!existsSync(propsFile)) throw new Error(`no props file for ${videoId}`);
  const res = spawnSync("npx", ["remotion", "render", "Short", out, `--props=${propsFile}`, "--log=error", "--concurrency=2"], {
    cwd: CONFIG.REMOTION_DIR, encoding: "utf8", timeout: 10 * 60_000, env: { ...process.env },
  });
  if (res.status !== 0) throw new Error(`render failed: ${(res.stderr || res.stdout || "").slice(-300)}`);
  if (!existsSync(out) || statSync(out).size < 200_000) throw new Error("render produced no/tiny file");
  return out;
}

/** Every ledger entry must still be live. Returns the list of missing videoIds. */
async function ledgerIntact(led) {
  const rows = await M.listPosts("2026-07-01T00:00:00", "2026-12-31T23:59:59");
  const live = new Set(rows.map((p) => String(p.uuid)));
  return { missing: led.posts.filter((r) => !live.has(String(r.uuid))).map((r) => r.videoId), rows };
}

const led = readJSON(LEDGER, { posts: [] });
const byUuid = new Map(led.posts.map((r) => [String(r.uuid), r]));
let { missing, rows } = await ledgerIntact(led);
if (missing.length) { console.error(`ABORT: ledger already short before starting: ${missing.join(", ")}`); process.exit(2); }
console.log(`ledger intact: ${led.posts.length}/${led.posts.length}\n`);

const published = [];
const todo = [];
for (const p of rows) {
  const rec = byUuid.get(String(p.uuid));
  if (!rec || rec.opening !== "motion-hook") continue;
  const isPub = (p.providers ?? []).some((x) => String(x.status).toUpperCase() === "PUBLISHED");
  (isPub ? published : todo).push({ post: p, rec });
}
todo.sort((a, b) => String(a.post.publicationDate.dateTime).localeCompare(String(b.post.publicationDate.dateTime)));

console.log(`HOOK reels ALREADY PUBLISHED with the OLD tilted opening: ${published.length}`);
for (const { post, rec } of published) {
  const url = (post.providers ?? []).find((x) => x.publicUrl)?.publicUrl;
  console.log(`   ${post.publicationDate.dateTime}  ${rec.videoId}  ${url}`);
}
console.log(`\nHOOK reels to re-render + swap: ${todo.length}\n`);
if (!WRITE) { for (const { post, rec } of todo) console.log(`   would swap ${post.publicationDate.dateTime}  ${rec.videoId}`); console.log("\n(dry run)"); process.exit(0); }

let ok = 0;
for (const { post, rec } of todo) {
  const label = `${post.publicationDate.dateTime} ${rec.videoId}`;
  try {
    // The cover already on the live post must come through untouched.
    const cover = post.videoThumbnailUrl;
    const gate = G.publishGate(
      { id: rec.videoId, caption: rec.caption, hashtag_set: rec.hashtag_set, questions: [], explanations: [], cover_url: cover },
      [],
    );
    if (!gate.pass) { console.log(`  SKIP ${label} — publish gate refused: ${gate.reason}`); continue; }

    rerender(rec.videoId);
    const mediaUrl = uploadToS3(join(CONFIG.RENDERS_DIR, `${rec.videoId}.tiktok.mp4`), `hermes/swap/${rec.videoId}.mp4`);

    const staleId = await M.resolveId(String(post.uuid));
    if (staleId === null) { console.log(`  SKIP ${label} — uuid no longer resolves`); continue; }
    const current = await M.getPost(staleId);
    const body = M.buildUpdateBody(current, { media: [mediaUrl], videoThumbnailUrl: cover });
    const updated = await M.putPost(staleId, body);
    const newId = Number(updated?.id);
    if (Number.isFinite(newId) && newId !== staleId) await M.retireStaleId(staleId);

    // Verify the ledger on THIS post, not 18 posts from now.
    const check = await ledgerIntact(led);
    if (check.missing.length) {
      console.error(`\nABORT after ${label}: ledger lost ${check.missing.join(", ")}`);
      process.exit(3);
    }
    rec.uuid = String(updated.uuid ?? post.uuid);
    rec.id = newId;
    rec.hook_version = "square-open";
    byUuid.set(String(rec.uuid), rec);
    writeJSONAtomic(LEDGER, { ...led, updated_at: new Date().toISOString() });
    console.log(`  swapped ${label}  id ${staleId} -> ${newId}`);
    ok++;
  } catch (e) {
    console.log(`  FAIL ${label} — ${e instanceof Error ? e.message : String(e)}`);
  }
}
console.log(`\nswapped ${ok}/${todo.length}`);
