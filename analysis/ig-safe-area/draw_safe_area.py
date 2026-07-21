"""Draw an Instagram Reels SAFE-AREA proposal on a copy of the screenshot.

Model (verified): IG COVER-scales the 9:16 reel to fill the tall phone screen by
height (scale s = screenH/1920), so the video is horizontally cropped ~97px/side
on the 1080 master. Vertical is 1:1 (no crop) -> TOP/BOTTOM insets are pure IG
overlay clearance; LEFT/RIGHT insets include the cover crop.

Insets chosen (px @ 1080x1920 master), clearing all measured chrome + breathing:
    TOP = 220, BOTTOM = 540, LEFT = 120, RIGHT = 220
"""
import os
from PIL import Image, ImageDraw, ImageFont

# Proposal PNGs render IN-PROJECT under renders.nosync (iCloud-skipped), never the Desktop.
_OUT_DIR = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "renders.nosync", "working", "ig-safe-area"))
os.makedirs(_OUT_DIR, exist_ok=True)

SRC = "/Users/khoilam/.cursor/projects/Users-khoilam-Documents-Crossover-coding-projects/assets/image-746816f0-3767-4362-a441-174f36b84b6c.png"
OUT = os.path.join(_OUT_DIR, "ig-safe-area-proposal.png")

# ---- master + insets ------------------------------------------------------
MW, MH = 1080, 1920
TOP, BOTTOM, LEFT, RIGHT = 220, 540, 120, 220
box_x, box_y = LEFT, TOP
box_w, box_h = MW - LEFT - RIGHT, MH - TOP - BOTTOM

def pct(v, dim): return f"{round(v/dim*100)}%"

# ---- screenshot + cover mapping (master -> screen) ------------------------
base = Image.open(SRC).convert("RGB")
W, H = base.size
s = H / MH                          # cover scale (by height)
crop_screen = (MW * s - W) / 2.0    # px cropped each side, in screen space
def sx(mx): return mx * s - crop_screen     # master x -> screen x
def sy(my): return my * s                    # master y -> screen y (no crop)

# safe box in screen space
bx0, by0 = sx(box_x), sy(box_y)
bx1, by1 = sx(box_x + box_w), sy(box_y + box_h)

# ---- build a padded canvas (header + screenshot + footer), 2x for clarity -
SS = 2
sw, sh = W * SS, H * SS
head, foot = 190, 306
CW, CH = sw, head + sh + foot
canvas = Image.new("RGB", (CW, CH), (14, 16, 20))

shot = base.resize((sw, sh), Image.LANCZOS)

# transparent overlay for red shading + green box, drawn in shot space
ov = Image.new("RGBA", (sw, sh), (0, 0, 0, 0))
d = ImageDraw.Draw(ov)
RED = (255, 45, 45, 96)
def S(v): return v * SS
X0, Y0, X1, Y1 = S(bx0), S(by0), S(bx1), S(by1)
# red UNSAFE margins
d.rectangle([0, 0, sw, Y0], fill=RED)               # top band
d.rectangle([0, Y1, sw, sh], fill=RED)              # bottom band
d.rectangle([0, Y0, X0, Y1], fill=RED)              # left band
d.rectangle([X1, Y0, sw, Y1], fill=RED)             # right band
shot = Image.alpha_composite(shot.convert("RGBA"), ov).convert("RGB")

# green safe rectangle (bold)
d2 = ImageDraw.Draw(shot)
for i in range(SS * 4):                              # bold outline
    d2.rectangle([X0 + i, Y0 + i, X1 - i, Y1 - i], outline=(0, 230, 90))

canvas.paste(shot, (0, head))

# ---- fonts ----------------------------------------------------------------
def load(size, bold=True):
    for p in ([
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
        "/Library/Fonts/Arial Bold.ttf",
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

def pill(dr, cx, cy, s_, fnt, fg=(255, 255, 255), bg=(0, 0, 0), pad=12, anchor="mm", border=None):
    tw, th = text_size(dr, s_, fnt)
    if anchor == "mm": x, y = cx - tw / 2, cy - th / 2
    elif anchor == "lm": x, y = cx, cy - th / 2
    elif anchor == "rm": x, y = cx - tw, cy - th / 2
    r = [x - pad, y - pad, x + tw + pad, y + th + pad]
    dr.rounded_rectangle(r, radius=pad, fill=bg, outline=border, width=3 if border else 0)
    dr.text((x, y), s_, font=fnt, fill=fg)
    return r

# ---- header ---------------------------------------------------------------
dc.text((24, 26), "Instagram Reels — SAFE-AREA proposal", font=f_title, fill=(255, 255, 255))
dc.text((24, 78), "9:16 vertical · 1080×1920 master · keep all content inside the GREEN box",
        font=f_small, fill=(170, 178, 190))
# legend swatches
ly = 130
dc.rectangle([24, ly, 60, ly + 30], fill=(200, 40, 40)); dc.text((70, ly + 2), "UNSAFE — IG UI / cover-crop", font=f_leg, fill=(230, 230, 230))
dc.rectangle([430, ly, 466, ly + 30], outline=(0, 230, 90), width=5); dc.text((476, ly + 2), "SAFE content zone", font=f_leg, fill=(230, 230, 230))

# ---- on-image labels (offset into header space by +head on y) -------------
def L(x, y): return (x, y + head)   # shot-space (2x) -> canvas
# TOP
pill(dc, *L(sw/2, S(by0)/2 + 30), f"TOP  {TOP}px ({pct(TOP,MH)})", f_lab, bg=(150, 20, 20))
# BOTTOM (place just inside the bottom red band, above the caption stack)
pill(dc, *L(sw/2, S(by1) + 46), f"BOTTOM  {BOTTOM}px ({pct(BOTTOM,MH)})  ·  username · caption · audio · comment",
     f_lab, bg=(150, 20, 20))
# LEFT & RIGHT labels sit in the clear green strip below option D (empty green)
gap_y = 700 * SS                                   # shot-space y in the clear strip
# LEFT: leader from the (thin) left band into the safe zone
dc.line([L(X0, gap_y), L(X0 + 70, gap_y)], fill=(255, 220, 80), width=5)
pill(dc, *L(X0 + 80, gap_y), f"LEFT {LEFT}px ({pct(LEFT,MW)})", f_lab, bg=(150, 20, 20), anchor="lm")
# RIGHT: leader from the right band into the safe zone
dc.line([L(X1, gap_y), L(X1 - 70, gap_y)], fill=(255, 220, 80), width=5)
pill(dc, *L(X1 - 80, gap_y), f"RIGHT {RIGHT}px ({pct(RIGHT,MW)})", f_lab, bg=(150, 20, 20), anchor="rm")

# ---- footer ---------------------------------------------------------------
fy = head + sh + 16
dc.text((24, fy), "Recommended insets @ 1080×1920 master:", font=f_leg, fill=(255, 255, 255))
dc.text((24, fy + 40),
        f"TOP {TOP}px ({pct(TOP,MH)})      ·      BOTTOM {BOTTOM}px ({pct(BOTTOM,MH)})",
        font=f_lab, fill=(0, 230, 120))
dc.text((24, fy + 78),
        f"LEFT {LEFT}px ({pct(LEFT,MW)})      ·      RIGHT {RIGHT}px ({pct(RIGHT,MW)})",
        font=f_lab, fill=(0, 230, 120))
dc.text((24, fy + 124),
        f"Safe content box:  x={box_x}, y={box_y},  w={box_w} × h={box_h} px",
        font=f_leg, fill=(215, 219, 228))
dc.text((24, fy + 168),
        "Tall 19.5:9 phones cover-crop ~97px off each side of a 9:16 reel, so LEFT/RIGHT",
        font=f_small, fill=(150, 158, 172))
dc.text((24, fy + 196),
        "include that crop; RIGHT also clears the action column; TOP/BOTTOM clear IG's UI.",
        font=f_small, fill=(150, 158, 172))

canvas.save(OUT)
print("saved:", OUT, canvas.size)

# ---- print final numbers (plain) -----------------------------------------
print("\n=== FINAL RECOMMENDED SAFE-AREA INSETS (px @ 1080x1920) ===")
print(f"TOP    = {TOP}px  ({TOP/MH*100:.1f}%)")
print(f"BOTTOM = {BOTTOM}px  ({BOTTOM/MH*100:.1f}%)")
print(f"LEFT   = {LEFT}px  ({LEFT/MW*100:.1f}%)")
print(f"RIGHT  = {RIGHT}px  ({RIGHT/MW*100:.1f}%)")
print(f"SAFE CONTENT BOX: x={box_x}, y={box_y}, w={box_w}, h={box_h}")
