#!/usr/bin/env node
/**
 * render-carousel.ts — render a carousel spec (content/carousels/carousel-NNN.json)
 * to slide PNGs, mirroring the video render convention (renders.nosync/videos/...).
 *
 * A spec is one JSON file: { carousel, slug, title, family, props, caption, ... }
 * (see content/schema/carousel.schema.json). The composition id derives from
 * family ("rebus" -> RebusCarousel), the slide count from the props (same
 * slidePlan logic as the composition), and each slide renders via
 * `npx remotion still --frame=N` with cwd=remotion/.
 *
 * USAGE
 *   node tools/render-carousel.ts <spec.json> [more-specs.json...]
 *   node tools/render-carousel.ts content/carousels/carousel-*.json
 *
 * OUTPUT (mirrors renders.nosync/videos/<...>/<slug>/)
 *   renders.nosync/carousels/<slug>/slide-N.png   (gitignored — heavy, regenerable)
 *   renders.nosync/carousels/<slug>/props.json    (tracked — the render input)
 *   renders.nosync/carousels/<slug>/info.md       (tracked — human card)
 *   renders.nosync/carousels/manifest.json        (tracked — index of all carousels)
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "..");
const REMOTION_DIR = join(REPO, "remotion");
const OUT_ROOT = join(REPO, "renders.nosync", "carousels");
const MANIFEST = join(OUT_ROOT, "manifest.json");

const ENTRIES: Record<string, { entry: string; compId: string }> = {
  rebus: { entry: "hermes/carousel-entry.tsx", compId: "RebusCarousel" },
};

// Slides occupy SLIDE_PERIOD-frame blocks so shared video springs settle; grab
// the still at each block's LAST frame. Keep in sync with RebusCarousel.
const SLIDE_PERIOD = 60;
const settledFrame = (slide: number) => slide * SLIDE_PERIOD + SLIDE_PERIOD - 1;

/** Mirrors RebusCarousel.slidePlan: puzzle slide each (skipped when answerOnly),
 *  reveal slide if reveal|answerOnly, +outro. */
function slideCount(family: string, props: any): number {
  if (family === "rebus") {
    let n = 1; // outro
    for (const p of props.puzzles ?? []) {
      if (!p.answerOnly) n += 1; // puzzle slide
      if (p.reveal || p.answerOnly) n += 1; // reveal slide
    }
    return n;
  }
  throw new Error(`unknown family: ${family}`);
}

/** One markdown card per carousel, mirroring renders.nosync/videos/.../info.md. */
function infoMd(spec: any, slides: number): string {
  const { slug, title, family, status, hashtagSet, caption, props } = spec;
  const puzzles = props.puzzles ?? [];
  const rows = puzzles
    .map((p: any, i: number) => {
      const shown = p.answerOnly ? "answer-only" : "puzzle";
      const reveal = p.reveal || p.answerOnly ? "yes" : "no";
      return `| ${i + 1} | ${shown} | ${reveal} | ${p.answer} |`;
    })
    .join("\n");
  return `# ${title}

- **Slug:** ${slug}
- **Family:** ${family}
- **Aspect:** 4:5 (1080x1350)
- **Slides:** ${slides} (${puzzles.length} puzzles + reveals + outro)
- **Status:** ${status}
- **Hashtag set:** ${hashtagSet}
- **Prompt:** ${props.prompt}

## Caption

${caption}

## Puzzles (slide order)

| # | Slide | Reveal | Answer |
|---|-------|--------|--------|
${rows}

## Files
- \`slide-N.png\` — the rendered carousel slides (gitignored; regenerable).
- \`props.json\` — the render input (the spec's \`props\`).
- \`info.md\` — this card.
`;
}

/** Rebuild renders.nosync/carousels/manifest.json from every rendered carousel
 *  dir that has a props.json, mirroring renders.nosync/videos/manifest.json. */
function rebuildManifest(): void {
  const entries: any[] = [];
  // Discover from the content specs so the manifest is deterministic.
  const specDir = join(REPO, "content", "carousels");
  const specs = existsSync(specDir)
    ? readdirSync(specDir).filter((f) => /^carousel-\d+\.json$/.test(f)).sort()
    : [];
  for (const f of specs) {
    const spec = JSON.parse(readFileSync(join(specDir, f), "utf8"));
    const dir = join(OUT_ROOT, spec.slug);
    if (!existsSync(join(dir, "props.json"))) continue; // not rendered yet
    entries.push({
      slug: spec.slug,
      dir: spec.slug,
      family: spec.family,
      title: spec.title,
      slides: slideCount(spec.family, spec.props),
      status: spec.status,
      hashtagSet: spec.hashtagSet,
    });
  }
  mkdirSync(OUT_ROOT, { recursive: true });
  writeFileSync(MANIFEST, JSON.stringify({ carousels: entries }, null, 2) + "\n");
  process.stderr.write(`[render-carousel] manifest: ${entries.length} carousels -> ${MANIFEST}\n`);
}

function renderSpec(specPath: string): void {
  const spec = JSON.parse(readFileSync(specPath, "utf8"));
  const { slug, family, props } = spec;
  if (!slug || !family || !props) throw new Error(`${specPath}: spec needs slug, family, props`);
  const target = ENTRIES[family];
  if (!target) throw new Error(`${specPath}: no composition registered for family "${family}"`);

  const outDir = join(OUT_ROOT, slug);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  // remotion still reads props from a file; drop it next to the renders (tracked).
  const propsFile = join(outDir, "props.json");
  writeFileSync(propsFile, JSON.stringify(props));

  const n = slideCount(family, props);
  for (let f = 0; f < n; f++) {
    const out = join(outDir, `slide-${f + 1}.png`);
    process.stderr.write(`[render-carousel] ${slug}: slide ${f + 1}/${n}\n`);
    execFileSync(
      process.platform === "win32" ? "npx.cmd" : "npx",
      ["remotion", "still", target.entry, target.compId, out, `--frame=${settledFrame(f)}`, `--props=${propsFile}`],
      { cwd: REMOTION_DIR, stdio: ["ignore", "ignore", "inherit"], shell: process.platform === "win32" },
    );
  }

  // human card + refreshed index (mirrors the video render sidecars)
  writeFileSync(join(outDir, "info.md"), infoMd(spec, n));
  console.log(`${slug}: ${n} slides -> ${outDir}`);
}

const specs = process.argv.slice(2);
if (!specs.length) {
  console.error("usage: render-carousel.ts <spec.json> [...]");
  process.exit(2);
}
for (const s of specs) renderSpec(s);
rebuildManifest();
