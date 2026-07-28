#!/usr/bin/env python3
"""review_agent — the SECOND key of the SFFS software-factory auto-merge gate.

Reviews a proposed **diff** for correctness + SAFETY and returns **APPROVE /
REJECT** with reasons. It is *fail-closed*: any error, timeout, unparseable model
reply, or a static-safety hit yields REJECT (never a silent APPROVE).

Two layers, both must be satisfied to APPROVE:

  1. **Static safety floor (deterministic, no model).** Scans the ADDED lines of
     the diff for an introduced publish / schedule / delete / mutate path, a
     non-draft post state being set, or tampering with the frozen DRAFT-ONLY
     invariant. A hit is an immediate REJECT — no model call needed. This makes
     the SAFETY key robust even when the model/gateway is unavailable, and it
     targets the exact threat the task calls out ("no publish/schedule/delete
     path introduced + draft-only preserved"). It is scoped to production code
     (test/markdown files are exempt — tests legitimately contain adversarial
     strings to *verify* the guard).
  2. **Fresh Nous review subagent (correctness + a second safety opinion).** A
     brand-new agent turn — ``hermes -z`` oneshot by default, or a caller-supplied
     ``delegate_task``-backed runner at runtime — reads the diff with NO parent
     history (independent of the author agent) and must end its reply with a line
     ``VERDICT: APPROVE`` or ``VERDICT: REJECT``. Anything else → fail-closed
     REJECT.

The model runner is injectable (``review(..., model_runner=fn)``) so the gate's
own tests exercise APPROVE/REJECT deterministically without spending tokens, and
so the deployed factory can wire the review to ``delegate_task`` (fresh child,
role independent of author) instead of the CLI oneshot.

CLI: ``python review_agent.py --diff FILE|-  [--from REF --to REF] [--repo P]
[--offline] [--json]``  →  exit 0 APPROVE / 1 REJECT.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

GATE_DIR = Path(__file__).resolve().parent
HERMES_NOUS_DIR = GATE_DIR.parent.parent
REPO_DIR = HERMES_NOUS_DIR.parent

# Safety-core files: any change here raises review scrutiny (touches_guard) and
# is what a merge must never be allowed to weaken.
SAFETY_CORE_FILES = (
    "hermes-nous/sffs/publish_guard.py",
    "hermes-nous/sffs/donottouch.py",
    "hermes-nous/sffs/reads.py",
    "hermes-nous/sffs/schemas.py",
    "hermes-nous/sffs/__init__.py",
    "hermes-nous/sffs/plugin.yaml",
    "hermes-nous/bridge/donottouch.ts",
    "hermes-nous/bridge/metricool-read.ts",
)

_MODEL_TIMEOUT = 240
_MAX_PROMPT_DIFF_CHARS = 180_000  # keep the embedded diff within safe argv/model bounds


class ReviewModelError(RuntimeError):
    """The fresh-review model call failed (→ fail-closed REJECT)."""


# ---------------------------------------------------------------------------
# Diff parsing helpers
# ---------------------------------------------------------------------------
def _iter_added_lines(diff_text: str):
    """Yield (path, line_without_plus) for every ADDED code line in a unified diff."""
    path = "?"
    for line in diff_text.splitlines():
        if line.startswith("+++ "):
            p = line[4:].strip()
            path = p[2:] if p.startswith(("a/", "b/")) else p
            continue
        if line.startswith("--- "):
            continue
        if line.startswith("+") and not line.startswith("+++"):
            yield path, line[1:]


def _iter_removed_lines(diff_text: str):
    path = "?"
    for line in diff_text.splitlines():
        if line.startswith("--- "):
            p = line[4:].strip()
            path = p[2:] if p.startswith(("a/", "b/")) else p
            continue
        if line.startswith("+++ "):
            continue
        if line.startswith("-") and not line.startswith("---"):
            yield path, line[1:]


def _changed_files(diff_text: str) -> List[str]:
    files: List[str] = []
    for line in diff_text.splitlines():
        m = re.match(r"^\+\+\+ [ab]/(.+)$", line)
        if m and m.group(1) != "/dev/null":
            files.append(m.group(1))
        else:
            m2 = re.match(r"^diff --git a/(.+) b/(.+)$", line)
            if m2:
                files.append(m2.group(2))
    # de-dup, keep order
    seen, out = set(), []
    for f in files:
        if f not in seen:
            seen.add(f)
            out.append(f)
    return out


def _code_only(path: str, line: str) -> str:
    """Return the executable-code portion of a diff line (comments stripped).

    A publish/schedule call sitting in a COMMENT or docstring is not a real
    publish path, and the guard modules legitimately *name* the forbidden verbs
    in their denylist comments/JSDoc. Stripping comments keeps the scan focused on
    code that actually runs, which removes those false positives without weakening
    detection of a real (executable) publish path.
    """
    s = line.strip()
    if not s:
        return ""
    if path.endswith((".py", ".sh", ".yaml", ".yml")):
        if s.startswith("#"):
            return ""
        line = line.split(" # ")[0]  # strip an aligned inline comment
    elif path.endswith((".ts", ".tsx", ".js", ".mjs", ".json")):
        if s.startswith(("//", "*", "/*", "/**", "*/")):
            return ""
        line = line.split(" // ")[0]
    # Strip rST/docstring backtick spans (``x`` then `x`): these wrap code-like
    # PROSE (e.g. ``metricool_publish_post_now`` inside a docstring) which is not an
    # executable path. Backticks are never Python code, so this is safe there;
    # for TS we only strip the double-backtick rST form (not template literals).
    line = re.sub(r"``[^`]*``", "", line)
    if path.endswith((".py", ".sh", ".yaml", ".yml")):
        line = re.sub(r"`[^`]*`", "", line)
    return line


def _is_exempt_path(path: str) -> bool:
    """Test + doc files are exempt from CONTENT safety patterns.

    Tests deliberately contain adversarial strings (``state="published"`` etc.) to
    VERIFY the guard; docs discuss publishing freely. The tool-name / import
    checks below are still meaningful only for production code.
    """
    p = path.lower()
    if p.endswith((".md", ".markdown", ".txt")):
        return True
    if "/tests/" in f"/{p}" or p.startswith("tests/") or "/test_" in f"/{p}" or Path(p).name.startswith("test_"):
        return True
    return False


# ---------------------------------------------------------------------------
# Static safety floor
# ---------------------------------------------------------------------------
# Case-SENSITIVE camelCase mutation verbs — the pipeline's non-draft write API.
# (Case-sensitive so we do NOT match the lowercase denylist strings that
# publish_guard.py legitimately contains, e.g. "publishpost"/"deletepost".)
_FORBIDDEN_TS_SYMBOL = re.compile(
    r"\b(schedulePost|publishPost|deletePost|deletePosts|updatePost|unschedulePost)\b"
)
# A vendor publish/schedule/delete/update TOOL name being introduced as a QUOTED
# string (a real identifier/registration — not backtick doc-prose, and not the
# guard's underscore-free denylist substrings like "publishpost").
#
# Deliberately vendor-agnostic. It used to hard-code the `publer_` prefix, which
# meant retiring Publer would have silently retired the check with it — the next
# scheduler's publish tool would have sailed straight through.
_FORBIDDEN_PUBLISH_TOOL = re.compile(r"""["']\w+_(publish|schedule|delete|update)\w*post\w*""", re.IGNORECASE)
# Registering ANY tool whose name carries a publish/schedule/delete/mutate verb.
_REGISTER_FORBIDDEN = re.compile(
    r"""register_tool\s*\([^)]*name\s*=\s*["'][^"']*"""
    r"""(publish|schedule|delete|golive|go_live|post_now|update_post)""",
    re.IGNORECASE,
)
# A scheduling key used as an assignment/property/subscript (opt. quote/bracket,
# then : or =). e.g. scheduled_at: x · scheduled_at = x · obj["scheduled_at"] = x
_SCHEDULE_KEY_ASSIGN = re.compile(
    r"\b(scheduled_at|publish_at|go_live_at|golive_at|auto_publish|publish_now|scheduled_for|schedule_at)"
    r"[\"']?\s*\]?\s*[:=]"
)
# A non-draft post state being SET — covers dict/yaml (state: "published"),
# assignment (state = "scheduled"), and subscript/attr (obj["state"] = "published").
_LIVE_STATE_SET = re.compile(
    r"\bstate[\"']?\s*\]?\s*[:=]\s*[\"'](published|scheduled|scheduling|publishing|live|"
    r"draft_public|draft_private|queued)[\"']",
    re.IGNORECASE,
)
# Tampering with the frozen DRAFT-ONLY constant (either module's spelling).
_FROZEN_CONST = re.compile(r"\b(ALLOWED_POST_STATE|ALLOWED_STATE_VALUE)\s*=\s*[\"']([^\"']+)[\"']")
# Removing the framework publish guard hook.
_GUARD_HOOK_REF = re.compile(r"register_hook\(\s*[\"']pre_tool_call[\"']|^\s*-\s*pre_tool_call\s*$")


def static_safety_scan(diff_text: str) -> Dict[str, Any]:
    """Deterministic safety scan of a unified diff. Returns a result dict.

    ``ok`` is True only when NO introduced publish/schedule/delete path, non-draft
    state, or DRAFT-ONLY tampering is detected in production code.
    """
    findings: List[str] = []
    changed = _changed_files(diff_text)
    touched_core = [f for f in changed if f in SAFETY_CORE_FILES]

    # --- introduced capability / state (added lines, production code only) ---
    for path, raw in _iter_added_lines(diff_text):
        if _is_exempt_path(path):
            continue
        line = _code_only(path, raw)
        if not line.strip():
            continue
        if path.endswith((".ts", ".tsx", ".js", ".mjs")) and _FORBIDDEN_TS_SYMBOL.search(line):
            m = _FORBIDDEN_TS_SYMBOL.search(line)
            findings.append(f"{path}: introduces forbidden write/mutation symbol '{m.group(1)}': {line.strip()[:160]}")
        if _FORBIDDEN_PUBLISH_TOOL.search(line):
            findings.append(f"{path}: introduces a publish/schedule/delete post tool: {line.strip()[:160]}")
        if _REGISTER_FORBIDDEN.search(line):
            findings.append(f"{path}: registers a tool with a publish/schedule/delete/mutate name: {line.strip()[:160]}")
        if _SCHEDULE_KEY_ASSIGN.search(line):
            findings.append(f"{path}: sets a scheduling field (DRAFT-ONLY forbids scheduling): {line.strip()[:160]}")
        if _LIVE_STATE_SET.search(line):
            findings.append(f"{path}: sets a non-draft/live post state (only 'draft' allowed): {line.strip()[:160]}")
        m = _FROZEN_CONST.search(line)
        if m and m.group(2) != "draft":
            findings.append(f"{path}: changes frozen post-state constant to '{m.group(2)}' (must stay 'draft')")

    # --- tampering via REMOVED lines (weakening the invariant) --------------
    for path, raw in _iter_removed_lines(diff_text):
        if _is_exempt_path(path):
            continue
        line = _code_only(path, raw)
        if not line.strip():
            continue
        m = _FROZEN_CONST.search(line)
        if m and m.group(2) == "draft":
            findings.append(f"{path}: removes/edits the frozen ALLOWED post-state='draft' line (DRAFT-ONLY tamper)")
        if _GUARD_HOOK_REF.search(line):
            findings.append(f"{path}: removes the pre_tool_call publish-guard hook (defense-in-depth tamper)")

    return {
        "ok": not findings,
        "findings": findings,
        "changed_files": changed,
        "touches_safety_core": touched_core,
        "touches_guard": bool(touched_core),
    }


# ---------------------------------------------------------------------------
# Fresh review subagent
# ---------------------------------------------------------------------------
_REVIEW_PROMPT = """\
You are an INDEPENDENT code REVIEW AGENT for the SFFS autonomous DRAFT-ONLY \
video agent (the "software factory"). You did NOT write this change; review it \
with fresh eyes. Approve ONLY if you are confident it is correct AND safe.

Judge the diff on:
  1. SAFETY (highest priority): it must NOT introduce any path that can publish, \
schedule, go-live, delete, or mutate a live social post. The agent is DRAFT-ONLY \
and human-gated for posting. The guard layers (the pre_tool_call publish-guard hook, \
the do-not-touch snapshot/verify pair, and the platform-level draft:true / \
autoPublish:false the loop writes) must NOT be weakened, bypassed, or removed. No \
non-draft post state may be set.
  2. CORRECTNESS: the change does what it claims, is internally consistent, and \
does not break existing behavior or tests.
  3. SCOPE: it stays within the SFFS pipeline / the agent's own code — no prod \
infra, secrets, or unrelated repos.

{extra}
Respond with a short bullet list of findings, then FINISH with EXACTLY one line:
  VERDICT: APPROVE
or
  VERDICT: REJECT
followed by a line beginning "REASONS:" summarizing why. If you are unsure, or \
cannot fully assess safety, you MUST answer VERDICT: REJECT (fail-closed).

=== BEGIN DIFF ===
{diff}
=== END DIFF ===
"""


def build_review_prompt(diff_text: str, extra_instructions: str = "") -> str:
    diff = diff_text
    if len(diff) > _MAX_PROMPT_DIFF_CHARS:
        diff = diff[:_MAX_PROMPT_DIFF_CHARS] + "\n...[diff truncated for length — review the omitted part as suspicious]..."
    extra = (extra_instructions.strip() + "\n") if extra_instructions.strip() else ""
    return _REVIEW_PROMPT.format(extra=extra, diff=diff)


_VERDICT_RE = re.compile(r"^\s*VERDICT\s*:\s*(APPROVE|REJECT)\b", re.IGNORECASE | re.MULTILINE)


def parse_model_verdict(text: str) -> Tuple[Optional[str], List[str]]:
    """Extract the LAST ``VERDICT: APPROVE|REJECT`` from a model reply.

    Returns (verdict|None, reasons). A missing/ambiguous verdict → (None, ...),
    which the caller treats as fail-closed REJECT.
    """
    if not isinstance(text, str) or not text.strip():
        return None, ["empty model reply"]
    matches = list(_VERDICT_RE.finditer(text))
    if not matches:
        return None, ["no 'VERDICT: APPROVE|REJECT' line in model reply"]
    verdict = matches[-1].group(1).upper()
    reasons: List[str] = []
    m = re.search(r"REASONS?\s*:\s*(.+)", text[matches[-1].start():], re.IGNORECASE | re.DOTALL)
    if m:
        reasons = [ln.strip(" -\t") for ln in m.group(1).strip().splitlines() if ln.strip()][:12]
    return verdict, reasons or ["(no explicit reasons given)"]


def default_model_runner(prompt: str, *, timeout: int = _MODEL_TIMEOUT) -> str:
    """Run the fresh review turn and return its stdout. Raises on any failure.

    Wiring precedence:
      * ``SFFS_REVIEW_MODEL_CMD`` — a command template run via the shell; the token
        ``{prompt_file}`` (if present) is replaced with a temp file holding the
        prompt, else the prompt is fed on stdin. This is the deploy-time hook for
        pointing the review at a ``delegate_task`` child / a specific model / a
        usage-accounted invocation.
      * otherwise ``hermes -z <prompt>`` — a fresh Nous oneshot (no parent history
        = independent of the author) on the configured provider. Requires
        ``hermes`` on PATH and a configured ``HERMES_HOME`` (inherited from env).
    """
    template = os.environ.get("SFFS_REVIEW_MODEL_CMD", "").strip()
    if template:
        with tempfile.NamedTemporaryFile("w", suffix=".prompt", delete=False) as fh:
            fh.write(prompt)
            prompt_file = fh.name
        try:
            if "{prompt_file}" in template:
                cmd = template.replace("{prompt_file}", prompt_file)
                proc = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=timeout)
            else:
                proc = subprocess.run(template, shell=True, input=prompt, capture_output=True, text=True, timeout=timeout)
        finally:
            try:
                os.unlink(prompt_file)
            except OSError:
                pass
        if proc.returncode != 0:
            raise ReviewModelError(f"review command failed (exit {proc.returncode}): {(proc.stderr or '')[:400]}")
        return proc.stdout

    hermes = shutil.which("hermes")
    if not hermes:
        raise ReviewModelError("hermes CLI not on PATH and SFFS_REVIEW_MODEL_CMD unset — cannot run fresh review")
    try:
        proc = subprocess.run([hermes, "-z", prompt], capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired as exc:
        raise ReviewModelError(f"review model timed out after {timeout}s") from exc
    if proc.returncode != 0:
        raise ReviewModelError(f"hermes oneshot failed (exit {proc.returncode}): {(proc.stderr or '')[:400]}")
    return proc.stdout


def review(
    diff_text: str,
    *,
    model_runner: Optional[Callable[[str], str]] = None,
    require_model: bool = True,
    extra_instructions: str = "",
) -> Dict[str, Any]:
    """Review a diff. Returns ``{verdict: APPROVE|REJECT, reasons, source, ...}``.

    Fail-closed: an empty diff, a static-safety hit, a model error, or an
    unparseable verdict all yield REJECT.
    """
    result: Dict[str, Any] = {
        "verdict": "REJECT",
        "approved": False,
        "source": "static",
        "reasons": [],
        "static": None,
        "model_reply": None,
    }

    if not isinstance(diff_text, str) or not diff_text.strip():
        result["reasons"] = ["empty diff — nothing to review (fail-closed REJECT)"]
        return result

    # --- Layer 1: static safety floor --------------------------------------
    scan = static_safety_scan(diff_text)
    result["static"] = scan
    if not scan["ok"]:
        result["reasons"] = ["STATIC SAFETY REJECT:"] + scan["findings"]
        result["source"] = "static"
        return result  # hard reject — no model call needed

    # --- degraded / offline: static-only (NOT the full two-key correctness) --
    if not require_model:
        result.update(verdict="APPROVE", approved=True, source="static-only")
        result["reasons"] = [
            "static safety scan clean; model review skipped (--offline / static-only degraded mode)"
        ]
        if scan["touches_guard"]:
            result["reasons"].append(
                f"NOTE: touches safety-core {scan['touches_safety_core']} — a full model review is strongly advised"
            )
        return result

    # --- Layer 2: fresh review subagent ------------------------------------
    runner = model_runner or default_model_runner
    prompt = build_review_prompt(diff_text, extra_instructions)
    try:
        reply = runner(prompt)
    except Exception as exc:  # noqa: BLE001 — fail-closed on ANY model failure
        result["source"] = "model"
        result["reasons"] = [f"fresh review failed → fail-closed REJECT: {exc}"]
        return result

    result["model_reply"] = (reply or "")[:4000]
    verdict, reasons = parse_model_verdict(reply)
    result["source"] = "static+model"
    if verdict == "APPROVE":
        result.update(verdict="APPROVE", approved=True)
        result["reasons"] = ["static safety clean + fresh review APPROVED"] + reasons
    else:
        result.update(verdict="REJECT", approved=False)
        result["reasons"] = (["fresh review REJECTED"] if verdict == "REJECT" else ["unparseable model verdict → fail-closed REJECT"]) + reasons
    return result


# ---------------------------------------------------------------------------
# Diff acquisition + CLI
# ---------------------------------------------------------------------------
def diff_from_git(repo: Path, from_ref: str, to_ref: str) -> str:
    proc = subprocess.run(
        ["git", "-C", str(repo), "diff", "--no-color", f"{from_ref}...{to_ref}"],
        capture_output=True, text=True, timeout=120,
    )
    if proc.returncode != 0:
        raise ReviewModelError(f"git diff failed: {(proc.stderr or '').strip()[:300]}")
    return proc.stdout


def _read_diff(args) -> str:
    if args.diff == "-":
        return sys.stdin.read()
    if args.diff:
        return Path(args.diff).read_text(encoding="utf-8")
    if args.from_ref and args.to_ref:
        return diff_from_git(Path(args.repo), args.from_ref, args.to_ref)
    raise SystemExit("provide --diff FILE|- OR --from REF --to REF")


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="SFFS auto-merge review agent (key #2): APPROVE/REJECT")
    parser.add_argument("--diff", help="path to a unified diff file, or '-' for stdin")
    parser.add_argument("--from", dest="from_ref", help="base git ref (with --to)")
    parser.add_argument("--to", dest="to_ref", help="head git ref (with --from)")
    parser.add_argument("--repo", default=str(REPO_DIR), help="repo for --from/--to diffing")
    parser.add_argument("--offline", action="store_true", help="static-only (no model call); degraded mode")
    parser.add_argument("--extra", default="", help="extra reviewer instructions")
    parser.add_argument("--json", action="store_true", help="print the machine-readable result")
    args = parser.parse_args(argv)

    diff_text = _read_diff(args)
    result = review(diff_text, require_model=not args.offline, extra_instructions=args.extra)
    if args.json:
        print(json.dumps(result, indent=2, default=str))
    else:
        print(f"review_agent: {result['verdict']}  (source={result['source']})")
        for r in result["reasons"]:
            print(f"  - {r}")
    return 0 if result["approved"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
