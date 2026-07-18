import { Composition } from "remotion";
import "./theme/fonts"; // side-effect: load Anton + DM Sans (gated via delayRender)
import { VIDEO } from "./theme/brand";
import { FullVideo } from "./full/FullVideo";
import { FPS, TOTAL as FULL_TOTAL, getTimeline, type Platform } from "./full/timeline";
import { Round15Slice } from "./slice/Round15Slice";
import { SEG, TOTAL as SLICE_TOTAL } from "./slice/timeline";
import { Intro } from "./scenes/Intro";

/**
 * Compositions. `FullVideo` is the Phase-2 deliverable (~11 min); its `platform`
 * prop (youtube | instagram | tiktok) picks the outro CTA + outro VO/captions,
 * and `calculateMetadata` recomputes the total length for that platform.
 * `Round15Slice` is the Phase-1 vertical slice; `Intro` is standalone.
 */
export const RemotionRoot: React.FC = () => {
  const common = { fps: FPS, width: VIDEO.width, height: VIDEO.height };
  return (
    <>
      <Composition
        id="FullVideo"
        component={FullVideo}
        durationInFrames={FULL_TOTAL}
        defaultProps={{ platform: "youtube" as Platform }}
        calculateMetadata={({ props }) => ({ durationInFrames: getTimeline(props.platform as Platform).total })}
        {...common}
      />
      <Composition id="Round15Slice" component={Round15Slice} durationInFrames={SLICE_TOTAL} {...common} />
      <Composition id="Intro" component={Intro} durationInFrames={SEG.intro} {...common} />
    </>
  );
};
