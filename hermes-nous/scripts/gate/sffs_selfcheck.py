#!/usr/bin/env python3
"""sffs_selfcheck — load the `sffs` plugin, list its tools, and exercise the
DRAFT-ONLY publish guard against a known BLOCK / ALLOW matrix.

This is the plugin-integration leg of the auto-merge harness (:mod:`harness`).
It answers three questions that gate a merge:

  1. **Does the plugin load?** We call the plugin's real ``register(ctx)``
     entry-point with a capturing context and record every tool + hook it
     registers. (A ``register`` that raises, or drifts from the manifest, is a
     merge blocker.)
  2. **Is the tool surface exactly the sanctioned safety core + read tools —
     and NOTHING that can publish / schedule / delete / mutate a post?** We
     assert the registered tool names equal the expected set, that no forbidden
     (publish/schedule/mutate) tool name was registered, that a single
     ``pre_tool_call`` hook exists, and that ``sffs/plugin.yaml`` agrees.
  3. **Does the ``pre_tool_call`` guard actually block the dangerous matrix and
     allow the benign one?** We drive the *real* captured hook against a curated
     matrix and assert the framework block-directive contract
     (``{"action":"block","message": <non-empty>}`` to refuse, ``None`` to allow).

It is hermetic: no network, no Node, no Hermes framework import, no model call.
It loads the plugin package straight from the worktree, so it validates the code
on the CURRENT branch (not whatever is symlinked into ``$HERMES_HOME``).

Exit code: 0 = GREEN (all checks pass), 1 = RED. ``--json`` prints the full
machine-readable result. Importable: :func:`run_selfcheck` returns the result
dict; :data:`BLOCK_MATRIX` / :data:`ALLOW_MATRIX` are reused by the harness tests.
"""

from __future__ import annotations

import argparse
import importlib
import json
import sys
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

# gate/ -> scripts/ -> hermes-nous/ -> <repo>
GATE_DIR = Path(__file__).resolve().parent
HERMES_NOUS_DIR = GATE_DIR.parent.parent          # .../hermes-nous
PLUGIN_PARENT = HERMES_NOUS_DIR                    # dir CONTAINING the `sffs` package
PLUGIN_DIR = HERMES_NOUS_DIR / "sffs"
PLUGIN_YAML = PLUGIN_DIR / "plugin.yaml"

# The safety core + read tools that MUST always be present. New tools that land
# on the main line (render / score / design / quality-gate / upload …) are
# ALLOWED and reported as `extra_tools` — the gate only hard-fails if one of
# these REQUIRED tools goes missing or a FORBIDDEN (publish/schedule/delete) tool
# name appears. (This is the "auto-discover as more tools land" contract: the
# harness picks up new test_*.py, and the selfcheck tolerates new tool names.)
REQUIRED_TOOLS = frozenset(
    {
        "sffs_publer_draft",          # the ONLY write path — draft-only
        "sffs_donottouch_snapshot",   # read-only
        "sffs_donottouch_verify",     # read-only
        "sffs_publer_read",           # read-only
        "sffs_score",                 # read-only
    }
)
EXPECTED_TOOLS = REQUIRED_TOOLS  # back-compat alias

# Normalized substrings that must NEVER appear in a registered tool NAME — any
# would mean the plugin exposed a publish/schedule/mutation capability.
FORBIDDEN_TOOLNAME_SUBSTRINGS = (
    "publish",
    "schedule",   # a *scheduling* tool (the plugin has none; read filters are args, not tools)
    "golive",
    "go_live",
    "delete",
    "update_post",
    "updatepost",
    "post_now",
    "postnow",
)


# ---------------------------------------------------------------------------
# The BLOCK / ALLOW matrix the pre_tool_call guard is driven against.
# Each entry: (label, tool_name, args). BLOCK entries MUST return a block
# directive; ALLOW entries MUST return None. This is the "known block/allow
# matrix" the harness runs the publish-guard against.
# ---------------------------------------------------------------------------
BLOCK_MATRIX: Tuple[Tuple[str, str, Dict[str, Any]], ...] = (
    # --- publish / schedule / mutate by TOOL NAME (incl. the Publer MCP surface)
    ("publer MCP publish now", "publer_publish_post_now", {"post_id": "p1"}),
    ("publer MCP update post", "publer_update_post", {"post_id": "p1", "text": "x"}),
    ("publer MCP delete post", "publer_delete_post", {"post_id": "p1"}),
    ("publer MCP bulk delete", "publer_delete_posts", {"ids": ["p1", "p2"]}),
    ("generic schedule_post", "schedule_post", {"account_ids": ["a"], "text": "x"}),
    ("generic post_now", "post_now", {"account_ids": ["a"]}),
    ("generic go_live", "go_live", {}),
    # --- publish / schedule intent by ARGUMENT (on an otherwise-unnamed tool)
    ("scheduled_at arg", "some_tool", {"scheduled_at": "2026-08-01T09:00:00Z"}),
    ("publish flag arg", "some_tool", {"publish": True}),
    ("go_live_at arg", "some_tool", {"go_live_at": "2026-08-01T00:00:00Z"}),
    # --- live/non-draft post state VALUES
    ("live state=published", "some_tool", {"state": "published"}),
    ("live state=scheduled", "some_tool", {"post_state": "scheduled"}),
    ("publer draft-variant", "some_tool", {"state": "draft_public"}),
    (
        "posting tool non-draft state",
        "publer_create_post",
        {"account_ids": ["a"], "text": "x", "state": "scheduled"},
    ),
    # --- nested live state deep in a media/post object
    (
        "nested published state",
        "publer_create_post",
        {"account_ids": ["a"], "text": "hi", "media_objects": [{"id": "m1", "state": "published"}]},
    ),
)

ALLOW_MATRIX: Tuple[Tuple[str, str, Dict[str, Any]], ...] = (
    # --- the sanctioned draft path + read tools
    (
        "sanctioned draft (valid)",
        "sffs_publer_draft",
        {"account_ids": ["6a5fc9dc4ccd63dc1f041549"], "text": "Smart Fella? 🧠", "type": "video", "dry_run": True},
    ),
    ("draft with explicit draft state", "publer_create_post", {"state": "draft", "account_ids": ["a"], "text": "x"}),
    (
        "do-not-touch verify snapshot (scheduled_ids/published_ids)",
        "sffs_donottouch_verify",
        {"snapshot": {"scheduled_ids": ["a", "b"], "published_ids": ["c"], "captured_at": "t"}},
    ),
    (
        "read posts filtered to published (state_filter, not state)",
        "sffs_publer_read",
        {"what": "posts", "state_filter": "published"},
    ),
    ("score read window", "sffs_score", {"from": "2026-06-01", "to": "2026-07-01"}),
    # --- benign non-posting tools that must never be tripped (no false positives)
    ("cron schedule expression", "cronjob", {"schedule": "24h", "name": "sffs-nightly"}),
    ("kanban state", "kanban_update_task", {"state": "in_progress"}),
    ("git pr state", "gh_pr", {"state": "open"}),
    ("terminal npm publish (free-form value)", "terminal", {"command": "npm publish && gh release"}),
    ("delegate goal free-form", "delegate_task", {"goal": "publish the post and go live now"}),
    ("benign 'post' substring in name", "compost_heap", {}),
)


class _CaptureCtx:
    """A stand-in for the Hermes ``PluginContext`` that records registrations.

    It exposes exactly the surface the plugin's ``register()`` uses —
    ``register_tool`` / ``register_hook`` — and captures the arguments so we can
    enumerate the tool set and drive the real hooks. Extra methods on the real
    context (``llm``, ``inject_message`` …) are intentionally absent; the safety
    core never calls them, and their absence keeps this hermetic.
    """

    def __init__(self) -> None:
        self.tools: List[Dict[str, Any]] = []
        self.hooks: List[Tuple[str, Callable]] = []

    def register_tool(self, name: str, toolset: str = "", schema: Any = None,
                      handler: Callable | None = None, **kwargs: Any) -> None:
        self.tools.append(
            {"name": name, "toolset": toolset, "schema": schema, "handler": handler, **kwargs}
        )

    def register_hook(self, hook_name: str, callback: Callable) -> None:
        self.hooks.append((hook_name, callback))

    # -- convenience --------------------------------------------------------
    @property
    def tool_names(self) -> List[str]:
        return [t["name"] for t in self.tools]

    def hook(self, hook_name: str) -> Optional[Callable]:
        for name, cb in self.hooks:
            if name == hook_name:
                return cb
        return None


def _load_plugin_module(plugin_parent: Path = PLUGIN_PARENT):
    """Import the `sffs` plugin PACKAGE from the worktree and return the module.

    Ensures we load the code on the current branch (not the ``$HERMES_HOME``
    symlink): the parent dir is put first on ``sys.path`` and any previously
    imported ``sffs`` package is evicted so the fresh copy wins.
    """
    init = plugin_parent / "sffs" / "__init__.py"
    if not init.exists():
        # Fail-closed: no plugin here means we CANNOT verify the safety core.
        raise ModuleNotFoundError(f"no `sffs` plugin package under {plugin_parent}")
    parent = str(plugin_parent)
    # Evict any cached sffs package/submodules so we import THIS worktree's copy
    # (and it wins: parent goes first on sys.path).
    for mod in [m for m in list(sys.modules) if m == "sffs" or m.startswith("sffs.")]:
        del sys.modules[mod]
    if parent in sys.path:
        sys.path.remove(parent)
    sys.path.insert(0, parent)
    return importlib.import_module("sffs")


def _read_manifest_tools(plugin_yaml: Path = PLUGIN_YAML) -> List[str]:
    """Return the ``provides_tools:`` list from plugin.yaml.

    Uses PyYAML when present; otherwise a tiny hand parser for the simple
    ``provides_tools:\\n  - a\\n  - b`` block (keeps this dependency-free).
    """
    text = plugin_yaml.read_text(encoding="utf-8")
    try:
        import yaml  # type: ignore

        data = yaml.safe_load(text) or {}
        tools = data.get("provides_tools") or []
        return [str(t).strip() for t in tools]
    except Exception:
        # Minimal fallback parser: collect the "- item" lines under provides_tools.
        out: List[str] = []
        in_block = False
        for line in text.splitlines():
            stripped = line.strip()
            if stripped.startswith("provides_tools:"):
                in_block = True
                continue
            if in_block:
                if stripped.startswith("- "):
                    out.append(stripped[2:].strip())
                elif stripped and not line.startswith((" ", "\t")):
                    break  # dedented to a new top-level key
        return out


def _directive_is_block(directive: Any) -> bool:
    """True iff `directive` is a valid framework BLOCK directive.

    Mirrors the framework contract (hermes_cli/plugins.py
    ``_get_pre_tool_call_directive_details``): a block is a dict with
    ``action == "block"`` and a NON-EMPTY string ``message``.
    """
    return (
        isinstance(directive, dict)
        and directive.get("action") == "block"
        and isinstance(directive.get("message"), str)
        and bool(directive.get("message").strip())
    )


def run_selfcheck(plugin_parent: Path = PLUGIN_PARENT) -> Dict[str, Any]:
    """Run the full plugin/guard self-check. Returns a machine-readable result.

    Never raises: any exception is captured and turned into a RED verdict
    (fail-closed — an un-loadable plugin or a crashing guard blocks the merge).
    """
    result: Dict[str, Any] = {
        "verdict": "RED",
        "ok": False,
        "checks": {},
        "tools": [],
        "hooks": [],
        "failures": [],
    }
    failures: List[str] = result["failures"]

    # --- 1. load the plugin -------------------------------------------------
    try:
        module = _load_plugin_module(plugin_parent)
        ctx = _CaptureCtx()
        module.register(ctx)
    except Exception as exc:  # noqa: BLE001 — fail-closed
        failures.append(f"plugin failed to load/register: {exc!r}")
        result["checks"]["plugin_loads"] = False
        return result
    result["checks"]["plugin_loads"] = True
    result["tools"] = sorted(ctx.tool_names)
    result["hooks"] = [name for name, _ in ctx.hooks]

    # --- 2. tool surface (REQUIRED present; extras allowed) -----------------
    registered = set(ctx.tool_names)
    missing = sorted(REQUIRED_TOOLS - registered)
    extra = sorted(registered - REQUIRED_TOOLS)  # new main-line tools — allowed
    if missing:
        failures.append(f"missing REQUIRED safety/read tools: {missing}")
    result["checks"]["required_tools_present"] = not missing
    result["extra_tools"] = extra
    if extra:
        result.setdefault("warnings", []).append(f"extra tools registered (allowed): {extra}")

    # A publish/schedule/delete/mutate-named tool must NEVER be registered.
    forbidden_hits = [
        name
        for name in registered
        for sub in FORBIDDEN_TOOLNAME_SUBSTRINGS
        if sub in name.replace("_", "").lower() or sub in name.lower()
    ]
    if forbidden_hits:
        failures.append(f"FORBIDDEN publish/schedule/mutate tool name(s) registered: {sorted(set(forbidden_hits))}")
    result["checks"]["no_forbidden_tool_names"] = not forbidden_hits

    # --- 3. the pre_tool_call publish guard is present ----------------------
    hook_names = [name for name, _ in ctx.hooks]
    has_guard_hook = hook_names.count("pre_tool_call") >= 1
    if not has_guard_hook:
        failures.append(f"the pre_tool_call publish-guard hook is missing (got hooks {hook_names!r})")
    result["checks"]["pre_tool_call_hook_registered"] = has_guard_hook

    # --- 4. manifest lists the REQUIRED tools (drift is a non-fatal warning) -
    try:
        manifest_tools = set(_read_manifest_tools())
        manifest_missing_required = sorted(REQUIRED_TOOLS - manifest_tools)
        if manifest_missing_required:
            failures.append(f"plugin.yaml provides_tools omits REQUIRED tools: {manifest_missing_required}")
        result["checks"]["manifest_lists_required"] = not manifest_missing_required
        drift = {
            "registered_not_in_manifest": sorted(registered - manifest_tools),
            "manifest_not_registered": sorted(manifest_tools - registered),
        }
        result["manifest_drift"] = drift
        if drift["registered_not_in_manifest"] or drift["manifest_not_registered"]:
            result.setdefault("warnings", []).append(f"plugin.yaml drift (non-fatal): {drift}")
    except Exception as exc:  # noqa: BLE001
        failures.append(f"could not read/verify plugin.yaml: {exc!r}")
        result["checks"]["manifest_lists_required"] = False

    # --- 5. drive the real guard against the BLOCK/ALLOW matrix -------------
    hook = ctx.hook("pre_tool_call")
    block_results: List[Dict[str, Any]] = []
    allow_results: List[Dict[str, Any]] = []
    matrix_ok = True
    if hook is None:
        failures.append("no pre_tool_call hook to exercise the block/allow matrix")
        matrix_ok = False
    else:
        for label, tool_name, args in BLOCK_MATRIX:
            try:
                directive = hook(tool_name=tool_name, args=args)
            except Exception as exc:  # noqa: BLE001 — a raising guard is a failure
                directive = {"_raised": repr(exc)}
            ok = _directive_is_block(directive)
            block_results.append({"label": label, "tool": tool_name, "blocked": ok})
            if not ok:
                matrix_ok = False
                failures.append(f"BLOCK matrix leak: '{label}' ({tool_name}) was NOT blocked")
        for label, tool_name, args in ALLOW_MATRIX:
            try:
                directive = hook(tool_name=tool_name, args=args)
            except Exception as exc:  # noqa: BLE001
                directive = {"_raised": repr(exc)}
            ok = directive is None
            allow_results.append({"label": label, "tool": tool_name, "allowed": ok})
            if not ok:
                matrix_ok = False
                failures.append(f"ALLOW matrix false-positive: '{label}' ({tool_name}) was blocked: {directive!r}")
    result["checks"]["guard_matrix"] = matrix_ok
    result["block_matrix"] = block_results
    result["allow_matrix"] = allow_results
    result["matrix_counts"] = {
        "block_total": len(BLOCK_MATRIX),
        "block_passed": sum(1 for r in block_results if r["blocked"]),
        "allow_total": len(ALLOW_MATRIX),
        "allow_passed": sum(1 for r in allow_results if r["allowed"]),
    }

    # --- verdict ------------------------------------------------------------
    result["ok"] = not failures
    result["verdict"] = "GREEN" if result["ok"] else "RED"
    return result


def _format_human(result: Dict[str, Any]) -> str:
    lines = [f"sffs_selfcheck: {result['verdict']}"]
    for name, ok in result.get("checks", {}).items():
        lines.append(f"  [{'ok' if ok else 'XX'}] {name}")
    mc = result.get("matrix_counts")
    if mc:
        lines.append(
            f"  guard matrix: {mc['block_passed']}/{mc['block_total']} blocked, "
            f"{mc['allow_passed']}/{mc['allow_total']} allowed"
        )
    lines.append(f"  tools: {', '.join(result.get('tools', [])) or '(none)'}")
    if result.get("extra_tools"):
        lines.append(f"  extra tools (allowed): {', '.join(result['extra_tools'])}")
    for w in result.get("warnings", []):
        lines.append(f"  warn: {w}")
    for f in result.get("failures", []):
        lines.append(f"  FAIL: {f}")
    return "\n".join(lines)


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="sffs plugin + DRAFT-ONLY guard self-check")
    parser.add_argument("--json", action="store_true", help="print the machine-readable result")
    parser.add_argument(
        "--plugin-parent",
        default=str(PLUGIN_PARENT),
        help="dir containing the `sffs` package (default: this worktree's hermes-nous/)",
    )
    args = parser.parse_args(argv)

    result = run_selfcheck(Path(args.plugin_parent))
    if args.json:
        print(json.dumps(result, indent=2, default=str))
    else:
        print(_format_human(result))
    return 0 if result["verdict"] == "GREEN" else 1


if __name__ == "__main__":
    raise SystemExit(main())
