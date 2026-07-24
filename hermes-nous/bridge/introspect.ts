#!/usr/bin/env node
/**
 * introspect.ts (bridge) — a DEPENDENCY-FREE probe the hermetic Python test suite
 * shells into to assert the REAL TypeScript behavior of the content-defaults work
 * WITHOUT needing node_modules (openai etc.). It imports ONLY the dep-free modules:
 *
 *   - hermes/src/dimensions.ts  -> dimensionCatalog()  (defaults applied)
 *   - hermes/src/rollup.ts      -> computeRollups(posts)
 *   - hermes/src/defaults.ts    -> contentDefaults() / FALLBACK_DEFAULTS
 *
 * None of those pull in Publer/LLM, so this runs on a box with no deps installed
 * (which is exactly the hermes-nous build). It is READ-ONLY: it computes + prints
 * JSON, and has NO create/schedule/publish/mutate path anywhere in its imports.
 *
 * USAGE:
 *   node introspect.ts catalog          # dimensionCatalog() under the current defaults
 *   node introspect.ts catalog          # (stdin optional: {"narration":..,"ending":..}
 *                                        #  to preview the catalog under a HYPOTHETICAL
 *                                        #  flipped default, e.g. after a promotion)
 *   node introspect.ts rollups          # stdin = posts[] JSON -> computeRollups(posts)
 *   node introspect.ts defaults         # the resolved current content defaults
 *
 * EXIT CODES: 0 ok · 1 runtime error · 2 bad stdin JSON · 3 bad usage.
 */
import { dimensionCatalog } from "../../hermes/src/dimensions.ts";
import { computeRollups } from "../../hermes/src/rollup.ts";
import { contentDefaults, FALLBACK_DEFAULTS, type ContentDefaults } from "../../hermes/src/defaults.ts";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function coerceDefaults(raw: unknown): ContentDefaults | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.narration !== "string" && typeof o.ending !== "string" && typeof o.mascot !== "string") return null;
  return {
    narration: (typeof o.narration === "string" ? o.narration : FALLBACK_DEFAULTS.narration) as ContentDefaults["narration"],
    ending: (typeof o.ending === "string" ? o.ending : FALLBACK_DEFAULTS.ending) as ContentDefaults["ending"],
    mascot: (typeof o.mascot === "string" ? o.mascot : FALLBACK_DEFAULTS.mascot) as ContentDefaults["mascot"],
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const sub = argv.find((a) => !a.startsWith("-"));

  if (sub === "defaults") {
    console.log(JSON.stringify({ ok: true, sub, defaults: contentDefaults() }));
    return;
  }

  if (sub === "catalog") {
    const raw = (await readStdin()).trim();
    let defaults: ContentDefaults | undefined;
    if (raw) {
      try {
        const parsed = coerceDefaults(JSON.parse(raw));
        if (parsed) defaults = parsed;
      } catch {
        console.error("introspect: invalid JSON on stdin for catalog defaults override");
        process.exit(2);
        return;
      }
    }
    const dimensions = defaults ? dimensionCatalog(defaults) : dimensionCatalog();
    console.log(JSON.stringify({ ok: true, sub, count: dimensions.length, defaults: defaults ?? contentDefaults(), dimensions }));
    return;
  }

  if (sub === "rollups") {
    const raw = (await readStdin()).trim();
    let posts: unknown = [];
    if (raw) {
      try {
        posts = JSON.parse(raw);
      } catch (e) {
        console.error(`introspect: invalid JSON on stdin: ${(e as Error).message}`);
        process.exit(2);
        return;
      }
    }
    const rollups = computeRollups(Array.isArray(posts) ? posts : (posts as any)?.posts ?? []);
    console.log(JSON.stringify({ ok: true, sub, rollups }));
    return;
  }

  console.error("introspect: usage: introspect.ts <catalog|rollups|defaults>");
  process.exit(3);
}

main().catch((e) => {
  console.error(`introspect: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
