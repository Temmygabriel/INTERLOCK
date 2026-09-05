"""
Direct-mode tests for Interlock that do NOT need a live target vault (direct mode
runs one contract per VM and cannot make cross-contract calls). Covers: the
frozen constitution / no-setter structure, the empty escrow ledger, the
bond-below-minimum gate (which fires BEFORE any vault access), and the
deterministic status surface.

The full exploit-report flow (guard -> pause, bond refund/forfeit, false-report
rejection) needs the linked pair + consensus, so it lives in
tests/integration/test_interlock_flow.py against studionet.

Run:  pytest tests/direct/test_interlock_isolated.py -v
"""

from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
INTERLOCK = str(REPO / "contracts" / "interlock.py")
MIN_BOND = 5


@pytest.fixture
def interlock(direct_deploy, addr):
    # target_vault is only stored (never called) in these isolated tests.
    return direct_deploy(INTERLOCK, addr("target_vault"), addr("alice"), MIN_BOND)


def test_constitution_frozen_and_status(interlock, addr):
    s = interlock.status()
    assert s["target"] == str(addr("target_vault"))
    assert s["governance"] == str(addr("alice"))
    assert s["min_bond"] == MIN_BOND
    assert s["tripped"] is False
    assert s["report_count"] == 0
    assert s["incident_count"] == 0
    assert s["deployed_at"]  # non-empty anchor

    c = interlock.constitution_view()
    assert c["schema"] == 1
    assert set(c["effect_set"]) == {"apply_pause", "noop_already_paused", "noop_false_report"}
    assert c["doctrine"]
    assert "owner-only" in c["unpause"]


def test_escrow_starts_empty(interlock, addr):
    assert interlock.refundable_of(str(addr("alice"))) == 0
    assert interlock.refundable_of(str(addr("bob"))) == 0
    assert interlock.refundable_of("0x" + "0" * 40) == 0


def test_withdraw_bond_reverts_when_nothing_owed(direct_vm, interlock, addr):
    direct_vm.sender = addr("alice")
    with pytest.raises(Exception) as exc:
        interlock.withdraw_bond()
    assert "nothing to withdraw" in str(exc.value)


def test_bond_below_minimum_reverts_before_any_vault_access(direct_vm, interlock, addr):
    """The bond gate is the first thing report_exploit does: under-min reports are
    rejected deterministically, before any evidence read or consensus — a report
    cannot even start without skin in the game."""
    direct_vm.sender = addr("alice")
    direct_vm.value = MIN_BOND - 1  # 4 < 5
    with pytest.raises(Exception) as exc:
        interlock.report_exploit(0)
    assert "bond below minimum" in str(exc.value)
    assert interlock.status()["report_count"] == 0
    direct_vm.value = 0


def test_no_constitution_setter_exists():
    """Structural guard-test: the rulebook fields are assigned exactly once (in the
    constructor) and no write method can mutate them. Grep the source rather than
    the ABI so this also fails if someone adds a setter later."""
    src = (REPO / "contracts" / "interlock.py").read_text(encoding="utf-8")

    # Only two public write entry points exist: report_exploit (payable) and
    # withdraw_bond. Neither accepts a rulebook value.
    assert src.count("@gl.public.write") == 2, "expected exactly 2 public write methods"
    assert "@gl.public.write.payable" in src

    # No conventional setter/update/configure/reset method by name.
    for banned in ("def set_", "def update_", "def configure", "def reset_", "def rearm"):
        assert banned not in src, f"found forbidden mutator: {banned}"

    # Frozen fields are each assigned in exactly one place (the constructor).
    for field in ("self.target_vault =", "self.governance =", "self.min_bond =",
                  "self.constitution =", "self.deployed_at ="):
        assert src.count(field) == 1, f"{field} must be assigned once (constructor only)"
