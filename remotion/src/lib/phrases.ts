/**
 * Caption phrase builders. Reuses the per-word forced-alignment timings in
 * captions.json (NO re-align).
 *   - buildPhrases: FULL transcript (every clip, every word) -> phrase cues for
 *     the .srt/.vtt sidecar (the toggleable CC track).
 *   - buildSmartPhrases: the burned-in SPOKEN-ONLY subset -> only narration that
 *     is NOT already printed on screen (per the approved audit), located by exact
 *     text match against the aligned words.
 * Both share chunkWords (grouping) + finalizeWindows (display timing).
 */
import CAPS_DATA from "../data/captions.json";
import { FPS, type TimelineData } from "../full/timeline";

type WordT = { w: string; s: number; e: number };
const CAPS = CAPS_DATA as Record<string, { text: string; words: WordT[] }>;

export type Phrase = { s: number; e: number; text: string }; // absolute DISPLAY window, FRAMES

const MAX_WORDS = 6;
const MAX_CHARS = 30;
const MIN_WORDS_BREAK = 3; // only honor a punctuation break once the phrase has this many words
const MIN_ON = Math.round(0.7 * FPS); // never flash a phrase shorter than this
const MAX_HOLD = Math.round(0.5 * FPS); // linger this long after the last word before fading
const PUNCT = /[.,?!;:]$/;

/** Group a word list into short, readable phrase groups (with orphan-merge). */
export function chunkWords(words: WordT[]): WordT[][] {
  const groups: WordT[][] = [];
  let group: WordT[] = [];
  const flush = () => {
    if (group.length) groups.push(group);
    group = [];
  };
  for (const w of words) {
    group.push(w);
    const chars = group.reduce((a, g) => a + g.w.length + 1, -1);
    const hard = group.length >= MAX_WORDS || chars >= MAX_CHARS;
    const natural = PUNCT.test(w.w) && group.length >= MIN_WORDS_BREAK;
    if (hard || natural) flush();
  }
  flush();
  // no lone trailing single-word group: merge it back into the previous one
  if (groups.length >= 2 && groups[groups.length - 1].length === 1) {
    const last = groups.pop()!;
    groups[groups.length - 1].push(...last);
  }
  return groups;
}

/** Turn raw {s,e,text} (frames, sorted) into display windows: linger after the
 *  last word, enforce a minimum, and never run into the next phrase. */
function finalizeWindows(raw: { s: number; e: number; text: string }[]): Phrase[] {
  raw.sort((a, b) => a.s - b.s);
  const out: Phrase[] = [];
  for (let i = 0; i < raw.length; i++) {
    const p = raw[i];
    const next = raw[i + 1];
    let e = p.e + MAX_HOLD;
    if (e - p.s < MIN_ON) e = p.s + MIN_ON;
    if (next) e = Math.min(e, next.s);
    if (e < p.e) e = p.e;
    out.push({ s: p.s, e, text: p.text });
  }
  return out;
}

const clipKey = (src: string) => src.split("/").pop()!.replace(/\.mp3$/, "");
const group2raw = (g: WordT[], off: number) => ({
  s: off + Math.round(g[0].s * FPS),
  e: off + Math.round(g[g.length - 1].e * FPS),
  text: g.map((x) => x.w).join(" "),
});

/** FULL transcript (all clips) -> phrase cues for the sidecar. */
export function buildPhrases(timeline: TimelineData): Phrase[] {
  const raw: { s: number; e: number; text: string }[] = [];
  for (const n of timeline.narration) {
    const c = CAPS[clipKey(n.src)];
    if (!c || !c.words.length) continue;
    for (const g of chunkWords(c.words)) raw.push(group2raw(g, n.from));
  }
  return finalizeWindows(raw);
}

// --- Smart (spoken-only) subset -------------------------------------------------
type Sel = { target: string; display?: string };

/** SPOKEN-ONLY narration to burn in (NOT already printed on screen). Located by
 *  exact text match against the aligned words. Everything else (prompts, options,
 *  printed framing "Question N / category / N seconds", reveals, outro) is skipped. */
const SPOKEN_ONLY: Record<string, Sel[]> = {
  intro: [{ target: "Let's find OUT!" }],
  // Q3/Q11/Q13: the verbal walkthrough of the visual (highest-value spoken-only)
  q3: [{ target: "An empty circle becomes a filled-in circle. So an empty square becomes... which one?" }],
  q11: [{ target: "Watch them grow, gaining one side each step: a triangle, then a square, then a pentagon." }],
  q13: [{ target: "A dot marches clockwise around a square: top-left, top-right, bottom-right..." }],
  // genuine non-printed personality only (skip "Question N", category, "N seconds")
  q7: [{ target: "and this one is tricky!" }],
  q15: [{ target: "Last one, question fifteen, a number puzzle, and it's sneaky!", display: "Last one, and it's sneaky!" }],
  // played at the end of EVERY countdown; fully spoken-only
  timesup: [{ target: "TIME'S UP! Pencils down!" }],
  // score: host commentary only (skip the printed ranges + the pill opener)
  score: [
    { target: "Take a bow, you are a certified smart fella!" },
    { target: "You're one seriously sharp cookie." },
    { target: "Hey, every champion starts out a certified fart smella!" },
  ],
};

// Split on WHITESPACE only, then strip intra-word punctuation per token, so the
// tokenization matches the per-word normalization ("filled-in"->"filledin",
// "Let's"->"lets"). Splitting on punctuation here would desync the two.
const normTokens = (s: string) =>
  s
    .trim()
    .split(/\s+/)
    .map((x) => x.toLowerCase().replace(/[^a-z0-9]/g, ""))
    .filter(Boolean);

/** Find the first contiguous run of words whose normalized text equals target. */
function locate(words: WordT[], target: string): [number, number] | null {
  const t = normTokens(target);
  const w = words.map((x) => x.w.toLowerCase().replace(/[^a-z0-9]/g, ""));
  for (let i = 0; i + t.length <= w.length; i++) {
    let ok = true;
    for (let j = 0; j < t.length; j++) if (w[i + j] !== t[j]) { ok = false; break; }
    if (ok) return [i, i + t.length - 1];
  }
  return null;
}

/** Burned-in SPOKEN-ONLY subset -> phrases (absolute frames), for the overlay. */
export function buildSmartPhrases(timeline: TimelineData): Phrase[] {
  const raw: { s: number; e: number; text: string }[] = [];
  for (const n of timeline.narration) {
    const key = clipKey(n.src);
    const sels = SPOKEN_ONLY[key];
    const c = CAPS[key];
    if (!sels || !c) continue;
    for (const sel of sels) {
      const run = locate(c.words, sel.target);
      if (!run) continue;
      const sub = c.words.slice(run[0], run[1] + 1);
      if (sel.display) {
        raw.push({ s: n.from + Math.round(sub[0].s * FPS), e: n.from + Math.round(sub[sub.length - 1].e * FPS), text: sel.display });
      } else {
        for (const g of chunkWords(sub)) raw.push(group2raw(g, n.from));
      }
    }
  }
  return finalizeWindows(raw);
}

/** Clip keys that carry a burned-in caption (for per-plate placement). */
export const CAPTIONED_CLIPS = new Set(Object.keys(SPOKEN_ONLY));
