# Repurposing — One Long-Form → Shorts, Carousel & Blog

Every long-form riddle/quiz video is a **content factory**. One puzzle set → many surfaces, each
carrying the **Closer** brand and the **parent-email gate**. This is the PRD's multiplier: produce
once, distribute everywhere.

> **Read with:** [`riddle-video-style-spec.md`](riddle-video-style-spec.md) §9 & §13 (pacing +
> repurposing) · [`compliance.md`](compliance.md) (applies to **every** cut) ·
> [`prompts/asset-prompt-library.md`](prompts/asset-prompt-library.md) (brand-locked assets) ·
> [`prizes.md`](prizes.md).
>
> **Compliance travels with every surface.** Parent-email CTA only, **zero child PII**, CARU-safe,
> **no Alpha branding**, prize mentions link to public rules. Re-check on each format.

---

## 0. Save these while you edit the long-form (repurpose-ready master)

Editing the long-form? Export these as you go so repurposing is assembly, not re-work:

- **Per-round clean stems:** puzzle media panel, question card, countdown, reveal (`mint ✓`/`coral ✗`),
  one-line explain — each as an isolated element/PNG + the VO/beat (see the component library, spec §12.3).
- **Square-safe + vertical-safe framing:** keep the puzzle panel centered so it re-crops to 1:1 / 9:16.
- **VO beats** named per round (`r3-setup`, `r3-reveal`) from ElevenLabs Studio.
- **Thumbnail + hook art**, the score/tier card, and the mascot (reuse everywhere).
- A **captions/subtitle** file (SRT) — most social is watched muted.

---

## 1. Shorts / Reels (9:16 vertical cut-downs)

**Goal:** lift **one strong round** from the long-form, re-crop to vertical, enlarge type, compress
the loop. Auto-spawn **3–6 Shorts per long-form** (best rounds + one "score/CTA" teaser).

### Which beats to keep (and what to cut)

| Keep | Cut |
|---|---|
| **Hook in the first 1–2s** ("Only 7% solve this") | Long intros, channel throat-clearing |
| **One puzzle** (or 3 rapid-fire), one question | Multiple deep rounds, interludes/b-roll |
| **Big Anton number-flex timer** (glanceable) | Small/subtle bar timers, chapter cards |
| **One punchy reveal** (`mint ✓`), one-line explain | Extended explanations, tangents |
| **One CTA = parent-email gate** | Subscribe walls, multi-CTA end screens |

### Beat map (~20–40s)

```
0:00–0:02  HOOK: "Only 7% solve this" — Anton on a flat accent block (thumb-grade)
0:02–0:06  PUZZLE: centered sticker-frame media + Anton question (≤8 words), vertical stack
0:06–0:12  COUNTDOWN: big yellow number-flex, VO "5...4...3...", thinking bed under
0:12–0:16  REVEAL: mint ✓ press-in (coral ✗ on wrong) + big Anton answer, win sting
0:16–0:22  EXPLAIN: one line, mascot reaction
0:22–0:30  CTA: "Ask a grown-up to enter their email to unlock your score" + on-screen URL
```

### Spec

| Property | Value |
|---|---|
| Dimensions | **1080×1920 (9:16)** |
| Length | **20–45s** ideal (≤60s; YouTube Shorts allows more but keep it tight) |
| Hook | **First 1–2s**, on-screen text + VO, thumb-grade |
| Type | Enlarge vs long-form; Anton cap-height big; **burn-in captions** (muted viewing) |
| Timer | **Anton number-flex** (most legible at a glance) |
| CTA | **One** — parent-email gate + on-screen URL/handle |
| Safe zones | Keep text/CTA clear of platform UI: **top ~10%**, **bottom ~20–25%** (captions, handle, buttons), **right ~10%** (action rail) |
| Export | sRGB, H.264 MP4; loud-enough mix (VO over ducked bed) |

**Per-platform notes:** YouTube Shorts (vertical, hashtag `#Shorts` optional, "Made for Kids" flag) ·
Instagram Reels (cover frame = the hook; keep captions above the bottom UI) · TikTok (native captions
+ trending-but-CARU-safe audio; our instrumental is safest). Same master cut, per-platform safe-area
tweak + caption placement.

---

## 2. IG / TikTok carousel (slide breakdown)

**Goal:** a swipeable, muted-friendly version — static brand slides that make the viewer swipe to the
reveal, ending on the parent-email CTA. Works on Instagram (image carousel) and **TikTok Photo Mode**.

### Slide breakdown (7 slides)

| # | Slide | Content (brand) |
|---|---|---|
| 1 | **Hook** (cover/thumb-grade) | Anton "ONLY 7% CAN SOLVE THIS" on a flat accent block + mascot sticker. This is the scroll-stopper. |
| 2 | **Puzzle** | Centered sticker-frame media + Anton question (≤8 words). One accent. |
| 3 | **"Answer on next slide →"** | Big Anton prompt on a color block; a "swipe" chevron sticker. Builds the pause-and-guess beat. |
| 4 | **Reveal** | `mint ✓` badge on the answer + big Anton answer numeral/word. |
| 5 | **Explain** | One-line "why" in DM Sans on paper/cream card + mascot reaction. |
| 6 | **Score tiers** | Anton tier card (e.g. novice / sharp / genius — CARU-safe, non-shaming) with mint/coral recap row. |
| 7 | **Parent CTA** | "Grown-ups: enter your email to unlock the full score + prize entry." URL/handle + link to public prize rules. |

> Optional: expand to 8–10 slides by adding a 2nd/3rd rapid-fire puzzle (repeat slides 2–4).

### Spec

| Property | Value |
|---|---|
| Dimensions | **1080×1350 (4:5)** primary; **1080×1080 (1:1)** alt. Keep one ratio across all slides. |
| Slide count | **6–10** (7 default) |
| Slide 1 | Thumbnail-grade hook (DESIGN.md §9 recipes); ≤6 words, cap-height huge |
| Type | Anton headline per slide, DM Sans body; one dominant accent/slide, **rotate accents** slide-to-slide |
| Safe zones | Keep text ~**64px** from edges; on IG keep clear of the top-right "1/7" dots + bottom caption |
| CTA | **Final slide** = parent-email gate + prize-rules link; repeat handle/URL on slide 1 footer |
| Export | PNG/JPG, sRGB, <8MB each |

**Caption (CARU-safe):** short setup + "Can your brain solve it? Answer inside → Grown-ups, unlock
the full score with your email (link in bio)." Hashtags age-appropriate; **no** "tag 3 friends or
else," **no** false urgency. **No Alpha** anything in caption, bio, or handle.

---

## 3. Blog post (web version)

**Goal:** an SEO-friendly, embeddable write-up that turns search + shares into parent-email captures.

### Structure

1. **Hero image** = the video thumbnail (reuse; add alt text).
2. **Embed the long-form video** near the top.
3. **Hook paragraph** — restate the "only X% solve this" promise in **our own words** (original).
4. **Per-puzzle write-up** — for each round: the setup (our words), the sticker-frame media as an
   inline image, a "think about it" line, then the reveal (`mint ✓`) + a one-line explanation.
   **Never transcribe another creator's riddles/answers** — original only.
5. **Score tiers** section (same tiers as the video, CARU-safe).
6. **Parent-email gate CTA block** — bordered, hard-shadow card: "Grown-ups: enter your email to
   unlock the full brain score + prize entry," with the gate form/link.
7. **Prize section** — brief, parent-facing, linking to the **public prize rules** ([`prizes.md`](prizes.md)).
8. **Related** — links to other Kid Loop posts/videos.

### Spec

| Property | Value |
|---|---|
| Hero / OG image | **1200×630** (social share) + 1280×720 thumbnail reuse |
| Inline images | Puzzle panels + reveal cards (reuse video stems), sRGB, compressed, **descriptive alt text** |
| Length | ~**600–1,200 words**, scannable (Anton H2s, short DM Sans paragraphs, bulleted lists) |
| Hook | First screen: headline + one-line promise **above the fold** + video embed |
| CTA | Parent-email gate block (mid + end) + prize-rules link |
| SEO | Original title/meta, kid-topic keywords, `Made for Kids`/audience-appropriate, fast + mobile-first |
| Brand | Closer tokens for all embedded graphics/CTA cards (Anton + DM Sans, flat palette, hard shadows) |

---

## 4. Per-format spec cheat-sheet

| Format | Dimensions | Length | Hook | Primary CTA |
|---|---|---|---|---|
| **Long-form** (source) | 1920×1080 (16:9) | ~8–15 min (spec §9) | "X% fail" title, first ~15s | Parent-email gate end screen |
| **Shorts / Reels** | 1080×1920 (9:16) | 20–45s | First **1–2s** | Parent-email gate + URL |
| **Carousel** | 1080×1350 (or 1:1) | 6–10 slides | Slide 1 (thumb-grade) | Final slide = parent-email + prize rules |
| **Blog** | 1200×630 OG + inline | 600–1,200 words | Above-fold headline + embed | Parent-email gate block + prize link |
| **Thumbnail** | 1280×720 | still | ≤6 words, cap-height ≥90px | (drives the click) |

---

## 5. Repurposing workflow

1. **Master done + CARU-cleared.** Only repurpose an approved long-form.
2. **Pick the Shorts rounds** (3–6 strongest) → cut, re-crop 9:16, enlarge type, burn captions, one CTA.
3. **Build the carousel** from the same rounds (slides 1–7) → export per platform ratio.
4. **Write the blog** (original write-ups) → embed video, place gate CTA + prize link, add alt text.
5. **Localize CTAs/captions per platform** safe zones; keep handle/URL consistent (brandless).
6. **Re-run compliance per surface** (§6) before scheduling.
7. **Schedule + cross-link** (blog ↔ video ↔ social) so every surface funnels to the same gate.

## 6. Per-surface compliance re-check (do this for EVERY cut)

- [ ] CTA is a **parent-email** action ("ask a grown-up…") — no child data asked on any surface.
- [ ] **Zero child PII** in cut, caption, alt text, bio, handle, or metadata.
- [ ] **No Alpha** name/logo/color/URL anywhere (incl. captions, hashtags, blog embeds).
- [ ] Prize mentions link to **public rules** (parent-facing) — [`prizes.md`](prizes.md).
- [ ] CARU-safe: hook stays about the **puzzle** ("X% fail" is fine), never about the product or the
      viewer's outcome (`compliance.md` §3); no false urgency, no "tag/nag friends," non-shaming
      tiers, non-scary.
- [ ] Puzzles/copy/music **original** (or licensed); on-brand tokens (Anton/DM Sans, flat palette, hard shadows).
- [ ] Platform kids'/audience flags set correctly per surface.

---

### Related docs
[`README.md`](README.md) · [`riddle-video-style-spec.md`](riddle-video-style-spec.md) ·
[`compliance.md`](compliance.md) · [`prizes.md`](prizes.md) ·
[`prompts/asset-prompt-library.md`](prompts/asset-prompt-library.md)
