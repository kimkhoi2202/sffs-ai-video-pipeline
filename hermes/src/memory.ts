/**
 * memory.ts — per-cycle MEMORY.md hygiene (P3).
 *
 * MEMORY.md (the framework's agent memory, $HERMES_HOME/memories/MEMORF.md) says
 * "I also jot a one-line takeaway per cycle" — this implements that, BOUNDED so
 * memory stays tidy: takeaways live in a single trailing, auto-managed block that
 * keeps only the last N lines. The narrative prose above the block is never
 * touched.
 *
 * The pure helpers (formatTakeaway / mergeTakeaway) are unit-tested; appendTakeaway
 * is the thin best-effort file writer (never throws — a memory note must never
 * break a cycle).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { CONFIG } from "./config.ts";

/** The heading that delimits the auto-managed, bounded takeaways block. */
export const TAKEAWAY_HEADING = "## Recent cycle takeaways (auto, newest last)";

export interface TakeawayInput {
  run_id: string;
  drafted: number;
  rejected: number;
  failed: number;
  /** The format production is PINNED to (a fact about what shipped). */
  format?: string | null;
  /** Live view total across every network, from the analytics snapshot. */
  liveViews?: number | null;
  freshQuestions?: number | null;
  quarantined?: number | null; // questions the validity gate has retired
  reconciled?: number | null; // records back-filled this cycle
  date?: string; // YYYY-MM-DD (defaults to today, UTC)
}

/**
 * Build the ONE-LINE takeaway for a cycle. Pure.
 *
 * `front-runner` is GONE from this line. MEMORY.md is what the agent reads back as its
 * own recollection, and it was being handed a nightly champion picked on median
 * engagement rate — a metric the content policy had already written off as unreliable
 * for this account. An inference restated often enough becomes a belief, so the line
 * now carries only things that are true by construction: what shipped, what the live
 * analytics say, and how much bank is left.
 */
export function formatTakeaway(t: TakeawayInput): string {
  const date = t.date || new Date().toISOString().slice(0, 10);
  const parts = [
    `${date} run ${t.run_id}: ${t.drafted} drafted, ${t.rejected} rejected, ${t.failed} failed`,
  ];
  parts.push(`format: ${t.format || "n/a"}`);
  if (t.liveViews != null) parts.push(`${t.liveViews.toLocaleString("en-US")} live views to date`);
  if (t.freshQuestions != null) parts.push(`${t.freshQuestions} fresh Qs left`);
  if (t.quarantined != null && t.quarantined > 0) parts.push(`${t.quarantined} quarantined`);
  if (t.reconciled != null) parts.push(`reconciled ${t.reconciled}`);
  // one line: collapse any stray newlines defensively.
  return parts.join(" · ").replace(/\s*\n\s*/g, " ").trim();
}

/**
 * Merge a new takeaway line into MEMORY.md, keeping the prose head intact and the
 * auto-managed takeaways block bounded to the last `keep` lines. Pure + idempotent
 * in structure (always exactly one block, newest last). Returns the full new file.
 */
export function mergeTakeaway(existing: string, line: string, keep = 30): string {
  const text = existing ?? "";
  const idx = text.indexOf("## Recent cycle takeaways");
  const head = (idx >= 0 ? text.slice(0, idx) : text).replace(/\s+$/, "");
  const prior =
    idx >= 0
      ? text
          .slice(idx)
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l.startsWith("- "))
      : [];
  const next = [...prior, `- ${line}`].slice(-Math.max(1, keep));
  const block = `${TAKEAWAY_HEADING}\n${next.join("\n")}`;
  return head ? `${head}\n\n§\n\n${block}\n` : `${block}\n`;
}

/** Append a one-line takeaway to MEMORY.md (bounded). Best-effort; never throws. */
export function appendTakeaway(line: string, keep = 30): { ok: boolean; path: string; note?: string } {
  const path = CONFIG.MEMORY_FILE;
  try {
    const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
    const merged = mergeTakeaway(existing, line, keep);
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, merged);
    renameSync(tmp, path);
    return { ok: true, path };
  } catch (e) {
    return { ok: false, path, note: e instanceof Error ? e.message : String(e) };
  }
}
