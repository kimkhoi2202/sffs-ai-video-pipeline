/**
 * reconcile.ts — close the A/B LEARNING LOOP for the agent's OWN posts.
 *
 * The loop creates Metricool DRAFTS and records each in ab-database.json with a
 * `metricool_uuid` (Metricool's stable planner id) but a NULL `platform_post_id`
 * (the network-native TikTok video id / Instagram media id), a null `permalink` and
 * no `posted_at` — those only exist once a human APPROVES the draft and it actually
 * goes out. Until they are back-filled, scoring (which joins matured analytics onto
 * ab-database by `platform_post_id`) can never attach metrics to the agent's own
 * posts, so the agent cannot learn from them.
 *
 * THE JOIN, AND WHY IT LOOKS LIKE THIS
 *
 * Metricool splits the two halves of a post across two APIs that share no id:
 *   - the PLANNER (`listPosts`) knows `uuid` and, once published, the provider's
 *     `publicUrl` — but never the native post id;
 *   - ANALYTICS (`insights.ts`) knows the native `post_id` and the post's `url` —
 *     but never the planner uuid.
 * The permalink is the only field both sides carry, so it is the join key:
 *   ab-database.metricool_uuid -> planner.publicUrl == analytics.url -> post_id.
 *
 * `uuid` is a signed 64-bit integer rendered as a string and CAN BE NEGATIVE, so it
 * is compared and stored as TEXT throughout. The numeric `id` is reassigned on every
 * update, so it is deliberately never persisted as a join key.
 *
 * This module does two things:
 *   1. `reconcile()` — read Metricool (planner + analytics, GET only) and back-fill
 *      `platform_post_id` / `permalink` / `posted_at` onto each ab-database record by
 *      matching on `metricool_uuid`. IDEMPOTENT (fills a field only when it is
 *      currently empty) and DRAFT-SAFE (read + local JSON write only — it imports
 *      ZERO create/schedule/publish/delete/update paths).
 *   2. the pure `indexInsights` / `matchInsight` helpers score.ts uses to attach
 *      matured metrics to a record by its native `platform_post_id`.
 *
 * The pure functions here (no network) are the hermetically unit-tested core
 * (reconcile.test.ts); `reconcile()` is the thin live orchestrator around them.
 */
import { listPosts, type McPost } from "./metricool.ts";
import { pullInsights, type FlatInsight } from "./insights.ts";
import { readJSON, writeJSONAtomic } from "./state.ts";
import { CONFIG } from "./config.ts";
import { info, warn } from "./log.ts";

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Normalize any id to a trimmed string; "" for null/undefined/blank. */
export function idStr(x: unknown): string {
  return x == null ? "" : String(x).trim();
}

/** True when a back-fillable field is currently empty (null / undefined / blank). */
export function isEmptyField(v: unknown): boolean {
  return v == null || (typeof v === "string" && v.trim() === "");
}

/**
 * Canonical form of a post permalink, so the planner side and the analytics side of
 * the same post compare equal. Instagram hands back the same reel URL with and
 * without its trailing slash depending on which endpoint answered, which would
 * otherwise silently halve the match rate.
 */
export function normalizePermalink(u: unknown): string {
  const s = idStr(u);
  if (!s) return "";
  return s.replace(/[?#].*$/, "").replace(/\/+$/, "").toLowerCase();
}

/**
 * Coerce a Metricool timestamp to a plain string.
 *
 * Defence in depth: insights.ts normalises this at the source, but `posted_at` is
 * persisted into ab-database and then parsed by rollup.ts's timeBucket(), which would
 * stringify a leaked `{dateTime, timezone}` object to "[object Object]" and silently
 * drop the post from the time-of-day rollup. A wrong shape must not survive to disk.
 */
export function timeStr(v: unknown): string {
  if (typeof v === "string") return v.trim();
  if (v && typeof v === "object") {
    const dt = (v as { dateTime?: unknown }).dateTime;
    if (typeof dt === "string") return dt.trim();
  }
  return "";
}

/**
 * A normalized "what Metricool knows about this post" reference, keyed by the stable
 * planner uuid (== ab-database `metricool_uuid`).
 */
export interface NativeRef {
  metricool_uuid: string;
  platform_post_id: string | null; // network-native id (TikTok video id / IG media id)
  permalink: string | null;
  posted_at: string | null;
  network?: string | null;
  account_id?: string | null;
}

/**
 * Build native refs by joining the PLANNER's published posts to ANALYTICS on the
 * permalink. A planner post that has published but whose analytics row has not
 * appeared yet still yields a ref (permalink + posted_at), just without a native id;
 * the next cycle fills that in, because back-fill is idempotent per field.
 */
export function nativeRefsFromBoard(boardPosts: McPost[], insights: FlatInsight[]): NativeRef[] {
  const byUrl = new Map<string, FlatInsight>();
  for (const f of insights ?? []) {
    const u = normalizePermalink(f?.post_link);
    if (u) byUrl.set(u, f);
  }
  const out: NativeRef[] = [];
  for (const p of boardPosts ?? []) {
    const uuid = idStr((p as any)?.uuid);
    if (!uuid) continue;
    for (const pr of ((p as any)?.providers ?? []) as any[]) {
      if (pr?.status !== "PUBLISHED") continue;
      const permalink = idStr(pr?.publicUrl) || null;
      const hit = permalink ? byUrl.get(normalizePermalink(permalink)) : undefined;
      out.push({
        metricool_uuid: uuid,
        platform_post_id: (hit && idStr(hit.post_id)) || null,
        permalink,
        posted_at: timeStr((p as any)?.publicationDate?.dateTime) || timeStr(hit?.scheduled_at) || null,
        network: idStr(pr?.network) || hit?.network || null,
        account_id: CONFIG.ACCOUNTS[idStr(pr?.network)] ?? null,
      });
    }
  }
  return out;
}

/**
 * Merge several ref lists into one map keyed by metricool_uuid, FIRST-NON-NULL-WINS
 * per field. Pass the primary/most-trusted source first.
 */
export function indexRefs(refsLists: NativeRef[][]): Map<string, NativeRef> {
  const map = new Map<string, NativeRef>();
  for (const refs of refsLists) {
    for (const r of refs ?? []) {
      if (!r?.metricool_uuid) continue;
      const cur = map.get(r.metricool_uuid);
      if (!cur) {
        map.set(r.metricool_uuid, { ...r });
        continue;
      }
      cur.platform_post_id = cur.platform_post_id ?? r.platform_post_id;
      cur.permalink = cur.permalink ?? r.permalink;
      cur.posted_at = cur.posted_at ?? r.posted_at;
      cur.network = cur.network ?? r.network ?? null;
      cur.account_id = cur.account_id ?? r.account_id ?? null;
    }
  }
  return map;
}

export interface BackfillResult {
  records: number;
  matched: number;
  records_changed: number;
  filled: { platform_post_id: number; permalink: number; posted_at: number };
}

/**
 * Back-fill platform_post_id / permalink / posted_at onto ab-database posts[] by
 * matching each record's `metricool_uuid` against the ref index. Mutates posts in
 * place. IDEMPOTENT: a field is only written when currently empty AND the ref has a
 * value, so re-running after a successful fill changes nothing. Pure (no I/O).
 */
export function backfillAbPosts(posts: any[], refIndex: Map<string, NativeRef>): BackfillResult {
  const res: BackfillResult = {
    records: 0,
    matched: 0,
    records_changed: 0,
    filled: { platform_post_id: 0, permalink: 0, posted_at: 0 },
  };
  for (const p of posts ?? []) {
    res.records++;
    const uuid = idStr(p?.metricool_uuid);
    if (!uuid) continue;
    const ref = refIndex.get(uuid);
    if (!ref) continue;
    res.matched++;
    let changed = false;
    if (isEmptyField(p.platform_post_id) && ref.platform_post_id) {
      p.platform_post_id = ref.platform_post_id;
      res.filled.platform_post_id++;
      changed = true;
    }
    if (isEmptyField(p.permalink) && ref.permalink) {
      p.permalink = ref.permalink;
      res.filled.permalink++;
      changed = true;
    }
    if (isEmptyField(p.posted_at) && ref.posted_at) {
      p.posted_at = ref.posted_at;
      res.filled.posted_at++;
      changed = true;
    }
    if (changed) res.records_changed++;
  }
  return res;
}

// ---------------------------------------------------------------------------
// Metrics-join helpers (used by score.ts) — pure, network-free.
// ---------------------------------------------------------------------------
export interface InsightIndex {
  byNative: Map<string, FlatInsight>;
}

/**
 * Index matured insights by the network-native post id.
 *
 * There is deliberately no second index here. The Publer-era join carried a fallback
 * on Publer's own internal post id, because Publer's analytics reported it alongside
 * the native id. Metricool's analytics expose no planner uuid at all, so no such
 * fallback can exist — which is why reconcile() runs BEFORE scoring in cycle.ts: it
 * back-fills the native id first so the very next join can find it.
 */
export function indexInsights(flat: FlatInsight[]): InsightIndex {
  const byNative = new Map<string, FlatInsight>();
  for (const f of flat ?? []) {
    const n = idStr(f?.post_id);
    if (n) byNative.set(n, f);
  }
  return { byNative };
}

/** Find the matured insight for an ab-database post, by its native platform id. */
export function matchInsight(p: any, idx: InsightIndex): FlatInsight | undefined {
  const native = idStr(p?.platform_post_id);
  if (!native) return undefined;
  return idx.byNative.get(native);
}

// ---------------------------------------------------------------------------
// Live orchestrator — read Metricool (GET only), back-fill ab-database.json.
// ---------------------------------------------------------------------------
export interface ReconcileResult {
  ok: boolean;
  records: number;
  matched: number;
  records_changed: number;
  filled: { platform_post_id: number; permalink: number; posted_at: number };
  sources: { board_published: number; insights: number };
  wrote: boolean;
  note: string;
}

const BOARD_FROM = "2026-01-01T00:00:00";
const BOARD_TO = "2030-12-31T23:59:59";

/**
 * Back-fill native ids/permalinks/posted_at onto ab-database.json from Metricool.
 * Read-only on Metricool (planner GET + analytics GET); the only write is the local
 * ab-database.json (atomic), and only when something actually changed.
 */
export async function reconcile(): Promise<ReconcileResult> {
  const empty = { platform_post_id: 0, permalink: 0, posted_at: 0 };
  const db = readJSON<any>(CONFIG.AB_DB, null);
  if (!db || !Array.isArray(db.posts)) {
    return {
      ok: false,
      records: 0,
      matched: 0,
      records_changed: 0,
      filled: empty,
      sources: { board_published: 0, insights: 0 },
      wrote: false,
      note: "ab-database.json missing/invalid; nothing to reconcile",
    };
  }

  const to = ymd(new Date());
  const from = ymd(new Date(Date.now() - 90 * 86400_000));

  let board: McPost[] = [];
  try {
    board = await listPosts(BOARD_FROM, BOARD_TO);
  } catch (e) {
    warn("reconcile: planner pull failed (continuing)", { err: e instanceof Error ? e.message : String(e) });
  }

  let insights: FlatInsight[] = [];
  try {
    insights = await pullInsights(from, to);
  } catch (e) {
    warn("reconcile: analytics pull failed (continuing)", { err: e instanceof Error ? e.message : String(e) });
  }

  const refs = nativeRefsFromBoard(board, insights);
  const refIndex = indexRefs([refs]);
  const res = backfillAbPosts(db.posts, refIndex);

  let wrote = false;
  if (res.records_changed > 0) {
    db.updated_at = new Date().toISOString();
    writeJSONAtomic(CONFIG.AB_DB, db);
    wrote = true;
  }

  // "already reconciled" and "nothing could be reconciled" are opposite facts and were
  // being reported with the same sentence. A run where NOTHING MATCHED means no
  // ab-database row shares a uuid with any published post — the learning loop is still
  // open — and reading that as a healthy idempotent no-op is exactly how a dead
  // pipeline goes unnoticed.
  const note =
    refIndex.size === 0
      ? "no published posts on the Metricool board yet — nothing to back-fill"
      : res.matched === 0
      ? `no ab-database row matched any of the ${refIndex.size} published post(s) — nothing could be back-filled (the loop is still open)`
      : res.records_changed === 0
      ? "already reconciled — every matched record was already complete (idempotent no-op)"
      : `back-filled ${res.records_changed} record(s)`;

  info("reconcile done", {
    matched: res.matched,
    records_changed: res.records_changed,
    filled: res.filled,
    board_published: refs.length,
    insights: insights.length,
  });

  return {
    ok: true,
    records: res.records,
    matched: res.matched,
    records_changed: res.records_changed,
    filled: res.filled,
    sources: { board_published: refs.length, insights: insights.length },
    wrote,
    note,
  };
}
