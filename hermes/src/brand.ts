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
  "NO em dashes and NO en dashes; the 🧠💨 glyph is the LOGO and is free, plus at most ONE other emoji " +
  "(never spam); no AI-slop tone; no over-explaining/lecturing; " +
  // The nudge is still mandatory; WHICH nudge changed. Social copy now closes on the
  // free test, with the comment beat demoted to the line before it. Leaving this as
  // "follow / come-back" would have the judge reject the very captions the new prompt
  // is written to produce, which is how a rule text and a prompt drift into opposition.
  "always end social copy with a nudge, and make TAKING THE FREE TEST the closing ask; " +
  "a light comment beat may come before it, but do not ask for a follow or subscribe. " +
  "CLAIMS: difficulty puffery about the PUZZLE is fine and encouraged ('97% get this wrong', " +
  "'only 3% can solve this', '9 out of 10 pick B') and needs no substantiation; claims about the " +
  "PRODUCT or the viewer's OUTCOME are forbidden ('97% of users gain 20 IQ points', 'watch daily and " +
  "get smarter', 'scientifically proven', 'improves memory/focus/grades'). See compliance.md section 3.";

/**
 * The brand LOGO glyph (brain + wind). It is two codepoints but reads as one mark,
 * and it is the single most-used element of the house caption style, so it does NOT
 * count against the one-emoji cap. Counting codepoints made ruleCheckCopy reject the
 * brand's own signature, which is why the guide and the gate had drifted apart.
 */
const BRAND_GLYPH = /\u{1F9E0}\u{1F4A8}/gu;

/**
 * Product / outcome efficacy claims. compliance.md section 3 permits difficulty
 * puffery about a puzzle and forbids claims about what the app does for the viewer,
 * so this deliberately keys on the OUTCOME vocabulary rather than on the presence of
 * a number: "97% get this wrong" must pass and "97% of users gain 20 IQ points" must not.
 */
const PRODUCT_EFFICACY = [
  /\b(?:users?|players?|kids|children|students?|subscribers?|customers?)\b[^.!?]{0,40}\b(?:gain|gains|raise|raises|boost|boosts|improve|improves|increase|increases|get smarter|score higher)\b/i,
  /\b(?:gain|raise|boost|improve|increase)\b[^.!?]{0,25}\b(?:iq|iq points|score|scores|memory|focus|grades|test scores|attention)\b/i,
  /\b(?:scientifically|clinically)\s+(?:proven|shown|validated|backed)\b/i,
  /\bbacked by (?:research|science|studies)\b/i,
  /\b(?:proven|guaranteed) to\s+(?:make|help|improve|boost|raise|increase)\b/i,
  /\bwatch(?:ing)? (?:daily|every day|this)\b[^.!?]{0,30}\b(?:smarter|iq|sharper|memory|focus)\b/i,
  /\b(?:get|getting|makes you|make you|makes them|become)\s+smarter\b/i,
];

export function loadBrandVoice(): BrandVoice {
  let guide = "";
  if (existsSync(CONFIG.BRAND_VOICE)) guide = readFileSync(CONFIG.BRAND_VOICE, "utf8").slice(0, 8000);

  const examples: string[] = [];
  if (existsSync(CONFIG.BRAND_EXAMPLES)) {
    try {
      const raw = JSON.parse(readFileSync(CONFIG.BRAND_EXAMPLES, "utf8"));
      // READ THE EXAMPLES, NOT THE FILE. This used to walk the whole JSON collecting
      // every string anywhere in it, then take the first 60 — which are the file's
      // HEADER: the campaign name, the acronym, a generated_at date, the audience
      // paragraph, two copies of the account handle. Of the 60 strings the judge was
      // handed, ZERO were captions. It has been grading brand voice against metadata.
      //
      // The real corpus is 262 approved examples under categories.<surface>.examples,
      // and only those are read now. `surface` and `description` are labels ABOUT the
      // examples and stay out.
      const cats = raw?.categories;
      if (cats && typeof cats === "object") {
        // Callers slice (gateCopy takes 20), so ORDER decides what actually arrives.
        // The surfaces the copy gate judges come first; the rest follow so nothing
        // approved is thrown away, it is just further down.
        const FIRST = [
          "caption", "caption-template", "hook", "signature-phrase", "endcard",
          "on-screen", "question-onscreen", "explanation-onscreen", "verdict", "cta",
        ];
        const seen = new Set<string>();
        const take = (name: string) => {
          if (seen.has(name)) return;
          seen.add(name);
          const ex = (cats as Record<string, any>)[name]?.examples;
          if (!Array.isArray(ex)) return;
          for (const e of ex) {
            // An example is `{ text, source }`, where `source` is the FILE it was
            // lifted from ("ready-to-post/01 caption.txt"). Only `text` is copy. The
            // old recursive flatten took both, so filenames were being handed to the
            // judge as examples of the brand's voice alongside the header metadata.
            const t = typeof e === "string" ? e : typeof e?.text === "string" ? e.text : null;
            if (t) examples.push(t);
          }
        };
        FIRST.forEach(take);
        Object.keys(cats).forEach(take);
      }
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

/**
 * Derive a standalone title from a caption, on a SENTENCE boundary where one exists.
 *
 * This is the fallback path only — a real title is written, not derived (design.ts
 * makeTitle). But when the model cannot be reached the derived one still has to read
 * like a finished thought, because it goes out on the video either way. The old
 * derivations cut at a character count and shipped "...99% of people mess this up 👀
 * comment" on YouTube and a bare trailing newline on TikTok.
 *
 * Order of preference: a whole sentence that fits, then a whole clause, then a whole
 * word. Hashtags, URLs and line breaks are removed first — none of them belong in a
 * title on either network.
 */
export function titleFromCaption(caption: string, max: number): string {
  const flat = String(caption ?? "")
    .split(/\r?\n/)
    .find((l) => l.trim())
    ?.replace(/\s*#[\p{L}\p{N}_]+/gu, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\s+/g, " ")
    .trim() ?? "";
  if (!flat) return "Smart Fella or Fart Smella?";
  if (flat.length <= max) return flat;

  // A whole sentence, then a whole clause, then a whole word. Each is only accepted if
  // it keeps enough of the line to still be a title rather than a fragment.
  for (const re of [/[.!?](?=\s|$)/g, /[,;:](?=\s)/g]) {
    let best = -1;
    for (const m of flat.slice(0, max + 1).matchAll(re)) best = m.index ?? best;
    if (best > max * 0.4) return flat.slice(0, best + 1).replace(/[,;:]$/, "").trim();
  }
  const cut = flat.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  return (sp > max * 0.5 ? cut.slice(0, sp) : cut).trim();
}

/** Deterministic, rule-based copy checks (the LLM gate adds judgement on top). */
export function ruleCheckCopy(text: string): { pass: boolean; violations: string[] } {
  const violations: string[] = [];
  if (/\u2014/.test(text)) violations.push("contains em dash (—)");
  if (/\u2013/.test(text)) violations.push("contains en dash (–)");
  // The logo glyph is exempt from the cap (see BRAND_GLYPH); everything else counts.
  const emojis = (text.replace(BRAND_GLYPH, "").match(/\p{Extended_Pictographic}/gu) || []).length;
  if (emojis > 1) violations.push(`too many emoji (${emojis} > 1, excluding the 🧠💨 logo)`);
  const profanity = /\b(fuck|shit|bitch|asshole|cunt|dick|pussy|nigger|faggot|retard)\b/i;
  if (profanity.test(text)) violations.push("contains hard profanity (not kid-safe)");
  if (text.length > 600) violations.push(`too long (${text.length} chars)`);
  if (/\b(as an ai|dive in|unleash|elevate|game[- ]changer|in today's world|delve)\b/i.test(text))
    violations.push("AI-slop phrasing");
  // Difficulty puffery about the puzzle is allowed; efficacy claims about the product
  // are not. compliance.md section 3.
  if (PRODUCT_EFFICACY.some((re) => re.test(text)))
    violations.push("product/outcome efficacy claim (compliance.md section 3)");
  return { pass: violations.length === 0, violations };
}
