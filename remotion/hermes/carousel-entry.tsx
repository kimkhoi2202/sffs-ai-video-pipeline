/**
 * Standalone Remotion entry for teaser-carousel stills (1080x1350, 4:5 — the
 * roomy in-feed carousel ratio).
 *
 * Slides occupy SLIDE_PERIOD-frame blocks at 30fps so the shared video springs
 * (HeroShapes/PerspectiveGrid) settle before we grab the still. Render slide N
 * at its block's LAST frame:
 *   npx remotion still hermes/carousel-entry.tsx RebusCarousel out.png --frame=<N*SLIDE_PERIOD+SLIDE_PERIOD-1> --props=<file.json>
 * (cwd=remotion/, same convention as hermes/entry.tsx; tools/render-carousel.ts
 * does this frame math for you.)
 *
 * Families:
 *   RebusCarousel - rebus word-picture puzzles (slide count derives from props;
 *                   revealed puzzles get answer slides, last slide = comment CTA)
 */
import React from "react";
import { registerRoot, Composition } from "remotion";
import { RebusCarousel, DEFAULT_PROPS as REBUS_DEFAULTS, durationFrames, type RebusCarouselProps } from "./RebusCarousel";

const Root: React.FC = () => (
  <Composition
    id="RebusCarousel"
    component={RebusCarousel}
    durationInFrames={durationFrames(REBUS_DEFAULTS)}
    fps={30}
    width={1080}
    height={1350}
    defaultProps={REBUS_DEFAULTS}
    calculateMetadata={({ props }) => ({ durationInFrames: durationFrames(props as RebusCarouselProps) })}
  />
);

registerRoot(Root);
