"""SFFS software-factory **auto-merge gate** infrastructure.

This package is the *merge policy* for the SFFS "software factory" (the deployed
agent that improves its OWN code). It is built as a parallel, self-contained
workstream and touches ONLY new gate/E2E/review-agent files — never the shared
plugin registry, schemas, config, or tool files.

Three pieces implement the **TWO-KEY** auto-merge gate (RALPH_TASK.md criteria
6 + 8):

  * :mod:`harness`        — the FIRST key. Runs the full pytest suite + the Node
                            bridge dry-run matrix + the :mod:`sffs_selfcheck`
                            plugin/guard self-check, and returns a single
                            machine-readable GREEN / RED verdict.
  * :mod:`review_agent`   — the SECOND key. A fresh Nous subagent (oneshot /
                            ``delegate_task``, independent of the author) that
                            reviews a diff for correctness + SAFETY (esp. that no
                            publish / schedule / delete path was introduced and
                            DRAFT-ONLY is preserved) and returns APPROVE / REJECT.
                            Fail-closed on any error.
  * :mod:`auto_merge`     — the gate itself. Merges a proposed change ONLY when
                            the harness is GREEN **AND** the review agent
                            APPROVES; otherwise it refuses and logs. Ships a
                            dry-run mode (the default) + a kill-switch +
                            protected-branch + scope guards.

:mod:`sffs_selfcheck` is the shared plugin/guard self-check used by the harness.

DRAFT-ONLY is a frozen invariant: nothing in this package can (or ever should)
introduce a publish/schedule path. The gate exists to KEEP it that way.
"""

from __future__ import annotations

__all__ = ["harness", "review_agent", "auto_merge", "sffs_selfcheck"]
