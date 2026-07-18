import { Fragment } from "react";
import { QuestionFrame, PromptTitle } from "../../components/QuestionFrame";
import { TextOptionsGrid } from "../../components/OptionCards";
import { InlineArrow } from "../../components/InlineArrow";
import { OperatorGlyph, isOperator } from "../../components/OperatorGlyph";
import type { TextQuestion as TextQ } from "../../data/types";

/**
 * Text / analogy / odd-one-out / mapping / equation plate. Mapping arrows ("->")
 * render as a real vector arrow, and math operators (+ = × ÷ −) render as crisp
 * SVG glyphs (OperatorGlyph) instead of font characters, with even spacing.
 * Ordinary hyphens in words are untouched (only the standalone operators split).
 */
const OP_SPLIT = /([+=×÷−])/;

/** Render one arrow-free segment: normalize spacing around operators, then swap
 *  each operator for a matched SVG glyph. */
const renderMath = (text: string, fontSize: number) => {
  const norm = text.replace(/\s*([+=×÷−])\s*/g, "$1"); // even operator spacing
  return norm.split(OP_SPLIT).map((tok, i) =>
    isOperator(tok) ? (
      <span key={i} style={{ display: "inline-flex", margin: "0 0.17em", transform: `translateY(${fontSize * 0.03}px)` }}>
        <OperatorGlyph op={tok} fontSize={fontSize} />
      </span>
    ) : (
      <span key={i} style={{ whiteSpace: "pre" }}>
        {tok}
      </span>
    ),
  );
};

const renderLines = (question: string, fontSize: number) => (
  <div
    style={{
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      gap: fontSize * 0.34,
      letterSpacing: "0.01em",
      lineHeight: 1,
    }}
  >
    {question.split("\n").map((line, li) => {
      const parts = line.split("->");
      return (
        <div key={li} style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
          {parts.map((part, pi) => (
            <Fragment key={pi}>
              {renderMath(part, fontSize)}
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

export const TextQuestion: React.FC<{ q: TextQ; elapsed: number }> = ({ q, elapsed }) => (
  <QuestionFrame
    q={q}
    elapsed={elapsed}
    prompt={<PromptTitle fontSize={q.questionFontSize}>{renderLines(q.question, q.questionFontSize)}</PromptTitle>}
    options={<TextOptionsGrid options={q.options} />}
  />
);
