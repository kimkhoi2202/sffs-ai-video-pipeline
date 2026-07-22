"""SFFS DRAFT-ONLY safety core — the Python tool layer ("belt").

This module is the belt in the belt-and-suspenders DRAFT-ONLY guarantee that the
`sffs_publer_draft` Hermes tool preserves:

  * BELT (here): ``build_draft_payload`` refuses any non-draft state or any
    scheduling/publish field BEFORE anything else happens, and forces
    ``state="draft"``. ``sffs_publer_draft`` (the tool handler) never proceeds to
    a network call on a refusal.
  * SUSPENDERS (Node): a valid request is handed to the pipeline's
    ``createDraftOnly`` path via ``hermes-nous/bridge/publer-draft.ts``, which
    re-validates and can ONLY ever create a Publer draft (it does not import or
    expose schedule/publish/delete/update).

Nothing here can publish or schedule a live post. That is a human action, forever
(see .ralph/guardrails.md: "DRAFT-ONLY POSTING is frozen").

Kept dependency-free (stdlib only) and free of intra-package imports so the
DRAFT-ONLY invariant can be unit-tested without the Hermes framework, without
Node, and without any network — see hermes-nous/tests/test_draft_only.py.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any, Dict

# Frozen invariant — mirrors hermes/src/config.ts CONFIG.ALLOWED_POST_STATE.
# The tool may ONLY ever emit this post state. Never make this configurable.
ALLOWED_POST_STATE = "draft"

# Any of these, if present with a truthy value, is an attempt to go live or to
# mutate an existing post. Always refused — this tool is DRAFT-ONLY.
_FORBIDDEN_LIVE_KEYS = (
    "scheduled_at",
    "schedule",
    "publish_at",
    "publish",
    "auto_publish",
    "go_live",
)


class DraftGuardError(ValueError):
    """Raised when an input would violate the DRAFT-ONLY invariant."""


def _is_truthy(value: Any) -> bool:
    """Match the TS guard's truthiness: empty string / empty container / None
    are treated as "not present" (so ``scheduled_at=""`` is a no-op, exactly like
    ``createDraftOnly`` in guardrails.ts). Any other value counts as present."""
    return value not in (None, "", [], {}, ())


def build_draft_payload(args: Dict[str, Any]) -> Dict[str, Any]:
    """Validate + normalize a draft request. Pure: no network, no subprocess.

    Refuses (raises :class:`DraftGuardError`) if:
      * ``state`` is present and is anything other than ``"draft"`` (this rejects
        near-misses like ``"draft_public"`` / ``"scheduled"`` / ``"published"``);
      * any scheduling/publish field is present (``scheduled_at``, ``publish``, …);
      * ``account_ids`` is missing / empty / not a list of non-empty strings;
      * ``text`` is missing / empty.

    Returns a normalized payload with ``state`` FORCED to ``"draft"`` (never taken
    from the input). Unknown keys (e.g. ``dry_run``) are ignored.
    """
    if not isinstance(args, dict):
        raise DraftGuardError("args must be a JSON object")

    state = args.get("state")
    if state is not None and state != ALLOWED_POST_STATE:
        raise DraftGuardError(
            f'refusing non-draft state "{state}" — sffs_publer_draft is DRAFT-ONLY'
        )

    for key in _FORBIDDEN_LIVE_KEYS:
        if key in args and _is_truthy(args.get(key)):
            raise DraftGuardError(
                f'refusing "{key}" — sffs_publer_draft is DRAFT-ONLY '
                f"(it can never schedule or publish a live post)"
            )

    account_ids = args.get("account_ids")
    if (
        not isinstance(account_ids, list)
        or not account_ids
        or not all(isinstance(a, str) and a.strip() for a in account_ids)
    ):
        raise DraftGuardError("account_ids (a non-empty list of strings) is required")

    text = args.get("text")
    if not isinstance(text, str) or not text.strip():
        raise DraftGuardError("text (a non-empty string) is required")

    payload: Dict[str, Any] = {
        "account_ids": list(account_ids),
        "text": text,
        "type": args.get("type") or "video",
        "state": ALLOWED_POST_STATE,  # forced — the invariant, never from input
    }
    media_ids = args.get("media_ids")
    if isinstance(media_ids, list) and media_ids:
        payload["media_ids"] = [str(m) for m in media_ids]
    media_objects = args.get("media_objects")
    if isinstance(media_objects, list) and media_objects:
        payload["media_objects"] = media_objects
    return payload


def _repo_dir() -> Path:
    """Absolute path to the pipeline repo root.

    Uses ``resolve()`` so that when this file is reached through the symlinked
    plugin dir (``$HERMES_HOME/plugins/sffs`` → ``<repo>/hermes-nous/sffs``) it
    still maps to the REAL repo path, letting the Node bridge resolve its
    ``../../hermes/src/*.ts`` imports. ``HERMES_SFFS_REPO_DIR`` overrides.
    """
    override = os.environ.get("HERMES_SFFS_REPO_DIR")
    if override:
        return Path(override).resolve()
    # draft_guard.py → sffs/ → hermes-nous/ → <repo root>
    return Path(__file__).resolve().parents[2]


def _bridge_entry() -> Path:
    return _repo_dir() / "hermes-nous" / "bridge" / "publer-draft.ts"


def _parse_last_json(stdout: str) -> Dict[str, Any] | None:
    """Return the last stdout line that decodes to a JSON object, else None.

    The Node bridge shares the pipeline's logger (hermes/src/log.ts), which writes
    human-readable INFO/WARN lines to STDOUT (for journald) BEFORE the
    machine-readable result. Those lines start with a timestamp and never parse as
    JSON; the result JSON is emitted last. So scan lines bottom-up and return the
    first that decodes to a dict. (Dry-run emits a single clean JSON line, so this
    is behaviour-preserving there.)
    """
    for line in reversed([ln for ln in stdout.splitlines() if ln.strip()]):
        try:
            obj = json.loads(line)
        except Exception:
            continue
        if isinstance(obj, dict):
            return obj
    return None


def run_node_bridge(payload: Dict[str, Any], *, dry_run: bool, timeout: int = 240) -> Dict[str, Any]:
    """Shell out to the Node ``createDraftOnly`` path (the suspenders layer).

    ``dry_run=True`` validates via the same guard and returns the normalized
    draft payload with NO network call. Raises :class:`DraftGuardError` on any
    failure so the handler can convert it to an error result.
    """
    node = shutil.which("node")
    if not node:
        raise DraftGuardError("node runtime not found on PATH")
    entry = _bridge_entry()
    if not entry.exists():
        raise DraftGuardError(f"bridge entry missing: {entry}")

    cmd = [node, str(entry)]
    if dry_run:
        cmd.append("--dry-run")
    try:
        proc = subprocess.run(
            cmd,
            input=json.dumps(payload),
            capture_output=True,
            text=True,
            timeout=timeout,
            cwd=str(_repo_dir()),
        )
    except subprocess.TimeoutExpired:
        raise DraftGuardError(f"bridge timed out after {timeout}s")

    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or "").strip()
        # exit 3 = the Node guard refused (defense in depth); surface it clearly.
        prefix = "bridge REFUSED" if proc.returncode == 3 else f"bridge failed (exit {proc.returncode})"
        raise DraftGuardError(f"{prefix}: {detail[:500]}")

    out = (proc.stdout or "").strip()
    parsed = _parse_last_json(out)
    if parsed is None:
        raise DraftGuardError(f"bridge returned non-JSON: {out[:300]}")
    return parsed


def sffs_publer_draft(args: Dict[str, Any], **kwargs: Any) -> str:
    """Hermes tool handler: create a Publer DRAFT for the SFFS accounts.

    Hermes contract: ALWAYS return a JSON string; NEVER raise.

    Safety: this refuses any non-draft state / any scheduling field at the Python
    layer FIRST (before any subprocess or network), then delegates a valid,
    normalized, ``state="draft"`` payload to the Node ``createDraftOnly`` path
    (which refuses again). ``dry_run=True`` validates and returns the exact draft
    payload with no network call.
    """
    # Belt: validate + normalize. On any violation, refuse and STOP here — we
    # never reach a subprocess or a network call for a refused request.
    try:
        payload = build_draft_payload(args if isinstance(args, dict) else {})
    except DraftGuardError as exc:
        return json.dumps(
            {"ok": False, "refused": True, "state": ALLOWED_POST_STATE, "error": str(exc)}
        )
    except Exception as exc:  # never raise out of a tool handler
        return json.dumps({"ok": False, "refused": True, "error": f"invalid args: {exc}"})

    dry_run = bool(args.get("dry_run", False)) if isinstance(args, dict) else False

    if dry_run:
        # No network. Prove the emitted payload is a draft and nothing else.
        return json.dumps(
            {"ok": True, "dry_run": True, "state": ALLOWED_POST_STATE, "payload": payload}
        )

    # Suspenders: hand the validated draft to the pipeline's createDraftOnly path.
    try:
        result = run_node_bridge(payload, dry_run=False)
    except Exception as exc:
        return json.dumps(
            {"ok": False, "state": ALLOWED_POST_STATE, "error": str(exc), "payload": payload}
        )

    # Re-assert the invariant on the way out — a draft, always.
    if not isinstance(result, dict):
        result = {"ok": False, "error": "bridge returned a non-object result"}
    result["state"] = ALLOWED_POST_STATE
    result.setdefault("ok", True)
    return json.dumps(result)
