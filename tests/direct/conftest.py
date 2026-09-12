"""Shared fixtures for direct-mode tests.

The stock ``direct_alice``/``direct_bob`` fixtures return raw ``bytes`` unless
genlayer is already importable, but contract storage slots typed ``Address`` need
a real ``genlayer.py.types.Address``. We therefore put the cached SDK on
``sys.path`` once and construct ``Address`` values ourselves from a seed.

⚠️ **These tests cannot currently run.** Every contract in this repo pins the
**v0.3.0** runner (``py-genlayer:5jycge4q8k23462jtb0b9fyey1s9qz928sz2nbrd9mg4sxqg2qng``)
for studio-dev, and the locally cached gltest runner bundle does not contain that
hash — `gltest.direct.sdk_loader` fails with::

    ValueError: Runner hash 5jycge4q8… not found

so the SDK never loads and every direct test errors at setup (verified
2026-09-12; the one exception is the source-grep structural test, which needs no
SDK). This is a harness limitation, not a contract defect — do not read a direct
run as evidence about studio-dev behaviour. The live check for these contracts is
`genvm-lint lint` plus a real studio-dev deploy; the cross-chain rail has its own
live verification in `v3-crosschain/genlayer/scripts/verify_eoa_refund.py`.

**A control must differ from the suspect in the dimension under test.** A direct
run under whatever SDK *is* cached would be evidence about THAT runner's
semantics, not about the v0.3.0 surface studio-dev serves. Reconcile the cached
runner before treating this suite as a studio-dev control.
"""

import hashlib
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
VAULT_CONTRACT = REPO / "intelligent-contracts" / "demo_vault.py"


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
