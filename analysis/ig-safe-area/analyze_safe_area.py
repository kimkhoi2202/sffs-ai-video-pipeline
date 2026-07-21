"""Measure Instagram Reels UI overlay boundaries from a screenshot.

The screenshot is a full phone screen (~19.5:9). We measure where IG's chrome
sits (status bar, camera, right action column, bottom caption/comment stack),
express each boundary as a fraction of the screen, then map those fractions onto
a 1080x1920 (9:16) master to use as design insets.
"""
import os
from PIL import Image
import numpy as np

SRC = "/Users/khoilam/.cursor/projects/Users-khoilam-Documents-Crossover-coding-projects/assets/image-746816f0-3767-4362-a441-174f36b84b6c.png"

im = Image.open(SRC).convert("RGB")
W, H = im.size
a = np.asarray(im).astype(np.int16)
R, G, B = a[:, :, 0], a[:, :, 1], a[:, :, 2]
print(f"screenshot size: {W} x {H}  (aspect {W/H:.4f})")

white = (R > 205) & (G > 205) & (B > 205)
red   = (R > 150) & (G < 110) & (B < 110)
yellow = (R > 200) & (G > 150) & (B < 120)
green = (G > R + 10) & (G > B + 10) & (G > 110)

def col(x): return int(round(x))

# --- TOP: system status bar (top-left clock band, not our pills) -----------
# The clock "7:34" is white text high on the left; measure its band, ignoring
# our pills which start lower. Use a thin top region only.
clk = white[0:60, int(W*0.05):int(W*0.22)]
crows = np.where(clk.any(axis=1))[0]
status_bar_bottom = int(crows.max()) + 1 if len(crows) else 50
print(f"TOP status bar bottom (clock band) ~ y={status_bar_bottom}")

# --- TOP-RIGHT camera icon (IG chrome, below the status bar) ---------------
cam = white[55:130, int(W*0.86):W]
crows = np.where(cam.any(axis=1))[0]
camera_bottom = 55 + int(crows.max()) + 1 if len(crows) else status_bar_bottom
print(f"TOP-RIGHT camera icon bottom ~ y={camera_bottom}")

# --- RIGHT action column (profile/heart/comment/share/more/audio) ----------
# restrict to far-right strip so wide white quiz plates are excluded
strip_x0 = int(W * 0.80)
edges = []
# scan rows BELOW the quiz plates (comment/share/more/repost/audio disc live here)
for y in range(int(H*0.66), int(H*0.83)):
    bright = np.where(white[y, strip_x0:] | red[y, strip_x0:] | yellow[y, strip_x0:])[0]
    if len(bright):
        edges.append(strip_x0 + int(bright.min()))
edges_arr = np.array(edges) if edges else np.array([W])
action_left = int(np.percentile(edges_arr, 5))
print(f"RIGHT action column leftmost icon edge ~ x={action_left} "
      f"(min={int(edges_arr.min())}, p5={int(np.percentile(edges_arr,5))}, "
      f"p25={int(np.percentile(edges_arr,25))}, median={int(np.median(edges_arr))}, n={len(edges)})")

# heart specifically (red blob in the right strip) — the tightest current clash
hy, hx = np.where(red[:, strip_x0:])
heart_left = None
if len(hx):
    hx = hx + strip_x0
    heart_left = int(hx.min())
    print(f"  heart red bbox x[{hx.min()}..{hx.max()}] y[{hy.min()}..{hy.max()}]")

# --- BOTTOM: top of the caption/username/audio/comment stack ---------------
# The highest bottom-chrome element bottom-left is the profile/audio disc pair
# (bright yellow circles). Find the top-most yellow disc in the lower-left area.
# restrict below the option plates (skip the yellow 'D' tile) and to the left.
yb = yellow.copy()
yb[:int(H*0.74), :] = False       # below all quiz plates
yb[:, int(W*0.4):] = False        # bottom-left discs only
yy, yx = np.where(yb)
disc_top = int(yy.min()) if len(yy) else H
print(f"BOTTOM disc/username stack top ~ y={disc_top} "
      f"(yellow px found: {len(yy)})")

# dark 'Add comment' bar + home area
dark = (R < 70) & (G < 70) & (B < 70)
drow = dark.mean(axis=1)
y = H - 1
while y > 0 and drow[y] > 0.4:
    y -= 1
comment_bar_top = y + 1
print(f"dark comment/home block top ~ y={comment_bar_top}")

# --- LEFT: leftmost edge of our own quiz plates (our content today) --------
plate_left = []
for y in range(int(H*0.36), int(H*0.66)):
    xs = np.where(white[y, :int(W*0.5)])[0]
    if len(xs):
        plate_left.append(int(xs.min()))
left_edge = int(np.median(plate_left)) if plate_left else 0
print(f"LEFT current plate edge ~ x={left_edge}")

# ---------------------------------------------------------------------------
MW, MH = 1080, 1920
def frac_h(px): return px / H
def frac_w(px): return px / W
def to_m_h(px): return round(frac_h(px) * MH)
def to_m_w(px): return round(frac_w(px) * MW)

print("\n=== MEASURED CHROME (screen px -> % -> 1080x1920 px) ===")
rows_out = [
    ("TOP status bar",   status_bar_bottom, frac_h(status_bar_bottom), to_m_h(status_bar_bottom), MH),
    ("TOP camera icon",  camera_bottom,     frac_h(camera_bottom),     to_m_h(camera_bottom),     MH),
    ("BOTTOM chrome",    H - disc_top,      frac_h(H - disc_top),      to_m_h(H - disc_top),      MH),
    ("BOTTOM (comment only)", H - comment_bar_top, frac_h(H-comment_bar_top), to_m_h(H-comment_bar_top), MH),
    ("RIGHT action col", W - action_left,   frac_w(W - action_left),   to_m_w(W - action_left),   MW),
    ("LEFT plate edge",  left_edge,         frac_w(left_edge),         to_m_w(left_edge),         MW),
]
for name, px, fr, mpx, dim in rows_out:
    print(f"{name:24s}: {px:4d}px  {fr*100:5.1f}%  -> {mpx:4d}px @ {'H' if dim==MH else 'W'}")

# stash measurements for the drawing script
import json
json.dump({
    "W": W, "H": H,
    "status_bar_bottom": status_bar_bottom,
    "camera_bottom": camera_bottom,
    "action_left": action_left,
    "disc_top": disc_top,
    "comment_bar_top": comment_bar_top,
    "left_edge": left_edge,
    "heart": [int(hx.min()), int(hy.min()), int(hx.max()), int(hy.max())] if len(hx) else None,
}, open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "measurements.json"), "w"), indent=2)
print("\nwrote measurements.json")
