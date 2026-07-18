#!/usr/bin/env python3
"""
Captions pipeline (audio NOT altered except the two NEW outro variants):
  1. Regenerate the two platform outro VO variants with the cloned voice:
       outro-youtube.mp3  -> "...subscribe for more!"
       outro-follow.mp3   -> "...follow for more!"
     (backs up the current outro.mp3 -> outro-followsubscribe.bak.mp3), and copies
     the new clips into the Remotion public/ folder.
  2. Forced-align EVERY narration clip to its transcript via the ElevenLabs
     Forced Alignment API (POST /v1/forced-alignment) to get exact WORD timings
     without regenerating/altering the existing audio.
  3. Write per-clip word timings -> remotion/src/data/captions.json and refresh
     remotion/src/data/durations.json (adds outro-youtube / outro-follow).
Key read from env/.env; never printed.
"""
import json
import os
import re
import subprocess
import sys
import shutil
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

# New platform outro scripts (only the ending changes).
OUTRO_VARIANTS = {
    "outro-youtube": "[cheerful] So, how did you do? Comment your score below, and subscribe for more!",
    "outro-follow": "[cheerful] So, how did you do? Comment your score below, and follow for more!",
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
        print("ERROR: no ELEVENLABS_API_KEY")
        sys.exit(2)
    return k


def strip_tags(t):
    """Remove non-spoken v3 audio tags like [cheerful] and collapse whitespace."""
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
    """POST /v1/forced-alignment (multipart) -> word timings for the transcript."""
    boundary = uuid.uuid4().hex
    with open(audio_path, "rb") as fh:
        audio = fh.read()
    parts = []
    parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"text\"\r\n\r\n{text}\r\n".encode())
    parts.append(
        (f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; "
         f"filename=\"{os.path.basename(audio_path)}\"\r\nContent-Type: audio/mpeg\r\n\r\n").encode()
        + audio + b"\r\n"
    )
    parts.append(f"--{boundary}--\r\n".encode())
    body = b"".join(parts)
    req = urllib.request.Request(f"{API}/v1/forced-alignment", data=body, method="POST")
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
        if not txt or not _WORDY.search(txt):
            continue  # drop pure-punctuation / whitespace tokens
        out.append({"w": txt, "s": round(float(w["start"]), 3), "e": round(float(w["end"]), 3)})
    return out


def main():
    key = get_key()
    idx = json.load(open(IDX))
    voice = idx["voice_id"]

    # 1) regenerate the two outro variants + back up the current outro.mp3
    bak = os.path.join(NARR, "outro-followsubscribe.bak.mp3")
    cur_outro = os.path.join(NARR, "outro.mp3")
    if os.path.exists(cur_outro) and not os.path.exists(bak):
        shutil.copyfile(cur_outro, bak)
        print(f"[outro] backed up outro.mp3 -> {os.path.basename(bak)}")
    for name, text in OUTRO_VARIANTS.items():
        data = tts(key, voice, text)
        mp3 = os.path.join(NARR, f"{name}.mp3")
        with open(mp3, "wb") as fh:
            fh.write(data)
        shutil.copyfile(mp3, os.path.join(PUBLIC_NARR, f"{name}.mp3"))
        print(f"[outro] {name}: {dur(mp3):.2f}s (voice {voice})")

    # 2) build the clip -> transcript map (all existing beats except old outro, + variants)
    clips = {}
    for b in idx["beats"]:
        if b["beat"] == "outro":
            continue
        clips[b["beat"]] = b["text"]
    clips.update(OUTRO_VARIANTS)

    # 3) forced-align every clip
    captions = {}
    durations = json.load(open(DURS_OUT)) if os.path.exists(DURS_OUT) else {}
    for kkey, raw in clips.items():
        mp3 = os.path.join(NARR, f"{kkey}.mp3")
        if not os.path.exists(mp3):
            print(f"[align] {kkey}: MISSING {mp3}")
            sys.exit(1)
        text = strip_tags(raw)
        try:
            resp = force_align(key, mp3, text)
        except urllib.error.HTTPError as e:
            print(f"[align] {kkey}: HTTP {e.code} {e.read()[:200]!r}")
            sys.exit(1)
        words = clean_words(resp)
        captions[kkey] = {"text": text, "words": words}
        durations[kkey] = round(dur(mp3), 3)
        print(f"[align] {kkey:14s} {len(words):3d} words, {words[0]['s'] if words else 0:.2f}-{words[-1]['e'] if words else 0:.2f}s")

    with open(CAPS_OUT, "w") as fh:
        json.dump(captions, fh, indent=1, sort_keys=True)
    with open(DURS_OUT, "w") as fh:
        json.dump(durations, fh, indent=2, sort_keys=True)
    print(f"[done] captions -> {CAPS_OUT} ({len(captions)} clips)")
    print(f"[done] durations -> {DURS_OUT}")


if __name__ == "__main__":
    main()
