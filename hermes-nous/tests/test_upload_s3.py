"""S3 UPLOAD tool test — proves sffs_upload_s3 validates its args, runs subprocess-
free in dry-run, surfaces errors as results (never raises), and that its args are
NOT flagged by the framework's publish/schedule defense-in-depth guard (hosting
media is not a posting action).

No network, no node, no credentials: imports the pure module (``upload_s3``)
directly and stubs the Node bridge via monkeypatch. A dry-run / bad-arg call must
NEVER reach the bridge (asserted with a spy that fails if called).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

PLUGIN_DIR = Path(__file__).resolve().parents[1] / "sffs"
sys.path.insert(0, str(PLUGIN_DIR))

import upload_s3  # noqa: E402
import publish_guard as pg  # noqa: E402


def _no_bridge(*_a, **_k):
    raise AssertionError("run_node_bridge must NOT be called on a dry-run / refused path")


# ===========================================================================
# build_upload_request — pure arg guard
# ===========================================================================


def test_minimal_local_path_only():
    req = upload_s3.build_upload_request({"local_path": "/tmp/v01.mp4"})
    assert req["local_path"] == "/tmp/v01.mp4"
    assert req["dest_key"] is None


def test_with_dest_key():
    req = upload_s3.build_upload_request({"local_path": "/tmp/v01.mp4", "dest_key": "sffs/2026-07-22/v01.mp4"})
    assert req["dest_key"] == "sffs/2026-07-22/v01.mp4"


def test_local_path_is_trimmed():
    req = upload_s3.build_upload_request({"local_path": "  /tmp/v.mp4  "})
    assert req["local_path"] == "/tmp/v.mp4"


def test_dest_key_leading_slash_kept_but_no_traversal():
    # leading slash is allowed (buildKey strips it); only '..' is rejected
    req = upload_s3.build_upload_request({"local_path": "/tmp/v.mp4", "dest_key": "/abs/key.mp4"})
    assert req["dest_key"] == "/abs/key.mp4"


@pytest.mark.parametrize(
    "bad",
    [
        None,                                                    # not a dict
        "nope",                                                  # not a dict
        {},                                                      # no local_path
        {"local_path": ""},                                      # empty local_path
        {"local_path": "   "},                                   # blank local_path
        {"local_path": 123},                                     # non-string
        {"local_path": "/tmp/v.mp4", "dest_key": ""},            # empty dest_key
        {"local_path": "/tmp/v.mp4", "dest_key": 5},             # non-string dest_key
        {"local_path": "/tmp/v.mp4", "dest_key": "../escape.mp4"},   # traversal
        {"local_path": "/tmp/v.mp4", "dest_key": "a/../../b.mp4"},   # nested traversal
        {"local_path": "/tmp/v.mp4", "dest_key": ".."},          # traversal only
    ],
)
def test_upload_request_rejects_bad(bad):
    with pytest.raises(upload_s3.UploadGuardError):
        upload_s3.build_upload_request(bad)


# ===========================================================================
# sffs_upload_s3 handler — dry-run is subprocess-free
# ===========================================================================


def test_dry_run_makes_no_subprocess(monkeypatch):
    monkeypatch.setattr(upload_s3, "run_node_bridge", _no_bridge)
    out = upload_s3.sffs_upload_s3({"local_path": "/tmp/v01.mp4", "dest_key": "k/v01.mp4", "dry_run": True})
    data = json.loads(out)
    assert data["ok"] is True and data["dry_run"] is True
    assert data["local_path"] == "/tmp/v01.mp4" and data["dest_key"] == "k/v01.mp4"


def test_dry_run_without_dest_key(monkeypatch):
    monkeypatch.setattr(upload_s3, "run_node_bridge", _no_bridge)
    out = upload_s3.sffs_upload_s3({"local_path": "/tmp/v01.mp4", "dry_run": True})
    data = json.loads(out)
    assert data["ok"] is True and data["dry_run"] is True and data["dest_key"] is None


def test_live_success_passes_params_and_returns_url(monkeypatch):
    captured = {}

    def fake_bridge(stdin_obj, *, dry_run, timeout=300):
        captured["stdin"] = stdin_obj
        captured["dry_run"] = dry_run
        return {"ok": True, "url": "https://hermes-sffs-media.s3.us-east-1.amazonaws.com/v01.mp4?X-Amz-Signature=abc", "key": "v01.mp4", "provider": "s3", "bytes": 1087051}

    monkeypatch.setattr(upload_s3, "run_node_bridge", fake_bridge)
    out = upload_s3.sffs_upload_s3({"local_path": "/tmp/v01.mp4"})
    data = json.loads(out)
    assert data["ok"] is True and data["provider"] == "s3"
    assert "X-Amz-Signature" in data["url"]
    assert captured["stdin"] == {"local_path": "/tmp/v01.mp4"}  # no dest_key when absent
    assert captured["dry_run"] is False


def test_live_success_includes_dest_key(monkeypatch):
    captured = {}

    def fake_bridge(stdin_obj, *, dry_run, timeout=300):
        captured["stdin"] = stdin_obj
        return {"ok": True, "url": "https://x/y", "key": "d/v.mp4", "provider": "s3", "bytes": 10}

    monkeypatch.setattr(upload_s3, "run_node_bridge", fake_bridge)
    upload_s3.sffs_upload_s3({"local_path": "/tmp/v.mp4", "dest_key": "d/v.mp4"})
    assert captured["stdin"] == {"local_path": "/tmp/v.mp4", "dest_key": "d/v.mp4"}


def test_bad_args_refused_without_bridge(monkeypatch):
    monkeypatch.setattr(upload_s3, "run_node_bridge", _no_bridge)
    out = upload_s3.sffs_upload_s3({"dest_key": "k.mp4"})  # missing local_path
    data = json.loads(out)
    assert data["ok"] is False
    assert "local_path" in data["error"]


def test_live_error_is_reported_not_raised(monkeypatch):
    def boom(*_a, **_k):
        raise upload_s3.UploadGuardError("bridge failed (exit 1): S3 PutObject failed (HTTP 403)")

    monkeypatch.setattr(upload_s3, "run_node_bridge", boom)
    out = upload_s3.sffs_upload_s3({"local_path": "/tmp/v.mp4"})
    data = json.loads(out)
    assert data["ok"] is False
    assert "403" in data["error"]


def test_non_object_bridge_result_is_error(monkeypatch):
    monkeypatch.setattr(upload_s3, "run_node_bridge", lambda *a, **k: "just-a-url")
    out = upload_s3.sffs_upload_s3({"local_path": "/tmp/v.mp4"})
    data = json.loads(out)
    assert data["ok"] is False and "non-object" in data["error"]


# ===========================================================================
# Handler NEVER raises on garbage
# ===========================================================================


@pytest.mark.parametrize("garbage", [None, 42, "nope", [], {"local_path": 5}, {"dest_key": ".."}])
def test_handler_never_raises_on_garbage(monkeypatch, garbage):
    monkeypatch.setattr(upload_s3, "run_node_bridge", _no_bridge)
    out = upload_s3.sffs_upload_s3(garbage)
    assert isinstance(out, str)
    assert "ok" in json.loads(out)


# ===========================================================================
# Cross-check: the UPLOAD tool's args are NEVER flagged by the publish/schedule
# defense-in-depth guard (hosting media is not a posting action), while a genuine
# publish is still blocked.
# ===========================================================================


def test_upload_tool_args_are_not_flagged_by_publish_guard():
    assert pg.refusal_reason("sffs_upload_s3", {"local_path": "/tmp/v.mp4"}) is None
    assert pg.refusal_reason("sffs_upload_s3", {"local_path": "/tmp/v.mp4", "dest_key": "sffs/v01.mp4"}) is None


def test_guard_would_still_block_a_real_publish():
    assert pg.refusal_reason("publer_publish_post_now", {}) is not None
    assert pg.refusal_reason("publer_update_post", {"id": "x"}) is not None
