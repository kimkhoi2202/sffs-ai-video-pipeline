/**
 * hooks.ts — the HOOK BANK reader.
 *
 * ab-testing/hook-bank.json holds pre-approved, in-voice, claim-tagged opening
 * lines grouped by psychological MECHANISM. This module turns that file into the
 * A/B arms the designer rotates and picks one concrete line per video.
 *
 * Why the bank and not literals in dimensions.ts: the previous hook arm hardcoded
 * "ONLY 1% PASS" in the catalog, which meant the copy could not be reviewed,
 * varied, or claim-checked without a code change, and one string per arm confounds
 * "this MECHANISM works" with "this SENTENCE works". The bank gives each mechanism
 * several interchangeable phrasings, so an arm's result is about the mechanism.
 *
 * DEPENDENCY-FREE (node builtins + config/state only), like dimensions.ts, so the
 * offline `sffs_design catalog` probe keeps working.
 */
import { readJSON } from "./state.ts";
import { CONFIG } from "./config.ts";

/**
 * The spoken hook rides OVER the 2.2s motion opening, so it has to FIT inside it. The
 * budget is the animation minus the segment lead; anything longer would bleed into the
 * question read, collide with the question VO, and reintroduce the serial delay the
 * overlay design exists to remove. Mirrors HOOK_SECONDS in remotion/src/full/timeline.ts
 * and SHORT_LEAD in render.ts.
 */
export const HOOK_BUDGET_SEC = 2.2 - 0.12;

/**
 * Selection headroom. ElevenLabs is generative, so the SAME line does not synthesize to
 * the same length twice: "Only one percent pass." calibrated at 2.08s and came back at
 * 2.16s on the production render, which the runtime guard then (correctly) refused,
 * costing that video its hook. Measured drift was about 4%, so selection holds back
 * 0.15s and only offers lines that will still fit after a bad roll. The runtime guard in
 * render.ts stays exactly where it is -- this reduces how often it fires, it does not
 * replace it.
 */
export const HOOK_TTS_MARGIN_SEC = 0.15;
/** What a line must measure at calibration time to be offered at all. */
export const HOOK_SELECT_MAX_SEC = HOOK_BUDGET_SEC - HOOK_TTS_MARGIN_SEC;

export interface HookOpening {
  id: string;
  mechanism: string;
  vo: string;
  /** MEASURED spoken length, written by tools/calibrate-hooks.ts. Absent means the line
   *  has never been measured, which is treated as not-fitting: we do not guess. */
  vo_sec?: number;
  plate: { title: string; subtitle?: string };
  claim_class: string;
  /** Render props this line needs in order to stay TRUE. null = unconditional. */
  requires?: { numQ?: number; countdownSec?: number; ending?: string } | null;
  /** Placeholders the selector must substitute (e.g. "{WRONG}" -> a wrong letter). */
  fill?: Record<string, string>;
}

interface HookBank {
  mechanisms?: Record<string, { arm?: string; surfaces?: string[] }>;
  openings?: HookOpening[];
}

/** Resolved copy for one video: the plate text plus the line to speak. */
export interface ResolvedHook {
  title: string;
  subtitle?: string;
  vo: string;
  id: string;
  mechanism: string;
}

/** Render facts a line's `requires` is checked against. */
export interface HookContext {
  numQ: number;
  countdownSec: number;
  /** Resolved ending arm: "cliffhanger" | "full-reveal" | "no-answer". */
  ending: string;
  /** Answer-option letters that are NOT correct, for `fill` placeholders. */
  wrongLetters?: string[];
}

export function loadHookBank(): HookBank {
  return readJSON<HookBank>(CONFIG.HOOK_BANK, {});
}

/** The opening mechanisms, each with its stable A/B arm label, in bank order. */
export function hookArms(bank: HookBank = loadHookBank()): Array<{ mechanism: string; arm: string }> {
  const mechs = bank.mechanisms ?? {};
  return Object.entries(mechs)
    .filter(([, m]) => m.arm && (m.surfaces ?? []).includes("opening"))
    .map(([mechanism, m]) => ({ mechanism, arm: String(m.arm) }));
}

/** Does this line stay TRUE under the render props we are about to use? */
export function eligible(o: HookOpening, ctx: HookContext): boolean {
  // FIRST the budget, because a line that does not fit is not a line we have.
  // Unmeasured counts as over budget: tools/calibrate-hooks.ts exists so this is
  // never a guess, and failing closed keeps question one where it is.
  if (!(typeof o.vo_sec === "number" && o.vo_sec > 0 && o.vo_sec <= HOOK_SELECT_MAX_SEC)) return false;
  const r = o.requires;
  if (!r) return true;
  if (r.numQ != null && r.numQ !== ctx.numQ) return false;
  if (r.countdownSec != null && r.countdownSec !== ctx.countdownSec) return false;
  if (r.ending != null && r.ending !== ctx.ending) return false;
  return true;
}

function seedOf(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) (h ^= s.charCodeAt(i)), (h = Math.imul(h, 16777619));
  return h >>> 0;
}

/**
 * Substitute a line's `fill` placeholders. Today the only one is {WRONG}, which
 * MUST resolve to an option letter that is not the answer: a decoy hook that names
 * the correct letter would contradict its own reveal on camera. If we cannot prove
 * a safe substitution, the line is refused (null) rather than guessed.
 */
function resolveFill(text: string, o: HookOpening, ctx: HookContext, seed: number): string | null {
  if (!o.fill) return text;
  let out = text;
  for (const ph of Object.keys(o.fill)) {
    if (!out.includes(ph)) continue;
    if (ph !== "{WRONG}") return null; // unknown placeholder: refuse rather than ship a literal "{X}"
    const wrong = (ctx.wrongLetters ?? []).filter(Boolean);
    if (!wrong.length) return null;
    out = out.split(ph).join(wrong[seed % wrong.length]);
  }
  return out.includes("{") ? null : out;
}

/**
 * Pick one line for `mechanism`, deterministic in `seed` so a re-render of the same
 * video reuses the same copy (and therefore the same cached hook.mp3). Returns null
 * when the mechanism has no line that is eligible AND fillable for these props, which
 * the caller should treat as "drop the hook", never as "ship it anyway".
 */
export function pickHook(mechanism: string, seed: string, ctx: HookContext, bank: HookBank = loadHookBank()): ResolvedHook | null {
  const pool = (bank.openings ?? []).filter((o) => o.mechanism === mechanism && eligible(o, ctx));
  if (!pool.length) return null;
  const n = seedOf(seed);
  // Walk from the seeded start so a line refused by resolveFill falls through to the
  // next candidate instead of dropping the whole arm.
  for (let i = 0; i < pool.length; i++) {
    const o = pool[(n + i) % pool.length];
    const vo = resolveFill(o.vo, o, ctx, n);
    const title = resolveFill(o.plate.title, o, ctx, n);
    const subtitle = o.plate.subtitle == null ? undefined : resolveFill(o.plate.subtitle, o, ctx, n);
    if (vo == null || title == null || subtitle === null) continue;
    return { title, subtitle, vo, id: o.id, mechanism };
  }
  return null;
}
