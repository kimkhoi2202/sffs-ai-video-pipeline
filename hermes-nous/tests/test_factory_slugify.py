"""Regression tests for factory.slugify — clean, git-branch-safe workstream slugs.

slugify() turns a free-text factory goal into a git BRANCH name
(``sffs-factory/<slug>``). A slug that ends in ``-`` (which truncation can
produce) makes an awkward branch name; empty/garbage input must fall back to a
stable default. These lock in that the slug is always a clean, hyphen-trimmed,
lowercase-alnum token of bounded length.

Hermetic: stdlib-only, no network/node/model/framework (mirrors test_factory.py).
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

PLUGIN_DIR = Path(__file__).resolve().parents[1] / "sffs"
sys.path.insert(0, str(PLUGIN_DIR))

import factory  # noqa: E402

_SLUG_RE = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*")


def test_basic_slug():
    assert factory.slugify("Improve render sanity gate") == "improve-render-sanity-gate"


def test_empty_and_garbage_fall_back_to_default():
    assert factory.slugify("") == "workstream"
    assert factory.slugify(None) == "workstream"
    assert factory.slugify("   ") == "workstream"
    assert factory.slugify("!!!  ---  ???") == "workstream"


def test_collapses_and_trims_separators():
    assert factory.slugify("  Hello,   World!!  ") == "hello-world"
    s = factory.slugify("a b c")
    assert not s.startswith("-") and not s.endswith("-")


def test_truncation_never_leaves_a_trailing_hyphen():
    # A goal whose 48-char boundary lands on a separator must NOT yield a slug
    # ending in '-' (the exact edge this fix hardens). Before the fix, s[:48]
    # could end in '-'; after it, the trailing separator is always trimmed.
    goal = "x" * 47 + " tail words here"
    s = factory.slugify(goal)
    assert len(s) <= 48
    assert not s.startswith("-")
    assert not s.endswith("-")


def test_slug_is_always_git_branch_safe():
    for goal in (
        "Feature: add A/B narration metrics!!!",
        "fix   the    render-sanity gate (ffprobe) --- now",
        "UPPER CASE GOAL with 123 numbers",
        "x" * 200,
    ):
        s = factory.slugify(goal)
        assert s, "slug must never be empty"
        assert _SLUG_RE.fullmatch(s), f"slug not branch-safe: {s!r}"
        assert len(s) <= 48
