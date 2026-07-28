#!/usr/bin/env node
/**
 * metricool-read.ts — the dashboard's READ-ONLY window onto Metricool.
 *
 * Replaces bridge/publer-read.ts, which has been returning HTTP 403 on every content
 * endpoint ("Please upgrade to Business") since Publer cut us off. The dashboard was
 * therefore rendering an empty board while Metricool held the entire live schedule —
 * the worst possible failure for the one window the human has into the system, because
 * "nothing is happening" and "I cannot see" look identical.
 *
 * WHY THIS IS A SUBPROCESS AND NOT AN IMPORT
 * hermes/src/metricool.ts also exports createPost, reschedule and deletePost. Importing
 * it into the dashboard would put those symbols one `import` away from a publicly
 * reachable, unauthenticated server. Spawning a bridge keeps the dashboard's module
 * graph free of every write symbol, which is exactly the property the Publer bridge
 * had and which the guardrail tests assert. This file itself calls ONLY the read
 * functions, and it never imports a mutating one.
 *
 * Protocol: argv[2] is the subcommand, params arrive as JSON on stdin, and exactly one
 * JSON line goes to stdout. Same contract as publer-read.ts, so data.ts's runReadBridge
 * needs no change beyond which script it spawns.
 *
 *   scheduled  -> { ok, posts[], as_of }   every post on the calendar in a window
 *   analytics  -> { ok, reels[], as_of }   published IG reel metrics incl. skip rate
 *
 * The token stays in this process's env and is never printed. No URL emitted here is
 * ever a presigned S3 link: Metricool rehosts media onto static.metricool.com at
 * schedule time, and data.ts re-validates every URL against a host allowlist anyway.
 */
import { instagramReels, listPosts } from "../../hermes/src/metricool.ts";

/**
 * `/v2/scheduler/posts` wants NAIVE local datetimes: `yyyy-MM-dd'T'HH:mm:ss`, with the
 * zone supplied separately. It rejects an ISO offset like `...000-05:00` and a bare
 * date with HTTP 400 and a format complaint, so this pads/trims rather than trusting
 * whatever the caller passed.
 */
function naive(v: unknown, fallback: string): string {
  const s = String(v ?? "").trim();
  const m = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}(:\d{2})?))?/.exec(s);
  if (!m) return fallback;
  const time = m[2] ? (m[3] ? m[2] : `${m[2]}:00`) : "00:00:00";
  return `${m[1]}T${time}`;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  const sub = String(process.argv[2] || "").trim();
  let params: Record<string, unknown> = {};
  try {
    const raw = (await readStdin()).trim();
    if (raw) params = JSON.parse(raw);
  } catch {
    /* no params is fine */
  }
  const as_of = new Date().toISOString();

  try {
    if (sub === "scheduled") {
      const start = naive(params.start, "2026-01-01T00:00:00");
      const end = naive(params.end, "2030-12-31T23:59:59");
      const rows = await listPosts(start, end);
      // Pass through only the fields the dashboard renders. Deliberately narrow: it
      // keeps creator emails and other account metadata out of a public response.
      const posts = rows.map((p) => ({
        uuid: String(p.uuid ?? ""),
        id: p.id,
        text: String(p.text ?? ""),
        dateTime: p.publicationDate?.dateTime ?? "",
        timezone: p.publicationDate?.timezone ?? "",
        draft: !!p.draft,
        // draft && !autoPublish is the loop's approval gate; the dashboard needs both.
        auto_publish: p.autoPublish !== false,
        media: Array.isArray(p.media) ? p.media.map(String) : [],
        thumbnail: typeof p.videoThumbnailUrl === "string" ? p.videoThumbnailUrl : null,
        providers: (p.providers ?? []).map((x) => ({
          network: String(x.network ?? ""),
          status: String(x.status ?? ""),
          publicUrl: typeof x.publicUrl === "string" ? x.publicUrl : null,
        })),
      }));
      process.stdout.write(JSON.stringify({ ok: true, posts, as_of }) + "\n");
      return;
    }

    if (sub === "analytics") {
      const from = naive(params.from, "2026-07-01T00:00:00");
      const to = naive(params.to, "2030-12-31T23:59:59");
      const rows = await instagramReels(from, to);
      const reels = rows.map((r) => ({
        platformPostId: r.platformPostId,
        url: r.url ?? null,
        publishedAt: r.publishedAt ?? null,
        reach: r.reach,
        views: r.views,
        skipRate: r.skipRate,
        averageWatchTime: r.averageWatchTime,
      }));
      process.stdout.write(JSON.stringify({ ok: true, reels, as_of }) + "\n");
      return;
    }

    process.stdout.write(JSON.stringify({ ok: false, error: `unknown subcommand "${sub}"`, as_of }) + "\n");
  } catch (e) {
    // Never let a token or a full URL escape in an error string.
    const msg = (e instanceof Error ? e.message : String(e)).replace(/[?&](userId|blogId)=[^&\s]*/g, "$1=…").slice(0, 200);
    process.stdout.write(JSON.stringify({ ok: false, error: msg, as_of }) + "\n");
  }
}

await main();
