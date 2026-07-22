"""Auto-generated characterization tests for cost_governor._metric (SFFS software factory).

Locks in the CURRENT behavior of a previously-untested pure helper — the
expected values were captured by EXECUTING the real function, so this raises
genuine coverage and is green by construction. Additive, test-only: introduces
no publish / schedule / delete / mutate path (DRAFT-ONLY preserved).
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "sffs"))

import cost_governor as m  # noqa: E402


def test__metric_characterization():
    assert m._metric(0, '') == {'value': 0, 'ceiling': '', 'over': False}
    assert m._metric(1, '') == {'value': 1, 'ceiling': '', 'over': False}
    assert m._metric(5, '') == {'value': 5, 'ceiling': '', 'over': False}
