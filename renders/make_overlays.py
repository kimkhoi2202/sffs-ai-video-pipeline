#!/usr/bin/env python3
"""Render all on-brand text/card overlays as transparent 1920x1080 PNGs.
Neo-brutalist "Closer" system: Anton UPPERCASE + DM Sans, flat brand colors,
thick pure-black borders, hard offset shadows (ZERO blur)."""
from PIL import Image, ImageDraw, ImageFont

W, H = 1920, 1080
OUT = "/tmp/quiz_build"

# --- brand palette (sRGB, DESIGN.md §2) ---
INK    = (0, 0, 0, 255)
PAPER  = (255, 255, 255, 255)
BLUE   = (131, 154, 255, 255)
MINT   = (198, 252, 208, 255)
CORAL  = (253, 121, 98, 255)
YELLOW = (252, 229, 82, 255)
CREAM  = (246, 244, 238, 255)
SHADOW = (0, 0, 0, 255)

ANTON = "/tmp/Anton-Regular.ttf"
DMSANS = "/tmp/DMSans.ttf"

_fc = {}
def anton(sz):
    k = ("a", sz)
    if k not in _fc:
        _fc[k] = ImageFont.truetype(ANTON, sz)
    return _fc[k]

def dmsans(sz, bold=False):
    k = ("d", sz, bold)
    if k not in _fc:
        f = ImageFont.truetype(DMSANS, sz)
        if bold:
            for nm in ("Bold", "ExtraBold", "SemiBold"):
                try:
                    f.set_variation_by_name(nm)
                    break
                except Exception:
                    pass
        _fc[k] = f
    return _fc[k]

def lh(font, factor=1.0):
    a, d = font.getmetrics()
    return int((a + d) * factor)

def hs_rect(d, box, fill, radius=28, border=6, shadow=12, sh=SHADOW):
    """Rounded rect with hard offset shadow (zero blur) + pure-black border."""
    x0, y0, x1, y1 = box
    if shadow:
        d.rounded_rectangle([x0 + shadow, y0 + shadow, x1 + shadow, y1 + shadow],
                            radius=radius, fill=sh)
    d.rounded_rectangle([x0, y0, x1, y1], radius=radius, fill=fill,
                        outline=INK, width=border)

def pill(d, cx, cy, text, font, fill, txt, pad_x=40, h=64, border=5, shadow=8, track=0.06):
    """Centered pill with tracked uppercase label."""
    widths = [d.textlength(ch, font=font) for ch in text]
    extra = font.size * track
    tw = sum(widths) + extra * (len(text) - 1)
    w = tw + pad_x * 2
    x0, y0 = cx - w / 2, cy - h / 2
    hs_rect(d, [x0, y0, x0 + w, y0 + h], fill, radius=h / 2, border=border, shadow=shadow)
    x = cx - tw / 2
    for ch, cw in zip(text, widths):
        d.text((x, cy), ch, font=font, fill=txt, anchor="lm")
        x += cw + extra

def wrap(d, text, font, max_w):
    words, lines, cur = text.split(), [], ""
    for w in words:
        t = (cur + " " + w).strip()
        if d.textlength(t, font=font) <= max_w:
            cur = t
        else:
            if cur:
                lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines

def center_lines(d, lines, font, top, fill, cx=960, factor=1.0, gap=0):
    y = top
    L = lh(font, factor)
    for ln in lines:
        d.text((cx, y), ln, font=font, fill=fill, anchor="ma")
        y += L + gap
    return y

def check_badge(d, cx, cy, r=58, fill=MINT):
    """Circle badge with an ink checkmark."""
    hs_rect(d, [cx - r, cy - r, cx + r, cy + r], fill, radius=r, border=7, shadow=10)
    s = r * 0.62
    d.line([(cx - s * 0.55, cy + s * 0.02),
            (cx - s * 0.12, cy + s * 0.5),
            (cx + s * 0.62, cy - s * 0.52)],
           fill=INK, width=max(9, int(r * 0.18)), joint="curve")

# ---------- geometry shared with ffmpeg (timer bar fill) ----------
NUMBOX = [885, 718, 1035, 868]          # yellow number-flex box
NUM_CX, NUM_CY = 960, 790
BAR = [680, 900, 1240, 952]             # white bar track (outer)
BAR_FILL_X, BAR_FILL_Y = 688, 908
BAR_FILL_W, BAR_FILL_H = 544, 36        # yellow depleting fill (inside border)

def timer_widget(d, digit):
    """Number-flex box + short depleting-bar track + the current digit."""
    hs_rect(d, NUMBOX, YELLOW, radius=26, border=7, shadow=13)
    d.text((NUM_CX, NUM_CY + 2), str(digit), font=anton(118), fill=INK, anchor="mm")
    hs_rect(d, BAR, PAPER, radius=12, border=6, shadow=10)

# ============================ INTRO (yellow) ============================
def make_intro():
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0)); d = ImageDraw.Draw(img)
    pill(d, 960, 172, "BRAIN QUIZ  ·  3 RIDDLES", dmsans(30, True), INK, PAPER, pad_x=46, h=68)
    d.text((960, 300), "SMART FELLA", font=anton(150), fill=INK, anchor="ma")
    # second line highlighted in a coral box
    f = anton(150); line2 = "OR FART SMELLA?"
    tw = d.textlength(line2, font=f); L = lh(f, 1.0)
    y2 = 300 + L + 6
    hs_rect(d, [960 - tw / 2 - 34, y2 - 6, 960 + tw / 2 + 34, y2 + L + 6], CORAL,
            radius=26, border=6, shadow=14)
    d.text((960, y2), line2, font=f, fill=INK, anchor="ma")
    sub = "3 riddles. 5 seconds each. Can you solve them all?"
    d.text((960, y2 + L + 60), sub, font=dmsans(46, True), fill=INK, anchor="ma")
    pill(d, 960, 905, "BEAT THE CLOCK!", dmsans(32, True), INK, YELLOW, pad_x=44, h=74)
    img.save(f"{OUT}/ov_intro.png")

# ============================ QUESTION ============================
def make_question(path, eyebrow, body, options=None, open_riddle=False):
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0)); d = ImageDraw.Draw(img)
    pill(d, 960, 168, eyebrow, dmsans(30, True), INK, PAPER, pad_x=46, h=66)
    if open_riddle:
        f = anton(64); lines = wrap(d, body, f, 1580)
        while len(lines) > 6 and f.size > 44:
            f = anton(f.size - 4); lines = wrap(d, body, f, 1580)
        L = lh(f, 1.0); top = 300
        y = top
        for i, ln in enumerate(lines):
            last = (i == len(lines) - 1)
            if last and ln.strip().endswith("?"):
                tw = d.textlength(ln, font=f)
                hs_rect(d, [960 - tw / 2 - 30, y - 4, 960 + tw / 2 + 30, y + L + 4],
                        YELLOW, radius=20, border=6, shadow=10)
            d.text((960, y), ln, font=f, fill=INK, anchor="ma")
            y += L
    else:
        f = anton(82); lines = wrap(d, body, f, 1480)
        y = 250
        L = lh(f, 1.0)
        for ln in lines:
            d.text((960, y), ln, font=f, fill=INK, anchor="ma"); y += L
        # option tiles row
        accents = [BLUE, MINT, YELLOW, CORAL]
        oy = y + 34
        n = len(options); gap = 28
        tw = (1580 - gap * (n - 1)) / n
        th = 116
        for i, (letter, otext) in enumerate(options):
            x0 = 170 + i * (tw + gap)
            hs_rect(d, [x0, oy, x0 + tw, oy + th], PAPER, radius=26, border=6, shadow=11)
            br = 40
            bcx, bcy = x0 + 30 + br, oy + th / 2
            hs_rect(d, [bcx - br, bcy - br, bcx + br, bcy + br], accents[i % 4],
                    radius=br, border=5, shadow=7)
            d.text((bcx, bcy + 1), letter, font=anton(46), fill=INK, anchor="mm")
            d.text((bcx + br + 24, bcy + 1), otext, font=dmsans(38, True), fill=INK, anchor="lm")
    img.save(path)

# ============================ REVEAL (mint) ============================
def make_reveal(path, answer, explanation):
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0)); d = ImageDraw.Draw(img)
    pill(d, 960, 166, "CORRECT!", dmsans(32, True), INK, CORAL, pad_x=52, h=72)
    check_badge(d, 960, 300, r=62, fill=PAPER)
    # answer with yellow highlight box
    f = anton(140); tw = d.textlength(answer, font=f); L = lh(f, 1.0)
    ay = 400
    hs_rect(d, [960 - tw / 2 - 40, ay - 6, 960 + tw / 2 + 40, ay + L + 6], YELLOW,
            radius=28, border=7, shadow=16)
    d.text((960, ay), answer, font=f, fill=INK, anchor="ma")
    # explanation card (kept clear of the plate's bottom-right check)
    ef = dmsans(40, True); elines = wrap(d, explanation, ef, 1120)
    eL = lh(ef, 1.12); eh = eL * len(elines) + 56
    card = [255, 615, 1465, 615 + eh]
    hs_rect(d, card, PAPER, radius=30, border=6, shadow=12)
    center_lines(d, elines, ef, card[1] + 28, INK, cx=(card[0] + card[2]) // 2)
    img.save(path)

# ============================ OUTRO (ink) ============================
def make_outro():
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0)); d = ImageDraw.Draw(img)
    pill(d, 960, 168, "HOW'D YOU DO?", dmsans(32, True), YELLOW, INK, pad_x=50, h=72)
    d.text((960, 250), "WANT YOUR", font=anton(96), fill=PAPER, anchor="ma")
    f = anton(120); line = "BRAIN SCORE?"; tw = d.textlength(line, font=f); L = lh(f, 1.0)
    y2 = 356
    d.text((960, y2), line, font=f, fill=YELLOW, anchor="ma")
    # parent-email CTA card (COPPA-safe: a GROWN-UP action, no child data)
    cta = [360, 520, 1560, 700]
    hs_rect(d, cta, YELLOW, radius=32, border=7, shadow=16)
    d.text((960, 556), "ASK A GROWN-UP TO ENTER THEIR", font=dmsans(46, True), fill=INK, anchor="ma")
    d.text((960, 616), "EMAIL TO UNLOCK YOUR SCORE", font=dmsans(46, True), fill=INK, anchor="ma")
    pill(d, 960, 772, "PLAY FOR $500 - $2,000 IN PRIZES", dmsans(34, True), CORAL, INK, pad_x=48, h=78)
    d.text((960, 858), "Grown-ups: see official rules  ·  no purchase necessary",
           font=dmsans(27), fill=PAPER, anchor="ma")
    img.save(f"{OUT}/ov_outro.png")

# ============================ DIGITS (timed overlays) ============================
def make_digits():
    for n in (5, 4, 3, 2, 1):
        img = Image.new("RGBA", (W, H), (0, 0, 0, 0)); d = ImageDraw.Draw(img)
        timer_widget(d, n)
        img.save(f"{OUT}/dig{n}.png")

if __name__ == "__main__":
    make_intro()
    # Q1 open riddle (blue), Q2 MC (coral), Q3 open riddle (blue)
    make_question(f"{OUT}/ov_q1.png", "RIDDLE 1 OF 3",
                  "I HAVE KEYS BUT NO LOCKS, A SPACE BAR BUT NOTHING TO DRINK, AND LETTERS BUT I SEND NO MAIL. WHAT AM I?",
                  open_riddle=True)
    make_question(f"{OUT}/ov_q2.png", "RIDDLE 2 OF 3",
                  "WHICH PLANET IS THE HOTTEST IN OUR SOLAR SYSTEM?",
                  options=[("A", "MERCURY"), ("B", "VENUS"), ("C", "MARS"), ("D", "JUPITER")])
    make_question(f"{OUT}/ov_q3.png", "RIDDLE 3 OF 3",
                  "THE MORE YOU TAKE AWAY FROM ME, THE BIGGER I GET. WHAT AM I?",
                  open_riddle=True)
    make_reveal(f"{OUT}/ov_r1.png", "A KEYBOARD",
                "Keys, a space bar, and letters - just not the everyday kind.")
    make_reveal(f"{OUT}/ov_r2.png", "VENUS",
                "Venus's thick clouds trap heat like a blanket - even hotter than Mercury.")
    make_reveal(f"{OUT}/ov_r3.png", "A HOLE",
                "The more you dig out of it, the bigger the hole gets.")
    make_outro()
    make_digits()
    # geometry for the ffmpeg drawbox depleting fill
    with open(f"{OUT}/geom.env", "w") as fh:
        fh.write(f"BAR_FILL_X={BAR_FILL_X}\nBAR_FILL_Y={BAR_FILL_Y}\n"
                 f"BAR_FILL_W={BAR_FILL_W}\nBAR_FILL_H={BAR_FILL_H}\n")
    print("overlays written to", OUT)
