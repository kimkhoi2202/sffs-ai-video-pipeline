"""SFFS RENDER tool — turn a video plan's render props into an mp4 (DRAFT media).

One tool, ``sffs_render``, wrapping hermes/src/render.ts ``renderVideo`` (+ its
``computeFrames`` for the dry-run frame preview). Given a video ``id`` and the
HermesQuiz render ``props`` (as produced by ``sffs_design`` plan mode), it:

  * synthesizes the cloned-voice narration for the requested A/B arm — full /
    no-question-vo / no-options-vo / none(=music-only) — by reusing the pipeline's
    existing voice/tts_batch.py (via narration.ts). "none" needs no ElevenLabs key;
    the voiced arms need ELEVENLABS_API_KEY (read by tts_batch.py from env /
    voice/.env);
  * renders the SELF-CONTAINED HermesQuiz composition (1080x1920, 30fps) to an mp4
    with the Remotion CLI (reusing remotion/ node_modules + the ensured headless
    Chromium + ffmpeg). Idempotent: an existing non-trivial render is reused unless
    ``force=true``.

render.ts imports ONLY config / log / narration; it has NO create / schedule /
publish / delete / update path anywhere in its dependency tree, so the Node bridge
(hermes-nous/bridge/render.ts) is physically unable to create, publish, schedule,
or mutate any post. It produces a LOCAL mp4 only (DRAFT media); uploading it and
attaching it to a Publer DRAFT are separate, later steps (sffs_upload_s3 /
the loop's draft path). The render sanity check (1080x1920 + audio + duration) is the
job of ``sffs_gates`` mode="render".

GUARD-SAFE ARG NAMING: the args are ``id`` / ``props`` / ``force`` / ``data_dir`` /
``dry_run`` — none normalize to a state / schedule / publish key, ``sffs_render`` is
not a posting-named tool, and the nested ``props`` object carries NO state-like key
(its keys are title/subtitle/outro/music/showProgress/progressStyle/reveal/
countdownSec/narration/questions), so the framework publish guard never flags it
(locked in by a cross-check in tests/test_render.py).

Kept stdlib-only and free of intra-package imports so the pure arg-guards can be
imported directly by the hermetic test suite (mirrors reads.py / gates.py).
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional


class RenderGuardError(ValueError):
    """Raised for a malformed render argument (converted to an error result)."""


# The narration A/B arms the composition understands (mirrors
# hermes/src/narration.ts NarrationMode). "none" = music-only (no ElevenLabs).
_NARRATION_MODES = frozenset({"full", "none", "no-question-vo", "no-options-vo"})
# The two headless-renderable question kinds (mirrors HermesQuiz.tsx).
_QUESTION_KINDS = frozenset({"text", "numseries"})
_REVEAL_MODES = frozenset({"all", "none", "last"})
_PROGRESS_STYLES = frozenset({"short", "full"})
# A render id becomes the mp4 filename stem, so keep it filesystem-safe.
_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


# ---------------------------------------------------------------------------
# Pure arg-guards (no network, no subprocess) — the hermetically testable core
# ---------------------------------------------------------------------------
def _positive_number(value: Any, label: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise RenderGuardError(f"{label} must be a number")
    if value <= 0:
        raise RenderGuardError(f"{label} must be positive")
    return float(value)


def _validate_question(q: Any, i: int) -> Dict[str, Any]:
    if not isinstance(q, dict):
        raise RenderGuardError(f"questions[{i}] must be an object")
    kind = q.get("kind")
    if kind not in _QUESTION_KINDS:
        raise RenderGuardError(f"questions[{i}].kind must be one of {sorted(_QUESTION_KINDS)}")
    prompt = q.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip():
        raise RenderGuardError(f"questions[{i}] needs a non-empty string 'prompt'")
    answer = q.get("answer")
    if not isinstance(answer, str) or not answer.strip():
        raise RenderGuardError(f"questions[{i}] needs a non-empty string 'answer'")
    # text questions display multiple-choice options; numseries display a sequence.
    if kind == "text":
        opts = q.get("options")
        if not isinstance(opts, list) or len([o for o in opts if isinstance(o, str) and o.strip()]) < 2:
            raise RenderGuardError(f"questions[{i}] (text) needs an 'options' list of >= 2 strings")
    else:  # numseries
        seq = q.get("seq")
        if not isinstance(seq, list) or len([s for s in seq if isinstance(s, str) and s.strip()]) < 2:
            raise RenderGuardError(f"questions[{i}] (numseries) needs a 'seq' list of >= 2 strings")
    return q


def _validate_narration(value: Any) -> Dict[str, Any]:
    if not isinstance(value, dict):
        raise RenderGuardError("narration must be an object")
    mode = value.get("mode", "none")
    if mode not in _NARRATION_MODES:
        raise RenderGuardError(f"narration.mode must be one of {sorted(_NARRATION_MODES)}")
    clips = value.get("clips", [])
    if clips is not None and not isinstance(clips, list):
        raise RenderGuardError("narration.clips must be a list (usually empty; synthesized at render time)")
    return value


def _validate_props(value: Any) -> Dict[str, Any]:
    """Validate the HermesQuiz render props (as produced by sffs_design plan)."""
    if not isinstance(value, dict):
        raise RenderGuardError("props must be a JSON object")

    questions = value.get("questions")
    if not isinstance(questions, list) or not questions:
        raise RenderGuardError("props.questions must be a non-empty list")
    for i, q in enumerate(questions):
        _validate_question(q, i)

    if value.get("narration") is not None:
        _validate_narration(value.get("narration"))

    reveal = value.get("reveal")
    if reveal is not None and reveal not in _REVEAL_MODES:
        raise RenderGuardError(f"props.reveal must be one of {sorted(_REVEAL_MODES)}")

    style = value.get("progressStyle")
    if style is not None and style not in _PROGRESS_STYLES:
        raise RenderGuardError(f"props.progressStyle must be one of {sorted(_PROGRESS_STYLES)}")

    if value.get("countdownSec") is not None:
        _positive_number(value.get("countdownSec"), "props.countdownSec")

    if value.get("showProgress") is not None and not isinstance(value.get("showProgress"), bool):
        raise RenderGuardError("props.showProgress must be a boolean")

    music = value.get("music")
    if music is not None and (not isinstance(music, str) or not music.strip()):
        raise RenderGuardError("props.music must be a non-empty string (staticFile path)")

    return value


def build_render_request(args: Dict[str, Any]) -> Dict[str, Any]:
    """Validate + normalize an ``sffs_render`` request. Pure.

    Returns ``{"id", "props", "force", "data_dir", "mode"}``. ``id`` is defaulted
    to a UTC-timestamp stem when absent. Raises :class:`RenderGuardError` on any
    bad input.
    """
    if not isinstance(args, dict):
        raise RenderGuardError("args must be a JSON object")

    raw_id = args.get("id")
    if raw_id is not None:
        if not isinstance(raw_id, str) or not _ID_RE.match(raw_id.strip()):
            raise RenderGuardError(
                "id must be a filesystem-safe string (letters/digits/._-, <=128 chars)"
            )
        vid = raw_id.strip()
    else:
        vid = "sffs-render-" + datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")

    props = _validate_props(args.get("props"))

    force = args.get("force")
    if force is not None and not isinstance(force, bool):
        raise RenderGuardError("force must be a boolean")

    data_dir = args.get("data_dir")
    if data_dir is not None and (not isinstance(data_dir, str) or not data_dir.strip()):
        raise RenderGuardError("data_dir must be a non-empty string path")

    narration = props.get("narration") if isinstance(props.get("narration"), dict) else {}
    mode = narration.get("mode", "none")

    return {
        "id": vid,
        "props": props,
        "force": bool(force),
        "data_dir": data_dir.strip() if isinstance(data_dir, str) else None,
        "mode": mode,
    }


# ---------------------------------------------------------------------------
# Node bridge plumbing (mirrors reads.py / gates.py — entry bridge/render.ts)
# ---------------------------------------------------------------------------
def _repo_dir() -> Path:
    override = os.environ.get("HERMES_SFFS_REPO_DIR")
    if override:
        return Path(override).resolve()
    return Path(__file__).resolve().parents[2]


def _bridge_entry() -> Path:
    return _repo_dir() / "hermes-nous" / "bridge" / "render.ts"


def _default_data_dir() -> Path:
    """Where rendered mp4s land (CONFIG.RENDERS_DIR = <data_dir>/renders).

    Prefer the isolated HERMES_HOME (outside the repo, writable, untracked); fall
    back to a gitignored dir under the repo. Overridable via the ``data_dir`` arg
    or HERMES_DATA_DIR.
    """
    home = os.environ.get("HERMES_HOME")
    if home:
        return Path(home) / "sffs-data"
    return _repo_dir() / ".sffs-data"


def _parse_last_json(stdout: str) -> Optional[Dict[str, Any]]:
    """Return the last stdout line that decodes to a JSON object, else None.

    render.ts shares hermes/src/log.ts (INFO/WARN to STDOUT for journald) before
    the machine-readable result. Log lines start with a timestamp and never parse
    as JSON; the result is emitted last. So scan bottom-up. (See failures.md F6.)
    """
    for line in reversed([ln for ln in stdout.splitlines() if ln.strip()]):
        try:
            obj = json.loads(line)
        except Exception:
            continue
        if isinstance(obj, dict):
            return obj
    return None


def _bridge_env(data_dir: Optional[str]) -> Dict[str, str]:
    """Env for the Node bridge.

    * HERMES_ENV_FILE -> $HERMES_HOME/.env so config.ts loads ELEVENLABS_API_KEY
      (for voiced arms) + any other keys (gitignored).
    * HERMES_DATA_DIR -> where CONFIG.RENDERS_DIR (and the props file) live; the
      ``data_dir`` arg wins, else keep an existing env value, else a sane default.
    """
    env = os.environ.copy()
    if not env.get("HERMES_ENV_FILE"):
        home = env.get("HERMES_HOME")
        if home:
            candidate = Path(home) / ".env"
            if candidate.exists():
                env["HERMES_ENV_FILE"] = str(candidate)
    if data_dir:
        env["HERMES_DATA_DIR"] = data_dir
    elif not env.get("HERMES_DATA_DIR"):
        env["HERMES_DATA_DIR"] = str(_default_data_dir())
    return env


def run_node_bridge(
    stdin_obj: Dict[str, Any],
    *,
    dry_run: bool,
    data_dir: Optional[str] = None,
    timeout: int = 900,
) -> Dict[str, Any]:
    """Shell out to the RENDER Node bridge. Raises :class:`RenderGuardError` on any
    failure so the handler can convert it to a result. ``dry_run=True`` computes
    frames only (no narration synth, no Chromium/ffmpeg, no network)."""
    node = shutil.which("node")
    if not node:
        raise RenderGuardError("node runtime not found on PATH")
    entry = _bridge_entry()
    if not entry.exists():
        raise RenderGuardError(f"bridge entry missing: {entry}")

    cmd = [node, str(entry), "render"]
    if dry_run:
        cmd.append("--dry-run")
    try:
        proc = subprocess.run(
            cmd,
            input=json.dumps(stdin_obj),
            capture_output=True,
            text=True,
            timeout=timeout,
            cwd=str(_repo_dir()),
            env=_bridge_env(data_dir),
        )
    except subprocess.TimeoutExpired:
        raise RenderGuardError(f"bridge timed out after {timeout}s")

    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or "").strip()
        prefix = "bridge bad-usage" if proc.returncode in (2, 3) else f"bridge failed (exit {proc.returncode})"
        raise RenderGuardError(f"{prefix}: {detail[-800:]}")

    parsed = _parse_last_json((proc.stdout or "").strip())
    if parsed is None:
        raise RenderGuardError(f"bridge returned non-JSON: {(proc.stdout or '').strip()[:300]}")
    return parsed


# ---------------------------------------------------------------------------
# Tool handler (Hermes contract: return a JSON string; NEVER raise)
# ---------------------------------------------------------------------------
def sffs_render(args: Dict[str, Any], **kwargs: Any) -> str:
    """Hermes tool handler: render a quiz short to an mp4 (DRAFT media).

    ``dry_run=True`` validates the request and returns a preview WITHOUT any
    subprocess, network, narration synth, or render. Always returns a JSON string;
    never raises.
    """
    a = args if isinstance(args, dict) else {}
    try:
        req = build_render_request(a)
    except RenderGuardError as exc:
        return json.dumps({"ok": False, "error": str(exc)})
    except Exception as exc:
        return json.dumps({"ok": False, "error": f"invalid args: {exc}"})

    dry_run = bool(a.get("dry_run", False))
    if dry_run:
        return json.dumps(
            {
                "ok": True,
                "dry_run": True,
                "id": req["id"],
                "mode": req["mode"],
                "questions": len(req["props"]["questions"]),
                "note": (
                    "dry-run validated the request only — no render, no narration "
                    "synth, no Chromium/ffmpeg, no network"
                ),
            }
        )

    stdin_obj = {"id": req["id"], "props": req["props"], "force": req["force"]}
    try:
        result = run_node_bridge(stdin_obj, dry_run=False, data_dir=req["data_dir"])
    except Exception as exc:
        return json.dumps({"ok": False, "error": str(exc)})
    if not isinstance(result, dict):
        return json.dumps({"ok": False, "error": "bridge returned a non-object result"})
    result.setdefault("ok", True)
    return json.dumps(result)
