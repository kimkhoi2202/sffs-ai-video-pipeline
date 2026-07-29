/**
 * cycle.test.ts — the cycle's git durability step.
 *
 * Two regressions from the 2026-07-25 incident are pinned here:
 *   1. `git add` is ATOMIC over its pathspecs. Passing a path that doesn't exist
 *      (remotion/hermes, absent on the rebuilt box) aborted the add, staged nothing,
 *      and the commit then failed with "nothing to commit" on STDOUT — surfacing as
 *      the useless empty note `commit failed: `. The day's A/B data was never
 *      committed on any cycle.
 *   2. Remote sync must be OPT-IN. The live branch is `hermes-nous`, hundreds of
 *      commits divergent from origin/main, so the old `pull --rebase origin main` +
 *      `push origin HEAD:main` pair left the repo detached mid-rebase and would
 *      otherwise publish every unpushed local commit to main.
 *
 * Hermetic: a throwaway git repo with NO remote, wired in before cycle.ts is loaded.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "hermes-cycle-"));
const REPO = mkdtempSync(join(tmpdir(), "hermes-repo-"));
process.env.HERMES_ENV_FILE = join(TMP, "nonexistent.env");
process.env.HERMES_DATA_DIR = TMP;
process.env.HERMES_REPO_DIR = REPO;
process.env.TFY_API_KEY = process.env.TFY_API_KEY || "test-dummy-key";
delete process.env.HERMES_GIT_PUSH;

const git = (...args: string[]): string => execFileSync("git", args, { cwd: REPO, encoding: "utf8" });

// A repo that mirrors the live box: the data files exist, remotion/hermes does NOT.
git("init", "-q", "-b", "main");
git("config", "user.email", "t@t.local");
git("config", "user.name", "T");
for (const rel of ["ab-testing/ab-database.json", "ab-testing/learnings.json", "content/ab-test-usage.json"]) {
  mkdirSync(join(REPO, rel, ".."), { recursive: true });
  writeFileSync(join(REPO, rel), JSON.stringify({ seed: true }));
}
mkdirSync(join(REPO, "hermes"), { recursive: true });
writeFileSync(join(REPO, "hermes", "marker.txt"), "v1");
git("add", "-A");
git("commit", "-qm", "seed");

const { gitCommitPush, isRateLimited, cycleCommitMessage } = await import("./cycle.ts");
const summary = { planned: 12, drafted: 9, rejected: 2, failed: 1 };
const dirty = (n: number): void =>
  writeFileSync(join(REPO, "ab-testing/ab-database.json"), JSON.stringify({ seed: true, updated: n }));

test("recognises Publer's rate-limit answers, including the 403 upsell disguise", () => {
  // Both of these ended videos during the 2026-07-25 backfill. The 403 is the same
  // "you are going too fast" signal wearing a different status code, and must get
  // the long backoff rather than the few seconds a network blip needs.
  assert.equal(isRateLimited(new Error('Publer API POST /media/from-url -> HTTP 429: {"error": "Rate limit exceeded. Retry later."}')), true);
  assert.equal(isRateLimited(new Error('Publer API POST /media/from-url -> HTTP 403: {"errors":["Please upgrade to Business to access our API."]}')), true);
  // ...but a genuine failure must NOT be mistaken for one and slow the cycle down.
  assert.equal(isRateLimited(new Error("Publer media-import 6a63 timed out after 180000ms")), false);
  assert.equal(isRateLimited(new Error("ENOTFOUND app.publer.com")), false);
});

test("reports a USEFUL reason when there is nothing to commit", () => {
  const r = gitCommitPush("2026-07-25", summary);
  assert.equal(r.committed, false);
  assert.equal(r.note, "nothing to commit", "an empty `commit failed: ` note is useless for diagnosis");
});

test("commits the day's data even though remotion/hermes does not exist", () => {
  dirty(1);
  const r = gitCommitPush("2026-07-25", summary);
  assert.equal(r.committed, true, `expected a commit, got note: ${r.note}`);
  // The subject states the posting mode the cycle actually ran in, so it is checked
  // against both legal forms rather than pinned to the draft-only era's wording.
  const subject = git("log", "--oneline", "-1");
  assert.ok(
    subject.includes(cycleCommitMessage("2026-07-25", summary, false)) ||
      subject.includes(cycleCommitMessage("2026-07-25", summary, true)),
    `subject must state the posting mode, got: ${subject}`,
  );
  assert.equal(git("status", "--porcelain").trim(), "", "working tree clean after the commit");
});

test("the commit subject states the posting mode — live by default, draft-only once the gate is restored", () => {
  // DEFAULT (approval gate retired, HERMES_APPROVAL_PAUSED unset): the loop schedules
  // live, and a subject still claiming "drafts" would put a lie in git history.
  const live = cycleCommitMessage("2026-07-25", summary, false);
  assert.equal(live, "hermes: cycle 2026-07-25 — 9 scheduled live, 2 rejected [live]");
  assert.doesNotMatch(live, /draft/, "nothing was drafted, so nothing may say drafts");

  // THE RESTORE PATH. HERMES_APPROVAL_PAUSED=false puts CONFIG.DRAFT_ONLY back to true
  // and the subject returns, word for word, to what the draft-only era wrote.
  const drafts = cycleCommitMessage("2026-07-25", summary, true);
  assert.equal(drafts, "hermes: cycle 2026-07-25 — 9 drafts, 2 rejected [draft-only]");
});

test("does NOT push unless HERMES_GIT_PUSH=1, and never leaves a rebase in progress", () => {
  dirty(2);
  const before = git("rev-parse", "HEAD").trim();
  const r = gitCommitPush("2026-07-25", summary);
  assert.equal(r.committed, true);
  assert.equal(r.pushed, false);
  assert.match(r.note, /committed locally/);
  // This repo has NO remote, so the old `pull --rebase origin main` would have
  // errored here. Prove we are still on a clean branch, never detached.
  assert.equal(git("branch", "--show-current").trim(), "main", "must never be detached by a rebase");
  assert.notEqual(git("rev-parse", "HEAD").trim(), before, "HEAD advanced by exactly the new commit");
});
