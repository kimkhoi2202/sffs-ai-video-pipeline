#!/usr/bin/env python3
"""
Regenerate ONLY the score narration with a concise script (cloned voice,
eleven_v3), back up the old long one, copy into the Remotion public/ folder,
re-run forced alignment to refresh the sidecar word timings, and update
durations.json + narration_index.json. Key read from env/.env; never printed.
"""
import json
import os
import re
import shutil
import subprocess
import sys
import uuid
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
API = "https://api.elevenlabs.io"
NARR = os.path.join(HERE, "narration")
IDX = os.path.join(NARR, "narration_index.json")
PUBLIC_NARR = os.path.abspath(os.path.join(HERE, "..", "remotion", "public", "audio", "narration"))
DATA = os.path.abspath(os.path.join(HERE, "..", "remotion", "src", "data"))
CAPS_OUT = os.path.join(DATA, "captions.json")
DURS_OUT = os.path.join(DATA, "durations.json")
FP = "/opt/homebrew/bin/ffprobe"
VS_V3 = {"stability": 0.5, "similarity_boost": 0.85, "use_speaker_boost": True}

SCRIPT = "[cheerful] So, are you smart or fart? Count up your correct answers to find your rank!"


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
        print("ERROR: no ELEVENLABS_API_KEY")
        sys.exit(2)
    return k


def strip_tags(t):
    return re.sub(r"\s+", " ", re.sub(r"\[[^\]]+\]", "", t)).strip()


def dur(path):
    return float(subprocess.run([FP, "-v", "error", "-show_entries", "format=duration",
                                 "-of", "default=nk=1:nw=1", path], capture_output=True, text=True).stdout.strip())


def tts(key, voice, text):
    body = json.dumps({"text": text, "model_id": "eleven_v3", "voice_settings": VS_V3}).encode()
    req = urllib.request.Request(f"{API}/v1/text-to-speech/{voice}?output_format=mp3_44100_128", data=body, method="POST")
    req.add_header("xi-api-key", key)
    req.add_header("Content-Type", "application/json")
    req.add_header("Accept", "audio/mpeg")
    with urllib.request.urlopen(req, timeout=180) as r:
        data = r.read()
    if len(data) < 1500:
        raise RuntimeError("tts too small")
    return data


def force_align(key, audio_path, text):
    boundary = uuid.uuid4().hex
    with open(audio_path, "rb") as fh:
        audio = fh.read()
    body = (
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"text\"\r\n\r\n{text}\r\n".encode()
        + (f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"score.mp3\"\r\n"
           f"Content-Type: audio/mpeg\r\n\r\n").encode()
        + audio + b"\r\n"
        + f"--{boundary}--\r\n".encode()
    )
    req = urllib.request.Request(f"{API}/v1/forced-alignment", data=body, method="POST")
    req.add_header("xi-api-key", key)
    req.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")
    req.add_header("Accept", "application/json")
    with urllib.request.urlopen(req, timeout=300) as r:
        return json.load(r)


def main():
    key = get_key()
    idx = json.load(open(IDX))
    voice = idx["voice_id"]

    score_mp3 = os.path.join(NARR, "score.mp3")
    bak = os.path.join(NARR, "score-longcommentary.bak.mp3")
    if os.path.exists(score_mp3) and not os.path.exists(bak):
        shutil.copyfile(score_mp3, bak)
        print(f"[score] backed up -> {os.path.basename(bak)} ({dur(bak):.2f}s)")

    data = tts(key, voice, SCRIPT)
    with open(score_mp3, "wb") as fh:
        fh.write(data)
    shutil.copyfile(score_mp3, os.path.join(PUBLIC_NARR, "score.mp3"))
    d = round(dur(score_mp3), 3)
    print(f"[score] regenerated: {d:.2f}s (voice {voice})")

    # refresh sidecar word timings
    resp = force_align(key, score_mp3, strip_tags(SCRIPT))
    wordy = re.compile(r"[A-Za-z0-9]")
    words = [{"w": w["text"].strip(), "s": round(float(w["start"]), 3), "e": round(float(w["end"]), 3)}
             for w in resp.get("words", []) if (w.get("text") or "").strip() and wordy.search(w["text"])]
    caps = json.load(open(CAPS_OUT))
    caps["score"] = {"text": strip_tags(SCRIPT), "words": words}
    json.dump(caps, open(CAPS_OUT, "w"), indent=1, sort_keys=True)
    print(f"[score] captions.json score refreshed ({len(words)} words)")

    durs = json.load(open(DURS_OUT))
    durs["score"] = d
    json.dump(durs, open(DURS_OUT, "w"), indent=2, sort_keys=True)

    for b in idx["beats"]:
        if b["beat"] == "score":
            b["text"] = SCRIPT
            b["dur_s"] = d
            b["chars"] = len(SCRIPT)
    json.dump(idx, open(IDX, "w"), indent=2)
    print(f"[score] durations.json + narration_index.json updated -> {d:.2f}s")


if __name__ == "__main__":
    main()
