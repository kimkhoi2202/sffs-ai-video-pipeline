import { AbsoluteFill } from "remotion";
import { COLORS, separatorColor } from "../theme/brand";
import { ANTON, DM_SANS } from "../theme/fonts";
import { ShapeGlyph, GLYPH_KINDS, type GlyphKind } from "../components/ShapeGlyph";
import { DotSquare, DOT_RING, type DotPos } from "../components/DotSquare";
import { Polygon } from "../components/Polygon";
import { SHADE_FILL } from "../data/questions";

/**
 * NonverbalPreview — a static contact sheet of the EXPANDED nonverbal visual
 * vocabulary, drawn through the real ShapeGlyph / DotSquare / Polygon components
 * with the ACTUAL video styling (white tiles, per-plate brand separators via
 * separatorColor, blue SHADE_FILL shapes, gray ghost pips). Rendered as a still.
 * Review artifact for the shape expansion; no rounds are generated.
 */
const INK = COLORS.ink;
const SEP_OUTLINE = 4;
const SEQ = [COLORS.blue, COLORS.coral, COLORS.yellow, COLORS.mint, COLORS.green];

const Tile: React.FC<{ size?: number; bg?: string; children: React.ReactNode }> = ({ size = 118, bg = COLORS.paper, children }) => (
  <div style={{ width: size, height: size, boxSizing: "border-box", background: bg, border: `7px solid ${INK}`, borderRadius: 18, display: "flex", alignItems: "center", justifyContent: "center" }}>
    {children}
  </div>
);
const Label: React.FC<{ children: React.ReactNode; size?: number }> = ({ children, size = 24 }) => (
  <div style={{ fontFamily: DM_SANS, fontWeight: 700, fontSize: size, letterSpacing: "1px", color: INK, marginTop: 8, textAlign: "center", textTransform: "uppercase" }}>{children}</div>
);
const SectionTitle: React.FC<{ n: number; children: React.ReactNode }> = ({ n, children }) => (
  <div style={{ fontFamily: ANTON, fontSize: 36, background: SEQ[n % SEQ.length], border: `5px solid ${INK}`, borderRadius: 12, padding: "2px 18px", color: INK, boxShadow: `6px 6px 0 0 ${INK}`, alignSelf: "flex-start", margin: "6px 0 16px" }}>{children}</div>
);
const Item: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>{children}</div>
);

// Real analogy separators (mirror ShadedQuestion): stacked dots for ":" and
// stacked bars for "=", filled per-plate via separatorColor + black outline.
const SepDots: React.FC<{ fill: string }> = ({ fill }) => (
  <div style={{ display: "flex", flexDirection: "column", gap: 12, alignItems: "center", padding: "0 6px" }}>
    {[0, 1].map((i) => <div key={i} style={{ width: 18, height: 18, borderRadius: "50%", background: fill, border: `${SEP_OUTLINE}px solid ${INK}`, boxSizing: "border-box" }} />)}
  </div>
);
const SepBars: React.FC<{ fill: string }> = ({ fill }) => (
  <div style={{ display: "flex", flexDirection: "column", gap: 12, alignItems: "center", padding: "0 8px" }}>
    {[0, 1].map((i) => <div key={i} style={{ width: 52, height: 18, borderRadius: 9, background: fill, border: `${SEP_OUTLINE}px solid ${INK}`, boxSizing: "border-box" }} />)}
  </div>
);

// A figure analogy shown on its real brand-colored plate (empty L : filled L = empty R : ?)
const AnalogyPlate: React.FC<{ bg: string; L: GlyphKind; R: GlyphKind }> = ({ bg, L, R }) => {
  const sep = separatorColor(bg);
  const T = 84;
  const g = (kind: GlyphKind, filled: boolean) => (
    <Tile size={T}><ShapeGlyph kind={kind} s={T * 0.3} fill={filled ? SHADE_FILL : COLORS.paper} /></Tile>
  );
  return (
    <div style={{ background: bg, border: `6px solid ${INK}`, borderRadius: 20, padding: "18px 22px", display: "flex", alignItems: "center", boxShadow: `7px 7px 0 0 ${INK}` }}>
      {g(L, false)}
      <SepDots fill={sep} />
      {g(L, true)}
      <SepBars fill={sep} />
      {g(R, false)}
      <SepDots fill={sep} />
      <Tile size={T}><span style={{ fontFamily: ANTON, fontSize: T * 0.55, color: INK }}>?</span></Tile>
    </div>
  );
};

const rotate = (start: number, step: number, len: number): DotPos[] =>
  Array.from({ length: len }, (_, i) => DOT_RING[(start + i * step + DOT_RING.length * 4) % DOT_RING.length]);
const DOT_SAMPLES: { label: string; seq: DotPos[]; next: DotPos }[] = [
  { label: "STEP +1 (WALK)", seq: rotate(0, 1, 3), next: DOT_RING[3] },
  { label: "STEP +2 (CORNERS)", seq: rotate(0, 2, 3), next: DOT_RING[6 % 8] },
  { label: "STEP -1 (CCW)", seq: rotate(4, -1, 3), next: DOT_RING[(4 - 3 + 32) % 8] },
];

export const NonverbalPreview: React.FC = () => {
  return (
    <AbsoluteFill style={{ background: COLORS.cream, padding: 56, fontFamily: DM_SANS }}>
      <div style={{ fontFamily: ANTON, fontSize: 58, color: INK }}>NONVERBAL VOCABULARY — EXPANDED PREVIEW (v2)</div>
      <div style={{ fontFamily: DM_SANS, fontSize: 24, color: INK, marginTop: 4, marginBottom: 20 }}>
        Real Remotion components + real video styling (white tiles, per-plate brand separators, blue filled shapes). Not yet generated into rounds.
      </div>

      {/* 1. Glyphs (11) */}
      <SectionTitle n={0}>1 · SHAPE GLYPHS (11) — 6 base + 5 new distinct</SectionTitle>
      <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
        {GLYPH_KINDS.map((k) => (
          <Item key={k}>
            <Tile size={112}><ShapeGlyph kind={k} s={36} fill={SHADE_FILL} /></Tile>
            <Label size={20}>{k}</Label>
          </Item>
        ))}
      </div>

      {/* 2. Figure analogies on real plates */}
      <div style={{ height: 24 }} />
      <SectionTitle n={1}>2 · FIGURE ANALOGIES — real per-plate separators (empty : filled = empty : ?)</SectionTitle>
      <div style={{ display: "flex", gap: 26, flexWrap: "wrap" }}>
        <AnalogyPlate bg={COLORS.coral} L="crescent" R="star" />
        <AnalogyPlate bg={COLORS.blue} L="arrow" R="heart" />
        <AnalogyPlate bg={COLORS.mint} L="cross" R="lightning" />
      </div>

      {/* 3. Dot 3x3 grid + rotations */}
      <div style={{ height: 24 }} />
      <SectionTitle n={2}>3 · DOT 3x3 GRID — 9 spots (inset fixed) + ring rotations</SectionTitle>
      <div style={{ display: "flex", gap: 44, alignItems: "flex-start", flexWrap: "wrap" }}>
        <Item>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 92px)", gap: 8 }}>
            {(["tl", "tm", "tr", "lm", "center", "rm", "bl", "bm", "br"] as DotPos[]).map((p, i) => (
              <DotSquare key={p} size={92} pos={p} dotColor={SEQ[i % 4]} border={5} sqRadius={8} />
            ))}
          </div>
          <Label>ALL 9 SPOTS</Label>
        </Item>
        {DOT_SAMPLES.map((s) => (
          <Item key={s.label}>
            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              {s.seq.map((p, i) => <DotSquare key={i} size={104} pos={p} dotColor={SEQ[i % SEQ.length]} border={6} sqRadius={8} />)}
              <div style={{ fontFamily: ANTON, fontSize: 42, color: INK }}>?</div>
              <DotSquare size={104} pos={s.next} dotColor={COLORS.green} border={6} sqRadius={8} />
            </div>
            <Label>{s.label}</Label>
          </Item>
        ))}
      </div>

      {/* 4. Polygon series 3-8 */}
      <div style={{ height: 24 }} />
      <SectionTitle n={3}>4 · POLYGON SERIES (sides 3 to 8 + circle) — capped at 8</SectionTitle>
      <div style={{ display: "flex", gap: 22, flexWrap: "wrap" }}>
        {[3, 4, 5, 6, 7, 8, "circle" as const].map((shape, i) => (
          <Item key={String(shape)}>
            <Tile size={116}><Polygon shape={shape} r={44} fill={SEQ[i % SEQ.length]} border={6} /></Tile>
            <Label size={20}>{typeof shape === "number" ? `${shape} SIDES` : "CIRCLE"}</Label>
          </Item>
        ))}
      </div>
    </AbsoluteFill>
  );
};
