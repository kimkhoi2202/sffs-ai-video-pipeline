import { Composition, registerRoot } from "remotion";
import "../theme/fonts"; // side-effect: load Anton + DM Sans (delayRender-gated)
import { IntroBrand } from "./IntroBrand";
import { ThumbV, ThumbSq, ThumbWide } from "./Thumbnails";
import { ReplyBrand, REPLY_TOTAL } from "./ReplyBrand";
import { FPS, TOTAL } from "./timing";

/**
 * ISOLATED render entry. Registers ONLY the intro + thumbnail compositions, so a
 * render off this entry never loads Root.tsx or the 100-round render graph. Run:
 *   npx remotion render src/introcut/entry.tsx IntroBrand out.mp4 --port=7788
 *   npx remotion still  src/introcut/entry.tsx ThumbV out.png --frame=60 --port=7788
 */
const IntroRoot: React.FC = () => {
  const portrait = { fps: FPS, width: 1080, height: 1920 };
  return (
    <>
      <Composition id="IntroBrand" component={IntroBrand} durationInFrames={TOTAL} {...portrait} />
      <Composition id="ReplyBrand" component={ReplyBrand} durationInFrames={REPLY_TOTAL} {...portrait} />
      <Composition id="ThumbV" component={ThumbV} durationInFrames={90} {...portrait} />
      <Composition id="ThumbSq" component={ThumbSq} durationInFrames={90} fps={FPS} width={1080} height={1080} />
      <Composition id="ThumbWide" component={ThumbWide} durationInFrames={90} fps={FPS} width={1920} height={1080} />
    </>
  );
};

registerRoot(IntroRoot);
