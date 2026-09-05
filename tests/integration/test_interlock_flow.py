"""Live studionet integration tests: the linked vault<->Interlock exploit flow,
run against real GenLayer validator consensus.

These exercise the section-5 rules that direct mode cannot: cross-contract
guard -> pause with a real LLM judgment round, honest-reporter bond refund, and
the deterministic no-op when the breaker is already tripped.

Run from repo root:  python -m pytest tests/integration/test_interlock_flow.py -v -s
(mark @pytest.mark.live — skipped unless studionet is reachable)

Scenarios, in order (shared module pair from conftest):
  1. A HEALTHY operation is reported -> NOT_CONFIRMED, no pause, bond forfeited.
  2. The undercollateralized borrow is reported -> EXPLOIT_CONFIRMED, guard
     pauses the vault, honest reporter is owed their bond; the paused vault
     rejects new borrows; a second report of the same exploit no-ops (already
     paused) but still refunds; withdraw clears escrow.
"""

from ._helpers import (
    BOND_VALUE,
    DEPOSIT_AMOUNT,
    EXPLOIT_AMOUNT,
    finalize,
    finalize_parent,
    read,
    write,
)

from gltest.assertions import tx_execution_failed


def _status(world) -> dict:
    return read(world.client, world.interlock, "status")


def _params(world) -> dict:
    return read(world.client, world.vault, "params")


def _report(world, reporter, op_index: int) -> dict:
    """Submit a bonded report and await the guard's emitted child (if any)."""
    rec = write(
        world.client,
        world.interlock,
        "report_exploit",
        reporter,
        args=[op_index],
        value=BOND_VALUE,
    )
    assert rec["status_name"] in ("ACCEPTED", "FINALIZED")
    return finalize(world.client, rec["tx_id"])


# --------------------------------------------------------------------------- #1

def test_false_report_is_rejected_and_bond_forfeited(world):
    # audit[0] is the fixture's guardian_update; this deposit lands at audit[1].
    # A healthy operation: deposit 43 -> coverage 250%.
    rec = write(world.client, world.vault, "deposit", world.owner, args=[DEPOSIT_AMOUNT])
    assert rec["status_name"] in ("ACCEPTED", "FINALIZED")
    assert read(world.client, world.vault, "coverage") == 250

    # The liar bonds 7 and reports the healthy op as an exploit.
    _report(world, world.liar, op_index=1)

    st = _status(world)
    p = _params(world)
    assert st["tripped"] is False, "breaker must NOT trip on a healthy operation"
    assert p["paused"] is False, "vault must stay live after a false report"
    assert st["report_count"] == 1
    # The false report is an incident; the bond was forfeited (no refund entry).
    inc = read(world.client, world.interlock, "get_incident", [0])
    assert inc["kind"] == "FALSE_REPORT_REJECTED"
    assert inc["effect"] == "noop_false_report"
    assert read(world.client, world.interlock, "refundable_of", [world.liar.address.lower()]) == 0


# --------------------------------------------------------------------------- #2

def test_confirmed_exploit_trips_guard_pauses_vault_and_refunds(world):
    # audit[1] is the healthy deposit (collateral 57 -> 100, coverage 250%). This
    # undercollateralized borrow raises debt to 150 against 100 collateral, leaving
    # coverage 66% (< 100%) — the insolvent exploit Interlock must catch. audit[2].
    rec = write(world.client, world.vault, "borrow", world.exploiter, args=[EXPLOIT_AMOUNT])
    assert rec["status_name"] in ("ACCEPTED", "FINALIZED")
    assert read(world.client, world.vault, "coverage") == 66
    assert _params(world)["paused"] is False

    # An honest reporter bonds 7 and points at the pinned audit entry.
    _report(world, world.honest, op_index=2)

    # Guard fired: consensus confirmed, vault is paused, reporter is owed.
    st = _status(world)
    p = _params(world)
    assert st["tripped"] is True
    assert p["paused"] is True, "guard must pause the vault on a confirmed exploit"
    assert read(world.client, world.vault, "coverage") == 66
    assert st["report_count"] == 2
    inc = read(world.client, world.interlock, "get_incident", [1])
    assert inc["kind"] == "TRIPPED"
    assert inc["effect"] == "apply_pause"
    assert read(world.client, world.interlock, "refundable_of", [world.honest.address.lower()]) == BOND_VALUE

    # The vault is frozen: even the exploiter cannot borrow through the breaker.
    rej = write(world.client, world.vault, "borrow", world.exploiter, args=[1])
    assert rej["status_name"] in ("ACCEPTED", "FINALIZED")
    assert tx_execution_failed(rej), "borrow on a paused vault must revert"
    assert read(world.client, world.vault, "coverage") == 66

    # Second report of the SAME exploit: already paused -> no outward effect, but
    # a genuine report is still refunded (never double-acts, never steals the bond).
    _report(world, world.liar, op_index=2)
    st2 = _status(world)
    assert st2["tripped"] is True
    assert _params(world)["paused"] is True
    inc2 = read(world.client, world.interlock, "get_incident", [2])
    assert inc2["kind"] == "TRIPPED" and inc2["effect"] == "noop_already_paused"
    assert read(world.client, world.interlock, "refundable_of", [world.liar.address.lower()]) == BOND_VALUE

    # Honest reporter withdraws their escrowed bond. The contract-level guarantee
    # is the ledger: escrow credited once, cleared exactly once, nothing left to
    # withdraw. The refund itself is an emit_transfer to the reporter's EOA,
    # which the hosted studionet cannot settle (its value ledger only knows
    # deployed contracts -> child errors "Contract 0x… not found"); on a
    # production network it settles natively to the reporter's account. So we
    # finalize the parent (escrow clear) and assert the transfer child WAS
    # emitted, but do not require the child to settle on studionet.
    wrec = write(world.client, world.interlock, "withdraw_bond", world.honest)
    _, children = finalize_parent(world.client, wrec["tx_id"])
    assert len(children) >= 1, "withdraw must emit the bond-refund transfer"
    assert read(world.client, world.interlock, "refundable_of", [world.honest.address.lower()]) == 0
    # Nothing left to withdraw (a second withdraw deterministically reverts).
    again = write(world.client, world.interlock, "withdraw_bond", world.honest)
    assert tx_execution_failed(again), "second withdraw with empty escrow must revert"
