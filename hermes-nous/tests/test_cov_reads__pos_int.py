"""Auto-generated characterization tests for reads._pos_int (SFFS software factory).

Locks in the CURRENT behavior of a previously-untested pure helper — the
expected values were captured by EXECUTING the real function, so this raises
genuine coverage and is green by construction. Additive, test-only: introduces
no publish / schedule / delete / mutate path (DRAFT-ONLY preserved).
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "sffs"))

import reads as m  # noqa: E402


def test__pos_int_characterization():
    assert m._pos_int(0, '', allow_zero=True) == 0
    assert m._pos_int(0, '{"a": 1}', allow_zero=True) == 0
    assert m._pos_int(0, 'hello', allow_zero=True) == 0
    assert m._pos_int(0, '42', allow_zero=True) == 0
    assert m._pos_int(1, '', allow_zero=True) == 1
