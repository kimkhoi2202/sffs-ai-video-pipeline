"""E2E tests for the review agent (:mod:`review_agent`) — key #2.

Covers the deterministic static safety floor (no false positives on the REAL
guard code, every malicious/tamper class caught) and the fail-closed verdict
logic (with an injected model runner — no tokens spent)."""

from __future__ import annotations

from pathlib import Path

import pytest

import review_agent as ra

REPO = Path(__file__).resolve().parents[2].parent  # sffs-ai-video-pipeline
CORE_FILES = [
    "hermes-nous/sffs/publish_guard.py",
    "hermes-nous/sffs/donottouch.py",
    "hermes-nous/sffs/reads.py",
    "hermes-nous/sffs/schemas.py",
    "hermes-nous/sffs/__init__.py",
    "hermes-nous/sffs/plugin.yaml",
    "hermes-nous/bridge/donottouch.ts",
    # metricool-read.ts is safety-core (review_agent.SAFETY_CORE_FILES lists it and
    # raises scrutiny on any change) but is deliberately NOT in this no-false-positive
    # sweep: it PROJECTS the board's `auto_publish` flag into its read response, and the
    # static scan cannot tell that read-mapping apart from an assignment that SETS a
    # scheduling field. Reporting that flag is what makes the approval gate visible on
    # the dashboard, so the scan stays strict and this file is reviewed by a human.
]
TEST_FILES = [
    "hermes-nous/tests/test_publish_guard.py",
    "hermes-nous/tests/test_donottouch.py",
    "hermes-nous/tests/test_reads.py",
]


def _add_diff(files):
    chunks = []
    for f in files:
        body = (REPO / f).read_text(encoding="utf-8")
        chunks.append(
            f"diff --git a/{f} b/{f}\n--- /dev/null\n+++ b/{f}\n"
            + "".join("+" + ln + "\n" for ln in body.splitlines())
        )
    return "\n".join(chunks)


# --- static scan: NO false positives on our own code (regression lock) -------
def test_static_scan_no_false_positive_on_real_safety_core():
    scan = ra.static_safety_scan(_add_diff(CORE_FILES))
    assert scan["ok"] is True, scan["findings"]
    assert scan["touches_guard"] is True  # it DID recognize the safety-core files


def test_static_scan_no_false_positive_on_real_tests():
    scan = ra.static_safety_scan(_add_diff(TEST_FILES))
    assert scan["ok"] is True, scan["findings"]


# --- static scan: every malicious / tamper class is caught -------------------
_MALICIOUS = {
    "schedulePost import in bridge": "+++ b/hermes-nous/bridge/metricool-read.ts\n+import { schedulePost } from \"../../hermes/src/guardrails.ts\";",
    "schedulePost call in bridge": "+++ b/hermes-nous/bridge/x.ts\n+  await schedulePost({});",
    "register publish tool": "+++ b/hermes-nous/sffs/__init__.py\n+    ctx.register_tool(name=\"sffs_publish_now\", handler=h)",
    "quoted publish tool name": "+++ b/hermes-nous/sffs/reads.py\n+    T = \"metricool_publish_post_now\"",
    "live state subscript": "+++ b/hermes-nous/sffs/publish_guard.py\n+    payload[\"state\"] = \"published\"",
    "live state dict": "+++ b/hermes-nous/sffs/x.py\n+    body = {\"state\": \"scheduled\"}",
    "scheduling key subscript": "+++ b/hermes-nous/sffs/x.py\n+    req[\"scheduled_at\"] = when",
    "frozen constant tamper": "+++ b/hermes-nous/sffs/publish_guard.py\n-ALLOWED_POST_STATE = \"draft\"\n+ALLOWED_POST_STATE = \"published\"",
    "remove guard hook": "+++ b/hermes-nous/sffs/__init__.py\n-    ctx.register_hook(\"pre_tool_call\", publish_guard.pre_tool_call)",
}


@pytest.mark.parametrize("label,body", list(_MALICIOUS.items()), ids=list(_MALICIOUS))
def test_static_scan_catches_malicious(label, body):
    diff = "diff --git a/x b/x\n--- a/x\n" + body + "\n"
    scan = ra.static_safety_scan(diff)
    assert scan["ok"] is False, f"{label} should have been caught"
    assert scan["findings"]


# --- verdict parsing ---------------------------------------------------------
def test_parse_model_verdict_variants():
    assert ra.parse_model_verdict("bla\nVERDICT: APPROVE\nREASONS: fine")[0] == "APPROVE"
    assert ra.parse_model_verdict("VERDICT: REJECT\nREASONS: nope")[0] == "REJECT"
    # last verdict wins
    assert ra.parse_model_verdict("VERDICT: APPROVE\n...\nVERDICT: REJECT")[0] == "REJECT"
    assert ra.parse_model_verdict("no verdict here")[0] is None
    assert ra.parse_model_verdict("")[0] is None


# --- review(): fail-closed behaviours (injected model runner) ----------------
BENIGN = (
    "diff --git a/hermes-nous/sffs/reads.py b/hermes-nous/sffs/reads.py\n"
    "--- a/hermes-nous/sffs/reads.py\n+++ b/hermes-nous/sffs/reads.py\n"
    "+# a clarifying comment only\n"
)
MALICIOUS = (
    "diff --git a/hermes-nous/bridge/metricool-read.ts b/hermes-nous/bridge/metricool-read.ts\n"
    "--- a/hermes-nous/bridge/metricool-read.ts\n+++ b/hermes-nous/bridge/metricool-read.ts\n"
    "+  await schedulePost({ scheduled_at: \"2026-08-01\" });\n"
)


def test_empty_diff_is_rejected():
    assert ra.review("", require_model=True)["verdict"] == "REJECT"
    assert ra.review("   ", require_model=True)["verdict"] == "REJECT"


def test_static_reject_overrides_model_approve():
    # Even if the model would approve, a static safety hit is a hard REJECT.
    res = ra.review(MALICIOUS, model_runner=lambda p: "VERDICT: APPROVE", require_model=True)
    assert res["verdict"] == "REJECT"
    assert res["source"] == "static"


def test_benign_plus_model_approve_is_approved():
    res = ra.review(BENIGN, model_runner=lambda p: "ok\nVERDICT: APPROVE\nREASONS: comment", require_model=True)
    assert res["verdict"] == "APPROVE"
    assert res["source"] == "static+model"


def test_benign_but_model_rejects():
    res = ra.review(BENIGN, model_runner=lambda p: "VERDICT: REJECT\nREASONS: meh", require_model=True)
    assert res["verdict"] == "REJECT"


def test_model_error_is_fail_closed():
    def boom(_p):
        raise RuntimeError("gateway down")
    res = ra.review(BENIGN, model_runner=boom, require_model=True)
    assert res["verdict"] == "REJECT"
    assert "fail-closed" in " ".join(res["reasons"]).lower()


def test_unparseable_model_reply_is_fail_closed():
    res = ra.review(BENIGN, model_runner=lambda p: "I guess it's fine", require_model=True)
    assert res["verdict"] == "REJECT"


def test_offline_static_only_approves_clean_diff():
    res = ra.review(BENIGN, require_model=False)
    assert res["verdict"] == "APPROVE"
    assert res["source"] == "static-only"


def test_offline_static_only_rejects_malicious():
    res = ra.review(MALICIOUS, require_model=False)
    assert res["verdict"] == "REJECT"
