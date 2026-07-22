"""Auto-generated characterization tests for score_rollup._parse_last_json (SFFS software factory).

Locks in the CURRENT behavior of a previously-untested pure helper — the
expected values were captured by EXECUTING the real function, so this raises
genuine coverage and is green by construction. Additive, test-only: introduces
no publish / schedule / delete / mutate path (DRAFT-ONLY preserved).
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "sffs"))

import score_rollup as m  # noqa: E402


def test__parse_last_json_characterization():
    assert m._parse_last_json('') == None
    assert m._parse_last_json('{"a": 1}') == {'a': 1}
    assert m._parse_last_json('hello') == None
    assert m._parse_last_json('42') == None
