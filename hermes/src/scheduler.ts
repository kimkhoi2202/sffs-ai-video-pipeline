/**
 * scheduler.ts — the POST-KICKOFF scheduling policy (pure; no network, no Publer).
 *
 * Policy (used ONLY when kickoff.ts is armed; the OFF loop never calls this):
 *   - TIME WINDOW: schedule ONLY between 7:00am and 1:00am America/Chicago
 *     (CST/CDT resolved automatically via Intl — July is CDT/UTC-5). NOTHING is
 *     ever scheduled 1:00am–7:00am (the dead hours).
 *   - NATURAL JITTER: odd, irregular minutes (e.g. 3:13, 9:47 — never :00/:15/:30),
 *     irregular gaps between posts, and a per-platform JITTER LANE so no two networks
 *     land on an identical timestamp — or even a near-identical one.
 *
 * THE LANE TABLE IS THE WHOLE CROSS-NETWORK GUARANTEE. A platform that is not in
 * LANES has no lane of its own, and the failure mode is silent: it would share
 * another network's band and publish alongside it all day while everything still
 * "works". So an unrecognised platform is a hard error, not a default.
 *
 * Everything here is deterministic given (count, from, seed, platform) so it is
 * unit-testable, while still LOOKING organic (seeded jitter, not a fixed cadence).
 */

export const TZ = "America/Chicago";
/** Allowed wall-clock band: [07:00, 01:00 next day). Dead hours = [01:00, 07:00). */
export const WINDOW_OPEN_HOUR = 7;
/**
 * Wall-clock hour the window CLOSES on the following day (exclusive). 1 => the band
 * runs 07:00 -> 01:00 next day (an 18h window). Everything below derives the close
 * from this constant, so widening/narrowing the window is a one-line change and the
 * dead hours [WINDOW_CLOSE_HOUR, WINDOW_OPEN_HOUR) stay consistent everywhere.
 *
 * WAS 3, which put real posts at 1am, 2am and 2:39am Chicago. Nothing was wrong with
 * the scheduler; the band was simply wider than any hour worth posting in, and the
 * tail of it was spending daily cap on the emptiest part of the clock.
 */
export const WINDOW_CLOSE_HOUR = 1;
/**
 * DEFAULT minimum per-platform gap (minutes) a NEW slot must keep from a SAME-platform
 * post a PREVIOUS cycle ALREADY scheduled (see `SlotOpts.avoid`). This is what stops a
 * later batch (e.g. a front-runner replication cycle) from landing minutes away from
 * a post an earlier armed cycle already placed — the collision that put a 10:13pm
 * TikTok post two minutes from an existing 10:15pm one.
 *
 * IT IS A DEFAULT, NOT THE POLICY. Every network's real floor lives in
 * CONFIG.PLATFORM_POLICY[network].minGapMinutes, and this module stays pure by taking
 * it through `SlotOpts.minGapMin` rather than importing config. Hardcoding it here
 * silently overrode TikTok's configured 240 with 56 — a four-times-faster cadence than
 * policy, on the one channel already under suppression, which is the opposite of what
 * a recovery needs. A caller that names a platform should pass that platform's floor.
 */
export const MIN_GAP_MIN = 56;

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

/**
 * Render a real instant as an ISO-8601 string that CARRIES `tz`'s offset, e.g.
 * "2026-08-03T00:21:00-05:00".
 *
 * Exists because the two ways a timestamp gets read in this repo disagree unless the
 * offset is present. rollup.ts's timeBucket() reads the hour AS WRITTEN — which is only
 * the account's posting hour when the string says which zone it is written in — while
 * everything else calls Date.parse(), which resolves a naive string against the BOX's
 * zone. An offset-carrying string is the one form both read correctly.
 */
export function isoInZone(ms: number, tz: string = TZ): string {
  const d = new Date(ms);
  const p = parts(d, tz);
  const off = offsetMs(d, tz);
  const a = Math.abs(off);
  const pad = (n: number) => String(n).padStart(2, "0");
  const sign = off >= 0 ? "+" : "-";
  return (
    `${p.y}-${pad(p.mo)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}` +
    `${sign}${pad(Math.floor(a / 3_600_000))}:${pad(Math.floor((a % 3_600_000) / 60_000))}`
  );
}

/** Chicago wall-clock hour of a UTC instant. */
export function chicagoHour(date: Date): number {
  return parts(date).h;
}

/** True iff `date` (a UTC instant) is inside the allowed Chicago posting window. */
export function isWithinWindow(date: Date): boolean {
  const h = parts(date).h;
  // allow 00:xx..02:xx and 07:00..23:59; forbid the dead hours 03..06
  return h < WINDOW_CLOSE_HOUR || h >= WINDOW_OPEN_HOUR;
}

/** Real UTC instant for a Chicago wall-clock (DST-correct enough for our slack). */
function fromChicago(y: number, mo: number, d: number, h: number, mi: number): Date {
  const guess = new Date(Date.UTC(y, mo - 1, d, h, mi, 0));
  const off = offsetMs(guess);
  return new Date(Date.UTC(y, mo - 1, d, h, mi, 0) - off);
}

/**
 * The UTC instant whose `tz` wall clock reads `naive` ("YYYY-MM-DDTHH:MM:SS", no zone).
 *
 * Metricool stores naive local time, so every post already on the calendar has to be
 * turned back into an instant before MIN_GAP_MIN can be measured against it. Deriving
 * that offset from the HOST's clock is what silently killed the floor: the box runs UTC,
 * so an "is it DST?" probe against the local zone answered no all summer and every
 * existing post was read exactly 60 minutes late. 60 > MIN_GAP_MIN, so a slot genuinely
 * colliding with an existing post measured as comfortably clear, and the miss was
 * one-sided — anything placed EARLIER than an existing post sailed through.
 *
 * The offset is resolved from `tz` at the instant in question, so it is correct on both
 * sides of a DST transition and does not care which zone the process runs in.
 */
export function instantFromWallClock(naive: string, tz: string = TZ): number {
  const asIfUtc = Date.parse(`${String(naive).trim()}Z`);
  if (!Number.isFinite(asIfUtc)) return NaN;
  // offsetMs() needs a real instant to resolve the zone's rules at. The naive string
  // read as UTC is within a day of the answer — near enough to pick the right side of a
  // transition — and the second pass settles the hour it was out by.
  const first = asIfUtc - offsetMs(new Date(asIfUtc), tz);
  return asIfUtc - offsetMs(new Date(first), tz);
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

/**
 * JITTER LANES — the per-platform band, as a fraction of one post's segment, that a
 * slot's jitter is drawn from. Disjoint bands + a gutter between them are what keep
 * two networks from landing on the same minute.
 *
 * Instagram keeps the 0.10 band start and TikTok the 0.90 band end that the original
 * two-lane layout used, so the envelope is unchanged and TikTok's cadence on resume is
 * the same shape it always was; YouTube takes the middle band that the old 0.16 gutter
 * left empty. Widths shrank 0.32 -> 0.20 to make room, which narrows the within-lane
 * jitter slightly and leaves gaps just as irregular (see scheduler.test.ts).
 */
export const LANE_WIDTH = 0.2;
/** Gap between adjacent lanes. Must stay > 2/seg so ODD-minute rounding cannot
 *  collapse two lanes onto one minute; at 9/day (seg ~133min) this is ~13 minutes. */
export const LANE_GUTTER = 0.1;
export const LANES: Record<string, number> = {
  instagram: 0.1, // [0.10, 0.30]
  youtube: 0.4, //   [0.40, 0.60]
  tiktok: 0.7, //    [0.70, 0.90]
};
/** The default lane for a caller that names no platform (the documented `nextSlots(n)`
 *  shape). A NAMED platform with no lane is a bug we refuse to paper over. */
const DEFAULT_LANE = LANES.instagram;

/**
 * The jitter lane for `platform`.
 *
 * Throws on an unknown platform ON PURPOSE. The alternative — falling back to a
 * default — is how a newly added network silently inherits another one's band and
 * publishes seconds away from it all day, with nothing in the logs and every test
 * still green. Adding a network should have to add a lane.
 */
export function laneFor(platform?: string): number {
  const p = (platform ?? "").trim();
  if (!p) return DEFAULT_LANE;
  const lane = LANES[p];
  if (lane === undefined) {
    throw new Error(
      `scheduler: no jitter lane for platform "${p}". Add one to LANES in scheduler.ts — ` +
        `without its own band it would share another network's slots. Known: ${Object.keys(LANES).join(", ")}.`,
    );
  }
  return lane;
}

export interface SlotOpts {
  fromMs?: number; // base instant (default: now)
  seed?: string; // deterministic jitter seed (e.g. runId)
  platform?: string; // per-platform jitter lane (see LANES) so networks never collide
  /**
   * ISO times of SAME-platform posts a PREVIOUS cycle already scheduled. When set,
   * every returned slot is kept >= the gap minutes away from each of them (and
   * from the other slots in this batch), so two separately-scheduled batches can
   * never collide. Empty/omitted (the default) => the unchanged even distribution.
   */
  avoid?: string[];
  /**
   * This platform's same-platform floor in minutes, from
   * CONFIG.PLATFORM_POLICY[network].minGapMinutes. Defaults to MIN_GAP_MIN so existing
   * callers are unchanged; pass it whenever `platform` is named, or the network's own
   * configured policy is ignored in favour of Instagram's.
   */
  minGapMin?: number;
}

/** The next WINDOW_CLOSE_HOUR (1:00am) America/Chicago strictly after `fromD` — the
 *  CLOSE of the posting window containing (or following) `fromD`. */
function nextWindowClose(fromD: Date): Date {
  const p = parts(fromD);
  // 00:xx..02:xx is the TAIL of the window that opened yesterday -> it closes today.
  if (p.h < WINDOW_CLOSE_HOUR) return fromChicago(p.y, p.mo, p.d, WINDOW_CLOSE_HOUR, 0);
  // 01:00-23:59 -> the close is tomorrow. Step via NOON so the +24h hop can never
  // land on the same calendar day across a DST transition.
  const t = parts(new Date(fromChicago(p.y, p.mo, p.d, 12, 0).getTime() + 24 * 3600_000));
  return fromChicago(t.y, t.mo, t.d, WINDOW_CLOSE_HOUR, 0);
}

/** The 7:00am America/Chicago that OPENS the window AFTER `fromD`'s window closes. */
function next7am(fromD: Date): Date {
  // the close (01:00) of this window; the next window opens 07:00 that SAME day
  const c = parts(nextWindowClose(fromD));
  return fromChicago(c.y, c.mo, c.d, WINDOW_OPEN_HOUR, 0);
}

/**
 * Produce `count` DISTINCT schedule timestamps (ISO, minute-resolution), all inside
 * ONE Chicago posting window [max(now, 7:00am) .. 1:00am), EVENLY distributed with
 * per-slot jitter, ODD minutes, and a per-platform jitter LANE so no two networks
 * share (or crowd) a minute.
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
  // This platform's same-platform floor. Rounded EVEN because slot search steps in twos
  // to stay on odd wall-clock minutes; an odd floor would flip candidates onto even ones.
  const gapMin = Math.max(0, Math.round((opts.minGapMin ?? MIN_GAP_MIN) / 2) * 2);
  // baseRng is PLATFORM-INDEPENDENT so both platforms share the SAME window + segment
  // grid (the per-platform jitter lanes below can only separate aligned grids).
  const baseRng = lcg(hashSeed(`${seed}|base`));
  const rng = lcg(hashSeed(`${seed}|${opts.platform ?? ""}`)); // per-platform lane jitter
  // a few jittered minutes into the future, then into the window (dead hours -> 7am)
  let start = intoWindow(new Date((opts.fromMs ?? Date.now()) + (5 + Math.floor(baseRng() * 21)) * 60_000), baseRng);
  // Don't cram: if the remaining window can't hold `count` posts >= ~18 min apart,
  // roll to the NEXT full window instead of stacking them minutes apart.
  const MIN_SEG_MIN = 18;
  if ((nextWindowClose(start).getTime() - start.getTime()) / 60_000 < count * MIN_SEG_MIN) {
    start = next7am(start);
  }
  const startMin = Math.ceil(start.getTime() / 60_000); // epoch minutes (>= start)
  const endMin = Math.floor(nextWindowClose(start).getTime() / 60_000) - 5; // 5-min buffer before the close
  // RETURN FEWER SLOTS RATHER THAN VIOLATE THE FLOOR. The even-distribution path used
  // to spread `count` posts across the window and never look at the gap at all, so
  // TikTok's 240-minute floor placed eleven posts ~84 minutes apart — the floor was
  // configured, documented, and had never once applied. Eleven posts at 240 minutes
  // needs forty hours; the honest answer is to place as many as the window holds and
  // let the caller walk the horizon to the next day for the rest, which loopPublish
  // already does with whatever it gets back.
  const windowMin = endMin - startMin;
  const maxByGap = gapMin > 0 ? Math.floor(windowMin / gapMin) + 1 : count;
  count = Math.max(0, Math.min(count, maxByGap));
  if (count <= 0) return [];
  const seg = Math.max(1, (endMin - startMin) / count); // per-post segment (minutes)
  // Per-platform jitter LANE within each segment, so two networks can never round to
  // the same minute — a stronger guarantee than a fixed shift. Epoch-minute arithmetic
  // keeps every slot on an ODD wall-clock minute (60 is even, so odd epoch-min == odd
  // mm), strictly increasing + distinct.
  //
  // Three disjoint bands of width LANE_WIDTH separated by a LANE_GUTTER gutter, inside
  // the same [0.10, 0.90] envelope the two-lane version used — so Instagram still starts
  // its band at 0.10 and TikTok still ends its band at 0.90. At the operating count
  // (9/day over an ~18h window, seg ~120min) the gutter is ~12 real minutes, so an
  // Instagram slot and a YouTube slot in the same segment are always minutes apart
  // rather than seconds.
  const laneLo = laneFor(opts.platform);
  // Collision-awareness: SAME-platform instants a PREVIOUS cycle already scheduled
  // (as epoch-minutes). A new slot must stay >= MIN_GAP_MIN from each of these AND,
  // once we are avoiding, from the previous NEW slot — so a later batch never lands
  // minutes from an earlier batch's post. Empty (the default) => the loop below is
  // byte-for-byte the legacy even distribution (all existing tests unaffected).
  const avoidMin = (opts.avoid ?? [])
    .map((s) => Math.round(Date.parse(s) / 60_000))
    .filter((m) => Number.isFinite(m));
  const collisionAware = avoidMin.length > 0;
  const clashesAvoid = (m: number): boolean => avoidMin.some((a) => Math.abs(m - a) < gapMin);
  const out: string[] = [];
  let prev = startMin - 2;
  for (let i = 0; i < count; i++) {
    let m = Math.round(startMin + i * seg + (laneLo + rng() * LANE_WIDTH) * seg);
    if (m % 2 === 0) m += 1; // ODD epoch-minute == ODD wall-clock minute
    if (m <= prev) m = prev + 2; // strictly increasing (+2 preserves ODD)
    if (collisionAware) {
      // A free ODD minute is one that is inside [floor, close), >= the gap after
      // the previous NEW slot, and >= the gap from EVERY already-scheduled same-
      // platform post. Search OUTWARD from the even-distribution target for the
      // nearest such minute — bidirectional so new slots stay near their spread-out
      // ideals (no forward drift / pile-up at the window close) instead of just
      // stepping past a clash. The gap is rounded even above, so candidates stay ODD.
      const floor = i > 0 ? prev + gapMin : startMin;
      const free = (x: number): boolean => x >= floor && x < endMin && !clashesAvoid(x);
      if (!free(m)) {
        let found = -1;
        for (let d = 2; d <= 4000 && found < 0; d += 2) {
          if (free(m + d)) found = m + d;
          else if (free(m - d)) found = m - d;
        }
        m = found >= 0 ? found : Math.max(floor, m); // best-effort if the window is saturated
      }
    } else if (m >= endMin) {
      m = Math.max(prev + 2, endMin - 2 * (count - i)); // legacy: pack near close, stays ODD
    }
    out.push(new Date(m * 60_000).toISOString());
    prev = m;
  }
  // THE FLOOR IS ENFORCED ON THE ARTIFACT, NOT ON THE ARITHMETIC. The count cap above
  // sizes the batch, but the even-distribution path then jitters each slot within its
  // segment, and a segment sized exactly at the floor can jitter to just under it —
  // TikTok's first run of this came back at 190 minutes against a 240 floor. Rather
  // than reverse-engineer the jitter envelope into the cap and hope it stays true when
  // the lane widths change, drop any slot that lands too close to the one before it.
  // Fewer slots is the documented, intended answer; a violated floor is not.
  if (gapMin <= 0) return out;
  const kept: string[] = [];
  let lastMin = -Infinity;
  for (const iso of out) {
    const m = Date.parse(iso) / 60_000;
    if (m - lastMin < gapMin) continue;
    kept.push(iso);
    lastMin = m;
  }
  return kept;
}
