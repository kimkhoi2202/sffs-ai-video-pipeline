#!/usr/bin/env python3
"""
Generate short on-brand SOUND EFFECTS for the Remotion quiz video via the
ElevenLabs Sound-Effects endpoint (/v1/sound-generation). Writes mp3s into the
Remotion public sfx folder so staticFile() can load them. Key is read ONLY from
env or the gitignored ./.env (never printed). Run:
    python3 gen_sfx.py
"""
import json
import os
import sys
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.abspath(os.path.join(HERE, "..", "remotion", "public", "audio", "sfx"))
API = "https://api.elevenlabs.io/v1/sound-generation"

# name, prompt, duration_seconds
SFX = [
    ("sfx-reveal-ding",
     "A bright cheerful correct-answer success chime for a kids game show. Short sparkly positive "
     "ding, uplifting and clean, single hit, no music bed.", 0.7),
    ("sfx-whoosh-enter",
     "A quick bright energetic whoosh transition for a game show intro. Fast punchy air swoosh, "
     "clean, single sweep.", 0.6),
    ("sfx-whoosh-reveal",
     "A short rising whoosh swoosh that leads into a reveal. Quick upward air sweep, bright, clean, "
     "single sweep.", 0.5),
    ("sfx-whoosh-advance",
     "A quick snappy page-turn advance whoosh moving forward. Short bright swoosh, clean, single "
     "sweep.", 0.5),
    ("sfx-sting-score",
     "A short rising triumphant musical sting building up to a results screen. Bright brassy "
     "game-show flourish, quick, clean.", 0.9),
    ("sfx-sting-outro",
     "A short celebratory game-show fanfare sting. Bright triumphant brassy flourish, quick and "
     "clean.", 1.0),
]


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
        print("ERROR: ELEVENLABS_API_KEY not set (env or ./.env)", file=sys.stderr)
        sys.exit(2)
    return k


def gen(key, text, dur):
    body = json.dumps({"text": text, "duration_seconds": dur, "prompt_influence": 0.4}).encode()
    req = urllib.request.Request(API + "?output_format=mp3_44100_128", data=body, method="POST")
    req.add_header("xi-api-key", key)
    req.add_header("Content-Type", "application/json")
    req.add_header("Accept", "audio/mpeg")
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def main():
    key = get_key()
    os.makedirs(OUT, exist_ok=True)
    ok = 0
    for name, text, dur in SFX:
        st, raw = gen(key, text, dur)
        if st != 200 or not raw or raw[:3] == b"{" + b'"e':
            print(f"[sfx] {name}: HTTP {st}  {raw[:200]!r}")
            continue
        path = os.path.join(OUT, name + ".mp3")
        with open(path, "wb") as fh:
            fh.write(raw)
        print(f"[sfx] {name}: {len(raw)} bytes -> {path}")
        ok += 1
    print(f"[sfx] generated {ok}/{len(SFX)}")
    if ok != len(SFX):
        sys.exit(1)


if __name__ == "__main__":
    main()
