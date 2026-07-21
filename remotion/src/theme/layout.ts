import { createContext, createElement, useContext, type ReactNode } from "react";
import { useVideoConfig } from "remotion";
import type { Platform } from "../full/timeline";

/**
 * Format helper. The composition's width/height (from useVideoConfig) is the
 * single source of truth for aspect: landscape 1920x1080 (YouTube long-form) vs
 * portrait 1080x1920 (IG/TikTok shorts). Scenes call `useFmt()` and branch their
 * layout on `portrait` so the SAME component tree re-flows for both aspects
 * (never letterboxed). Landscape values are kept identical to the approved
 * master; portrait gets its own tuned geometry.
 *
 * The active PLATFORM (youtube | instagram | tiktok) is provided by <FullVideo/>
 * via <PlatformProvider/> and surfaced through `useFmt().platform`, so portrait
 * layout can additionally branch per platform (e.g. the TikTok-only bigger,
 * UI-safe plate). Instagram/YouTube read the default and are unchanged.
 */
export type Fmt = "landscape" | "portrait";

/** The render's target platform, provided at the <FullVideo/> root. Defaults to
 *  "instagram" so any tree without a provider behaves exactly as before. */
const PlatformContext = createContext<Platform>("instagram");
export const PlatformProvider: React.FC<{ platform: Platform; children: ReactNode }> = ({ platform, children }) =>
  createElement(PlatformContext.Provider, { value: platform }, children);
export const usePlatform = (): Platform => useContext(PlatformContext);

export type FmtInfo = {
  w: number;
  h: number;
  portrait: boolean;
  fmt: Fmt;
  /** Outer action-safe margin (narrower in portrait). */
  M: number;
  /** Active render platform (from PlatformProvider; "instagram" by default). */
  platform: Platform;
};

export const useFmt = (): FmtInfo => {
  const { width, height } = useVideoConfig();
  const portrait = height > width;
  const platform = usePlatform();
  return { w: width, h: height, portrait, fmt: portrait ? "portrait" : "landscape", M: portrait ? 64 : 110, platform };
};
