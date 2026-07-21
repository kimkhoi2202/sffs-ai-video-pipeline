import { Composition, registerRoot } from "remotion";
import "../theme/fonts"; // side-effect: load Anton + DM Sans (delayRender-gated)
import { IntroBrand } from "./IntroBrand";
import { ThumbV, ThumbSq, ThumbWide, ThumbCover } from "./Thumbnails";
import { ReplyBrand, REPLY_TOTAL } from "./ReplyBrand";
import { FPS, TOTAL } from "./timing";

/**
 * ISOLATED render entry. Registers ONLY the intro/reply + thumbnail compositions,
 * so a render off this entry never loads Root.tsx or the 100-round render graph.
 *
 * Outputs go IN-PROJECT under ../renders.nosync/ (the ".nosync" suffix makes
 * iCloud skip the tree so heavy media never throttles file I/O) — NEVER the
 * Desktop. Prefer the npm scripts, which bake the correct output paths:
 *   npm run render:intro    # -> ../renders.nosync/videos/intro/sffs-brand-intro-v1.mp4
 *   npm run render:reply    # -> ../renders.nosync/videos/reply/reply-1.mp4
 *   npm run render:thumbs   # -> ../renders.nosync/thumbnails/thumb-<ratio>-<color>.png (x15)
 * Or run directly — keep the output under ../renders.nosync/, not ~/Desktop:
 *   npx remotion render src/introcut/entry.tsx IntroBrand ../renders.nosync/videos/intro/sffs-brand-intro-v1.mp4 --port=7788
 *   npx remotion still  src/introcut/entry.tsx ThumbV ../renders.nosync/thumbnails/thumb-9x16-yellow.png --frame=60 --port=7788
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
      <Composition id="ThumbCover" component={ThumbCover} durationInFrames={90} fps={FPS} width={1640} height={624} />
    </>
  );
};

registerRoot(IntroRoot);
