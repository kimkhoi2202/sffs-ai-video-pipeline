#!/usr/bin/env python3
"""
tts_batch.py — synthesize a batch of narration beats with the cloned host voice
for the mass-gen render pipeline. Reads a beats JSON ([{"beat","text"}, ...],
produced by content/gen-narration-scripts.mjs), writes <out-dir>/<beat>.mp3 for
each, measures each duration with ffprobe, and writes <out-dir>/durations.json
({beat: seconds}).

Only the per-round q/r beats are generated here; the round-agnostic meta beats
(intro/timesup/score/outro-*) are already committed under
remotion/public/audio/narration/ and reused as-is.

SECURITY: the ElevenLabs API key is read ONLY from env ELEVENLABS_API_KEY or the
gitignored voice/.env. It is never printed, logged, or placed on the command line.

Usage:
  python3 voice/tts_batch.py --beats beats.json --voice-id lZcmpVLaoXF4v0uz4l6Q \
      --out-dir remotion/public/audio/rounds/round-002 [--model eleven_v3] [--skip-existing]
"""
import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request

API = "https://api.elevenlabs.io"
HERE = os.path.dirname(os.path.abspath(__file__))
FP = os.environ.get("FFPROBE", "/opt/homebrew/bin/ffprobe")
VS_V3 = {"stability": 0.5, "similarity_boost": 0.85, "use_speaker_boost": True}
VS_V2 = {"stability": 0.45, "similarity_boost": 0.85, "style": 0.4, "use_speaker_boost": True}


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
        print("ERROR: ELEVENLABS_API_KEY not set (env or voice/.env)", file=sys.stderr)
        sys.exit(2)
    return k


def strip_tags(t):
    return re.sub(r"\s+", " ", re.sub(r"\[[^\]]+\]", "", t)).strip()


def tts(key, voice, text, model):
    send = text if model == "eleven_v3" else strip_tags(text)
    vs = VS_V3 if model == "eleven_v3" else VS_V2
    body = json.dumps({"text": send, "model_id": model, "voice_settings": vs}).encode()
    req = urllib.request.Request(
        f"{API}/v1/text-to-speech/{voice}?output_format=mp3_44100_128", data=body, method="POST"
    )
    req.add_header("xi-api-key", key)
    req.add_header("Content-Type", "application/json")
    req.add_header("Accept", "audio/mpeg")
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            ctype = r.headers.get("Content-Type", "")
            data = r.read()
        if "audio" in ctype and len(data) > 1500:
            return True, data
        return False, f"non-audio({ctype})"
    except urllib.error.HTTPError as e:
        return False, f"HTTP {e.code}"
    except Exception as e:
        return False, str(e)[:80]


def tts_retry(key, voice, text, model, tries=3):
    res = "no attempt"
    for i in range(tries):
        succ, res = tts(key, voice, text, model)
        if succ:
            return True, res
        time.sleep(1.5 * (i + 1))  # backoff on transient API slowness/blips
    return False, res


def dur(path):
    out = subprocess.run(
        [FP, "-v", "error", "-show_entries", "format=duration", "-of", "default=nk=1:nw=1", path],
        capture_output=True, text=True,
    ).stdout.strip()
    return round(float(out), 3)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--beats", required=True)
    ap.add_argument("--voice-id", required=True, dest="voice_id")
    ap.add_argument("--out-dir", required=True, dest="out_dir")
    ap.add_argument("--model", default="eleven_v3")
    ap.add_argument("--skip-existing", action="store_true")
    args = ap.parse_args()

    key = get_key()
    beats = json.load(open(args.beats))
    os.makedirs(args.out_dir, exist_ok=True)
    durs_path = os.path.join(args.out_dir, "durations.json")
    durations = {}
    if os.path.exists(durs_path):
        durations = json.load(open(durs_path))

    model = args.model
    ok, fails = 0, []
    for b in beats:
        beat, text = b["beat"], b["text"]
        mp3 = os.path.join(args.out_dir, f"{beat}.mp3")
        if args.skip_existing and os.path.exists(mp3) and durations.get(beat):
            print(f"[tts] {beat:5s} skip (exists {durations[beat]:.2f}s)")
            ok += 1
            continue
        succ, res = tts_retry(key, args.voice_id, text, model)
        if not succ and model == "eleven_v3" and ok == 0:
            print(f"[tts] eleven_v3 rejected ({res}); falling back to eleven_multilingual_v2")
            model = "eleven_multilingual_v2"
            succ, res = tts_retry(key, args.voice_id, text, model)
        if not succ:
            print(f"[tts] {beat}: FAIL {res}")
            fails.append(beat)
            continue
        with open(mp3, "wb") as fh:
            fh.write(res)
        d = dur(mp3)
        durations[beat] = d
        ok += 1
        print(f"[tts] {beat:5s} {d:6.2f}s  ({len(text)} chars)")
        json.dump(durations, open(durs_path, "w"), indent=2, sort_keys=True)
        time.sleep(0.1)  # be gentle on the API

    json.dump(durations, open(durs_path, "w"), indent=2, sort_keys=True)
    print(f"[tts] {ok}/{len(beats)} beats -> {args.out_dir} (model {model})")
    if fails:
        print(f"[tts] FAILS: {fails}")
        sys.exit(1)


if __name__ == "__main__":
    main()
