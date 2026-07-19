import { Composition } from "remotion";
import "./theme/fonts"; // side-effect: load Anton + DM Sans (gated via delayRender)
import { VIDEO } from "./theme/brand";
import { FullVideo } from "./full/FullVideo";
import { ALL_IDS, FPS, TOTAL as FULL_TOTAL, getTimeline, type Platform, type SfxSet } from "./full/timeline";
import type { Question } from "./data/types";
import { bySlug } from "./data/cuts";
import { Round15Slice } from "./slice/Round15Slice";
import { SEG, TOTAL as SLICE_TOTAL } from "./slice/timeline";
import { Intro } from "./scenes/Intro";
import { NonverbalPreview } from "./preview/NonverbalPreview";

/** Duration for a cut: prefer the named cut (by slug) from src/data/cuts.ts;
 *  fall back to explicit props. Per-round overrides (questions/durs/qrBase) are
 *  threaded so a generated round's length is computed from ITS narration. */
const cutDuration = (props: {
  slug?: string;
  platform?: Platform;
  questionIds?: number[];
  sfx?: SfxSet;
  questions?: Question[];
  durs?: Record<string, number>;
  qrBase?: string;
}): number => {
  const cut = props.slug ? bySlug(props.slug) : undefined;
  const platform = cut?.platform ?? (props.platform as Platform) ?? "youtube";
  const ids = cut?.ids ?? props.questionIds ?? ALL_IDS;
  const sfx = cut?.sfx ?? props.sfx;
  return getTimeline(platform, ids, sfx, props.questions, props.durs, props.qrBase).total;
};

/**
 * Compositions. `FullVideo` is the Phase-2 deliverable (~11 min); its `platform`
 * prop (youtube | instagram | tiktok) picks the outro CTA + outro VO/captions,
 * and `calculateMetadata` recomputes the total length for that platform.
 * `Round15Slice` is the Phase-1 vertical slice; `Intro` is standalone.
 */
export const RemotionRoot: React.FC = () => {
  const landscape = { fps: FPS, width: VIDEO.width, height: VIDEO.height };
  const portrait = { fps: FPS, width: 1080, height: 1920 };
  return (
    <>
      {/* Landscape 16:9 — the full 15-Q master + the curated 10-Q YouTube cut
          (same composition; pass slug via --props, e.g. {"slug":"cut-10"}). */}
      <Composition
        id="FullVideo"
        component={FullVideo}
        durationInFrames={FULL_TOTAL}
        defaultProps={{ slug: "full-15" }}
        calculateMetadata={({ props }) => ({ durationInFrames: cutDuration(props) })}
        {...landscape}
      />

      {/* Portrait 9:16 — the vertical shorts (3 Qs each, "follow for more",
          distinct music + SFX per short; pass slug via --props, e.g.
          {"slug":"short-3"}). */}
      <Composition
        id="Short"
        component={FullVideo}
        durationInFrames={FULL_TOTAL}
        defaultProps={{ slug: "short-1" }}
        calculateMetadata={({ props }) => ({ durationInFrames: cutDuration(props) })}
        {...portrait}
      />

      <Composition id="Round15Slice" component={Round15Slice} durationInFrames={SLICE_TOTAL} {...landscape} />
      <Composition id="Intro" component={Intro} durationInFrames={SEG.intro} {...landscape} />

      {/* Static contact sheet of the expanded nonverbal vocabulary (still-only). */}
      <Composition id="NonverbalPreview" component={NonverbalPreview} durationInFrames={1} fps={30} width={1920} height={1600} />
    </>
  );
};
