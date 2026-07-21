import { AbsoluteFill } from "remotion";
import { DM_SANS } from "../theme/fonts";
import { TT_DANGER } from "./SafeArea";

/**
 * DEV-ONLY overlay (never in a real render): draws TikTok's UI "danger zones" as
 * translucent bands so a preview still can confirm the plate content clears the
 * top tabs, the right action rail, and the bottom caption/CTA band. Enabled via
 * <FullVideo debugSafeZones/> and only meaningful in portrait TikTok renders.
 */
const Band: React.FC<{ style: React.CSSProperties; label: string }> = ({ style, label }) => (
  <div
    style={{
      position: "absolute",
      background: "rgba(255,0,64,0.16)",
      outline: "3px dashed rgba(255,0,64,0.75)",
      outlineOffset: -3,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      fontFamily: DM_SANS,
      fontWeight: 800,
      fontSize: 26,
      letterSpacing: 2,
      color: "rgba(140,0,30,0.95)",
      textTransform: "uppercase",
      textAlign: "center",
      ...style,
    }}
  >
    {label}
  </div>
);

export const DebugSafeZones: React.FC = () => (
  <AbsoluteFill style={{ pointerEvents: "none" }}>
    <Band style={{ left: 0, top: 0, width: 1080, height: TT_DANGER.top }} label={`TOP UI · ${TT_DANGER.top}px`} />
    <Band
      style={{ right: 0, top: 0, width: TT_DANGER.right, height: 1920, writingMode: "vertical-rl" }}
      label={`ACTION RAIL · ${TT_DANGER.right}px`}
    />
    <Band style={{ left: 0, bottom: 0, width: 1080, height: TT_DANGER.bottom }} label={`CAPTION / CTA · ${TT_DANGER.bottom}px`} />
  </AbsoluteFill>
);
