"""Auto-generated characterization tests for promote.get_proposal (SFFS software factory).

Locks in the CURRENT behavior of a previously-untested pure helper — the
expected values were captured by EXECUTING the real function, so this raises
genuine coverage and is green by construction. Additive, test-only: introduces
no publish / schedule / delete / mutate path (DRAFT-ONLY preserved).
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "sffs"))

import promote as m  # noqa: E402


def test_get_proposal_characterization():
    assert m.get_proposal('', paths=None) == None
    assert m.get_proposal('{"a": 1}', paths=None) == None
    assert m.get_proposal('hello', paths=None) == None
    assert m.get_proposal('42', paths=None) == None
