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

export interface SlotOpts {
  fromMs?: number; // base instant (default: now)
  seed?: string; // deterministic jitter seed (e.g. runId)
  platform?: string; // per-platform shift so IG != TikTok times
}

/** The next 1:00am America/Chicago strictly after `fromD` — the CLOSE of the
 *  posting window containing (or following) `fromD`. */
function nextOneAm(fromD: Date): Date {
  const p = parts(fromD);
  if (p.h === 0) return fromChicago(p.y, p.mo, p.d, 1, 0); // 00:xx -> 01:00 today
  const t = parts(new Date(fromChicago(p.y, p.mo, p.d, 12, 0).getTime() + 24 * 3600_000));
  return fromChicago(t.y, t.mo, t.d, 1, 0); // 07:00-23:59 -> 01:00 tomorrow
}

/** The 7:00am America/Chicago that OPENS the window AFTER `fromD`'s window closes. */
function next7am(fromD: Date): Date {
  const c = parts(nextOneAm(fromD)); // the close (01:00) of this window; +7h -> that day's 07:00
  return fromChicago(c.y, c.mo, c.d, 7, 0);
}

/**
 * Produce `count` DISTINCT schedule timestamps (ISO, minute-resolution), all inside
 * ONE Chicago posting window [max(now, 7:00am) .. 1:00am), EVENLY distributed with
 * per-slot jitter, ODD minutes, and a per-platform shift so IG != TikTok.
 *
 * Even distribution (vs a random walk of gaps) GUARANTEES every post fits the SAME
 * window — no dead-hours roll-over / cross-day accumulation — even for an aggressive
 * count, while the jittered offset within each per-post segment keeps gaps irregular
 * and organic-looking (anti-shadowban: consistent + varied, never rapid-fire). If
 * the CURRENT remaining window is too tight to hold `count` posts at a sane minimum
 * spacing (e.g. a late/backfilled fire), it rolls to the NEXT full window rather
 * than cramming a bursty batch. Deterministic given (count, fromMs, seed, platform).
 */
export function nextSlots(count: number, opts: SlotOpts = {}): string[] {
  if (count <= 0) return [];
  const seed = opts.seed ?? "hermes";
  // baseRng is PLATFORM-INDEPENDENT so both platforms share the SAME window + segment
  // grid (the per-platform jitter lanes below can only separate aligned grids).
  const baseRng = lcg(hashSeed(`${seed}|base`));
  const rng = lcg(hashSeed(`${seed}|${opts.platform ?? ""}`)); // per-platform lane jitter
  // a few jittered minutes into the future, then into the window (dead hours -> 7am)
  let start = intoWindow(new Date((opts.fromMs ?? Date.now()) + (5 + Math.floor(baseRng() * 21)) * 60_000), baseRng);
  // Don't cram: if the remaining window can't hold `count` posts >= ~18 min apart,
  // roll to the NEXT full window instead of stacking them minutes apart.
  const MIN_SEG_MIN = 18;
  if ((nextOneAm(start).getTime() - start.getTime()) / 60_000 < count * MIN_SEG_MIN) {
    start = next7am(start);
  }
  const startMin = Math.ceil(start.getTime() / 60_000); // epoch minutes (>= start)
  const endMin = Math.floor(nextOneAm(start).getTime() / 60_000) - 5; // 5-min buffer; ODD (01:00 - 5)
  const seg = Math.max(1, (endMin - startMin) / count); // per-post segment (minutes)
  // Per-platform jitter LANE within each segment so IG (low band) and TikTok (high
  // band) can never round to the same minute — a stronger IG!=TikTok guarantee than
  // a fixed shift. Epoch-minute arithmetic keeps every slot on an ODD wall-clock
  // minute (60 is even, so odd epoch-min == odd mm), strictly increasing + distinct.
  // Bands are separated by a ~0.16*seg gutter so that, even after rounding to the
  // nearest ODD minute, an IG slot and a TikTok slot in the same (or adjacent)
  // segment can never collapse onto the same minute.
  const laneLo = opts.platform === "tiktok" ? 0.58 : 0.1;
  const out: string[] = [];
  let prev = startMin - 2;
  for (let i = 0; i < count; i++) {
    let m = Math.round(startMin + i * seg + (laneLo + rng() * 0.32) * seg);
    if (m % 2 === 0) m += 1; // ODD epoch-minute == ODD wall-clock minute
    if (m <= prev) m = prev + 2; // strictly increasing (+2 preserves ODD)
    if (m >= endMin) m = Math.max(prev + 2, endMin - 2 * (count - i)); // pack near close, stays ODD
    out.push(new Date(m * 60_000).toISOString());
    prev = m;
  }
  return out;
}
