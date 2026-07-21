"""v3 Instagram Reels SAFE-AREA proposal — equal L/R (centered), bottom lowered
to just above the username + profile-pic row.

Insets (px @ 1080x1920 master):
    TOP = 220, BOTTOM = 480, LEFT = 130, RIGHT = 130
Box is horizontally centered (LEFT == RIGHT). BOTTOM lands just above the
"smartfellafartsmellatest" username + profile pic (small padding above them).
"""
import os
from PIL import Image, ImageDraw, ImageFont

# Proposal PNGs render IN-PROJECT under renders.nosync (iCloud-skipped), never the Desktop.
_OUT_DIR = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "renders.nosync", "working", "ig-safe-area"))
os.makedirs(_OUT_DIR, exist_ok=True)

SRC = "/Users/khoilam/.cursor/projects/Users-khoilam-Documents-Crossover-coding-projects/assets/image-746816f0-3767-4362-a441-174f36b84b6c.png"
OUT = os.path.join(_OUT_DIR, "ig-safe-area-proposal-v5.png")

MW, MH = 1080, 1920
TOP, BOTTOM, LEFT, RIGHT = 220, 350, 120, 120
box_x, box_y = LEFT, TOP
box_w, box_h = MW - LEFT - RIGHT, MH - TOP - BOTTOM

def pct(v, dim): return f"{round(v/dim*100)}%"

base = Image.open(SRC).convert("RGB")
W, H = base.size
s = H / MH
crop_screen = (MW * s - W) / 2.0
def sx(mx): return mx * s - crop_screen
def sy(my): return my * s

bx0, by0 = sx(box_x), sy(box_y)
bx1, by1 = sx(box_x + box_w), sy(box_y + box_h)

SS = 2
sw, sh = W * SS, H * SS
head, foot = 190, 306
CW, CH = sw, head + sh + foot
canvas = Image.new("RGB", (CW, CH), (14, 16, 20))
shot = base.resize((sw, sh), Image.LANCZOS)

ov = Image.new("RGBA", (sw, sh), (0, 0, 0, 0))
d = ImageDraw.Draw(ov)
RED = (255, 45, 45, 96)
def S(v): return v * SS
X0, Y0, X1, Y1 = S(bx0), S(by0), S(bx1), S(by1)
d.rectangle([0, 0, sw, Y0], fill=RED)
d.rectangle([0, Y1, sw, sh], fill=RED)
d.rectangle([0, Y0, X0, Y1], fill=RED)
d.rectangle([X1, Y0, sw, Y1], fill=RED)
shot = Image.alpha_composite(shot.convert("RGBA"), ov).convert("RGB")

d2 = ImageDraw.Draw(shot)
for i in range(SS * 4):
    d2.rectangle([X0 + i, Y0 + i, X1 - i, Y1 - i], outline=(0, 230, 90))
canvas.paste(shot, (0, head))

def load(size, bold=True):
    for p in ([
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
    ] if bold else [
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
    ]):
        try:
            return ImageFont.truetype(p, size)
        except Exception:
            continue
    return ImageFont.load_default()

f_title = load(38); f_leg = load(26); f_lab = load(30); f_small = load(23, False)
dc = ImageDraw.Draw(canvas)

def text_size(dr, s_, fnt):
    b = dr.textbbox((0, 0), s_, font=fnt); return b[2] - b[0], b[3] - b[1]

def pill(dr, cx, cy, s_, fnt, fg=(255, 255, 255), bg=(0, 0, 0), pad=12, anchor="mm"):
    tw, th = text_size(dr, s_, fnt)
    if anchor == "mm": x, y = cx - tw / 2, cy - th / 2
    elif anchor == "lm": x, y = cx, cy - th / 2
    elif anchor == "rm": x, y = cx - tw, cy - th / 2
    r = [x - pad, y - pad, x + tw + pad, y + th + pad]
    dr.rounded_rectangle(r, radius=pad, fill=bg)
    dr.text((x, y), s_, font=fnt, fill=fg)
    return r

dc.text((24, 26), "Instagram Reels — SAFE-AREA proposal v5", font=f_title, fill=(255, 255, 255))
dc.text((24, 78), "9:16 · 1080x1920 · equal L/R (centered) · bottom just above the username",
        font=f_small, fill=(170, 178, 190))
ly = 130
dc.rectangle([24, ly, 60, ly + 30], fill=(200, 40, 40)); dc.text((70, ly + 2), "UNSAFE — IG UI / cover-crop", font=f_leg, fill=(230, 230, 230))
dc.rectangle([430, ly, 466, ly + 30], outline=(0, 230, 90), width=5); dc.text((476, ly + 2), "SAFE content zone", font=f_leg, fill=(230, 230, 230))

def L(x, y): return (x, y + head)
pill(dc, *L(sw/2, S(by0)/2 + 30), f"TOP  {TOP}px ({pct(TOP,MH)})", f_lab, bg=(150, 20, 20))
pill(dc, *L(sw/2, S(by1) + 40), f"BOTTOM  {BOTTOM}px ({pct(BOTTOM,MH)})  ·  just above username + profile pic",
     f_lab, bg=(150, 20, 20))
gap_y = 690 * SS
dc.line([L(X0, gap_y), L(X0 + 70, gap_y)], fill=(255, 220, 80), width=5)
pill(dc, *L(X0 + 80, gap_y), f"LEFT {LEFT}px ({pct(LEFT,MW)})", f_lab, bg=(150, 20, 20), anchor="lm")
dc.line([L(X1, gap_y), L(X1 - 70, gap_y)], fill=(255, 220, 80), width=5)
pill(dc, *L(X1 - 80, gap_y), f"RIGHT {RIGHT}px ({pct(RIGHT,MW)})", f_lab, bg=(150, 20, 20), anchor="rm")

fy = head + sh + 16
dc.text((24, fy), "Recommended insets @ 1080x1920 master (v5):", font=f_leg, fill=(255, 255, 255))
dc.text((24, fy + 40),
        f"TOP {TOP}px ({pct(TOP,MH)})      .      BOTTOM {BOTTOM}px ({pct(BOTTOM,MH)})",
        font=f_lab, fill=(0, 230, 120))
dc.text((24, fy + 78),
        f"LEFT {LEFT}px ({pct(LEFT,MW)})      .      RIGHT {RIGHT}px ({pct(RIGHT,MW)})  (equal / centered)",
        font=f_lab, fill=(0, 230, 120))
dc.text((24, fy + 124),
        f"Safe content box:  x={box_x}, y={box_y},  w={box_w} x h={box_h} px  (centered on 540)",
        font=f_leg, fill=(215, 219, 228))
dc.text((24, fy + 168),
        "Bottom sits just above the username/profile-pic row; RIGHT=130 lets the action",
        font=f_small, fill=(150, 158, 172))
dc.text((24, fy + 196),
        "buttons overlap only the EMPTY right of the left-aligned cards (no text touched).",
        font=f_small, fill=(150, 158, 172))

canvas.save(OUT)
print("saved:", OUT, canvas.size)
print("\n=== v3 SAFE-AREA INSETS (px @ 1080x1920) ===")
print(f"TOP    = {TOP}  ({TOP/MH*100:.1f}%)")
print(f"BOTTOM = {BOTTOM}  ({BOTTOM/MH*100:.1f}%)")
print(f"LEFT   = {LEFT}  ({LEFT/MW*100:.1f}%)")
print(f"RIGHT  = {RIGHT}  ({RIGHT/MW*100:.1f}%)")
print(f"BOX: x={box_x}, y={box_y}, w={box_w}, h={box_h}  (bottom edge at master y={box_y+box_h}, screen y={sy(box_y+box_h):.0f})")
