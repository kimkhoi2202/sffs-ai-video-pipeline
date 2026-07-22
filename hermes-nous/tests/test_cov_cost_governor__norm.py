"""Auto-generated characterization tests for cost_governor._norm (SFFS software factory).

Locks in the CURRENT behavior of a previously-untested pure helper — the
expected values were captured by EXECUTING the real function, so this raises
genuine coverage and is green by construction. Additive, test-only: introduces
no publish / schedule / delete / mutate path (DRAFT-ONLY preserved).
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "sffs"))

import cost_governor as m  # noqa: E402


def test__norm_characterization():
    assert m._norm('') == ''
    assert m._norm('{"a": 1}') == 'a1'
    assert m._norm('hello') == 'hello'
    assert m._norm('42') == '42'
