#!/usr/bin/env python3
"""
Render frames for the "Smart Fella" demo quiz video (Kid Loop, round 01).

Because the local ffmpeg build has no drawtext/libfreetype, ALL text + brand
graphics are rendered here with Pillow (Anton + DM Sans), on-brand:
  - thick pure-black borders
  - HARD offset shadows (a solid black shape offset down-right, ZERO blur)
  - flat bright color-blocking, rounded bordered cards, mint check reveals
Each segment writes either a single PNG (static) or a frame sequence (countdown).
ffmpeg (see render_demo_quiz.sh) then turns these into per-segment H.264 clips
and concatenates them.

Content is ORIGINAL (drawn from video/content/starter-quiz-bank.md):
  Q1  Q16  which animal cannot jump   -> C) Elephant   (Warm-Up, 6s)
  Q2  Q17  which planet is hottest    -> B) Venus       (Brain-Bender, 7s)
  Q3  Q11  Fibonacci next number      -> C) 13          (Big-Brain, 9s)
No copyrighted/source-video material; parent-email gate only; no Alpha branding.
"""
import math
import os
import shutil
from PIL import Image, ImageDraw, ImageFont

W, H = 1920, 1080
FPS = 30
M = 110  # outer margin (~action safe)

# --- supersampled anti-aliasing (SSAA) ---
# Every plate/frame is composed on a canvas SS times larger, using the SAME
# logical 1920x1080 coordinates, then downscaled to 1920x1080 with LANCZOS on
# save. This is what smooths rounded corners, circle/badge edges, thick borders,
# hard-shadow edges, and all Anton/DM Sans text. It changes NO brand spec:
# colors, borders, radii, and layout are identical, and because the hard offset
# shadows are drawn as solid offset shapes (zero blur) they stay crisp -- SSAA
# only removes the stair-stepped jaggies, it does not soften the design.
# Default 3x (5760x3240); override with QUIZ_SS=4 (7680x4320) for even smoother.
SS = int(os.environ.get("QUIZ_SS", "3"))

# --- brand palette (sRGB, from DESIGN.md) ---
INK = (0, 0, 0)
PAPER = (255, 255, 255)
BLUE = (131, 154, 255)     # #839AFF
MINT = (198, 252, 208)     # #C6FCD0
CORAL = (253, 121, 98)     # #FD7962
YELLOW = (252, 229, 82)    # #FCE552
CREAM = (246, 244, 238)    # #F6F4EE

ANTON_PATH = "/tmp/Anton-Regular.ttf"
DM_PATH = "/tmp/DMSans.ttf"

OUT = "/tmp/qz_seg"

_dm_names_cache = None


class _SSFont:
    """A PIL font loaded at SS x its logical size, but reporting LOGICAL metrics
    and size so every measurement-driven layout stays in 1920x1080 space."""

    __slots__ = ("real", "size")

    def __init__(self, real, logical_size):
        self.real = real
        self.size = logical_size

    def getmetrics(self):
        asc, desc = self.real.getmetrics()
        return asc / SS, desc / SS


class _SSDraw:
    """Thin ImageDraw wrapper: code keeps drawing in logical 1920x1080 units and
    this scales every coordinate, corner radius and stroke width by SS (and swaps
    in the SS-sized real font) so it lands on the supersampled canvas. textlength
    is divided back down to logical units so layout math is unchanged. Only the
    primitives this module actually uses are wrapped."""

    def __init__(self, draw):
        self.d = draw

    @staticmethod
    def _pts(xy):
        if xy and isinstance(xy[0], (tuple, list)):
            return [(p[0] * SS, p[1] * SS) for p in xy]
        return [c * SS for c in xy]

    @staticmethod
    def _w(width):
        return max(1, int(round(width * SS)))

    def rounded_rectangle(self, xy, radius=0, fill=None, outline=None, width=1):
        self.d.rounded_rectangle(self._pts(xy), radius=int(round(radius * SS)),
                                 fill=fill, outline=outline, width=self._w(width))

    def ellipse(self, xy, fill=None, outline=None, width=1):
        self.d.ellipse(self._pts(xy), fill=fill, outline=outline, width=self._w(width))

    def line(self, xy, fill=None, width=0, joint=None):
        self.d.line(self._pts(xy), fill=fill, width=self._w(width), joint=joint)

    def polygon(self, xy, fill=None, outline=None, width=1):
        self.d.polygon(self._pts(xy), fill=fill, outline=outline, width=self._w(width))

    def text(self, xy, text, font=None, fill=None, anchor=None):
        rf = font.real if isinstance(font, _SSFont) else font
        self.d.text((xy[0] * SS, xy[1] * SS), text, font=rf, fill=fill, anchor=anchor)

    def textlength(self, text, font=None):
        rf = font.real if isinstance(font, _SSFont) else font
        return self.d.textlength(text, font=rf) / SS


def _finalize(img):
    """Downscale the supersampled canvas to the 1920x1080 deliverable (LANCZOS)."""
    if SS == 1:
        return img
    return img.resize((W, H), Image.LANCZOS)


def anton(sz):
    return _SSFont(ImageFont.truetype(ANTON_PATH, int(round(sz * SS))), sz)


def dm(sz, weight="Bold"):
    f = ImageFont.truetype(DM_PATH, int(round(sz * SS)))
    global _dm_names_cache
    try:
        if _dm_names_cache is None:
            _dm_names_cache = [
                (n.decode() if isinstance(n, bytes) else n)
                for n in f.get_variation_names()
            ]
        cand = [n for n in _dm_names_cache if n.lower() == weight.lower()]
        if not cand:
            cand = [n for n in _dm_names_cache if weight.lower() in n.lower()]
        if cand:
            f.set_variation_by_name(cand[0])
    except Exception:
        pass
    return _SSFont(f, sz)


# ---------------- text helpers ----------------

def text_width(d, text, font, tracking=0):
    w = d.textlength(text, font=font)
    if tracking and len(text) > 1:
        w += tracking * (len(text) - 1)
    return w


def draw_text(d, x, y, text, font, fill, anchor="la", tracking=0):
    """anchor: 2 chars like Pillow (h in l/m/r, v in a/m/s/d)."""
    if not tracking:
        d.text((x, y), text, font=font, fill=fill, anchor=anchor)
        return
    tw = text_width(d, text, font, tracking)
    ha, va = anchor[0], anchor[1]
    if ha == "m":
        sx = x - tw / 2
    elif ha == "r":
        sx = x - tw
    else:
        sx = x
    cx = sx
    for ch in text:
        d.text((cx, y), ch, font=font, fill=fill, anchor="l" + va)
        cx += d.textlength(ch, font=font) + tracking


def wrap(d, text, font, max_w, tracking=0):
    lines = []
    for para in text.split("\n"):
        words = para.split(" ")
        cur = ""
        for w in words:
            t = (cur + " " + w).strip()
            if text_width(d, t, font, tracking) <= max_w or not cur:
                cur = t
            else:
                lines.append(cur)
                cur = w
        lines.append(cur)
    return lines


def line_h(font, leading=1.0):
    asc, desc = font.getmetrics()
    return (asc + desc) * leading


def draw_multiline_center(d, cx, cy, lines, font, fill, leading=1.02, tracking=0):
    lh = line_h(font, leading)
    total = lh * len(lines)
    y = cy - total / 2 + lh / 2
    for ln in lines:
        draw_text(d, cx, y, ln, font, fill, anchor="mm", tracking=tracking)
        y += lh


def fit_font(d, text, max_w, max_h, sizes, tracking=0, leading=1.02):
    """Pick the largest Anton size whose wrapped text fits the box."""
    for sz in sizes:
        f = anton(sz)
        lines = wrap(d, text, f, max_w, tracking)
        if line_h(f, leading) * len(lines) <= max_h and all(
            text_width(d, ln, f, tracking) <= max_w for ln in lines
        ):
            return f, lines
    f = anton(sizes[-1])
    return f, wrap(d, text, f, max_w, tracking)


# ---------------- shape helpers (hard shadow + border) ----------------

def hard_card(d, box, fill, radius=36, border=8, shadow=16,
              border_col=INK, shadow_col=INK):
    x0, y0, x1, y1 = box
    if shadow:
        d.rounded_rectangle([x0 + shadow, y0 + shadow, x1 + shadow, y1 + shadow],
                            radius=radius, fill=shadow_col)
    d.rounded_rectangle([x0, y0, x1, y1], radius=radius, fill=fill)
    if border:
        d.rounded_rectangle([x0, y0, x1, y1], radius=radius,
                            outline=border_col, width=border)


def pill_left(d, left, cy, text, font, fill, txt_col=INK, pad_x=30, pad_y=16,
              border=6, shadow=8, tracking=2):
    tw = text_width(d, text, font, tracking)
    asc, desc = font.getmetrics()
    th = asc + desc
    w = tw + 2 * pad_x
    h = th + 2 * pad_y
    x0, y0 = left, cy - h / 2
    x1, y1 = left + w, cy + h / 2
    r = h / 2
    d.rounded_rectangle([x0 + shadow, y0 + shadow, x1 + shadow, y1 + shadow], radius=r, fill=INK)
    d.rounded_rectangle([x0, y0, x1, y1], radius=r, fill=fill)
    d.rounded_rectangle([x0, y0, x1, y1], radius=r, outline=INK, width=border)
    draw_text(d, (x0 + x1) / 2, cy, text, font, txt_col, anchor="mm", tracking=tracking)
    return x1


def pill_center(d, cx, cy, text, font, fill, **kw):
    tw = text_width(d, text, font, kw.get("tracking", 2))
    pad_x = kw.get("pad_x", 30)
    left = cx - (tw + 2 * pad_x) / 2
    return pill_left(d, left, cy, text, font, fill, **kw)


def badge_circle(d, cx, cy, r, fill, shadow=12, border=8):
    d.ellipse([cx - r + shadow, cy - r + shadow, cx + r + shadow, cy + r + shadow], fill=INK)
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=fill)
    d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=INK, width=border)


def draw_check(d, cx, cy, s, col=INK, width=18):
    p1 = (cx - 0.42 * s, cy + 0.02 * s)
    p2 = (cx - 0.10 * s, cy + 0.34 * s)
    p3 = (cx + 0.46 * s, cy - 0.36 * s)
    d.line([p1, p2, p3], fill=col, width=width, joint="curve")


ARROW_DIRS = ("up", "right", "down", "left")


def draw_arrow(d, cx, cy, s, direction, fill, border=8, shadow=14):
    """Thick neo-brutalist arrow (colored fill, pure-black border, hard ZERO-blur
    offset shadow) pointing up/right/down/left. Drawn in logical 1920x1080 units;
    the _SSDraw wrapper supersamples it so the diagonal head edges stay crisp.
    `s` is the arrow half-length (tip sits ~s from center)."""
    # canonical arrow pointing RIGHT in a [-1,1] box, then rotate per direction
    base = [(-0.92, -0.30), (0.12, -0.30), (0.12, -0.66), (0.98, 0.0),
            (0.12, 0.66), (0.12, 0.30), (-0.92, 0.30)]
    rot = {
        "right": lambda x, y: (x, y),
        "down":  lambda x, y: (-y, x),
        "left":  lambda x, y: (-x, -y),
        "up":    lambda x, y: (y, -x),
    }[direction]
    poly = [(cx + rx * s, cy + ry * s) for rx, ry in (rot(x, y) for x, y in base)]
    if shadow:
        d.polygon([(px + shadow, py + shadow) for px, py in poly], fill=INK)
    d.polygon(poly, fill=fill, outline=INK, width=border)


def new_frame(bg):
    img = Image.new("RGB", (W * SS, H * SS), bg)
    return img, _SSDraw(ImageDraw.Draw(img))


# ---------------- option tiles ----------------

BADGE_COLORS = {"A": BLUE, "B": MINT, "C": CORAL, "D": YELLOW}


def option_tile(d, box, letter, text, highlight=None):
    """highlight: None | 'correct' (mint) | 'dim'."""
    fill = PAPER
    if highlight == "correct":
        fill = MINT
    hard_card(d, box, fill, radius=26, border=7, shadow=12)
    x0, y0, x1, y1 = box
    inset = 22
    bh = (y1 - y0) - 2 * inset
    bw = bh
    bx0, by0 = x0 + inset, y0 + inset
    hard_card(d, [bx0, by0, bx0 + bw, by0 + bh], BADGE_COLORS[letter],
              radius=16, border=6, shadow=7)
    draw_text(d, bx0 + bw / 2, by0 + bh / 2, letter, anton(int(bh * 0.60)),
              INK, anchor="mm")
    tx = bx0 + bw + 34
    # fit option text
    f = dm(52, "Bold")
    max_tw = x1 - 30 - tx
    while text_width(d, text, f) > max_tw and f.size > 30:
        f = dm(f.size - 3, "Bold")
    draw_text(d, tx, (y0 + y1) / 2, text, f, INK, anchor="lm")


# Fixed geometry for question option grid
GAP = 48
TILE_W = (W - 2 * M - GAP) // 2  # 826
TILE_H = 150
ROW1_Y = 590
ROW2_Y = ROW1_Y + TILE_H + 36
OPT_BOXES = {
    "A": [M, ROW1_Y, M + TILE_W, ROW1_Y + TILE_H],
    "B": [M + TILE_W + GAP, ROW1_Y, W - M, ROW1_Y + TILE_H],
    "C": [M, ROW2_Y, M + TILE_W, ROW2_Y + TILE_H],
    "D": [M + TILE_W + GAP, ROW2_Y, W - M, ROW2_Y + TILE_H],
}

# countdown box (top-right)
CD_W, CD_H = 230, 180
CD_X1 = W - M
CD_X0 = CD_X1 - CD_W
CD_Y0 = 70
CD_Y1 = CD_Y0 + CD_H
CD_CX = (CD_X0 + CD_X1) / 2
CD_CY = (CD_Y0 + CD_Y1) / 2

# depleting bar
BAR_X = M
BAR_Y = 958
BAR_W = W - 2 * M
BAR_H = 42
BAR_PAD = 8

TIER_PILL = {"Warm-Up": MINT, "Brain-Bender": YELLOW, "Big-Brain": CORAL}


def render_question(cfg):
    """cfg keys: idx, bg, tier, question, options(list of (L,text)),
    countdown(int seconds), cd_accent, bar_accent, outdir."""
    outdir = cfg["outdir"]
    if os.path.isdir(outdir):
        shutil.rmtree(outdir)
    os.makedirs(outdir)

    bg = cfg["bg"]
    base, d = new_frame(bg)

    # eyebrow + tier pills (top-left)
    total = cfg.get("total", 3)
    # header "QUESTION X OF Y" pill: fill/txt are overridable (default INK/PAPER
    # so other rounds are unchanged); Round 15 passes CORAL so its black hard
    # shadow is visible (was black-on-black).
    r = pill_left(d, M, 100, f"QUESTION {cfg['idx']} OF {total}", dm(34, "Bold"),
                  fill=cfg.get("header_fill", INK),
                  txt_col=cfg.get("header_txt", PAPER), tracking=3)
    tier_col = cfg.get("tier_color") or TIER_PILL.get(cfg["tier"], YELLOW)
    pill_left(d, r + 24, 100, cfg["tier"].upper(), dm(34, "Bold"),
              tier_col, txt_col=INK, tracking=3)

    # countdown box (empty; number drawn per-frame)
    hard_card(d, [CD_X0, CD_Y0, CD_X1, CD_Y1], cfg["cd_accent"],
              radius=28, border=9, shadow=14)

    # question card (q_top overridable so Round 15 can clear the countdown shadow)
    qbox = [M, cfg.get("q_top", 288), W - M, 548]
    hard_card(d, qbox, PAPER, radius=40, border=9, shadow=18)
    qf, qlines = fit_font(d, cfg["question"], qbox[2] - qbox[0] - 90,
                          qbox[3] - qbox[1] - 44, [96, 88, 80, 72, 64, 58])
    draw_multiline_center(d, W / 2, (qbox[1] + qbox[3]) / 2, qlines, qf, INK)

    # options
    for letter, text in cfg["options"]:
        option_tile(d, OPT_BOXES[letter], letter, text)

    # bar track (solid black; accent fill drawn per-frame)
    d.rounded_rectangle([BAR_X, BAR_Y, BAR_X + BAR_W, BAR_Y + BAR_H],
                        radius=BAR_H // 2, fill=INK)

    return _countdown_sequence(base, outdir, cfg["countdown"], cfg["bar_accent"])


def _countdown_sequence(base, outdir, start, bar_accent):
    """Write the countdown frame sequence onto copies of `base`: the depleting
    accent bar plus the ticking number (with a per-second 'press' pop). Shared by
    render_question and render_arrow_question so both timers behave identically.
    Returns the segment duration in seconds (countdown + 1s hold on 0)."""
    dur = start + 1  # +1s hold on 0
    n_frames = dur * FPS
    for n in range(n_frames):
        t = n / FPS
        img = base.copy()
        dd = _SSDraw(ImageDraw.Draw(img))
        # bar fill
        frac = max(0.0, (start - t) / start)
        inner_w = int((BAR_W - 2 * BAR_PAD) * frac)
        if inner_w > 2:
            dd.rounded_rectangle(
                [BAR_X + BAR_PAD, BAR_Y + BAR_PAD,
                 BAR_X + BAR_PAD + inner_w, BAR_Y + BAR_H - BAR_PAD],
                radius=(BAR_H - 2 * BAR_PAD) // 2, fill=bar_accent)
        # number (with tick "press" pop)
        num = max(0, math.ceil(start - t))
        fs = 132
        if (t - math.floor(t)) < 0.12:
            fs = int(132 * 1.16)
        draw_text(dd, CD_CX, CD_CY, str(num), anton(fs), INK, anchor="mm")
        _finalize(img).save(os.path.join(outdir, f"{n:05d}.png"))
    return dur


def _arrow_cell(d, box, direction=None, question=False, color=BLUE):
    """One card in the nonverbal sequence strip: either a colored arrow icon or a
    big '?' for the missing final step."""
    hard_card(d, box, PAPER, radius=22, border=7, shadow=11)
    cx = (box[0] + box[2]) / 2
    cy = (box[1] + box[3]) / 2
    if question:
        draw_text(d, cx, cy, "?", anton(int((box[3] - box[1]) * 0.60)), INK, anchor="mm")
    else:
        s = min(box[2] - box[0], box[3] - box[1]) * 0.30
        draw_arrow(d, cx, cy, s, direction, color)


def arrow_option_tile(d, box, letter, direction, highlight=None):
    """An A-D option tile whose answer is a drawn arrow direction (not text)."""
    fill = MINT if highlight == "correct" else PAPER
    hard_card(d, box, fill, radius=26, border=7, shadow=12)
    x0, y0, x1, y1 = box
    bsz = 78
    bx0, by0 = x0 + 22, y0 + 22
    hard_card(d, [bx0, by0, bx0 + bsz, by0 + bsz], BADGE_COLORS[letter],
              radius=16, border=6, shadow=7)
    draw_text(d, bx0 + bsz / 2, by0 + bsz / 2, letter, anton(int(bsz * 0.58)),
              INK, anchor="mm")
    acx = (x0 + x1) / 2
    acy = (y0 + y1) / 2 + 26
    s = min(x1 - x0, y1 - y0) * 0.28
    draw_arrow(d, acx, acy, s, direction, BADGE_COLORS[letter])


def render_arrow_question(cfg):
    """Nonverbal / spatial item (CogAT figure-series style): a rotating-arrow
    sequence (up -> right -> down -> ?) plus four arrow-DIRECTION options drawn as
    icons. Reuses the exact brand chrome + countdown machinery as render_question.

    cfg keys: idx, total, bg, tier, tier_color, prompt, seq(list of directions),
    options(list of (letter, direction)), countdown, cd_accent, bar_accent, outdir.
    """
    outdir = cfg["outdir"]
    if os.path.isdir(outdir):
        shutil.rmtree(outdir)
    os.makedirs(outdir)

    base, d = new_frame(cfg["bg"])

    total = cfg.get("total", 5)
    r = pill_left(d, M, 100, f"QUESTION {cfg['idx']} OF {total}", dm(34, "Bold"),
                  fill=INK, txt_col=PAPER, tracking=3)
    tier_col = cfg.get("tier_color") or TIER_PILL.get(cfg["tier"], CORAL)
    pill_left(d, r + 24, 100, cfg["tier"].upper(), dm(34, "Bold"),
              tier_col, txt_col=INK, tracking=3)

    hard_card(d, [CD_X0, CD_Y0, CD_X1, CD_Y1], cfg["cd_accent"],
              radius=28, border=9, shadow=14)

    # prompt card
    pbox = [M, 250, W - M, 396]
    hard_card(d, pbox, PAPER, radius=36, border=9, shadow=16)
    pf, plines = fit_font(d, cfg["prompt"], pbox[2] - pbox[0] - 90,
                          pbox[3] - pbox[1] - 28, [64, 58, 52, 46])
    draw_multiline_center(d, W / 2, (pbox[1] + pbox[3]) / 2, plines, pf, INK)

    # sequence strip: known steps + a "?" cell
    seq = cfg["seq"]
    n = len(seq) + 1
    cw, chh, gap = 190, 190, 70
    sx = (W - (n * cw + (n - 1) * gap)) / 2
    sy = 430
    seq_colors = [BLUE, CORAL, YELLOW, MINT]
    for i, dirn in enumerate(seq):
        bx = sx + i * (cw + gap)
        _arrow_cell(d, [bx, sy, bx + cw, sy + chh], direction=dirn,
                    color=seq_colors[i % len(seq_colors)])
    bx = sx + len(seq) * (cw + gap)
    _arrow_cell(d, [bx, sy, bx + cw, sy + chh], question=True)

    # option row (four drawn-arrow tiles)
    ow, oh, ogap = 395, 240, 40
    oy = 662
    for j, (letter, dirn) in enumerate(cfg["options"]):
        bx = M + j * (ow + ogap)
        arrow_option_tile(d, [bx, oy, bx + ow, oy + oh], letter, dirn)

    # bar track
    d.rounded_rectangle([BAR_X, BAR_Y, BAR_X + BAR_W, BAR_Y + BAR_H],
                        radius=BAR_H // 2, fill=INK)

    return _countdown_sequence(base, outdir, cfg["countdown"], cfg["bar_accent"])


def render_title(path):
    img, d = new_frame(YELLOW)
    pill_center(d, W / 2, 150, "BRAIN TEASER QUIZ", dm(38, "Bold"),
                txt_col=PAPER, tracking=4, fill=INK, pad_x=36, pad_y=18)
    # hook card
    box = [190, 300, W - 190, 792]
    hard_card(d, box, PAPER, radius=44, border=10, shadow=24)
    qf, qlines = fit_font(d, "SMART FELLA OR FART SMELLA?",
                          box[2] - box[0] - 120, box[3] - box[1] - 120,
                          [180, 165, 150, 135, 120])
    draw_multiline_center(d, W / 2, (box[1] + box[3]) / 2, qlines, qf, INK, leading=0.98)
    draw_text(d, W / 2, 880, "3 QUESTIONS. BEAT THE CLOCK. HOW MANY CAN YOU GET?",
              dm(40, "Bold"), INK, anchor="mm", tracking=1)
    _finalize(img).save(path)


def answer_option_card(d, box, letter, answer, fill=PAPER):
    """The correct answer shown as an OPTION-STYLE card (matches option_tile): a
    colored letter badge + the answer text, bordered with a hard offset shadow.
    Used by the reveal so the answer reads like the question's option cards."""
    hard_card(d, box, fill, radius=30, border=9, shadow=16)
    x0, y0, x1, y1 = box
    inset = 30
    bh = (y1 - y0) - 2 * inset
    bw = bh
    bx0, by0 = x0 + inset, y0 + inset
    hard_card(d, [bx0, by0, bx0 + bw, by0 + bh], BADGE_COLORS[letter],
              radius=18, border=7, shadow=9)
    draw_text(d, bx0 + bw / 2, by0 + bh / 2, letter, anton(int(bh * 0.60)),
              INK, anchor="mm")
    tx = bx0 + bw + 50
    af, alines = fit_font(d, answer, (x1 - 40) - tx, (y1 - y0) - 40,
                          [104, 92, 80, 68, 58])
    draw_multiline_center(d, (tx + (x1 - 40)) / 2, (y0 + y1) / 2, alines, af, INK)


def render_reveal(path, bg, letter, answer, explanation, option_style=False):
    img, d = new_frame(bg)
    pill_center(d, W / 2, 150, "CORRECT ANSWER", dm(38, "Bold"),
                txt_col=PAPER, tracking=4, fill=INK, pad_x=36, pad_y=18)
    if option_style:
        # NO green check. Answer as an option-style card; explanation sized up to
        # use the freed vertical space so the layout looks intentional.
        answer_option_card(d, [300, 262, W - 300, 470], letter, answer)
        ebox = [M, 512, W - M, 902]
        ef = dm(46, "Medium")
    else:
        box = [M, 250, W - M, 636]
        hard_card(d, box, PAPER, radius=44, border=10, shadow=22)
        badge_circle(d, W / 2, 358, 78, MINT)
        draw_check(d, W / 2, 358, 96, INK, width=20)
        af, alines = fit_font(d, f"{letter})  {answer}", box[2] - box[0] - 120, 170,
                              [128, 116, 104, 92])
        draw_multiline_center(d, W / 2, 512, alines, af, INK)
        ebox = [M, 686, W - M, 902]
        ef = dm(40, "Medium")
    hard_card(d, ebox, CREAM, radius=36, border=8, shadow=16)
    elines = wrap(d, explanation, ef, ebox[2] - ebox[0] - 120)
    draw_multiline_center(d, W / 2, (ebox[1] + ebox[3]) / 2, elines, ef, INK, leading=1.3)
    _finalize(img).save(path)


def render_arrow_reveal(path, bg, letter, direction, label, explanation):
    """Reveal plate for the nonverbal item: a big drawn answer-arrow + the A-D
    label + mint check, over the same card system as render_reveal."""
    img, d = new_frame(bg)
    pill_center(d, W / 2, 150, "CORRECT ANSWER", dm(38, "Bold"),
                txt_col=PAPER, tracking=4, fill=INK, pad_x=36, pad_y=18)
    box = [M, 250, W - M, 636]
    hard_card(d, box, PAPER, radius=44, border=10, shadow=22)
    cy = (box[1] + box[3]) / 2
    ax = M + 250
    draw_arrow(d, ax, cy, 150, direction, BADGE_COLORS[letter])
    badge_circle(d, box[2] - 150, box[1] + 110, 58, MINT)
    draw_check(d, box[2] - 150, box[1] + 110, 72, INK, width=18)
    lab_left = ax + 210
    lf, llines = fit_font(d, f"{letter})  {label}", (W - M) - lab_left - 40, 200,
                          [120, 104, 92, 80])
    draw_multiline_center(d, (lab_left + (W - M)) / 2, cy, llines, lf, INK)
    ebox = [M, 686, W - M, 902]
    hard_card(d, ebox, CREAM, radius=36, border=8, shadow=16)
    ef = dm(40, "Medium")
    elines = wrap(d, explanation, ef, ebox[2] - ebox[0] - 120)
    draw_multiline_center(d, W / 2, (ebox[1] + ebox[3]) / 2, elines, ef, INK, leading=1.28)
    _finalize(img).save(path)


def render_score(path, tiers=None, heading="SCORE YOURSELF"):
    img, d = new_frame(BLUE)
    pill_center(d, W / 2, 138, "HOW DID YOU DO?", dm(38, "Bold"),
                txt_col=PAPER, tracking=4, fill=INK, pad_x=36, pad_y=18)
    draw_text(d, W / 2, 258, heading, anton(96), INK, anchor="mm")
    if tiers is None:
        tiers = [
            ("3 / 3", "CERTIFIED SMART FELLA", MINT),
            ("2 / 3", "SHARP COOKIE", YELLOW),
            ("1 / 3", "ROOKIE RIDDLER", CORAL),
        ]
    y = 372
    for score, name, col in tiers:
        box = [330, y, W - 330, y + 150]
        hard_card(d, box, col, radius=36, border=9, shadow=16)
        # score chip
        chip = [box[0] + 24, y + 22, box[0] + 24 + 200, y + 150 - 22]
        hard_card(d, chip, PAPER, radius=20, border=6, shadow=8)
        draw_text(d, (chip[0] + chip[2]) / 2, (chip[1] + chip[3]) / 2, score,
                  anton(70), INK, anchor="mm")
        draw_text(d, chip[2] + 40, y + 75, name, anton(64), INK, anchor="lm")
        y += 186
    _finalize(img).save(path)


def render_outro(path):
    img, d = new_frame(INK)
    pill_center(d, W / 2, 120, "RESULTS TIME", dm(38, "Bold"),
                txt_col=INK, tracking=4, fill=YELLOW, pad_x=36, pad_y=18)
    draw_text(d, W / 2, 248, "WANT YOUR RESULTS?", anton(118), PAPER, anchor="mm")
    # CTA card
    box = [330, 366, W - 330, 792]
    hard_card(d, box, PAPER, radius=44, border=10, shadow=24)
    cf, clines = fit_font(d, "ASK A PARENT TO ENTER THEIR EMAIL",
                          box[2] - box[0] - 110, 190, [76, 68, 60, 54])
    draw_multiline_center(d, W / 2, 480, clines, cf, INK, leading=1.02)
    # faux email field + button (a PARENT action; no child data)
    fld = [box[0] + 70, 610, box[0] + 70 + 720, 712]
    hard_card(d, fld, CREAM, radius=(712 - 610) // 2, border=6, shadow=8)
    draw_text(d, fld[0] + 40, (fld[1] + fld[3]) / 2, "parent@email.com",
              dm(42, "Medium"), (90, 90, 90), anchor="lm")
    btn = [fld[2] + 40, 610, box[2] - 70, 712]
    hard_card(d, btn, CORAL, radius=(712 - 610) // 2, border=6, shadow=8)
    draw_text(d, (btn[0] + btn[2]) / 2, (btn[1] + btn[3]) / 2, "GET RESULTS",
              dm(40, "Bold"), INK, anchor="mm", tracking=1)
    draw_text(d, W / 2, 858,
              "$500 & $2,000 PRIZES FOR PARENTS  -  SEE OFFICIAL RULES",
              dm(34, "Bold"), YELLOW, anchor="mm", tracking=2)
    _finalize(img).save(path)


def main():
    os.makedirs(OUT, exist_ok=True)
    manifest = []  # (name, kind, path_or_dir, duration_seconds)

    render_title(f"{OUT}/01_title.png")
    manifest.append(("01_title", "static", f"{OUT}/01_title.png", 6))

    d1 = render_question({
        "idx": 1, "bg": BLUE, "tier": "Warm-Up",
        "question": "WHICH ANIMAL CANNOT JUMP?",
        "options": [("A", "KANGAROO"), ("B", "FROG"), ("C", "ELEPHANT"), ("D", "RABBIT")],
        "countdown": 6, "cd_accent": YELLOW, "bar_accent": YELLOW,
        "outdir": f"{OUT}/02_q1",
    })
    manifest.append(("02_q1", "seq", f"{OUT}/02_q1", d1))

    render_reveal(f"{OUT}/03_r1.png", MINT, "C", "ELEPHANT",
                  "Adult elephants are too heavy to get all four feet off the ground at once.")
    manifest.append(("03_r1", "static", f"{OUT}/03_r1.png", 5))

    d2 = render_question({
        "idx": 2, "bg": CORAL, "tier": "Brain-Bender",
        "question": "WHICH PLANET IS THE HOTTEST?",
        "options": [("A", "MERCURY"), ("B", "VENUS"), ("C", "MARS"), ("D", "JUPITER")],
        "countdown": 7, "cd_accent": YELLOW, "bar_accent": YELLOW,
        "outdir": f"{OUT}/04_q2",
    })
    manifest.append(("04_q2", "seq", f"{OUT}/04_q2", d2))

    render_reveal(f"{OUT}/05_r2.png", MINT, "B", "VENUS",
                  "Venus's thick clouds trap heat like a blanket, making it hotter than Mercury.")
    manifest.append(("05_r2", "static", f"{OUT}/05_r2.png", 5))

    d3 = render_question({
        "idx": 3, "bg": YELLOW, "tier": "Big-Brain",
        "question": "WHAT COMES NEXT?\n1   1   2   3   5   8   ?",
        "options": [("A", "11"), ("B", "12"), ("C", "13"), ("D", "21")],
        "countdown": 9, "cd_accent": CORAL, "bar_accent": CORAL,
        "outdir": f"{OUT}/06_q3",
    })
    manifest.append(("06_q3", "seq", f"{OUT}/06_q3", d3))

    render_reveal(f"{OUT}/07_r3.png", MINT, "C", "13",
                  "Add the two numbers before it: 5 + 8 = 13. It's the Fibonacci pattern.")
    manifest.append(("07_r3", "static", f"{OUT}/07_r3.png", 6))

    render_score(f"{OUT}/08_score.png")
    manifest.append(("08_score", "static", f"{OUT}/08_score.png", 5))

    render_outro(f"{OUT}/09_outro.png")
    manifest.append(("09_outro", "static", f"{OUT}/09_outro.png", 8))

    # write manifest for the ffmpeg orchestrator
    with open(f"{OUT}/manifest.txt", "w") as f:
        for name, kind, path, dur in manifest:
            f.write(f"{name}\t{kind}\t{path}\t{dur}\n")

    total = sum(d for *_, d in manifest)
    print("Segments rendered:")
    for name, kind, path, dur in manifest:
        print(f"  {name:10s} {kind:6s} {dur:>3}s  {path}")
    print(f"TOTAL target duration: {total}s")


if __name__ == "__main__":
    main()
