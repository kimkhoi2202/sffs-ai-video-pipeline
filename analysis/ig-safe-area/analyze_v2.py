"""V2 measurements for the safe-area revision.

Primary playback (with action buttons + username): image-746816f0 (472x1024).
Width reference (no action column): image-c0626e3e (472x1024).

Cover model (verified in v1): IG scales the 9:16 reel to fill screen height,
cropping ~97.5px/side off the 1080 master.  s = H/1920, crop_master = 97.5.
"""
import os
from PIL import Image
import numpy as np

# Generated crops render IN-PROJECT under renders.nosync (iCloud-skipped), never the Desktop.
_OUT_DIR = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "renders.nosync", "working", "ig-safe-area"))
os.makedirs(_OUT_DIR, exist_ok=True)

ORIG = "/Users/khoilam/.cursor/projects/Users-khoilam-Documents-Crossover-coding-projects/assets/image-746816f0-3767-4362-a441-174f36b84b6c.png"
REF  = "/Users/khoilam/.cursor/projects/Users-khoilam-Documents-Crossover-coding-projects/assets/image-c0626e3e-7f58-4369-ba98-c80fa569fe65.png"

MW, MH = 1080, 1920

def load(p):
    im = Image.open(p).convert("RGB")
    W, H = im.size
    a = np.asarray(im).astype(np.int16)
    return im, W, H, a

def model(W, H):
    s = H / MH
    crop_screen = (MW * s - W) / 2.0
    return s, crop_screen

def mx_from_sx(sx, s, crop): return (sx + crop) / s      # screen x -> master x
def my_from_sy(sy, s):       return sy / s                # screen y -> master y
def sx_from_mx(mx, s, crop): return mx * s - crop
def sy_from_my(my, s):       return my * s

# ============================ PRIMARY ======================================
im, W, H, a = load(ORIG)
s, crop = model(W, H)
R, G, B = a[:, :, 0], a[:, :, 1], a[:, :, 2]
white = (R > 205) & (G > 205) & (B > 205)
red   = (R > 150) & (G < 110) & (B < 110)
yellow = (R > 200) & (G > 150) & (B < 120)
print(f"PRIMARY {W}x{H}  s={s:.4f}  crop_screen={crop:.1f}  crop_master={crop/s:.1f}")
print(f"  visible master X range = [{crop/s:.1f} .. {mx_from_sx(W,s,crop):.1f}]  (right vis edge)")

# --- option cards (white plates) left/right edges --------------------------
plate_L, plate_R = [], []
for y in range(int(H*0.36), int(H*0.66)):
    xs = np.where(white[y])[0]
    if len(xs) > 50:                    # a real plate row
        plate_L.append(int(xs.min())); plate_R.append(int(xs.max()))
cardL = int(np.median(plate_L)); cardR = int(np.median(plate_R))
print(f"  option card edges (screen): L={cardL}  R={cardR}  "
      f"-> master L={mx_from_sx(cardL,s,crop):.0f}  R={mx_from_sx(cardR,s,crop):.0f}")

# --- action column left edge (heart/comment/share/more/audio) --------------
strip_x0 = int(W*0.80)
edges = []
for y in range(int(H*0.66), int(H*0.83)):   # rows BELOW the plates
    br = np.where(white[y, strip_x0:] | red[y, strip_x0:] | yellow[y, strip_x0:])[0]
    if len(br): edges.append(strip_x0 + int(br.min()))
act_left = int(np.percentile(edges, 5)) if edges else W
hy, hx = np.where(red[:, strip_x0:])
heart_left = int(hx.min()+strip_x0) if len(hx) else None
print(f"  action-col left edge (screen): {act_left}  heart_left={heart_left}  "
      f"-> master act_left={mx_from_sx(act_left,s,crop):.0f}")

# --- bottom stack: profile discs, username, caption ------------------------
# yellow discs bottom-left (audio/profile avatars), below the plates
yb = yellow.copy(); yb[:int(H*0.70),:] = False; yb[:, int(W*0.35):] = False
yy, yx = np.where(yb)
disc_top = int(yy.min()) if len(yy) else H
disc_bot = int(yy.max()) if len(yy) else H
# text rows in the bottom band: count bright pixels per row in the text column
txt = (white).mean(axis=1)
print(f"  disc(yellow) top={disc_top} bot={disc_bot}  (screen)")
print("  bottom bright-text row profile (y: whiteFrac) around username/caption:")
for y in range(760, 940, 4):
    frac = white[y, int(W*0.10):int(W*0.70)].mean()
    bar = "#"*int(frac*120)
    print(f"    y={y:4d} {frac:.3f} {bar}")

# ============================ SECONDARY (width ref) ========================
im2, W2, H2, a2 = load(REF)
s2, crop2 = model(W2, H2)
R2, G2, B2 = a2[:, :, 0], a2[:, :, 1], a2[:, :, 2]
white2 = (R2 > 205) & (G2 > 205) & (B2 > 205)
pl, pr = [], []
for y in range(int(H2*0.38), int(H2*0.68)):
    xs = np.where(white2[y])[0]
    if len(xs) > 50:
        pl.append(int(xs.min())); pr.append(int(xs.max()))
if pl:
    print(f"\nSECONDARY {W2}x{H2}  option card edges (screen): L={int(np.median(pl))} "
          f"R={int(np.median(pr))} -> master L={mx_from_sx(int(np.median(pl)),s2,crop2):.0f} "
          f"R={mx_from_sx(int(np.median(pr)),s2,crop2):.0f}")

# save a bottom crop of PRIMARY for visual confirmation of the username line
im.crop((0, 640, W, H)).resize(((W)*2, (H-640)*2)).save(os.path.join(_OUT_DIR, "crop_primary_bottom.png"))
print("\nwrote crop_primary_bottom.png")
