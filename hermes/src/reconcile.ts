/**
 * reconcile.ts — close the A/B LEARNING LOOP for the agent's OWN posts.
 *
 * The loop creates Publer DRAFTS and records each in ab-database.json with a
 * `publer_post_id` (Publer's internal id) but a NULL `platform_post_id` (the
 * network-native TikTok video id / Instagram media id), a null `permalink`, and
 * no `posted_at` — those only exist once a human PUBLISHES the draft. Until they
 * are back-filled, scoring (which joins matured analytics onto ab-database by
 * `platform_post_id`) can never attach metrics to the agent's own posts, so the
 * agent cannot learn from them.
 *
 * This module does two things:
 *   1. `reconcile()` — read Publer (analytics + the published-post list, GET only)
 *      and back-fill `platform_post_id` / `permalink` / `posted_at` onto each
 *      ab-database record by matching on `publer_post_id`. IDEMPOTENT (fills a
 *      field only when it is currently empty) and DRAFT-SAFE (read + local JSON
 *      write only — it imports ZERO create/schedule/publish/delete/update paths).
 *   2. the pure `indexInsights` / `matchInsight` helpers score.ts uses so the
 *      metrics join can FALL BACK to `publer_post_id` when `platform_post_id`
 *      is null (the agent's freshly-published posts, before/without reconcile).
 *
 * The pure functions here (no network) are the hermetically unit-tested core
 * (reconcile.test.ts); `reconcile()` is the thin live orchestrator around them,
 * exercised via the tool/bridge dry-run + tests.
 */
import {
  getPostInsights,
  flattenPostInsights,
  listAllPosts,
  type FlatPostInsight,
} from "./publer.ts";
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
 * A normalized "what Publer knows about this post" reference, keyed by the Publer
 * internal id (== ab-database `publer_post_id`).
 */
export interface PublerNativeRef {
  publer_id: string;
  platform_post_id: string | null; // network-native id (TikTok video id / IG media id)
  permalink: string | null;
  posted_at: string | null;
  network?: string | null;
  account_id?: string | null;
}

/** Build native refs from flattened post insights (the DOCUMENTED, primary source). */
export function nativeRefsFromInsights(flat: FlatPostInsight[]): PublerNativeRef[] {
  const out: PublerNativeRef[] = [];
  for (const f of flat ?? []) {
    const publer_id = idStr(f?.publer_id);
    if (!publer_id) continue;
    out.push({
      publer_id,
      platform_post_id: idStr(f?.post_id) || null,
      permalink: (f?.post_link && String(f.post_link).trim()) || null,
      // insights expose scheduled_at (the publish/schedule time) — a good posted_at proxy.
      posted_at: (f?.scheduled_at && String(f.scheduled_at).trim()) || null,
      network: f?.network ?? null,
      account_id: f?.account_id ?? null,
    });
  }
  return out;
}

/**
 * Build native refs from raw Publer /posts objects (listAllPosts). The /posts
 * shape is tolerant/variant, so probe a set of candidate keys defensively. Used
 * as a gap-filler behind the insights source (esp. for a real `posted_at`).
 */
export function nativeRefsFromRawPosts(rawPosts: any[]): PublerNativeRef[] {
  const pick = (o: any, keys: string[]): string | null => {
    for (const k of keys) {
      const v = o?.[k];
      if (v != null && String(v).trim() !== "") return String(v).trim();
    }
    return null;
  };
  const out: PublerNativeRef[] = [];
  for (const p of rawPosts ?? []) {
    const publer_id = idStr(p?.id ?? p?._id);
    if (!publer_id) continue;
    out.push({
      publer_id,
      platform_post_id: pick(p, ["post_id", "native_id", "provider_id", "external_id", "network_post_id"]),
      permalink: pick(p, ["url", "permalink", "post_link", "link", "short_link", "postUrl"]),
      posted_at: pick(p, ["posted_at", "published_at", "used_at", "completed_at", "scheduled_at", "created_at"]),
      network: (p?.provider ?? p?.network ?? p?.account_type ?? null) as string | null,
      account_id: idStr(p?.account_id) || null,
    });
  }
  return out;
}

/**
 * Merge several ref lists into one map keyed by publer_id, FIRST-NON-NULL-WINS
 * per field. Pass the primary/most-trusted source first (insights), gap-fillers
 * after (raw published posts).
 */
export function indexRefs(refsLists: PublerNativeRef[][]): Map<string, PublerNativeRef> {
  const map = new Map<string, PublerNativeRef>();
  for (const refs of refsLists) {
    for (const r of refs ?? []) {
      if (!r?.publer_id) continue;
      const cur = map.get(r.publer_id);
      if (!cur) {
        map.set(r.publer_id, { ...r });
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
 * matching each record's `publer_post_id` against the ref index. Mutates posts in
 * place. IDEMPOTENT: a field is only written when currently empty AND the ref has
 * a value, so re-running after a successful fill changes nothing. Pure (no I/O).
 */
export function backfillAbPosts(posts: any[], refIndex: Map<string, PublerNativeRef>): BackfillResult {
  const res: BackfillResult = {
    records: 0,
    matched: 0,
    records_changed: 0,
    filled: { platform_post_id: 0, permalink: 0, posted_at: 0 },
  };
  for (const p of posts ?? []) {
    res.records++;
    const pid = idStr(p?.publer_post_id);
    if (!pid) continue;
    const ref = refIndex.get(pid);
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
// Metrics-join fallback helpers (used by score.ts) — pure, network-free.
// ---------------------------------------------------------------------------
export interface InsightIndex {
  byNative: Map<string, FlatPostInsight>;
  byPubler: Map<string, FlatPostInsight>;
}

/** Index flattened insights by BOTH the native post_id and the Publer id. */
export function indexInsights(flat: FlatPostInsight[]): InsightIndex {
  const byNative = new Map<string, FlatPostInsight>();
  const byPubler = new Map<string, FlatPostInsight>();
  for (const f of flat ?? []) {
    const n = idStr(f?.post_id);
    if (n) byNative.set(n, f);
    const pu = idStr(f?.publer_id);
    if (pu) byPubler.set(pu, f);
  }
  return { byNative, byPubler };
}

/**
 * Find the insight for an ab-database post: join on `platform_post_id` when set,
 * else FALL BACK to `publer_post_id` (so the agent's own freshly-published posts,
 * whose native id has not been reconciled yet, still attach metrics).
 */
export function matchInsight(p: any, idx: InsightIndex): FlatPostInsight | undefined {
  const native = idStr(p?.platform_post_id);
  if (native) return idx.byNative.get(native);
  const pub = idStr(p?.publer_post_id);
  if (pub) return idx.byPubler.get(pub);
  return undefined;
}

// ---------------------------------------------------------------------------
// Live orchestrator — read Publer (GET only), back-fill ab-database.json.
// ---------------------------------------------------------------------------
export interface ReconcileResult {
  ok: boolean;
  records: number;
  matched: number;
  records_changed: number;
  filled: { platform_post_id: number; permalink: number; posted_at: number };
  sources: { insights: number; published_posts: number };
  wrote: boolean;
  note: string;
}

/**
 * Back-fill native ids/permalinks/posted_at onto ab-database.json from Publer.
 * Read-only on Publer (analytics GET + published-post GET); the only write is the
 * local ab-database.json (atomic), and only when something actually changed.
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
      sources: { insights: 0, published_posts: 0 },
      wrote: false,
      note: "ab-database.json missing/invalid; nothing to reconcile",
    };
  }

  const to = ymd(new Date());
  const from = ymd(new Date(Date.now() - 90 * 86400_000));

  // (1) primary source: matured post insights (documented publer_id -> native id + permalink).
  let insightsRefs: PublerNativeRef[] = [];
  try {
    const flat: FlatPostInsight[] = [];
    for (const acc of CONFIG.ACCOUNT_IDS) {
      for (let page = 0; page < 20; page++) {
        const { posts, total } = await getPostInsights(acc, { from, to, sort_by: "reach", sort_type: "DESC", page });
        flat.push(...flattenPostInsights(posts));
        if (flat.length >= total || posts.length === 0) break;
      }
    }
    insightsRefs = nativeRefsFromInsights(flat);
  } catch (e) {
    warn("reconcile: insights pull failed (continuing)", { err: e instanceof Error ? e.message : String(e) });
  }

  // (2) gap-filler: the published-post list (real posted_at / any post insights missed).
  let publishedRefs: PublerNativeRef[] = [];
  try {
    const published = await listAllPosts("published", 30);
    publishedRefs = nativeRefsFromRawPosts(published);
  } catch (e) {
    warn("reconcile: published-post pull failed (continuing)", { err: e instanceof Error ? e.message : String(e) });
  }

  const refIndex = indexRefs([insightsRefs, publishedRefs]);
  const res = backfillAbPosts(db.posts, refIndex);

  let wrote = false;
  if (res.records_changed > 0) {
    db.updated_at = new Date().toISOString();
    writeJSONAtomic(CONFIG.AB_DB, db);
    wrote = true;
  }

  const note =
    refIndex.size === 0
      ? "no Publer refs available (no keys / no published posts yet) — nothing back-filled"
      : res.records_changed === 0
      ? "already reconciled — nothing to back-fill (idempotent no-op)"
      : `back-filled ${res.records_changed} record(s)`;

  info("reconcile done", {
    matched: res.matched,
    records_changed: res.records_changed,
    filled: res.filled,
    insights: insightsRefs.length,
    published: publishedRefs.length,
  });

  return {
    ok: true,
    records: res.records,
    matched: res.matched,
    records_changed: res.records_changed,
    filled: res.filled,
    sources: { insights: insightsRefs.length, published_posts: publishedRefs.length },
    wrote,
    note,
  };
}
