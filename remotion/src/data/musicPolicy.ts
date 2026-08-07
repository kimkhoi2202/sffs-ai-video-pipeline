/**
 * musicPolicy.ts — WHICH MUSIC BEDS MAY REACH WHICH PLATFORM.
 *
 * THE RULE (owner's decision, 2026-08-07): the APT bed is permitted on Instagram and
 * TikTok. It must NOT go to YouTube. This is a per-platform rule, not a global ban.
 *
 * WHY IT LIVES HERE, in remotion/src/data, rather than in hermes/src with the rest of
 * the music code. This module is imported by BOTH the Node render path
 * (hermes/src/render.ts, the same way it already imports data/fold.ts) AND the Remotion
 * composition root, which is the one piece of code that every render passes through no
 * matter who launched it. The beds that reached the YouTube queue on 2026-08-07 were
 * rendered by an ad-hoc script that spawned `npx remotion render` directly and never
 * touched hermes/src at all, so a rule stated only on the Node side would not have
 * stopped it. Stated once here, it is enforced on both sides and cannot drift apart.
 *
 * WHY THIS IS NOT COVERED BY THE EXISTING SWITCHES. HERMES_MUSIC_APT,
 * HERMES_MUSIC_APT_YOUTUBE and the manifest's rights.cleared all govern SELECTION —
 * whether a net-new render CHOOSES the alternate bed. None of them governs a bed that
 * was already baked into a stored props sidecar. The catalogue backfill re-renders from
 * those sidecars and never runs selection, so it reproduced APT beds for YouTube while
 * all three switches said no. This rule applies to the bed actually about to be used.
 */

/** The platforms the pipeline renders for. Mirrors full/timeline.ts Platform. */
export type MusicPlatform = "youtube" | "instagram" | "tiktok";

/**
 * Is this bed one of the APT segments?
 *
 * DIRECTORY MEMBERSHIP, NOT A NAME SUBSTRING. The segments live in their own
 * `audio/music/apt/` directory, so the test is "does this path sit in that directory".
 * A substring match on "apt" would also catch a licensed bed called
 * `adaptive-parade.mp3`, and an exact 12-entry list would silently miss a 13th segment
 * if one were ever cut. Accepts either form the pipeline stores: the props form
 * (`apt/apt-05.mp3`) or a full `audio/music/apt/apt-05.mp3` path.
 */
export function isAptBed(music: unknown): boolean {
  const rel = String(music ?? "").trim().replace(/^\/+/, "").replace(/^audio\/music\//, "");
  const parts = rel.split("/");
  return parts.length > 1 && parts[0] === "apt";
}

/** May an APT bed be used on this platform? Everything except YouTube. */
export function aptPermittedOn(platform: unknown): boolean {
  return String(platform ?? "") !== "youtube";
}

/**
 * Is `music` allowed on `platform`? The whole rule in one predicate, so callers on both
 * sides ask the same question rather than each re-deriving it.
 */
export function bedAllowedOn(music: unknown, platform: unknown): boolean {
  return aptPermittedOn(platform) || !isAptBed(music);
}

/** The message both enforcement points raise, so the failure reads the same either way. */
export function forbiddenBedMessage(music: unknown, platform: unknown, id?: string): string {
  return (
    `refusing to render ${id ?? "<unknown id>"} for ${String(platform)}: ` +
    `"${String(music)}" is an APT segment, which must never reach ${String(platform)}. ` +
    `The stored props sidecar is not authority for this — see remotion/src/data/musicPolicy.ts.`
  );
}
