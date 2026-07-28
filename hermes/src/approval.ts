/**
 * approval.ts — the ONLY two mutations a human can trigger from the dashboard, plus
 * the auto-reschedule that keeps an unapproved post from being silently lost.
 *
 * WHY THE GATE LIVES IN METRICOOL'S OWN DRAFT FLAG
 * Loop-generated posts are created with `draft: true, autoPublish: false`. That is not
 * bookkeeping on our side — the platform will not publish a draft, so an unapproved
 * video cannot go out even if this box, this process and the dashboard all fail at
 * once. Approving is the act of clearing exactly those two fields.
 *
 * BLAST RADIUS, deliberately tiny
 * The dashboard is publicly reachable over HTTP behind a guessable word. So the only
 * things reachable through it are approve and reject, addressed by a post uuid that
 * must ALREADY be an unapproved loop draft. There is no caption edit, no time edit, no
 * delete of a live post, no config change, and no way to post arbitrary content:
 *   - approve() refuses anything that is not currently a draft, so it can never
 *     "re-approve" (i.e. resurrect) something a human rejected or something already live;
 *   - reject() is a SOFT delete, which Metricool keeps restorable, and it likewise
 *     refuses anything that is not an unapproved draft;
 *   - neither accepts any field from the caller beyond the uuid.
 * The worst a stranger who guesses the password can do is approve or reject videos the
 * user was going to decide on anyway.
 */
import { CONFIG } from "./config.ts";
import { info, warn } from "./log.ts";
import { buildUpdateBody, getPost, listPosts, putPost, resolveId, retireStaleId, deletePost, type McPost } from "./metricool.ts";
import { slotTimes, NETWORKS } from "./postingPolicy.ts";

export interface PendingPost {
  uuid: string;
  id: number;
  at: string;
  network: string;
  text: string;
  overdue: boolean;
}

/** Is this post an unapproved loop draft — the only thing either action may touch? */
export function isUnapproved(p: McPost): boolean {
  return p.draft === true && p.autoPublish === false;
}

/** Naive local datetime -> ms, in the brand timezone. */
function localToMs(naive: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/.exec(String(naive).trim());
  if (!m) return NaN;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
  let guess = Date.UTC(y, mo - 1, d, h, mi, s);
  for (let i = 0; i < 2; i++) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: CONFIG.METRICOOL_TZ, hour12: false, year: "numeric", month: "2-digit",
      day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(new Date(guess));
    const g: Record<string, number> = {};
    for (const q of parts) if (q.type !== "literal") g[q.type] = Number(q.value);
    guess += Date.UTC(y, mo - 1, d, h, mi, s) - Date.UTC(g.year, g.month - 1, g.day, g.hour === 24 ? 0 : g.hour, g.minute, g.second);
  }
  return guess;
}

/** Every post still awaiting a human decision. */
export async function listPending(rows?: McPost[]): Promise<PendingPost[]> {
  const all = rows ?? (await listPosts("2026-01-01T00:00:00", "2030-12-31T23:59:59"));
  const now = Date.now();
  return all.filter(isUnapproved).map((p) => ({
    uuid: String(p.uuid),
    id: Number(p.id),
    at: String(p.publicationDate?.dateTime ?? ""),
    network: (p.providers ?? [])[0]?.network ?? "instagram",
    text: String(p.text ?? "").split("\n")[0].slice(0, 90),
    overdue: localToMs(String(p.publicationDate?.dateTime ?? "")) < now,
  }));
}

/**
 * APPROVE: clear draft + autoPublish so the post goes out at its existing slot.
 * Nothing else is touched — the time, caption, media and cover come through the
 * whitelist body unchanged.
 */
export async function approve(uuid: string): Promise<{ ok: boolean; reason: string; id?: number }> {
  const id = await resolveId(String(uuid));
  if (id === null) return { ok: false, reason: "no such scheduled post" };
  const current = await getPost(id);
  if (!isUnapproved(current)) return { ok: false, reason: "not an unapproved draft — nothing to approve" };
  const updated = await putPost(id, buildUpdateBody(current, { draft: false, autoPublish: true }));
  const newId = Number(updated?.id);
  if (Number.isFinite(newId) && newId !== id) await retireStaleId(id);
  info("APPROVED by human", { uuid, id: newId || id, at: current.publicationDate?.dateTime });
  return { ok: true, reason: "approved — will publish at its scheduled time", id: newId || id };
}

/**
 * REJECT: soft-delete the draft. Metricool keeps it in the recycle bin, so a mistaken
 * rejection is recoverable; this is why reject is a delete rather than a flag.
 */
export async function reject(uuid: string): Promise<{ ok: boolean; reason: string }> {
  const id = await resolveId(String(uuid));
  if (id === null) return { ok: false, reason: "no such scheduled post" };
  const current = await getPost(id);
  if (!isUnapproved(current)) return { ok: false, reason: "not an unapproved draft — refusing to touch a live post" };
  const r = await deletePost(String(uuid));
  info("REJECTED by human (soft delete; restorable)", { uuid, id: r.id });
  return { ok: r.deleted, reason: r.deleted ? "rejected — soft-deleted and restorable" : "delete did not take" };
}

/**
 * AUTO-RESCHEDULE: slide an unapproved post whose slot has passed forward to the next
 * free one, rather than letting it expire unnoticed.
 *
 * PATCH accepts exactly `publicationDate` and rejects everything else, which is
 * precisely this operation — so no delete-and-recreate, and none of the destructive-PUT
 * exposure that carries.
 *
 * Crucially it does NOT bunch. Each post is placed on the first day with room, spread
 * on the normal grid and kept behind the same-platform floor, because a backlog of
 * approvals collapsing into a burst is the pattern that preceded TikTok's suppression.
 */
export async function rescheduleOverdue(now: Date = new Date()): Promise<Array<{ uuid: string; from: string; to: string }>> {
  const { reschedule } = await import("./metricool.ts");
  const { planSlots, calendarRows } = await import("./loopPublish.ts");
  const rows = await calendarRows();
  const pending = (await listPending(rows)).filter((p) => p.overdue);
  const moved: Array<{ uuid: string; from: string; to: string }> = [];
  if (!pending.length) return moved;

  warn(`auto-reschedule: ${pending.length} unapproved post(s) passed their slot`, {});
  // Re-plan one at a time and re-read the calendar between each, so the slot chosen for
  // the second post accounts for where the first one just landed.
  let live = rows;
  for (const p of pending) {
    // Re-place on the post's OWN network. This was a two-way ternary that mapped
    // everything except TikTok to Instagram, which is the same silent-default shape as
    // the jitter-lane bug: once YouTube went live, an overdue YouTube draft would have
    // been re-slotted against INSTAGRAM's cap, Instagram's lane and Instagram's existing
    // times — landing it on the wrong grid while every log line still said "moved".
    // An unrecognised network is left alone rather than guessed at.
    const net = NETWORKS.find((n) => n === p.network);
    if (!net) { warn("auto-reschedule: unknown network — leaving it alone", { uuid: p.uuid, network: p.network }); continue; }
    const plan = planSlots(1, net, live, `reslot|${p.uuid}`, now);
    if (!plan.times.length) { warn("auto-reschedule: no room in the horizon", { uuid: p.uuid }); continue; }
    const to = plan.times[0];
    try {
      await reschedule(p.uuid, { dateTime: toNaive(to), timezone: CONFIG.METRICOOL_TZ });
      moved.push({ uuid: p.uuid, from: p.at, to: toNaive(to) });
      info("auto-rescheduled an unapproved post", { uuid: p.uuid, from: p.at, to: toNaive(to) });
      live = await calendarRows();
    } catch (e) {
      warn("auto-reschedule failed", { uuid: p.uuid, err: e instanceof Error ? e.message.slice(0, 120) : String(e) });
    }
  }
  return moved;
}

/** nextSlots returns ISO instants; Metricool wants naive local + a separate zone. */
export function toNaive(iso: string): string {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: CONFIG.METRICOOL_TZ, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const g: Record<string, string> = {};
  for (const part of f.formatToParts(new Date(iso))) if (part.type !== "literal") g[part.type] = part.value;
  const hh = g.hour === "24" ? "00" : g.hour;
  return `${g.year}-${g.month}-${g.day}T${hh}:${g.minute}:${g.second}`;
}
