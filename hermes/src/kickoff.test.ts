/**
 * kickoff.test.ts — proves the KICKOFF switch SHIPS OFF and can only be armed by a
 * deliberate human act (env token or a file CONTAINING the ack token; a bare touch
 * does nothing). Fail-closed. Hermetic: points HERMES_DATA_DIR at a tmp dir.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "hermes-kickoff-"));
process.env.HERMES_DATA_DIR = TMP;
delete process.env.SFFS_KICKOFF_ARMED;

const { isArmed, kickoffStatus, assertKickoffArmed, kickoffFilePath, KICKOFF_TOKEN, KICKOFF_ENV } = await import("./kickoff.ts");

test("SHIPS OFF: no env, no file => draft-only (not armed)", () => {
  const env = { HERMES_DATA_DIR: TMP } as any;
  assert.equal(isArmed(env), false);
  const s = kickoffStatus(env);
  assert.equal(s.armed, false);
  assert.equal(s.source, null);
  assert.throws(() => assertKickoffArmed(env), /KICKOFF NOT ARMED/);
});

test("a bare touch (empty file) does NOT arm — token required", () => {
  const dir = mkdtempSync(join(tmpdir(), "hermes-kickoff-empty-"));
  writeFileSync(join(dir, "KICKOFF_ARMED"), ""); // empty == accidental
  const env = { HERMES_DATA_DIR: dir } as any;
  assert.equal(isArmed(env), false);
  assert.match(kickoffStatus(env).note, /token missing/);
});

test("file CONTAINING the ack token arms it (source=file, since=mtime)", () => {
  const dir = mkdtempSync(join(tmpdir(), "hermes-kickoff-file-"));
  writeFileSync(join(dir, "KICKOFF_ARMED"), `# authorized by a human\n${KICKOFF_TOKEN}\n`);
  const env = { HERMES_DATA_DIR: dir } as any;
  assert.equal(isArmed(env), true);
  const s = kickoffStatus(env);
  assert.equal(s.armed, true);
  assert.equal(s.source, "file");
  assert.ok(s.since && !isNaN(Date.parse(s.since)), "since is an ISO timestamp (t0 for the goal clock)");
  assert.doesNotThrow(() => assertKickoffArmed(env));
});

test("env token arms it; a wrong env value does NOT", () => {
  assert.equal(isArmed({ HERMES_DATA_DIR: TMP, [KICKOFF_ENV]: KICKOFF_TOKEN } as any), true);
  assert.equal(isArmed({ HERMES_DATA_DIR: TMP, [KICKOFF_ENV]: "yes" } as any), false);
  assert.equal(isArmed({ HERMES_DATA_DIR: TMP, [KICKOFF_ENV]: "1" } as any), false);
});

test("kickoffFilePath is OUTSIDE the repo (in the data dir) — factory cannot flip it", () => {
  const p = kickoffFilePath({ HERMES_DATA_DIR: TMP } as any);
  assert.equal(p, join(TMP, "KICKOFF_ARMED"));
});
