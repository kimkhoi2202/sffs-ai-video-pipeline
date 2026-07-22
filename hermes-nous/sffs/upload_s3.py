"""SFFS S3 UPLOAD tool — host a rendered mp4 and get back a fetchable URL.

One tool, ``sffs_upload_s3``, wrapping tools/upload-media.ts ``uploadFile``. It
pushes a local file (a rendered quiz short from ``sffs_render``) to object storage
and returns a fetchable URL:

  * MEDIA HOST = S3 (operator directive: everything in AWS). The bucket is PRIVATE
    (public access blocked); the tool PutObjects the file and returns a PRESIGNED
    GET URL (TTL S3_PRESIGN_TTL, default 6h) that Publer can fetch during a later
    DRAFT import. Credentials resolve from AWS_ACCESS_KEY_ID/SECRET (+ optional
    session token) if present, else from the EC2 instance role via IMDSv2 (the VPS
    default at cutover). S3_BUCKET defaults to hermes-sffs-media; AWS_REGION to
    us-east-1 (mirrors hermes/src/config.ts).

tools/upload-media.ts imports ONLY node builtins (fs / path / crypto) + global
fetch; it has NO create / schedule / publish / delete / update path anywhere, so
the Node bridge (hermes-nous/bridge/upload-s3.ts) is physically unable to create,
publish, schedule, or mutate any post. It only HOSTS media (uploads a file, returns
a URL). Attaching that URL to a Publer DRAFT is a separate, later step
(sffs_publer_draft). This tool never deletes or overwrites anything except the exact
destination key it is given.

GUARD-SAFE ARG NAMING: the args are ``local_path`` / ``dest_key`` / ``dry_run`` —
none normalize to a state / schedule / publish key, and ``sffs_upload_s3`` is not a
posting-named tool, so the framework publish guard never flags it (locked in by a
cross-check in tests/test_upload_s3.py).

Kept stdlib-only and free of intra-package imports so the pure arg-guards can be
imported directly by the hermetic test suite (mirrors reads.py / render.py).
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any, Dict, Optional


class UploadGuardError(ValueError):
    """Raised for a malformed upload argument (converted to an error result)."""


# ---------------------------------------------------------------------------
# Pure arg-guards (no network, no subprocess) — the hermetically testable core
# ---------------------------------------------------------------------------
def _safe_dest_key(value: Any) -> str:
    """Validate an optional destination key: a non-empty relative path with no
    parent-traversal (``..``) segments and no leading slash (buildKey strips the
    leading slash anyway; we reject traversal defensively)."""
    if not isinstance(value, str) or not value.strip():
        raise UploadGuardError("dest_key must be a non-empty string")
    key = value.strip()
    parts = [p for p in key.replace("\\", "/").split("/") if p not in ("", ".")]
    if any(p == ".." for p in parts):
        raise UploadGuardError("dest_key must not contain '..' path segments")
    if not parts:
        raise UploadGuardError("dest_key must name a file")
    return key


def build_upload_request(args: Dict[str, Any]) -> Dict[str, Any]:
    """Validate + normalize an ``sffs_upload_s3`` request. Pure.

    Returns ``{"local_path": str, "dest_key": Optional[str]}``. Existence of the
    file is checked by the Node bridge (kept out of the pure guard so the arg-guard
    stays filesystem-free and hermetically testable). Raises
    :class:`UploadGuardError` on any bad input.
    """
    if not isinstance(args, dict):
        raise UploadGuardError("args must be a JSON object")

    local_path = args.get("local_path")
    if not isinstance(local_path, str) or not local_path.strip():
        raise UploadGuardError("local_path must be a non-empty string")

    out: Dict[str, Any] = {"local_path": local_path.strip(), "dest_key": None}
    if args.get("dest_key") is not None:
        out["dest_key"] = _safe_dest_key(args.get("dest_key"))
    return out


# ---------------------------------------------------------------------------
# Node bridge plumbing (mirrors reads.py / render.py — entry bridge/upload-s3.ts)
# ---------------------------------------------------------------------------
def _repo_dir() -> Path:
    override = os.environ.get("HERMES_SFFS_REPO_DIR")
    if override:
        return Path(override).resolve()
    return Path(__file__).resolve().parents[2]


def _bridge_entry() -> Path:
    return _repo_dir() / "hermes-nous" / "bridge" / "upload-s3.ts"


def _parse_last_json(stdout: str) -> Optional[Dict[str, Any]]:
    """Return the last stdout line that decodes to a JSON object, else None.

    tools/upload-media.ts writes diagnostics to STDERR and the URL to stdout only
    from its CLI ``main`` (never reached on import), so the bridge's stdout is a
    single clean JSON line — but we scan bottom-up for robustness / F6 parity.
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
    """Env for the Node bridge.

    * HERMES_ENV_FILE -> $HERMES_HOME/.env so any AWS/S3 keys placed there load.
    * S3_BUCKET / AWS_REGION default to the known SFFS values (mirrors config.ts)
      when unset, so an upload works via the EC2 instance role (or env creds) with
      no extra plumbing. MEDIA_HOST defaults to s3 in upload-media.ts itself.
    """
    env = os.environ.copy()
    if not env.get("HERMES_ENV_FILE"):
        home = env.get("HERMES_HOME")
        if home:
            candidate = Path(home) / ".env"
            if candidate.exists():
                env["HERMES_ENV_FILE"] = str(candidate)
    env.setdefault("S3_BUCKET", "hermes-sffs-media")
    env.setdefault("AWS_REGION", "us-east-1")
    return env


def run_node_bridge(
    stdin_obj: Dict[str, Any],
    *,
    dry_run: bool,
    timeout: int = 300,
) -> Dict[str, Any]:
    """Shell out to the UPLOAD Node bridge. Raises :class:`UploadGuardError` on any
    failure so the handler can convert it to a result. ``dry_run=True`` validates +
    previews the destination network-free (no credentials needed)."""
    node = shutil.which("node")
    if not node:
        raise UploadGuardError("node runtime not found on PATH")
    entry = _bridge_entry()
    if not entry.exists():
        raise UploadGuardError(f"bridge entry missing: {entry}")

    cmd = [node, str(entry), "upload"]
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
            env=_bridge_env(),
        )
    except subprocess.TimeoutExpired:
        raise UploadGuardError(f"bridge timed out after {timeout}s")

    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or "").strip()
        prefix = "bridge bad-usage" if proc.returncode in (2, 3) else f"bridge failed (exit {proc.returncode})"
        raise UploadGuardError(f"{prefix}: {detail[-800:]}")

    parsed = _parse_last_json((proc.stdout or "").strip())
    if parsed is None:
        raise UploadGuardError(f"bridge returned non-JSON: {(proc.stdout or '').strip()[:300]}")
    return parsed


# ---------------------------------------------------------------------------
# Tool handler (Hermes contract: return a JSON string; NEVER raise)
# ---------------------------------------------------------------------------
def sffs_upload_s3(args: Dict[str, Any], **kwargs: Any) -> str:
    """Hermes tool handler: upload a local file to S3, return a presigned GET URL.

    ``dry_run=True`` validates the request and previews the destination WITHOUT any
    subprocess, network, or credentials. Always returns a JSON string; never raises.
    """
    a = args if isinstance(args, dict) else {}
    try:
        req = build_upload_request(a)
    except UploadGuardError as exc:
        return json.dumps({"ok": False, "error": str(exc)})
    except Exception as exc:
        return json.dumps({"ok": False, "error": f"invalid args: {exc}"})

    dry_run = bool(a.get("dry_run", False))
    if dry_run:
        return json.dumps(
            {
                "ok": True,
                "dry_run": True,
                "local_path": req["local_path"],
                "dest_key": req["dest_key"],
                "note": (
                    "dry-run validated the request only — no upload, no network, no "
                    "credentials used"
                ),
            }
        )

    stdin_obj: Dict[str, Any] = {"local_path": req["local_path"]}
    if req["dest_key"] is not None:
        stdin_obj["dest_key"] = req["dest_key"]
    try:
        result = run_node_bridge(stdin_obj, dry_run=False)
    except Exception as exc:
        return json.dumps({"ok": False, "error": str(exc)})
    if not isinstance(result, dict):
        return json.dumps({"ok": False, "error": "bridge returned a non-object result"})
    result.setdefault("ok", True)
    return json.dumps(result)
