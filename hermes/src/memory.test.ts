/**
 * memory.test.ts — P3 MEMORY.md hygiene: formatTakeaway (one-line), mergeTakeaway
 * (bounded, single auto-managed block, prose head preserved), and appendTakeaway
 * (best-effort file write to a tmp MEMORY_FILE).
 *
 * Hermetic: point MEMORY_FILE at a tmp path + env at a nonexistent file BEFORE
 * importing (memory.ts pulls in config.ts).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "hermes-mem-"));
const MEM = join(TMP, "memories", "MEMORY.md");
process.env.HERMES_ENV_FILE = join(TMP, "nonexistent.env");
process.env.HERMES_MEMORY_FILE = MEM;
process.env.HERMES_REPO_DIR = TMP;
process.env.HERMES_DATA_DIR = TMP;

const { formatTakeaway, mergeTakeaway, appendTakeaway, TAKEAWAY_HEADING } = await import("./memory.ts");

test("formatTakeaway: one line with the key fields", () => {
  const line = formatTakeaway({
    run_id: "2026-07-22",
    drafted: 6,
    rejected: 4,
    failed: 0,
    frontFamily: "narration",
    frontTimeBucket: "evening (18-24)",
    freshQuestions: 812,
    reconciled: 3,
    date: "2026-07-22",
  });
  assert.ok(!line.includes("\n"));
  assert.match(line, /2026-07-22 run 2026-07-22: 6 drafted, 4 rejected, 0 failed/);
  assert.match(line, /front-runner: narration/);
  assert.match(line, /best time: evening \(18-24\)/);
  assert.match(line, /812 fresh Qs left/);
  assert.match(line, /reconciled 3/);
});

test("formatTakeaway: omits optional fields cleanly", () => {
  const line = formatTakeaway({ run_id: "r", drafted: 0, rejected: 0, failed: 0, date: "2026-07-22" });
  assert.match(line, /front-runner: n\/a/);
  assert.doesNotMatch(line, /best time:/);
  assert.doesNotMatch(line, /fresh Qs/);
});

test("mergeTakeaway: empty existing -> just the block", () => {
  const out = mergeTakeaway("", "line one");
  assert.match(out, new RegExp(TAKEAWAY_HEADING.replace(/[()]/g, "\\$&")));
  assert.match(out, /- line one/);
});

test("mergeTakeaway: preserves the prose head + one block, newest last", () => {
  const head = "I am the agent.\n§\nDRAFT-ONLY forever.";
  let doc = mergeTakeaway(head, "first");
  doc = mergeTakeaway(doc, "second");
  // prose head intact
  assert.match(doc, /I am the agent\./);
  assert.match(doc, /DRAFT-ONLY forever\./);
  // exactly ONE takeaways heading (not duplicated on re-merge)
  assert.equal(doc.split("## Recent cycle takeaways").length - 1, 1);
  // newest last
  const firstIdx = doc.indexOf("- first");
  const secondIdx = doc.indexOf("- second");
  assert.ok(firstIdx > 0 && secondIdx > firstIdx);
});

test("mergeTakeaway: bounded to keep last N", () => {
  let doc = "";
  for (let i = 1; i <= 10; i++) doc = mergeTakeaway(doc, `line ${i}`, 3);
  const kept = doc.split("\n").filter((l) => l.trim().startsWith("- "));
  assert.equal(kept.length, 3);
  assert.deepEqual(kept.map((l) => l.trim()), ["- line 8", "- line 9", "- line 10"]);
});

test("appendTakeaway: writes MEMORY_FILE (creating dirs) + stays bounded", () => {
  const r1 = appendTakeaway("cycle A", 2);
  assert.equal(r1.ok, true);
  assert.ok(existsSync(MEM));
  appendTakeaway("cycle B", 2);
  const r3 = appendTakeaway("cycle C", 2);
  assert.equal(r3.ok, true);
  const content = readFileSync(MEM, "utf8");
  const kept = content.split("\n").filter((l) => l.trim().startsWith("- "));
  assert.equal(kept.length, 2); // bounded to keep=2
  assert.deepEqual(kept.map((l) => l.trim()), ["- cycle B", "- cycle C"]);
  // single managed block
  assert.equal(content.split("## Recent cycle takeaways").length - 1, 1);
});
