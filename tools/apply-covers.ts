#!/usr/bin/env node
/**
 * apply-covers.ts — give each still-SCHEDULED SFFS post a branded custom COVER
 * thumbnail (the "SMART FELLA OR FART SMELLA?" title card, one per brand bg color)
 * WITHOUT touching the video, so every short still cold-opens on its first question.
 *
 * WHY RECREATE (not update):
 *   Publer's PUT /posts/{id} only updates text/title — it cannot set a video cover
 *   (confirmed via publer.com/docs "Updating Posts"). A custom cover is only settable
 *   at CREATE time via networks.{provider}.media[].thumbnails (+ default_thumbnail).
 *   So per post we recreate it via /posts/schedule REUSING THE EXISTING VIDEO
 *   media_id (same bytes -> same cold-open) with our branded thumbnail appended and
 *   default_thumbnail pointed at it, preserving EVERYTHING else (exact caption, exact
 *   jittered scheduled_at, account, IG details {type:reel,feed:true}), then delete the
 *   old post. Serial only (Publer 403s parallel jobs); new is confirmed BEFORE old is
 *   deleted so a slot is never left empty.
 *
 * COVER COLORS (rotate the 5 punchy brand colors; each platform grid cycles all five
 * once; the two platform twins of a round differ; no two globally-consecutive match):
 *   round-027 no-question-vo  IG yellow / TT blue
 *   round-028 no-options-vo   IG coral  / TT green
 *   round-029 speed           IG blue   / TT pink
 *   round-030 one-question    IG green  / TT yellow
 *   round-031 mascot          IG pink   / TT coral
 *
 * SCOPE: only posts still `scheduled` on Publer right now. Any DB record marked
 * scheduled that is NO LONGER live (already auto-published) is reconciled to
 * post_state=published and SKIPPED (never re-covered / never re-rendered).
 *
 * USAGE (run from video/; loadEnv() reads video/.env — no --env-file needed):
 *   node tools/apply-covers.ts                     # DRY RUN — plan only, no mutations
 *   node tools/apply-covers.ts --prep              # upload the 5 covers to Publer (idempotent) + write manifest
 *   node tools/apply-covers.ts --commit            # execute (auto-preps missing covers)
 *   node tools/apply-covers.ts --commit --only ID  # only the post whose CURRENT publer id == ID (canary)
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { readFile as readFileP } from "node:fs/promises";
import { join } from "node:path";
import {
  createPost,
  deletePosts,
  listAccounts,
  listPosts,
  loadEnv,
  pollJob,
} from "./post-to-publer.ts";
import { localIso, serializeDb } from "./post-variant.ts";

const REPO_ROOT = join(import.meta.dirname, "..");
const DB_PATH = join(REPO_ROOT, "ab-testing", "ab-database.json");
const COVERS_DIR = join(REPO_ROOT, "renders.nosync", "covers");
const MANIFEST_PATH = join(COVERS_DIR, "covers-publer-manifest.json");
const PUBLER_BASE = "https://app.publer.com/api/v1";
const SAFETY_MS = 20 * 60 * 1000; // never mutate a post within 20 min of its go-live

/** color -> brand hex (mirrors remotion/src/theme/brand.ts + Thumbnails PINK accent). */
const HEX: Record<string, string> = {
  yellow: "#fce552",
  coral: "#fd7962",
  blue: "#839aff",
  green: "#63c088",
  pink: "#ff5fb0",
};

/** question_round -> per-platform cover bg color. */
const COLOR_BY_ROUND: Record<string, { instagram: string; tiktok: string }> = {
  "round-027": { instagram: "yellow", tiktok: "blue" },
  "round-028": { instagram: "coral", tiktok: "green" },
  "round-029": { instagram: "blue", tiktok: "pink" },
  "round-030": { instagram: "green", tiktok: "yellow" },
  "round-031": { instagram: "pink", tiktok: "coral" },
};

type CoverMedia = { id: string; path: string; thumbnail: string };
type Manifest = { note?: string; covers: Record<string, CoverMedia> };

const log = (m: string) => console.error(`[apply-covers] ${m}`);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Publer post-create jobs return status="complete" even when a post was rejected —
 *  the real per-post errors live in payload.failures. Throw if any are present. */
function jobFailureMessage(job: { payload: any }): string | null {
  const f = job?.payload?.failures;
  if (!f || typeof f !== "object" || !Object.keys(f).length) return null;
  const msgs: string[] = [];
  for (const arr of Object.values(f)) {
    for (const e of Array.isArray(arr) ? arr : [arr]) {
      msgs.push(String((e as any)?.message ?? JSON.stringify(e)));
    }
  }
  return msgs.join(" | ");
}

function authHeaders(): Record<string, string> {
  const key = (process.env.PUBLER_API_KEY ?? "").trim();
  const ws = (process.env.PUBLER_WORKSPACE_ID ?? "").trim();
  if (!key || !ws) throw new Error("Missing PUBLER_API_KEY / PUBLER_WORKSPACE_ID (loadEnv failed?)");
  return { Authorization: `Bearer-API ${key}`, "Publer-Workspace-Id": ws, Accept: "application/json" };
}

/** Direct-upload a local image to Publer (POST /media multipart). Synchronous;
 *  returns the Publer-hosted { id, path, thumbnail } for use as a video cover. */
async function directUploadImage(absPath: string, name: string): Promise<CoverMedia> {
  const buf = await readFileP(absPath);
  const fd = new FormData();
  fd.append("file", new Blob([buf], { type: "image/png" }), name);
  fd.append("direct_upload", "true"); // required to get the final CDN URL
  fd.append("in_library", "true");
  const res = await fetch(`${PUBLER_BASE}/media`, { method: "POST", headers: authHeaders(), body: fd });
  const txt = await res.text();
  if (!res.ok) throw new Error(`Publer direct upload ${name} -> HTTP ${res.status}: ${txt.slice(0, 500)}`);
  const j = JSON.parse(txt);
  if (!j?.id || !j?.path) throw new Error(`Publer direct upload ${name} returned no id/path: ${txt.slice(0, 300)}`);
  return { id: String(j.id), path: String(j.path), thumbnail: String(j.thumbnail ?? j.path) };
}

function readManifest(): Manifest {
  if (existsSync(MANIFEST_PATH)) return JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  return { covers: {} };
}
function writeManifest(m: Manifest) {
  m.note =
    "Publer-hosted custom cover thumbnails for the SFFS scheduled-post covers job (2026-07-21). " +
    "One per brand bg color; direct-uploaded to Publer via POST /media (direct_upload=true, in_library=true). " +
    "Reused across the 2 posts that share a color. Managed by tools/apply-covers.ts.";
  writeFileSync(MANIFEST_PATH, JSON.stringify(m, null, 2) + "\n");
}

/** Ensure every brand color used by the plan has a Publer-hosted cover; upload the
 *  missing ones (idempotent via the manifest). Serial. */
async function ensureCovers(colors: string[]): Promise<Manifest> {
  const m = readManifest();
  for (const color of colors) {
    if (m.covers[color]?.id) {
      log(`cover ${color} already uploaded (${m.covers[color].id})`);
      continue;
    }
    const png = join(COVERS_DIR, `cover-9x16-${color}.png`);
    if (!existsSync(png)) throw new Error(`missing rendered cover PNG: ${png} (render it first)`);
    log(`direct-uploading cover ${color} -> Publer ...`);
    m.covers[color] = await directUploadImage(png, `sffs-cover-${color}.png`);
    writeManifest(m);
    log(`  ${color} -> media ${m.covers[color].id}`);
  }
  return m;
}

async function gatherScheduled(): Promise<any[]> {
  let out: any[] = [];
  for (let p = 0; p < 12; p++) {
    const r = await listPosts({ state: "scheduled", page: p });
    if (!r.length) break;
    out = out.concat(r);
  }
  return out;
}

const stripMs = (iso: string) => iso.replace(/\.\d{1,3}(?=[+-]\d{2}:?\d{2}|Z)/, "");
const sameInstant = (a: string, b: string) => Date.parse(a) === Date.parse(b);

type Plan = {
  oldId: string;
  platform: "instagram" | "tiktok";
  accountId: string;
  round: string;
  color: string;
  hex: string;
  scheduledAt: string; // from LIVE, ms-stripped
};

/** Wait for a newly-created scheduled post to appear for `accountId` that is not in
 *  `beforeIds`, matching the expected scheduled instant. Returns it (or null). */
async function findNewPost(accountId: string, beforeIds: Set<string>, wantIso: string, tries = 40, delay = 3000): Promise<any | null> {
  for (let i = 0; i < tries; i++) {
    const all = await gatherScheduled();
    const cands = all.filter((p) => String(p.account_id) === accountId && !beforeIds.has(String(p.id)));
    const exact = cands.find((p) => sameInstant(String(p.scheduled_at), wantIso));
    if (exact) return exact;
    if (cands.length === 1) return cands[0];
    await sleep(delay);
  }
  return null;
}

/** True if the post's first media has our cover as its default thumbnail. */
function coverApplied(post: any, cover: CoverMedia): boolean {
  const media = Array.isArray(post?.media) ? post.media[0] : null;
  if (!media) return false;
  const thumbs = Array.isArray(media.thumbnails) ? media.thumbnails : [];
  const di = Number(media.default_thumbnail);
  const t = thumbs[di];
  const url = String(t?.real ?? t?.small ?? "");
  return url.includes(cover.id);
}

function buildPlans(db: any, liveById: Map<string, any>): { plans: Plan[]; published: any[]; unknown: any[]; done: any[] } {
  const plans: Plan[] = [];
  const published: any[] = [];
  const unknown: any[] = [];
  const done: any[] = [];
  for (const rec of db.posts) {
    if (rec.post_state !== "scheduled") continue; // only DB records we believe are scheduled
    const oldId = String(rec.publer_post_id);
    const live = liveById.get(oldId);
    if (!live) {
      // No longer scheduled on Publer -> it auto-published (or was removed). Reconcile.
      published.push(rec);
      continue;
    }
    // Idempotency: already covered (live default thumbnail == recorded cover media) -> skip.
    if (rec.cover?.applied === true && rec.cover?.cover_media_id && coverApplied(live, { id: String(rec.cover.cover_media_id), path: "", thumbnail: "" })) {
      done.push(rec);
      continue;
    }
    const round = String(rec.question_round ?? "");
    const platform = rec.platform as "instagram" | "tiktok";
    const color = COLOR_BY_ROUND[round]?.[platform];
    if (!color) {
      unknown.push({ rec, reason: `no color mapping for round=${round} platform=${platform}` });
      continue;
    }
    plans.push({
      oldId,
      platform,
      accountId: String(rec.account_id),
      round,
      color,
      hex: HEX[color],
      scheduledAt: stripMs(String(live.scheduled_at)),
    });
  }
  // soonest-first
  plans.sort((a, b) => Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt));
  return { plans, published, unknown, done };
}

function reconcilePublished(rec: any) {
  const db = JSON.parse(readFileSync(DB_PATH, "utf8"));
  const r = db.posts.find((p: any) => String(p.publer_post_id) === String(rec.publer_post_id));
  if (!r) return;
  r.post_state = "published";
  r.notes =
    `[covers 2026-07-21] Auto-published at its ~${r.scheduled_at ?? "scheduled"} slot BEFORE the cover job ran ` +
    `(no longer in Publer's scheduled list) -> reconciled to published; cover NOT changed (covers cannot be set post-publish). ` +
    (r.notes ?? "");
  db.updated_at = localIso();
  writeFileSync(DB_PATH, serializeDb(db));
}

function updateDbCover(
  oldId: string,
  plan: Plan,
  newId: string,
  cover: CoverMedia,
  defIdx: number,
  checks: { okTime: boolean; okState: boolean; okFeed: boolean; okCover: boolean },
) {
  const db = JSON.parse(readFileSync(DB_PATH, "utf8"));
  const rec = db.posts.find((p: any) => String(p.publer_post_id) === String(oldId));
  if (!rec) throw new Error(`DB record not found for ${oldId}`);
  rec.prior_cover_swap_post_id = oldId;
  rec.publer_post_id = newId;
  rec.cover = {
    bg: plan.color,
    bg_hex: plan.hex,
    style: "SMART FELLA OR FART SMELLA? branded title card (Remotion ThumbV 1080x1920)",
    cover_media_id: cover.id,
    image_path: cover.path,
    image_thumbnail: cover.thumbnail,
    default_thumbnail_index: defIdx,
    cold_open_preserved: true,
    applied: checks.okCover,
    verified: { time: checks.okTime, state: checks.okState, ig_feed: checks.okFeed, cover: checks.okCover },
    applied_at: localIso(),
  };
  const status = checks.okCover ? `Branded ${plan.color} cover applied` : `Recreated WITHOUT confirmed cover (${plan.color} intended)`;
  rec.notes =
    `[covers 2026-07-21] ${status} via delete+recreate (reused existing video media ${rec.publer_media_id}, ` +
    `custom cover thumbnail ${cover.id} appended at index ${defIdx}); video unchanged so it still cold-opens on Q1. ` +
    `Recreated at the SAME scheduled_at ${plan.scheduledAt}; old ${oldId} deleted first (Publer 1-min-gap rule). A/B identity preserved. ` +
    (rec.notes ?? "");
  db.updated_at = localIso();
  writeFileSync(DB_PATH, serializeDb(db));
}

async function main() {
  loadEnv();
  const args = process.argv.slice(2);
  const commit = args.includes("--commit");
  const prepOnly = args.includes("--prep");
  const onlyId = args.includes("--only") ? String(args[args.indexOf("--only") + 1]) : undefined;

  const db = JSON.parse(readFileSync(DB_PATH, "utf8"));
  const accounts = await listAccounts();
  const providerById = new Map(accounts.map((a: any) => [String(a.id), a.provider]));

  const live = await gatherScheduled();
  const liveById = new Map(live.map((p: any) => [String(p.id), p]));

  let { plans, published, unknown, done } = buildPlans(db, liveById);
  if (onlyId) plans = plans.filter((p) => p.oldId === onlyId);

  const now = Date.now();
  console.log(`\n=== APPLY COVERS PLAN (${commit ? "COMMIT" : prepOnly ? "PREP" : "DRY RUN"}) ===`);
  console.log(`live scheduled on Publer: ${live.length} | coverable: ${plans.length} | already-covered (skip): ${done.length} | already-published (reconcile+skip): ${published.length}`);
  for (const rec of done) console.log(`  DONE/skip      ${rec.platform.padEnd(9)} ${rec.question_round}  bg=${rec.cover?.bg} id=${rec.publer_post_id}`);
  for (const p of plans) {
    const mins = Math.round((Date.parse(p.scheduledAt) - now) / 60000);
    console.log(
      `  ${p.scheduledAt}  ${p.platform.padEnd(9)} ${p.round}  bg=${p.color.padEnd(6)} old=${p.oldId}  (in ${mins}m)`,
    );
  }
  for (const rec of published) console.log(`  PUBLISHED/skip  ${rec.platform.padEnd(9)} ${rec.question_round ?? rec.variant?.family}  id=${rec.publer_post_id}`);
  for (const u of unknown) console.log(`  UNKNOWN/skip   ${u.reason}`);

  const colorsNeeded = [...new Set(plans.map((p) => p.color))];

  if (!commit && !prepOnly) {
    console.log(`\n(dry run — no mutations. --prep to upload covers, --commit to apply.)`);
    return;
  }

  // Reconcile already-published records (DB-only; safe in prep + commit).
  for (const rec of published) {
    reconcilePublished(rec);
    log(`reconciled published: ${rec.publer_post_id} (${rec.platform} ${rec.question_round})`);
  }

  const manifest = await ensureCovers(colorsNeeded);
  if (prepOnly) {
    console.log(`\nPREP complete. Covers uploaded:`);
    for (const c of colorsNeeded) console.log(`  ${c}: ${manifest.covers[c].id} -> ${manifest.covers[c].path}`);
    return;
  }

  // Recreate the post at the SAME scheduled_at with the cover baked in. Returns the
  // new live post. Publer enforces a 1-minute gap between an account's posts, so we
  // cannot hold the old post while creating the new one at the same instant — the old
  // post MUST already be deleted before calling this. Retries once on transient failure.
  async function recreateWithCover(
    plan: Plan,
    caption: string,
    mediaObject: Record<string, unknown>,
  ): Promise<any> {
    let lastErr = "";
    for (let attempt = 1; attempt <= 2; attempt++) {
      const beforeIds = new Set(
        (await gatherScheduled()).filter((p) => String(p.account_id) === plan.accountId).map((p) => String(p.id)),
      );
      const jobId = await createPost({
        account_ids: [plan.accountId],
        text: caption,
        media_objects: [mediaObject],
        state: "scheduled",
        scheduled_at: plan.scheduledAt,
        type: "video",
      });
      const job = await pollJob(jobId, { label: "post-create", timeoutMs: 120_000, intervalMs: 2500 });
      const fail = jobFailureMessage(job);
      if (fail) {
        lastErr = `create job reported failure: ${fail}`;
        log(`  attempt ${attempt}: ${lastErr}`);
        await sleep(2000);
        continue;
      }
      const np = await findNewPost(plan.accountId, beforeIds, plan.scheduledAt);
      if (np) return np;
      lastErr = "create job completed but new post not found in scheduled list";
      log(`  attempt ${attempt}: ${lastErr}`);
      await sleep(2000);
    }
    throw new Error(`SLOT EMPTY: recreate failed after deleting old (${lastErr})`);
  }

  const results: any[] = [];
  for (const plan of plans) {
    try {
      // Live re-guard (state + safety window) right before mutating.
      const fresh = (await gatherScheduled()).find((p) => String(p.id) === plan.oldId);
      if (!fresh || fresh.state !== "scheduled") {
        results.push({ ...plan, skipped: true, reason: `old post not scheduled (state=${fresh?.state ?? "gone"})` });
        log(`SKIP ${plan.oldId}: not scheduled anymore`);
        continue;
      }
      if (Date.parse(fresh.scheduled_at) - Date.now() < SAFETY_MS) {
        results.push({ ...plan, skipped: true, reason: `within ${SAFETY_MS / 60000}min safety window (${fresh.scheduled_at})` });
        log(`SKIP ${plan.oldId}: safety window`);
        continue;
      }
      const caption = String(fresh.text ?? "");
      if (!caption) throw new Error(`no caption on live post ${plan.oldId}`);
      const vmedia = Array.isArray(fresh.media) ? fresh.media[0] : null;
      if (!vmedia?.id) throw new Error(`no video media on live post ${plan.oldId}`);
      const existingThumbs = (Array.isArray(vmedia.thumbnails) ? vmedia.thumbnails : []).map((t: any) => ({
        ...(t.id ? { id: String(t.id) } : {}),
        small: String(t.small),
        real: String(t.real),
      }));
      const cover = manifest.covers[plan.color];
      const defIdx = existingThumbs.length; // appended at the end
      const mediaObject = {
        id: String(vmedia.id),
        ...(vmedia.path ? { path: String(vmedia.path) } : {}),
        type: "video",
        thumbnails: [...existingThumbs, { id: cover.id, small: cover.thumbnail, real: cover.path }],
        default_thumbnail: defIdx,
      };

      log(`=== ${plan.platform} ${plan.round} bg=${plan.color} old=${plan.oldId} @ ${plan.scheduledAt} ===`);
      // DELETE-FIRST: Publer requires a 1-min gap between an account's posts, so the
      // old post must be gone before we recreate at the identical instant. The window
      // with an empty slot is a few seconds and the slot is >=20 min in the future.
      const del = await deletePosts([plan.oldId]);
      const deleted = (del?.deleted_ids ?? []).map(String);
      if (!deleted.includes(plan.oldId)) {
        results.push({ ...plan, error: `delete of old ${plan.oldId} not confirmed (${JSON.stringify(del)}); left as-is, no cover` });
        log(`ABORT ${plan.oldId}: delete not confirmed; original left intact`);
        continue;
      }
      log(`  deleted old ${JSON.stringify(deleted)}; recreating with ${plan.color} cover (video ${vmedia.id}, cover ${cover.id} @ idx ${defIdx})`);

      const np = await recreateWithCover(plan, caption, mediaObject);

      const okTime = sameInstant(String(np.scheduled_at), plan.scheduledAt);
      const okState = np.state === "scheduled";
      const okFeed = plan.platform === "instagram" ? np?.details?.feed === true : true;
      const okCover = coverApplied(np, cover);
      log(`  new id=${np.id} state=${np.state} at=${np.scheduled_at} feed=${np?.details?.feed ?? "n/a"} default_thumb=${np?.media?.[0]?.default_thumbnail} coverApplied=${okCover}`);

      // Update DB to the new id regardless (the new post now owns the slot). Record
      // whether the cover actually took so a partial success is never lost.
      updateDbCover(plan.oldId, plan, String(np.id), cover, defIdx, { okTime, okState, okFeed, okCover });

      if (!okState || !okTime || !okFeed) {
        results.push({ ...plan, new_id: String(np.id), applied: false, error: `identity check failed (state=${okState} time=${okTime} feed=${okFeed})` });
        log(`STOP: ${plan.oldId} -> ${np.id} identity check failed; investigate before continuing`);
        break;
      }
      if (!okCover) {
        results.push({ ...plan, new_id: String(np.id), applied: false, error: `cover not applied (default thumbnail != cover ${cover.id})` });
        log(`STOP: cover did not apply on ${np.id}; new post is valid (uncovered) but STOPPING to investigate`);
        break;
      }
      results.push({ ...plan, new_id: String(np.id), cover_media: cover.id, applied: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`ERROR ${plan.oldId}: ${msg}`);
      results.push({ ...plan, error: msg });
      break; // any error here (esp. SLOT EMPTY) -> stop and report rather than cascade
    }
  }

  console.log(`\n=== RESULT ===`);
  console.log(JSON.stringify({ ok: results.every((r) => !r.error), applied: results.filter((r) => r.applied).length, results }, null, 2));
  if (results.some((r) => r.error)) process.exitCode = 1;
}

main().catch((e) => {
  console.error(`[apply-covers] FATAL: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
