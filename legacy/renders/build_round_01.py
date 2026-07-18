#!/usr/bin/env python3
"""
Round 01 — "Smart Fella or Fart Smella?" — end-to-end quiz video renderer.

Fully automatic: builds each segment as its OWN self-contained clip
(plate -> scaled+pillarboxed background, PIL overlay cards, timed digit
overlays + stepped depleting timer bar via drawbox, macOS `say` narration,
lavfi tick/ding SFX mixed low), exports every segment with IDENTICAL params,
then concatenates via the concat demuxer.

Why PIL overlays instead of drawtext: this Homebrew ffmpeg is built WITHOUT
libfreetype, so the drawtext/subtitles filters are unavailable. All type/cards
are rendered to transparent PNGs by make_overlays.py (real Anton + DM Sans),
then composited with `overlay` (no freetype needed).

Reads (for content/brand): video/riddle-video-style-spec.md, DESIGN.md,
video/content/starter-quiz-bank.md, video/compliance.md.

Output: video/renders/round-01-master.mp4  +  round-01-timeline.md
"""
import os, subprocess, json, shutil, sys

FFMPEG  = "/opt/homebrew/bin/ffmpeg"
FFPROBE = "/opt/homebrew/bin/ffprobe"
SAY     = "/usr/bin/say"

WORK     = "/tmp/quiz_build"
ASSETS   = "/Users/khoilam/.cursor/projects/Users-khoilam-Documents-Crossover-coding-projects/assets"
PROJECT  = "/Users/khoilam/Documents/Crossover/30mpc-website-design-cursor"
OUT_DIR  = f"{PROJECT}/video/renders"
HERE     = os.path.dirname(os.path.abspath(__file__))

ANTON  = "/tmp/Anton-Regular.ttf"
DMSANS = "/tmp/DMSans.ttf"
ANTON_URL  = "https://github.com/google/fonts/raw/main/ofl/anton/Anton-Regular.ttf"
DMSANS_URL = "https://github.com/google/fonts/raw/main/ofl/dmsans/DMSans%5Bopsz%2Cwght%5D.ttf"

VOICE = "Samantha"   # best natural built-in en_US voice (no Enhanced/Premium installed)
RATE  = 178

# plate background fill colors (for the 3:2 -> 16:9 pillarbox pad; matches each plate)
BG = {
    "yellow": "0xFCE552", "blue": "0x839AFF", "coral": "0xFD7962",
    "mint": "0xC6FCD0", "ink": "0x000000",
}

# ---- narration (original, energetic game-show host; the spoken script) ----
VO_TEXT = {
    "intro": "Are you a smart fella... or a fart smella? Let's find out! Three riddles, five seconds each. Get that big brain ready... here we go!",
    "q1":    "Riddle number one. I have keys, but no locks. A space bar, but nothing to drink. And letters, but I send no mail. What am I? Your five seconds start now!",
    "r1":    "Time's up! The answer is... a keyboard! Keys, a space bar, and letters, just not the everyday kind. Did you get it?",
    "q2":    "Riddle two, and this one is out of this world. Which planet is the hottest in our whole solar system? Is it Mercury, Venus, Mars, or Jupiter? The clock is ticking!",
    "r2":    "The answer is... Venus! Its thick clouds trap heat like a cozy blanket, making it even hotter than Mercury. Boom!",
    "q3":    "Last one, and it's a tricky one. The more you take away from me, the bigger I get. What in the world am I? Five seconds... go!",
    "r3":    "Time! The answer is... a hole! The more you dig out of it, the bigger it gets. Sneaky, right?",
    "outro": "So, how did you do? Smart fella, or fart smella? Want your official brain score? Grown-ups, pop your email in to unlock the results, and play for a chance at some seriously cool prizes. See you next time!",
}

# segment order + wiring. kind: "static" | "question"
SEGMENTS = [
    dict(name="intro", kind="static",   plate="plate-intro-yellow", bg="yellow", overlay="ov_intro", vo="intro", pad=1.10, ding=0.15),
    dict(name="q1",    kind="question", plate="plate-question-blue", bg="blue",  overlay="ov_q1",    vo="q1"),
    dict(name="r1",    kind="static",   plate="plate-reveal-mint",  bg="mint",   overlay="ov_r1",    vo="r1", pad=1.10, ding=0.25),
    dict(name="q2",    kind="question", plate="plate-question-coral",bg="coral", overlay="ov_q2",    vo="q2"),
    dict(name="r2",    kind="static",   plate="plate-reveal-mint",  bg="mint",   overlay="ov_r2",    vo="r2", pad=1.10, ding=0.25),
    dict(name="q3",    kind="question", plate="plate-question-blue", bg="blue",  overlay="ov_q3",    vo="q3"),
    dict(name="r3",    kind="static",   plate="plate-reveal-mint",  bg="mint",   overlay="ov_r3",    vo="r3", pad=1.10, ding=0.25),
    dict(name="outro", kind="static",   plate="plate-outro-ink",    bg="ink",    overlay="ov_outro", vo="outro", pad=1.30, ding=0.15),
]

COUNTDOWN   = 5.0     # seconds of on-screen countdown per question
Q_LEAD      = 0.35    # beat between end of question VO and countdown start
Q_TAIL      = 0.60    # beat after countdown before the reveal cut
BAR_FULL_W  = 544     # px (matches make_overlays BAR_FILL_W)
BOX_W       = [544, 435, 326, 218, 109]  # stepped depleting-bar widths (5..1)

# identical export params for every segment (critical for clean concat)
VENC = ["-r", "30", "-fps_mode", "cfr", "-c:v", "libx264", "-profile:v", "high",
        "-pix_fmt", "yuv420p", "-preset", "medium", "-crf", "18"]
AENC = ["-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2"]

CMDS = []  # record every ffmpeg command for the report

def run(cmd, **kw):
    CMDS.append(" ".join(cmd))
    r = subprocess.run(cmd, capture_output=True, text=True, **kw)
    if r.returncode != 0:
        print("CMD FAILED:\n", " ".join(cmd))
        print(r.stderr[-3000:])
        raise SystemExit(1)
    return r

def dur(path):
    r = subprocess.run([FFPROBE, "-v", "error", "-show_entries", "format=duration",
                        "-of", "default=nk=1:nw=1", path], capture_output=True, text=True)
    return float(r.stdout.strip())

def ensure_fonts():
    for path, url, name in ((ANTON, ANTON_URL, "Anton"), (DMSANS, DMSANS_URL, "DM Sans")):
        ok = os.path.exists(path) and os.path.getsize(path) > 20000
        if not ok:
            print(f"downloading {name}...")
            subprocess.run(["curl", "-sL", "-o", path, url])
        # validate it is a real TTF
        with open(path, "rb") as fh:
            head = fh.read(4)
        if head not in (b"\x00\x01\x00\x00", b"true", b"OTTO", b"ttcf"):
            print(f"WARNING: {name} at {path} is not a valid TTF; text may fall back.")

def make_sfx():
    run([FFMPEG, "-y", "-loglevel", "error", "-f", "lavfi", "-i",
         "sine=frequency=1400:duration=0.05", "-af", "afade=t=out:st=0.02:d=0.03",
         "-ar", "48000", "-ac", "2", f"{WORK}/tick.wav"])
    run([FFMPEG, "-y", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=880:duration=0.6",
         "-f", "lavfi", "-i", "sine=frequency=1320:duration=0.6", "-filter_complex",
         "[0][1]amix=inputs=2,afade=t=out:st=0.12:d=0.48", "-ar", "48000", "-ac", "2", f"{WORK}/ding.wav"])

def make_vo():
    for key, text in VO_TEXT.items():
        run([SAY, "-v", VOICE, "-r", str(RATE), "-o", f"{WORK}/vo_{key}.aiff", text])

def build_static(seg, out):
    plate = f"{ASSETS}/{seg['plate']}.png"
    ov    = f"{WORK}/{seg['overlay']}.png"
    vo    = f"{WORK}/vo_{seg['vo']}.aiff"
    ding  = f"{WORK}/ding.wav"
    d     = dur(vo) + seg["pad"]
    bg    = BG[seg["bg"]]
    ding_ms = int(round(seg.get("ding", 0.15) * 1000))
    vfilter = (f"[0:v]scale=1620:1080,pad=1920:1080:150:0:color={bg},fps=30,setsar=1[bg];"
               f"[bg][1:v]overlay=0:0,format=yuv420p[vout]")
    afilter = (f"[2:a]aformat=sample_rates=48000:channel_layouts=stereo,apad,atrim=0:{d:.3f},asetpts=N/SR/TB[vo];"
               f"[3:a]aformat=sample_rates=48000:channel_layouts=stereo,volume=0.5,adelay={ding_ms}|{ding_ms}[dg];"
               f"[vo][dg]amix=inputs=2:normalize=0:duration=first[aout]")
    run([FFMPEG, "-y", "-loglevel", "error",
         "-loop", "1", "-i", plate, "-loop", "1", "-i", ov, "-i", vo, "-i", ding,
         "-filter_complex", vfilter + ";" + afilter,
         "-map", "[vout]", "-map", "[aout]", *VENC, *AENC,
         "-movflags", "+faststart", "-t", f"{d:.3f}", out])
    return d

def build_question(seg, out):
    plate = f"{ASSETS}/{seg['plate']}.png"
    ov    = f"{WORK}/{seg['overlay']}.png"
    vo    = f"{WORK}/vo_{seg['vo']}.aiff"
    tick  = f"{WORK}/tick.wav"
    digs  = [f"{WORK}/dig{n}.png" for n in (5, 4, 3, 2, 1)]
    vod   = dur(vo)
    TC    = vod + Q_LEAD
    d     = TC + COUNTDOWN + Q_TAIL
    bg    = BG[seg["bg"]]
    # ---- video: base overlay, 5 timed digit overlays, 5 stepped drawboxes ----
    v = [f"[0:v]scale=1620:1080,pad=1920:1080:150:0:color={bg},fps=30,setsar=1[bg]",
         f"[bg][1:v]overlay=0:0[base]"]
    prev = "base"
    for k in range(5):
        lab = f"o{k}"
        v.append(f"[{prev}][{k+2}:v]overlay=0:0:enable='between(t,{TC+k:.3f},{TC+k+1:.3f})'[{lab}]")
        prev = lab
    boxes = ",".join(
        f"drawbox=x=688:y=908:w={BOX_W[k]}:h=36:color=0xFCE552:t=fill:enable='between(t,{TC+k:.3f},{TC+k+1:.3f})'"
        for k in range(5))
    v.append(f"[{prev}]{boxes},format=yuv420p[vout]")
    vfilter = ";".join(v)
    # ---- audio: VO padded to duration + 5 ticks on each countdown second ----
    a = [f"[7:a]aformat=sample_rates=48000:channel_layouts=stereo,apad,atrim=0:{d:.3f},asetpts=N/SR/TB[vo]",
         f"[8:a]aformat=sample_rates=48000:channel_layouts=stereo,volume=0.4,asplit=5[k0][k1][k2][k3][k4]"]
    for k in range(5):
        ms = int(round((TC + k) * 1000))
        a.append(f"[k{k}]adelay={ms}|{ms}[d{k}]")
    a.append("[vo][d0][d1][d2][d3][d4]amix=inputs=6:normalize=0:duration=first[aout]")
    afilter = ";".join(a)
    inputs = ["-loop", "1", "-i", plate, "-loop", "1", "-i", ov]
    for dg in digs:
        inputs += ["-loop", "1", "-i", dg]
    inputs += ["-i", vo, "-i", tick]
    run([FFMPEG, "-y", "-loglevel", "error", *inputs,
         "-filter_complex", vfilter + ";" + afilter,
         "-map", "[vout]", "-map", "[aout]", *VENC, *AENC,
         "-movflags", "+faststart", "-t", f"{d:.3f}", out])
    return d, TC

def main():
    os.makedirs(WORK, exist_ok=True)
    os.makedirs(OUT_DIR, exist_ok=True)
    ensure_fonts()
    print("rendering overlays...")
    run([sys.executable, os.path.join(HERE, "make_overlays.py")])
    print("generating SFX + narration...")
    make_sfx()
    make_vo()

    print("building segments...")
    timeline, t0 = [], 0.0
    for i, seg in enumerate(SEGMENTS, 1):
        out = f"{WORK}/seg{i:02d}.mp4"
        if seg["kind"] == "static":
            d = build_static(seg, out)
            tc = None
        else:
            d, tc = build_question(seg, out)
        timeline.append(dict(seg=seg["name"], kind=seg["kind"], start=t0, end=t0 + d,
                             dur=d, tc=tc, vo=VO_TEXT[seg["vo"]], file=os.path.basename(out)))
        print(f"  seg{i:02d} {seg['name']:6s} dur={d:6.2f}s  ({t0:6.2f} -> {t0+d:6.2f})")
        t0 += d

    # ---- concat (demuxer, stream copy: all segments share identical params) ----
    listfile = f"{WORK}/concat.txt"
    with open(listfile, "w") as fh:
        for i in range(1, len(SEGMENTS) + 1):
            fh.write(f"file '{WORK}/seg{i:02d}.mp4'\n")
    master = f"{OUT_DIR}/round-01-master.mp4"
    run([FFMPEG, "-y", "-loglevel", "error", "-f", "concat", "-safe", "0",
         "-i", listfile, "-c", "copy", "-movflags", "+faststart", master])

    total = dur(master)
    print(f"\nMASTER: {master}\n  total={total:.2f}s")
    write_timeline(timeline, total, master)
    with open(f"{OUT_DIR}/build-commands.txt", "w") as fh:
        fh.write("\n\n".join(CMDS))
    print("done.")

def write_timeline(tl, total, master):
    pr = subprocess.run([FFPROBE, "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=width,height,codec_name,avg_frame_rate",
        "-of", "json", master], capture_output=True, text=True)
    v = json.loads(pr.stdout)["streams"][0]
    size_mb = os.path.getsize(master) / 1e6
    try:
        num, den = v["avg_frame_rate"].split("/")
        fps = f"{(float(num) / float(den)):.0f}" if float(den) else v["avg_frame_rate"]
    except Exception:
        fps = v.get("avg_frame_rate", "30")

    def ts(s):
        return f"{int(s//60):d}:{s%60:05.2f}"

    lines = []
    lines.append("# Round 01 — Timeline & Voiceover Map")
    lines.append("")
    lines.append('Master: `video/renders/round-01-master.mp4` — "Smart Fella or Fart Smella?" (Kid Loop pilot, variant (a)/(b) mix, lean tier).')
    lines.append("")
    lines.append(f"- **Resolution:** {v['width']}x{v['height']} ({v['codec_name']}, {fps} fps)")
    lines.append(f"- **Duration:** {total:.2f}s  ·  **Size:** {size_mb:.1f} MB  ·  Audio: AAC 48k stereo")
    lines.append(f"- **Placeholder narration:** macOS `say` voice **{VOICE}** (rate {RATE}). Replace per-segment with the ElevenLabs host VO; the Suno music bed muxes under the whole timeline.")
    lines.append("")
    lines.append("Each segment was rendered as a self-contained clip and concatenated (concat demuxer, stream copy). "
                 "Times below are absolute positions in the master; drop the ElevenLabs clip for each segment at its **start**, "
                 "and (for question segments) keep the countdown window fixed so the on-screen 5→0 timer and ticks stay in sync.")
    lines.append("")
    lines.append("| # | Segment | Start | End | Dur | Countdown window | Narration (placeholder = final script line) |")
    lines.append("|---|---|---|---|---|---|---|")
    for i, r in enumerate(tl, 1):
        cw = ""
        if r["tc"] is not None:
            cw = f"{ts(r['start']+r['tc'])} – {ts(r['start']+r['tc']+COUNTDOWN)}"
        vo = r["vo"].replace("|", "\\|")
        lines.append(f"| {i} | {r['seg']} | {ts(r['start'])} | {ts(r['end'])} | {r['dur']:.2f}s | {cw or '—'} | {vo} |")
    lines.append("")
    lines.append("## Music (Suno) cue sheet")
    lines.append("- **0:00–intro end:** upbeat game-show sting / bright bed, energetic.")
    lines.append("- **Question segments:** tension bed under narration; light rise during each countdown window.")
    lines.append("- **Reveal segments:** short positive resolve on the 'ding'.")
    lines.append("- **Outro:** warm, friendly button; leave headroom for the parent-email CTA line.")
    lines.append("- Keep music ~ -18 LUFS under VO; duck ~6 dB during narration.")
    lines.append("")
    lines.append("## SFX baked into this master (placeholders)")
    lines.append("- Countdown **tick** (lavfi sine 1400 Hz, ~50 ms) on each of the 5 seconds, low under VO.")
    lines.append("- Reveal / intro / outro **ding** (lavfi 880+1320 Hz bell) on the reveal pop.")
    lines.append("- Replace with designed SFX at mux time if desired; timings match the countdown windows above.")
    lines.append("")
    lines.append("## Compliance (COPPA / CARU)")
    lines.append("- Outro CTA is a **parent action**: “ASK A GROWN-UP TO ENTER THEIR EMAIL TO UNLOCK YOUR SCORE.” No child data requested on-screen.")
    lines.append("- Prize tease is parent-facing ($500 input / $2,000 spotlight) with “see official rules · no purchase necessary.”")
    lines.append("- No Alpha School / Alpha AI branding anywhere. Neutral “Closer”/Smart Fella visual system only.")
    with open(f"{OUT_DIR}/round-01-timeline.md", "w") as fh:
        fh.write("\n".join(lines) + "\n")

if __name__ == "__main__":
    main()
