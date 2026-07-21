"""Instagram Reels SAFE-AREA proposal v2 (revised per feedback).

Base = actual playback screenshot WITH action buttons (image-746816f0, 472x1024).
Model (verified): IG COVER-scales the 9:16 reel to fill screen height
(s = H/1920), cropping ~97.5px/side off the 1080 master. So the screenshot's
own left/right edges ARE the cover-crop lines (master x ~= 98 and ~= 982).

Revised insets @ 1080x1920:
    TOP = 220 (keep) · BOTTOM = 580 (just above audio disc + username)
    LEFT = 100  (widest still fully visible on this phone; 60-72 would clip)
    RIGHT = 130 (hugs card right; action buttons overlap empty card area)
"""
import os
from PIL import Image, ImageDraw, ImageFont

# Proposal PNGs render IN-PROJECT under renders.nosync (iCloud-skipped), never the Desktop.
_OUT_DIR = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "renders.nosync", "working", "ig-safe-area"))
os.makedirs(_OUT_DIR, exist_ok=True)

SRC = "/Users/khoilam/.cursor/projects/Users-khoilam-Documents-Crossover-coding-projects/assets/image-746816f0-3767-4362-a441-174f36b84b6c.png"
OUT = os.path.join(_OUT_DIR, "ig-safe-area-proposal-v2.png")

MW, MH = 1080, 1920
TOP, BOTTOM, LEFT, RIGHT = 220, 580, 100, 130
box_x, box_y = LEFT, TOP
box_w, box_h = MW - LEFT - RIGHT, MH - TOP - BOTTOM
def pct(v, dim): return f"{round(v/dim*100)}%"

base = Image.open(SRC).convert("RGB")
W, H = base.size
s = H / MH
crop_screen = (MW * s - W) / 2.0
crop_master = crop_screen / s
def sx(mx): return mx * s - crop_screen
def sy(my): return my * s
def mx(sx_): return (sx_ + crop_screen) / s

# measured chrome (screen px)
ACT_LEFT_S = 424          # heart/comment leftmost edge
CARD_R_S   = 462          # option card right edge
DISC_TOP_S = 775          # audio-attribution disc top
USER_TOP_S = 845          # username line top

# detect the action-button column vertical span (far-right strip)
import numpy as np
_a = np.asarray(base).astype(np.int16)
_R, _G, _B = _a[:, :, 0], _a[:, :, 1], _a[:, :, 2]
_bright = ((_R > 205) & (_G > 205) & (_B > 205)) | ((_R > 150) & (_G < 110) & (_B < 110))
_strip = _bright[:, int(W * 0.90):]           # right-most icons only
_rows = np.where(_strip.any(axis=1))[0]
_rows = _rows[(_rows > int(H * 0.42)) & (_rows < int(H * 0.86))]
ACT_TOP_S = int(_rows.min()) if len(_rows) else 480
ACT_BOT_S = int(_rows.max()) if len(_rows) else 840

# safe box -> screen
bx0, by0 = sx(box_x), sy(box_y)
bx1, by1 = sx(box_x + box_w), sy(box_y + box_h)

# button overlap into the safe zone (right side)
act_left_m = mx(ACT_LEFT_S)
green_r_m  = box_x + box_w
overlap_m  = green_r_m - act_left_m
overlap_s  = overlap_m * s

SS = 2
sw, sh = W * SS, H * SS
head, foot = 196, 350
canvas = Image.new("RGB", (sw, head + sh + foot), (14, 16, 20))
shot = base.resize((sw, sh), Image.LANCZOS)

def S(v): return v * SS
X0, Y0, X1, Y1 = S(bx0), S(by0), S(bx1), S(by1)

# red UNSAFE margins
ov = Image.new("RGBA", (sw, sh), (0, 0, 0, 0)); d = ImageDraw.Draw(ov)
RED = (255, 45, 45, 96)
d.rectangle([0, 0, sw, Y0], fill=RED)
d.rectangle([0, Y1, sw, sh], fill=RED)
d.rectangle([0, Y0, X0, Y1], fill=RED)
d.rectangle([X1, Y0, sw, Y1], fill=RED)
# orange overlap sliver: only where the action buttons actually sit, inside the box
XB = S(ACT_LEFT_S)
oy0 = max(Y0, S(ACT_TOP_S)); oy1 = min(Y1, S(ACT_BOT_S))
d.rectangle([XB, oy0, X1, oy1], fill=(255, 150, 0, 80))
shot = Image.alpha_composite(shot.convert("RGBA"), ov).convert("RGB")

d2 = ImageDraw.Draw(shot)
# green safe rectangle (bold)
for i in range(SS * 4):
    d2.rectangle([X0 + i, Y0 + i, X1 - i, Y1 - i], outline=(0, 230, 90))
# dashed orange line at action-button left edge (only over the button span)
yy = oy0
while yy < oy1:
    d2.line([XB, yy, XB, min(yy + 14, oy1)], fill=(255, 160, 0), width=3)
    yy += 26

canvas.paste(shot, (0, head))

def load(size, bold=True):
    paths = (["/System/Library/Fonts/Supplemental/Arial Bold.ttf",
              "/System/Library/Fonts/Helvetica.ttc"] if bold else
             ["/System/Library/Fonts/Supplemental/Arial.ttf",
              "/System/Library/Fonts/Helvetica.ttc"])
    for p in paths:
        try: return ImageFont.truetype(p, size)
        except Exception: pass
    return ImageFont.load_default()

f_title = load(38); f_leg = load(25); f_lab = load(30); f_small = load(22, False)
dc = ImageDraw.Draw(canvas)

def tsize(dr, t, f):
    b = dr.textbbox((0, 0), t, font=f); return b[2] - b[0], b[3] - b[1]
def pill(dr, cx, cy, t, f, fg=(255, 255, 255), bg=(0, 0, 0), pad=11, anchor="mm"):
    tw, th = tsize(dr, t, f)
    x = cx - tw / 2 if anchor == "mm" else (cx if anchor == "lm" else cx - tw)
    y = cy - th / 2
    dr.rounded_rectangle([x - pad, y - pad, x + tw + pad, y + th + pad], radius=pad, fill=bg)
    dr.text((x, y), t, font=f, fill=fg)

# header
dc.text((24, 24), "Instagram Reels — SAFE-AREA proposal  v2", font=f_title, fill=(255, 255, 255))
dc.text((24, 78), "9:16 · 1080×1920 master · WIDER content · bottom lifted above the username",
        font=f_small, fill=(170, 178, 190))
ly = 132
dc.rectangle([24, ly, 58, ly + 28], fill=(200, 40, 40)); dc.text((66, ly + 1), "UNSAFE (IG UI / crop)", font=f_leg, fill=(230, 230, 230))
dc.rectangle([352, ly, 386, ly + 28], outline=(0, 230, 90), width=5); dc.text((394, ly + 1), "SAFE zone", font=f_leg, fill=(230, 230, 230))
dc.rectangle([560, ly, 594, ly + 28], fill=(240, 150, 20)); dc.text((602, ly + 1), "action-button overlap", font=f_leg, fill=(230, 230, 230))

def L(x, y): return (x, y + head)
# TOP / BOTTOM labels (centered in their bands)
pill(dc, *L(sw/2, S(by0)/2 + 26), f"TOP  {TOP}px ({pct(TOP,MH)})", f_lab, bg=(150, 20, 20))
pill(dc, *L(sw/2, S(by1) + 44), f"BOTTOM  {BOTTOM}px ({pct(BOTTOM,MH)})  ·  above audio-disc + username",
     f_lab, bg=(150, 20, 20))
# LEFT / RIGHT labels in the clear green strip just below option D
gap_y = S((CARD_R_S and (int(sy(box_y+box_h)) )))  # placeholder
gap_y = S(688)   # empty green strip (screen ~665-712)
dc.line([L(X0, gap_y), L(X0 + 60, gap_y)], fill=(255, 220, 80), width=5)
pill(dc, *L(X0 + 68, gap_y), f"LEFT {LEFT}px ({pct(LEFT,MW)})", f_lab, bg=(150, 20, 20), anchor="lm")
dc.line([L(X1, gap_y), L(X1 - 60, gap_y)], fill=(255, 220, 80), width=5)
pill(dc, *L(X1 - 68, gap_y), f"RIGHT {RIGHT}px ({pct(RIGHT,MW)})", f_lab, bg=(150, 20, 20), anchor="rm")
# overlap callout near the heart
pill(dc, *L(S(ACT_LEFT_S) - 6, S(560)), f"buttons overlap ~{round(overlap_m)}px (empty card)",
     f_small, bg=(200, 110, 0), anchor="rm")

# footer
fy = head + sh + 16
dc.text((24, fy), "Revised insets @ 1080×1920 master:", font=f_leg, fill=(255, 255, 255))
dc.text((24, fy + 38), f"TOP {TOP}px ({pct(TOP,MH)})      ·      BOTTOM {BOTTOM}px ({pct(BOTTOM,MH)})",
        font=f_lab, fill=(0, 230, 120))
dc.text((24, fy + 76), f"LEFT {LEFT}px ({pct(LEFT,MW)})      ·      RIGHT {RIGHT}px ({pct(RIGHT,MW)})",
        font=f_lab, fill=(0, 230, 120))
dc.text((24, fy + 120), f"Safe content box:  x={box_x}, y={box_y},  w={box_w} × h={box_h} px",
        font=f_leg, fill=(215, 219, 228))
dc.text((24, fy + 160),
        f"Button overlap: heart/comment intrude ~{round(overlap_m)}px (@1080) into the box's right —",
        font=f_small, fill=(240, 170, 90))
dc.text((24, fy + 186),
        "over the EMPTY right of the cards only (option text is left-aligned, ~400px away). OK.",
        font=f_small, fill=(240, 170, 90))
dc.text((24, fy + 220),
        "Crop: this 19.5:9 phone cover-crops ~98px/side; the screen edges = the crop lines.",
        font=f_small, fill=(150, 158, 172))
dc.text((24, fy + 246),
        "LEFT 100px is the widest still fully visible here; 60–72px would be off-screen (clipped).",
        font=f_small, fill=(150, 158, 172))

canvas.save(OUT)
print("saved:", OUT, canvas.size)
print("\n=== V2 RECOMMENDED SAFE-AREA INSETS (px @ 1080x1920) ===")
print(f"TOP    = {TOP}px  ({TOP/MH*100:.1f}%)")
print(f"BOTTOM = {BOTTOM}px  ({BOTTOM/MH*100:.1f}%)")
print(f"LEFT   = {LEFT}px  ({LEFT/MW*100:.1f}%)")
print(f"RIGHT  = {RIGHT}px  ({RIGHT/MW*100:.1f}%)")
print(f"SAFE CONTENT BOX: x={box_x}, y={box_y}, w={box_w}, h={box_h}")
print(f"\naction-button left edge  = master {act_left_m:.0f}  (screen {ACT_LEFT_S})")
print(f"green box right edge      = master {green_r_m}")
print(f"=> button overlap into box = {overlap_m:.0f}px @1080  ({overlap_s:.0f}px on this screen)")
print(f"card right edge           = master {mx(CARD_R_S):.0f};  nearest option text ends ~master 491")
print(f"crop line (this phone)    = master {crop_master:.1f}/side; visible master X = [{crop_master:.0f}..{MW-crop_master:.0f}]")
print(f"LEFT target 60-72 -> master 60 maps to screen x={sx(60):.0f} (off-screen if <0)")
