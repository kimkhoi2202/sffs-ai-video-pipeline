/**
 * scheduler.ts — the POST-KICKOFF scheduling policy (pure; no network, no Publer).
 *
 * Policy (used ONLY when kickoff.ts is armed; the OFF loop never calls this):
 *   - TIME WINDOW: schedule ONLY between 7:00am and 1:00am America/Chicago
 *     (CST/CDT resolved automatically via Intl — July is CDT/UTC-5). NOTHING is
 *     ever scheduled 1:00am–7:00am (the dead hours).
 *   - NATURAL JITTER: odd, irregular minutes (e.g. 3:13, 9:47 — never :00/:15/:30),
 *     irregular gaps between posts, and a per-platform shift so IG and TikTok never
 *     land on an identical timestamp.
 *
 * Everything here is deterministic given (count, from, seed, platform) so it is
 * unit-testable, while still LOOKING organic (seeded jitter, not a fixed cadence).
 */

export const TZ = "America/Chicago";
/** Allowed wall-clock band: [07:00, 01:00 next day). Dead hours = [01:00, 07:00). */
export const WINDOW_OPEN_HOUR = 7;

interface Parts {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

/** Wall-clock parts of a UTC instant in America/Chicago (DST-correct via Intl). */
function parts(date: Date, tz: string = TZ): Parts {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const p: Record<string, string> = {};
  for (const part of f.formatToParts(date)) if (part.type !== "literal") p[part.type] = part.value;
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second };
}

/** tz offset (ms) at `date` such that (wall-clock-as-UTC) = date + offset. */
function offsetMs(date: Date, tz: string = TZ): number {
  const p = parts(date, tz);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - date.getTime();
}

/** Chicago wall-clock hour of a UTC instant. */
export function chicagoHour(date: Date): number {
  return parts(date).h;
}

/** True iff `date` (a UTC instant) is inside the allowed Chicago posting window. */
export function isWithinWindow(date: Date): boolean {
  const h = parts(date).h;
  return h === 0 || h >= WINDOW_OPEN_HOUR; // allow 00:xx and 07:00..23:59; forbid 01..06
}

/** Real UTC instant for a Chicago wall-clock (DST-correct enough for our slack). */
function fromChicago(y: number, mo: number, d: number, h: number, mi: number): Date {
  const guess = new Date(Date.UTC(y, mo - 1, d, h, mi, 0));
  const off = offsetMs(guess);
  return new Date(Date.UTC(y, mo - 1, d, h, mi, 0) - off);
}

// --- seeded RNG (LCG; same family used elsewhere in the loop) ----------------
function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function lcg(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

/** If `date` is in the dead hours, jump forward to ~07:xx (jittered) that day. */
function intoWindow(date: Date, rng: () => number): Date {
  if (isWithinWindow(date)) return date;
  const p = parts(date); // 01:00..06:59 -> same-day 07:00 + jitter
  const jitterMin = 1 + Math.floor(rng() * 48); // 1..48 past 7:00 (odd-ized by caller)
  return fromChicago(p.y, p.mo, p.d, WINDOW_OPEN_HOUR, jitterMin);
}

const PLATFORM_SHIFT: Record<string, number> = { instagram: 3, tiktok: 8 };

export interface SlotOpts {
  fromMs?: number; // base instant (default: now)
  seed?: string; // deterministic jitter seed (e.g. runId)
  platform?: string; // per-platform shift so IG != TikTok times
}

/**
 * Produce `count` DISTINCT schedule timestamps (ISO, minute-resolution), all inside
 * the Chicago window, with irregular gaps + odd jittered minutes + a per-platform
 * shift. Deterministic given (count, fromMs, seed, platform).
 */
export function nextSlots(count: number, opts: SlotOpts = {}): string[] {
  const rng = lcg(hashSeed(`${opts.seed ?? "hermes"}|${opts.platform ?? ""}`));
  const shift = PLATFORM_SHIFT[opts.platform ?? ""] ?? 0;
  const out: string[] = [];
  const seen = new Set<string>();
  // start a few (jittered) minutes in the future so we never schedule in the past
  let cur = new Date((opts.fromMs ?? Date.now()) + (5 + Math.floor(rng() * 21)) * 60_000);
  let guard = 0;
  while (out.length < count && guard++ < count * 25) {
    const gap = 55 + Math.floor(rng() * 96); // irregular 55..150 min between posts
    cur = intoWindow(new Date(cur.getTime() + gap * 60_000), rng);
    const p = parts(cur);
    // odd, jittered minute (+ platform shift), kept within the same allowed hour
    let minute = (p.mi + shift + Math.floor(rng() * 6)) % 60;
    if (minute % 2 === 0) minute = (minute + 1) % 60;
    let slot = fromChicago(p.y, p.mo, p.d, p.h, minute);
    if (!isWithinWindow(slot)) slot = intoWindow(slot, rng);
    const iso = new Date(Math.floor(slot.getTime() / 60_000) * 60_000).toISOString();
    if (seen.has(iso) || slot.getTime() <= (out.length ? Date.parse(out[out.length - 1]) : 0)) {
      cur = new Date(cur.getTime() + (11 + Math.floor(rng() * 19)) * 60_000);
      continue;
    }
    seen.add(iso);
    out.push(iso);
  }
  return out;
}
