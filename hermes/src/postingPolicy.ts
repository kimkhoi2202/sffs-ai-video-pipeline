/**
 * postingPolicy.ts — which networks may post today, how many times, and how far apart.
 *
 * This exists because the two networks are in completely different states and a single
 * shared cap cannot express that.
 *
 *   INSTAGRAM is the campaign now: 12/day, no gap constraint. It is also the only
 *   network that reports a 3-second skip rate, so it is the only place the opening
 *   experiment can be measured at all.
 *
 *   TIKTOK is under ACCOUNT-LEVEL SUPPRESSION. The last throttle only lifted after
 *   27.9 hours of unbroken silence; the account has been quiet since 2026-07-25 15:45
 *   America/Chicago. It stays dark until Monday evening and then comes back at 2/day
 *   with a hard 4-hour floor between posts. Resuming early risks a fresh throttle and
 *   there is no way to buy back the silence.
 *
 * On top of both sits Metricool's Fair Use ceiling: 700 published posts per brand per
 * month, and breaching it triggers a MANUAL HUMAN REVIEW during which the account
 * cannot post at all. That failure is indefinite and mid-campaign, so the monthly
 * guard fails closed at the documented 600 base threshold and warns from 80%.
 * At 12 IG/day plus 2 TikTok/day this plan runs ~420/month, about 60% of 600.
 */
import { CONFIG } from "./config.ts";

export type Network = "instagram" | "tiktok";

export interface PolicyDecision {
  network: Network;
  allowed: boolean;
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
 * Instagram is served first when headroom is short: it is the measurable arm and the
 * one carrying the campaign, so if something has to give it is not Instagram.
 */
export function decide(budgetRemaining: number, now: Date = new Date()): PolicyDecision[] {
  const out: PolicyDecision[] = [];
  let left = Math.max(0, budgetRemaining);

  for (const network of ["instagram", "tiktok"] as Network[]) {
    const p = CONFIG.PLATFORM_POLICY[network];
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
