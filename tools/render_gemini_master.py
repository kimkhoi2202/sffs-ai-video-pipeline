#!/usr/bin/env python3
"""
Render the Gemini-voiced master quiz video (Kid Loop, round 01).

Reuses the on-brand Pillow plates from render_demo_quiz.py (Anton + DM Sans,
hard shadows, flat color-blocking, 5s countdowns, mint reveals) but:
  - narration is generated with Gemini TTS (gemini-2.5-pro-preview-tts, voice
    "Puck") via the TrueFoundry gateway (see gen_vo.sh),
  - every segment is sized to the length of its own narration clip (+ pad),
  - a light tick bed sits under each countdown and a soft ding under each reveal.

Content is ORIGINAL (drawn from video/content/starter-quiz-bank.md, identical to
the demo render for consistency); parent-email gate only; no Alpha branding.

Usage:
  render_gemini_master.py frames   # draw all PNGs / countdown frame sequences
  render_gemini_master.py bodies   # write TTS request bodies (no API key)
  render_gemini_master.py build    # size to VO, build per-seg clips, concat, verify
"""
import contextlib
import json
import os
import subprocess
import sys
import wave

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import render_demo_quiz as R  # noqa: E402  (brand plate drawing + palette)

FF = "/opt/homebrew/bin/ffmpeg"
FP = "/opt/homebrew/bin/ffprobe"
ROOT = "/Users/khoilam/Documents/Crossover/30mpc-website-design-cursor"

WORK = "/tmp/qz_gem"
FRAMES = f"{WORK}/frames"
CLIPS = f"{WORK}/clips"
VO = "/tmp/qz_vo"
BODIES = f"{VO}/bodies"
OUT = f"{ROOT}/video/renders/round-01-master-gemini.mp4"

# HQ anti-aliased deliverable. Same timeline as OUT, but frames are re-rendered
# with supersampled anti-aliasing (see render_demo_quiz.SS) and encoded at higher
# quality. The finished audio (Gemini VO + music) is REUSED verbatim from the
# existing master below via stream copy -- no TTS/music is regenerated, so A/V
# stays byte-for-byte in sync.
OUT_HQ = f"{ROOT}/video/renders/round-01-master-gemini-music-hq.mp4"
MUSIC_SRC = f"{ROOT}/video/renders/round-01-master-gemini-music.mp4"
TMP_HQ = f"{WORK}/round-01-hq-concat.mp4"

MODEL = "gemini-2.5-pro-preview-tts"
VOICE = "Puck"  # upbeat Gemini prebuilt voice -> game-show host energy

# Natural-language style directives. Gemini TTS interprets (does NOT speak) the
# text before the colon; verified empirically (prefixed vs plain = same spoken
# length, different prosody).
HOST = "Read this like a high-energy, upbeat TV game-show host, fast and punchy"
REVEAL = "Read this like a game-show host cheerfully revealing the answer"
URGENT = "Shout this with urgent, excited game-show energy"
WARM = "Read this warmly and invitingly, like a friendly game-show host"

# key -> (style, spoken line)
NARR = {
    "intro": (HOST,
              "Welcome to the Brain Teaser Quiz! Three riddles, one ticking "
              "clock, and one big question... are you a smart fella, or a fart "
              "smella? Let's find out how many you can crack!"),
    "q1": (HOST,
           "Question one. Here's your warm-up. Which one of these animals "
           "simply cannot jump? Is it the kangaroo, the frog, the elephant, "
           "or the rabbit? Five seconds on the clock!"),
    "q2": (HOST,
           "Question two, and it's a brain-bender. Which planet is the hottest "
           "in the whole solar system? Mercury, Venus, Mars, or Jupiter? "
           "Lock it in!"),
    "q3": (HOST,
           "Question three, the big-brain finale! One, one, two, three, five, "
           "eight... what number comes next? Eleven, twelve, thirteen, or "
           "twenty-one?"),
    "timesup": (URGENT, "Time's up! Pencils down!"),
    "r1": (REVEAL,
           "The answer is C, the elephant! Adult elephants are just too heavy "
           "to get all four feet off the ground at once."),
    "r2": (REVEAL,
           "It's B, Venus! Even though Mercury sits closer to the sun, Venus "
           "traps heat under thick clouds like a blanket, making it the "
           "hottest of them all."),
    "r3": (REVEAL,
           "The answer is C, thirteen! Just add the two numbers before it. "
           "Five plus eight equals thirteen. That's the famous Fibonacci "
           "pattern!"),
    "score": (HOST,
              "So, how did you do? Three out of three, you're a certified "
              "smart fella! Two out of three, a sharp cookie. One out of "
              "three? Every rookie riddler starts somewhere!"),
    "outro": (WARM,
              "Want to see your full results? Ask a parent to enter their "
              "email on screen. There are five hundred and two thousand dollar "
              "prizes for parents up for grabs. Check the official rules, and "
              "we'll see you in the next round!"),
}

# Light audio bed exprs (kept low so the VO stays on top).
TICK = "0.09*sin(2*PI*1150*t)*exp(-32*mod(t,1))"
DING = "0.16*sin(2*PI*880*t)*exp(-3.5*t)+0.10*sin(2*PI*1320*t)*exp(-3.5*t)"

CD = 5           # countdown seconds per question (user spec)
LEAD = 0.35      # silence before VO on static plates
TRAIL = 0.80     # silence after VO on static plates
AR = 48000

ENC = [
    "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
    "-r", "30", "-profile:v", "high", "-level:v", "4.2",
    "-x264-params", "keyint=60:min-keyint=60:scenecut=0",
    "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709",
]
AENC = ["-c:a", "aac", "-b:a", "192k", "-ar", str(AR), "-ac", "2"]

# High-quality final encode for the anti-aliased master (user spec: libx264,
# crf 16, preset slow, yuv420p, +faststart, 1920x1080 @ 30fps).
ENC_HQ = [
    "-c:v", "libx264", "-preset", "slow", "-crf", "16", "-pix_fmt", "yuv420p",
    "-r", "30", "-profile:v", "high", "-level:v", "4.2",
    "-x264-params", "keyint=60:min-keyint=60:scenecut=0",
    "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709",
]
# Near-lossless intermediate for the per-segment clips so the single crf-16 concat
# pass is the only meaningful compression step (no visible generation loss on the
# flat-color art).
ENC_INT = [
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "12", "-pix_fmt", "yuv420p",
    "-r", "30", "-profile:v", "high", "-level:v", "4.2",
    "-x264-params", "keyint=60:min-keyint=60:scenecut=0",
    "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709",
]


def sh(cmd):
    p = subprocess.run(cmd, capture_output=True, text=True)
    if p.returncode != 0:
        sys.stderr.write("CMD FAILED: " + " ".join(cmd) + "\n" + p.stderr + "\n")
        raise SystemExit(1)
    return p


def wav_dur(path):
    with contextlib.closing(wave.open(path, "rb")) as w:
        return w.getnframes() / float(w.getframerate())


# ---------------------------------------------------------------- frames
def frames():
    for d in (FRAMES, CLIPS):
        os.makedirs(d, exist_ok=True)

    R.render_title(f"{FRAMES}/title.png")

    questions = [
        dict(idx=1, bg=R.BLUE, tier="Warm-Up",
             question="WHICH ANIMAL CANNOT JUMP?",
             options=[("A", "KANGAROO"), ("B", "FROG"),
                      ("C", "ELEPHANT"), ("D", "RABBIT")],
             cd_accent=R.YELLOW, bar_accent=R.YELLOW),
        dict(idx=2, bg=R.CORAL, tier="Brain-Bender",
             question="WHICH PLANET IS THE HOTTEST?",
             options=[("A", "MERCURY"), ("B", "VENUS"),
                      ("C", "MARS"), ("D", "JUPITER")],
             cd_accent=R.YELLOW, bar_accent=R.YELLOW),
        dict(idx=3, bg=R.YELLOW, tier="Big-Brain",
             question="WHAT COMES NEXT?\n1   1   2   3   5   8   ?",
             options=[("A", "11"), ("B", "12"), ("C", "13"), ("D", "21")],
             cd_accent=R.CORAL, bar_accent=R.CORAL),
    ]
    for q in questions:
        cfg = dict(q, countdown=CD, outdir=f"{FRAMES}/q{q['idx']}")
        R.render_question(cfg)
        # frame 0 (shows "5" + full bar) doubles as the static "read" plate
        import shutil
        shutil.copy(f"{FRAMES}/q{q['idx']}/00000.png",
                    f"{FRAMES}/q{q['idx']}_read.png")

    R.render_reveal(f"{FRAMES}/r1.png", R.MINT, "C", "ELEPHANT",
                    "Adult elephants are too heavy to get all four feet off "
                    "the ground at once.")
    R.render_reveal(f"{FRAMES}/r2.png", R.MINT, "B", "VENUS",
                    "Venus's thick clouds trap heat like a blanket, making it "
                    "hotter than Mercury.")
    R.render_reveal(f"{FRAMES}/r3.png", R.MINT, "C", "13",
                    "Add the two numbers before it: 5 + 8 = 13. It's the "
                    "Fibonacci pattern.")
    R.render_score(f"{FRAMES}/score.png")
    R.render_outro(f"{FRAMES}/outro.png")
    print("frames: rendered plates + 3 countdown sequences ->", FRAMES)


# ---------------------------------------------------------------- bodies
def bodies():
    os.makedirs(BODIES, exist_ok=True)
    for key, (style, line) in NARR.items():
        body = {"model": MODEL, "input": f"{style}: {line}", "voice": VOICE}
        with open(f"{BODIES}/{key}.json", "w") as f:
            json.dump(body, f)
    print(f"bodies: wrote {len(NARR)} TTS request bodies -> {BODIES}")


# ---------------------------------------------------------------- build
def _static_clip(out, png, vo_key, ding=False, enc=ENC):
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
            *enc, *AENC, "-t", f"{d}", out]
    sh(cmd)
    return d


def _count_clip(out, qidx, enc=ENC):
    seg = f"{FRAMES}/q{qidx}"
    n = len([x for x in os.listdir(seg) if x.endswith(".png")])
    base = round(n / 30.0, 3)                     # 6.0s (5s count + 1s "0" hold)
    tu = wav_dur(f"{VO}/timesup.wav")
    tu_at = float(CD)                             # fire "time's up" as clock hits 0
    d = round(max(base, tu_at + tu + 0.30), 3)    # hold last frame so VO rings out
    hold = round(d - base, 3)
    vf = "[0:v]tpad=stop_mode=clone:stop_duration=%s[v]" % hold if hold > 0 else None
    dly = int(tu_at * 1000)
    af = (f"[2:a]adelay={dly}|{dly}[tu];"
          f"[1:a][tu]amix=inputs=2:normalize=0,apad[a]")
    fc = (vf + ";" + af) if vf else af
    vmap = "[v]" if vf else "0:v"
    cmd = [FF, "-y", "-loglevel", "error",
           "-framerate", "30", "-i", f"{seg}/%05d.png",
           "-f", "lavfi", "-i", f"aevalsrc=exprs='{TICK}':d={CD}:s={AR}",  # ticks stop at 0
           "-i", f"{VO}/timesup.wav",
           "-filter_complex", fc,
           "-map", vmap, "-map", "[a]", *enc, *AENC, "-t", f"{d}", out]
    sh(cmd)
    return d


# Per-segment timeline: (clip name, kind, arg, vo_key, ding). Shared so the HQ
# rebuild reproduces the EXACT same segment durations as the original master.
PLAN = [
    ("01_title",  "static", f"{FRAMES}/title.png",   "intro", False),
    ("02_q1read", "static", f"{FRAMES}/q1_read.png", "q1",    False),
    ("03_q1cnt",  "count",  1,                        None,   None),
    ("04_r1",     "static", f"{FRAMES}/r1.png",      "r1",    True),
    ("05_q2read", "static", f"{FRAMES}/q2_read.png", "q2",    False),
    ("06_q2cnt",  "count",  2,                        None,   None),
    ("07_r2",     "static", f"{FRAMES}/r2.png",      "r2",    True),
    ("08_q3read", "static", f"{FRAMES}/q3_read.png", "q3",    False),
    ("09_q3cnt",  "count",  3,                        None,   None),
    ("10_r3",     "static", f"{FRAMES}/r3.png",      "r3",    True),
    ("11_score",  "static", f"{FRAMES}/score.png",   "score", False),
    ("12_outro",  "static", f"{FRAMES}/outro.png",   "outro", False),
]


def _probe(path):
    """Return (nb_frames, duration_seconds) for the video stream of a file."""
    n = sh([FP, "-v", "error", "-select_streams", "v:0", "-count_frames",
            "-show_entries", "stream=nb_read_frames", "-of", "default=nk=1:nw=1",
            path]).stdout.strip()
    d = sh([FP, "-v", "error", "-show_entries", "format=duration",
            "-of", "default=nk=1:nw=1", path]).stdout.strip()
    return int(n), float(d)


def _build_clips(enc):
    """Build every per-segment clip (video + throwaway sync audio) and return the
    ordered list of clip paths. The audio is only here so the concat reproduces
    the original CFR frame timeline exactly; it is discarded later."""
    os.makedirs(CLIPS, exist_ok=True)
    clips, rows, total = [], [], 0.0
    for name, kind, arg, vo, ding in PLAN:
        out = f"{CLIPS}/{name}.mp4"
        if kind == "static":
            d = _static_clip(out, arg, vo, ding=ding, enc=enc)
        else:
            d = _count_clip(out, arg, enc=enc)
        clips.append(out)
        rows.append((name, kind, d))
        total += d
        print(f"  built {name:10s} {kind:6s} {d:6.2f}s")
    return clips, rows, total


def build():
    clips, rows, total = _build_clips(ENC)

    # concat (filter re-encode -> clean A/V across joins)
    ins = []
    for c in clips:
        ins += ["-i", c]
    streams = "".join(f"[{i}:v][{i}:a]" for i in range(len(clips)))
    fc = f"{streams}concat=n={len(clips)}:v=1:a=1[v][a]"
    sh([FF, "-y", "-loglevel", "error", *ins, "-filter_complex", fc,
        "-map", "[v]", "-map", "[a]", *ENC, *AENC, "-movflags", "+faststart",
        OUT])

    print(f"\nSegments: {len(rows)}  target total ~{total:.2f}s")
    print("master:", OUT)


def build_hq():
    """Anti-aliased HQ master: re-render crisp SSAA frames, rebuild the exact same
    timeline, encode at crf 16 / preset slow, then reuse the FINISHED audio (VO +
    music) from the existing master via stream copy. No TTS/music regenerated."""
    if not os.path.isfile(MUSIC_SRC):
        raise SystemExit(f"missing finished-audio source: {MUSIC_SRC}")

    frames()  # crisp supersampled plates + countdown sequences

    clips, rows, total = _build_clips(ENC_INT)

    # Concat -> HQ video. The throwaway sync audio (a=1) makes the CFR concat
    # reproduce the original frame-exact timeline; it is replaced in the mux.
    ins = []
    for c in clips:
        ins += ["-i", c]
    streams = "".join(f"[{i}:v][{i}:a]" for i in range(len(clips)))
    fc = f"{streams}concat=n={len(clips)}:v=1:a=1[v][a]"
    sh([FF, "-y", "-loglevel", "error", *ins, "-filter_complex", fc,
        "-map", "[v]", "-map", "[a]", *ENC_HQ, *AENC, "-movflags", "+faststart",
        TMP_HQ])
    vframes, vdur = _probe(TMP_HQ)
    print(f"\nHQ video (crf16/slow): {vframes} frames, {vdur:.6f}s")

    # Mux: HQ video (copy) + finished audio from the existing music master (copy).
    adur = sh([FP, "-v", "error", "-show_entries", "format=duration",
               "-of", "default=nk=1:nw=1", MUSIC_SRC]).stdout.strip()
    sh([FF, "-y", "-loglevel", "error", "-i", TMP_HQ, "-i", MUSIC_SRC,
        "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "copy",
        "-movflags", "+faststart", OUT_HQ])

    oframes, odur = _probe(OUT_HQ)
    print(f"\nSegments: {len(rows)}  target total ~{total:.2f}s")
    print(f"reused audio from: {MUSIC_SRC}  (audio {adur}s)")
    print(f"master-hq: {OUT_HQ}\n  {oframes} frames / {odur:.6f}s @ 30fps")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "build"
    {"frames": frames, "bodies": bodies, "build": build, "hq": build_hq}[cmd]()
