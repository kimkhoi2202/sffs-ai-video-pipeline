#!/usr/bin/env python3
"""
PART 1: Clone the "Booming Ringmaster" voice into the NEW ElevenLabs account.

Reads NEW (ELEVENLABS_API_KEY) + OLD (OLD_ELEVENLABS_API_KEY) from ./.env or env.
Keys are used ONLY in the xi-api-key header; their values are NEVER printed. Only
safe info is printed (reference source, statuses, the new voice_id, durations).

Steps: pull clean reference audio via TTS from the OLD account's old voice (or
fall back to saved local samples if the old key is dead) -> POST /v1/voices/add
on the NEW account -> generate a short sanity clip with the clone.
"""
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
API = "https://api.elevenlabs.io"
OLD_VOICE = "UZLl5VadyJ8aGgjUQQ4C"
TMP = "/tmp/clone_ref"
FP = "/opt/homebrew/bin/ffprobe"
VS = {"stability": 0.5, "similarity_boost": 0.85, "use_speaker_boost": True}

REF_LINES = [
    "Welcome back to the ultimate brain showdown! Fifteen brand new reasoning puzzles, all sized up for grade five. Thinking caps on, let's play!",
    "Question one! Which one does not belong? Robin, sparrow, salmon, or eagle? Five seconds on the clock, go!",
    "Time's up! Pencils down, brainiacs! And the answer is salmon. A robin, a sparrow, and an eagle all soar through the sky, but a salmon? That one swims!",
    "So, are you smart or fart? Thirteen or more out of fifteen? Take a bow, you are a certified smart fella!",
    "Comment your score below, and follow or subscribe for more brain bending fun. See you next round!",
]


def read_env():
    new = os.environ.get("ELEVENLABS_API_KEY")
    old = os.environ.get("OLD_ELEVENLABS_API_KEY")
    envp = os.path.join(HERE, ".env")
    if os.path.exists(envp):
        for line in open(envp):
            line = line.strip()
            if line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            k = k.strip()
            v = v.strip().strip('"').strip("'")
            if k == "ELEVENLABS_API_KEY" and not new:
                new = v
            elif k == "OLD_ELEVENLABS_API_KEY" and not old:
                old = v
    return new, old


def key_status(key):
    req = urllib.request.Request(f"{API}/v1/user", method="GET")
    req.add_header("xi-api-key", key)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code
    except Exception:
        return 0


def tts(key, voice, text, out, model="eleven_v3"):
    body = json.dumps({"text": text, "model_id": model, "voice_settings": VS}).encode()
    req = urllib.request.Request(f"{API}/v1/text-to-speech/{voice}?output_format=mp3_44100_128", data=body, method="POST")
    req.add_header("xi-api-key", key)
    req.add_header("Content-Type", "application/json")
    req.add_header("Accept", "audio/mpeg")
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            ctype = r.headers.get("Content-Type", "")
            data = r.read()
        if "audio" in ctype and len(data) > 1500:
            with open(out, "wb") as fh:
                fh.write(data)
            return True, len(data)
        return False, f"non-audio ({ctype})"
    except urllib.error.HTTPError as e:
        return False, f"HTTP {e.code}"
    except Exception as e:
        return False, str(e)[:80]


def add_voice(key, name, files):
    boundary = "----clone" + uuid.uuid4().hex
    out = []

    def field(n, v):
        out.append((f"--{boundary}\r\nContent-Disposition: form-data; name=\"{n}\"\r\n\r\n{v}\r\n").encode())

    field("name", name)
    for fp in files:
        fn = os.path.basename(fp)
        out.append((f"--{boundary}\r\nContent-Disposition: form-data; name=\"files\"; filename=\"{fn}\"\r\nContent-Type: audio/mpeg\r\n\r\n").encode())
        with open(fp, "rb") as fh:
            out.append(fh.read())
        out.append(b"\r\n")
    out.append((f"--{boundary}--\r\n").encode())
    data = b"".join(out)
    req = urllib.request.Request(f"{API}/v1/voices/add", data=data, method="POST")
    req.add_header("xi-api-key", key)
    req.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        try:
            j = json.loads(e.read())
            msg = json.dumps(j)[:300]
        except Exception:
            msg = "(unreadable error body)"
        return e.code, {"_err": msg}


def dur(path):
    return subprocess.run([FP, "-v", "error", "-show_entries", "format=duration", "-of", "default=nk=1:nw=1", path], capture_output=True, text=True).stdout.strip()


def main():
    new, old = read_env()
    if not new:
        print("ERROR: NEW ELEVENLABS_API_KEY not found")
        sys.exit(2)
    os.makedirs(TMP, exist_ok=True)

    files = []
    source = None
    old_st = key_status(old) if old else "absent"
    print(f"[clone] old key status: {old_st}")
    if old and old_st == 200:
        for i, line in enumerate(REF_LINES):
            ok, info = tts(old, OLD_VOICE, line, f"{TMP}/ref_{i}.mp3")
            if ok:
                files.append(f"{TMP}/ref_{i}.mp3")
        if files:
            source = "old-key TTS pull (exact voice)"
    if not files:
        source = "saved local sample fallback"
        cands = [os.path.join(HERE, "previews", "a-ringmaster_3.mp3")]
        sdir = os.path.join(HERE, "samples")
        cands += [os.path.join(sdir, f) for f in sorted(os.listdir(sdir)) if f.endswith(".mp3") and not f.startswith("00-")]
        files = [c for c in cands if os.path.exists(c)]

    print(f"[clone] reference source: {source} ({len(files)} files)")
    if not files:
        print("ERROR: no reference audio available")
        sys.exit(1)

    st, resp = add_voice(new, "Smart Fella Host (Booming Ringmaster)", files)
    if st != 200 or "voice_id" not in resp:
        print(f"[clone] voices/add FAILED HTTP {st}: {resp.get('_err', '')}")
        sys.exit(1)
    vid = resp["voice_id"]
    print(f"[clone] created NEW voice_id: {vid}")

    ok, info = tts(new, vid, "Smart fella or fart smella!", f"{TMP}/sanity.mp3")
    if ok:
        print(f"[clone] sanity clip OK: {info} bytes, {dur(TMP + '/sanity.mp3')}s -> {TMP}/sanity.mp3")
        with open("/tmp/new_voice_id.txt", "w") as fh:
            fh.write(vid)
        print("[clone] SUCCESS")
    else:
        print(f"[clone] sanity clip FAILED: {info} -- STOP, review before regenerating")
        sys.exit(3)


if __name__ == "__main__":
    main()
