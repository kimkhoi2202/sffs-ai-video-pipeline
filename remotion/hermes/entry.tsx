/**
 * Standalone Remotion entry for the Hermes loop's self-contained quiz short.
 *
 * Rendered by hermes/src/render.ts with:
 *   npx remotion render hermes/entry.tsx HermesQuiz <out.mp4> --props=<file.json>
 * run with cwd=remotion/, so `import "remotion"` + @remotion/google-fonts resolve
 * from remotion/node_modules and staticFile() serves from remotion/public/.
 *
 * This file registers ONLY the HermesQuiz composition, so it never touches (or
 * conflicts with) the production remotion/src/Root.tsx.
 */
import React from "react";
import { registerRoot, Composition } from "remotion";
import { HermesQuiz, computeDuration, DEFAULT_PROPS, type HermesQuizProps } from "./HermesQuiz";

const Root: React.FC = () => (
  <Composition
    id="HermesQuiz"
    component={HermesQuiz}
    durationInFrames={computeDuration(DEFAULT_PROPS)}
    fps={30}
    width={1080}
    height={1920}
    defaultProps={DEFAULT_PROPS}
    calculateMetadata={({ props }) => ({ durationInFrames: computeDuration(props as HermesQuizProps) })}
  />
);

registerRoot(Root);
