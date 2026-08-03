/**
 * postingPolicy.ts — which networks may post today, how many times, and how far apart.
 *
 * ALL THREE NETWORKS RUN 12/DAY (2026-08-02). Instagram, YouTube Shorts and TikTok each
 * take the full daily allowance. The campaign is in its last two weeks and is optimising
 * for distribution, so the networks are no longer rationed against one another.
 *
 * Spacing is per-network and UNCHANGED by that: Instagram and YouTube keep the
 * 56-minute same-platform floor and their separate jitter lanes (scheduler.ts LANES) so
 * they never stack, and TikTok keeps its hard 4-HOUR floor. A network whose gap cannot
 * fit 12 posts in one window simply spills onto the next day via loopPublish.planSlots,
 * which is the designed behaviour for any over-full network.
 *
 * THIS IS A SPRINT BUDGET, NOT A STEADY STATE, AND THAT IS DELIBERATE
 *
 * Metricool's Fair Use ceiling is 700 PUBLISHED POSTS per brand per month, and breaching
 * it triggers a MANUAL HUMAN REVIEW during which the account cannot post at all. That
 * failure is indefinite and mid-campaign, so the monthly guard fails closed at the
 * documented 600 base threshold.
 *
 * The trap is that a fan-out to N networks costs N RECORDS, not one. Metricool splits a
 * multi-network post into one record per network, so the cost is
 * (sum of perDay over LIVE networks) * days — see monthlyRecords() below, which is the
 * executable version of this paragraph.
 *
 * THE ARITHMETIC, STATED PLAINLY. Three networks at 12/day is 36 records/day.
 *
 *   over a full 31-day month:  1,116 — nearly TWICE the 600 guard, so
 *                              budgetForecast(31).withinBudget is FALSE, on purpose;
 *   over a 14-day sprint:      504, which fits IF the month's counter starts near zero.
 *
 * So the honest description is: this cadence is affordable for a sprint and would not be
 * affordable indefinitely.
 *
 * WHAT THE GUARD ACTUALLY IS, as of 2026-08-03. budget() in metricool.ts fails closed at
 * 600 — but until this date NOTHING IN THE CYCLE CALLED IT. cycle.ts asked for slots with
 * `allocatable(Number.MAX_SAFE_INTEGER)`, so decide() rationed against infinite headroom
 * and the documented guard existed only for ops/resume_posting.mjs, a script run by hand.
 * The counter read 54 of 600 with 36/day committed and no cycle had ever logged a budget
 * line. cycle.ts liveHeadroom() now passes the real number, and exhaustionForecast()
 * below turns it into a dated countdown that is logged every run instead of a wall the
 * loop walks into. budgetForecast() remains the pure what-if that tests call.
 *
 * And there is no plan to buy out of it. maxPostsPerBrand is 700 on every API-enabled
 * Metricool plan, so the only lever is posting less on each network.
 */
import { CONFIG } from "./config.ts";

export type Network = "instagram" | "youtube" | "tiktok";

/** Every network the policy knows about, in the order slots are handed out. */
export const NETWORKS: Network[] = ["instagram", "youtube", "tiktok"];

export interface PolicyDecision {
  network: Network;
  allowed: boolean;
  /** True when a human paused this network, as distinct from a cooldown or a budget cap. */
  paused?: boolean;
  /** How many posts this network may take in this batch. */
  slots: number;
  minGapMinutes: number;
  reason: string;
}

/** Parse a naive local datetime ("2026-07-27T18:00:00") as ms in the brand timezone. */
function naiveLocalToMs(naive: string, timeZone: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(naive.trim());
  if (!m) return Number.NaN;
  const [, y, mo, d, h, mi, s] = m.map(Number) as unknown as number[];
  // Interpret the wall-clock fields in `timeZone` by correcting a UTC guess with the
  // zone's offset at that instant. Two passes settle DST edges.
  let guess = Date.UTC(y, mo - 1, d, h, mi, s);
  for (let i = 0; i < 2; i++) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone, hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(new Date(guess));
    const g: Record<string, number> = {};
    for (const p of parts) if (p.type !== "literal") g[p.type] = Number(p.value);
    const asUtc = Date.UTC(g.year, g.month - 1, g.day, g.hour === 24 ? 0 : g.hour, g.minute, g.second);
    guess += Date.UTC(y, mo - 1, d, h, mi, s) - asUtc;
  }
  return guess;
}

/** The env var that lifts a network's pause. Kept next to isPaused so the message a
 *  human reads and the switch they flip cannot drift apart. */
export function pauseEnvVar(network: Network): string {
  return `HERMES_${network.toUpperCase()}_PAUSED`;
}

/**
 * How many Metricool RECORDS this policy costs in a month of `days`.
 *
 * This is the arithmetic the 600-post guard is actually about, and it is a function
 * rather than a comment because the comment is what went stale: a fan-out to N networks
 * costs N records, so adding a network multiplies the bill instead of sharing it. A
 * paused network costs nothing.
 *
 * 31 days is the default deliberately — budgeting against a 30-day month understates
 * the worst case by a whole day of posting.
 */
export function monthlyRecords(days = 31): { perDay: number; perMonth: number; byNetwork: Record<string, number> } {
  const byNetwork: Record<string, number> = {};
  let perDay = 0;
  for (const network of NETWORKS) {
    if (isPaused(network)) continue;
    const n = CONFIG.PLATFORM_POLICY[network]?.perDay ?? 0;
    byNetwork[network] = n;
    perDay += n;
  }
  return { perDay, perMonth: perDay * days, byNetwork };
}

/**
 * Does the CURRENT policy fit inside the monthly guard over `days`?
 *
 * `days` is the horizon, and at 36 records/day the answer depends entirely on it: a
 * full 31-day month does not fit, the 14 days left in the campaign do. Pass the horizon
 * you actually mean rather than reading the 31-day default as a verdict on the plan.
 * Pure — this reports, it does not gate. The live guard is metricool.ts budget().
 */
export function budgetForecast(days = 31): {
  perDay: number;
  perMonth: number;
  budget: number;
  pctOfBudget: number;
  withinBudget: boolean;
  alerts: boolean;
  byNetwork: Record<string, number>;
  reason: string;
} {
  const { perDay, perMonth, byNetwork } = monthlyRecords(days);
  const budget = CONFIG.MC_MONTHLY_POST_BUDGET;
  const pct = budget > 0 ? perMonth / budget : 0;
  const within = perMonth <= budget;
  const alerts = pct >= CONFIG.MC_MONTHLY_ALERT_AT;
  const shape = Object.entries(byNetwork).map(([n, v]) => `${n} ${v}`).join(" + ") || "nothing live";
  return {
    perDay, perMonth, budget, pctOfBudget: pct, withinBudget: within, alerts, byNetwork,
    reason: within
      ? `${shape} = ${perDay} records/day = ${perMonth} in ${days} days (${(pct * 100).toFixed(0)}% of ${budget})`
      : `OVER BUDGET: ${shape} = ${perDay} records/day = ${perMonth} in ${days} days, over the ${budget} guard by ${perMonth - budget}`,
  };
}

export interface ExhaustionForecast {
  /** Records still unspent AND uncommitted: budget - published - already on the calendar. */
  headroom: number;
  perDay: number;
  /** Whole days of posting the headroom still buys. */
  daysLeft: number;
  /** Local calendar date the guard starts refusing, or null when the cadence is zero. */
  exhaustsOn: string | null;
  /** Inside WARN_DAYS of the wall — worth saying out loud every cycle. */
  warn: boolean;
  reason: string;
}

/**
 * How many more days this cadence can run before the monthly guard refuses.
 *
 * COMMITTED IS NOT THE SAME AS SPENT. Metricool's counter is
 * `monthPublishedPostsByBrand` — it moves when a post PUBLISHES, not when it is
 * scheduled. At 36 records/day placed one to two days ahead, the counter lags the
 * real commitment by 40-70 records, so a guard that reads it alone believes it has
 * headroom it has already promised away. `committed` is the future-dated rows on the
 * calendar, and subtracting them is what makes the guard fail closed BEFORE the wall
 * rather than two days after it.
 *
 * Pure. `today` is a naive local YYYY-MM-DD.
 */
export function exhaustionForecast(
  used: number,
  committed: number,
  perDay: number,
  today: string,
  budgetTotal: number = CONFIG.MC_MONTHLY_POST_BUDGET,
): ExhaustionForecast {
  const headroom = Math.max(0, budgetTotal - Math.max(0, used) - Math.max(0, committed));
  if (perDay <= 0) {
    return { headroom, perDay: 0, daysLeft: Infinity, exhaustsOn: null, warn: false, reason: "nothing is live — no records are being spent" };
  }
  const daysLeft = Math.floor(headroom / perDay);
  const exhaustsOn = addDays(today, daysLeft);
  const warn = daysLeft <= EXHAUSTION_WARN_DAYS;
  return {
    headroom,
    perDay,
    daysLeft,
    exhaustsOn,
    warn,
    reason:
      `${used} published + ${committed} already scheduled of ${budgetTotal} leaves ${headroom} records; ` +
      `at ${perDay}/day that is ${daysLeft} more full day(s), so the guard starts refusing on ${exhaustsOn}`,
  };
}

/** Inside this many days of the guard, every cycle says so. */
export const EXHAUSTION_WARN_DAYS = 7;

/** `YYYY-MM-DD` plus n days, as `YYYY-MM-DD`. */
function addDays(dayISO: string, n: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dayISO).trim());
  if (!m) return dayISO;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) + n * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/** Days between two naive local calendar dates (YYYY-MM-DD). NaN if either is unparseable. */
function daysBetween(fromISO: string, toISO: string): number {
  const p = (d: string): number => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d).trim());
    return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : Number.NaN;
  };
  const a = p(fromISO);
  const b = p(toISO);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.NaN;
  return Math.round((b - a) / 86_400_000);
}

/**
 * The per-day cap for `network` on the LOCAL CALENDAR DAY `dayISO` (YYYY-MM-DD).
 *
 * For every network except YouTube this is just PLATFORM_POLICY[network].perDay — the
 * behaviour every caller had before. YouTube additionally honours the seeding RAMP
 * (CONFIG.YT_RAMP_START / YT_RAMP_STEPS): a channel with no history opens at 3/day and
 * climbs to the real 7/day cap over four days.
 *
 * WHY THIS IS A CAP AND NOT A BACKFILL COUNTER. planSlots() sizes a day's room as
 * `perDayFor(network, day) - countOnDay(rows, network, day)`, and countOnDay counts
 * EVERY YouTube post already on that day whatever created it. So catalogue-backfill
 * posts and the loop's own fresh output draw down the SAME allowance: fill a ramp day
 * with backfill and the loop finds zero room there and moves on, instead of adding its
 * 7 on top. There is no second number to keep in sync, which is the point — a separate
 * backfill budget is exactly how the two would have drifted apart.
 *
 * FAILS OPEN TO THE REAL CAP, deliberately. An empty/malformed RAMP_START, a day before
 * the ramp starts, or a day past the last step all return PLATFORM_POLICY.youtube.perDay.
 * The dangerous direction here is a forgotten ramp silently pinning the network at 3/day
 * forever; the ramp can only ever LOWER the cap while it is running, and it stops
 * running by itself.
 */
export function perDayFor(network: Network, dayISO: string): number {
  const base = CONFIG.PLATFORM_POLICY[network]?.perDay ?? 0;
  if (network !== "youtube") return base;
  const start = String(CONFIG.YT_RAMP_START ?? "").trim();
  if (!start) return base;
  const d = daysBetween(start, dayISO);
  if (!Number.isFinite(d) || d < 0) return base;
  let cap = base;
  for (const step of CONFIG.YT_RAMP_STEPS) {
    if (d >= step.afterDays) cap = step.perDay;
  }
  // Never let the ramp table RAISE the cap above the policy — the monthly budget is
  // derived from PLATFORM_POLICY, so a typo here must not be able to overspend it.
  return Math.min(cap, base);
}

/**
 * Is posting to this network PAUSED?
 *
 * A pause is a human decision and it outranks every date-based rule, which is the point:
 * TikTok's cooldown has already expired, so without this the platform would quietly come
 * back on a timer that nobody re-approved. Checked before isDark() for that reason.
 *
 * Reversible by design — clear HERMES_TIKTOK_PAUSED and the network resumes on its
 * existing cadence. See CONFIG.PLATFORM_POLICY for the one-step instruction.
 */
export function isPaused(network: Network): boolean {
  return CONFIG.PLATFORM_POLICY[network]?.paused === true;
}

/** Is a network still inside its blackout window? */
export function isDark(network: Network, now: Date = new Date()): { dark: boolean; until?: string } {
  const p = CONFIG.PLATFORM_POLICY[network];
  if (!p?.darkUntil) return { dark: false };
  const untilMs = naiveLocalToMs(p.darkUntil, CONFIG.METRICOOL_TZ);
  if (!Number.isFinite(untilMs)) return { dark: false };
  return { dark: now.getTime() < untilMs, until: p.darkUntil };
}

/**
 * What each network may do right now.
 *
 * `budgetRemaining` is the live Metricool monthly headroom (see metricool.ts budget()).
 * Instagram is served FIRST when headroom is short — NETWORKS puts it first for exactly
 * this reason. It is the only network that reports a 3-second skip rate, which is the
 * one metric that predicts reach on this account, and it is where the audience is. If
 * something has to give it is the other networks' slots that shrink, not Instagram's.
 */
export function decide(budgetRemaining: number, now: Date = new Date()): PolicyDecision[] {
  const out: PolicyDecision[] = [];
  let left = Math.max(0, budgetRemaining);

  for (const network of NETWORKS) {
    const p = CONFIG.PLATFORM_POLICY[network];
    // PAUSE FIRST. It is a deliberate hold and it overrides the date-based cooldown,
    // which has expired and would otherwise re-admit the network on its own.
    if (isPaused(network)) {
      out.push({
        network, allowed: false, slots: 0, minGapMinutes: p.minGapMinutes, paused: true,
        reason: `PAUSED by config — set ${pauseEnvVar(network)}=false to resume at ${p.perDay}/day with a ${p.minGapMinutes}-minute floor`,
      });
      continue;
    }
    const dark = isDark(network, now);
    if (dark.dark) {
      out.push({
        network, allowed: false, slots: 0, minGapMinutes: p.minGapMinutes,
        reason: `dark until ${dark.until} ${CONFIG.METRICOOL_TZ} (account-level suppression; a previous throttle needed 27.9h of silence)`,
      });
      continue;
    }
    const want = p.perDay;
    const slots = Math.min(want, left);
    left -= slots;
    out.push({
      network,
      allowed: slots > 0,
      slots,
      minGapMinutes: p.minGapMinutes,
      reason: slots === 0
        ? "no monthly publication headroom left"
        : slots < want
          ? `capped to ${slots} of ${want} by remaining monthly budget`
          : `${slots}/day`,
    });
  }
  return out;
}

/**
 * Evenly spread `count` slot times across a posting window, honouring a minimum gap.
 * Returns naive local datetimes in the brand timezone, ready for Metricool.
 *
 * Returns FEWER slots than asked rather than violating the gap — on TikTok the gap is
 * the whole point of the restart and quietly compressing it would undo the recovery.
 */
export function slotTimes(
  count: number,
  opts: { dayISO: string; startHour: number; endHour: number; minGapMinutes: number },
): string[] {
  if (count <= 0) return [];
  const { dayISO, startHour, endHour, minGapMinutes } = opts;
  const windowMin = (endHour - startHour) * 60;
  if (windowMin <= 0) return [];

  const maxByGap = minGapMinutes > 0 ? Math.floor(windowMin / minGapMinutes) + 1 : count;
  const n = Math.max(0, Math.min(count, maxByGap));
  if (n === 0) return [];

  const step = n === 1 ? 0 : windowMin / (n - 1);
  const times: string[] = [];
  for (let i = 0; i < n; i++) {
    const offset = Math.round(startHour * 60 + step * i);
    const h = Math.floor(offset / 60);
    const m = offset % 60;
    times.push(`${dayISO}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00`);
  }
  return times;
}
