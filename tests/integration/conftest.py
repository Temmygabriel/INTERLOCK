"""Live studionet fixture: one fully wired DemoVault <-> Interlock pair.

Bootstrap (models a real protocol arming its breaker before go-live):
  1. owner deploys DemoVault with guardian = itself (placeholder).
  2. owner deploys Interlock(target_vault=vault, governance=owner, min_bond=5).
  3. owner calls vault.set_guardian(interlock) — the vault is now paused only by
     Interlock, and only Interlock is frozen to this vault. Circular anchor
     problem solved by the owner *installing* the breaker (the vault is the
     protected protocol and may be re-wired by its own governance; Interlock's
     rulebook is the immutable one).

Shared module-scope so the two narrative tests below run against one pair; each
asserts its own slice of state and leaves the vault live for the next.
"""

from dataclasses import dataclass

import pytest
from gltest.assertions import tx_execution_failed

from ._helpers import (
    MIN_BOND,
    REPO,
    deploy,
    write,
    raw_addr,
)

VAULT_CODE = (REPO / "contracts" / "demo_vault.py").read_text(encoding="utf-8")
INTERLOCK_CODE = (REPO / "contracts" / "interlock.py").read_text(encoding="utf-8")


@dataclass
class World:
    client: object
    vault: str
    interlock: str
    owner: object        # account[0] — protocol owner / human governance
    exploiter: object    # account[1] — takes the undercollateralized borrow
    honest: object       # account[2] — reports the exploit, gets bond back
    liar: object         # account[3] — false report, bond forfeited


@pytest.fixture(scope="module")
def world(gl_client, default_account, accounts):
    owner, exploiter, honest, liar = accounts[0], accounts[1], accounts[2], accounts[3]

    vault = deploy(
        gl_client,
        VAULT_CODE,
        [raw_addr(owner.address), raw_addr(owner.address)],  # guardian placeholder
        default_account,
        "vault",
    )
    interlock = deploy(
        gl_client,
        INTERLOCK_CODE,
        [raw_addr(vault), raw_addr(owner.address), MIN_BOND],
        default_account,
        "interlock",
    )
    # Arm the breaker: the vault's pause authority becomes Interlock, and only
    # Interlock. Recorded on the audit log Interlock later reads.
    rec = write(gl_client, vault, "set_guardian", owner, args=[raw_addr(interlock)])
    assert not tx_execution_failed(rec), "set_guardian did not execute cleanly"

    return World(
        client=gl_client,
        vault=vault,
        interlock=interlock,
        owner=owner,
        exploiter=exploiter,
        honest=honest,
        liar=liar,
    )
