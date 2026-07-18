import { useVideoConfig } from "remotion";

/**
 * Format helper. The composition's width/height (from useVideoConfig) is the
 * single source of truth for aspect: landscape 1920x1080 (YouTube long-form) vs
 * portrait 1080x1920 (IG/TikTok shorts). Scenes call `useFmt()` and branch their
 * layout on `portrait` so the SAME component tree re-flows for both aspects
 * (never letterboxed). Landscape values are kept identical to the approved
 * master; portrait gets its own tuned geometry.
 */
export type Fmt = "landscape" | "portrait";

export type FmtInfo = {
  w: number;
  h: number;
  portrait: boolean;
  fmt: Fmt;
  /** Outer action-safe margin (narrower in portrait). */
  M: number;
};

export const useFmt = (): FmtInfo => {
  const { width, height } = useVideoConfig();
  const portrait = height > width;
  return { w: width, h: height, portrait, fmt: portrait ? "portrait" : "landscape", M: portrait ? 64 : 110 };
};
