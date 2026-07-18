#!/usr/bin/env python3
"""
ElevenLabs Voice Design V3 pipeline for the "Smart Fella or Fart Smella" Kid Loop.

Subcommands:
  check    - report account tier, character + voice-slot limits, and which TTS models are usable
  design   - POST /v1/text-to-voice/design (model eleven_ttv_v3) for N voice_description VARIANTS,
             save every preview mp3 to previews/ and write previews/index.json (no audio/base64, no key)
  save     - POST /v1/text-to-voice to persist a chosen preview -> permanent voice_id
  samples  - POST /v1/text-to-speech/<voice_id> for the in-context narration sample lines,
             preferring eleven_v3 and falling back to eleven_multilingual_v2

SECURITY: the API key is read ONLY from env var ELEVENLABS_API_KEY (or the gitignored .env next to
this file). It is never printed, logged, or placed on the command line. Run as:
    set -a; . ./.env; set +a; python3 voice_pipeline.py <cmd> ...
"""
import argparse
import base64
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
import wave

API = "https://api.elevenlabs.io"
HERE = os.path.dirname(os.path.abspath(__file__))
PREVIEW_DIR = os.path.join(HERE, "previews")
SAMPLE_DIR = os.path.join(HERE, "samples")
NARRATION_DIR = os.path.join(HERE, "narration")           # persistent per-beat mp3s
TOOLS_DIR = os.path.abspath(os.path.join(HERE, "..", "tools"))
PREVIEW_OUTPUT_FORMAT = "mp3_44100_128"
FF = "/opt/homebrew/bin/ffmpeg"
FP = "/opt/homebrew/bin/ffprobe"
VO_AR = 48000                                             # pipeline audio rate

# ---------------------------------------------------------------------------
# Voice design: three on-brand host descriptions (V3 best practice = detailed,
# multi-attribute prompt: age / accent / timbre / delivery / character / recording
# quality) paired with a tuned guidance_scale. Detailed prompt -> lower guidance.
# ---------------------------------------------------------------------------
VARIANTS = [
    {
        "slug": "a-ringmaster",
        "name": "A — Booming Ringmaster",
        "guidance_scale": 4.0,
        "description": (
            "A charismatic, high-energy American game-show host in his late thirties, MCing a "
            "comedic kids-and-family brain quiz. Warm, booming, resonant chest voice with big "
            "theatrical prime-time-announcer energy, like a spotlight-and-confetti ringmaster. "
            "Bright, punchy, crisp diction; leans in to tease a question, then erupts with delight "
            "on the reveal. Playful and a little cheeky, never mean; huge dynamic range, bouncy "
            "rhythm, always building excitement. Clean, close-mic studio sound, no background "
            "noise. Neutral American accent."
        ),
    },
    {
        "slug": "b-cheeky-rascal",
        "name": "B — Cheeky Rascal",
        "guidance_scale": 3.0,
        "description": (
            "A fast-talking, mischievous American game-show host, gender-neutral-leaning, sounds "
            "early thirties, hosting a silly kids-and-family brain quiz. Bright, bouncy and cheeky "
            "with a wink in every line: warm and encouraging but full of playful comedic energy. "
            "Snappy, punchy delivery with quick pacing, exaggerated build-ups and gleeful reveals, "
            "lots of dynamic range. Fun cartoon-quiz-master vibe, all-ages and kid-safe, never "
            "sarcastic at the player's expense. Crisp, clean studio recording, no background "
            "noise. Neutral American accent."
        ),
    },
    {
        "slug": "c-warm-hype",
        "name": "C — Warm Hype Host",
        "guidance_scale": 5.0,
        "description": (
            "A warm, charismatic American game-show host in their thirties for a family "
            "brain-quiz show: big, friendly and high-energy. A booming yet welcoming voice with "
            "theatrical announcer flair: crisp, punchy consonants, confident delivery, and an "
            "infectious build of excitement toward each answer. Playful and a touch cheeky, "
            "genuinely rooting for the player; celebrates wins, never mocks. Wide dynamic range "
            "from a conspiratorial hush to a triumphant shout. Pristine studio sound, no noise. "
            "Neutral American accent, all-ages friendly."
        ),
    },
]

# Preview line auditioned for every variant (kept identical so variants compare fairly).
# Must be 100-1000 chars. Kid-safe, original, uses the real Q1 from the 15-question video.
PREVIEW_TEXT = (
    "[excited] Are you a SMART fella... or a FART smella? Let's find OUT! Fifteen questions, quick "
    "minds only, here we go! Question one: which one does NOT belong? Robin, sparrow, salmon, or "
    "eagle? You've got five seconds... five, four, three, two, one, [gasp] time's UP! And the "
    "answer is... SALMON! Robin, sparrow, and eagle all fly, but a salmon swims. [laughs] Nice "
    "work, big brain, grab a grown-up, and let's keep this quiz rolling!"
)

# In-context narration samples (kid-safe, original, drawn from the real 15-question round).
# Tags like [excited] work in eleven_v3; they are stripped automatically for the v2 fallback.
SAMPLES = [
    ("01-intro",
     "[excited] Are you a SMART fella... or a FART smella? Let's find OUT! Fifteen questions, "
     "quick minds only, here we go!"),
    ("02-question-q1",
     "[excited] Question one! Which one does NOT belong? Robin... sparrow... salmon... or eagle? "
     "[whispers] Five seconds on the clock... [excited] and, GO!"),
    ("03-timesup",
     "Three... two... one... [excited] TIME'S UP! Pencils down, brainiacs!"),
    ("04-reveal-q1",
     "[gasp] And the answer is... SALMON! Robin, sparrow, and eagle all fly, but a salmon swims. "
     "[laughs] If you got it, give yourself a point!"),
    ("05-hard-q14",
     "[curious] Ooh, this one is a BRAIN-BENDER. Two makes eight, three makes twenty-seven, four "
     "makes sixty-four... so what does FIVE make? [whispers] Think in cubes..."),
    ("06-outro-cta",
     "[excited] Add 'em up, are you a certified SMART fella? Want your full brain score and a shot "
     "at the prizes? Grab a grown-up and have them pop their email in on screen, and we'll unlock "
     "it. See you next round!"),
]


def get_key():
    k = os.environ.get("ELEVENLABS_API_KEY")
    if not k:
        envp = os.path.join(HERE, ".env")
        if os.path.exists(envp):
            with open(envp) as fh:
                for line in fh:
                    line = line.strip()
                    if line.startswith("ELEVENLABS_API_KEY=") and not line.startswith("#"):
                        k = line.split("=", 1)[1].strip().strip('"').strip("'")
                        break
    if not k:
        print("ERROR: ELEVENLABS_API_KEY not set (env or ./.env)", file=sys.stderr)
        sys.exit(2)
    return k


def http(method, path, key, query=None, body=None, timeout=300):
    url = API + path
    if query:
        url += "?" + urllib.parse.urlencode(query)
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(url, data=data, method=method)
    r.add_header("xi-api-key", key)
    r.add_header("Accept", "application/json")
    if data is not None:
        r.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            return resp.status, resp.headers.get("Content-Type", ""), resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.headers.get("Content-Type", ""), e.read()
    except urllib.error.URLError as e:
        return 0, "", str(e.reason).encode()


def _err(raw):
    """Decode an error body for display. Never contains the key."""
    try:
        return json.dumps(json.loads(raw), indent=2)[:1200]
    except Exception:
        return raw.decode("utf-8", "replace")[:1200]


def cmd_check(key, args):
    st, _, raw = http("GET", "/v1/user/subscription", key)
    print(f"[subscription] HTTP {st}")
    if st == 200:
        s = json.loads(raw)
        print(f"  tier                : {s.get('tier')}")
        print(f"  characters          : {s.get('character_count')} / {s.get('character_limit')}")
        print(f"  voice slots         : {s.get('voice_slots_used', '?')} / {s.get('voice_limit', '?')}")
        print(f"  pro voice slots     : {s.get('professional_voice_slots_used', '?')} / {s.get('professional_voice_limit', '?')}")
        print(f"  can extend voices   : {s.get('can_extend_voice_limit')}")
        print(f"  can use v3 (alpha?) : {s.get('can_use_delayed_payment_methods', 'n/a')}")
    else:
        print("  " + _err(raw))

    st, _, raw = http("GET", "/v1/voices", key)
    if st == 200:
        v = json.loads(raw).get("voices", [])
        print(f"[voices] HTTP {st} | {len(v)} voice(s) in library")
        for x in v[:40]:
            print(f"    - {x.get('name')}  ({x.get('voice_id')})  [{x.get('category')}]")
    else:
        print(f"[voices] HTTP {st}\n  " + _err(raw))

    st, _, raw = http("GET", "/v1/models", key)
    if st == 200:
        models = json.loads(raw)
        print(f"[models] HTTP {st}")
        want = {"eleven_v3", "eleven_ttv_v3", "eleven_multilingual_v2"}
        for m in models:
            mid = m.get("model_id")
            can_tts = m.get("can_do_text_to_speech")
            if mid in want or can_tts:
                flag = "  <-- target" if mid in want else ""
                print(f"    - {mid:32} tts={can_tts}{flag}")
    else:
        print(f"[models] HTTP {st}\n  " + _err(raw))


def cmd_design(key, args):
    os.makedirs(PREVIEW_DIR, exist_ok=True)
    index = []
    for v in VARIANTS:
        body = {
            "voice_description": v["description"],
            "model_id": "eleven_ttv_v3",
            "text": PREVIEW_TEXT,
            "guidance_scale": v["guidance_scale"],
            "loudness": 0.5,
        }
        st, _, raw = http("POST", "/v1/text-to-voice/design", key,
                          query={"output_format": PREVIEW_OUTPUT_FORMAT}, body=body)
        if st != 200:
            print(f"[design] {v['name']} -> HTTP {st}\n  " + _err(raw))
            continue
        j = json.loads(raw)
        previews = j.get("previews", [])
        print(f"[design] {v['name']} (guidance={v['guidance_scale']}) -> {len(previews)} preview(s)")
        for i, p in enumerate(previews, 1):
            fn = os.path.join(PREVIEW_DIR, f"{v['slug']}_{i}.mp3")
            with open(fn, "wb") as fh:
                fh.write(base64.b64decode(p["audio_base_64"]))
            rec = {
                "variant": v["name"],
                "slug": v["slug"],
                "guidance_scale": v["guidance_scale"],
                "preview_index": i,
                "file": os.path.relpath(fn, HERE),
                "generated_voice_id": p["generated_voice_id"],
                "duration_secs": p.get("duration_secs"),
                "language": p.get("language"),
            }
            index.append(rec)
            print(f"    #{i}  gvid={p['generated_voice_id']}  {p.get('duration_secs')}s  -> {rec['file']}")
    out = {
        "model_id": "eleven_ttv_v3",
        "output_format": PREVIEW_OUTPUT_FORMAT,
        "preview_text": PREVIEW_TEXT,
        "variants": [{k: v[k] for k in ("slug", "name", "guidance_scale", "description")} for v in VARIANTS],
        "previews": index,
    }
    with open(os.path.join(PREVIEW_DIR, "index.json"), "w") as fh:
        json.dump(out, fh, indent=2)
    print(f"[design] wrote {len(index)} preview(s); index -> previews/index.json")


def cmd_save(key, args):
    body = {
        "voice_name": args.name,
        "voice_description": args.description,
        "generated_voice_id": args.gvid,
    }
    st, _, raw = http("POST", "/v1/text-to-voice", key, body=body)
    if st != 200:
        print(f"[save] HTTP {st}\n  " + _err(raw))
        sys.exit(1)
    j = json.loads(raw)
    vid = j.get("voice_id")
    print(f"[save] SAVED '{args.name}' -> voice_id={vid}")
    ledger = os.path.join(HERE, "voice_saved.json")
    data = []
    if os.path.exists(ledger):
        data = json.load(open(ledger))
    data.append({"voice_name": args.name, "voice_id": vid,
                 "generated_voice_id": args.gvid, "voice_description": args.description})
    with open(ledger, "w") as fh:
        json.dump(data, fh, indent=2)
    print(f"[save] appended to voice_saved.json")


def _strip_tags(t):
    return re.sub(r"\s+", " ", re.sub(r"\[[^\]]+\]", "", t)).strip()


def cmd_samples(key, args):
    os.makedirs(SAMPLE_DIR, exist_ok=True)
    model = args.model
    for slug, text in SAMPLES:
        use_text = text if model == "eleven_v3" else _strip_tags(text)
        vs = ({"stability": 0.5, "similarity_boost": 0.85, "use_speaker_boost": True}
              if model == "eleven_v3"
              else {"stability": 0.4, "similarity_boost": 0.85, "style": 0.45, "use_speaker_boost": True})
        body = {"text": use_text, "model_id": model, "voice_settings": vs}
        st, ctype, raw = http("POST", f"/v1/text-to-speech/{args.voice_id}", key,
                              query={"output_format": PREVIEW_OUTPUT_FORMAT}, body=body)
        # First clip: if the preferred model is rejected, fall back once and retry the whole set.
        if st != 200 and model == "eleven_v3" and slug == SAMPLES[0][0]:
            print(f"[samples] eleven_v3 rejected (HTTP {st}): {_err(raw)[:200]}")
            print("[samples] falling back to eleven_multilingual_v2 (tags stripped)")
            model = "eleven_multilingual_v2"
            use_text = _strip_tags(text)
            vs = {"stability": 0.4, "similarity_boost": 0.85, "style": 0.45, "use_speaker_boost": True}
            body = {"text": use_text, "model_id": model, "voice_settings": vs}
            st, ctype, raw = http("POST", f"/v1/text-to-speech/{args.voice_id}", key,
                                  query={"output_format": PREVIEW_OUTPUT_FORMAT}, body=body)
        if st != 200 or "audio" not in ctype:
            print(f"[samples] {slug} -> HTTP {st} ({ctype})\n  " + _err(raw))
            continue
        fn = os.path.join(SAMPLE_DIR, f"{slug}.mp3")
        with open(fn, "wb") as fh:
            fh.write(raw)
        print(f"[samples] {slug}: {len(raw)} bytes -> {os.path.relpath(fn, HERE)}  (model={model})")
    print(f"[samples] done (model used: {model})")


def _v3_narration_text(key, style, line):
    """Adapt a flagship NARR beat (from render_cogat_round_15.py) for eleven_v3:
    keep the SPOKEN WORDS identical (so on-screen visuals stay in sync) but drop
    the Gemini style prefix and add V3 audio tags + a reveal drumroll ellipsis,
    matching the game-show dynamic range of the approved phase-1 samples."""
    if key == "timesup":
        return "[excited] TIME'S UP! Pencils down!"
    body = line
    if key.startswith("r"):  # reveals: add a suspense beat before the answer
        if line.startswith("The answer is "):
            body = "The answer is... " + line[len("The answer is "):]
        elif line.startswith("It's "):
            body = "It's... " + line[len("It's "):]
    if key == "outro":       # parent-email CTA: warm, inviting, natural read
        return body
    return "[excited] " + body


def _wav_dur(path):
    with wave.open(path, "rb") as w:
        return w.getnframes() / float(w.getframerate())


def cmd_narrate(key, args):
    """Generate every flagship narration beat with the saved voice on eleven_v3,
    save a persistent per-beat mp3, and write a pipeline-ready 48k WAV to out-dir
    (named <beat>.wav) so render_cogat_round_15.build re-times to the new clips."""
    sys.path.insert(0, TOOLS_DIR)
    import render_cogat_round_15 as R15  # noqa: E402  (source of the SAME beats)
    narr = R15.NARR
    os.makedirs(args.out_dir, exist_ok=True)
    os.makedirs(NARRATION_DIR, exist_ok=True)
    model = args.model
    manifest, fails, total_chars = [], [], 0
    for k, (style, line) in narr.items():
        text = _v3_narration_text(k, style, line)
        if model != "eleven_v3":
            text = _strip_tags(text)
        total_chars += len(text)
        vs = ({"stability": 0.5, "similarity_boost": 0.85, "use_speaker_boost": True}
              if model == "eleven_v3"
              else {"stability": 0.45, "similarity_boost": 0.85, "style": 0.4, "use_speaker_boost": True})
        body = {"text": text, "model_id": model, "voice_settings": vs}
        st, ctype, raw = http("POST", f"/v1/text-to-speech/{args.voice_id}", key,
                              query={"output_format": PREVIEW_OUTPUT_FORMAT}, body=body)
        if st != 200 and model == "eleven_v3" and k == next(iter(narr)):
            print(f"[narrate] eleven_v3 rejected (HTTP {st}): {_err(raw)[:200]}")
            print("[narrate] falling back to eleven_multilingual_v2 (tags stripped)")
            model = "eleven_multilingual_v2"
            text = _strip_tags(text)
            vs = {"stability": 0.45, "similarity_boost": 0.85, "style": 0.4, "use_speaker_boost": True}
            body = {"text": text, "model_id": model, "voice_settings": vs}
            st, ctype, raw = http("POST", f"/v1/text-to-speech/{args.voice_id}", key,
                                  query={"output_format": PREVIEW_OUTPUT_FORMAT}, body=body)
        if st != 200 or "audio" not in ctype:
            print(f"[narrate] {k}: HTTP {st} ({ctype})\n  " + _err(raw))
            fails.append(k)
            continue
        mp3 = os.path.join(NARRATION_DIR, f"{k}.mp3")
        with open(mp3, "wb") as fh:
            fh.write(raw)
        wav = os.path.join(args.out_dir, f"{k}.wav")
        subprocess.run([FF, "-y", "-loglevel", "error", "-i", mp3,
                        "-ar", str(VO_AR), "-ac", "2", "-c:a", "pcm_s16le", wav],
                       check=True)
        dur = _wav_dur(wav)
        manifest.append({"beat": k, "chars": len(text), "dur_s": round(dur, 3),
                         "mp3": os.path.relpath(mp3, HERE), "wav": wav, "text": text})
        print(f"[narrate] {k:8s} {dur:5.2f}s  {len(text):4d} chars  -> {os.path.relpath(mp3, HERE)}")
    with open(os.path.join(NARRATION_DIR, "narration_index.json"), "w") as fh:
        json.dump({"voice_id": args.voice_id, "model": model,
                   "total_chars": total_chars, "beats": manifest}, fh, indent=2)
    tot = sum(m["dur_s"] for m in manifest)
    print(f"[narrate] {len(manifest)}/{len(narr)} beats  (model={model})  "
          f"~{tot:.1f}s VO total  {total_chars} chars")
    if fails:
        print(f"[narrate] FAILED beats: {fails}")
        sys.exit(1)


def cmd_tts(key, args):
    """Generate ONE beat (arbitrary text) with the saved voice -> persistent mp3
    (narration/<name>.mp3) + pipeline WAV (<wav-dir>/<name>.wav), and update that
    beat's entry in narration_index.json. Used to regenerate a single clip (e.g.
    a shorter intro) without re-running the whole 34-beat narration."""
    os.makedirs(NARRATION_DIR, exist_ok=True)
    os.makedirs(args.wav_dir, exist_ok=True)
    model = args.model
    send = args.text if model == "eleven_v3" else _strip_tags(args.text)
    vs = ({"stability": 0.5, "similarity_boost": 0.85, "use_speaker_boost": True}
          if model == "eleven_v3"
          else {"stability": 0.45, "similarity_boost": 0.85, "style": 0.4, "use_speaker_boost": True})
    body = {"text": send, "model_id": model, "voice_settings": vs}
    st, ctype, raw = http("POST", f"/v1/text-to-speech/{args.voice_id}", key,
                          query={"output_format": PREVIEW_OUTPUT_FORMAT}, body=body)
    if st != 200 or "audio" not in ctype:
        print(f"[tts] HTTP {st} ({ctype})\n  " + _err(raw))
        sys.exit(1)
    mp3 = os.path.join(NARRATION_DIR, f"{args.name}.mp3")
    with open(mp3, "wb") as fh:
        fh.write(raw)
    wav = os.path.join(args.wav_dir, f"{args.name}.wav")
    subprocess.run([FF, "-y", "-loglevel", "error", "-i", mp3,
                    "-ar", str(VO_AR), "-ac", "2", "-c:a", "pcm_s16le", wav], check=True)
    dur = _wav_dur(wav)
    idx = os.path.join(NARRATION_DIR, "narration_index.json")
    if os.path.exists(idx):
        data = json.load(open(idx))
        beats = data.get("beats", [])
        rec = {"beat": args.name, "chars": len(send), "dur_s": round(dur, 3),
               "mp3": os.path.relpath(mp3, HERE), "wav": wav, "text": send}
        for i, b in enumerate(beats):
            if b.get("beat") == args.name:
                beats[i] = rec
                break
        else:
            beats.append(rec)
        data["beats"] = beats
        json.dump(data, open(idx, "w"), indent=2)
    print(f"[tts] {args.name}: {dur:.2f}s  ({len(send)} chars)  model={model}")
    print(f"  text: {send}")
    print(f"  mp3 : {mp3}")
    print(f"  wav : {wav}")


def main():
    ap = argparse.ArgumentParser(description="ElevenLabs Voice Design V3 pipeline")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("check")
    sub.add_parser("design")
    sp = sub.add_parser("save")
    sp.add_argument("--gvid", required=True)
    sp.add_argument("--name", required=True)
    sp.add_argument("--description", required=True)
    ss = sub.add_parser("samples")
    ss.add_argument("--voice-id", required=True, dest="voice_id")
    ss.add_argument("--model", default="eleven_v3")
    sn = sub.add_parser("narrate")
    sn.add_argument("--voice-id", required=True, dest="voice_id")
    sn.add_argument("--model", default="eleven_v3")
    sn.add_argument("--out-dir", default="/tmp/vo_r15", dest="out_dir")
    stx = sub.add_parser("tts")
    stx.add_argument("--voice-id", required=True, dest="voice_id")
    stx.add_argument("--model", default="eleven_v3")
    stx.add_argument("--text", required=True)
    stx.add_argument("--name", required=True)
    stx.add_argument("--wav-dir", default="/tmp/vo_r15", dest="wav_dir")
    args = ap.parse_args()
    key = get_key()
    {"check": cmd_check, "design": cmd_design, "save": cmd_save,
     "samples": cmd_samples, "narrate": cmd_narrate, "tts": cmd_tts}[args.cmd](key, args)


if __name__ == "__main__":
    main()
