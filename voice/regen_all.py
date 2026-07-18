#!/usr/bin/env python3
"""
PART 2: regenerate EVERY narration beat with the NEW cloned voice on the new key,
using the EXACT current scripts from narration_index.json (wording unchanged).
Overwrites narration/*.mp3 (already backed up to _oldaccount_bak/), updates the
index (voice_id + per-beat durations), and writes the Remotion timeline duration
map (src/data/durations.json) so the whole timeline re-times to the new clips.
Key read from env/.env; never printed.
"""
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
API = "https://api.elevenlabs.io"
NARR = os.path.join(HERE, "narration")
IDX = os.path.join(NARR, "narration_index.json")
DURS_OUT = os.path.abspath(os.path.join(HERE, "..", "remotion", "src", "data", "durations.json"))
FP = "/opt/homebrew/bin/ffprobe"
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
        print("ERROR: no key")
        sys.exit(2)
    return k


def strip_tags(t):
    return re.sub(r"\s+", " ", re.sub(r"\[[^\]]+\]", "", t)).strip()


def tts(key, voice, text, model):
    send = text if model == "eleven_v3" else strip_tags(text)
    vs = VS_V3 if model == "eleven_v3" else VS_V2
    body = json.dumps({"text": send, "model_id": model, "voice_settings": vs}).encode()
    req = urllib.request.Request(f"{API}/v1/text-to-speech/{voice}?output_format=mp3_44100_128", data=body, method="POST")
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


def dur(path):
    return float(subprocess.run([FP, "-v", "error", "-show_entries", "format=duration", "-of", "default=nk=1:nw=1", path], capture_output=True, text=True).stdout.strip())


def main():
    key = get_key()
    vid = open("/tmp/new_voice_id.txt").read().strip()
    idx = json.load(open(IDX))
    beats = idx["beats"]
    model = "eleven_v3"
    durations = {}
    ok, fails = 0, []
    for b in beats:
        beat, text = b["beat"], b["text"]
        succ, res = tts(key, vid, text, model)
        if not succ and model == "eleven_v3" and ok == 0:
            print(f"[regen] eleven_v3 rejected ({res}); falling back to eleven_multilingual_v2")
            model = "eleven_multilingual_v2"
            succ, res = tts(key, vid, text, model)
        if not succ:
            print(f"[regen] {beat}: FAIL {res}")
            fails.append(beat)
            continue
        mp3 = os.path.join(NARR, f"{beat}.mp3")
        with open(mp3, "wb") as fh:
            fh.write(res)
        d = round(dur(mp3), 3)
        b["dur_s"] = d
        durations[beat] = d
        ok += 1
        print(f"[regen] {beat:8s} {d:6.2f}s")

    idx["voice_id"] = vid
    idx["model"] = model
    json.dump(idx, open(IDX, "w"), indent=2)
    with open(DURS_OUT, "w") as fh:
        json.dump(durations, fh, indent=2, sort_keys=True)
    print(f"[regen] {ok}/{len(beats)} regenerated with voice {vid} (model {model})")
    print(f"[regen] durations -> {DURS_OUT}")
    if fails:
        print(f"[regen] FAILS: {fails}")
        sys.exit(1)


if __name__ == "__main__":
    main()
