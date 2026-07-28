/**
 * postingPolicy.ts — which networks may post today, how many times, and how far apart.
 *
 * This exists because the two networks are in completely different states and a single
 * shared cap cannot express that.
 *
 *   INSTAGRAM runs at 12/day behind a 56-minute floor, UNCHANGED. It is the only
 *   network that reports a 3-second skip rate, so it is the only place the opening
 *   experiment can be measured at all, and it is the only channel currently producing
 *   anything. Its volume is protected; YouTube is fitted around it.
 *
 *   YOUTUBE SHORTS is the second live network at 7/day behind the same 56-minute
 *   floor, with its own jitter lane so the two never stack (scheduler.ts LANES). 7 is
 *   the RESIDUAL of the budget, not a preference — see the arithmetic below.
 *
 *   TIKTOK is PAUSED (CONFIG.PLATFORM_POLICY.tiktok.paused). It is under account-level
 *   suppression and never resumed when its cooldown expired, so the pause makes that a
 *   decision instead of an accident. Its cadence — 2/day behind a hard 4-hour floor — is
 *   kept exactly as it should be on resume. Clear HERMES_TIKTOK_PAUSED to bring it back.
 *
 * WHY 9 AND 9, AND WHY THIS IS NOT A BILLING QUESTION
 *
 * Metricool's Fair Use ceiling is 700 PUBLISHED POSTS per brand per month, and breaching
 * it triggers a MANUAL HUMAN REVIEW during which the account cannot post at all. That
 * failure is indefinite and mid-campaign, so the monthly guard fails closed at the
 * documented 600 base threshold and warns from 80%.
 *
 * The trap is that a fan-out to N networks costs N RECORDS, not one. Metricool splits a
 * multi-network post into one record per network, so the monthly cost is
 * (sum of perDay over LIVE networks) * days — see monthlyRecords() below, which is the
 * executable version of this paragraph.
 *
 * YOUTUBE'S 7/DAY IS THE RESIDUAL, DERIVED LIKE THIS. Instagram is fixed at 12/day, so
 * over the longest month it spends 12 * 31 = 372 of the 600, leaving 228. 228 / 31 =
 * 7.35, so YouTube gets 7:
 *
 *   Instagram 12 + YouTube 7 = 19/day = 589 in a 31-day month (98% of the 600 guard)
 *                                     = 570 in a 30-day month (95%)
 *   Instagram 12 + YouTube 8 = 20/day = 620 in a 31-day month — OVER. The guard would
 *                                       fail closed and stop scheduling near month end.
 *
 * 7 holds for both month lengths, so there is no seasonal adjustment to remember. Note
 * the plan now sits ABOVE the 80% warn line by design: at 98% the warning is no longer
 * an early signal, it is the steady state, and the number that actually matters is
 * budgetForecast().withinBudget.
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
 * Does the CURRENT policy fit inside the monthly guard, and does it trip the 80% warn?
 *
 * Fails closed on `withinBudget` so a policy edit that overshoots is caught by a test
 * and a preflight rather than by the scheduler quietly refusing to place posts on the
 * 29th of the month — which is what Instagram 12 + YouTube 9 (651/month) would have done.
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
 * this reason. It is the measurable arm and the one carrying the experiment, so if
 * something has to give it is YouTube's slots that shrink, not Instagram's.
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
