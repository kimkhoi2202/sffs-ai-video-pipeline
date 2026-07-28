"""SFFS QUESTIONS tool — never-repeat question SELECTION (read-only).

One tool, ``sffs_questions``, with two read-only modes (selected by ``what``):

  * ``candidates`` — return validated, FRESH (never-before-used) questions in a
    stable seeded order. "Fresh" excludes every sig in BOTH dedup ledgers
    (content/ab-test-usage.json UNION DATA_DIR/hermes-used-sigs.json) plus any
    in-batch ``exclude`` sigs, so a question is NEVER repeated across the campaign.
    Only the two headless-renderable kinds are returned (text / numseries). Wraps
    questions.ts ``candidateQuestions``.
  * ``stats`` — bank freshness counts {total, usable, fresh, used}. Wraps
    ``bankStats``.

DELIBERATELY READ-ONLY: the Node bridge (hermes-nous/bridge/questions.ts) imports
ONLY ``candidateQuestions`` + ``bankStats``. It does NOT import ``markUsed`` — the
ledger WRITE that marks questions consumed — so this tool is physically unable to
mutate the never-repeat ledger. Marking-used belongs with the drafting step (a
later ``sffs_*`` tool / cron), exactly as the read-only ``sffs_score`` defers its
write-side rollup. questions.ts has NO network/LLM import at all (state/config/log
only), so this is a pure, local, network-free selector.

GUARD-SAFE ARG NAMING: the args are ``what`` / ``category`` / ``kinds`` / ``seed``
/ ``exclude`` / ``limit`` / ``dry_run`` — none normalize to a state / schedule /
publish key, and ``sffs_questions`` is not a posting-named tool, so the framework
publish guard never flags it (locked in by a cross-check in tests/test_questions.py).

Kept stdlib-only and free of intra-package imports so the pure arg-guards can be
imported directly by the hermetic test suite (mirrors reads.py / design.py / gates.py).
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any, Dict, List, Optional

# Bank category values (see content/master-question-bank.json). "mixed" (or an
# omitted category) means "no category filter". "nonverbal" exists in the bank but
# its kinds (shaded/polygon/dot) are not headless-renderable, so it yields ~0
# candidates — allowed for completeness, flagged in the schema description.
_CATEGORIES = frozenset({"verbal", "quantitative", "nonverbal", "mixed"})

# The only two headless-safe kinds candidateQuestions can return (toHermesQ maps
# the rest to null). Mirrors CandidateFilter.kinds in questions.ts.
_KINDS = frozenset({"text", "numseries"})

# Cap on how many candidates a single call may request (the fresh pool can be
# hundreds; this just bounds the response size). Default applied in the handler.
_MAX_LIMIT = 200
_DEFAULT_LIMIT = 20


class QuestionsGuardError(ValueError):
    """Raised for a malformed questions argument (converted to an error result)."""


# ---------------------------------------------------------------------------
# Pure arg-guard (no network, no subprocess) — the hermetically testable core
# ---------------------------------------------------------------------------
def build_questions_request(args: Dict[str, Any]) -> Dict[str, Any]:
    """Validate + normalize an ``sffs_questions`` request. Pure.

    Returns ``{"sub": "candidates"|"stats", "params": <stdin dict|None>}``. Raises
    :class:`QuestionsGuardError` on any bad input.
    """
    if not isinstance(args, dict):
        raise QuestionsGuardError("args must be a JSON object")

    what = args.get("what", "candidates")
    if what not in ("candidates", "stats"):
        raise QuestionsGuardError("'what' must be 'candidates' or 'stats'")

    if what == "stats":
        return {"sub": "stats", "params": None}

    params: Dict[str, Any] = {}

    category = args.get("category")
    if category is not None:
        if not isinstance(category, str) or category.strip().lower() not in _CATEGORIES:
            raise QuestionsGuardError(f"category must be one of {sorted(_CATEGORIES)}")
        c = category.strip().lower()
        if c != "mixed":  # "mixed"/omitted => no filter (don't send it)
            params["category"] = c

    kinds = args.get("kinds")
    if kinds is not None:
        if not isinstance(kinds, list) or not kinds:
            raise QuestionsGuardError("kinds must be a non-empty list")
        norm_kinds: List[str] = []
        for k in kinds:
            if not isinstance(k, str) or k.strip().lower() not in _KINDS:
                raise QuestionsGuardError(f"each kind must be one of {sorted(_KINDS)}")
            norm_kinds.append(k.strip().lower())
        params["kinds"] = norm_kinds

    seed = args.get("seed")
    if seed is not None:
        if not isinstance(seed, str):
            raise QuestionsGuardError("seed must be a string")
        if seed.strip():
            params["seed"] = seed.strip()

    exclude = args.get("exclude")
    if exclude is not None:
        if not isinstance(exclude, list) or not all(isinstance(s, str) and s.strip() for s in exclude):
            raise QuestionsGuardError("exclude must be a list of non-empty strings (sigs)")
        params["exclude"] = list(exclude)

    limit = args.get("limit")
    if limit is not None:
        if isinstance(limit, bool) or not isinstance(limit, int):
            raise QuestionsGuardError("limit must be an integer")
        if limit < 1 or limit > _MAX_LIMIT:
            raise QuestionsGuardError(f"limit must be between 1 and {_MAX_LIMIT}")
        params["limit"] = limit

    return {"sub": "candidates", "params": params}


# ---------------------------------------------------------------------------
# Node bridge plumbing (mirrors reads.py / design.py — entry bridge/questions.ts)
# ---------------------------------------------------------------------------
def _repo_dir() -> Path:
    override = os.environ.get("HERMES_SFFS_REPO_DIR")
    if override:
        return Path(override).resolve()
    return Path(__file__).resolve().parents[2]


def _bridge_entry() -> Path:
    return _repo_dir() / "hermes-nous" / "bridge" / "questions.ts"


def _parse_last_json(stdout: str) -> Optional[Dict[str, Any]]:
    """Return the last stdout line that decodes to a JSON object, else None.

    questions.ts calls log.ts ``info(...)`` (which writes to STDOUT) on some paths,
    so scan bottom-up for the machine-readable result. (See failures.md F6.)
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
    """Env for the Node bridge. questions.ts needs NO keys (fully local reads); we
    still forward HERMES_ENV_FILE for parity so config.ts path resolution matches
    the rest of the loop."""
    env = os.environ.copy()
    if not env.get("HERMES_ENV_FILE"):
        home = env.get("HERMES_HOME")
        if home:
            candidate = Path(home) / ".env"
            if candidate.exists():
                env["HERMES_ENV_FILE"] = str(candidate)
    return env


def run_node_bridge(
    subcommand: str,
    stdin_obj: Optional[Dict[str, Any]] = None,
    *,
    dry_run: bool,
    timeout: int = 60,
) -> Dict[str, Any]:
    """Shell out to the READ-ONLY questions Node bridge (``candidates`` | ``stats``).

    Raises :class:`QuestionsGuardError` on any failure so the handler can convert it
    to a result. ``dry_run=True`` echoes the request; live is a local read (no
    network)."""
    node = shutil.which("node")
    if not node:
        raise QuestionsGuardError("node runtime not found on PATH")
    entry = _bridge_entry()
    if not entry.exists():
        raise QuestionsGuardError(f"bridge entry missing: {entry}")

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
        raise QuestionsGuardError(f"bridge timed out after {timeout}s")

    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or "").strip()
        prefix = "bridge bad-usage" if proc.returncode in (2, 3) else f"bridge failed (exit {proc.returncode})"
        raise QuestionsGuardError(f"{prefix}: {detail[:500]}")

    parsed = _parse_last_json((proc.stdout or "").strip())
    if parsed is None:
        raise QuestionsGuardError(f"bridge returned non-JSON: {(proc.stdout or '').strip()[:300]}")
    return parsed


# ---------------------------------------------------------------------------
# Tool handler (Hermes contract: return a JSON string; NEVER raise)
# ---------------------------------------------------------------------------
def sffs_questions(args: Dict[str, Any], **kwargs: Any) -> str:
    """Hermes tool handler: select fresh never-repeated questions, or bank stats.

    READ-ONLY: it can never mark questions used or mutate any post. ``dry_run=True``
    echoes the request. Always returns a JSON string; never raises.
    """
    a = args if isinstance(args, dict) else {}
    try:
        req = build_questions_request(a)
    except QuestionsGuardError as exc:
        return json.dumps({"ok": False, "error": str(exc)})
    except Exception as exc:
        return json.dumps({"ok": False, "error": f"invalid args: {exc}"})

    sub = req["sub"]
    dry_run = bool(a.get("dry_run", False))
    if dry_run:
        return json.dumps({"ok": True, "dry_run": True, "what": sub, "note": "dry-run made no network call"})

    params = req["params"]
    if sub == "candidates":
        params = dict(params or {})
        params.setdefault("limit", _DEFAULT_LIMIT)

    try:
        result = run_node_bridge(sub, params, dry_run=False, timeout=60)
    except Exception as exc:
        return json.dumps({"ok": False, "error": str(exc)})
    if not isinstance(result, dict):
        return json.dumps({"ok": False, "error": "bridge returned a non-object result"})
    result.setdefault("ok", True)
    return json.dumps(result)
