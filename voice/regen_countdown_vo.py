#!/usr/bin/env python3
"""
Countdown re-sync: every question is now a uniform 5s answer window, so the few
question VO clips that SAY "Six seconds" / "Seven seconds" must be regenerated to
say "Five seconds" (same script otherwise, same cloned voice). Auto-selects any
beat whose text contains "Six seconds"/"Seven seconds" (q3,7,9,11,12,13,14,15),
TTS-regenerates it, backs up the old take, updates narration_index.json, then
re-forced-aligns ONLY the changed clips and refreshes captions.json +
durations.json. Key read from env/.env; never printed. Run: python3 regen_countdown_vo.py
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
BAK = os.path.join(NARR, "_countdownbak")
PUBLIC_NARR = os.path.abspath(os.path.join(HERE, "..", "remotion", "public", "audio", "narration"))
DATA = os.path.abspath(os.path.join(HERE, "..", "remotion", "src", "data"))
CAPS_OUT = os.path.join(DATA, "captions.json")
DURS_OUT = os.path.join(DATA, "durations.json")
FP = "/opt/homebrew/bin/ffprobe"
VS_V3 = {"stability": 0.5, "similarity_boost": 0.85, "use_speaker_boost": True}
SECONDS_RE = re.compile(r"\b(Six|Seven) seconds\b")


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
        print("ERROR: no ELEVENLABS_API_KEY", file=sys.stderr)
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
        raise RuntimeError("tts returned too little data")
    return data


def force_align(key, audio_path, text):
    boundary = uuid.uuid4().hex
    audio = open(audio_path, "rb").read()
    parts = [
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"text\"\r\n\r\n{text}\r\n".encode(),
        (f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{os.path.basename(audio_path)}\"\r\n"
         f"Content-Type: audio/mpeg\r\n\r\n").encode() + audio + b"\r\n",
        f"--{boundary}--\r\n".encode(),
    ]
    req = urllib.request.Request(f"{API}/v1/forced-alignment", data=b"".join(parts), method="POST")
    req.add_header("xi-api-key", key)
    req.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")
    req.add_header("Accept", "application/json")
    with urllib.request.urlopen(req, timeout=300) as r:
        return json.load(r)


_WORDY = re.compile(r"[A-Za-z0-9]")


def clean_words(resp):
    out = []
    for w in resp.get("words", []):
        txt = (w.get("text") or "").strip()
        if txt and _WORDY.search(txt):
            out.append({"w": txt, "s": round(float(w["start"]), 3), "e": round(float(w["end"]), 3)})
    return out


def main():
    key = get_key()
    idx = json.load(open(IDX))
    voice = idx["voice_id"]
    os.makedirs(BAK, exist_ok=True)
    caps = json.load(open(CAPS_OUT)) if os.path.exists(CAPS_OUT) else {}
    durs = json.load(open(DURS_OUT)) if os.path.exists(DURS_OUT) else {}

    changed = []
    for b in idx["beats"]:
        if not SECONDS_RE.search(b["text"]):
            continue
        beat = b["beat"]
        new_text = SECONDS_RE.sub("Five seconds", b["text"])
        mp3 = os.path.join(NARR, f"{beat}.mp3")
        # back up the old take once
        bak = os.path.join(BAK, f"{beat}.mp3")
        if os.path.exists(mp3) and not os.path.exists(bak):
            shutil.copyfile(mp3, bak)
        data = tts(key, voice, new_text)
        with open(mp3, "wb") as fh:
            fh.write(data)
        shutil.copyfile(mp3, os.path.join(PUBLIC_NARR, f"{beat}.mp3"))
        d = round(dur(mp3), 3)
        b["text"] = new_text
        b["dur_s"] = d
        b["chars"] = len(new_text)
        # re-align the changed clip
        resp = force_align(key, mp3, strip_tags(new_text))
        caps[beat] = {"text": strip_tags(new_text), "words": clean_words(resp)}
        durs[beat] = d
        changed.append((beat, d))
        print(f"[regen] {beat:5s} {d:6.2f}s  -> \"...{new_text[-40:]}\"")

    if not changed:
        print("[regen] no clips referenced 6/7 seconds; nothing to do")
        return
    json.dump(idx, open(IDX, "w"), indent=2)
    json.dump(caps, open(CAPS_OUT, "w"), indent=1, sort_keys=True)
    json.dump(durs, open(DURS_OUT, "w"), indent=2, sort_keys=True)
    print(f"[done] regenerated {len(changed)} clips (voice {voice}); updated index + captions + durations")


if __name__ == "__main__":
    main()
