/**
 * board.test.ts — the calendar board is ordered so that today is at the top.
 *
 * The board was one ascending list, so the first ~70 cards were already-published
 * history and the next post to go out was far below the fold. It read as a stale page.
 * These pin the ordering contract rather than the markup.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { partitionBoard, BOARD_RECENT_HOURS } from "./render.ts";
import type { ScheduledPost } from "./data.ts";

const NOW = Date.parse("2026-08-01T16:00:00Z");
const H = 3600_000;
const p = (id: string, hoursFromNow: number, status: string): ScheduledPost =>
  ({ post_id: id, scheduled_at: new Date(NOW + hoursFromNow * H).toISOString(), status }) as ScheduledPost;

const ids = (xs: ScheduledPost[]) => xs.map((x) => x.post_id);

test("upcoming comes first and runs soonest-first", () => {
  const { upcoming } = partitionBoard([p("later", 30, "PENDING"), p("soon", 2, "PENDING"), p("mid", 9, "PENDING")], NOW);
  assert.deepEqual(ids(upcoming), ["soon", "mid", "later"]);
});

test("published runs newest-first, the opposite of upcoming", () => {
  const { recent } = partitionBoard([p("oldest", -40, "PUBLISHED"), p("newest", -2, "PUBLISHED"), p("mid", -20, "PUBLISHED")], NOW);
  assert.deepEqual(ids(recent), ["newest", "mid", "oldest"]);
});

test(`published inside ${BOARD_RECENT_HOURS}h stays expanded; older collapses`, () => {
  const { recent, older } = partitionBoard([
    p("just-now", -1, "PUBLISHED"),
    p("yesterday", -25, "PUBLISHED"),
    p("edge-inside", -(BOARD_RECENT_HOURS - 0.5), "PUBLISHED"),
    p("edge-outside", -(BOARD_RECENT_HOURS + 0.5), "PUBLISHED"),
    p("ancient", -120, "PUBLISHED"),
  ], NOW);
  assert.deepEqual(ids(recent), ["just-now", "yesterday", "edge-inside"]);
  assert.deepEqual(ids(older), ["edge-outside", "ancient"]);
});

test("nothing is dropped: every post lands in exactly one section", () => {
  const posts = [p("a", 5, "PENDING"), p("b", -1, "PUBLISHED"), p("c", -200, "PUBLISHED"), p("d", -3, "PENDING")];
  const { upcoming, recent, older } = partitionBoard(posts, NOW);
  assert.equal(upcoming.length + recent.length + older.length, posts.length);
  assert.deepEqual([...ids(upcoming), ...ids(recent), ...ids(older)].sort(), ["a", "b", "c", "d"]);
});

test("STATUS decides, not the clock: an overdue unpublished post stays UPCOMING", () => {
  // A post whose time has passed but which Metricool has not published is precisely the
  // one a human needs to see, so it must never be filed into collapsed history.
  const { upcoming, recent, older } = partitionBoard([p("overdue", -6, "PENDING")], NOW);
  assert.deepEqual(ids(upcoming), ["overdue"]);
  assert.equal(recent.length + older.length, 0);
});

test("a board with no history at all yields no collapsed section", () => {
  const { upcoming, recent, older } = partitionBoard([p("a", 1, "PENDING")], NOW);
  assert.equal(upcoming.length, 1);
  assert.equal(recent.length, 0);
  assert.equal(older.length, 0);
});

test("an unparseable scheduled_at sorts to the far past rather than throwing", () => {
  const bad = ({ post_id: "bad", scheduled_at: "not-a-date", status: "PUBLISHED" }) as ScheduledPost;
  const { older } = partitionBoard([bad, p("ok", -1, "PUBLISHED")], NOW);
  assert.deepEqual(ids(older), ["bad"]);
});
