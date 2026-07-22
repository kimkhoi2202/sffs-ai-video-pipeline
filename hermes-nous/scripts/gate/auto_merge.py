#!/usr/bin/env python3
"""auto_merge — the SFFS software-factory's TWO-KEY auto-merge gate.

Merges a proposed change (``--source`` ref) into a target branch (``--target``)
**ONLY** when BOTH keys are satisfied:

    KEY 1  the E2E :mod:`harness` is GREEN on the *merged* result, AND
    KEY 2  the :mod:`review_agent` APPROVES the diff.

If either key fails — or any guard trips — the gate REFUSES and logs. Fail-closed
by construction: the merge happens only on an explicit ``harness_ok AND
review_approved AND mergeable AND no-guard-failure`` conjunction; every error
path leaves those False.

Guards (all fail-closed):
  * **kill-switch** — env ``SFFS_FACTORY_KILL`` truthy, or a stop-file present.
    A single switch halts ALL auto-merges (the shared-sandbox emergency brake).
  * **protected branch** — never auto-merges into ``main``/``master``/``prod``…
    Code autonomy is scoped to the build branch; prod cutover stays human-gated.
  * **scope** — refuses if the change touches a denied path (prod infra, etc.).

Safety note: the gate itself introduces NO publish path and NEVER weakens
DRAFT-ONLY. Its whole job is to keep the safety core green + reviewed before any
code lands. It also never merges to ``main`` — matching the build rule that the
``hermes-nous`` line is pushed, never merged to ``main``, without human sign-off.

Modes:
  * default = **dry-run**: computes both keys + the decision and logs the plan,
    but performs NO merge (safe to run anywhere, incl. this overnight build).
  * ``--execute``: actually performs the merge — but only after both keys pass,
    the target is not protected, and no guard tripped. The merge is staged in an
    EPHEMERAL detached worktree (so the harness runs on the real merged tree) and
    the target branch is advanced with a compare-and-swap ``update-ref`` only on
    success; on any failure the worktree is aborted + removed, target untouched.

The harness/review runners are injectable (``two_key_gate(..., harness_runner=,
review_runner=)``) so the gate LOGIC is unit-tested on throwaway temp repos with
deterministic keys — never touching a real branch.
"""

from __future__ import annotations

import argparse
import fnmatch
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

GATE_DIR = Path(__file__).resolve().parent
HERMES_NOUS_DIR = GATE_DIR.parent.parent
REPO_DIR = HERMES_NOUS_DIR.parent

sys.path.insert(0, str(GATE_DIR))
import harness as harness_mod  # noqa: E402
import review_agent as review_mod  # noqa: E402

DEFAULT_PROTECTED = ("main", "master", "production", "prod", "release")
DEFAULT_DENY_GLOBS: tuple[str, ...] = ()  # e.g. ("ops/**", "**/*.pem") — prod infra / secrets
DEFAULT_LOG = GATE_DIR / "logs" / "auto_merge.log"


def _is_truthy(v: Optional[str]) -> bool:
    return bool(v) and v.strip().lower() in {"1", "true", "yes", "on"}


def _git(repo: Path, *args: str, check: bool = True, timeout: int = 120) -> subprocess.CompletedProcess:
    proc = subprocess.run(
        ["git", "-C", str(repo), *args], capture_output=True, text=True, timeout=timeout
    )
    if check and proc.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} failed: {(proc.stderr or proc.stdout or '').strip()[:300]}")
    return proc


# ---------------------------------------------------------------------------
# Guards
# ---------------------------------------------------------------------------
def check_kill_switch(kill_file: Optional[Path] = None) -> Optional[str]:
    """Return a reason if the factory kill-switch is engaged, else None."""
    if _is_truthy(os.environ.get("SFFS_FACTORY_KILL")):
        return "kill-switch engaged (SFFS_FACTORY_KILL)"
    if kill_file and Path(kill_file).exists():
        return f"kill-switch file present: {kill_file}"
    return None


def check_protected(target: str, protected: tuple[str, ...] = DEFAULT_PROTECTED) -> Optional[str]:
    name = target.strip().replace("refs/heads/", "")
    if name in protected:
        return f"target '{name}' is a protected branch — auto-merge is forbidden (human-gated)"
    return None


def check_scope(changed_files: List[str], deny_globs: tuple[str, ...] = DEFAULT_DENY_GLOBS) -> Optional[str]:
    for f in changed_files:
        for pat in deny_globs:
            if fnmatch.fnmatch(f, pat):
                return f"out-of-scope change: '{f}' matches denied path '{pat}'"
    return None


# ---------------------------------------------------------------------------
# The pure decision (the heart of the two-key gate)
# ---------------------------------------------------------------------------
def decide(
    *,
    harness_ok: bool,
    review_approved: bool,
    mergeable: bool,
    guard_failures: List[str],
) -> Dict[str, Any]:
    """The two-key AND. Merge iff BOTH keys pass, it's mergeable, and no guard tripped."""
    reasons: List[str] = []
    reasons += [f"guard: {g}" for g in guard_failures]
    if not mergeable:
        reasons.append("merge is not clean (conflicts) — not auto-mergeable")
    if not harness_ok:
        reasons.append("KEY 1 (harness) is NOT GREEN")
    if not review_approved:
        reasons.append("KEY 2 (review agent) did NOT APPROVE")
    merge = bool(harness_ok and review_approved and mergeable and not guard_failures)
    return {
        "merge": merge,
        "verdict": "MERGE" if merge else "REFUSE",
        "reasons": reasons or ["both keys satisfied (harness GREEN + review APPROVE) and all guards passed"],
    }


# ---------------------------------------------------------------------------
# Git merge preview / finalize (ephemeral detached worktree)
# ---------------------------------------------------------------------------
def _resolve(repo: Path, ref: str) -> str:
    return _git(repo, "rev-parse", ref).stdout.strip()


def _changed_files(repo: Path, target: str, source: str) -> List[str]:
    out = _git(repo, "diff", "--name-only", f"{target}...{source}").stdout
    return [ln.strip() for ln in out.splitlines() if ln.strip()]


def _diff(repo: Path, target: str, source: str) -> str:
    return _git(repo, "diff", "--no-color", f"{target}...{source}").stdout


class _MergePreview:
    """Stages ``source`` into a detached worktree at ``target`` (no commit).

    Use as a context manager. ``.mergeable`` reports whether the merge applied
    cleanly; ``.worktree`` is the on-disk merged tree (for the harness). On exit
    it either finalizes (if :meth:`finalize` was called) or aborts, then removes
    the worktree — the real target branch is only ever advanced by :meth:`finalize`
    via a compare-and-swap ``update-ref``.
    """

    def __init__(self, repo: Path, source: str, target: str):
        self.repo = repo
        self.source = source
        self.target = target
        self.worktree: Optional[Path] = None
        self.mergeable = False
        self._target_sha = ""
        self._finalized = False

    def __enter__(self) -> "_MergePreview":
        self._target_sha = _resolve(self.repo, self.target)
        tmp = Path(tempfile.mkdtemp(prefix="sffs-gate-merge-"))
        self.worktree = tmp
        _git(self.repo, "worktree", "add", "--detach", str(tmp), self._target_sha)
        merge = _git(
            tmp, "merge", "--no-ff", "--no-commit",
            "-m", f"auto-merge {self.source} -> {self.target} [two-key gate]",
            self.source, check=False,
        )
        # Clean merge with --no-commit exits 0 but leaves MERGE_HEAD; a conflict
        # exits non-zero. Either way the working tree now holds the merged files.
        self.mergeable = merge.returncode == 0
        if not self.mergeable:
            _git(tmp, "merge", "--abort", check=False)
        return self

    def finalize(self) -> str:
        """Commit the staged merge and advance the target branch (CAS). Returns new sha."""
        if not self.mergeable or self.worktree is None:
            raise RuntimeError("cannot finalize a non-mergeable/absent preview")
        _git(self.worktree, "commit", "--no-edit")
        new_sha = _resolve(self.worktree, "HEAD")
        # Compare-and-swap: only advance target if it still points where we forked.
        _git(self.repo, "update-ref", f"refs/heads/{self.target.replace('refs/heads/', '')}",
             new_sha, self._target_sha)
        self._finalized = True
        return new_sha

    def __exit__(self, *exc: Any) -> None:
        if self.worktree is not None:
            if not self._finalized:
                _git(self.worktree, "merge", "--abort", check=False)
            _git(self.repo, "worktree", "remove", "--force", str(self.worktree), check=False)
            shutil.rmtree(self.worktree, ignore_errors=True)


# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
def _log(entry: Dict[str, Any], log_file: Optional[Path]) -> None:
    entry = {"ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"), **entry}
    if log_file is None:
        return
    try:
        log_file.parent.mkdir(parents=True, exist_ok=True)
        with open(log_file, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(entry, default=str) + "\n")
    except OSError:
        pass  # logging must never crash the gate


# ---------------------------------------------------------------------------
# The gate
# ---------------------------------------------------------------------------
def _default_harness_runner(worktree: Path) -> Dict[str, Any]:
    return harness_mod.run_harness(worktree)


def _default_review_runner(diff: str) -> Dict[str, Any]:
    return review_mod.review(diff, require_model=True)


def two_key_gate(
    repo: Path,
    source: str,
    target: str,
    *,
    execute: bool = False,
    harness_runner: Callable[[Path], Dict[str, Any]] = _default_harness_runner,
    review_runner: Callable[[str], Dict[str, Any]] = _default_review_runner,
    protected: tuple[str, ...] = DEFAULT_PROTECTED,
    deny_globs: tuple[str, ...] = DEFAULT_DENY_GLOBS,
    kill_file: Optional[Path] = None,
    log_file: Optional[Path] = DEFAULT_LOG,
) -> Dict[str, Any]:
    """Run the full two-key gate for merging ``source`` into ``target``.

    Returns a machine-readable result. Performs the merge only when
    ``execute=True`` and the decision is MERGE. Always logs.
    """
    repo = Path(repo)
    result: Dict[str, Any] = {
        "source": source,
        "target": target,
        "mode": "execute" if execute else "dry-run",
        "merged": False,
        "decision": None,
        "keys": {},
        "guards": {},
    }

    # --- pre-flight guards that need no worktree ---------------------------
    guard_failures: List[str] = []
    for g in (check_kill_switch(kill_file), check_protected(target, protected)):
        if g:
            guard_failures.append(g)

    # A protected target or engaged kill-switch: refuse before doing any work.
    if guard_failures:
        result["decision"] = decide(harness_ok=False, review_approved=False, mergeable=False, guard_failures=guard_failures)
        result["guards"] = {"failures": guard_failures}
        _log(result, log_file)
        return result

    try:
        changed = _changed_files(repo, target, source)
    except Exception as exc:  # noqa: BLE001 — fail-closed
        result["decision"] = decide(harness_ok=False, review_approved=False, mergeable=False,
                                    guard_failures=[f"could not compute changed files: {exc}"])
        _log(result, log_file)
        return result
    result["changed_files"] = changed
    if not changed:
        result["decision"] = decide(harness_ok=False, review_approved=False, mergeable=False,
                                    guard_failures=["no changes between target and source (nothing to merge)"])
        _log(result, log_file)
        return result

    scope = check_scope(changed, deny_globs)
    if scope:
        guard_failures.append(scope)
    result["guards"] = {"failures": guard_failures}

    # --- stage the merge in an ephemeral worktree, run BOTH keys -----------
    harness_ok = False
    review_approved = False
    try:
        with _MergePreview(repo, source, target) as preview:
            result["mergeable"] = preview.mergeable
            diff_text = _diff(repo, target, source)

            if preview.mergeable and not guard_failures:
                # KEY 1 — harness on the merged tree
                try:
                    hres = harness_runner(preview.worktree)  # type: ignore[arg-type]
                    result["keys"]["harness"] = hres
                    harness_ok = hres.get("verdict") == "GREEN" or hres.get("ok") is True
                except Exception as exc:  # noqa: BLE001 — fail-closed
                    result["keys"]["harness"] = {"verdict": "RED", "error": f"harness crashed: {exc}"}
                    harness_ok = False

                # KEY 2 — review agent on the diff
                try:
                    rres = review_runner(diff_text)
                    result["keys"]["review"] = rres
                    review_approved = bool(rres.get("approved")) or rres.get("verdict") == "APPROVE"
                except Exception as exc:  # noqa: BLE001 — fail-closed
                    result["keys"]["review"] = {"verdict": "REJECT", "error": f"review crashed: {exc}"}
                    review_approved = False
            else:
                result["keys"]["harness"] = {"verdict": "SKIPPED", "reason": "unmergeable or guard failure"}
                result["keys"]["review"] = {"verdict": "SKIPPED", "reason": "unmergeable or guard failure"}

            decision = decide(
                harness_ok=harness_ok,
                review_approved=review_approved,
                mergeable=preview.mergeable,
                guard_failures=guard_failures,
            )
            result["decision"] = decision

            if decision["merge"] and execute:
                new_sha = preview.finalize()
                result["merged"] = True
                result["merge_commit"] = new_sha
    except Exception as exc:  # noqa: BLE001 — anything unexpected: fail-closed, no merge
        result["decision"] = decide(harness_ok=False, review_approved=False, mergeable=False,
                                    guard_failures=[f"gate error (fail-closed): {exc}"])
        result["merged"] = False

    _log(result, log_file)
    return result


def _format_human(result: Dict[str, Any]) -> str:
    d = result.get("decision") or {}
    lines = [
        f"auto_merge [{result['mode']}]: {d.get('verdict', '?')}  "
        f"({result['source']} -> {result['target']})",
        f"  merged: {result.get('merged')}"
        + (f"  commit={result['merge_commit'][:10]}" if result.get("merge_commit") else ""),
    ]
    keys = result.get("keys", {})
    if "harness" in keys:
        lines.append(f"  KEY 1 harness: {keys['harness'].get('verdict', '?')}")
    if "review" in keys:
        lines.append(f"  KEY 2 review:  {keys['review'].get('verdict', '?')} (source={keys['review'].get('source', '?')})")
    for r in d.get("reasons", []):
        lines.append(f"  - {r}")
    return "\n".join(lines)


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="SFFS TWO-KEY auto-merge gate (harness GREEN AND review APPROVE)")
    parser.add_argument("--repo", default=str(REPO_DIR), help="pipeline repo root")
    parser.add_argument("--source", required=True, help="ref/branch to merge FROM")
    parser.add_argument("--target", required=True, help="branch to merge INTO")
    parser.add_argument("--execute", action="store_true", help="actually perform the merge (default: dry-run)")
    parser.add_argument("--offline-review", action="store_true",
                        help="run the review's static safety floor only (no model call); degraded")
    parser.add_argument("--deny-glob", action="append", default=list(DEFAULT_DENY_GLOBS),
                        help="path glob to refuse merging (repeatable)")
    parser.add_argument("--kill-file", default=None, help="path to a kill-switch stop file")
    parser.add_argument("--log-file", default=str(DEFAULT_LOG), help="append JSONL decisions here")
    parser.add_argument("--json", action="store_true", help="print the machine-readable result")
    args = parser.parse_args(argv)

    review_runner = _default_review_runner
    if args.offline_review:
        review_runner = lambda diff: review_mod.review(diff, require_model=False)  # noqa: E731

    result = two_key_gate(
        Path(args.repo), args.source, args.target,
        execute=args.execute,
        review_runner=review_runner,
        deny_globs=tuple(args.deny_glob),
        kill_file=Path(args.kill_file) if args.kill_file else None,
        log_file=Path(args.log_file) if args.log_file else None,
    )
    if args.json:
        print(json.dumps(result, indent=2, default=str))
    else:
        print(_format_human(result))
    return 0 if (result.get("decision") or {}).get("merge") else 1


if __name__ == "__main__":
    raise SystemExit(main())
