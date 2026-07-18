#!/usr/bin/env python3
"""
Generate a DISTINCT SFX set per short (so the 5 shorts don't sound the same) via
the ElevenLabs Sound-Effects endpoint. Each set = ding (correct-answer) + whoosh
(transition) + sting (score/outro), with a distinct timbre per short. Writes to
remotion/public/audio/sfx/<slug>/{ding,whoosh,sting}.mp3 and peak-normalizes each
to -6 dBFS (ffmpeg). Key read from env/.env; never printed. Run: python3 gen_sfx_variants.py
"""
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.abspath(os.path.join(HERE, "..", "remotion", "public", "audio", "sfx"))
API = "https://api.elevenlabs.io/v1/sound-generation"
FFMPEG = "/opt/homebrew/bin/ffmpeg" if os.path.exists("/opt/homebrew/bin/ffmpeg") else "ffmpeg"
PEAK_TARGET = -6.0  # dBFS

# slug -> { ding/whoosh/sting: (prompt, seconds) } — a distinct sonic identity each.
SETS = {
    "short-1": {  # bright / sparkly bell
        "ding": ("A bright sparkly bell success chime for a kids game show correct answer, short clean single shimmering ding, no music.", 0.6),
        "whoosh": ("A fast bright airy whoosh transition swoosh for a game show, quick clean single sweep.", 0.5),
        "sting": ("A short bright brass fanfare flourish sting for a game show results screen, quick triumphant clean.", 0.9),
    },
    "short-2": {  # warm wooden mallet
        "ding": ("A warm wooden marimba xylophone success ding for a kids quiz correct answer, short mellow single mallet hit, clean, no music.", 0.6),
        "whoosh": ("A deep smooth low bass whoosh transition, quick clean single rounded sweep.", 0.5),
        "sting": ("A short warm marimba arpeggio flourish sting rising to a results screen, quick playful clean.", 0.9),
    },
    "short-3": {  # retro 8-bit arcade
        "ding": ("A retro 8-bit arcade coin pickup success blip for a correct answer, short chiptune ding, clean single hit.", 0.6),
        "whoosh": ("A retro 8-bit laser zap swoosh transition, quick synthetic single sweep, clean.", 0.5),
        "sting": ("A short 8-bit chiptune victory jingle sting for a game results screen, quick upbeat clean.", 0.9),
    },
    "short-4": {  # bouncy cartoon pop
        "ding": ("A bouncy bubbly pop success chime for a kids game correct answer, short playful single pop ding, clean, no music.", 0.6),
        "whoosh": ("A playful springy cartoon whoosh transition, light, quick clean single sweep.", 0.5),
        "sting": ("A short bouncy playful marimba and pop flourish sting for a results screen, quick cheerful clean.", 0.9),
    },
    "short-5": {  # cinematic triumphant
        "ding": ("A triumphant bright harp glissando success chime for a correct answer, short elegant sparkling upward ding, clean, no music.", 0.6),
        "whoosh": ("A cinematic rising riser whoosh transition building up, quick smooth single sweep, clean.", 0.5),
        "sting": ("A short cinematic orchestral brass hit sting for a big results reveal, quick bold triumphant clean.", 0.9),
    },
}


def get_key():
    k = os.environ.get("ELEVENLABS_API_KEY")
    if not k:
        envp = os.path.join(HERE, ".env")
        if os.path.exists(envp):
            for line in open(envp):
                line = line.strip()
                if line.startswith("ELEVENLABS_API_KEY=") and not line.startswith("#"):
                    k = line.split("=", 1)[1].strip().strip('"').strip("'")
                    break
    if not k:
        print("ERROR: ELEVENLABS_API_KEY not set", file=sys.stderr)
        sys.exit(2)
    return k


def gen(key, text, dur):
    body = json.dumps({"text": text, "duration_seconds": dur, "prompt_influence": 0.45}).encode()
    req = urllib.request.Request(API + "?output_format=mp3_44100_128", data=body, method="POST")
    req.add_header("xi-api-key", key)
    req.add_header("Content-Type", "application/json")
    req.add_header("Accept", "audio/mpeg")
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def peak_normalize(path):
    """Two-pass peak normalize to PEAK_TARGET dBFS."""
    det = subprocess.run([FFMPEG, "-i", path, "-af", "volumedetect", "-f", "null", "-"],
                         capture_output=True, text=True).stderr
    m = re.search(r"max_volume:\s*(-?\d+\.?\d*) dB", det)
    if not m:
        return None
    gain = PEAK_TARGET - float(m.group(1))
    tmp = path + ".norm.mp3"
    subprocess.run([FFMPEG, "-y", "-i", path, "-af", f"volume={gain:.2f}dB", "-c:a", "libmp3lame", "-b:a", "128k", tmp],
                   capture_output=True, text=True)
    os.replace(tmp, path)
    return gain


def main():
    key = get_key()
    ok = 0
    total = 0
    for slug, kinds in SETS.items():
        d = os.path.join(OUT, slug)
        os.makedirs(d, exist_ok=True)
        for kind, (text, dur) in kinds.items():
            total += 1
            st, raw = gen(key, text, dur)
            if st != 200 or not raw or raw[:2] == b"{\"":
                print(f"[sfx] {slug}/{kind}: HTTP {st} {raw[:120]!r}")
                continue
            path = os.path.join(d, f"{kind}.mp3")
            with open(path, "wb") as fh:
                fh.write(raw)
            g = peak_normalize(path)
            print(f"[sfx] {slug}/{kind}: {len(raw)} bytes, norm {g:+.1f}dB -> {os.path.relpath(path, OUT)}")
            ok += 1
    print(f"[sfx] generated {ok}/{total}")
    sys.exit(0 if ok == total else 1)


if __name__ == "__main__":
    main()
