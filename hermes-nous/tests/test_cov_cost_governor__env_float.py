"""Auto-generated characterization tests for cost_governor._env_float (SFFS software factory).

Locks in the CURRENT behavior of a previously-untested pure helper — the
expected values were captured by EXECUTING the real function, so this raises
genuine coverage and is green by construction. Additive, test-only: introduces
no publish / schedule / delete / mutate path (DRAFT-ONLY preserved).
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "sffs"))

import cost_governor as m  # noqa: E402


def test__env_float_characterization():
    assert m._env_float({}, '', 0.0) == 0.0
    assert m._env_float({}, '', 1.5) == 1.5
    assert m._env_float({}, '', -2.5) == -2.5
    assert m._env_float({}, '', 100.0) == 100.0
    assert m._env_float({}, '{"a": 1}', 0.0) == 0.0
