#!/usr/bin/env python3
"""
Render the FLAGSHIP Gemini-voiced master quiz video -- Round 15, "15-Question
CogAT" (Grade 5 / Level 11 calibration), with an ANIMATED BRANDED INTRO.

Reuses the established Round-01..05 pipeline verbatim (imports the shared brand
plate module render_demo_quiz.py READ-ONLY -- nothing in it is modified):
  - on-brand Pillow plates (Anton + DM Sans, thick pure-black borders, HARD
    zero-blur offset shadows, rotating color blocks, mint check reveals),
    supersampled for crisp anti-aliasing (QUIZ_SS=4),
  - narration from Gemini TTS (gemini-2.5-pro-preview-tts, voice "Puck") via the
    gateway in gen_vo.sh (API key loaded from .env.local, NEVER printed),
  - a light tick bed under each countdown + a soft ding under each reveal,
  - a ducked music arc (Game Show Fanfare -> Prize Wheel Parade bed -> Winner
    Spin) sidechained ~12 dB under the VO, then an HQ libx264 crf16/slow encode.

THE KEY NEW PIECE -- ANIMATED BRANDED INTRO (matches the WEBSITE HERO):
  The opening title is drawn HERE in ANTON (vendored at tools/fonts/Anton-
  Regular.ttf) to MATCH components/quiz/smart-fart-hero.tsx: "SMART FELLA" in
  brand BLUE and "FART SMELLA?" in brand CORAL, each with a ~3px BLACK outline
  and a TIGHT black extruded drop shadow (0.04em, hard, down-right); "OR" is a
  small WHITE pill with a 2.5px black border + a hard black offset shadow. The
  field is the hero's YELLOW synthwave grid (bg-yellow + a perspective floor).
  Everything is supersampled (TITLE_SS) then LANCZOS-downscaled so edges stay
  crisp. The brand brain-mascot logo (video/assets/sffs-logo.png) pops in AT THE
  STAR's position (upper-right, at the end of SMART FELLA / above-right of FART
  SMELLA) -- THERE IS NO STAR. Choreography (easeOutCubic/easeOutBack): SMART
  FELLA rises up, OR pops (back-eased), FART SMELLA rises up, the logo pops in,
  then the title HOLDS for the intro VO. render_title_animation() is the reusable
  segment; render_intro_sample() renders the phase-1 approval clip.

CONTENT -- the 15 curated CogAT-style items in video/content/cogat-round-15.md,
in order, spanning the three CogAT batteries (Verbal 6 / Quant 6 / Nonverbal 3).
GRADE-5 CALIBRATION -- per video/content/cogat-timing-difficulty.md, each item
uses its "Video (L11)" countdown + Grade-5 difficulty. IMPORTANT SWAP: Q14, the
cubes item (5 -> 125, an above-Grade-5 exponent concept), is REPLACED by the
calibration's Grade-5 number-analogy swap "2->5, 3->7, 4->9, 5->?" = 11
(x2 + 1 rule). The three nonverbal items reuse drawing helpers COPIED here from
the sibling orchestrators (polygon-sides from _03, empty->filled shading from
_04, dot-position from _05) -- those files are NOT edited.

Collision-safety: this file writes ONLY its own artifacts (/tmp/r15_work,
/tmp/vo_r15, /tmp/r15_*.png, video/renders/round-15-cogat-master.mp4). The
shared module, sibling orchestrators, music, and title chunks are read-only.

Steps (run in order):
  render_cogat_round_15.py frames   # animated title + all PNGs / countdowns (SSAA)
  render_cogat_round_15.py bodies   # write Gemini TTS request bodies (no API key)
  # ...then the wavs:
  #   set -a; . .env.local; set +a
  #   VO_BODIES=/tmp/vo_r15/bodies VO_OUT=/tmp/vo_r15 bash video/tools/gen_vo.sh
  render_cogat_round_15.py build    # size to VO, per-seg HQ clips, concat -> A/V master
  render_cogat_round_15.py music    # ducked music bed, mux, verify, sample frames
"""
import contextlib
import json
import math
import os
import re
import shutil
import subprocess
import sys
import wave

from PIL import Image, ImageChops, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("QUIZ_SS", "4")  # crisp supersampled anti-aliasing
import render_demo_quiz as R  # noqa: E402  (shared brand toolkit; READ-ONLY)

FF = "/opt/homebrew/bin/ffmpeg"
FP = "/opt/homebrew/bin/ffprobe"
ROOT = "/Users/khoilam/Documents/Crossover/30mpc-website-design-cursor"

# --- Round-15 private scratch space (collision-free vs sibling round workers) ---
WORK = "/tmp/r15_work"
FRAMES = f"{WORK}/frames"
CLIPS = f"{WORK}/clips"
TITLE_FRAMES = f"{FRAMES}/title"        # animated-intro frame sequence
VO = "/tmp/vo_r15"
BODIES = f"{VO}/bodies"
META = f"{WORK}/meta.json"
CONCAT_AV = os.environ.get("R15_CONCAT_AV", f"{WORK}/round-15-concat.mp4")   # HQ video + baked VO/SFX audio
# OUT is env-overridable so an alternate narration source (e.g. the ElevenLabs
# re-render) can write a NEW deliverable without clobbering the Gemini master.
OUT = os.environ.get("R15_OUT", f"{ROOT}/video/renders/round-15-cogat-master.mp4")
# PHASE-1 approval clip: the new real-font animated intro only (silent, no full render).
INTRO_SAMPLE = f"{ROOT}/video/renders/round-15-intro-sample.mp4"

# The user's transparent title chunks -- read IN PLACE, never moved/altered.
TITLE_DIR = f"{ROOT}/video/assets/title"
TITLE_SMART = f"{TITLE_DIR}/smart-fella.png"
TITLE_OR = f"{TITLE_DIR}/or.png"
TITLE_FART = f"{TITLE_DIR}/fart-smella.png"

# The user's music assets -- read IN PLACE, never moved/altered.
MUSIC_DIR = "/Users/khoilam/Documents/Crossover/Smart Fella Video Campaign/Audio Assets/Music"
FANFARE = f"{MUSIC_DIR}/Game Show Fanfare.mp3"
PARADE = f"{MUSIC_DIR}/Prize Wheel Parade (1).mp3"
WINNER = f"{MUSIC_DIR}/Winner Spin.mp3"

MODEL = "gemini-2.5-pro-preview-tts"
VOICE = "Puck"  # upbeat Gemini prebuilt voice -> game-show host energy

# Natural-language style directives. Gemini TTS interprets (does NOT speak) the
# text before the colon -- it shapes prosody without altering the spoken words.
HOST = "Read this like a high-energy, upbeat TV game-show host, fast and punchy"
REVEAL = "Read this like a game-show host cheerfully revealing the answer"
URGENT = "Shout this with urgent, excited game-show energy"
WARM = "Read this warmly and invitingly, like a friendly game-show host"

# key -> (style, spoken line). Fresh, ORIGINAL Round-15 narration.
NARR = {
    "intro": (HOST,
              "Are you a smart fella... or a fart smella? Welcome to the "
              "ultimate brain showdown! Fifteen brand-new reasoning puzzles: "
              "words, numbers, and shapes, all sized up for grade five. You'll "
              "beat the clock, keep score, and find out just how big that "
              "beautiful brain really is. Thinking caps on... let's play!"),
    # ---- the 15 questions ----
    "q1": (HOST,
           "Question one! Which one does NOT belong? Robin... sparrow... "
           "salmon... eagle. Is it A, robin... B, sparrow... C, salmon... or "
           "D, eagle? Five seconds, go!"),
    "q2": (HOST,
           "Question two, a number series! Three, six, twelve, twenty-four, and "
           "then... what comes next? A, thirty-six... B, forty-eight... C, "
           "thirty... or D, forty-two? Five seconds!"),
    "q3": (HOST,
           "Question three, a picture puzzle! An empty circle becomes a "
           "filled-in circle. So an empty square becomes... which one? A, a "
           "filled square... B, an empty square... C, a filled circle... or D, "
           "a filled triangle? Six seconds!"),
    "q4": (HOST,
           "Question four, a word analogy! Giant is to tiny, as wide is to... "
           "what? A, narrow... B, tall... C, long... or D, big? Five seconds, "
           "go!"),
    "q5": (HOST,
           "Question five, another number series! One hundred, ninety-two, "
           "eighty-four, seventy-six, and then... what? A, seventy... B, "
           "sixty-eight... C, sixty-six... or D, seventy-two? Five seconds!"),
    "q6": (HOST,
           "Question six, a word analogy! Ocean is to puddle, as mountain is "
           "to... what? A, valley... B, hill... C, river... or D, rock? Five "
           "seconds!"),
    "q7": (HOST,
           "Question seven, and this one is tricky! Two, six, twelve, twenty, "
           "thirty, and then... what comes next? A, thirty-six... B, forty... "
           "C, forty-two... or D, forty-four? Seven seconds on the clock!"),
    "q8": (HOST,
           "Question eight, a word analogy! Painter is to brush, as carpenter "
           "is to... what? A, hammer... B, wood... C, house... or D, nail? "
           "Five seconds!"),
    "q9": (HOST,
           "Question nine, a number series! One, one, two, three, five, eight, "
           "and then... what comes next? A, eleven... B, thirteen... C, "
           "twelve... or D, sixteen? Seven seconds!"),
    "q10": (HOST,
            "Question ten! Which one does NOT belong? Add... subtract... "
            "multiply... number. A, add... B, subtract... C, multiply... or D, "
            "number? Five seconds!"),
    "q11": (HOST,
            "Question eleven, a shape puzzle! Watch them grow, gaining one side "
            "each step: a triangle, then a square, then a pentagon. Which shape "
            "comes next? A, a circle... B, a hexagon... C, a square... or D, an "
            "octagon? Seven seconds!"),
    "q12": (HOST,
            "Question twelve, fill in the blank! The bridge was too weak to "
            "hold the heavy truck, so workers had to blank it before opening "
            "the road. A, decorate... B, reinforce... C, rename... or D, "
            "measure? Six seconds!"),
    "q13": (HOST,
            "Question thirteen, a picture puzzle! A dot marches clockwise "
            "around a square: top-left, top-right, bottom-right... where does "
            "it jump next? A, top-left... B, bottom-left... C, top-right... or "
            "D, the center? Seven seconds!"),
    "q14": (HOST,
            "Question fourteen, a number analogy! Two makes five, three makes "
            "seven, four makes nine, so five makes... what? A, ten... B, "
            "eleven... C, twelve... or D, thirteen? Six seconds!"),
    "q15": (HOST,
            "Last one, question fifteen, a number puzzle, and it's sneaky! If "
            "four plus five makes twenty, three plus six makes eighteen, and "
            "two plus seven makes fourteen... then five plus four makes... "
            "what? A, nine... B, eighteen... C, twenty... or D, twenty-five? "
            "Seven seconds!"),
    "timesup": (URGENT, "Time's up! Pencils down!"),
    # ---- the 15 reveals ----
    "r1": (REVEAL,
           "The answer is C, salmon! A robin, a sparrow, and an eagle all soar "
           "through the sky as birds. But a salmon? That one swims. It's a "
           "fish!"),
    "r2": (REVEAL,
           "It's B, forty-eight! Each number simply doubles: three, six, "
           "twelve, twenty-four... and twenty-four times two is forty-eight!"),
    "r3": (REVEAL,
           "The answer is A, a filled square! The rule is simple: the shape "
           "gets colored in, but stays the very same shape. Empty square "
           "becomes filled square!"),
    "r4": (REVEAL,
           "It's A, narrow! Giant and tiny are opposites, so just flip 'wide' "
           "to its opposite, and that's narrow!"),
    "r5": (REVEAL,
           "The answer is B, sixty-eight! Every step drops by eight, and "
           "seventy-six minus eight is sixty-eight!"),
    "r6": (REVEAL,
           "It's B, hill! An ocean shrinks down to a tiny puddle, so a mountain "
           "shrinks down to a little hill. Same thing, pocket-sized!"),
    "r7": (REVEAL,
           "The answer is C, forty-two! Look at the jumps: plus four, plus six, "
           "plus eight, plus ten. The next jump is plus twelve, and thirty plus "
           "twelve is forty-two!"),
    "r8": (REVEAL,
           "It's A, hammer! A painter's tool is a brush, and a carpenter's tool "
           "is a hammer. Wood is just the material, and a house is what you "
           "build!"),
    "r9": (REVEAL,
           "The answer is B, thirteen! Add the two numbers before it: five plus "
           "eight is thirteen. That's the famous Fibonacci pattern!"),
    "r10": (REVEAL,
            "It's D, number! Add, subtract, and multiply are all things you do. "
            "But a number? That's the thing you do them to!"),
    "r11": (REVEAL,
            "The answer is B, hexagon! Count the sides: triangle three, square "
            "four, pentagon five... so next up is the six-sided hexagon!"),
    "r12": (REVEAL,
            "It's B, reinforce! Too weak means you have to make it stronger, "
            "and reinforce is the only word that fixes the problem!"),
    "r13": (REVEAL,
            "The answer is B, bottom-left! The dot steps clockwise, corner to "
            "corner, and right after bottom-right, the next corner is "
            "bottom-left!"),
    "r14": (REVEAL,
            "It's B, eleven! Each number is doubled, then add one. Five times "
            "two is ten, plus one is eleven!"),
    "r15": (REVEAL,
            "The answer is C, twenty! Here's the trick: that plus sign secretly "
            "means multiply. Four times five is twenty, so five times four is "
            "twenty too!"),
    "score": (HOST,
              "So, how did you do? Thirteen or more out of fifteen? Take a bow, "
              "you are a certified smart fella! Eight to twelve, you're one "
              "seriously sharp cookie. Seven or fewer? Hey, every champion "
              "starts out a rookie riddler!"),
    "outro": (WARM,
              "Want to see your full results and how you stack up? Just ask a "
              "parent or guardian to pop their email onto the screen. There are "
              "five hundred dollar and two thousand dollar prizes up for grabs, "
              "for the grown-ups! Check the official rules, and we'll see you "
              "next time!"),
}

# =========================================================================
#  ANIMATED BRANDED INTRO  (rebuilt to MATCH THE WEBSITE HERO -- real-font,
#  crisp typography; no raster title chunks). "SMART FELLA / OR / FART SMELLA?"
#  is rendered HERE in ANTON (vendored at tools/fonts/Anton-Regular.ttf) exactly
#  like components/quiz/smart-fart-hero.tsx: BLUE + CORAL words with a black
#  outline and a TIGHT black extruded shadow, a small WHITE "OR" pill, over the
#  hero's YELLOW synthwave-grid floor -- supersampled + LANCZOS-downscaled so
#  edges stay crisp. The brand brain-mascot logo pops in AT THE STAR's position
#  (upper-right, end of SMART FELLA / above-right of FART SMELLA). NO STAR.
#
#  Choreography (snappy, staggered, easeOutCubic/easeOutBack): SMART FELLA rises
#  up, OR pops in (back-eased rotate), FART SMELLA rises up, then the mascot logo
#  pops/spins in at the star spot -- then the assembled title HOLDS (under the
#  intro VO in the full render). render_title_animation() is the reusable segment
#  the full re-render imports UNCHANGED; render_intro_sample() renders the short
#  approval clip (video/renders/round-15-intro-sample.mp4).
# =========================================================================
TITLE_FONT = os.path.join(HERE, "fonts", "Anton-Regular.ttf")  # vendored Anton
LOGO_PATH = f"{ROOT}/video/assets/sffs-logo.png"               # brain mascot (RGBA)

TITLE_SS = 3                       # title-frame supersample (SSAA) -> crisp downscale
TITLE_OS = 1.18                    # master oversample headroom (covers pop overshoot)

# --- WEBSITE-HERO look (matched to components/quiz/smart-fart-hero.tsx) ------
# "SMART FELLA" is brand BLUE, "FART SMELLA?" is brand CORAL, both in ANTON with
# a black outline (-webkit-text-stroke:3px #000) and a TIGHT black extruded drop
# shadow (text-shadow 0.04em 0.04em 0 #000 -- hard, zero-blur, down-right). "OR"
# is a small WHITE pill with a 2.5px black border + hard black offset shadow
# (shadow-hard-sm). Background is the YELLOW synthwave-grid floor (bg-yellow +
# the rotateX perspective grid). NO purple, NO yellow text shadow.
SMART_COLOR = R.BLUE               # --color-blue  #839aff
FART_COLOR = R.CORAL               # --color-coral #fd7962
TITLE_OUTLINE = R.INK              # -webkit-text-stroke:3px #000
TITLE_SHADOW = R.INK               # text-shadow 0.04em 0.04em 0 #000 (hard, down-right)
OUTLINE_FRAC = 0.022               # ~3px black outline, proportional to cap
SHADOW_FRAC = 0.040                # 0.04em hard extruded shadow (x == y, down-right)
FLOOR_YELLOW = R.YELLOW            # --color-yellow #fce552 field
FLOOR_HORIZON = 0.34               # grid horizon = hero perspective-origin 50% 34%
FLOOR_LINE_ALPHA = 23              # ~0.09 black grid lines (hero .fella-floor opacity)

ANIM_SECONDS = 2.4                 # assemble time; then holds for the intro VO

# Stacked + centered like the hero: SMART FELLA (top) / OR pill (middle) /
# FART SMELLA? (bottom). The brain mascot logo sits upper-right EXACTLY where
# the star sits in the reference (end/right of SMART FELLA, above-right of FART
# SMELLA). cap = Anton font size (logical 1920x1080 px).
TITLE_LINES = {
    "smart": dict(text="SMART FELLA", color=SMART_COLOR, cap=208, cx=918, cy=322),
    "fart":  dict(text="FART SMELLA?", color=FART_COLOR, cap=208, cx=944, cy=768),
}
OR_CFG = dict(cap=102, cx=918, cy=548)       # small white pill (hero connector)
# Logo sits ON TOP of the "?" in "FART SMELLA?" (painted last -> above the text):
# pulled left so its lower-left visibly OVERLAPS the "?"s upper-right (FART tile
# ends ~x=1526, glyph ~x=1510) and raised toward the line top (~y=653), settling
# at a jaunty clockwise (right-leaning) tilt. Fine-tuned to keep the "?" readable.
LOGO_CFG = dict(cx=1530, cy=645, size=286)
LOGO_TILT = 12.0                             # resting CLOCKWISE (right-lean) tilt, deg

# Per-element choreography: (start_s, dur_s, mode). Snappy staggered entrance.
TITLE_ANIM = {
    "smart": (0.08, 0.58, "riseup"),   # SMART FELLA rises up into place
    "or":    (0.66, 0.46, "poprot"),   # OR pops (back-eased, slight rotate)
    "fart":  (1.05, 0.58, "riseup"),   # FART SMELLA? rises up into place
    "logo":  (1.60, 0.70, "logopop"),  # logo pops in at the star spot
}
TITLE_ORDER = ["smart", "or", "fart", "logo"]   # back-to-front paint order


def _clamp01(x):
    return 0.0 if x < 0.0 else (1.0 if x > 1.0 else x)


def _ease_out_cubic(x):
    x = _clamp01(x)
    return 1.0 - (1.0 - x) ** 3


def _ease_out_back(x):
    x = _clamp01(x)
    c1 = 1.70158
    c3 = c1 + 1.0
    return 1.0 + c3 * (x - 1.0) ** 3 + c1 * (x - 1.0) ** 2


def _title_background(w, h):
    """Flat brand-yellow field (the hero's bg-yellow). The floating neo-brutalist
    shapes are drawn per-frame on top (see _draw_hero_shapes); NO synthwave grid."""
    return Image.new("RGB", (w, h), FLOOR_YELLOW)


# --- WEBSITE-HERO floating shapes (replace the grid) -------------------------
# Five neo-brutalist shapes (black border + hard offset shadow, colors that avoid
# the yellow field) scattered around the title, each slowly rotating + gently
# floating on its own speed/direction. Positions hug the corners so they never
# cover the title text or the tilted logo.
BLOB_RADII = [1.0, 0.88, 1.07, 0.9, 1.09, 0.86, 1.02, 0.9, 1.06, 0.88, 1.08, 0.92]
HERO_SHAPES = [
    dict(kind="circle",   cx=232,  cy=212, size=252, color=R.BLUE,  tilt=0,   rot=6,  amp=20, hz=0.13, ph=0.0),
    dict(kind="rsquare",  cx=1698, cy=206, size=196, color=R.CORAL, tilt=-10, rot=9,  amp=16, hz=0.12, ph=1.1),
    dict(kind="blob",     cx=250,  cy=880, size=300, color=R.MINT,  tilt=0,   rot=-7, amp=22, hz=0.10, ph=2.0),
    dict(kind="triangle", cx=176,  cy=556, size=168, color=R.CORAL, tilt=8,   rot=11, amp=15, hz=0.16, ph=0.6),
    dict(kind="pill",     cx=1690, cy=906, w=250, h=104, color=R.PAPER, tilt=8, rot=-8, amp=17, hz=0.13, ph=1.6),
]


def _shape_poly(kind, cx, cy, half):
    if kind == "triangle":
        return [(cx, cy - half), (cx + half * 0.92, cy + half * 0.72),
                (cx - half * 0.92, cy + half * 0.72)]
    pts = []
    m = len(BLOB_RADII)
    for i, rf in enumerate(BLOB_RADII):
        a = 2 * math.pi * i / m
        pts.append((cx + half * rf * math.cos(a), cy + half * rf * math.sin(a)))
    return pts


def _make_shape_tile(sp, ss):
    """Prebuild one shape as an upright RGBA tile at `ss` scale, with a baked hard
    black offset shadow (zero blur) + thick black border (rotated per frame later)."""
    if sp["kind"] == "pill":
        hw, hh = sp["w"] / 2.0, sp["h"] / 2.0
    else:
        hw = hh = sp["size"] / 2.0
    HW, HH = hw * ss, hh * ss
    border = max(2, int(round(max(hw, hh) * 0.11 * ss)))
    shoff = int(round(max(hw, hh) * 0.15 * ss))
    pad = shoff + border + 6
    Wt = int(round(2 * max(HW, HH))) + 2 * pad
    tile = Image.new("RGBA", (Wt, Wt), (0, 0, 0, 0))
    d = ImageDraw.Draw(tile)
    cx = cy = Wt / 2.0

    def _draw(dx, dy, fill, outline=None, width=0):
        k = sp["kind"]
        if k == "circle":
            d.ellipse([cx - HW + dx, cy - HH + dy, cx + HW + dx, cy + HH + dy],
                      fill=fill, outline=outline, width=width)
        elif k == "rsquare":
            d.rounded_rectangle([cx - HW + dx, cy - HH + dy, cx + HW + dx, cy + HH + dy],
                                radius=int(HW * 0.30), fill=fill, outline=outline, width=width)
        elif k == "pill":
            d.rounded_rectangle([cx - HW + dx, cy - HH + dy, cx + HW + dx, cy + HH + dy],
                                radius=int(HH), fill=fill, outline=outline, width=width)
        else:  # triangle / blob polygon
            d.polygon(_shape_poly(k, cx + dx, cy + dy, HW), fill=fill,
                      outline=outline, width=width)

    _draw(shoff, shoff, R.INK)                        # hard offset shadow, zero blur
    _draw(0, 0, sp["color"], outline=R.INK, width=border)
    return tile


def _hero_shapes():
    """Build every shape tile once (rotated/positioned per frame in _draw_hero_shapes)."""
    return [dict(sp, tile=_make_shape_tile(sp, TITLE_SS)) for sp in HERO_SHAPES]


def _draw_hero_shapes(frame_ss, shapes, t):
    """Composite the floating shapes onto the supersampled frame at time t: each
    rotates (tilt + rot*t) and bobs vertically (amp*sin) at its own speed."""
    for sp in shapes:
        ang = sp["tilt"] + sp["rot"] * t
        fy = sp["amp"] * math.sin(2 * math.pi * sp["hz"] * t + sp["ph"])
        im = sp["tile"].rotate(ang, expand=True, resample=Image.BICUBIC)
        cxp = sp["cx"] * TITLE_SS
        cyp = (sp["cy"] + fy) * TITLE_SS
        frame_ss.paste(im, (int(round(cxp - im.width / 2)),
                            int(round(cyp - im.height / 2))), im)


def _render_text_master(text, cap, fill):
    """One crisp Anton line as an RGBA master tile, HERO-styled: a TIGHT black
    extruded drop shadow (0.04em, down-right, zero blur) behind a `fill`-colored
    (blue/coral) fill + ~3px black outline. Rasterized at cap*TITLE_SS*TITLE_OS
    so every per-frame LANCZOS downscale stays crisp. Returns (master, lw, lh)."""
    m = TITLE_SS * TITLE_OS
    fpx = max(4, int(round(cap * m)))
    stroke = max(1, int(round(cap * OUTLINE_FRAC * m)))
    soff = int(round(cap * SHADOW_FRAC * m))
    font = ImageFont.truetype(TITLE_FONT, fpx)
    probe = ImageDraw.Draw(Image.new("RGBA", (4, 4)))
    l, t, r, b = probe.textbbox((0, 0), text, font=font, stroke_width=stroke)
    tw, th = r - l, b - t
    pad = stroke + int(round(cap * 0.05 * m))
    Wm = tw + 2 * pad + soff
    Hm = th + 2 * pad + soff
    master = Image.new("RGBA", (Wm, Hm), (0, 0, 0, 0))
    d = ImageDraw.Draw(master)
    ox, oy = pad - l, pad - t
    # tight black extruded shadow (outlined silhouette), down-right, zero blur
    d.text((ox + soff, oy + soff), text, font=font, fill=TITLE_SHADOW,
           stroke_width=stroke, stroke_fill=TITLE_SHADOW)
    # main: brand fill (blue/coral) + ~3px black outline on top
    d.text((ox, oy), text, font=font, fill=fill,
           stroke_width=stroke, stroke_fill=TITLE_OUTLINE)
    return master, Wm / m, Hm / m


def _render_or_master(cap):
    """The middle "OR" as the hero's small WHITE pill: paper fill, ~2.5px black
    border, a hard black offset shadow (shadow-hard-sm), with a black Anton "OR"
    centered (no stroke -- matches the hero). Returns (master, lw, lh)."""
    m = TITLE_SS * TITLE_OS
    fpx = max(4, int(round(cap * m)))
    soff = int(round(cap * 0.11 * m))              # hard offset shadow (~4px)
    border = max(2, int(round(cap * 0.062 * m)))   # ~2.5px hero border
    font = ImageFont.truetype(TITLE_FONT, fpx)
    probe = ImageDraw.Draw(Image.new("RGBA", (4, 4)))
    l, t, r, b = probe.textbbox((0, 0), "OR", font=font)
    tw, th = r - l, b - t
    pad_x = int(round(cap * 0.44 * m))
    pad_y = int(round(cap * 0.18 * m))
    pill_w, pill_h = tw + 2 * pad_x, th + 2 * pad_y
    rad = pill_h // 2
    Wm = pill_w + 2 * border + soff
    Hm = pill_h + 2 * border + soff
    master = Image.new("RGBA", (Wm, Hm), (0, 0, 0, 0))
    d = ImageDraw.Draw(master)
    x0, y0 = border, border
    x1, y1 = x0 + pill_w, y0 + pill_h
    d.rounded_rectangle([x0 + soff, y0 + soff, x1 + soff, y1 + soff], radius=rad,
                        fill=R.INK)
    d.rounded_rectangle([x0, y0, x1, y1], radius=rad, fill=R.PAPER,
                        outline=R.INK, width=border)
    d.text(((x0 + x1) / 2, (y0 + y1) / 2), "OR", font=font, fill=R.INK,
           anchor="mm")
    return master, Wm / m, Hm / m


def _render_logo_masters():
    """Load the brain-mascot logo (RGBA), trim to its alpha bbox so it composits
    tight, and build a matching HARD BLACK drop-shadow silhouette so the logo
    carries the brand's signature hard offset shadow. Returns (logo, shadow)."""
    im = Image.open(LOGO_PATH).convert("RGBA")
    bbox = im.getchannel("A").getbbox()
    if bbox:
        im = im.crop(bbox)
    sil = Image.new("RGBA", im.size, R.INK + (0,))
    sil.putalpha(im.getchannel("A"))
    return im, sil


def _title_transform(mode, u):
    """Return (dx, dy, scale, angle_deg, alpha) for an element at local progress
    u in [0,1]. easeOutCubic drives motion/opacity; easeOutBack gives scale a
    springy overshoot 'press' (matches the hero's back.out entrances)."""
    eo = _ease_out_cubic(u)
    eb = _ease_out_back(u)
    alpha = _ease_out_cubic(min(1.0, u / 0.5))   # fully opaque by ~50% through
    dx = dy = 0.0
    ang = 0.0
    scale = 1.0
    if mode == "riseup":
        dy = 155.0 * (1.0 - eo)           # rises up from below into place
        scale = 0.90 + 0.10 * eb          # subtle springy settle
    elif mode == "poprot":
        scale = eb                         # 0 -> 1 with back overshoot (hero OR)
        ang = -12.0 * (1.0 - eb)           # rotate -12deg -> 0 (hero rotate:-12)
    elif mode == "logopop":
        scale = 0.10 + 0.90 * eb           # tiny -> full, springy overshoot
        # spin in from a slight LEFT lean, settling at a jaunty RIGHT (clockwise)
        # tilt. PIL rotate is CCW-positive, so a clockwise rest = -LOGO_TILT.
        ang = -LOGO_TILT + 24.0 * (1.0 - eb)
    return dx, dy, scale, ang, alpha


def _title_elements():
    """Render every element master ONCE and return the ordered list (with logical
    geometry + choreography) reused by the animation and the still preview."""
    els = []
    cs = TITLE_LINES["smart"]
    sm, slw, slh = _render_text_master(cs["text"], cs["cap"], cs["color"])
    s, d, mode = TITLE_ANIM["smart"]
    els.append(dict(key="smart", master=sm, shadow=None, lw=slw, lh=slh,
                    cx=cs["cx"], cy=cs["cy"], start=s, dur=d, mode=mode))

    om, olw, olh = _render_or_master(OR_CFG["cap"])
    s, d, mode = TITLE_ANIM["or"]
    els.append(dict(key="or", master=om, shadow=None, lw=olw, lh=olh,
                    cx=OR_CFG["cx"], cy=OR_CFG["cy"], start=s, dur=d, mode=mode))

    cf = TITLE_LINES["fart"]
    fm, flw, flh = _render_text_master(cf["text"], cf["cap"], cf["color"])
    s, d, mode = TITLE_ANIM["fart"]
    els.append(dict(key="fart", master=fm, shadow=None, lw=flw, lh=flh,
                    cx=cf["cx"], cy=cf["cy"], start=s, dur=d, mode=mode))

    logo, sil = _render_logo_masters()
    gw, gh = logo.size
    size = LOGO_CFG["size"]
    s, d, mode = TITLE_ANIM["logo"]
    els.append(dict(key="logo", master=logo, shadow=sil, lw=size,
                    lh=size * gh / gw, cx=LOGO_CFG["cx"], cy=LOGO_CFG["cy"],
                    start=s, dur=d, mode=mode))
    return els


def _paste_element(frame_ss, el, t):
    """Composite one animated element onto the supersampled frame at time t."""
    start, dur, mode = el["start"], el["dur"], el["mode"]
    if t < start:
        return                                 # not entered yet
    u = (t - start) / dur
    dx, dy, scale, ang, alpha = _title_transform(mode, u)
    pw = max(1, int(round(el["lw"] * TITLE_SS * scale)))
    ph = max(1, int(round(el["lh"] * TITLE_SS * scale)))
    cxp = (el["cx"] + dx) * TITLE_SS
    cyp = (el["cy"] + dy) * TITLE_SS

    def _prep(src):
        im = src.resize((pw, ph), Image.LANCZOS)
        if abs(ang) > 0.01:
            im = im.rotate(ang, expand=True, resample=Image.BICUBIC)
        if alpha < 0.999:
            im.putalpha(im.getchannel("A").point(lambda p: int(p * alpha)))
        return im

    # the logo carries its own hard yellow shadow (text/pill bake theirs in)
    if el["shadow"] is not None:
        sh = _prep(el["shadow"])
        off = int(round(el["lw"] * 0.045 * TITLE_SS * scale))
        frame_ss.paste(sh, (int(round(cxp - sh.width / 2 + off)),
                            int(round(cyp - sh.height / 2 + off))), sh)
    im = _prep(el["master"])
    frame_ss.paste(im, (int(round(cxp - im.width / 2)),
                        int(round(cyp - im.height / 2))), im)


def render_title_animation(outdir):
    """Write the animated-intro frame sequence (00000.png ...). The final frame
    is the fully assembled, settled title (cloned by ffmpeg for the hold). This
    is the reusable intro segment the full re-render imports UNCHANGED."""
    if os.path.isdir(outdir):
        shutil.rmtree(outdir)
    os.makedirs(outdir)
    bg = _title_background(R.W * TITLE_SS, R.H * TITLE_SS)
    els = _title_elements()
    shapes = _hero_shapes()
    # Render across the WHOLE intro (LEAD + intro VO + TRAIL, + buffer) so the
    # shapes keep drifting under the settled title (no frozen clone-hold). The
    # title elements finish assembling early (~2.3s) then hold. Falls back to
    # ANIM_SECONDS when the intro VO isn't present (still/preview use).
    intro_wav = f"{VO}/intro.wav"
    if os.path.exists(intro_wav):
        total_sec = LEAD + wav_dur(intro_wav) + TRAIL + 0.5
    else:
        total_sec = ANIM_SECONDS
    n_frames = int(round(total_sec * R.FPS))
    for n in range(n_frames):
        t = n / float(R.FPS)
        frame = bg.copy()
        _draw_hero_shapes(frame, shapes, t)
        for el in els:
            _paste_element(frame, el, t)
        frame.resize((R.W, R.H), Image.LANCZOS).save(f"{outdir}/{n:05d}.png")
    return n_frames


def render_title_still(path, t=None):
    """Render ONE composited title frame (default: fully assembled/settled) to
    `path` -- a cheap layout preview without rendering the whole sequence."""
    if t is None:
        t = ANIM_SECONDS + 1.0
    bg = _title_background(R.W * TITLE_SS, R.H * TITLE_SS)
    frame = bg.copy()
    _draw_hero_shapes(frame, _hero_shapes(), t)
    for el in _title_elements():
        _paste_element(frame, el, t)
    frame.resize((R.W, R.H), Image.LANCZOS).save(path)
    return path


def render_intro_sample(out=None, hold=3.2):
    """PHASE-1 approval clip: the animated intro assembling, then HOLDING the
    settled title. Silent, 1920x1080 / 30 fps, same HQ encode + AA as the full
    render (crf16/slow). Reuses render_title_animation verbatim."""
    out = out or INTRO_SAMPLE
    seg = f"{WORK}/intro_sample"
    os.makedirs(WORK, exist_ok=True)
    n = render_title_animation(seg)
    base = round(n / float(R.FPS), 3)
    total = round(base + hold, 3)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    sh([FF, "-y", "-loglevel", "error",
        "-framerate", "30", "-i", f"{seg}/%05d.png",
        "-vf", f"tpad=stop_mode=clone:stop_duration={hold}",
        *ENC_HQ, "-an", "-movflags", "+faststart", "-t", f"{total}", out])
    print(f"intro sample: {n} anim frames ({base:.2f}s) + {hold:.2f}s hold "
          f"= {total:.2f}s -> {out}")
    return out


# =========================================================================
#  NONVERBAL DRAWING HELPERS -- COPIED here from the sibling orchestrators and
#  renamed to coexist in one file (the sibling files are NOT edited). All draw
#  in logical 1920x1080 units through R's _SSDraw wrapper so edges stay crisp
#  under supersampling, exactly like the shared draw_arrow primitive.
# =========================================================================

# --- (A) polygon-sides figure series  [copied from render_cogat_round_03.py] --
# Per-shape start angle (deg) so each reads "correctly": triangle/pentagon point
# up with a flat base, square + octagon axis-aligned, hexagon flat-topped.
POLY_ROT = {3: -90.0, 4: 45.0, 5: -90.0, 6: 0.0, 7: -90.0, 8: 22.5}


def _poly_points(cx, cy, r, sides, rot_deg):
    return [
        (cx + r * math.cos(math.radians(rot_deg + i * 360.0 / sides)),
         cy + r * math.sin(math.radians(rot_deg + i * 360.0 / sides)))
        for i in range(sides)
    ]


def draw_polygon(d, cx, cy, r, shape, fill, border=8, shadow=0):
    """Neo-brutalist regular polygon (or circle): colored fill, pure-black
    border. FLAT by default (shadow=0) so stacked nonverbal shapes don't clutter.
    `shape` is an int side-count or the string 'circle'; `r` is the circumradius."""
    if shape == "circle":
        if shadow:
            d.ellipse([cx - r + shadow, cy - r + shadow,
                       cx + r + shadow, cy + r + shadow], fill=R.INK)
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=fill,
                  outline=R.INK, width=border)
        return
    pts = _poly_points(cx, cy, r, int(shape), POLY_ROT.get(int(shape), -90.0))
    if shadow:
        d.polygon([(px + shadow, py + shadow) for px, py in pts], fill=R.INK)
    d.polygon(pts, fill=fill, outline=R.INK, width=border)


def _poly_cell(d, box, shape=None, question=False, color=R.BLUE):
    """One card in the figure-series strip: a colored shape icon, or a big '?'
    for the missing final step."""
    R.hard_card(d, box, R.PAPER, radius=22, border=7, shadow=0)
    cx = (box[0] + box[2]) / 2
    cy = (box[1] + box[3]) / 2
    if question:
        R.draw_text(d, cx, cy, "?", R.anton(int((box[3] - box[1]) * 0.60)),
                    R.INK, anchor="mm")
    else:
        s = min(box[2] - box[0], box[3] - box[1]) * 0.34
        draw_polygon(d, cx, cy, s, shape, color)


def poly_option_tile(d, box, letter, shape, highlight=None):
    """An A-D option tile whose answer is a drawn shape icon (not text)."""
    fill = R.MINT if highlight == "correct" else R.PAPER
    R.hard_card(d, box, fill, radius=26, border=7, shadow=0)
    x0, y0, x1, y1 = box
    bsz = 78
    bx0, by0 = x0 + 22, y0 + 22
    R.hard_card(d, [bx0, by0, bx0 + bsz, by0 + bsz], R.BADGE_COLORS[letter],
                radius=16, border=6, shadow=0)
    R.draw_text(d, bx0 + bsz / 2, by0 + bsz / 2, letter, R.anton(int(bsz * 0.58)),
                R.INK, anchor="mm")
    scx = (x0 + x1) / 2
    scy = (y0 + y1) / 2 + 26
    s = min(x1 - x0, y1 - y0) * 0.30
    draw_polygon(d, scx, scy, s, shape, R.BADGE_COLORS[letter])


def render_polygon_question(cfg):
    """Nonverbal FIGURE-SERIES item: a growing-sides shape sequence
    (triangle -> square -> pentagon -> ?) plus four shape-icon options. Reuses
    the exact brand chrome + countdown machinery as R.render_question."""
    outdir = cfg["outdir"]
    if os.path.isdir(outdir):
        shutil.rmtree(outdir)
    os.makedirs(outdir)

    base, d = R.new_frame(cfg["bg"])

    total = cfg.get("total", TOTAL_Q)
    r = R.pill_left(d, R.M, 100, f"QUESTION {cfg['idx']} OF {total}",
                    R.dm(34, "Bold"), fill=cfg.get("header_fill", R.CORAL),
                    txt_col=cfg.get("header_txt", R.INK), tracking=3)
    tier_col = cfg.get("tier_color") or R.CORAL
    R.pill_left(d, r + 24, 100, cfg["tier"].upper(), R.dm(34, "Bold"),
                tier_col, txt_col=R.INK, tracking=3)

    R.hard_card(d, [R.CD_X0, R.CD_Y0, R.CD_X1, R.CD_Y1], cfg["cd_accent"],
                radius=28, border=9, shadow=14)

    pbox = [R.M, 300, R.W - R.M, 416]
    R.hard_card(d, pbox, R.PAPER, radius=36, border=9, shadow=16)
    pf, plines = R.fit_font(d, cfg["prompt"], pbox[2] - pbox[0] - 90,
                            pbox[3] - pbox[1] - 28, [64, 58, 52, 46])
    R.draw_multiline_center(d, R.W / 2, (pbox[1] + pbox[3]) / 2, plines, pf, R.INK)

    seq = cfg["seq"]
    n = len(seq) + 1
    cw, chh, gap = 190, 190, 70
    sx = (R.W - (n * cw + (n - 1) * gap)) / 2
    sy = 430
    seq_colors = [R.BLUE, R.CORAL, R.YELLOW, R.MINT]
    for i, shape in enumerate(seq):
        bx = sx + i * (cw + gap)
        _poly_cell(d, [bx, sy, bx + cw, sy + chh], shape=shape,
                   color=seq_colors[i % len(seq_colors)])
    bx = sx + len(seq) * (cw + gap)
    _poly_cell(d, [bx, sy, bx + cw, sy + chh], question=True)

    ow, oh, ogap = 395, 240, 40
    oy = 662
    for j, (letter, shape) in enumerate(cfg["options"]):
        bx = R.M + j * (ow + ogap)
        poly_option_tile(d, [bx, oy, bx + ow, oy + oh], letter, shape)

    d.rounded_rectangle([R.BAR_X, R.BAR_Y, R.BAR_X + R.BAR_W, R.BAR_Y + R.BAR_H],
                        radius=R.BAR_H // 2, fill=R.INK)
    return R._countdown_sequence(base, outdir, cfg["countdown"], cfg["bar_accent"])


def _shape_reveal(path, letter, label, explanation, draw_shape):
    """Shared nonverbal reveal: NO green check. The answer is an OPTION-STYLE card
    (colored letter badge + the flat answer shape + label), with the explanation
    sized up below to use the freed space (mirrors R.render_reveal option style)."""
    img, d = R.new_frame(R.MINT)
    R.pill_center(d, R.W / 2, 150, "CORRECT ANSWER", R.dm(38, "Bold"),
                  txt_col=R.PAPER, tracking=4, fill=R.INK, pad_x=36, pad_y=18)
    card = [300, 262, R.W - 300, 470]
    R.hard_card(d, card, R.PAPER, radius=30, border=9, shadow=16)
    x0, y0, x1, y1 = card
    inset = 30
    bh = (y1 - y0) - 2 * inset
    bx0, by0 = x0 + inset, y0 + inset
    R.hard_card(d, [bx0, by0, bx0 + bh, by0 + bh], R.BADGE_COLORS[letter],
                radius=18, border=7, shadow=9)
    R.draw_text(d, bx0 + bh / 2, by0 + bh / 2, letter, R.anton(int(bh * 0.60)),
                R.INK, anchor="mm")
    scx = bx0 + bh + 150
    draw_shape(d, scx, (y0 + y1) / 2)
    lab_left = scx + 150
    lf, llines = R.fit_font(d, label, (x1 - 40) - lab_left, (y1 - y0) - 50,
                            [88, 76, 66, 56])
    R.draw_multiline_center(d, (lab_left + (x1 - 40)) / 2, (y0 + y1) / 2, llines,
                            lf, R.INK)
    ebox = [R.M, 512, R.W - R.M, 902]
    R.hard_card(d, ebox, R.CREAM, radius=36, border=8, shadow=16)
    ef = R.dm(46, "Medium")
    elines = R.wrap(d, explanation, ef, ebox[2] - ebox[0] - 120)
    R.draw_multiline_center(d, R.W / 2, (ebox[1] + ebox[3]) / 2, elines, ef,
                            R.INK, leading=1.3)
    R._finalize(img).save(path)


def render_polygon_reveal(path, bg, letter, shape, label, explanation):
    _shape_reveal(path, letter, label, explanation,
                  lambda dd, cx, cy: draw_polygon(dd, cx, cy, 90, shape,
                                                  R.BADGE_COLORS[letter], border=8, shadow=0))


# --- (B) empty -> filled shading analogy  [copied from render_cogat_round_04] --
SHADE_FILL = R.BLUE  # single consistent "filled" ink -> only shape+fill vary


def _draw_shaded(d, cx, cy, s, shape, filled, border=8, shadow=0):
    """One neo-brutalist shape icon: circle / square / triangle, EMPTY (paper)
    or FILLED (solid SHADE_FILL), pure-black border. FLAT by default (shadow=0).
    `s` is the half-size."""
    fill_col = SHADE_FILL if filled else R.PAPER
    if shape == "circle":
        if shadow:
            d.ellipse([cx - s + shadow, cy - s + shadow, cx + s + shadow, cy + s + shadow],
                      fill=R.INK)
        d.ellipse([cx - s, cy - s, cx + s, cy + s], fill=fill_col, outline=R.INK, width=border)
    elif shape == "square":
        rad = 16
        if shadow:
            d.rounded_rectangle([cx - s + shadow, cy - s + shadow, cx + s + shadow, cy + s + shadow],
                                radius=rad, fill=R.INK)
        d.rounded_rectangle([cx - s, cy - s, cx + s, cy + s], radius=rad,
                            fill=fill_col, outline=R.INK, width=border)
    elif shape == "triangle":
        top = (cx, cy - s)
        bl = (cx - s * 0.98, cy + s * 0.72)
        br = (cx + s * 0.98, cy + s * 0.72)
        poly = [top, br, bl]
        if shadow:
            d.polygon([(px + shadow, py + shadow) for px, py in poly], fill=R.INK)
        d.polygon(poly, fill=fill_col, outline=R.INK, width=border)


def _shaded_cell(d, box, shape=None, filled=False, question=False):
    """One card in the analogy strip: a shaded/empty shape icon, or a big '?'."""
    R.hard_card(d, box, R.PAPER, radius=22, border=7, shadow=0)
    cx = (box[0] + box[2]) / 2
    cy = (box[1] + box[3]) / 2
    if question:
        R.draw_text(d, cx, cy, "?", R.anton(int((box[3] - box[1]) * 0.60)), R.INK, anchor="mm")
    else:
        s = min(box[2] - box[0], box[3] - box[1]) * 0.30
        _draw_shaded(d, cx, cy, s, shape, filled)


def _shaded_option_tile(d, box, letter, shape, filled, highlight=None):
    """An A-D option tile whose answer is a drawn SHAPE icon (not text)."""
    fill = R.MINT if highlight == "correct" else R.PAPER
    R.hard_card(d, box, fill, radius=26, border=7, shadow=0)
    x0, y0, x1, y1 = box
    bsz = 78
    bx0, by0 = x0 + 22, y0 + 22
    R.hard_card(d, [bx0, by0, bx0 + bsz, by0 + bsz], R.BADGE_COLORS[letter],
                radius=16, border=6, shadow=0)
    R.draw_text(d, bx0 + bsz / 2, by0 + bsz / 2, letter, R.anton(int(bsz * 0.58)),
                R.INK, anchor="mm")
    acx = (x0 + x1) / 2
    acy = (y0 + y1) / 2 + 26
    s = min(x1 - x0, y1 - y0) * 0.26
    _draw_shaded(d, acx, acy, s, shape, filled)


def _sep_dots(d, cx, cy, double=False, col=(120, 120, 120)):
    """Soft, shaded analogy separator: small muted dots (one column for ':' , two
    columns for '::'), replacing the old chunky solid-black colon glyphs."""
    r = 12
    vgap = 46
    xs = [cx - 24, cx + 24] if double else [cx]
    for X in xs:
        d.ellipse([X - r, cy - vgap / 2 - r, X + r, cy - vgap / 2 + r], fill=col)
        d.ellipse([X - r, cy + vgap / 2 - r, X + r, cy + vgap / 2 + r], fill=col)


def render_shaded_question(cfg):
    """Nonverbal FIGURE-ANALOGY item: [empty L] : [filled L] :: [empty R] : [?]
    drawn as shaded-shape icons, plus four SHAPE-icon options."""
    outdir = cfg["outdir"]
    if os.path.isdir(outdir):
        shutil.rmtree(outdir)
    os.makedirs(outdir)

    base, d = R.new_frame(cfg["bg"])

    total = cfg.get("total", TOTAL_Q)
    r = R.pill_left(d, R.M, 100, f"QUESTION {cfg['idx']} OF {total}", R.dm(34, "Bold"),
                    fill=cfg.get("header_fill", R.CORAL),
                    txt_col=cfg.get("header_txt", R.INK), tracking=3)
    tier_col = cfg.get("tier_color") or R.YELLOW
    R.pill_left(d, r + 24, 100, cfg["tier"].upper(), R.dm(34, "Bold"),
                tier_col, txt_col=R.INK, tracking=3)

    R.hard_card(d, [R.CD_X0, R.CD_Y0, R.CD_X1, R.CD_Y1], cfg["cd_accent"],
                radius=28, border=9, shadow=14)

    pbox = [R.M, 300, R.W - R.M, 416]
    R.hard_card(d, pbox, R.PAPER, radius=36, border=9, shadow=16)
    pf, plines = R.fit_font(d, cfg["prompt"], pbox[2] - pbox[0] - 90,
                            pbox[3] - pbox[1] - 28, [64, 58, 52, 46])
    R.draw_multiline_center(d, R.W / 2, (pbox[1] + pbox[3]) / 2, plines, pf, R.INK)

    # analogy strip:  [empty L] : [filled L]  ::  [empty R] : [?]
    cw = 190
    pair_gap = 70
    mid_gap = 130
    total_w = 4 * cw + 2 * pair_gap + mid_gap
    sx = (R.W - total_w) / 2
    sy = 430
    cy = sy + cw / 2
    L = cfg["left_shape"]
    Rt = cfg["right_shape"]

    x = sx
    _shaded_cell(d, [x, sy, x + cw, sy + cw], shape=L, filled=False)
    x += cw
    _sep_dots(d, x + pair_gap / 2, cy, double=False)
    x += pair_gap
    _shaded_cell(d, [x, sy, x + cw, sy + cw], shape=L, filled=True)
    x += cw
    _sep_dots(d, x + mid_gap / 2, cy, double=True)
    x += mid_gap
    _shaded_cell(d, [x, sy, x + cw, sy + cw], shape=Rt, filled=False)
    x += cw
    _sep_dots(d, x + pair_gap / 2, cy, double=False)
    x += pair_gap
    _shaded_cell(d, [x, sy, x + cw, sy + cw], question=True)

    ow, oh, ogap = 395, 240, 40
    oy = 662
    for j, (letter, shape, filled) in enumerate(cfg["options"]):
        bx = R.M + j * (ow + ogap)
        _shaded_option_tile(d, [bx, oy, bx + ow, oy + oh], letter, shape, filled)

    d.rounded_rectangle([R.BAR_X, R.BAR_Y, R.BAR_X + R.BAR_W, R.BAR_Y + R.BAR_H],
                        radius=R.BAR_H // 2, fill=R.INK)
    return R._countdown_sequence(base, outdir, cfg["countdown"], cfg["bar_accent"])


def render_shaded_reveal(path, bg, letter, shape, filled, label, explanation):
    _shape_reveal(path, letter, label, explanation,
                  lambda dd, cx, cy: _draw_shaded(dd, cx, cy, 82, shape, filled,
                                                  border=8, shadow=0))


# --- (C) dot-position around a square  [copied from render_cogat_round_05.py] --
POS_LABEL = {"tl": "TOP-LEFT", "tr": "TOP-RIGHT", "br": "BOTTOM-RIGHT",
             "bl": "BOTTOM-LEFT", "center": "CENTER"}


def draw_dot_square(d, box, position, dot_col=R.CORAL, sq_fill=R.PAPER,
                    border=7, shadow=0, sq_radius=10, ghost=True):
    """Neo-brutalist POSITION icon: a bordered square with a colored dot at one
    corner (or center). Faint 'ghost' pips mark the other corners so the
    moving-dot geometry reads at a glance. position may be None (empty square)."""
    x0, y0, x1, y1 = box
    if shadow:
        d.rounded_rectangle([x0 + shadow, y0 + shadow, x1 + shadow, y1 + shadow],
                            radius=sq_radius, fill=R.INK)
    d.rounded_rectangle([x0, y0, x1, y1], radius=sq_radius, fill=sq_fill)
    d.rounded_rectangle([x0, y0, x1, y1], radius=sq_radius, outline=R.INK, width=border)

    side = min(x1 - x0, y1 - y0)
    pad = side * 0.22
    dr = side * 0.14
    pos = {
        "tl": (x0 + pad, y0 + pad), "tr": (x1 - pad, y0 + pad),
        "br": (x1 - pad, y1 - pad), "bl": (x0 + pad, y1 - pad),
        "center": ((x0 + x1) / 2, (y0 + y1) / 2),
    }
    if ghost:
        g = dr * 0.34
        for k in ("tl", "tr", "br", "bl"):
            gx, gy = pos[k]
            d.ellipse([gx - g, gy - g, gx + g, gy + g], fill=(176, 176, 176))
    if position:
        cx, cy = pos[position]
        if shadow:
            ds = max(4, dr * 0.18)
            d.ellipse([cx - dr + ds, cy - dr + ds, cx + dr + ds, cy + dr + ds], fill=R.INK)
        d.ellipse([cx - dr, cy - dr, cx + dr, cy + dr], fill=dot_col)
        d.ellipse([cx - dr, cy - dr, cx + dr, cy + dr], outline=R.INK,
                  width=max(4, border - 1))


def dot_option_tile(d, box, letter, position, highlight=None):
    """An A-D option tile whose choice is a dot-POSITION icon (not text)."""
    fill = R.MINT if highlight == "correct" else R.PAPER
    R.hard_card(d, box, fill, radius=26, border=7, shadow=0)
    x0, y0, x1, y1 = box
    bsz = 74
    bx0, by0 = x0 + 22, y0 + 20
    R.hard_card(d, [bx0, by0, bx0 + bsz, by0 + bsz], R.BADGE_COLORS[letter],
                radius=16, border=6, shadow=0)
    R.draw_text(d, bx0 + bsz / 2, by0 + bsz / 2, letter, R.anton(int(bsz * 0.58)),
                R.INK, anchor="mm")
    isz = 116
    icx = (x0 + x1) / 2
    itop = y0 + 26
    draw_dot_square(d, [icx - isz / 2, itop, icx + isz / 2, itop + isz], position,
                    dot_col=R.BADGE_COLORS[letter], border=6, shadow=0, sq_radius=8)
    R.draw_text(d, icx, itop + isz + 30, POS_LABEL[position], R.dm(28, "Bold"),
                R.INK, anchor="mm", tracking=1)


def render_dot_question(cfg):
    """Nonverbal figure-series / POSITION item: a dot stepping clockwise around
    a square's corners (TL -> TR -> BR -> ?), plus four dot-position options."""
    outdir = cfg["outdir"]
    if os.path.isdir(outdir):
        shutil.rmtree(outdir)
    os.makedirs(outdir)

    base, d = R.new_frame(cfg["bg"])

    total = cfg.get("total", TOTAL_Q)
    r = R.pill_left(d, R.M, 100, f"QUESTION {cfg['idx']} OF {total}",
                    R.dm(34, "Bold"), fill=cfg.get("header_fill", R.CORAL),
                    txt_col=cfg.get("header_txt", R.INK), tracking=3)
    tier_col = cfg.get("tier_color") or R.YELLOW
    R.pill_left(d, r + 24, 100, cfg["tier"].upper(), R.dm(34, "Bold"),
                tier_col, txt_col=R.INK, tracking=3)

    R.hard_card(d, [R.CD_X0, R.CD_Y0, R.CD_X1, R.CD_Y1], cfg["cd_accent"],
                radius=28, border=9, shadow=14)

    pbox = [R.M, 300, R.W - R.M, 416]
    R.hard_card(d, pbox, R.PAPER, radius=36, border=9, shadow=16)
    pf, plines = R.fit_font(d, cfg["prompt"], pbox[2] - pbox[0] - 90,
                            pbox[3] - pbox[1] - 28, [64, 58, 52, 46])
    R.draw_multiline_center(d, R.W / 2, (pbox[1] + pbox[3]) / 2, plines, pf, R.INK)

    seq = cfg["seq"]
    n = len(seq) + 1
    cw, chh, gap = 190, 190, 70
    sx = (R.W - (n * cw + (n - 1) * gap)) / 2
    sy = 430
    seq_colors = [R.BLUE, R.CORAL, R.YELLOW, R.MINT]
    for i, posn in enumerate(seq):
        bx = sx + i * (cw + gap)
        draw_dot_square(d, [bx, sy, bx + cw, sy + chh], posn,
                        dot_col=seq_colors[i % len(seq_colors)])
    bx = sx + len(seq) * (cw + gap)
    draw_dot_square(d, [bx, sy, bx + cw, sy + chh], None)
    R.draw_text(d, bx + cw / 2, sy + chh / 2, "?", R.anton(int(chh * 0.50)),
                R.INK, anchor="mm")

    ow, oh, ogap = 395, 240, 40
    oy = 662
    for j, (letter, posn) in enumerate(cfg["options"]):
        bx = R.M + j * (ow + ogap)
        dot_option_tile(d, [bx, oy, bx + ow, oy + oh], letter, posn)

    d.rounded_rectangle([R.BAR_X, R.BAR_Y, R.BAR_X + R.BAR_W, R.BAR_Y + R.BAR_H],
                        radius=R.BAR_H // 2, fill=R.INK)
    return R._countdown_sequence(base, outdir, cfg["countdown"], cfg["bar_accent"])


def render_dot_reveal(path, bg, letter, position, label, explanation):
    _shape_reveal(path, letter, label, explanation,
                  lambda dd, cx, cy: draw_dot_square(dd, [cx - 92, cy - 92, cx + 92, cy + 92],
                                                     position, dot_col=R.BADGE_COLORS[letter],
                                                     border=8, shadow=0, sq_radius=12))


def render_numseries_question(cfg):
    """NUMBER-SERIES item: the prompt plus each number AND the '?' in its OWN
    neo-brutalist bordered TILE (thick border, rounded corners, hard shadow,
    on-brand fill, centered bold number) laid out as a clean centered row; A-D
    text options below. Same brand chrome + countdown machinery as render_question."""
    outdir = cfg["outdir"]
    if os.path.isdir(outdir):
        shutil.rmtree(outdir)
    os.makedirs(outdir)

    base, d = R.new_frame(cfg["bg"])

    total = cfg.get("total", TOTAL_Q)
    r = R.pill_left(d, R.M, 100, f"QUESTION {cfg['idx']} OF {total}",
                    R.dm(34, "Bold"), fill=cfg.get("header_fill", R.CORAL),
                    txt_col=cfg.get("header_txt", R.INK), tracking=3)
    tier_col = cfg.get("tier_color") or R.MINT
    R.pill_left(d, r + 24, 100, cfg["tier"].upper(), R.dm(34, "Bold"),
                tier_col, txt_col=R.INK, tracking=3)

    R.hard_card(d, [R.CD_X0, R.CD_Y0, R.CD_X1, R.CD_Y1], cfg["cd_accent"],
                radius=28, border=9, shadow=14)

    pbox = [R.M, 300, R.W - R.M, 416]
    R.hard_card(d, pbox, R.PAPER, radius=36, border=9, shadow=16)
    pf, plines = R.fit_font(d, cfg["prompt"], pbox[2] - pbox[0] - 90,
                            pbox[3] - pbox[1] - 28, [64, 58, 52, 46])
    R.draw_multiline_center(d, R.W / 2, (pbox[1] + pbox[3]) / 2, plines, pf, R.INK)

    # number tiles: each numeral + the "?" in its own bordered square, centered
    toks = cfg["seq"]
    n = len(toks)
    gap = 36
    tw = min(160, int((R.W - 2 * R.M - (n - 1) * gap) / n))
    th = 132
    total_w = n * tw + (n - 1) * gap
    sx = (R.W - total_w) / 2
    ty = 436
    for i, tok in enumerate(toks):
        bx = sx + i * (tw + gap)
        is_q = (tok == "?")
        R.hard_card(d, [bx, ty, bx + tw, ty + th],
                    cfg["cd_accent"] if is_q else R.PAPER,
                    radius=22, border=8, shadow=12)
        nf, _ = R.fit_font(d, tok, tw - 26, th - 26, [92, 84, 74, 64, 54])
        R.draw_text(d, bx + tw / 2, ty + th / 2, tok, nf, R.INK, anchor="mm")

    for letter, text in cfg["options"]:
        R.option_tile(d, R.OPT_BOXES[letter], letter, text)

    d.rounded_rectangle([R.BAR_X, R.BAR_Y, R.BAR_X + R.BAR_W, R.BAR_Y + R.BAR_H],
                        radius=R.BAR_H // 2, fill=R.INK)
    return R._countdown_sequence(base, outdir, cfg["countdown"], cfg["bar_accent"])


# =========================================================================
#  THE 15 QUESTIONS (video/content/cogat-round-15.md), Grade-5 / Level-11
#  calibrated per video/content/cogat-timing-difficulty.md.
#    - Countdown = "Video (L11)" seconds; Diff = Grade-5 tier.
#    - Q14 is the SWAP: cubes (5->125, above Grade 5) -> x2+1 (2->5,3->7,4->9,
#      5->11), a same-type Grade-5 number analogy (Medium, 6 s).
# =========================================================================
TOTAL_Q = 15
QUESTIONS = [
    # Q1  Verbal Classification (birds)          Easy   5 s
    dict(idx=1, kind="text", bg=R.BLUE, tier="ODD ONE OUT", tier_color=R.MINT,
         diff="Easy",
         question="WHICH ONE DOES NOT BELONG?",
         options=[("A", "ROBIN"), ("B", "SPARROW"), ("C", "SALMON"), ("D", "EAGLE")],
         countdown=5, cd_accent=R.YELLOW, bar_accent=R.YELLOW,
         ans="C", ans_label="SALMON",
         expl="A robin, sparrow, and eagle are all birds. A salmon is a fish, so "
              "it does not belong."),
    # Q2  Number Series (doubling x2)             Easy   5 s
    dict(idx=2, kind="numseries", bg=R.CORAL, tier="NUMBER SERIES", tier_color=R.MINT,
         diff="Easy",
         prompt="WHAT COMES NEXT?", seq=["3", "6", "12", "24", "?"],
         options=[("A", "36"), ("B", "48"), ("C", "30"), ("D", "42")],
         countdown=5, cd_accent=R.YELLOW, bar_accent=R.YELLOW,
         ans="B", ans_label="48",
         expl="Each number doubles (x2): 3, 6, 12, 24, so the next is "
              "24 x 2 = 48."),
    # Q3  Nonverbal Figure Analogy (empty->filled)  Easy   6 s  [SHADING helper]
    dict(idx=3, kind="shaded", bg=R.YELLOW, tier="FIGURE ANALOGY", tier_color=R.CORAL,
         diff="Easy",
         prompt="WHICH SHAPE COMPLETES THE PATTERN?",
         left_shape="circle", right_shape="square",
         options=[("A", "square", True), ("B", "square", False),
                  ("C", "circle", True), ("D", "triangle", True)],
         countdown=6, cd_accent=R.CORAL, bar_accent=R.CORAL,
         ans="A", ans_shape="square", ans_filled=True, ans_label="FILLED SQUARE",
         expl="The relation is 'get filled in' while the shape stays the same, "
              "so the empty square becomes a filled square."),
    # Q4  Verbal Analogy (opposites)             Easy   5 s
    dict(idx=4, kind="text", bg=R.BLUE, tier="VERBAL ANALOGY", tier_color=R.MINT,
         diff="Easy",
         question="GIANT IS TO TINY AS\nWIDE IS TO ?",
         options=[("A", "NARROW"), ("B", "TALL"), ("C", "LONG"), ("D", "BIG")],
         countdown=5, cd_accent=R.YELLOW, bar_accent=R.YELLOW,
         ans="A", ans_label="NARROW",
         expl="Giant and tiny are opposites, so the opposite of wide is narrow - "
              "the same relationship, flipped."),
    # Q5  Number Series (constant -8)            Easy   5 s
    dict(idx=5, kind="numseries", bg=R.CORAL, tier="NUMBER SERIES", tier_color=R.YELLOW,
         diff="Easy",
         prompt="WHAT COMES NEXT?", seq=["100", "92", "84", "76", "?"],
         options=[("A", "70"), ("B", "68"), ("C", "66"), ("D", "72")],
         countdown=5, cd_accent=R.YELLOW, bar_accent=R.YELLOW,
         ans="B", ans_label="68",
         expl="Each number goes down by 8: 100, 92, 84, 76, so 76 - 8 = 68."),
    # Q6  Verbal Analogy (size-degree)           Medium 5 s
    dict(idx=6, kind="text", bg=R.YELLOW, tier="VERBAL ANALOGY", tier_color=R.BLUE,
         diff="Medium",
         question="OCEAN IS TO PUDDLE AS\nMOUNTAIN IS TO ?",
         options=[("A", "VALLEY"), ("B", "HILL"), ("C", "RIVER"), ("D", "ROCK")],
         countdown=5, cd_accent=R.CORAL, bar_accent=R.CORAL,
         ans="B", ans_label="HILL",
         expl="An ocean shrinks to a puddle, so a mountain shrinks to a hill - "
              "the tiny version of the same thing."),
    # Q7  Number Series (2nd differences)        Hard   7 s
    dict(idx=7, kind="numseries", bg=R.BLUE, tier="NUMBER SERIES", tier_color=R.YELLOW,
         diff="Hard",
         prompt="WHAT COMES NEXT?", seq=["2", "6", "12", "20", "30", "?"],
         options=[("A", "36"), ("B", "40"), ("C", "42"), ("D", "44")],
         countdown=7, cd_accent=R.YELLOW, bar_accent=R.YELLOW,
         ans="C", ans_label="42",
         expl="The gaps grow +4, +6, +8, +10, so the next gap is +12. "
              "That makes 30 + 12 = 42."),
    # Q8  Verbal Analogy (worker-tool)           Medium 5 s
    dict(idx=8, kind="text", bg=R.CORAL, tier="VERBAL ANALOGY", tier_color=R.MINT,
         diff="Medium",
         question="PAINTER IS TO BRUSH AS\nCARPENTER IS TO ?",
         options=[("A", "HAMMER"), ("B", "WOOD"), ("C", "HOUSE"), ("D", "NAIL")],
         countdown=5, cd_accent=R.YELLOW, bar_accent=R.YELLOW,
         ans="A", ans_label="HAMMER",
         expl="A painter's tool is a brush; a carpenter's tool is a hammer. "
              "Wood is the material and a house is the product."),
    # Q9  Number Series (Fibonacci)              Hard   7 s
    dict(idx=9, kind="numseries", bg=R.YELLOW, tier="NUMBER SERIES", tier_color=R.CORAL,
         diff="Hard",
         prompt="WHAT COMES NEXT?", seq=["1", "1", "2", "3", "5", "8", "?"],
         options=[("A", "11"), ("B", "13"), ("C", "12"), ("D", "16")],
         countdown=7, cd_accent=R.CORAL, bar_accent=R.CORAL,
         ans="B", ans_label="13",
         expl="Each number is the sum of the two before it: 3 + 5 = 8, so "
              "5 + 8 = 13. It's the Fibonacci pattern."),
    # Q10 Verbal Classification (ops vs number)  Medium 5 s
    dict(idx=10, kind="text", bg=R.BLUE, tier="ODD ONE OUT", tier_color=R.MINT,
         diff="Medium",
         question="WHICH ONE DOES NOT BELONG?",
         options=[("A", "ADD"), ("B", "SUBTRACT"), ("C", "MULTIPLY"), ("D", "NUMBER")],
         countdown=5, cd_accent=R.YELLOW, bar_accent=R.YELLOW,
         ans="D", ans_label="NUMBER",
         expl="Add, subtract, and multiply are operations you do. A number is "
              "the thing you do them to, so it doesn't belong."),
    # Q11 Nonverbal Figure Series (polygon +1)   Medium 7 s  [POLYGON helper]
    dict(idx=11, kind="polygon", bg=R.CORAL, tier="FIGURE SERIES", tier_color=R.YELLOW,
         diff="Medium",
         prompt="WHICH SHAPE COMES NEXT?",
         seq=[3, 4, 5],  # triangle -> square -> pentagon
         options=[("A", "circle"), ("B", 6), ("C", 4), ("D", 8)],
         countdown=7, cd_accent=R.YELLOW, bar_accent=R.YELLOW,
         ans="B", ans_label="HEXAGON", ans_shape=6,
         expl="The sides count up by one: triangle 3, square 4, pentagon 5, so "
              "next is the hexagon with 6 sides."),
    # Q12 Sentence Completion                    Medium 6 s
    dict(idx=12, kind="text", bg=R.YELLOW, tier="SENTENCE COMPLETION", tier_color=R.BLUE,
         diff="Medium",
         question="THE BRIDGE WAS TOO WEAK TO HOLD THE\n"
                  "HEAVY TRUCK, SO WORKERS HAD TO ______\nIT BEFORE OPENING THE ROAD.",
         options=[("A", "DECORATE"), ("B", "REINFORCE"), ("C", "RENAME"), ("D", "MEASURE")],
         countdown=6, cd_accent=R.CORAL, bar_accent=R.CORAL,
         ans="B", ans_label="REINFORCE",
         expl="\"Too weak\" calls for strengthening - only reinforce fixes the "
              "problem the sentence describes."),
    # Q13 Nonverbal Figure Series / Position     Medium 7 s  [DOT helper]
    dict(idx=13, kind="dot", bg=R.BLUE, tier="POSITION", tier_color=R.YELLOW,
         diff="Medium",
         prompt="WHERE DOES THE DOT MOVE NEXT?",
         seq=["tl", "tr", "br"],
         options=[("A", "tl"), ("B", "bl"), ("C", "tr"), ("D", "center")],
         countdown=7, cd_accent=R.YELLOW, bar_accent=R.YELLOW,
         ans="B", ans_label="BOTTOM-LEFT", ans_pos="bl",
         expl="The dot steps clockwise corner to corner: top-left, top-right, "
              "bottom-right, then the next corner is bottom-left."),
    # Q14 Number Analogy -- SWAP: cubes -> x2+1  Medium 6 s
    dict(idx=14, kind="text", bg=R.CORAL, tier="NUMBER ANALOGY", tier_color=R.MINT,
         diff="Medium",
         question="WHICH NUMBER FITS?\n2 -> 5,   3 -> 7,   4 -> 9,   5 -> ?",
         options=[("A", "10"), ("B", "11"), ("C", "12"), ("D", "13")],
         countdown=6, cd_accent=R.YELLOW, bar_accent=R.YELLOW,
         ans="B", ans_label="11",
         expl="Each number is doubled then add one (x2 + 1): 5 x 2 = 10, "
              "plus 1 = 11."),
    # Q15 Number Puzzle (hidden operation)       Hard   7 s
    dict(idx=15, kind="text", bg=R.YELLOW, tier="NUMBER PUZZLE", tier_color=R.CORAL,
         diff="Hard",
         question="IF  4+5=20,  3+6=18,  2+7=14\nTHEN  5+4 = ?",
         options=[("A", "9"), ("B", "18"), ("C", "20"), ("D", "25")],
         countdown=7, cd_accent=R.CORAL, bar_accent=R.CORAL,
         ans="C", ans_label="20",
         expl="The + secretly means multiply: 4x5=20, 3x6=18, 2x7=14, so "
              "5x4 = 20."),
]

SCORE_TIERS = [
    ("13-15", "CERTIFIED SMART FELLA", R.MINT),
    ("8-12", "SHARP COOKIE", R.YELLOW),
    ("0-7", "ROOKIE RIDDLER", R.CORAL),
]

# Light audio bed exprs (kept low so the VO stays on top).
TICK = "0.09*sin(2*PI*1150*t)*exp(-32*mod(t,1))"
DING = "0.16*sin(2*PI*880*t)*exp(-3.5*t)+0.10*sin(2*PI*1320*t)*exp(-3.5*t)"

LEAD = 0.35      # silence before VO on static plates
TRAIL = 0.80     # silence after VO on static plates
AR = 48000

# --- HQ deliverable encode (user spec: libx264 crf16 preset slow, yuv420p) ---
ENC_HQ = [
    "-c:v", "libx264", "-preset", "slow", "-crf", "16", "-pix_fmt", "yuv420p",
    "-r", "30", "-profile:v", "high", "-level:v", "4.2",
    "-x264-params", "keyint=60:min-keyint=60:scenecut=0",
    "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709",
]
# Near-lossless per-segment intermediate so the single crf16 concat is the only
# meaningful compression step (no visible generation loss on flat-color art).
ENC_INT = [
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "12", "-pix_fmt", "yuv420p",
    "-r", "30", "-profile:v", "high", "-level:v", "4.2",
    "-x264-params", "keyint=60:min-keyint=60:scenecut=0",
    "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709",
]
AENC = ["-c:a", "aac", "-b:a", "192k", "-ar", str(AR), "-ac", "2"]

# --- music mix design (same ducked arc/params as Round 01..05) ---
FADE = 1.5
XF = 1.5                 # fanfare->parade overlap
FAN_LEN = 13.0          # fanfare open length
WIN_LEN = 15.0          # winner-spin close length
STEM_VOL = {"fan": 0.0, "par": -2.5, "win": -1.0}  # parade bed sits lowest
# sidechain duck: music is compressed whenever the VO (sidechain key) is present
SC = "threshold=0.03:ratio=8:attack=20:release=320:makeup=1:detection=rms:link=average"
TARGET_SEP_DB = 12.0    # aim: music ~12 dB under the VO during narration (10-14 band)


def sh(cmd):
    p = subprocess.run(cmd, capture_output=True, text=True)
    if p.returncode != 0:
        sys.stderr.write("CMD FAILED: " + " ".join(map(str, cmd)) + "\n" + p.stderr + "\n")
        raise SystemExit(1)
    return p


def wav_dur(path):
    with contextlib.closing(wave.open(path, "rb")) as w:
        return w.getnframes() / float(w.getframerate())


# ------------------------------------------------------------------- frames
def frames():
    for dd in (FRAMES, CLIPS):
        os.makedirs(dd, exist_ok=True)

    nt = render_title_animation(TITLE_FRAMES)

    for q in QUESTIONS:
        k = q["kind"]
        common = dict(idx=q["idx"], total=TOTAL_Q, bg=q["bg"], tier=q["tier"],
                      tier_color=q["tier_color"], countdown=q["countdown"],
                      cd_accent=q["cd_accent"], bar_accent=q["bar_accent"],
                      header_fill=R.CORAL, header_txt=R.INK,  # coral QUESTION pill
                      q_top=306,                              # clear countdown shadow
                      outdir=f"{FRAMES}/q{q['idx']}")
        if k == "shaded":
            render_shaded_question(dict(common, prompt=q["prompt"],
                                        left_shape=q["left_shape"],
                                        right_shape=q["right_shape"],
                                        options=q["options"]))
        elif k == "polygon":
            render_polygon_question(dict(common, prompt=q["prompt"], seq=q["seq"],
                                         options=q["options"]))
        elif k == "dot":
            render_dot_question(dict(common, prompt=q["prompt"], seq=q["seq"],
                                     options=q["options"]))
        elif k == "numseries":
            render_numseries_question(dict(common, prompt=q["prompt"], seq=q["seq"],
                                           options=q["options"]))
        else:
            render_fn = R.render_question
            render_fn(dict(common, question=q["question"], options=q["options"]))
        # frame 0 (full timer + full bar) doubles as the static "read" plate
        shutil.copy(f"{FRAMES}/q{q['idx']}/00000.png", f"{FRAMES}/q{q['idx']}_read.png")

        rpath = f"{FRAMES}/r{q['idx']}.png"
        if k == "shaded":
            render_shaded_reveal(rpath, R.MINT, q["ans"], q["ans_shape"],
                                 q["ans_filled"], q["ans_label"], q["expl"])
        elif k == "polygon":
            render_polygon_reveal(rpath, R.MINT, q["ans"], q["ans_shape"],
                                  q["ans_label"], q["expl"])
        elif k == "dot":
            render_dot_reveal(rpath, R.MINT, q["ans"], q["ans_pos"],
                              q["ans_label"], q["expl"])
        else:
            R.render_reveal(rpath, R.MINT, q["ans"], q["ans_label"], q["expl"],
                            option_style=True)

    R.render_score(f"{FRAMES}/score.png", tiers=SCORE_TIERS)
    R.render_outro(f"{FRAMES}/outro.png")
    print(f"frames: animated title ({nt}f) + {TOTAL_Q} questions (+countdowns) + "
          f"reveals + score + outro -> {FRAMES}")


# ------------------------------------------------------------------- bodies
def bodies():
    os.makedirs(BODIES, exist_ok=True)
    for key, (style, line) in NARR.items():
        body = {"model": MODEL, "input": f"{style}: {line}", "voice": VOICE}
        with open(f"{BODIES}/{key}.json", "w") as f:
            json.dump(body, f)
    print(f"bodies: wrote {len(NARR)} Gemini TTS request bodies -> {BODIES}")


# -------------------------------------------------------------- clip helpers
def _title_clip(out):
    """The animated intro: play the assemble frames, hold the settled title, all
    under the intro VO (delayed by LEAD). Mirrors the static-clip timing model."""
    seg = TITLE_FRAMES
    n = len([x for x in os.listdir(seg) if x.endswith(".png")])
    base = round(n / 30.0, 3)
    intro = wav_dur(f"{VO}/intro.wav")
    total = round(LEAD + intro + TRAIL, 3)
    hold = round(max(0.0, total - base), 3)
    dly = int(LEAD * 1000)
    vf = f"[0:v]tpad=stop_mode=clone:stop_duration={hold}[v]"
    af = f"[1:a]adelay={dly}|{dly},apad[a]"
    cmd = [FF, "-y", "-loglevel", "error",
           "-framerate", "30", "-i", f"{seg}/%05d.png",
           "-i", f"{VO}/intro.wav",
           "-filter_complex", vf + ";" + af,
           "-map", "[v]", "-map", "[a]", *ENC_INT, *AENC, "-t", f"{total}", out]
    sh(cmd)
    return total


def _static_clip(out, png, vo_key, ding=False):
    d = round(LEAD + wav_dur(f"{VO}/{vo_key}.wav") + TRAIL, 3)
    dly = int(LEAD * 1000)
    cmd = [FF, "-y", "-loglevel", "error",
           "-loop", "1", "-framerate", "30", "-t", f"{d}", "-i", png,
           "-i", f"{VO}/{vo_key}.wav"]
    if ding:
        cmd += ["-f", "lavfi", "-i", f"aevalsrc=exprs='{DING}':d=2:s={AR}"]
        fc = (f"[1:a]adelay={dly}|{dly}[vo];"
              f"[2:a]adelay=120|120[dg];"
              f"[vo][dg]amix=inputs=2:normalize=0,apad[a]")
    else:
        fc = f"[1:a]adelay={dly}|{dly},apad[a]"
    cmd += ["-filter_complex", fc, "-map", "0:v", "-map", "[a]",
            *ENC_INT, *AENC, "-t", f"{d}", out]
    sh(cmd)
    return d


def _count_clip(out, qidx, cd):
    seg = f"{FRAMES}/q{qidx}"
    n = len([x for x in os.listdir(seg) if x.endswith(".png")])
    base = round(n / 30.0, 3)                       # cd + 1s hold on "0"
    tu = wav_dur(f"{VO}/timesup.wav")
    tu_at = float(cd)                               # fire "time's up" as clock hits 0
    d = round(max(base, tu_at + tu + 0.30), 3)      # hold last frame so VO rings out
    hold = round(d - base, 3)
    vf = "[0:v]tpad=stop_mode=clone:stop_duration=%s[v]" % hold if hold > 0 else None
    dly = int(tu_at * 1000)
    af = (f"[2:a]adelay={dly}|{dly}[tu];"
          f"[1:a][tu]amix=inputs=2:normalize=0,apad[a]")
    fc = (vf + ";" + af) if vf else af
    vmap = "[v]" if vf else "0:v"
    cmd = [FF, "-y", "-loglevel", "error",
           "-framerate", "30", "-i", f"{seg}/%05d.png",
           "-f", "lavfi", "-i", f"aevalsrc=exprs='{TICK}':d={cd}:s={AR}",  # ticks stop at 0
           "-i", f"{VO}/timesup.wav",
           "-filter_complex", fc,
           "-map", vmap, "-map", "[a]", *ENC_INT, *AENC, "-t", f"{d}", out]
    sh(cmd)
    return d


def _plan():
    """Ordered per-segment timeline: (clip name, kind, arg, vo_key, ding, cd).
    Segment 1 is the ANIMATED title (kind 'title'); it uses the intro VO."""
    seq = [("title", "title", TITLE_FRAMES, "intro", False, None)]
    for q in QUESTIONS:
        i = q["idx"]
        seq.append((f"q{i}read", "static", f"{FRAMES}/q{i}_read.png", f"q{i}", False, None))
        seq.append((f"q{i}cnt", "count", i, None, None, q["countdown"]))
        seq.append((f"r{i}", "static", f"{FRAMES}/r{i}.png", f"r{i}", True, None))
    seq.append(("score", "static", f"{FRAMES}/score.png", "score", False, None))
    seq.append(("outro", "static", f"{FRAMES}/outro.png", "outro", False, None))
    return [(f"{n:02d}_{name}", kind, arg, vo, ding, cd)
            for n, (name, kind, arg, vo, ding, cd) in enumerate(seq, 1)]


def _probe_dur(path):
    return float(sh([FP, "-v", "error", "-show_entries", "format=duration",
                     "-of", "default=nk=1:nw=1", path]).stdout.strip())


# ------------------------------------------------------------------- build
def build():
    os.makedirs(CLIPS, exist_ok=True)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    clips, rows, total = [], [], 0.0
    for name, kind, arg, vo, ding, cd in _plan():
        out = f"{CLIPS}/{name}.mp4"
        if kind == "title":
            d = _title_clip(out)
        elif kind == "static":
            d = _static_clip(out, arg, vo, ding=ding)
        else:
            d = _count_clip(out, arg, cd)
        clips.append(out)
        rows.append([name, kind, d])
        total += d
        print(f"  built {name:12s} {kind:6s} {d:6.2f}s")

    # concat -> HQ video + baked VO/SFX audio (single crf16/slow compression pass)
    ins = []
    for c in clips:
        ins += ["-i", c]
    streams = "".join(f"[{i}:v][{i}:a]" for i in range(len(clips)))
    fc = f"{streams}concat=n={len(clips)}:v=1:a=1[v][a]"
    sh([FF, "-y", "-loglevel", "error", *ins, "-filter_complex", fc,
        "-map", "[v]", "-map", "[a]", *ENC_HQ, *AENC, "-movflags", "+faststart",
        CONCAT_AV])

    with open(META, "w") as f:
        json.dump({"rows": rows, "total": total}, f)
    print(f"\nSegments: {len(rows)}   target total ~{total:.2f}s ({total/60:.1f} min)")
    print("A/V master (HQ video + VO):", CONCAT_AV)


# ------------------------------------------------------------------- music
def _build_bed(total, gain_db):
    """Fanfare open -> looped Prize Wheel Parade bed -> Winner Spin close, with
    crossfades and fade in/out, summed and trimmed to `total`, at master gain."""
    bed = f"{WORK}/bed.wav"
    par_start = FAN_LEN - XF
    win_start = max(par_start + 6.0, total - WIN_LEN)
    par_len = max(4.0, (win_start + XF) - par_start)
    fan_delay = 0
    par_delay = int(par_start * 1000)
    win_delay = int(win_start * 1000)

    def stem(idx, dur, vol, delay_ms):
        fo = max(0.1, dur - FADE)
        s = (f"[{idx}:a]atrim=0:{dur:.3f},asetpts=PTS-STARTPTS,"
             f"afade=t=in:st=0:d={FADE},afade=t=out:st={fo:.3f}:d={FADE},"
             f"volume={vol:.2f}dB,aformat=sample_rates={AR}:channel_layouts=stereo")
        if delay_ms:
            s += f",adelay={delay_ms}|{delay_ms}"
        return s

    # The Prize Wheel Parade bed is looped (-stream_loop -1) so it fills the full
    # ~10-12 min body between the fanfare open and the winner-spin close.
    fc = (
        stem(0, FAN_LEN, STEM_VOL["fan"], fan_delay) + "[a];"
        + stem(1, par_len, STEM_VOL["par"], par_delay) + "[b];"
        + stem(2, WIN_LEN, STEM_VOL["win"], win_delay) + "[c];"
        f"[a][b][c]amix=inputs=3:normalize=0:dropout_transition=0,"
        f"atrim=0:{total:.3f},asetpts=PTS-STARTPTS,volume={gain_db:.2f}dB,"
        f"aresample={AR}[bed]"
    )
    sh([FF, "-y", "-loglevel", "error",
        "-i", FANFARE, "-stream_loop", "-1", "-i", PARADE, "-i", WINNER,
        "-filter_complex", fc, "-map", "[bed]", "-ac", "2", "-ar", str(AR), bed])
    return bed, dict(par_start=par_start, win_start=win_start, par_len=par_len)


def _duck(bed, vo):
    """Sidechain-compress the music bed, keyed by the VO, so music ducks when the
    host speaks and swells back in the gaps."""
    ducked = f"{WORK}/bed_ducked.wav"
    sh([FF, "-y", "-loglevel", "error", "-i", bed, "-i", vo,
        "-filter_complex", f"[0:a][1:a]sidechaincompress={SC}[out]",
        "-map", "[out]", "-ac", "2", "-ar", str(AR), ducked])
    return ducked


def _mean_db(path, t0, t1):
    """Mean volume (dBFS) of a time window via ffmpeg volumedetect."""
    p = subprocess.run([FF, "-hide_banner", "-nostats", "-ss", f"{t0:.3f}",
                        "-to", f"{t1:.3f}", "-i", path, "-af", "volumedetect",
                        "-f", "null", "-"], capture_output=True, text=True)
    m = re.search(r"mean_volume:\s*(-?[\d.]+) dB", p.stderr)
    return float(m.group(1)) if m else float("nan")


def music():
    meta = json.load(open(META))
    rows, total = meta["rows"], meta["total"]
    total = _probe_dur(CONCAT_AV)  # authoritative
    os.makedirs(os.path.dirname(OUT), exist_ok=True)

    # extract the VO/SFX master audio (sidechain key + top layer)
    vo = f"{WORK}/vo.wav"
    sh([FF, "-y", "-loglevel", "error", "-i", CONCAT_AV, "-vn",
        "-acodec", "pcm_s16le", "-ar", str(AR), "-ac", "2", vo])

    # measurement windows from the title/intro segment
    title_dur = rows[0][2]
    intro_vo = wav_dur(f"{VO}/intro.wav")
    sp0, sp1 = LEAD + 0.5, LEAD + intro_vo - 0.5          # VO speech window
    mo0, mo1 = title_dur - 0.55, title_dur - 0.10          # music-only (VO silent) window
    vo_mean = _mean_db(vo, sp0, sp1)

    # pass 1: neutral master gain -> measure the natural VO/music separation
    bed0, _ = _build_bed(total, 0.0)
    duck0 = _duck(bed0, vo)
    m_under0 = _mean_db(duck0, sp0, sp1)
    sep0 = vo_mean - m_under0
    gain = round(sep0 - TARGET_SEP_DB, 2)                  # slope is -1 dB/dB

    # pass 2: calibrated bed -> duck -> mux
    bed, cues = _build_bed(total, gain)
    ducked = _duck(bed, vo)
    sh([FF, "-y", "-loglevel", "error", "-i", CONCAT_AV, "-i", ducked,
        "-filter_complex",
        "[0:a][1:a]amix=inputs=2:normalize=0:duration=first,alimiter=limit=0.98:level=false[a]",
        "-map", "0:v", "-map", "[a]", "-c:v", "copy", *AENC,
        "-movflags", "+faststart", OUT])

    # final measurements
    m_under = _mean_db(ducked, sp0, sp1)      # ducked music under VO
    m_only = _mean_db(ducked, mo0, mo1)       # music bed with VO silent (full)
    out_sp = _mean_db(OUT, sp0, sp1)          # final mix during VO
    out_mo = _mean_db(OUT, mo0, mo1)          # final mix, music-only
    sep = vo_mean - m_under
    duck_depth = m_only - m_under

    print("\n=== MUSIC / LOUDNESS ===")
    print(f"  master bed gain (auto-calibrated): {gain:+.2f} dB  (pass-1 sep {sep0:.1f} dB)")
    print(f"  cues: fanfare 0-{FAN_LEN:.0f}s | parade {cues['par_start']:.1f}-"
          f"{cues['win_start']:.1f}s (looped, {cues['par_len']:.0f}s) | "
          f"winner {cues['win_start']:.1f}-{total:.1f}s")
    print(f"  VO speech window   [{sp0:.2f},{sp1:.2f}]s  mean {vo_mean:.1f} dBFS")
    print(f"  music UNDER VO     mean {m_under:.1f} dBFS   -> VO is {sep:.1f} dB above music")
    print(f"  music-only (gap)   mean {m_only:.1f} dBFS   -> sidechain duck depth {duck_depth:.1f} dB")
    print(f"  final mix @VO      mean {out_sp:.1f} dBFS")
    print(f"  final mix @gap     mean {out_mo:.1f} dBFS")

    _verify(rows, total)


def _verify(rows, total):
    print("\n=== FFPROBE VERIFY ===")
    info = sh([FP, "-v", "error", "-show_entries",
               "format=duration,size:stream=codec_type,codec_name,width,height,"
               "r_frame_rate,sample_rate,channels,duration",
               "-of", "default=noprint_wrappers=1", OUT]).stdout
    print(info.strip())
    vdur = _probe_dur_stream("v")
    adur = _probe_dur_stream("a")
    print(f"  video {vdur:.3f}s  audio {adur:.3f}s  drift {abs(vdur-adur)*1000:.0f} ms")

    # frame offsets from the FINAL mp4
    off, cur = {}, 0.0
    for name, _kind, d in rows:
        off[name] = cur
        cur += d
    # The 3 REQUIRED frames: assembled animated title, a mid quiz question, the
    # parent-email outro. Plus 3 bonus QA frames for the copied nonverbal helpers.
    grab = [
        ("title-assembled", off["01_title"] + 3.5, "/tmp/r15_frame_title.png"),
        ("mid-question-Q8", off["23_q8read"] + 1.3, "/tmp/r15_frame_question.png"),
        ("outro", off["48_outro"] + min(2.8, rows[-1][2] - 0.5), "/tmp/r15_frame_outro.png"),
        ("shaded-Q3", off["08_q3read"] + 1.0, "/tmp/r15_frame_shaded.png"),
        ("polygon-Q11", off["32_q11read"] + 1.0, "/tmp/r15_frame_polygon.png"),
        ("dot-Q13", off["38_q13read"] + 1.0, "/tmp/r15_frame_dot.png"),
    ]
    print("\n=== SAMPLE FRAMES ===")
    for label, t, path in grab:
        sh([FF, "-y", "-loglevel", "error", "-ss", f"{t:.3f}", "-i", OUT,
            "-frames:v", "1", path])
        print(f"  {label:16s} @ {t:7.2f}s -> {path}")
    print(f"\nOUTPUT: {OUT}")


def _probe_dur_stream(kind):
    return float(sh([FP, "-v", "error", "-select_streams", f"{kind}:0",
                     "-show_entries", "stream=duration", "-of",
                     "default=nk=1:nw=1", OUT]).stdout.strip())


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "build"
    {"frames": frames, "bodies": bodies, "build": build, "music": music,
     "sample": render_intro_sample,   # PHASE-1: render the intro approval clip
     "still": lambda: render_title_still("/tmp/r15_title_still.png"),
     }[cmd]()
