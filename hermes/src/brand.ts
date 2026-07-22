/**
 * brand.ts — load the SFFS brand-voice DB so every piece of generated copy is
 * written IN VOICE and can be gated against the hard rules. Falls back gracefully
 * if the files are missing.
 */
import { existsSync, readFileSync } from "node:fs";
import { CONFIG } from "./config.ts";

export interface BrandVoice {
  guide: string;
  examples: string[];
  hardRules: string;
  signatureDevice: string;
}

const HARD_RULES =
  "concise; funny; Gen Z lowercase-casual; kid-safe (no hard/explicit profanity, mild slang like 'af' ok); " +
  "NO em dashes; at most ONE tasteful emoji (never spam); no AI-slop tone; no over-explaining/lecturing; " +
  "always end social copy with a follow / come-back nudge.";

export function loadBrandVoice(): BrandVoice {
  let guide = "";
  if (existsSync(CONFIG.BRAND_VOICE)) guide = readFileSync(CONFIG.BRAND_VOICE, "utf8").slice(0, 8000);

  const examples: string[] = [];
  if (existsSync(CONFIG.BRAND_EXAMPLES)) {
    try {
      const raw = JSON.parse(readFileSync(CONFIG.BRAND_EXAMPLES, "utf8"));
      const collect = (v: any) => {
        if (typeof v === "string") examples.push(v);
        else if (Array.isArray(v)) v.forEach(collect);
        else if (v && typeof v === "object") Object.values(v).forEach(collect);
      };
      collect(raw);
    } catch {
      /* ignore malformed */
    }
  }
  return {
    guide,
    examples: examples.filter((e) => e && e.length < 240).slice(0, 60),
    hardRules: HARD_RULES,
    signatureDevice: "SMART FELLA (praise) vs FART SMELLA '(for now)' (miss).",
  };
}

/** Deterministic, rule-based copy checks (the LLM gate adds judgement on top). */
export function ruleCheckCopy(text: string): { pass: boolean; violations: string[] } {
  const violations: string[] = [];
  if (/\u2014/.test(text)) violations.push("contains em dash (—)");
  const emojis = (text.match(/\p{Extended_Pictographic}/gu) || []).length;
  if (emojis > 1) violations.push(`too many emoji (${emojis} > 1)`);
  const profanity = /\b(fuck|shit|bitch|asshole|cunt|dick|pussy|nigger|faggot|retard)\b/i;
  if (profanity.test(text)) violations.push("contains hard profanity (not kid-safe)");
  if (text.length > 600) violations.push(`too long (${text.length} chars)`);
  if (/\b(as an ai|dive in|unleash|elevate|game[- ]changer|in today's world|delve)\b/i.test(text))
    violations.push("AI-slop phrasing");
  return { pass: violations.length === 0, violations };
}
