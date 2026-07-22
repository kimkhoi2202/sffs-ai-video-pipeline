"""Auto-generated characterization tests for cost_governor._matches (SFFS software factory).

Locks in the CURRENT behavior of a previously-untested pure helper — the
expected values were captured by EXECUTING the real function, so this raises
genuine coverage and is green by construction. Additive, test-only: introduces
no publish / schedule / delete / mutate path (DRAFT-ONLY preserved).
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "sffs"))

import cost_governor as m  # noqa: E402


def test__matches_characterization():
    assert m._matches('', ()) == False
    assert m._matches('', ('a',)) == False
    assert m._matches('{"a": 1}', ()) == False
    assert m._matches('{"a": 1}', ('a',)) == True
    assert m._matches('hello', ()) == False
