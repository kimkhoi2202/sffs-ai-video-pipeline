"""SFFS QUALITY GATES tool — the fail-closed checks nothing becomes a draft without.

One tool, ``sffs_gates``, with four gate modes (selected by ``what``), each wrapping
a distinct check in hermes/src/gates.ts:

  * ``dedup``    — never-repeat check: refuse any question already in the used
    ledger, already claimed in this batch, or duplicated internally. Deterministic;
    reads the used-sigs ledgers (file reads) — no network. Wraps ``gateDedup``.
  * ``validity`` — LLM rubric (cached by hash): exactly one unambiguous correct
    answer, factual, grade-appropriate, plausible distractors. FAILS CLOSED for any
    question with no verdict. Wraps ``validateQuestions``.
  * ``copy``     — brand-voice + kid-safe: deterministic hard rules first (no
    tokens), then an LLM judge (falls back to the deterministic pass if the judge is
    unreachable). Wraps ``gateCopy``.
  * ``render``   — render sanity: 1080x1920, video+audio streams, duration ~
    expected (ffprobe). Never throws (a bad path/ffprobe returns pass:false).
    Wraps ``gateRenderSanity``.

Every mode returns a pass/fail verdict; the caller MUST treat ``pass=false`` as
"do not draft" (quality > volume). gates.ts has NO create / schedule / publish /
delete / update path anywhere (it wraps llm / brand / questions / state / config /
log + node ffprobe only), so the Node bridge (hermes-nous/bridge/gates.ts) is
physically unable to create, publish, schedule, or mutate any post.

GUARD-SAFE ARG NAMING: the args are ``what`` / ``questions`` / ``claimed`` /
``pieces`` / ``path`` / ``expected_frames`` / ``fps`` / ``dry_run`` — none normalize
to a state / schedule / publish key, and ``sffs_gates`` is not a posting-named tool,
so the framework publish guard never flags it (locked in by a cross-check in
tests/test_gates.py).

Kept stdlib-only and free of intra-package imports so the pure arg-guards can be
imported directly by the hermetic test suite (mirrors reads.py / design.py).
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any, Dict, List, Optional


class GatesGuardError(ValueError):
    """Raised for a malformed gates argument (converted to an error result)."""


# ---------------------------------------------------------------------------
# Pure arg-guards (no network, no subprocess) — the hermetically testable core
# ---------------------------------------------------------------------------
def _pos_int(value: Any, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise GatesGuardError(f"{label} must be an integer")
    if value <= 0:
        raise GatesGuardError(f"{label} must be a positive integer")
    return value


def _question_list(value: Any, *, require_hash: bool) -> List[Dict[str, Any]]:
    """Validate a non-empty list of question objects, each with a usable ``sig``
    (and ``hash`` when ``require_hash`` — validity caches verdicts by hash)."""
    if not isinstance(value, list) or not value:
        raise GatesGuardError("questions must be a non-empty list")
    out: List[Dict[str, Any]] = []
    for i, q in enumerate(value):
        if not isinstance(q, dict):
            raise GatesGuardError(f"questions[{i}] must be an object")
        sig = q.get("sig")
        if not isinstance(sig, str) or not sig.strip():
            raise GatesGuardError(f"questions[{i}] needs a non-empty string 'sig'")
        if require_hash:
            h = q.get("hash")
            if not isinstance(h, str) or not h.strip():
                raise GatesGuardError(f"questions[{i}] needs a non-empty string 'hash' (validity caches by hash)")
        out.append(q)
    return out


def build_gates_request(args: Dict[str, Any]) -> Dict[str, Any]:
    """Validate + normalize an ``sffs_gates`` request. Pure.

    Returns ``{"sub": <gate>, "params": <stdin dict>}``. Raises
    :class:`GatesGuardError` on any bad input.
    """
    if not isinstance(args, dict):
        raise GatesGuardError("args must be a JSON object")

    what = args.get("what")
    if what not in ("dedup", "validity", "copy", "render"):
        raise GatesGuardError("'what' must be one of 'dedup', 'validity', 'copy', 'render'")

    if what == "dedup":
        questions = _question_list(args.get("questions"), require_hash=False)
        params: Dict[str, Any] = {"questions": questions}
        claimed = args.get("claimed")
        if claimed is not None:
            if not isinstance(claimed, list) or not all(isinstance(c, str) and c.strip() for c in claimed):
                raise GatesGuardError("claimed must be a list of non-empty strings")
            params["claimed"] = list(claimed)
        return {"sub": "dedup", "params": params}

    if what == "validity":
        questions = _question_list(args.get("questions"), require_hash=True)
        return {"sub": "validity", "params": {"questions": questions}}

    if what == "copy":
        pieces = args.get("pieces")
        if not isinstance(pieces, list) or not pieces:
            raise GatesGuardError("pieces must be a non-empty list of {label, text}")
        norm: List[Dict[str, str]] = []
        for i, p in enumerate(pieces):
            if not isinstance(p, dict):
                raise GatesGuardError(f"pieces[{i}] must be an object")
            label = p.get("label")
            text = p.get("text")
            if not isinstance(label, str) or not label.strip():
                raise GatesGuardError(f"pieces[{i}] needs a non-empty string 'label'")
            if not isinstance(text, str) or not text.strip():
                raise GatesGuardError(f"pieces[{i}] needs a non-empty string 'text'")
            norm.append({"label": label, "text": text})
        return {"sub": "copy", "params": {"pieces": norm}}

    # render
    path = args.get("path")
    if not isinstance(path, str) or not path.strip():
        raise GatesGuardError("path must be a non-empty string")
    expected_frames = _pos_int(args.get("expected_frames"), "expected_frames")
    params = {"path": path.strip(), "expected_frames": expected_frames}
    if args.get("fps") is not None:
        params["fps"] = _pos_int(args.get("fps"), "fps")
    return {"sub": "render", "params": params}


# ---------------------------------------------------------------------------
# Node bridge plumbing (mirrors reads.py / design.py — entry bridge/gates.ts)
# ---------------------------------------------------------------------------
def _repo_dir() -> Path:
    override = os.environ.get("HERMES_SFFS_REPO_DIR")
    if override:
        return Path(override).resolve()
    return Path(__file__).resolve().parents[2]


def _bridge_entry() -> Path:
    return _repo_dir() / "hermes-nous" / "bridge" / "gates.ts"


def _parse_last_json(stdout: str) -> Optional[Dict[str, Any]]:
    """Return the last stdout line that decodes to a JSON object, else None.

    gates.ts calls log.ts ``gate(...)`` (render sanity) which writes to STDOUT
    before the machine-readable result. Scan bottom-up. (See failures.md F6.)
    """
    for line in reversed([ln for ln in stdout.splitlines() if ln.strip()]):
        try:
            obj = json.loads(line)
        except Exception:
            continue
        if isinstance(obj, dict):
            return obj
    return None


def _bridge_env() -> Dict[str, str]:
    """Env for the Node bridge — ensures gates.ts can load the LLM (TFY) key for
    the ``validity`` / ``copy`` judges (``dedup`` / ``render`` need no key), and
    resolves ffprobe for the ``render`` sanity gate."""
    env = os.environ.copy()
    if not env.get("HERMES_ENV_FILE"):
        home = env.get("HERMES_HOME")
        if home:
            candidate = Path(home) / ".env"
            if candidate.exists():
                env["HERMES_ENV_FILE"] = str(candidate)
    # The render-sanity gate shells to ffprobe (gates.ts default /usr/local/bin/
    # ffprobe). Resolve the real ffprobe on PATH so the gate works on any host
    # (e.g. Apple Silicon: /opt/homebrew/bin/ffprobe).
    if not env.get("FFPROBE"):
        ffprobe = shutil.which("ffprobe")
        if ffprobe:
            env["FFPROBE"] = ffprobe
    return env


def run_node_bridge(
    subcommand: str,
    stdin_obj: Optional[Dict[str, Any]] = None,
    *,
    dry_run: bool,
    timeout: int = 180,
) -> Dict[str, Any]:
    """Shell out to the GATES Node bridge. Raises :class:`GatesGuardError` on any
    failure so the handler can convert it to a result. ``dry_run=True`` is
    network-free."""
    node = shutil.which("node")
    if not node:
        raise GatesGuardError("node runtime not found on PATH")
    entry = _bridge_entry()
    if not entry.exists():
        raise GatesGuardError(f"bridge entry missing: {entry}")

    cmd = [node, str(entry), subcommand]
    if dry_run:
        cmd.append("--dry-run")
    try:
        proc = subprocess.run(
            cmd,
            input=json.dumps(stdin_obj) if stdin_obj is not None else "",
            capture_output=True,
            text=True,
            timeout=timeout,
            cwd=str(_repo_dir()),
            env=_bridge_env(),
        )
    except subprocess.TimeoutExpired:
        raise GatesGuardError(f"bridge timed out after {timeout}s")

    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or "").strip()
        prefix = "bridge bad-usage" if proc.returncode in (2, 3) else f"bridge failed (exit {proc.returncode})"
        raise GatesGuardError(f"{prefix}: {detail[:500]}")

    parsed = _parse_last_json((proc.stdout or "").strip())
    if parsed is None:
        raise GatesGuardError(f"bridge returned non-JSON: {(proc.stdout or '').strip()[:300]}")
    return parsed


# Which gate modes need the LLM (longer timeout) vs are deterministic/fast.
_LLM_MODES = frozenset({"validity", "copy"})


# ---------------------------------------------------------------------------
# Tool handler (Hermes contract: return a JSON string; NEVER raise)
# ---------------------------------------------------------------------------
def sffs_gates(args: Dict[str, Any], **kwargs: Any) -> str:
    """Hermes tool handler: run a quality gate (dedup / validity / copy / render).

    Every mode returns a pass/fail verdict; treat ``gate.pass == false`` as "do not
    draft". ``dry_run=True`` makes NO network/LLM call. Always returns a JSON
    string; never raises.
    """
    a = args if isinstance(args, dict) else {}
    try:
        req = build_gates_request(a)
    except GatesGuardError as exc:
        return json.dumps({"ok": False, "error": str(exc)})
    except Exception as exc:
        return json.dumps({"ok": False, "error": f"invalid args: {exc}"})

    sub = req["sub"]
    dry_run = bool(a.get("dry_run", False))
    if dry_run:
        return json.dumps({"ok": True, "dry_run": True, "what": sub, "note": "dry-run made no network call"})

    timeout = 180 if sub in _LLM_MODES else 60
    try:
        result = run_node_bridge(sub, req["params"], dry_run=False, timeout=timeout)
    except Exception as exc:
        return json.dumps({"ok": False, "error": str(exc)})
    if not isinstance(result, dict):
        return json.dumps({"ok": False, "error": "bridge returned a non-object result"})
    result.setdefault("ok", True)
    return json.dumps(result)
