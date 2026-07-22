"""Auto-generated characterization tests for cost_governor._block (SFFS software factory).

Locks in the CURRENT behavior of a previously-untested pure helper — the
expected values were captured by EXECUTING the real function, so this raises
genuine coverage and is green by construction. Additive, test-only: introduces
no publish / schedule / delete / mutate path (DRAFT-ONLY preserved).
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "sffs"))

import cost_governor as m  # noqa: E402


def test__block_characterization():
    assert m._block('') == {'action': 'block', 'message': 'REFUSED by the SFFS cost governor: . New subagent/LLM/render work is halted (aggressive-but-bounded cost stance on a shared sandbox). This halts SPEND only — it does NOT affect the DRAFT-ONLY posting belt. To resume: clear the kill-switch (env SFFS_FACTORY_KILL / stop-file) or wait for the daily ceiling to roll over (or raise SFFS_COST_MAX_* limits).'}
    assert m._block('{"a": 1}') == {'action': 'block', 'message': 'REFUSED by the SFFS cost governor: {"a": 1}. New subagent/LLM/render work is halted (aggressive-but-bounded cost stance on a shared sandbox). This halts SPEND only — it does NOT affect the DRAFT-ONLY posting belt. To resume: clear the kill-switch (env SFFS_FACTORY_KILL / stop-file) or wait for the daily ceiling to roll over (or raise SFFS_COST_MAX_* limits).'}
    assert m._block('hello') == {'action': 'block', 'message': 'REFUSED by the SFFS cost governor: hello. New subagent/LLM/render work is halted (aggressive-but-bounded cost stance on a shared sandbox). This halts SPEND only — it does NOT affect the DRAFT-ONLY posting belt. To resume: clear the kill-switch (env SFFS_FACTORY_KILL / stop-file) or wait for the daily ceiling to roll over (or raise SFFS_COST_MAX_* limits).'}
    assert m._block('42') == {'action': 'block', 'message': 'REFUSED by the SFFS cost governor: 42. New subagent/LLM/render work is halted (aggressive-but-bounded cost stance on a shared sandbox). This halts SPEND only — it does NOT affect the DRAFT-ONLY posting belt. To resume: clear the kill-switch (env SFFS_FACTORY_KILL / stop-file) or wait for the daily ceiling to roll over (or raise SFFS_COST_MAX_* limits).'}
