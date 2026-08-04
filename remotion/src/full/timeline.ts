/**
 * Full-video timeline. Builds the ordered segment list (intro -> 15 x [read,
 * countdown, reveal] -> score -> outro) with exact frame offsets derived from
 * the EXISTING narration durations + the Python pacing (LEAD/TRAIL, countdown +
 * "time's up" tail). Also emits every audio event (narration, tick beds, reveal
 * dings) and the VO / countdown windows that drive the music duck + swell and
 * the fanfare->parade->winner arc.
 *
 * Platform-aware: the OUTRO clip (VO + captions + duration) depends on the
 * target platform - YouTube uses the "subscribe" variant, IG/TikTok the "follow"
 * (note "youtube" names the NETWORK here; whether a cut is a Short or the 16:9
 * master is Variant.isShort, not the platform - see Variant"
 * variant - so the whole timeline (and total length) is computed per platform.
 */
import { QUESTIONS } from "../data/questions";
import type { Question } from "../data/types";
import DURS from "../data/durations.json";

// Per-beat narration durations (s), regenerated together with the clips — the
// authoritative source for timing. Keyed "intro","q1".."q15","r1".."r15",
// "timesup","score","outro-youtube","outro-follow".
const D = DURS as Record<string, number>;

export const FPS = 30;
export const LEAD = 0.35;
export const TRAIL = 0.8;
export const frames = (s: number): number => Math.round(s * FPS);
export const LEAD_FRAMES = frames(LEAD);

export type Platform = "youtube" | "instagram" | "tiktok";
/** Outro VO/caption clip key for a platform (YouTube -> description; else bio). */
export const outroClipKey = (p: Platform): "outro-youtube" | "outro-follow" =>
  p === "youtube" ? "outro-youtube" : "outro-follow";

/**
 * No-answer end-card VO key for a platform.
 *
 * This was ONE clip for all three networks, which was right while the line was
 * "comment below" — a comment box exists everywhere. The line now sends people to the
 * site, and the pointer to it does NOT travel: Instagram and TikTok have a bio link,
 * YouTube has a description and no bio at all. A viewer told to check a bio that does
 * not exist simply does not convert, so YouTube gets its own clip here exactly as it
 * already does for `outro-youtube`.
 */
export const noanswerClipKey = (p: Platform): "outro-noanswer-youtube" | "outro-noanswer" =>
  p === "youtube" ? "outro-noanswer-youtube" : "outro-noanswer";

export type Segment =
  | { type: "intro"; start: number; dur: number }
  | { type: "hook"; start: number; dur: number }
  | { type: "read"; q: Question; pos: number; start: number; dur: number }
  | { type: "countdown"; q: Question; pos: number; start: number; dur: number }
  | { type: "reveal"; q: Question; pos: number; start: number; dur: number }
  | { type: "score"; start: number; dur: number }
  | { type: "outro"; start: number; dur: number };

export type AudioEvent = { src: string; from: number; durationInFrames?: number };
export type SfxEvent = { src: string; from: number; vol: number };

/**
 * A per-cut SFX set (paths under public/audio/sfx/). When supplied (the shorts,
 * for a distinct sound per short) one whoosh covers all transition types and one
 * sting covers score+outro; when omitted (the YouTube cuts) the shared per-type
 * defaults are used, so the 16:9 masters are unchanged.
 */
export type SfxSet = { whoosh: string; ding: string; sting: string };

/** SFX mix levels, applied to the -6 dBFS-normalized SFX. They play mostly in
 *  VO-silence gaps (segment TRAIL/LEAD), so they sit above the music bed and
 *  under the VO peaks. */
const SFX_VOL = { whoosh: 0.55, ding: 0.7, sting: 0.62 };
const SFX_LEADIN = frames(0.25); // a transition whoosh starts this far before the boundary

const countdownFrames = (q: Question, durs: Record<string, number>): number =>
  Math.max(frames(q.countdown + 1), frames(q.countdown + durs.timesup + 0.3));

/**
 * A/B-test variant toggles (prop-driven; the committed masters/shorts omit them
 * and behave exactly as before). Purely additive on top of the shared timeline:
 *  - `readVO`  which question VO plays while the question is on screen — "full"
 *              (the combined q clip, default), "options" only (drop the question
 *              text VO), "stem" only (drop the options VO), or "none" (silent;
 *              the question still DISPLAYS for a short read + its 5s countdown).
 *              The split clips are qs<id>.mp3 (stem) / qo<id>.mp3 (options).
 *  - `dropReveal`  answer-reveal control: `false` reveals every question (default),
 *              `true` omits every reveal (NO-ANSWER), `"last"` reveals all but the
 *              final question (CLIFFHANGER — end on the CTA before the last answer).
 *              A dropped reveal omits its segment + r<id> VO + ding.
 *  - `dropScore`   omit the score screen (segment + score VO).
 *  - `endCard`     which end card + end VO: "default" (platform outro), "noanswer"
 *                  (comment-for-the-answer CTA), or "verdict" (smart-fella payoff).
 *  - `metaBase`    dir for the round-agnostic meta clips (timesup/score/outro/…).
 *                  Defaults to the committed audio/narration/; the SPEED test
 *                  points it at a per-video atempo'd copy so the meta VO is sped too.
 */
export type ReadVO = "full" | "options" | "stem" | "none";
export type EndCard = "default" | "noanswer" | "verdict";
/** Reveal control: false=reveal all, true=reveal none, "last"=reveal all but the last. */
export type DropReveal = boolean | "last";
/**
 * Opening arm (the 3-second skip-rate experiment; shorts only).
 *   "cold-plate"  the control: frame one is the static question plate, exactly as today.
 *   "motion-hook" prepends the wordless Hook scene so nothing has to be READ until the
 *                 plate arrives ~2.2s in.
 * The two arms differ in NOTHING ELSE — same questions, same countdown, same reveals,
 * same score, same outro, same VO, same music — so a skip-rate difference is
 * attributable to the opening alone.
 */
export type Opening = "cold-plate" | "motion-hook";
export type Variant = {
  readVO?: ReadVO;
  dropReveal?: DropReveal;
  dropScore?: boolean;
  endCard?: EndCard;
  metaBase?: string;
  opening?: Opening;
  /**
   * HOOK COPY carried BY the motion opening, when this is a spoken-hook arm.
   * The title replaces the wordless "?" inside the Hook scene and the line is spoken
   * OVER the animation, so the curiosity payload is free: the segment stays exactly
   * HOOK_SECONDS and question one does not move. Omitted => the wordless arm, byte for
   * byte as before.
   */
  hook?: { title: string; subtitle?: string };
  /**
   * Is this a SHORT (tight pacing, cold open) rather than the long-form master?
   *
   * This used to be inferred as `platform !== "youtube"`, which was true only while
   * "youtube" meant exactly one thing: the 16:9 long-form master. It now also means
   * YouTube SHORTS, and those two want opposite pacing — the master opens on a branded
   * intro and runs on the slower LEAD/TRAIL, a Short cold-opens and runs tight. Left to
   * the platform name, a YouTube Short would have been built as a master: it would look
   * for D.intro, which a short's duration map does not contain, and every downstream
   * `from` would go NaN.
   *
   * So the caller states it. FullVideo derives it from the COMPOSITION ASPECT, which is
   * the honest signal — the Short composition is 1080x1920 and the master is 1920x1080.
   * Omitted => the original platform-based inference, so every script that calls
   * getTimeline directly (build-cuts, gen-subs) is unchanged.
   */
  isShort?: boolean;
};
/** Hook length in seconds; mirrored by scenes/Hook.tsx HOOK_SECONDS. */
export const HOOK_SECONDS = 2.2;
/** Silent-read hold (frames) for readVO="none": the question flashes on screen
 *  before its 5s countdown so a viewer can register it with no VO to pace them. */
const SILENT_READ = frames(1.5);
/** End-card VO/duration key for a variant (default -> the platform outro clip). */
const endCardKey = (endCard: EndCard, platform: Platform): string =>
  endCard === "noanswer" ? noanswerClipKey(platform) : endCard === "verdict" ? "verdict" : outroClipKey(platform);

export type TimelineData = {
  platform: Platform;
  questions: Question[];
  segments: Segment[];
  narration: AudioEvent[];
  ticks: AudioEvent[];
  sfx: SfxEvent[];
  voWindows: [number, number][];
  swellWindows: [number, number][];
  total: number;
};

/** All 15 question ids, in order — the default subset (the full master). */
export const ALL_IDS = QUESTIONS.map((q) => q.idx);

/** Resolve a subset of question ids (in the given order) to Question objects. */
const resolve = (ids: number[], src: Question[] = QUESTIONS): Question[] =>
  ids.map((id) => src.find((q) => q.idx === id)).filter((q): q is Question => Boolean(q));

/**
 * Build a cut's timeline. For the committed master, `questionsSrc`/`durs`/`qrBase`
 * default to the module data (data/questions.ts + data/durations.json + the shared
 * audio/narration/ dir). To render a DIFFERENT generated round, the batch pipeline
 * passes that round's Question[] + measured duration map + a per-round narration
 * base (e.g. "audio/rounds/round-002/") via props; the META beats (intro/timesup/
 * score/outro) always come from the shared audio/narration/ dir since they are
 * round-agnostic. Purely additive: omit the extras and behavior is unchanged.
 */
function build(
  platform: Platform,
  ids: number[],
  sfxSet?: SfxSet,
  questionsSrc: Question[] = QUESTIONS,
  durs: Record<string, number> = DURS as Record<string, number>,
  qrBase = "audio/narration/",
  variant: Variant = {},
): TimelineData {
  const { readVO = "full", dropReveal = false, dropScore = false, endCard = "default", metaBase = "audio/narration/", opening = "cold-plate", hook } = variant;
  const D = durs;
  const questions = resolve(ids, questionsSrc);
  const segments: Segment[] = [];
  const narration: AudioEvent[] = [];
  const ticks: AudioEvent[] = [];
  const voWindows: [number, number][] = [];
  const swellWindows: [number, number][] = []; // countdown (timer ticking, no VO) -> music swells
  let cur = 0;

  // Shorts run tighter + FASTER than the 16:9 master: smaller LEAD/TRAIL gaps and NO
  // long intro, so the first question (the hook) lands in the first ~1s (people scroll
  // ~4s). The 16:9 master cut is unchanged.
  //
  // `variant.isShort` wins when supplied because the PLATFORM no longer determines this:
  // "youtube" now covers both the long-form master AND Shorts. The fallback is the
  // original inference, so callers that predate this behave exactly as before.
  const isShort = variant.isShort ?? platform !== "youtube";
  const lead = isShort ? 0.12 : LEAD;
  const trail = isShort ? 0.4 : TRAIL;
  const leadFrames = frames(lead);

  // Shorts are PERMANENTLY cold-open (no branded intro): the A/B test chose no-intro,
  // so the withIntro option was retired and a short can never render with an intro.
  // YouTube 16:9 long-form keeps its title intro; the standalone brand-intro promo
  // (IntroBrand / sffs-brand-intro-v1) is a separate composition and is unaffected.
  if (!isShort) {
    const introDur = frames(lead + D.intro + trail);
    segments.push({ type: "intro", start: cur, dur: introDur });
    narration.push({ src: `${metaBase}intro.mp3`, from: cur + leadFrames });
    voWindows.push([cur + leadFrames, cur + leadFrames + frames(D.intro)]);
    cur += introDur;
  }

  // OPENING ARM. The wordless hook, when this is the motion-hook arm. It carries no
  // narration on purpose: adding VO would change what the two arms differ by, and the
  // whole claim is that the opening is the only difference. Music runs unducked here,
  // which is exactly the energy the beat wants.
  if (isShort && opening === "motion-hook") {
    const hookDur = frames(HOOK_SECONDS);
    segments.push({ type: "hook", start: cur, dur: hookDur });
    // A spoken hook rides OVER the animation instead of in front of it. The segment
    // length is unchanged, so this arm costs the viewer nothing beyond the animation
    // that was already there -- which is the entire point: the motion arm lost to the
    // cold plate by 5.6pp on skip rate while spending 2.2s carrying no information.
    //
    // The VO must FIT. If it does not, the clip is dropped rather than allowed to run
    // long, because bleeding into the question read would both collide with the question
    // VO and reintroduce the serial delay this design exists to remove. buildDurs
    // refuses over-budget lines up front, so this is the belt to that braces.
    const hookVo = D.hook ?? 0;
    if (hookVo > 0 && lead + hookVo <= HOOK_SECONDS) {
      narration.push({ src: `${qrBase}hook.mp3`, from: cur + leadFrames });
      // Registering the VO window is what ducks the music bed under the voice, exactly
      // as it does for every question read. Without it the bed would run at full swell
      // over the line (the wordless arm wants that; a spoken one very much does not).
      voWindows.push([cur + leadFrames, cur + leadFrames + frames(hookVo)]);
    }
    cur += hookDur;
  }

  // Which question VO (if any) plays over the read segment, per the A/B `readVO`
  // mode. "none" keeps a short SILENT_READ hold so the question still displays.
  const readClip = (id: number): { src: string; dur: number } | null => {
    if (readVO === "options") return { src: `${qrBase}qo${id}.mp3`, dur: D[`qo${id}`] };
    if (readVO === "stem") return { src: `${qrBase}qs${id}.mp3`, dur: D[`qs${id}`] };
    if (readVO === "none") return null;
    return { src: `${qrBase}q${id}.mp3`, dur: D[`q${id}`] };
  };

  questions.forEach((q, qi) => {
    const pos = qi + 1; // 1-based position within THIS cut ("QUESTION pos OF N")
    const rc = readClip(q.idx);
    const readDur = rc ? frames(lead + rc.dur + trail) : SILENT_READ;
    segments.push({ type: "read", q, pos, start: cur, dur: readDur });
    if (rc) {
      narration.push({ src: rc.src, from: cur + leadFrames });
      voWindows.push([cur + leadFrames, cur + leadFrames + frames(rc.dur)]);
    }
    cur += readDur;

    const cdDur = countdownFrames(q, D);
    segments.push({ type: "countdown", q, pos, start: cur, dur: cdDur });
    ticks.push({ src: "audio/sfx/tick.wav", from: cur, durationInFrames: frames(q.countdown) });
    swellWindows.push([cur, cur + frames(q.countdown)]); // swell across the tick, before "time's up"
    narration.push({ src: `${metaBase}timesup.mp3`, from: cur + frames(q.countdown) });
    voWindows.push([cur + frames(q.countdown), cur + frames(q.countdown) + frames(D.timesup)]);
    cur += cdDur;

    // Per-question reveal: drop all (true), drop only the final one ("last",
    // the cliffhanger), or keep every reveal (false/default).
    const isLastQ = qi === questions.length - 1;
    const revealThis = dropReveal === "last" ? !isLastQ : !dropReveal;
    if (revealThis) {
      const rDur = frames(lead + D[`r${q.idx}`] + trail);
      segments.push({ type: "reveal", q, pos, start: cur, dur: rDur });
      narration.push({ src: `${qrBase}r${q.idx}.mp3`, from: cur + leadFrames });
      voWindows.push([cur + leadFrames, cur + leadFrames + frames(D[`r${q.idx}`])]);
      cur += rDur;
    }
  });

  if (!dropScore) {
    const scoreDur = frames(lead + D.score + trail);
    segments.push({ type: "score", start: cur, dur: scoreDur });
    narration.push({ src: `${metaBase}score.mp3`, from: cur + leadFrames });
    voWindows.push([cur + leadFrames, cur + leadFrames + frames(D.score)]);
    cur += scoreDur;
  }

  const endKey = endCardKey(endCard, platform);
  const outroDur = frames(lead + D[endKey] + trail);
  segments.push({ type: "outro", start: cur, dur: outroDur });
  narration.push({ src: `${metaBase}${endKey}.mp3`, from: cur + leadFrames });
  voWindows.push([cur + leadFrames, cur + leadFrames + frames(D[endKey])]);
  cur += outroDur;

  // --- SFX: transition whooshes + stings + a correct-answer ding per reveal ---
  // A cut may supply its own SfxSet (the shorts); otherwise the shared per-type
  // defaults are used (the YouTube cuts, unchanged).
  const wEnter = sfxSet ? sfxSet.whoosh : "sfx-whoosh-enter.mp3";
  const wReveal = sfxSet ? sfxSet.whoosh : "sfx-whoosh-reveal.mp3";
  const wAdvance = sfxSet ? sfxSet.whoosh : "sfx-whoosh-advance.mp3";
  const stScore = sfxSet ? sfxSet.sting : "sfx-sting-score.mp3";
  const stOutro = sfxSet ? sfxSet.sting : "sfx-sting-outro.mp3";
  const dingFile = sfxSet ? sfxSet.ding : "sfx-reveal-ding.mp3";
  const sfx: SfxEvent[] = [];
  const addSfx = (src: string, from: number, vol: number) =>
    sfx.push({ src: `audio/sfx/${src}`, from: Math.max(0, from), vol });
  for (let i = 1; i < segments.length; i++) {
    const prev = segments[i - 1].type;
    const t = segments[i].type;
    const b = segments[i].start;
    if (prev === "intro" && t === "read") addSfx(wEnter, b - SFX_LEADIN, SFX_VOL.whoosh); // intro -> Q1
    else if (t === "reveal") addSfx(wReveal, b - SFX_LEADIN, SFX_VOL.whoosh); // question -> reveal
    else if (prev === "reveal" && t === "read") addSfx(wAdvance, b - SFX_LEADIN, SFX_VOL.whoosh); // reveal -> next question
    else if (prev === "countdown" && t === "read") addSfx(wAdvance, b - SFX_LEADIN, SFX_VOL.whoosh); // no-reveal (NO-ANSWER) flow: countdown -> next question
    else if (t === "score") addSfx(stScore, b - SFX_LEADIN, SFX_VOL.sting); // last reveal -> score
    else if (t === "outro") addSfx(stOutro, b - SFX_LEADIN, SFX_VOL.sting); // score -> outro
  }
  for (const seg of segments) {
    if (seg.type === "reveal") addSfx(dingFile, seg.start + frames(0.12), SFX_VOL.ding);
  }

  return { platform, questions, segments, narration, ticks, sfx, voWindows, swellWindows, total: cur };
}

const CACHE = new Map<string, TimelineData>();
/**
 * Per-cut timeline (cached by platform + question subset + sfx set + round). The
 * default is the committed full-15 YouTube master. Pass a subset of ids (the
 * curated 10 or a short's 3), an optional per-cut SfxSet, and — for a generated
 * round other than the committed master — that round's Question[] + duration map
 * + per-round narration base (qrBase). The cache key includes qrBase so distinct
 * rounds never collide.
 */
export const getTimeline = (
  platform: Platform = "youtube",
  ids: number[] = ALL_IDS,
  sfxSet?: SfxSet,
  questionsSrc?: Question[],
  durs?: Record<string, number>,
  qrBase?: string,
  variant: Variant = {},
): TimelineData => {
  const drKey = variant.dropReveal === "last" ? "drL" : variant.dropReveal ? "dr" : "";
  // isShort is IN the key: without it the Short and the 16:9 master would collide on
  // one cache entry and the second render would silently reuse the first one's pacing.
  // `opening` was missing from this key, which is a latent cache collision: two cuts
  // with identical questions/durs but different opening arms would have been served the
  // same timeline. It has been invisible so far only because the two arms never render
  // in one process. The spoken-hook arms make that a real risk, so both the arm and the
  // hook copy are keyed now.
  const hookKey = variant.hook ? `${variant.hook.title}\u0001${variant.hook.subtitle ?? ""}` : "";
  const vKey = `${variant.readVO ?? "full"}|${drKey}|${variant.dropScore ? "ds" : ""}|${variant.endCard ?? "default"}|${variant.metaBase ?? "def"}|${variant.isShort === undefined ? "auto" : variant.isShort ? "short" : "long"}|${variant.opening ?? "cold-plate"}|${hookKey}`;
  const key = `${platform}:${ids.join(",")}:${sfxSet ? `${sfxSet.whoosh}|${sfxSet.ding}|${sfxSet.sting}` : "def"}:${qrBase ?? "def"}:${vKey}`;
  let t = CACHE.get(key);
  if (!t) {
    t = build(platform, ids, sfxSet, questionsSrc, durs, qrBase, variant);
    CACHE.set(key, t);
  }
  return t;
};

export const TIMELINE = getTimeline("youtube");
export const TOTAL = TIMELINE.total;

// --- Music: dynamic envelope (swell on countdowns, duck under VO) + arc -------
// Levels are the shared duck/swell curve; each bed also gets its crossfade * GAIN
// (parade is x0.75). With the parade gain the effective music sits ~11-12 dB
// under the VO at DUCKED (present bed, not near-silent) and near-full at SWELL.
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
// Two-level, VO-keyed envelope: the music is a CONTINUOUS bed that swells to a
// full non-VO ceiling in EVERY no-one-talking gap (countdown, transitions,
// intro/outro/reveal beats) and ducks to a present, clearly-audible bed whenever
// narration is speaking. Smooth ramps between the two (no pops).
const DUCKED = 0.38; // under VO: present bed, ~-8 dB under the swell (VO stays clearly on top)
const SWELL = 0.9; // every VO-silence gap lifts to this full/non-VO ceiling
const RAMP = 8; // frames attack/release for the duck <-> swell ramp (~0.27s)
const SWELL_RAMP = 12; // frames ramp for the (still-exported) countdown swell gate

export const duckGate = (frame: number, T: TimelineData = TIMELINE): number => {
  let g = 0;
  for (const [s, e] of T.voWindows) {
    g = Math.max(g, Math.min(clamp01((frame - s) / RAMP), clamp01((e + RAMP - frame) / RAMP)));
  }
  return g;
};

/** Countdown swell gate: ramps 0->1 as the timer starts ticking and 1->0 just
 *  before "time's up", so the swell lives entirely in the VO-free countdown. */
export const swellGate = (frame: number, T: TimelineData = TIMELINE): number => {
  let g = 0;
  for (const [s, e] of T.swellWindows) {
    g = Math.max(g, Math.min(clamp01((frame - s) / SWELL_RAMP), clamp01((e - frame) / SWELL_RAMP)));
  }
  return g;
};

/** Music level: full SWELL in every VO-silence gap, ducked to DUCKED while any
 *  narration is speaking, with smooth ramps between (keyed only to the VO
 *  windows, so the swell now applies to ALL gaps, not just the countdown). */
export const musicLevel = (frame: number, T: TimelineData = TIMELINE): number =>
  SWELL + (DUCKED - SWELL) * duckGate(frame, T);

const FAN_LEN = 13;
const XF = 1.5;
const WIN_LEN = 15;
const FADE = 1.5;
export const GAIN = { fanfare: 1.0, parade: 0.75, winner: 0.89 };
export const winStartFrame = (T: TimelineData = TIMELINE): number => T.total - frames(WIN_LEN);

const rampUp = (f: number, aS: number, bS: number) => clamp01((f - frames(aS)) / (frames(bS) - frames(aS)));
const rampDown = (f: number, aS: number, bS: number) => 1 - rampUp(f, aS, bS);

/** Bed crossfade envelopes (global frame). */
export const fanfareBed = (f: number): number => rampUp(f, 0, FADE) * rampDown(f, FAN_LEN - XF, FAN_LEN);
export const paradeBed = (f: number, T: TimelineData = TIMELINE): number => {
  const winStartS = winStartFrame(T) / FPS;
  return rampUp(f, FAN_LEN - XF, FAN_LEN) * rampDown(f, winStartS, winStartS + XF);
};

/** Winner plays inside a Sequence starting at winStartFrame, so it receives a
 *  sequence-LOCAL frame; convert to global for the duck. */
export const winnerVolume = (local: number, T: TimelineData = TIMELINE): number => {
  const global = winStartFrame(T) + local;
  const fade = clamp01(local / frames(FADE)) * (1 - clamp01((local - frames(WIN_LEN - FADE)) / frames(FADE)));
  return musicLevel(global, T) * fade * GAIN.winner;
};

/**
 * Single-track short music: one looped bed under the whole cut with the SAME
 * duck/swell envelope (musicLevel) + parade gain as the arc, plus gentle fades
 * in/out so the loop start/end aren't abrupt. Used by the shorts (each gets a
 * distinct track); the YouTube cuts keep the fanfare->parade->winner arc.
 */
const SHORT_FADE_IN = frames(0.6);
const SHORT_FADE_OUT = frames(1.2);
export const shortMusicVolume = (frame: number, T: TimelineData = TIMELINE): number => {
  const fin = clamp01(frame / SHORT_FADE_IN);
  const fout = clamp01((T.total - frame) / SHORT_FADE_OUT);
  return musicLevel(frame, T) * GAIN.parade * fin * fout;
};
