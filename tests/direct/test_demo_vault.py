"""
Direct-mode tests for DemoVault (single contract per VM — no cross-contract in
direct mode). Covers the vault-side invariants that Interlock relies on: genesis
health, the intentional borrow flaw, the audit log, and the pause/resume
permission split (guardian may pause, owner/governance only may resume).

Run:  pytest tests/direct/test_demo_vault.py -v
"""

from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
VAULT = str(REPO / "contracts" / "demo_vault.py")


@pytest.fixture
def vault(direct_deploy, addr):
    # owner = "alice" (human governance, may resume); guardian = "bob" (Interlock stand-in).
    return direct_deploy(VAULT, addr("alice"), addr("bob"))


def _entry(vault, i: int) -> dict:
    return vault.get_audit_entry(i)


def test_genesis_state_is_healthy(vault):
    p = vault.params()
    assert p["collateral"] == 57
    assert p["debt"] == 40
    assert p["coverage"] == 142  # 57*100//40
    assert p["paused"] is False
    assert p["audit_len"] == 0


def test_deposit_raises_coverage_and_logs(vault):
    vault.deposit(43)
    assert vault.coverage() == 250  # 100*100//40
    assert vault.audit_len() == 1
    e = _entry(vault, 0)
    assert e["op"] == "deposit"
    assert e["amount"] == 43
    assert e["coverage"] == 250


def test_healthy_borrow_keeps_pool_solvent(vault):
    vault.deposit(43)   # collateral 100, debt 40
    vault.borrow(40)    # debt 80  -> coverage 125
    assert vault.coverage() == 125
    assert vault.audit_len() == 2


def test_borrow_flaw_leaves_pool_insolvent(vault):
    # The intentional flaw: borrow() has no health/max check, so a single call can
    # push coverage below 100%. This undercollateralized borrow is the incident
    # Interlock exists to catch.
    vault.borrow(110)   # debt 150 against collateral 57 -> coverage 38
    assert vault.coverage() == 38
    assert vault.audit_len() == 1
    e = _entry(vault, 0)
    assert e["op"] == "borrow"
    assert e["debt"] == 150
    assert e["coverage"] == 38


def test_withdraw_rejects_undercollateralization(vault):
    vault.deposit(43)    # collateral 100, debt 40, coverage 250
    vault.withdraw(60)   # collateral 40, debt 40, coverage exactly 100 -> allowed
    assert vault.coverage() == 100
    # Any further withdrawal would leave lenders unable to be made whole -> rejected.
    with pytest.raises(Exception) as exc:
        vault.withdraw(1)
    assert "undercollateralized" in str(exc.value)


def test_withdraw_cannot_exceed_collateral(vault):
    with pytest.raises(Exception) as exc:
        vault.withdraw(58)  # more than the 57 collateral
    assert "exceeds collateral" in str(exc.value)


def test_only_guardian_can_pause(vault, direct_vm, addr):
    direct_vm.sender = addr("alice")  # owner is NOT guardian
    with pytest.raises(Exception) as exc:
        vault.apply_pause()
    assert "not guardian" in str(exc.value)
    assert vault.params()["paused"] is False


def test_guardian_pause_trips_and_logs(vault, direct_vm, addr):
    direct_vm.sender = addr("bob")  # the guardian
    vault.apply_pause()
    p = vault.params()
    assert p["paused"] is True
    e = _entry(vault, p["audit_len"] - 1)
    assert e["op"] == "guardian_pause"


def test_paused_vault_rejects_all_ops(vault, direct_vm, addr):
    direct_vm.sender = addr("bob")
    vault.apply_pause()
    for call in (lambda: vault.deposit(10),
                 lambda: vault.borrow(1),
                 lambda: vault.withdraw(1)):
        with pytest.raises(Exception) as exc:
            call()
        assert "vault is paused" in str(exc.value)


def test_resume_is_owner_only(vault, direct_vm, addr):
    # Guardian pauses; guardian cannot resume.
    direct_vm.sender = addr("bob")
    vault.apply_pause()
    with pytest.raises(Exception) as exc:
        vault.resume()
    assert "not owner" in str(exc.value)
    assert vault.params()["paused"] is True

    # Owner (human governance) resumes; the vault is live again.
    direct_vm.sender = addr("alice")
    vault.resume()
    p = vault.params()
    assert p["paused"] is False
    e = _entry(vault, p["audit_len"] - 1)
    assert e["op"] == "governance_resume"
    # And operations work again.
    vault.deposit(5)


def test_audit_entries_are_append_only_ledger(vault):
    vault.deposit(10)
    vault.deposit(5)
    vault.borrow(3)
    assert vault.audit_len() == 3
    # Each entry carries its own post-state snapshot and a monotonic seq.
    seqs = [_entry(vault, i)["seq"] for i in range(3)]
    assert seqs == [1, 2, 3]
    first = _entry(vault, 0)
    assert first["collateral"] == 67 and first["debt"] == 40
    # Out-of-range reads return a benign not-found marker.
    assert _entry(vault, 99)["found"] is False
