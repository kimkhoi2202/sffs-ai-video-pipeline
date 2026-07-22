/**
 * HermesQuiz — a SELF-CONTAINED 9:16 quiz short for the autonomous Hermes loop.
 *
 * WHY THIS EXISTS (and how it differs from the production render):
 *   The full production renderer (remotion/scripts/render-ab.ts) makes gorgeous
 *   shorts but depends on cloned-voice TTS (voice/tts_batch.py), per-round SFX
 *   assets, Rhubarb lip-sync (macOS-only), and ffmpeg atempo passes — heavy and
 *   fragile on a fresh headless Linux box. This composition is the opposite: it
 *   renders from ONLY committed assets (Google Fonts + one committed music track),
 *   no external TTS, no SFX deps, no native binaries — so the always-on loop can
 *   reliably produce a real, on-brand quiz short (DRAFT media) every cycle.
 *
 *   It is PROP-DRIVEN so the loop can rotate real A/B dimensions per video:
 *     - showProgress / progressStyle : the "QUESTION 1 OF 3" retention test
 *     - reveal: "all" | "none" | "last" : answer-reveal vs no-answer vs cliffhanger
 *     - countdownSec : tempo test (e.g. 3 vs 5 vs 7 seconds)
 *     - questions : number (one-question vs three) + category mix
 *     - title / subtitle / outro : hook / opener style
 *
 *   Covers the two headless-safe master-bank kinds: "text" (verbal odd-one-out /
 *   analogies) and "numseries" (number series). Duration is derived from props.
 */
import React from "react";
import {
  AbsoluteFill,
  Audio,
  Sequence,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { loadFont as loadAnton } from "@remotion/google-fonts/Anton";
import { loadFont as loadDMSans } from "@remotion/google-fonts/DMSans";

const { fontFamily: ANTON } = loadAnton("normal", { weights: ["400"], subsets: ["latin"] });
const { fontFamily: DM } = loadDMSans("normal", { weights: ["400", "500", "700", "800"], subsets: ["latin"] });
const DISPLAY = `${ANTON}, Impact, sans-serif`;
const BODY = `${DM}, Arial, sans-serif`;

// ── Brand palette (mirrors remotion/src/theme/brand.ts) ──
const C = {
  ink: "#000000",
  paper: "#ffffff",
  blue: "#839aff",
  mint: "#c6fcd0",
  coral: "#fd7962",
  yellow: "#fce552",
  cream: "#f6f4ee",
  green: "#63c088",
} as const;
const PALETTE = [C.blue, C.mint, C.coral, C.yellow] as const;

export const FPS = 30;
const INTRO = 60;
const OUTRO = 75;
const REVEAL = 45; // frames held on the answer reveal
const HOLD = 18; // frames held after countdown when NOT revealing (no-answer)
const READ_TAIL = 12; // frames of breathing room after VO before the countdown starts
// ^ MUST match hermes/src/narration.ts READ_TAIL (the loop derives frames the same way).

export type RevealMode = "all" | "none" | "last";

export type HermesQuestion = {
  kind: "text" | "numseries";
  tier: string;
  prompt: string;
  options?: string[];
  seq?: string[];
  answer: string;
};

// ── Narration (cloned-voice question/options VO) ──────────────────────────────
// The loop's render step fills `clips` (via hermes/src/narration.ts -> tts_batch.py)
// before render; the composition just plays each clip and sizes the read window to
// its measured duration. `mode` is the A/B arm; `clips` empty => music-only.
export type NarrationMode = "full" | "none" | "no-question-vo" | "no-options-vo";
export type NarrationClip = {
  index: number; // question index (0-based)
  src: string; // staticFile path under remotion/public
  durSec: number; // measured VO duration
  kind: "full" | "stem" | "options";
};
export type Narration = { mode: NarrationMode; voiceId?: string; clips: NarrationClip[] };

export type HermesQuizProps = {
  title: string;
  subtitle: string;
  outro: string;
  music: string;
  questions: HermesQuestion[];
  showProgress: boolean;
  progressStyle: "short" | "full"; // "Q1" vs "QUESTION 1 OF 3"
  reveal: RevealMode;
  countdownSec: number;
  narration?: Narration;
};

// Preview defaults mirror the loop's CONTENT defaults (see hermes/src/defaults.ts):
// full narration + cliffhanger ending (reveal="last"; the last verdict is withheld
// with a comment-CTA). clips[] are empty here so Studio preview is music-only; the
// loop fills clips at render for the narrated arms.
export const DEFAULT_PROPS: HermesQuizProps = {
  title: "SMART or FART?",
  subtitle: "how many can you get?",
  outro: "comment your answer \uD83D\uDC47  follow for more",
  music: "audio/music/gameshow-fanfare.mp3",
  showProgress: true,
  progressStyle: "short",
  reveal: "last",
  countdownSec: 5,
  narration: { mode: "full", clips: [] },
  questions: [
    { kind: "text", tier: "ODD ONE OUT", prompt: "which one does not belong?", options: ["apple", "banana", "carrot", "grape"], answer: "carrot" },
    { kind: "numseries", tier: "NUMBER SERIES", prompt: "what comes next?", seq: ["5", "10", "15", "20"], answer: "25" },
    { kind: "text", tier: "VERBAL ANALOGY", prompt: "hot is to cold as day is to __", options: ["light", "morning", "night", "sun"], answer: "night" },
  ],
};

const willReveal = (p: HermesQuizProps, i: number): boolean => {
  if (p.reveal === "all") return true;
  if (p.reveal === "none") return false;
  return i === p.questions.length - 1 ? false : true; // "last" = cliffhanger: reveal all but the last
};

/** The VO clip for question i (if any). */
const clipFor = (p: HermesQuizProps, i: number): NarrationClip | undefined =>
  p.narration?.clips?.find((c) => c.index === i);

/** Frames of the spoken read window before the countdown (0 = no VO / music-only).
 *  MUST match hermes/src/narration.ts readFramesFor (loop + render agree on frames). */
const readFrames = (p: HermesQuizProps, i: number): number => {
  const c = clipFor(p, i);
  return c && c.durSec > 0 ? Math.round(c.durSec * FPS) + READ_TAIL : 0;
};

const qFrames = (p: HermesQuizProps, i: number): number =>
  readFrames(p, i) + Math.round(p.countdownSec * FPS) + (willReveal(p, i) ? REVEAL : HOLD);

export function computeDuration(p: HermesQuizProps): number {
  const n = Math.max(1, p.questions?.length ?? 0);
  let sum = INTRO + OUTRO;
  for (let i = 0; i < n; i++) sum += qFrames(p, i);
  return sum;
}

const offsets = (p: HermesQuizProps): number[] => {
  const out: number[] = [];
  let acc = INTRO;
  for (let i = 0; i < p.questions.length; i++) {
    out.push(acc);
    acc += qFrames(p, i);
  }
  return out;
};

const HARD = (o = 10, color = C.ink): string => `${o}px ${o}px 0 0 ${color}`;

const pop = (delay: number) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return spring({ frame: frame - delay, fps, config: { damping: 12, mass: 0.6 } });
};

const Pill: React.FC<{ children: React.ReactNode; bg: string; delay?: number }> = ({ children, bg, delay = 0 }) => {
  const s = pop(delay);
  return (
    <div
      style={{
        transform: `scale(${interpolate(s, [0, 1], [0.6, 1])})`,
        alignSelf: "flex-start",
        background: bg,
        color: C.ink,
        border: `6px solid ${C.ink}`,
        boxShadow: HARD(8),
        borderRadius: 20,
        padding: "18px 34px",
        fontFamily: DISPLAY,
        fontSize: 50,
        letterSpacing: 1,
        textTransform: "uppercase",
      }}
    >
      {children}
    </div>
  );
};

const Card: React.FC<{ label: string; text: string; correct: boolean; revealed: boolean; delay: number }> = ({
  label,
  text,
  correct,
  revealed,
  delay,
}) => {
  const s = pop(delay);
  const dim = revealed && !correct ? 0.35 : 1;
  const fill = revealed && correct ? C.green : C.paper;
  return (
    <div
      style={{
        opacity: interpolate(s, [0, 1], [0, dim]),
        transform: `translateY(${interpolate(s, [0, 1], [40, 0])}px) scale(${revealed && correct ? 1.04 : 1})`,
        background: fill,
        border: `7px solid ${C.ink}`,
        boxShadow: HARD(revealed && correct ? 14 : 10),
        borderRadius: 26,
        padding: "30px 28px",
        display: "flex",
        alignItems: "center",
        gap: 24,
        minHeight: 132,
      }}
    >
      <div
        style={{
          flexShrink: 0,
          width: 80,
          height: 80,
          borderRadius: 16,
          background: revealed && correct ? C.paper : C.cream,
          border: `6px solid ${C.ink}`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: DISPLAY,
          fontSize: 48,
        }}
      >
        {label}
      </div>
      <div style={{ fontFamily: BODY, fontWeight: 800, fontSize: 48, color: C.ink, lineHeight: 1.05 }}>{text}</div>
    </div>
  );
};

const Countdown: React.FC<{ seconds: number; color: string; startAt?: number }> = ({ seconds, color, startAt = 0 }) => {
  const frame = useCurrentFrame();
  const local = Math.max(0, frame - startAt); // countdown clock starts after the read window
  const remaining = Math.max(1, seconds - Math.floor(local / FPS));
  const pct = interpolate(local, [0, seconds * FPS], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, alignItems: "center", width: "100%" }}>
      <div
        style={{
          width: 150,
          height: 150,
          borderRadius: "50%",
          background: color,
          border: `8px solid ${C.ink}`,
          boxShadow: HARD(10),
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: DISPLAY,
          fontSize: 96,
          color: C.ink,
        }}
      >
        {remaining}
      </div>
      <div style={{ width: "100%", height: 34, background: C.paper, border: `6px solid ${C.ink}`, borderRadius: 18, overflow: "hidden" }}>
        <div style={{ width: `${pct * 100}%`, height: "100%", background: C.coral }} />
      </div>
    </div>
  );
};

const norm = (s: string) => s.trim().toLowerCase();

const QuestionScene: React.FC<{
  q: HermesQuestion;
  idx: number;
  total: number;
  countdownSec: number;
  reveals: boolean;
  showProgress: boolean;
  progressStyle: "short" | "full";
  readFramesN: number; // spoken-read window before the countdown (0 = music-only)
}> = ({ q, idx, total, countdownSec, reveals, showProgress, progressStyle, readFramesN }) => {
  const frame = useCurrentFrame();
  const bg = PALETTE[idx % PALETTE.length];
  const accent = PALETTE[(idx + 2) % PALETTE.length];
  const cdFrames = Math.round(countdownSec * FPS);
  const reading = frame < readFramesN; // host is reading the question/options
  const counting = frame >= readFramesN && frame < readFramesN + cdFrames;
  const revealed = reveals && frame >= readFramesN + cdFrames;
  const letters = ["A", "B", "C", "D"];
  const progressText = progressStyle === "full" ? `QUESTION ${idx + 1} OF ${total}` : `Q${idx + 1}`;

  return (
    <AbsoluteFill style={{ background: bg, padding: 70, flexDirection: "column", gap: 30 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", minHeight: 96 }}>
        <Pill bg={accent}>{q.tier}</Pill>
        {showProgress ? (
          <div
            style={{
              fontFamily: DISPLAY,
              fontSize: progressStyle === "full" ? 34 : 46,
              color: C.ink,
              background: C.paper,
              border: `6px solid ${C.ink}`,
              borderRadius: 16,
              padding: "10px 22px",
              boxShadow: HARD(6),
              whiteSpace: "nowrap",
            }}
          >
            {progressText}
          </div>
        ) : null}
      </div>

      <div style={{ fontFamily: DISPLAY, fontSize: 74, lineHeight: 1.06, color: C.ink, textShadow: `3px 3px 0 ${C.paper}` }}>
        {q.prompt}
      </div>

      {q.kind === "numseries" ? (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 20, justifyContent: "center", marginTop: 10 }}>
          {[...(q.seq ?? []), "?"].map((n, i) => {
            const isQ = n === "?";
            const show = revealed && isQ ? q.answer : n;
            return (
              <div
                key={i}
                style={{
                  minWidth: 140,
                  padding: "28px 24px",
                  background: revealed && isQ ? C.green : isQ ? C.paper : C.cream,
                  border: `7px solid ${C.ink}`,
                  boxShadow: HARD(10),
                  borderRadius: 22,
                  fontFamily: DISPLAY,
                  fontSize: 80,
                  color: C.ink,
                  textAlign: "center",
                }}
              >
                {show}
              </div>
            );
          })}
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 24, marginTop: 4 }}>
          {(q.options ?? []).slice(0, 4).map((opt, i) => (
            <Card key={i} label={letters[i]} text={opt} correct={norm(opt) === norm(q.answer)} revealed={revealed} delay={6 + i * 4} />
          ))}
        </div>
      )}

      <div style={{ flex: 1 }} />
      {revealed ? (
        <div
          style={{
            alignSelf: "center",
            fontFamily: DISPLAY,
            fontSize: 60,
            color: C.ink,
            background: C.green,
            border: `7px solid ${C.ink}`,
            boxShadow: HARD(10),
            borderRadius: 22,
            padding: "18px 40px",
            textAlign: "center",
          }}
        >
          answer: {q.answer}
        </div>
      ) : reading ? (
        <ListenChip />
      ) : counting ? (
        // Countdown clock starts when the spoken read finishes (startAt=readFramesN).
        <Countdown seconds={countdownSec} color={accent} startAt={readFramesN} />
      ) : (
        <div
          style={{
            alignSelf: "center",
            fontFamily: DISPLAY,
            fontSize: 54,
            color: C.ink,
            background: C.yellow,
            border: `7px solid ${C.ink}`,
            boxShadow: HARD(10),
            borderRadius: 22,
            padding: "18px 36px",
            textAlign: "center",
          }}
        >
          {"comment your answer \uD83D\uDC47"}
        </div>
      )}
    </AbsoluteFill>
  );
};

/** Shown while the host is reading the question/options aloud (narration read
 *  window). A calm "listen" cue so viewers don't answer before the countdown. */
const ListenChip: React.FC = () => {
  const s = pop(2);
  return (
    <div
      style={{
        alignSelf: "center",
        transform: `scale(${interpolate(s, [0, 1], [0.7, 1])})`,
        fontFamily: DISPLAY,
        fontSize: 54,
        color: C.ink,
        background: C.mint,
        border: `7px solid ${C.ink}`,
        boxShadow: HARD(10),
        borderRadius: 22,
        padding: "18px 40px",
        textAlign: "center",
        letterSpacing: 1,
      }}
    >
      {"listen up \uD83D\uDD0A"}
    </div>
  );
};

const CenteredCard: React.FC<{ big: string; small?: string; bg: string }> = ({ big, small, bg }) => {
  const s = pop(4);
  return (
    <AbsoluteFill style={{ background: bg, alignItems: "center", justifyContent: "center", padding: 80 }}>
      <div
        style={{
          transform: `scale(${interpolate(s, [0, 1], [0.7, 1])})`,
          background: C.paper,
          border: `10px solid ${C.ink}`,
          boxShadow: HARD(18),
          borderRadius: 40,
          padding: "64px 52px",
          textAlign: "center",
          maxWidth: 920,
        }}
      >
        <div style={{ fontFamily: DISPLAY, fontSize: 120, lineHeight: 1, color: C.ink }}>{big}</div>
        {small ? <div style={{ marginTop: 28, fontFamily: BODY, fontWeight: 800, fontSize: 52, color: C.ink, lineHeight: 1.15 }}>{small}</div> : null}
      </div>
    </AbsoluteFill>
  );
};

export const HermesQuiz: React.FC<HermesQuizProps> = (props) => {
  const total = computeDuration(props);
  const offs = offsets(props);
  // Duck the music bed under the spoken voiceover so the host stays intelligible.
  const hasVO = (props.narration?.clips?.length ?? 0) > 0;
  return (
    <AbsoluteFill style={{ background: C.cream }}>
      <Audio src={staticFile(props.music)} volume={hasVO ? 0.12 : 0.28} loop />
      <Sequence durationInFrames={INTRO}>
        <CenteredCard big={props.title} small={props.subtitle} bg={C.blue} />
      </Sequence>
      {props.questions.map((q, i) => {
        const clip = clipFor(props, i);
        return (
          <Sequence key={i} from={offs[i]} durationInFrames={qFrames(props, i)}>
            {clip ? <Audio src={staticFile(clip.src)} volume={1} /> : null}
            <QuestionScene
              q={q}
              idx={i}
              total={props.questions.length}
              countdownSec={props.countdownSec}
              reveals={willReveal(props, i)}
              showProgress={props.showProgress}
              progressStyle={props.progressStyle}
              readFramesN={readFrames(props, i)}
            />
          </Sequence>
        );
      })}
      <Sequence from={total - OUTRO} durationInFrames={OUTRO}>
        <CenteredCard big="SMART FELLA?" small={props.outro} bg={C.coral} />
      </Sequence>
    </AbsoluteFill>
  );
};
