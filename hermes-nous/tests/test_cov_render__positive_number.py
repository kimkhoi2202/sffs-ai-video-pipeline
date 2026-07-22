"""Auto-generated characterization tests for render._positive_number (SFFS software factory).

Locks in the CURRENT behavior of a previously-untested pure helper — the
expected values were captured by EXECUTING the real function, so this raises
genuine coverage and is green by construction. Additive, test-only: introduces
no publish / schedule / delete / mutate path (DRAFT-ONLY preserved).
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "sffs"))

import render as m  # noqa: E402


def test__positive_number_characterization():
    assert m._positive_number(1, '') == 1.0
    assert m._positive_number(1, '{"a": 1}') == 1.0
    assert m._positive_number(1, 'hello') == 1.0
    assert m._positive_number(1, '42') == 1.0
    assert m._positive_number(5, '') == 5.0
