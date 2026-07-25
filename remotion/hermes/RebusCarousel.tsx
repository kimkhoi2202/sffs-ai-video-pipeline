/**
 * RebusCarousel — static 4:5 (1080x1350) carousel of word-picture puzzles,
 * re-skinned to match the "Closer" quiz VIDEOS exactly (src/scenes/*) — same
 * fonts, palette, primitives (Pill, Card, HeroShapes, PerspectiveGrid, brain
 * logo) and the same grammar (4:5 is the roomy in-feed carousel ratio) —
 *
 *   PUZZLE slide  = colored field + header pill + the puzzle in a WHITE prompt
 *                   bubble (mirrors QuestionFrame/PromptTitle).
 *   ANSWER slide  = MINT field + coral "CORRECT ANSWER" pill + white answer card
 *                   + cream explanation card (mirrors scenes/Reveal).
 *   OUTRO slide   = GREEN field (same as the video outro) + perspective grid +
 *                   floating hero shapes + big "DID YOU / GET IT?" headline + a
 *                   plain "COMMENT YOUR ANSWER BELOW" line + yellow "FOLLOW FOR
 *                   MORE" pill w/ tilted brain + SCROLL FOR MORE cue (mirrors
 *                   scenes/Outro).
 *
 * We never say "rebus" on-screen. Puzzles get an ANSWER slide only when
 * reveal:true; the last puzzle is usually reveal:false = comment-bait.
 *
 * FRAMES: the video's shapes/springs settle over ~1s, so we give every slide a
 * SLIDE_PERIOD-frame block at 30fps and render the still at the block's LAST
 * frame (settled). Frame f -> slide floor(f / SLIDE_PERIOD).
 */
import React from "react";
import { AbsoluteFill, Img, staticFile, useCurrentFrame } from "remotion";
import { COLORS, hardDropShadow, hardShadow } from "../src/theme/brand";
import { ANTON, DM_SANS } from "../src/theme/fonts";
import { Pill } from "../src/components/Pill";
import { Card } from "../src/components/Card";
import { HeroShapes } from "../src/components/HeroShapes";
import { PerspectiveGrid } from "../src/components/PerspectiveGrid";

const W = 1080; // 4:5 carousel is 1080x1350; height is implicit via the composition
const M = 64; // action-safe margin
export const SLIDE_PERIOD = 60; // frames per slide @30fps (>= spring settle time)

// Colored puzzle fields rotate like the video plates (never two alike in a row).
const BGS = [COLORS.blue, COLORS.yellow, COLORS.coral, COLORS.mint] as const;
// Named brand fields a post can pin via `field` so two posts don't share a color.
const FIELDS: Record<string, string> = {
  blue: COLORS.blue,
  yellow: COLORS.yellow,
  coral: COLORS.coral,
  mint: COLORS.mint,
  cream: COLORS.cream,
};

// ── Props ─────────────────────────────────────────────────────────────────────
export type RebusRow = {
  text: string;
  /** Relative size: "big" (default) for the main words, "small" for helpers. */
  size?: "big" | "small";
  /** Draw horizontal rules above and below this row (e.g. reading BETWEEN lines). */
  ruled?: boolean;
  /** Ink the row in a brand color (e.g. "green" for GREEN with envy). */
  color?: "green" | "blue" | "coral" | "yellow";
  /** Transparent leading text that reserves space, shifting the row off-center
   *  to the right — used to show a MISSING letter (e.g. ghost "C" for ENTURY). */
  ghost?: string;
};

/** Big outlined word whose glyph interiors are tiled with a filler word
 *  ("YOU" full of "BOLOGNA" = you are full of bologna). */
export type RebusFilled = { word: string; filler: string };

export type RebusItem = {
  rows?: RebusRow[];
  filled?: RebusFilled; // takes precedence over rows
  answer: string;
  explanation: string;
  /** true = this puzzle gets an answer slide; false = comment-bait, no reveal. */
  reveal: boolean;
  /** true = answer slide ONLY (no puzzle slide) and excluded from "PUZZLE N OF M"
   *  numbering — a bonus reveal that isn't one of the counted puzzles. */
  answerOnly?: boolean;
  /** Per-puzzle field color override (brand name). Beats the post-level `field`
   *  and the default rotation — lets one post pick its own palette per slide. */
  field?: keyof typeof FIELDS;
};

export type RebusCarouselProps = {
  puzzles: RebusItem[];
  /** Instruction on each puzzle slide (never says "rebus"). */
  prompt: string;
  /** Category pill, top-left of each puzzle slide. */
  topic: string;
  /** Outro CTA pill (matches the video's "FOLLOW FOR MORE"). */
  outroCta: string;
  /** Puzzle-field color (brand name: blue|yellow|coral|mint|cream). Pin this so
   *  two posts don't share a field color; omitted = rotate per slide. */
  field?: keyof typeof FIELDS;
};

export const DEFAULT_PROPS: RebusCarouselProps = {
  prompt: "WHAT'S THE HIDDEN MEANING?",
  topic: "BRAIN TEASER",
  outroCta: "FOLLOW FOR MORE",
  puzzles: [
    {
      rows: [{ text: "STAND" }, { text: "I" }],
      answer: "I understand",
      explanation: "The I is standing UNDER the word STAND.",
      reveal: true,
    },
  ],
};

// ── Slide plan (pure: entry's calculateMetadata + still --frame rely on it) ─────
export type SlideRef = { type: "puzzle" | "reveal" | "outro"; idx: number };
export const slidePlan = (p: RebusCarouselProps): SlideRef[] => {
  const out: SlideRef[] = [];
  p.puzzles.forEach((pz, i) => {
    if (!pz.answerOnly) out.push({ type: "puzzle", idx: i }); // answer-only items skip the puzzle slide
    if (pz.reveal || pz.answerOnly) out.push({ type: "reveal", idx: i });
  });
  out.push({ type: "outro", idx: 0 });
  return out;
};
export const slideCount = (p: RebusCarouselProps): number => slidePlan(p).length;
/** Total composition frames = one settle-block per slide. */
export const durationFrames = (p: RebusCarouselProps): number => slideCount(p) * SLIDE_PERIOD;

// ── The puzzle inside the white prompt bubble ───────────────────────────────────
const FilledWord: React.FC<{ spec: RebusFilled }> = ({ spec }) => {
  const w = 780;
  const h = 340;
  const fontSize = Math.min(h * 0.92, (w * 0.94) / (spec.word.length * 0.62));
  const rowH = fontSize * 0.13;
  const fillerLine = `${spec.filler} `.repeat(Math.ceil(w / (rowH * 0.5 * spec.filler.length)) + 2);
  const rows = Math.ceil(h / rowH) + 1;
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
      <defs>
        <clipPath id="word-clip">
          <text x={w / 2} y={h / 2} textAnchor="middle" dominantBaseline="central" fontFamily={ANTON} fontSize={fontSize}>
            {spec.word}
          </text>
        </clipPath>
      </defs>
      <g clipPath="url(#word-clip)">
        <rect width={w} height={h} fill={COLORS.paper} />
        {Array.from({ length: rows }, (_, i) => (
          <text key={i} x={i % 2 === 0 ? 0 : -rowH * 2} y={i * rowH} fontFamily={ANTON} fontSize={rowH} fill={COLORS.ink} letterSpacing={1}>
            {fillerLine}
          </text>
        ))}
      </g>
      <text x={w / 2} y={h / 2} textAnchor="middle" dominantBaseline="central" fontFamily={ANTON} fontSize={fontSize} fill="none" stroke={COLORS.ink} strokeWidth={4}>
        {spec.word}
      </text>
    </svg>
  );
};

/** White prompt bubble holding the puzzle — same treatment as the video
 *  question box (PromptTitle): paper fill, thick ink border, 40px radius. */
const PuzzleBubble: React.FC<{ item: RebusItem }> = ({ item }) => {
  const ROW_COLOR = { green: COLORS.green, blue: COLORS.blue, coral: COLORS.coral, yellow: COLORS.yellow };
  // Tall stacks (3+ rows) would overflow the content region and shove the prompt
  // into the header pills, so scale the big font, padding and gap down by row
  // count. 1-2 rows keep the roomy default.
  const rowCount = item.rows?.length ?? 1;
  const bigSize = rowCount >= 4 ? 76 : rowCount === 3 ? 96 : 120;
  const padV = rowCount >= 3 ? 48 : 80;
  const rowGap = rowCount >= 3 ? 16 : 24;
  return (
    <div
      style={{
        boxSizing: "border-box",
        background: COLORS.paper,
        border: `9px solid ${COLORS.ink}`,
        boxShadow: hardShadow(16),
        borderRadius: 40,
        padding: `${padV}px 70px`,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: rowGap,
        minWidth: 760,
        maxWidth: 940,
      }}
    >
      {item.filled ? (
        <FilledWord spec={item.filled} />
      ) : (
        (item.rows ?? []).map((row, i) => (
          <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 16, width: "100%" }}>
            {row.ruled ? <div style={{ width: "100%", height: 10, background: COLORS.ink, borderRadius: 5 }} /> : null}
            <div
              style={{
                display: "flex",
                justifyContent: "center",
                fontFamily: ANTON,
                fontSize: row.size === "small" ? 60 : bigSize,
                lineHeight: 1.05,
                color: row.color ? ROW_COLOR[row.color] : COLORS.ink,
                letterSpacing: 3,
                textAlign: "center",
              }}
            >
              {/* transparent leading glyph reserves the missing-letter slot */}
              {row.ghost ? <span style={{ opacity: 0 }}>{row.ghost}</span> : null}
              <span>{row.text}</span>
            </div>
            {row.ruled ? <div style={{ width: "100%", height: 10, background: COLORS.ink, borderRadius: 5 }} /> : null}
          </div>
        ))
      )}
    </div>
  );
};

/** Cute bottom decoration for puzzle slides: the brain mascot centered, framed by
 *  a SYMMETRIC pair of question marks on each side — a bigger outer one and a
 *  smaller inner one, mirrored left/right, tilts leaning outward so they arc
 *  around the brain. Lives only in the lower band (well below the puzzle bubble)
 *  so nothing overlaps the problem. Anton with a clean ink stroke + soft hard
 *  shadow; colors avoid the two puzzle fields (coral/yellow) so they always pop. */
const qMarkStyle = (s: number, color: string): React.CSSProperties => ({
  position: "absolute",
  fontFamily: ANTON,
  fontSize: s,
  lineHeight: 1,
  color,
  WebkitTextStroke: `${Math.max(2, s * 0.018)}px ${COLORS.ink}`,
  textShadow: `${s * 0.05}px ${s * 0.05}px 0 ${COLORS.ink}`,
});
const ThinkingBrain: React.FC = () => {
  const cx = W / 2;
  const midY = 250; // vertical center of the decoration band
  const OUTER = 104;
  const INNER = 66;
  return (
    <div style={{ position: "absolute", left: 0, right: 0, bottom: 76, height: 400, pointerEvents: "none" }}>
      {/* mirrored pair per side: outer (far, big) + inner (near, small), tilts leaning outward */}
      <div style={{ ...qMarkStyle(OUTER, COLORS.blue), left: cx - 300, top: midY - OUTER / 2, transform: "rotate(-18deg)" }}>?</div>
      <div style={{ ...qMarkStyle(INNER, COLORS.green), left: cx - 190, top: midY + 8, transform: "rotate(-10deg)" }}>?</div>
      <div style={{ ...qMarkStyle(INNER, COLORS.green), left: cx + 150, top: midY + 8, transform: "rotate(10deg)" }}>?</div>
      <div style={{ ...qMarkStyle(OUTER, COLORS.blue), left: cx + 230, top: midY - OUTER / 2, transform: "rotate(18deg)" }}>?</div>
      {/* the brain mascot, centered, slight playful tilt */}
      <Img
        src={staticFile("images/sffs-logo.png")}
        style={{ position: "absolute", left: "50%", top: midY - 130, transform: "translateX(-50%) rotate(-4deg)", width: 280, height: "auto", display: "block", filter: hardDropShadow(14) }}
      />
    </div>
  );
};

// ── Slides ──────────────────────────────────────────────────────────────────────
const PuzzleSlide: React.FC<{ p: RebusCarouselProps; idx: number }> = ({ p, idx }) => {
  // Numbering counts only the "real" puzzles (answer-only bonus reveals excluded).
  const counted = p.puzzles.filter((pz) => !pz.answerOnly);
  const total = counted.length;
  const num = p.puzzles.slice(0, idx + 1).filter((pz) => !pz.answerOnly).length;
  const multi = total > 1;
  // Field precedence: per-puzzle override > post-level field > rotation. Rotation
  // keys off the counted position (num) so answer-only bonuses don't shift the
  // palette and a puzzle never lands on mint (the reveal field).
  const item = p.puzzles[idx];
  const bg = item.field ? FIELDS[item.field] : p.field ? FIELDS[p.field] : BGS[(num - 1) % BGS.length];
  return (
    <AbsoluteFill style={{ backgroundColor: bg }}>
      {/* header pills (top-left), like the video plate */}
      <div style={{ position: "absolute", left: M, top: 64, display: "flex", gap: 20 }}>
        {multi ? <Pill text={`PUZZLE ${num} OF ${total}`} fill={COLORS.paper} fontSize={32} /> : null}
        <Pill text={p.topic} fill={COLORS.paper} fontSize={32} />
      </div>

      {/* prompt box (flat white, like the video PromptTitle) + puzzle bubble.
          Bottom padding leaves room for the thinking-brain decoration below. */}
      <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 44, padding: `210px ${M}px 470px` }}>
        <div
          style={{
            boxSizing: "border-box",
            maxWidth: 940,
            background: COLORS.paper,
            border: `9px solid ${COLORS.ink}`,
            borderRadius: 40,
            padding: "26px 44px",
            fontFamily: ANTON,
            fontSize: 58,
            lineHeight: 1.08,
            color: COLORS.ink,
            textAlign: "center",
            textTransform: "uppercase",
          }}
        >
          {p.prompt}
        </div>
        <PuzzleBubble item={item} />
      </div>

      {/* cute bottom decoration — brain mid-thought + rising question marks */}
      <ThinkingBrain />
    </AbsoluteFill>
  );
};

/** Mirrors scenes/Reveal: mint field, coral "CORRECT ANSWER" pill, white answer
 *  card (flat), cream explanation card (shadowed). No letter badge — the puzzle
 *  has no lettered options. */
const RevealSlide: React.FC<{ p: RebusCarouselProps; idx: number }> = ({ p, idx }) => {
  const item = p.puzzles[idx];
  const cardW = W - 2 * M;
  // Condensed, vertically-centered stack for the 4:5 frame: pill -> answer card
  // -> explanation card, tight gaps, no dead space.
  const ansY = 404;
  const ansH = 256;
  const explY = ansY + ansH + 36; // 696
  const explH = 384;
  const pillY = ansY - 68; // pill sits just above the answer card
  const EXPL_SHADOW = 16;
  return (
    <AbsoluteFill style={{ backgroundColor: COLORS.mint }}>
      <div style={{ position: "absolute", left: W / 2, top: pillY, transform: "translate(-50%, -50%)" }}>
        <Pill text="CORRECT ANSWER" fill={COLORS.coral} fontSize={44} tracking={3} padX={40} padY={20} shadow={8} />
      </div>

      {/* answer card (FLAT) */}
      <Card x={M} y={ansY} w={cardW} h={ansH} radius={36} border={9} fill={COLORS.paper} shadow={0} />
      <div
        style={{
          position: "absolute",
          left: M + 48,
          top: ansY,
          width: cardW - 96,
          height: ansH,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          textAlign: "center",
          fontFamily: ANTON,
          fontSize: 92,
          lineHeight: 1.02,
          color: COLORS.ink,
          textTransform: "uppercase",
        }}
      >
        {item.answer}
      </div>

      {/* explanation card (keeps shadow) */}
      <Card x={M - EXPL_SHADOW / 2} y={explY} w={cardW} h={explH} radius={36} border={8} fill={COLORS.cream} shadow={EXPL_SHADOW} />
      <div
        style={{
          position: "absolute",
          left: M - EXPL_SHADOW / 2 + 56,
          top: explY,
          width: cardW - 112,
          height: explH,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          textAlign: "center",
          fontFamily: DM_SANS,
          fontWeight: 500,
          fontSize: 48,
          lineHeight: 1.3,
          color: COLORS.ink,
        }}
      >
        {item.explanation}
      </div>
    </AbsoluteFill>
  );
};

/** Two-line Anton title, ink stroke + hard shadow — the video intro/outro headline. */
const headWord = (head: number, color: string): React.CSSProperties => ({
  fontFamily: ANTON,
  fontSize: head,
  lineHeight: 1,
  color,
  WebkitTextStroke: `${head * 0.022}px ${COLORS.ink}`,
  textShadow: `${head * 0.05}px ${head * 0.05}px 0 ${COLORS.ink}`,
  textTransform: "uppercase",
  whiteSpace: "nowrap",
});

/** Clean ink down-arrow (lucide ArrowDown) — the scroll-for-more affordance,
 *  identical to scenes/Outro. */
const ArrowDown: React.FC<{ size: number }> = ({ size }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={COLORS.ink} strokeWidth={2.75} strokeLinecap="round" strokeLinejoin="round" style={{ display: "block" }} aria-hidden>
    <path d="M12 5v14" />
    <path d="m19 12-7 7-7-7" />
  </svg>
);

/** Mirrors scenes/Outro (noanswer variant): green field + grid + floating shapes,
 *  big two-line "DID YOU / GET IT?" headline, plain "COMMENT YOUR ANSWER BELOW"
 *  sub-line, yellow CTA pill with the tilted brain, and the bottom SCROLL FOR
 *  MORE cue. */
const OutroSlide: React.FC<{ p: RebusCarouselProps }> = ({ p }) => {
  const head = 132; // outro headline scale for the 4:5 frame
  return (
    <AbsoluteFill style={{ backgroundColor: COLORS.green }}>
      <PerspectiveGrid base={COLORS.green} />
      <HeroShapes overrides={{ hexagon: COLORS.yellow }} />

      {/* content renders above the shapes */}
      <div style={{ position: "absolute", inset: 0, zIndex: 1 }}>
        {/* big headline — the hook */}
        <div style={{ position: "absolute", left: W / 2, top: 430, transform: "translate(-50%, -50%)" }}>
          <div style={headWord(head, COLORS.blue)}>DID YOU</div>
        </div>
        <div style={{ position: "absolute", left: W / 2, top: 580, transform: "translate(-50%, -50%)" }}>
          <div style={headWord(head, COLORS.coral)}>GET IT?</div>
        </div>

        {/* medium sub-line — plain ink Anton, no box (matches scenes/Outro) */}
        <div style={{ position: "absolute", left: W / 2, top: 718, transform: "translate(-50%, -50%)" }}>
          <div style={{ fontFamily: ANTON, fontSize: 50, lineHeight: 1, color: COLORS.ink, textTransform: "uppercase", letterSpacing: "0.01em", whiteSpace: "nowrap" }}>
            COMMENT YOUR ANSWER BELOW
          </div>
        </div>

        {/* CTA pill + tilted brain sticker */}
        <div style={{ position: "absolute", left: W / 2, top: 910, transform: "translate(-50%, -50%)" }}>
          <div style={{ position: "relative", display: "inline-flex" }}>
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                background: COLORS.yellow,
                color: COLORS.ink,
                border: `8px solid ${COLORS.ink}`,
                borderRadius: 9999,
                padding: "26px 56px",
                boxShadow: hardShadow(12),
                fontFamily: ANTON,
                fontSize: 66,
                lineHeight: 1,
                textTransform: "uppercase",
                letterSpacing: "0.01em",
                whiteSpace: "nowrap",
              }}
            >
              {p.outroCta}
            </div>
            <Img
              src={staticFile("images/sffs-logo.png")}
              style={{ position: "absolute", top: -50, right: -32, width: 128, height: "auto", display: "block", transform: "rotate(12deg)", filter: hardDropShadow(10), zIndex: 2 }}
            />
          </div>
        </div>

        {/* SCROLL FOR MORE cue, bottom-pinned (matches the portrait video outro) */}
        <div style={{ position: "absolute", left: W / 2, top: 1200, transform: "translate(-50%, -50%)", display: "flex", flexDirection: "column", alignItems: "center", gap: 14 }}>
          <div style={{ fontFamily: ANTON, fontSize: 38, lineHeight: 1, color: COLORS.ink, textTransform: "uppercase", letterSpacing: "0.04em", whiteSpace: "nowrap" }}>
            SCROLL FOR MORE
          </div>
          <div style={{ width: 82, height: 82, borderRadius: 9999, background: COLORS.paper, border: `6px solid ${COLORS.ink}`, boxShadow: hardShadow(8), display: "flex", alignItems: "center", justifyContent: "center" }}>
            <ArrowDown size={40} />
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};

export const RebusCarousel: React.FC<RebusCarouselProps> = (p) => {
  const frame = useCurrentFrame();
  const plan = slidePlan(p);
  const ref = plan[Math.min(Math.floor(frame / SLIDE_PERIOD), plan.length - 1)];
  if (ref.type === "outro") return <OutroSlide p={p} />;
  return ref.type === "reveal" ? <RevealSlide p={p} idx={ref.idx} /> : <PuzzleSlide p={p} idx={ref.idx} />;
};
