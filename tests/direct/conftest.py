"""Shared fixtures for direct-mode tests.

The stock ``direct_alice``/``direct_bob`` fixtures return raw ``bytes`` unless
genlayer is already importable, but contract storage slots typed ``Address`` need
a real ``genlayer.py.types.Address``. We therefore put the cached SDK (the same
v0.2.16 the contracts pin) on ``sys.path`` once and construct ``Address`` values
ourselves from a seed.
"""

import hashlib
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
VAULT_CONTRACT = REPO / "contracts" / "demo_vault.py"


@pytest.fixture
def _sdk_path():
    """Ensure the pinned SDK is importable (uses the already-extracted cache).

    Function-scoped on purpose: the direct loader removes SDK roots from
    ``sys.path`` (and evicts ``genlayer.*`` modules) at every VM teardown, so the
    path must be re-added for each test. The setup itself is cheap (cached).
    """
    from gltest.direct.sdk_loader import setup_sdk_paths

    setup_sdk_paths(VAULT_CONTRACT, None)
    return True


@pytest.fixture
def addr(_sdk_path):
    """Deterministic, stable genlayer Address for a seed string."""
    from genlayer.py.types import Address

    def _make(seed: str) -> Address:
        raw = hashlib.sha256(seed.encode("utf-8")).digest()[:20]
        return Address(raw)

    return _make
