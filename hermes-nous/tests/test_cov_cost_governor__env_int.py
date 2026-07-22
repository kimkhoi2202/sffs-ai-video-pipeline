"""Auto-generated characterization tests for cost_governor._env_int (SFFS software factory).

Locks in the CURRENT behavior of a previously-untested pure helper — the
expected values were captured by EXECUTING the real function, so this raises
genuine coverage and is green by construction. Additive, test-only: introduces
no publish / schedule / delete / mutate path (DRAFT-ONLY preserved).
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "sffs"))

import cost_governor as m  # noqa: E402


def test__env_int_characterization():
    assert m._env_int({}, '', 0) == 0
    assert m._env_int({}, '', 1) == 1
    assert m._env_int({}, '', 5) == 5
    assert m._env_int({}, '', -3) == -3
    assert m._env_int({}, '{"a": 1}', 0) == 0
