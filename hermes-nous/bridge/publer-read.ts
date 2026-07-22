#!/usr/bin/env node
/**
 * publer-read.ts — the READ-ONLY Node entry the `sffs` plugin shells into to
 * LIST accounts / posts and to read per-post ANALYTICS (insights). It is the
 * data-reading complement to bridge/donottouch.ts (safety reads) and
 * bridge/publer-draft.ts (the one sanctioned write path).
 *
 * It imports ONLY read primitives from the pipeline's Publer facade
 * (hermes/src/publer.ts): `listAccounts`, `listPosts`, `listAllPosts`,
 * `getPostInsights`, `flattenPostInsights` — every one of which only ever issues
 * GET requests. It deliberately does NOT import createPost / importMediaFromUrl /
 * schedulePost / deletePost / updatePost, so it is physically unable to create,
 * publish, schedule, or mutate ANY post.
 *
 * USAGE:
 *   node publer-read.ts accounts                         # -> { ok, count, accounts }
 *   node publer-read.ts posts     (stdin=params JSON)    # -> { ok, count, posts }
 *   node publer-read.ts insights  (stdin=params JSON)    # -> { ok, from, to, count, by_account, posts }
 *   add --dry-run (or HERMES_READ_DRY_RUN=1) to any for a NETWORK-FREE run that
 *   echoes the validated request and makes no Publer call.
 *
 *   posts    params: { state?, page?, account_ids?, query?, all?, max_pages? }
 *   insights params: { from, to, account_ids?, sort_by?, sort_type?, max_pages? }
 *
 * LIVE MODE needs PUBLER_API_KEY + PUBLER_WORKSPACE_ID in the environment
 * (config.ts loads them from HERMES_ENV_FILE; the Python bridge points that at
 * $HERMES_HOME/.env).
 *
 * EXIT CODES: 0 ok · 1 runtime/network error · 2 bad stdin JSON · 3 bad usage.
 * Diagnostics -> stderr; the machine-readable result -> one JSON line on stdout.
 */
import {
  listAccounts,
  listPosts,
  listAllPosts,
  getPostInsights,
  flattenPostInsights,
} from "../../hermes/src/publer.ts";
import { CONFIG } from "../../hermes/src/config.ts";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v) || v.length === 0) return undefined;
  return v.map((x) => String(x));
}

function asPosInt(v: unknown): number | undefined {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run") || process.env.HERMES_READ_DRY_RUN === "1";
  const sub = argv.find((a) => !a.startsWith("-"));

  if (sub !== "accounts" && sub !== "posts" && sub !== "insights") {
    console.error("publer-read: usage: publer-read.ts <accounts|posts|insights> [--dry-run]");
    process.exit(3);
    return;
  }

  // Read + parse stdin params for the subcommands that take them.
  let params: Record<string, unknown> = {};
  if (sub === "posts" || sub === "insights") {
    const raw = (await readStdin()).trim();
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          params = parsed as Record<string, unknown>;
        } else {
          console.error("publer-read: stdin must be a JSON object of params");
          process.exit(2);
          return;
        }
      } catch (e) {
        console.error(`publer-read: invalid JSON on stdin: ${(e as Error).message}`);
        process.exit(2);
        return;
      }
    }
  }

  // ── accounts ──────────────────────────────────────────────────────────
  if (sub === "accounts") {
    if (dryRun) {
      console.log(JSON.stringify({ ok: true, dry_run: true, sub, note: "read dry-run made no network call" }));
      return;
    }
    const accounts = await listAccounts(); // READ-ONLY GET /accounts
    console.log(JSON.stringify({ ok: true, count: accounts.length, accounts }));
    return;
  }

  // ── posts ─────────────────────────────────────────────────────────────
  if (sub === "posts") {
    const state = typeof params.state === "string" && params.state.trim() ? params.state.trim() : undefined;
    const page = asPosInt(params.page);
    const account_ids = asStringArray(params.account_ids);
    const query = typeof params.query === "string" && params.query.trim() ? params.query.trim() : undefined;
    const all = params.all === true;
    const maxPages = asPosInt(params.max_pages) ?? 30;

    if (dryRun) {
      console.log(
        JSON.stringify({
          ok: true,
          dry_run: true,
          sub,
          request: { state, page, account_ids, query, all, max_pages: maxPages },
          note: "read dry-run made no network call",
        }),
      );
      return;
    }

    // READ-ONLY: both branches only ever GET /posts.
    const posts = all
      ? await listAllPosts(state ?? "published", maxPages)
      : await listPosts({ state, page, account_ids, query });
    console.log(JSON.stringify({ ok: true, count: posts.length, posts }));
    return;
  }

  // ── insights ──────────────────────────────────────────────────────────
  // sub === "insights"
  const from = typeof params.from === "string" ? params.from.trim() : "";
  const to = typeof params.to === "string" ? params.to.trim() : "";
  if (!from || !to) {
    console.error("publer-read: insights requires 'from' and 'to' (YYYY-MM-DD) params on stdin");
    process.exit(3);
    return;
  }
  const accountIds = asStringArray(params.account_ids) ?? CONFIG.ACCOUNT_IDS;
  const sort_by = typeof params.sort_by === "string" && params.sort_by.trim() ? params.sort_by.trim() : "reach";
  const sort_type: "ASC" | "DESC" = params.sort_type === "ASC" ? "ASC" : "DESC";
  const maxPages = asPosInt(params.max_pages) ?? 20;

  if (dryRun) {
    console.log(
      JSON.stringify({
        ok: true,
        dry_run: true,
        sub,
        request: { from, to, account_ids: accountIds, sort_by, sort_type, max_pages: maxPages },
        note: "read dry-run made no network call",
      }),
    );
    return;
  }

  // READ-ONLY: GET /analytics/{account}/post_insights, paged, then flatten.
  const byAccount: Array<{ account_id: string; total: number; count: number }> = [];
  const allFlat: ReturnType<typeof flattenPostInsights> = [];
  for (const acc of accountIds) {
    const flat: ReturnType<typeof flattenPostInsights> = [];
    let total = 0;
    for (let page = 0; page < maxPages; page++) {
      const { posts, total: t } = await getPostInsights(acc, { from, to, sort_by, sort_type, page });
      total = t;
      flat.push(...flattenPostInsights(posts));
      if (flat.length >= t || posts.length === 0) break;
    }
    byAccount.push({ account_id: acc, total, count: flat.length });
    allFlat.push(...flat);
  }
  console.log(
    JSON.stringify({ ok: true, from, to, count: allFlat.length, by_account: byAccount, posts: allFlat }),
  );
}

main().catch((e) => {
  console.error(`publer-read: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
