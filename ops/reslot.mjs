/**
 * reslot.mjs — slide unapproved posts forward instead of losing them.
 *
 * A post held for approval that reaches its slot undecided must not simply expire, and it
 * must not all come out at once later either: a backlog collapsing into a burst is the
 * pattern that preceded TikTok's suppression. So each overdue draft is re-placed on the
 * normal grid — first day with room, 12/day, 56-minute same-platform floor, inside the
 * posting window, with the usual jitter — one at a time, re-reading the calendar between
 * each so the second one accounts for where the first just landed.
 *
 * It moves the date and nothing else. Metricool's PATCH takes exactly `publicationDate`
 * and rejects every other field, which happens to be precisely this operation, so none of
 * the destructive-PUT exposure applies.
 */
const REPO = "/home/ec2-user/sffs-ai-video-pipeline";
const { rescheduleOverdue, listPending } = await import(`${REPO}/hermes/src/approval.ts`);

const pending = await listPending();
const overdue = pending.filter((p) => p.overdue);
console.log(`${new Date().toISOString()}  pending=${pending.length} overdue=${overdue.length}`);

if (!overdue.length) {
  console.log("nothing to move");
} else {
  const moved = await rescheduleOverdue();
  for (const m of moved) console.log(`  ${m.uuid}: ${m.from} -> ${m.to}`);
  console.log(`moved ${moved.length}/${overdue.length}`);
}
