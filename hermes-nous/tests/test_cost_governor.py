"""COST GOVERNOR tests — the AGGRESSIVE-BUT-BOUNDED spend brake + kill-switch.

Proves the governor: detects the kill-switch (env + stop-file, the same surface
the dashboard/auto_merge gate read); loads HIGH-but-finite limits (env-overridable,
garbage-robust); tallies estimated $/tokens/spawns from an append-only JSONL ledger
(corrupt-line-safe); tracks concurrent children with TTL self-healing; and — via the
real pre_tool_call hook — HARD-BLOCKS the factory (delegate_task/sffs_factory), the
loop (sffs_cycle), and heavy spend (render/score_rollup) when killed or over a
ceiling, while NEVER touching cheap read/draft tools (the DRAFT-ONLY belt is a
separate hook) and NEVER raising on garbage.

Hermetic: stdlib-only, no network/node/framework. Imports the pure module directly
and uses a tmp state dir; the kill-switch never touches a real stop-file.
"""

from __future__ import annotations

import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import pytest

PLUGIN_DIR = Path(__file__).resolve().parents[1] / "sffs"
sys.path.insert(0, str(PLUGIN_DIR))

import cost_governor as cg  # noqa: E402
import publish_guard as pg  # noqa: E402

FIXED_NOW = datetime(2026, 7, 22, 12, 0, 0, tzinfo=timezone.utc)


def _is_block(d) -> bool:
    return (
        isinstance(d, dict)
        and d.get("action") == "block"
        and isinstance(d.get("message"), str)
        and bool(d["message"].strip())
    )


# ===========================================================================
# Kill-switch
# ===========================================================================
@pytest.mark.parametrize("val,engaged", [
    ("1", True), ("true", True), ("TRUE", True), ("yes", True), ("on", True),
    ("0", False), ("false", False), ("", False), ("nope", False),
])
def test_kill_env_truthiness(val, engaged):
    for name in cg.ENV_KILL_VARS:
        r = cg.kill_switch_reason({name: val}, files=[])
        assert (r is not None) is engaged
        if engaged:
            assert name in r


def test_kill_both_env_vars_recognized():
    assert cg.kill_switch_reason({"SFFS_FACTORY_KILL": "1"}, files=[]) is not None
    assert cg.kill_switch_reason({"HERMES_SFFS_FACTORY_KILL": "on"}, files=[]) is not None
    assert cg.kill_switch_reason({"UNRELATED": "1"}, files=[]) is None


def test_kill_stop_file(tmp_path):
    stop = tmp_path / "STOP"
    assert cg.kill_switch_reason({}, files=[str(stop)]) is None
    stop.write_text("halt")
    r = cg.kill_switch_reason({}, files=[str(stop)])
    assert r is not None and "stop-file" in r


def test_kill_file_exists_error_is_swallowed():
    def boom(_p):
        raise OSError("boom")
    assert cg.kill_switch_reason({}, files=["/x"], file_exists=boom) is None


def test_default_kill_files_matches_dashboard_surface(tmp_path):
    env = {"HERMES_DATA_DIR": str(tmp_path), "HERMES_HOME": str(tmp_path / "home"),
           "SFFS_KILL_FILE": str(tmp_path / "custom-stop")}
    files = cg.default_kill_files(env)
    assert str(tmp_path / "custom-stop") in files              # SFFS_KILL_FILE override
    assert any(f.endswith("scripts/gate/STOP") for f in files)  # gate STOP
    assert str(tmp_path / "FACTORY_STOP") in files             # DATA_DIR/FACTORY_STOP
    assert str(tmp_path / "home" / "sffs-data" / "FACTORY_STOP") in files


# ===========================================================================
# Limits + pricing
# ===========================================================================
def test_limits_defaults_are_high_but_finite():
    lim = cg.load_limits({})
    assert lim.max_usd_per_day == 75.0
    assert lim.max_tokens_per_day == 40_000_000
    assert lim.max_concurrent_children == 8
    assert lim.max_spawns_per_day == 500
    # finite (a real hard stop, not unbounded)
    for v in lim.as_dict().values():
        assert v not in (0, float("inf"))


def test_limits_env_overrides_and_garbage():
    lim = cg.load_limits({
        "SFFS_COST_MAX_USD_PER_DAY": "250",
        "SFFS_MAX_CONCURRENT_CHILDREN": "32",
        "SFFS_COST_MAX_TOKENS_PER_DAY": "not-a-number",  # falls back
        "SFFS_MAX_SUBAGENT_SPAWNS_PER_DAY": "-5",         # negative → fallback
    })
    assert lim.max_usd_per_day == 250.0
    assert lim.max_concurrent_children == 32
    assert lim.max_tokens_per_day == 40_000_000  # garbage → default
    assert lim.max_spawns_per_day == 500         # negative → default


def test_price_table_and_blended_override():
    # The gateway bills Opus at 5/25, not the 15/75 list rate this table used to carry.
    assert cg.price_for_model("claude-opus-5") == (5.0, 25.0)
    assert cg.price_for_model("claude-sonnet-5") == (3.0, 15.0)
    assert cg.price_for_model("claude-haiku-4-5") == (0.80, 4.0)
    # An unknown model is still priced at the LIST rate, which is now HIGHER than any
    # row in the table — the point is to over-count something nobody has measured.
    assert cg.price_for_model("some-unknown-model") == (15.0, 75.0)
    blended = cg.price_for_model("haiku", {"SFFS_COST_PRICE_IN_PER_MTOK": "1", "SFFS_COST_PRICE_OUT_PER_MTOK": "2"})
    assert blended == (1.0, 2.0)


def test_estimate_tokens_and_cost():
    assert cg.estimate_tokens("") == 0
    assert cg.estimate_tokens(None) == 0
    assert cg.estimate_tokens("a" * 40) == 10  # 40 chars / 4
    # 1M in + 1M out at opus = 5 + 25 = 30, at the rate the gateway actually bills.
    # It read 90 while the table carried the 15/75 list rate, which is why the daily
    # budget halted the loop at roughly a third of the spend it was configured for.
    assert cg.estimate_cost_usd(1_000_000, 1_000_000, "opus") == pytest.approx(30.0)


# ===========================================================================
# Ledger: usage + spawns
# ===========================================================================
def test_record_and_read_tally(tmp_path):
    cg.record_llm_usage(1000, 2000, "opus", sdir=tmp_path, now=FIXED_NOW)
    cg.record_llm_usage(500, 500, "haiku", sdir=tmp_path, now=FIXED_NOW)
    cg.record_spawn(3, sdir=tmp_path, now=FIXED_NOW)
    t = cg.read_tally(sdir=tmp_path, now=FIXED_NOW)
    assert t["input_tokens"] == 1500
    assert t["output_tokens"] == 2500
    assert t["tokens"] == 4000
    assert t["llm_calls"] == 2
    assert t["spawns"] == 3
    assert t["usd"] > 0


def test_tally_is_per_day(tmp_path):
    cg.record_llm_usage(1000, 1000, "opus", sdir=tmp_path, now=FIXED_NOW)
    other_day = datetime(2026, 7, 23, 1, 0, 0, tzinfo=timezone.utc)
    assert cg.read_tally(sdir=tmp_path, now=other_day)["tokens"] == 0  # different day file


def test_tally_skips_corrupt_lines(tmp_path):
    ledger = tmp_path / f"usage-{FIXED_NOW.strftime('%Y-%m-%d')}.jsonl"
    ledger.write_text(
        json.dumps({"kind": "llm", "input_tokens": 10, "output_tokens": 10, "usd": 0.1}) + "\n"
        + "THIS IS NOT JSON\n"
        + json.dumps({"kind": "llm", "input_tokens": 5, "output_tokens": 5, "usd": 0.05}) + "\n"
    )
    t = cg.read_tally(sdir=tmp_path, now=FIXED_NOW)
    assert t["tokens"] == 30 and t["llm_calls"] == 2  # corrupt line skipped


def test_tally_none_sdir_is_zero_and_noop():
    assert cg.read_tally(sdir=None, env={})["tokens"] == 0
    cg.record_llm_usage(1, 1, "opus", sdir=None, env={})  # must not raise


# ===========================================================================
# Concurrency (with TTL self-healing)
# ===========================================================================
def test_active_child_count_start_stop(tmp_path):
    assert cg.active_child_count(sdir=tmp_path) == 0
    cg.note_child_start("c1", sdir=tmp_path, now=1000.0)
    cg.note_child_start("c2", sdir=tmp_path, now=1000.0)
    assert cg.active_child_count(sdir=tmp_path, now=1001.0) == 2
    cg.note_child_stop("c1", sdir=tmp_path, now=1002.0)
    assert cg.active_child_count(sdir=tmp_path, now=1003.0) == 1


def test_active_child_count_ttl_drops_leaked(tmp_path):
    cg.note_child_start("leaked", sdir=tmp_path, now=1000.0)
    # far in the future, past the TTL, no stop event → not counted
    assert cg.active_child_count(sdir=tmp_path, now=1000.0 + cg._CHILD_TTL_SECONDS + 10) == 0


# ===========================================================================
# Pure decisions
# ===========================================================================
def test_ceiling_reason_usd_tokens_spawns():
    lim = cg.Limits(max_usd_per_day=10, max_tokens_per_day=1000, max_spawns_per_day=5)
    assert cg.ceiling_reason({"usd": 5, "tokens": 500, "spawns": 2}, lim) is None
    assert "spend" in cg.ceiling_reason({"usd": 10, "tokens": 0, "spawns": 0}, lim)
    assert "token" in cg.ceiling_reason({"usd": 0, "tokens": 1000, "spawns": 0}, lim)
    assert "spawn" in cg.ceiling_reason({"usd": 0, "tokens": 0, "spawns": 5}, lim)


def test_concurrency_reason():
    lim = cg.Limits(max_concurrent_children=8)
    assert cg.concurrency_reason(7, lim) is None
    assert cg.concurrency_reason(8, lim) is not None


# ===========================================================================
# Tool classification
# ===========================================================================
def test_tool_classification():
    assert cg.is_initiator("delegate_task")
    assert cg.is_initiator("sffs_cycle")
    assert cg.is_initiator("sffs_factory")
    assert not cg.is_initiator("sffs_render")          # render is kill-only, not an initiator
    assert not cg.is_initiator("sffs_publer_read")
    assert cg.is_kill_blocked("sffs_render")
    assert cg.is_kill_blocked("sffs_score_rollup")
    assert cg.is_kill_blocked("delegate_task")
    assert not cg.is_kill_blocked("sffs_publer_draft")  # cheap draft stays usable
    assert cg.is_delegate("delegate_task")
    assert not cg.is_delegate("sffs_cycle")


# ===========================================================================
# evaluate() — the composed decision
# ===========================================================================
def test_evaluate_clean_allows_everything(tmp_path):
    env = {"SFFS_COST_GOVERNOR_DIR": str(tmp_path)}
    for tool in ("delegate_task", "sffs_cycle", "sffs_factory", "sffs_render",
                 "sffs_publer_draft", "sffs_publer_read"):
        assert cg.evaluate(tool, env=env, now=FIXED_NOW) is None


def test_evaluate_kill_blocks_spend_set_only(tmp_path):
    env = {"SFFS_COST_GOVERNOR_DIR": str(tmp_path), "SFFS_FACTORY_KILL": "1"}
    for tool in ("delegate_task", "sffs_cycle", "sffs_factory", "sffs_render", "sffs_score_rollup"):
        assert _is_block(cg.evaluate(tool, env=env, now=FIXED_NOW)), tool
    # cheap / draft / read tools stay usable even when killed (spend brake, not posting belt)
    for tool in ("sffs_publer_draft", "sffs_publer_read", "sffs_donottouch_verify", "read_file"):
        assert cg.evaluate(tool, env=env, now=FIXED_NOW) is None, tool


def test_evaluate_ceiling_blocks_initiators_not_render(tmp_path):
    # write usage over the $ ceiling
    env = {"SFFS_COST_GOVERNOR_DIR": str(tmp_path), "SFFS_COST_MAX_USD_PER_DAY": "1"}
    cg.record_llm_usage(1_000_000, 1_000_000, "opus", sdir=tmp_path, now=FIXED_NOW)  # ~ $90
    assert _is_block(cg.evaluate("delegate_task", env=env, now=FIXED_NOW))
    assert _is_block(cg.evaluate("sffs_cycle", env=env, now=FIXED_NOW))
    # render is NOT a ceiling-initiator (kill-only) → allowed under a mere ceiling
    assert cg.evaluate("sffs_render", env=env, now=FIXED_NOW) is None
    # cheap tools always allowed
    assert cg.evaluate("sffs_publer_read", env=env, now=FIXED_NOW) is None


def test_evaluate_concurrency_blocks_delegate_only(tmp_path):
    env = {"SFFS_COST_GOVERNOR_DIR": str(tmp_path), "SFFS_MAX_CONCURRENT_CHILDREN": "2"}
    cg.note_child_start("c1", sdir=tmp_path)
    cg.note_child_start("c2", sdir=tmp_path)
    assert _is_block(cg.evaluate("delegate_task", env=env, now=FIXED_NOW))
    # sffs_cycle is an initiator but concurrency only gates delegate_task
    assert cg.evaluate("sffs_cycle", env=env, now=FIXED_NOW) is None


# ===========================================================================
# Hooks (use ambient os.environ via monkeypatch)
# ===========================================================================
def test_pre_tool_call_hook_blocks_when_killed(tmp_path, monkeypatch):
    monkeypatch.setenv("SFFS_COST_GOVERNOR_DIR", str(tmp_path))
    monkeypatch.setenv("SFFS_FACTORY_KILL", "1")
    assert _is_block(cg.pre_tool_call(tool_name="delegate_task", args={}))
    assert _is_block(cg.pre_tool_call(tool_name="sffs_cycle", args={}))
    assert cg.pre_tool_call(tool_name="sffs_publer_draft", args={"text": "x"}) is None


def test_pre_tool_call_hook_allows_when_clear(tmp_path, monkeypatch):
    monkeypatch.setenv("SFFS_COST_GOVERNOR_DIR", str(tmp_path))
    monkeypatch.delenv("SFFS_FACTORY_KILL", raising=False)
    monkeypatch.delenv("HERMES_SFFS_FACTORY_KILL", raising=False)
    assert cg.pre_tool_call(tool_name="delegate_task", args={"goal": "x"}) is None
    assert cg.pre_tool_call(tool_name="sffs_cycle", args={}) is None


def test_pre_tool_call_never_raises_on_garbage(tmp_path, monkeypatch):
    monkeypatch.setenv("SFFS_COST_GOVERNOR_DIR", str(tmp_path))
    for name, args in [(None, None), (123, []), ("", {"x": object()}), ("delegate_task", None)]:
        cg.pre_tool_call(tool_name=name, args=args)  # must not raise


def test_post_llm_call_records_usage(tmp_path, monkeypatch):
    monkeypatch.setenv("SFFS_COST_GOVERNOR_DIR", str(tmp_path))
    cg.post_llm_call(
        model="claude-opus-5",
        conversation_history=[{"role": "user", "content": "x" * 400}],
        assistant_response="y" * 800,
    )
    t = cg.read_tally(sdir=tmp_path)
    assert t["llm_calls"] == 1
    assert t["input_tokens"] == 100 and t["output_tokens"] == 200  # 400/4, 800/4
    assert t["usd"] > 0


def test_post_llm_call_never_raises_on_garbage(tmp_path, monkeypatch):
    monkeypatch.setenv("SFFS_COST_GOVERNOR_DIR", str(tmp_path))
    cg.post_llm_call()  # empty
    cg.post_llm_call(conversation_history="not-a-list", assistant_response=None, model=None)


def test_subagent_hooks_update_counts(tmp_path, monkeypatch):
    monkeypatch.setenv("SFFS_COST_GOVERNOR_DIR", str(tmp_path))
    cg.subagent_start(child_session_id="s1")
    cg.subagent_start(child_session_id="s2")
    assert cg.active_child_count(sdir=tmp_path) == 2
    assert cg.read_tally(sdir=tmp_path)["spawns"] == 2
    cg.subagent_stop(child_session_id="s1")
    assert cg.active_child_count(sdir=tmp_path) == 1
    cg.subagent_start()  # missing id → no-op, no raise
    cg.subagent_stop()


def test_pre_llm_call_injects_only_when_constrained(tmp_path, monkeypatch):
    monkeypatch.setenv("SFFS_COST_GOVERNOR_DIR", str(tmp_path))
    monkeypatch.delenv("SFFS_FACTORY_KILL", raising=False)
    monkeypatch.delenv("HERMES_SFFS_FACTORY_KILL", raising=False)
    assert cg.pre_llm_call(session_id="s") is None  # clear → no injection
    monkeypatch.setenv("SFFS_FACTORY_KILL", "1")
    out = cg.pre_llm_call(session_id="s")
    assert isinstance(out, dict) and "COST GOVERNOR" in out.get("context", "")


# ===========================================================================
# status() snapshot
# ===========================================================================
def test_status_snapshot(tmp_path, monkeypatch):
    monkeypatch.setenv("SFFS_COST_GOVERNOR_DIR", str(tmp_path))
    monkeypatch.setenv("SFFS_FACTORY_KILL", "1")
    # Hermetic: isolate from ambient operator cap overrides (e.g. a scaled-up
    # deployment that exports SFFS_COST_* in the service env) so this snapshot
    # asserts the built-in DEFAULT ceilings regardless of the runtime environment.
    for _k in ("SFFS_COST_MAX_USD_PER_DAY", "SFFS_COST_MAX_TOKENS_PER_DAY",
               "SFFS_MAX_CONCURRENT_CHILDREN", "SFFS_MAX_SUBAGENT_SPAWNS_PER_DAY"):
        monkeypatch.delenv(_k, raising=False)
    s = cg.status()
    assert s["kill_switch"]["engaged"] is True
    assert s["limits"]["max_usd_per_day"] == 75.0
    assert "today" in s and "active_children" in s


# ===========================================================================
# Separation of concerns: the governor is a SPEND brake, not the posting belt
# ===========================================================================
def test_governor_and_publish_guard_are_independent(tmp_path):
    env = {"SFFS_COST_GOVERNOR_DIR": str(tmp_path), "SFFS_FACTORY_KILL": "1"}
    # governor: kill halts spend but NOT the sanctioned draft path
    assert cg.evaluate("sffs_publer_draft", env=env, now=FIXED_NOW) is None
    # publish_guard: a real publish is STILL blocked regardless of the governor
    assert pg.refusal_reason("publer_publish_post_now", {"post_id": "p"}) is not None
    assert pg.refusal_reason("some_tool", {"scheduled_at": "2026-08-01T00:00:00Z"}) is not None


# ===========================================================================
# Observable snapshot (for a spend panel) — compact state + idempotent write
# ===========================================================================
def test_snapshot_shape_and_metrics(tmp_path):
    cg.record_llm_usage(1000, 3000, "opus", sdir=tmp_path, now=FIXED_NOW)  # 4000 tokens
    cg.record_spawn(2, sdir=tmp_path, now=FIXED_NOW)
    cg.note_child_start("c1", sdir=tmp_path)
    cg.note_child_start("c2", sdir=tmp_path)

    s = cg.snapshot(env={}, sdir=tmp_path, now=FIXED_NOW)

    assert set(s) >= {"ts", "day", "kill_switch", "metrics", "ceiling_reason", "state_dir"}
    assert s["day"] == "2026-07-22"
    assert s["state_dir"] == str(tmp_path)
    assert s["kill_switch"] == {"engaged": False, "reason": None}

    m = s["metrics"]
    assert set(m) == {"usd", "tokens", "spawns", "concurrent_children"}
    for name in m:
        assert set(m[name]) == {"value", "ceiling", "over"}  # each metric vs its ceiling
    # values reflect the ledger tally
    assert m["tokens"]["value"] == 4000
    assert m["spawns"]["value"] == 2
    assert m["concurrent_children"]["value"] == 2
    assert m["usd"]["value"] > 0
    # ceilings mirror the HIGH-but-finite defaults (env={} => defaults)
    assert m["usd"]["ceiling"] == 75.0
    assert m["tokens"]["ceiling"] == 40_000_000
    assert m["spawns"]["ceiling"] == 500
    assert m["concurrent_children"]["ceiling"] == 8
    # comfortably under everything => nothing over, no ceiling reason
    assert all(m[n]["over"] is False for n in m)
    assert s["ceiling_reason"] is None


def test_snapshot_reflects_ceilings_and_over_flag(tmp_path):
    env = {"SFFS_COST_MAX_USD_PER_DAY": "1", "SFFS_MAX_CONCURRENT_CHILDREN": "1"}
    cg.record_llm_usage(1_000_000, 1_000_000, "opus", sdir=tmp_path, now=FIXED_NOW)  # ~$90 > $1
    cg.note_child_start("c1", sdir=tmp_path)

    s = cg.snapshot(env=env, sdir=tmp_path, now=FIXED_NOW)
    assert s["metrics"]["usd"]["ceiling"] == 1.0
    assert s["metrics"]["usd"]["over"] is True
    assert s["metrics"]["concurrent_children"]["ceiling"] == 1
    assert s["metrics"]["concurrent_children"]["over"] is True
    # a metric under its (default) ceiling stays not-over
    assert s["metrics"]["tokens"]["over"] is False
    assert s["ceiling_reason"] is not None and "spend" in s["ceiling_reason"]


def test_snapshot_reports_kill_switch(tmp_path):
    s = cg.snapshot(env={"SFFS_FACTORY_KILL": "1"}, sdir=tmp_path, now=FIXED_NOW)
    assert s["kill_switch"]["engaged"] is True
    assert "kill-switch" in s["kill_switch"]["reason"]


def test_snapshot_is_side_effect_free(tmp_path):
    cg.record_llm_usage(100, 100, "opus", sdir=tmp_path, now=FIXED_NOW)
    before = cg.read_tally(sdir=tmp_path, now=FIXED_NOW)
    cg.snapshot(env={}, sdir=tmp_path, now=FIXED_NOW)
    cg.snapshot(env={}, sdir=tmp_path, now=FIXED_NOW)  # repeatable
    after = cg.read_tally(sdir=tmp_path, now=FIXED_NOW)
    assert before == after                                    # accounting untouched
    assert not (tmp_path / cg.SNAPSHOT_FILENAME).exists()     # snapshot() never writes


def test_write_snapshot_writes_into_existing_state_dir(tmp_path):
    cg.record_spawn(1, sdir=tmp_path, now=FIXED_NOW)
    p = cg.write_snapshot(env={}, sdir=tmp_path, now=FIXED_NOW)
    assert p == tmp_path / "snapshot.json"
    assert p.exists()
    data = json.loads(p.read_text())
    assert data["metrics"]["spawns"]["value"] == 1
    # idempotent: rewriting is safe and stays a valid snapshot at the same path
    p2 = cg.write_snapshot(env={}, sdir=tmp_path, now=FIXED_NOW)
    assert p2 == p
    assert json.loads(p.read_text())["metrics"]["spawns"]["value"] == 1


def test_write_snapshot_path_reuses_governor_state_dir(tmp_path):
    # path derivation must reuse state_dir() (SFFS_COST_GOVERNOR_DIR override wins),
    # NOT a new config path.
    env = {"SFFS_COST_GOVERNOR_DIR": str(tmp_path)}
    p = cg.write_snapshot(env=env, now=FIXED_NOW)  # no explicit sdir -> derived from env
    assert p == cg.state_dir(env) / "snapshot.json"
    assert p.exists()


def test_write_snapshot_none_when_no_state_dir():
    assert cg.write_snapshot(env={}) is None  # no dir hints -> nothing written, no raise
