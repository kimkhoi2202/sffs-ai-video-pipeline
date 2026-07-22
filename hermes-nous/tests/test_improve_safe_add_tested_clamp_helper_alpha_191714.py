"""Auto-added by the SFFS software factory (workstream safe_add_tested_clamp_helper_alpha_191714).

A tiny, pure, well-tested helper. Additive test coverage only; introduces no
publish / schedule / delete / mutate path (DRAFT-ONLY preserved).
"""


def clamp(value, low, high):
    """Return value constrained to the inclusive [low, high] range."""
    if low > high:
        raise ValueError("low must be <= high")
    return max(low, min(high, value))


def test_clamp_within_range():
    assert clamp(5, 0, 10) == 5


def test_clamp_below_low():
    assert clamp(-3, 0, 10) == 0


def test_clamp_above_high():
    assert clamp(42, 0, 10) == 10
