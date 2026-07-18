#!/usr/bin/env python3
"""
Render the Gemini-voiced master quiz video -- Round 03, "CogAT Style".

Runs the same proven pipeline as Round 01/02 (see render_cogat_round.py, the
Round-02 orchestrator this is modeled on -- READ, never edited), reusing the
shared, read-only brand toolkit render_demo_quiz.py verbatim:
  - on-brand Pillow plates (Anton + DM Sans, thick pure-black borders, HARD
    zero-blur offset shadows, rotating color blocks, mint check reveals),
    supersampled for crisp anti-aliasing (QUIZ_SS=4),
  - narration from Gemini TTS (gemini-2.5-pro-preview-tts, voice "Puck") via the
    gateway in gen_vo.sh (API key loaded from .env.local, NEVER printed),
  - a light tick bed under each countdown + a soft ding under each reveal,
  - a ducked music arc (Game Show Fanfare -> Prize Wheel Parade bed -> Winner
    Spin) sidechained ~12 dB under the VO, then an HQ libx264 crf16/slow encode.

Content is the 5 ORIGINAL CogAT-STYLE reasoning items in
video/content/cogat-style-round-03.md:
  Q1 verbal analogy, Q2 sentence completion, Q3 number series, Q4 number analogy,
  Q5 nonverbal FIGURE SERIES -- shapes gain one side each step (triangle ->
  square -> pentagon -> ?), drawn here as regular-polygon icons + polygon-icon
  options (the polygon drawing helpers live IN THIS FILE; the shared module is
  not touched). Parent-email gate only; no child PII; no Alpha branding.

This file writes ONLY its own artifacts:
  frames/VO/clips under /tmp/r03_work + /tmp/vo_r03, sample frames /tmp/r03_*.png,
  and the deliverable video/renders/round-03-cogat-master.mp4.

Steps (run in order):
  render_cogat_round_03.py frames   # draw all PNGs / countdown sequences (SSAA)
  render_cogat_round_03.py bodies   # write Gemini TTS request bodies (no API key)
  # ...then the wavs:  VO_BODIES=/tmp/vo_r03/bodies VO_OUT=/tmp/vo_r03 bash gen_vo.sh
  render_cogat_round_03.py build    # size to VO, per-seg HQ clips, concat -> A/V master
  render_cogat_round_03.py music    # build ducked music bed, mux, verify, sample frames
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

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("QUIZ_SS", "4")  # crisp supersampled anti-aliasing
import render_demo_quiz as R  # noqa: E402  (shared, read-only brand toolkit)

FF = "/opt/homebrew/bin/ffmpeg"
FP = "/opt/homebrew/bin/ffprobe"
ROOT = "/Users/khoilam/Documents/Crossover/30mpc-website-design-cursor"

# --- collision-avoidance: everything temp lives under /tmp/r03_* or /tmp/vo_r03 ---
WORK = "/tmp/r03_work"
FRAMES = f"{WORK}/frames"
CLIPS = f"{WORK}/clips"
VO = "/tmp/vo_r03"
BODIES = f"{VO}/bodies"
META = f"{WORK}/meta.json"
CONCAT_AV = f"{WORK}/round-03-concat.mp4"   # HQ video + baked VO/SFX audio
OUT = f"{ROOT}/video/renders/round-03-cogat-master.mp4"
FRAME_Q = "/tmp/r03_frame_question.png"     # sample: a text question plate
FRAME_POLY = "/tmp/r03_frame_polygon.png"   # sample: the polygon figure-series plate

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

# key -> (style, spoken line). Fresh, original Round-03 narration.
NARR = {
    "intro": (HOST,
              "Welcome back, brain athletes, to the Brain Teaser Quiz! This is "
              "round three, and I've got five shiny new puzzles to make those "
              "mental gears spin. Words, numbers, and a shape-shifting stumper "
              "to finish. Thinking caps on, and let's play!"),
    "q1": (HOST,
           "Question one, word power! A pen is to write, as a broom is to... "
           "what? Is it A, sweep... B, bristles... C, floor... or D, dust? "
           "Five seconds, go!"),
    "q2": (HOST,
           "Question two, fill in the blank! The bridge was too weak to hold "
           "the heavy truck. So before opening the road, workers had to... what? "
           "A, decorate... B, reinforce... C, rename... or D, measure? Six "
           "seconds!"),
    "q3": (HOST,
           "Question three, a number series! Three, six, twelve, twenty-four, "
           "and then... what comes next? A, thirty-six... B, forty-eight... "
           "C, thirty... or D, forty-two? Five seconds on the clock!"),
    "q4": (HOST,
           "Question four, a number analogy! Twelve gives six, twenty gives ten, "
           "eight gives four, so thirty gives... what? A, twelve... B, fifteen... "
           "C, twenty... or D, twenty-five? Six seconds!"),
    "q5": (HOST,
           "Last one, a shape puzzle! Watch them grow: a triangle, then a "
           "square, then a pentagon, each one gaining a side. Which shape comes "
           "next? A, circle... B, hexagon... C, square... or D, octagon? Six "
           "seconds!"),
    "timesup": (URGENT, "Time's up! Pencils down!"),
    "r1": (REVEAL,
           "The answer is A, sweep! A pen's whole job is to write, and a broom's "
           "whole job is to sweep. Match the tool to what it does!"),
    "r2": (REVEAL,
           "It's B, reinforce! The bridge was too weak, so you have to make it "
           "stronger. Reinforce is the only word that fixes the problem!"),
    "r3": (REVEAL,
           "The answer is B, forty-eight! Each number simply doubles: three, "
           "six, twelve, twenty-four... and twenty-four times two is forty-eight!"),
    "r4": (REVEAL,
           "It's B, fifteen! Every number gets cut in half. Twelve to six, "
           "twenty to ten, eight to four... so thirty to fifteen!"),
    "r5": (REVEAL,
           "The answer is B, hexagon! Count the sides: triangle three, square "
           "four, pentagon five... so next comes the six-sided hexagon!"),
    "score": (HOST,
              "So how'd you stack up? Five out of five, you are a certified "
              "smart fella! Three or four, one seriously sharp cookie. Two or "
              "fewer? Hey, every great mind starts at question one!"),
    "outro": (WARM,
              "Want to see your full results and how you rank? Ask a parent or "
              "guardian to pop their email on the screen. There are five hundred "
              "dollar and two thousand dollar prizes for parents up for grabs. "
              "Check the official rules, and we'll see you in the next round!"),
}

# ---- the 5 CogAT-style questions (see video/content/cogat-style-round-03.md) ----
# Q5 shapes are encoded by side-count (3,4,5,6,8) or the string "circle".
TOTAL_Q = 5
QUESTIONS = [
    dict(idx=1, kind="text", bg=R.YELLOW, tier="VERBAL ANALOGY", tier_color=R.CORAL,
         question="PEN IS TO WRITE AS\nBROOM IS TO ?",
         options=[("A", "SWEEP"), ("B", "BRISTLES"), ("C", "FLOOR"), ("D", "DUST")],
         countdown=5, cd_accent=R.CORAL, bar_accent=R.CORAL,
         ans="A", ans_label="SWEEP",
         expl="A pen's job is to write; a broom's job is to sweep - the tool "
              "matched to the action it performs."),
    dict(idx=2, kind="text", bg=R.BLUE, tier="SENTENCE COMPLETION", tier_color=R.MINT,
         question="THE BRIDGE WAS TOO WEAK TO HOLD THE\n"
                  "HEAVY TRUCK, SO WORKERS HAD TO ______\nIT BEFORE OPENING THE ROAD.",
         options=[("A", "DECORATE"), ("B", "REINFORCE"), ("C", "RENAME"), ("D", "MEASURE")],
         countdown=6, cd_accent=R.YELLOW, bar_accent=R.YELLOW,
         ans="B", ans_label="REINFORCE",
         expl="\"Too weak\" calls for strengthening - only reinforce fixes the "
              "problem the sentence describes."),
    dict(idx=3, kind="text", bg=R.CORAL, tier="NUMBER SERIES", tier_color=R.YELLOW,
         question="WHAT COMES NEXT?\n3   6   12   24   ?",
         options=[("A", "36"), ("B", "48"), ("C", "30"), ("D", "42")],
         countdown=5, cd_accent=R.YELLOW, bar_accent=R.YELLOW,
         ans="B", ans_label="48",
         expl="Each number doubles (x2): 3, 6, 12, 24, so the next is "
              "24 x 2 = 48."),
    dict(idx=4, kind="text", bg=R.YELLOW, tier="NUMBER ANALOGY", tier_color=R.BLUE,
         question="WHICH NUMBER FITS?\n12 -> 6,   20 -> 10,   8 -> 4,   30 -> ?",
         options=[("A", "12"), ("B", "15"), ("C", "20"), ("D", "25")],
         countdown=6, cd_accent=R.BLUE, bar_accent=R.BLUE,
         ans="B", ans_label="15",
         expl="Each number is cut in half (/2): 12->6, 20->10, 8->4, so "
              "30 / 2 = 15."),
    dict(idx=5, kind="shape", bg=R.BLUE, tier="FIGURE SERIES", tier_color=R.YELLOW,
         prompt="WHICH SHAPE COMES NEXT?",
         seq=[3, 4, 5],  # triangle -> square -> pentagon
         options=[("A", "circle"), ("B", 6), ("C", 4), ("D", 8)],
         countdown=6, cd_accent=R.YELLOW, bar_accent=R.YELLOW,
         ans="B", ans_label="HEXAGON", ans_shape=6,
         expl="The sides count up by one: triangle 3, square 4, pentagon 5, "
              "so next is the hexagon with 6 sides."),
]

SCORE_TIERS = [
    ("5 / 5", "CERTIFIED SMART FELLA", R.MINT),
    ("3-4", "SHARP COOKIE", R.YELLOW),
    ("0-2", "ROOKIE RIDDLER", R.CORAL),
]

# Light audio bed exprs (kept low so the VO stays on top).
TICK = "0.09*sin(2*PI*1150*t)*exp(-32*mod(t,1))"
DING = "0.16*sin(2*PI*880*t)*exp(-3.5*t)+0.10*sin(2*PI*1320*t)*exp(-3.5*t)"

LEAD = 0.35      # silence before VO on static plates
TRAIL = 0.80     # silence after VO on static plates
AR = 48000

# --- HQ deliverable encode (libx264 crf16 preset slow, yuv420p) ---
ENC_HQ = [
    "-c:v", "libx264", "-preset", "slow", "-crf", "16", "-pix_fmt", "yuv420p",
    "-r", "30", "-profile:v", "high", "-level:v", "4.2",
    "-x264-params", "keyint=60:min-keyint=60:scenecut=0",
    "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709",
]
# Near-lossless per-segment intermediate so the single crf16 concat is the only
# meaningful compression step (no visible generation loss on the flat-color art).
ENC_INT = [
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "12", "-pix_fmt", "yuv420p",
    "-r", "30", "-profile:v", "high", "-level:v", "4.2",
    "-x264-params", "keyint=60:min-keyint=60:scenecut=0",
    "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709",
]
AENC = ["-c:a", "aac", "-b:a", "192k", "-ar", str(AR), "-ac", "2"]

# --- music mix design (identical arc/params to Round 02) ---
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


# ================================================================= polygon art
# Self-contained neo-brutalist regular-polygon / circle drawing for the Q5
# figure-series item. Defined HERE (not in the shared module) per spec. Draws in
# logical 1920x1080 units through R's _SSDraw wrapper, so edges stay crisp under
# supersampling, exactly like the shared draw_arrow primitive.

# Per-shape start angle (deg) chosen so each reads "correctly": triangle/pentagon
# point up with a flat base, square + octagon are axis-aligned (flat top), and
# the hexagon is flat-topped (classic honeycomb).
SHAPE_ROT = {3: -90.0, 4: 45.0, 5: -90.0, 6: 0.0, 7: -90.0, 8: 22.5}


def _poly_points(cx, cy, r, sides, rot_deg):
    return [
        (cx + r * math.cos(math.radians(rot_deg + i * 360.0 / sides)),
         cy + r * math.sin(math.radians(rot_deg + i * 360.0 / sides)))
        for i in range(sides)
    ]


def draw_shape(d, cx, cy, r, shape, fill, border=8, shadow=14):
    """Neo-brutalist regular polygon (or circle) at (cx,cy): colored fill, pure
    black border, hard ZERO-blur offset shadow. `shape` is an int side-count
    (3,4,5,6,8...) or the string 'circle'. `r` is the circumradius."""
    if shape == "circle":
        if shadow:
            d.ellipse([cx - r + shadow, cy - r + shadow,
                       cx + r + shadow, cy + r + shadow], fill=R.INK)
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=fill,
                  outline=R.INK, width=border)
        return
    pts = _poly_points(cx, cy, r, int(shape), SHAPE_ROT.get(int(shape), -90.0))
    if shadow:
        d.polygon([(px + shadow, py + shadow) for px, py in pts], fill=R.INK)
    d.polygon(pts, fill=fill, outline=R.INK, width=border)


def _shape_cell(d, box, shape=None, question=False, color=R.BLUE):
    """One card in the figure-series strip: a colored shape icon, or a big '?'
    for the missing final step (mirrors the shared _arrow_cell)."""
    R.hard_card(d, box, R.PAPER, radius=22, border=7, shadow=11)
    cx = (box[0] + box[2]) / 2
    cy = (box[1] + box[3]) / 2
    if question:
        R.draw_text(d, cx, cy, "?", R.anton(int((box[3] - box[1]) * 0.60)),
                    R.INK, anchor="mm")
    else:
        s = min(box[2] - box[0], box[3] - box[1]) * 0.34
        draw_shape(d, cx, cy, s, shape, color)


def shape_option_tile(d, box, letter, shape, highlight=None):
    """An A-D option tile whose answer is a drawn shape icon (not text). Mirrors
    the shared arrow_option_tile: letter badge top-left, shape centered below."""
    fill = R.MINT if highlight == "correct" else R.PAPER
    R.hard_card(d, box, fill, radius=26, border=7, shadow=12)
    x0, y0, x1, y1 = box
    bsz = 78
    bx0, by0 = x0 + 22, y0 + 22
    R.hard_card(d, [bx0, by0, bx0 + bsz, by0 + bsz], R.BADGE_COLORS[letter],
                radius=16, border=6, shadow=7)
    R.draw_text(d, bx0 + bsz / 2, by0 + bsz / 2, letter, R.anton(int(bsz * 0.58)),
                R.INK, anchor="mm")
    scx = (x0 + x1) / 2
    scy = (y0 + y1) / 2 + 26
    s = min(x1 - x0, y1 - y0) * 0.30
    draw_shape(d, scx, scy, s, shape, R.BADGE_COLORS[letter])


def render_shape_question(cfg):
    """Nonverbal FIGURE-SERIES item (CogAT style): a growing-sides shape sequence
    (triangle -> square -> pentagon -> ?) plus four shape-icon options. Reuses
    the exact brand chrome + countdown machinery as R.render_question.

    cfg keys: idx, total, bg, tier, tier_color, prompt, seq(list of shapes),
    options(list of (letter, shape)), countdown, cd_accent, bar_accent, outdir.
    """
    outdir = cfg["outdir"]
    if os.path.isdir(outdir):
        shutil.rmtree(outdir)
    os.makedirs(outdir)

    base, d = R.new_frame(cfg["bg"])

    total = cfg.get("total", TOTAL_Q)
    r = R.pill_left(d, R.M, 100, f"QUESTION {cfg['idx']} OF {total}",
                    R.dm(34, "Bold"), fill=R.INK, txt_col=R.PAPER, tracking=3)
    tier_col = cfg.get("tier_color") or R.CORAL
    R.pill_left(d, r + 24, 100, cfg["tier"].upper(), R.dm(34, "Bold"),
                tier_col, txt_col=R.INK, tracking=3)

    R.hard_card(d, [R.CD_X0, R.CD_Y0, R.CD_X1, R.CD_Y1], cfg["cd_accent"],
                radius=28, border=9, shadow=14)

    # prompt card
    pbox = [R.M, 250, R.W - R.M, 396]
    R.hard_card(d, pbox, R.PAPER, radius=36, border=9, shadow=16)
    pf, plines = R.fit_font(d, cfg["prompt"], pbox[2] - pbox[0] - 90,
                            pbox[3] - pbox[1] - 28, [64, 58, 52, 46])
    R.draw_multiline_center(d, R.W / 2, (pbox[1] + pbox[3]) / 2, plines, pf, R.INK)

    # sequence strip: known shapes + a "?" cell
    seq = cfg["seq"]
    n = len(seq) + 1
    cw, chh, gap = 190, 190, 70
    sx = (R.W - (n * cw + (n - 1) * gap)) / 2
    sy = 430
    seq_colors = [R.BLUE, R.CORAL, R.YELLOW, R.MINT]
    for i, shape in enumerate(seq):
        bx = sx + i * (cw + gap)
        _shape_cell(d, [bx, sy, bx + cw, sy + chh], shape=shape,
                    color=seq_colors[i % len(seq_colors)])
    bx = sx + len(seq) * (cw + gap)
    _shape_cell(d, [bx, sy, bx + cw, sy + chh], question=True)

    # option row (four drawn-shape tiles)
    ow, oh, ogap = 395, 240, 40
    oy = 662
    for j, (letter, shape) in enumerate(cfg["options"]):
        bx = R.M + j * (ow + ogap)
        shape_option_tile(d, [bx, oy, bx + ow, oy + oh], letter, shape)

    # bar track
    d.rounded_rectangle([R.BAR_X, R.BAR_Y, R.BAR_X + R.BAR_W, R.BAR_Y + R.BAR_H],
                        radius=R.BAR_H // 2, fill=R.INK)

    return R._countdown_sequence(base, outdir, cfg["countdown"], cfg["bar_accent"])


def render_shape_reveal(path, bg, letter, shape, label, explanation):
    """Reveal plate for the figure-series item: a big drawn answer-shape + the
    A-D label + mint check, over the same card system as R.render_reveal."""
    img, d = R.new_frame(bg)
    R.pill_center(d, R.W / 2, 150, "CORRECT ANSWER", R.dm(38, "Bold"),
                  txt_col=R.PAPER, tracking=4, fill=R.INK, pad_x=36, pad_y=18)
    box = [R.M, 250, R.W - R.M, 636]
    R.hard_card(d, box, R.PAPER, radius=44, border=10, shadow=22)
    cy = (box[1] + box[3]) / 2
    ax = R.M + 250
    draw_shape(d, ax, cy, 150, shape, R.BADGE_COLORS[letter], border=10, shadow=16)
    R.badge_circle(d, box[2] - 150, box[1] + 110, 58, R.MINT)
    R.draw_check(d, box[2] - 150, box[1] + 110, 72, R.INK, width=18)
    lab_left = ax + 210
    lf, llines = R.fit_font(d, f"{letter})  {label}", (R.W - R.M) - lab_left - 40,
                            200, [120, 104, 92, 80])
    R.draw_multiline_center(d, (lab_left + (R.W - R.M)) / 2, cy, llines, lf, R.INK)
    ebox = [R.M, 686, R.W - R.M, 902]
    R.hard_card(d, ebox, R.CREAM, radius=36, border=8, shadow=16)
    ef = R.dm(40, "Medium")
    elines = R.wrap(d, explanation, ef, ebox[2] - ebox[0] - 120)
    R.draw_multiline_center(d, R.W / 2, (ebox[1] + ebox[3]) / 2, elines, ef,
                            R.INK, leading=1.28)
    R._finalize(img).save(path)


# ------------------------------------------------------------------- frames
def frames():
    for d in (FRAMES, CLIPS):
        os.makedirs(d, exist_ok=True)

    R.render_title(f"{FRAMES}/title.png")

    for q in QUESTIONS:
        if q["kind"] == "shape":
            cfg = dict(idx=q["idx"], total=TOTAL_Q, bg=q["bg"], tier=q["tier"],
                       tier_color=q["tier_color"], prompt=q["prompt"], seq=q["seq"],
                       options=q["options"], countdown=q["countdown"],
                       cd_accent=q["cd_accent"], bar_accent=q["bar_accent"],
                       outdir=f"{FRAMES}/q{q['idx']}")
            render_shape_question(cfg)
        else:
            cfg = dict(idx=q["idx"], total=TOTAL_Q, bg=q["bg"], tier=q["tier"],
                       tier_color=q["tier_color"], question=q["question"],
                       options=q["options"], countdown=q["countdown"],
                       cd_accent=q["cd_accent"], bar_accent=q["bar_accent"],
                       outdir=f"{FRAMES}/q{q['idx']}")
            R.render_question(cfg)
        # frame 0 (full timer + full bar) doubles as the static "read" plate
        shutil.copy(f"{FRAMES}/q{q['idx']}/00000.png", f"{FRAMES}/q{q['idx']}_read.png")

        if q["kind"] == "shape":
            render_shape_reveal(f"{FRAMES}/r{q['idx']}.png", R.MINT, q["ans"],
                                q["ans_shape"], q["ans_label"], q["expl"])
        else:
            R.render_reveal(f"{FRAMES}/r{q['idx']}.png", R.MINT, q["ans"],
                            q["ans_label"], q["expl"])

    R.render_score(f"{FRAMES}/score.png", tiers=SCORE_TIERS)
    R.render_outro(f"{FRAMES}/outro.png")
    print(f"frames: title + {TOTAL_Q} questions (+countdowns) + reveals + score + outro -> {FRAMES}")


# ------------------------------------------------------------------- bodies
def bodies():
    os.makedirs(BODIES, exist_ok=True)
    for key, (style, line) in NARR.items():
        body = {"model": MODEL, "input": f"{style}: {line}", "voice": VOICE}
        with open(f"{BODIES}/{key}.json", "w") as f:
            json.dump(body, f)
    print(f"bodies: wrote {len(NARR)} Gemini TTS request bodies -> {BODIES}")


# -------------------------------------------------------------- clip helpers
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
    """Ordered per-segment timeline: (clip name, kind, arg, vo_key, ding, cd)."""
    seq = [("title", "static", f"{FRAMES}/title.png", "intro", False, None)]
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
        d = _static_clip(out, arg, vo, ding=ding) if kind == "static" else _count_clip(out, arg, cd)
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
    print(f"\nSegments: {len(rows)}   target total ~{total:.2f}s")
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
    # A/V sync: compare stream durations
    vdur = _probe_dur_stream("v")
    adur = _probe_dur_stream("a")
    print(f"  video {vdur:.3f}s  audio {adur:.3f}s  drift {abs(vdur-adur)*1000:.0f} ms")

    # extract 2 representative frames from the FINAL mp4
    off, cur = {}, 0.0
    for name, _kind, d in rows:
        off[name] = cur
        cur += d
    grab = [
        ("verbal-Q1", off["02_q1read"] + 1.2, FRAME_Q),
        ("figure-Q5", off["14_q5read"] + 1.0, FRAME_POLY),
    ]
    print("\n=== SAMPLE FRAMES ===")
    for label, t, path in grab:
        sh([FF, "-y", "-loglevel", "error", "-ss", f"{t:.3f}", "-i", OUT,
            "-frames:v", "1", path])
        print(f"  {label:10s} @ {t:6.2f}s -> {path}")
    print(f"\nOUTPUT: {OUT}")


def _probe_dur_stream(kind):
    return float(sh([FP, "-v", "error", "-select_streams", f"{kind}:0",
                     "-show_entries", "stream=duration", "-of",
                     "default=nk=1:nw=1", OUT]).stdout.strip())


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "build"
    {"frames": frames, "bodies": bodies, "build": build, "music": music}[cmd]()
