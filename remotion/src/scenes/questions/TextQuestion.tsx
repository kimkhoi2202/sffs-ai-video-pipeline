import { Fragment } from "react";
import { QuestionFrame, PromptTitle } from "../../components/QuestionFrame";
import { TextOptionsGrid } from "../../components/OptionCards";
import { InlineArrow } from "../../components/InlineArrow";
import { OperatorGlyph, isOperator } from "../../components/OperatorGlyph";
import { useFmt } from "../../theme/layout";
import type { TextQuestion as TextQ } from "../../data/types";

/**
 * Text / analogy / odd-one-out / mapping / equation plate. Mapping arrows ("->")
 * render as a real vector arrow, and math operators (+ = × ÷ −) render as crisp
 * SVG glyphs (OperatorGlyph) instead of font characters, with even spacing.
 * Ordinary hyphens in words are untouched (only the standalone operators split).
 * In portrait the prompt font is scaled down and lines are allowed to wrap so
 * long analogies/equations never overflow the narrow box.
 */
const OP_SPLIT = /([+=×÷−])/;

/** Render one arrow-free segment: normalize spacing around operators, then swap
 *  each operator for a matched SVG glyph. */
const renderMath = (text: string, fontSize: number, wrap: boolean) => {
  const norm = text.replace(/\s*([+=×÷−])\s*/g, "$1"); // even operator spacing
  return norm.split(OP_SPLIT).map((tok, i) =>
    isOperator(tok) ? (
      <span key={i} style={{ display: "inline-flex", margin: "0 0.17em", transform: `translateY(${fontSize * 0.03}px)` }}>
        <OperatorGlyph op={tok} fontSize={fontSize} />
      </span>
    ) : (
      <span key={i} style={{ whiteSpace: wrap ? "pre-wrap" : "pre" }}>
        {tok}
      </span>
    ),
  );
};

const renderLines = (question: string, fontSize: number, wrap: boolean) => (
  <div
    style={{
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      gap: fontSize * 0.34,
      letterSpacing: "0.01em",
      lineHeight: 1.05,
    }}
  >
    {question.split("\n").map((line, li) => {
      const parts = line.split("->");
      return (
        <div key={li} style={{ display: "flex", alignItems: "center", justifyContent: "center", flexWrap: wrap ? "wrap" : "nowrap" }}>
          {parts.map((part, pi) => (
            <Fragment key={pi}>
              {renderMath(part, fontSize, wrap)}
              {pi < parts.length - 1 ? (
                <span style={{ display: "inline-flex", margin: "0 0.14em", transform: `translateY(${fontSize * 0.06}px)` }}>
                  <InlineArrow h={fontSize * 0.55} />
                </span>
              ) : null}
            </Fragment>
          ))}
        </div>
      );
    })}
  </div>
);

export const TextQuestion: React.FC<{ q: TextQ; elapsed: number; pos?: number; total?: number }> = ({
  q,
  elapsed,
  pos,
  total,
}) => {
  const { portrait } = useFmt();
  const fs = portrait ? Math.round(q.questionFontSize * 0.72) : q.questionFontSize;
  return (
    <QuestionFrame
      q={q}
      elapsed={elapsed}
      pos={pos}
      total={total}
      prompt={<PromptTitle fontSize={fs}>{renderLines(q.question, fs, portrait)}</PromptTitle>}
      options={<TextOptionsGrid options={q.options} />}
    />
  );
};
