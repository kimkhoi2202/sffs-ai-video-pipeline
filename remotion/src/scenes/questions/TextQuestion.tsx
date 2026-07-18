import { Fragment } from "react";
import { QuestionFrame, PromptTitle } from "../../components/QuestionFrame";
import { TextOptionsGrid } from "../../components/OptionCards";
import { InlineArrow } from "../../components/InlineArrow";
import type { TextQuestion as TextQ } from "../../data/types";

/**
 * Text / analogy / odd-one-out / mapping plate. The question box (natural height)
 * hugs the top; a 2x2 grid of shadowed option cards sits in the consistent lower
 * band. Lines are stacked with a comfortable gap so a title like
 * "WHICH NUMBER FITS?" isn't crammed onto its mapping line, and any "->" renders
 * as a real vector arrow.
 */
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
              <span style={{ whiteSpace: "pre" }}>{part}</span>
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
