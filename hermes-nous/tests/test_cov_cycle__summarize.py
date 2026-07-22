"""Auto-generated characterization tests for cycle._summarize (SFFS software factory).

Locks in the CURRENT behavior of a previously-untested pure helper — the
expected values were captured by EXECUTING the real function, so this raises
genuine coverage and is green by construction. Additive, test-only: introduces
no publish / schedule / delete / mutate path (DRAFT-ONLY preserved).
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "sffs"))

import cycle as m  # noqa: E402


def test__summarize_characterization():
    assert m._summarize({}, {}) == {'ok': True, 'dry_run': False, 'run_id': None, 'status': None, 'target_count': None, 'summary': None, 'scoring': None, 'do_not_touch': {'scheduled': 0, 'published': 0, 'captured_at': None}, 'git': None, 'errors': [], 'videos': []}
    assert m._summarize({}, {'a': '1'}) == {'ok': True, 'dry_run': False, 'run_id': None, 'status': None, 'target_count': None, 'summary': None, 'scoring': None, 'do_not_touch': {'scheduled': 0, 'published': 0, 'captured_at': None}, 'git': None, 'errors': [], 'videos': []}
    assert m._summarize({'a': '1'}, {}) == {'ok': True, 'dry_run': False, 'run_id': None, 'status': None, 'target_count': None, 'summary': None, 'scoring': None, 'do_not_touch': {'scheduled': 0, 'published': 0, 'captured_at': None}, 'git': None, 'errors': [], 'videos': []}
    assert m._summarize({'a': '1'}, {'a': '1'}) == {'ok': True, 'dry_run': False, 'run_id': None, 'status': None, 'target_count': None, 'summary': None, 'scoring': None, 'do_not_touch': {'scheduled': 0, 'published': 0, 'captured_at': None}, 'git': None, 'errors': [], 'videos': []}
