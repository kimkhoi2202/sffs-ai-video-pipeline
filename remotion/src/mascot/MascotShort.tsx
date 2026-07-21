import { AbsoluteFill } from "remotion";
import { FullVideo } from "../full/FullVideo";
import { MascotNarrator, type NarratorClip } from "./MascotNarrator";

/**
 * MASCOT SHORT — a standard cold-open 9:16 short (the shared `FullVideo`) with
 * the bottom-right talking-brain narrator overlaid on top. Purely additive: it
 * renders `FullVideo` unchanged, then layers `<MascotNarrator/>` above it, so it
 * reuses the whole pipeline (timeline, scenes, music, SFX, captions) without
 * touching any shared file. The render script computes `narratorClips` (the VO
 * clips' frame offsets + Rhubarb visemes, generated from the exact muxed audio)
 * and passes them + all the usual FullVideo props via --props.
 */
type Props = React.ComponentProps<typeof FullVideo> & { narratorClips?: NarratorClip[] };

export const MascotShort: React.FC<Props> = ({ narratorClips = [], ...fullVideoProps }) => (
  <AbsoluteFill>
    <FullVideo {...fullVideoProps} />
    <MascotNarrator clips={narratorClips} />
  </AbsoluteFill>
);
