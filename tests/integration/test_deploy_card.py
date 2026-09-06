"""Live deployment record (smoke test + printed card).

Deploys ONE vault<->Interlock pair on studionet, arms the breaker, and prints a
verifiable DEPLOYMENT CARD (accounts, addresses, frozen constitution, live state)
so any run leaves a concrete on-chain record. Run with ``-s`` to see the card:

    python -m pytest tests/integration/test_deploy_card.py -v -s

Addresses rotate every run (studionet test accounts are re-derived per process);
the card this run prints is the live, on-chain pair for THAT run.
"""

import json

from ._helpers import (
    MIN_BOND,
    REPO,
    deploy,
    read,
    raw_addr,
    write,
)
from gltest.assertions import tx_execution_failed

VAULT_CODE = (REPO / "contracts" / "demo_vault.py").read_text(encoding="utf-8")
INTERLOCK_CODE = (REPO / "contracts" / "interlock.py").read_text(encoding="utf-8")


def test_print_deployment_card(gl_client, default_account, accounts):
    owner, exploiter, honest, liar = accounts[0], accounts[1], accounts[2], accounts[3]
    bar = "=" * 72
    print(f"\n{bar}\nDEPLOYMENT CARD  (live studionet pair — run of this test)\n{bar}")
    print(f"deployer (default_account): {default_account.address}")
    print("accounts:")
    for name, acc in [("owner(governance)", owner), ("exploiter", exploiter),
                      ("honest reporter", honest), ("liar reporter", liar)]:
        print(f"  {name:20} {acc.address}")

    vault = deploy(gl_client, VAULT_CODE,
                   [raw_addr(owner.address), raw_addr(owner.address)],
                   default_account, "vault")
    print(f"\nvault (DemoVault):  {vault}")

    interlock = deploy(gl_client, INTERLOCK_CODE,
                       [raw_addr(vault), raw_addr(owner.address), MIN_BOND],
                       default_account, "interlock")
    print(f"interlock (guard):  {interlock}")

    rec = write(gl_client, vault, "set_guardian", owner, args=[raw_addr(interlock)])
    assert not tx_execution_failed(rec), "set_guardian did not execute cleanly"
    print(f"armed: vault.guardian -> interlock (audit[0] = guardian_update)")

    # --- read frozen constitution + live state -------------------------------
    const = read(gl_client, interlock, "constitution_view")
    print(f"\n--- interlock constitution (frozen, no setter) ---")
    print(json.dumps(const, indent=2))
    st = read(gl_client, interlock, "status")
    print(f"\n--- interlock status ---")
    print(json.dumps(st, indent=2))
    p = read(gl_client, vault, "params")
    cov = read(gl_client, vault, "coverage")
    print(f"\n--- vault params / coverage ---")
    print(json.dumps(p, indent=2))
    print(f"coverage = {cov}%  (genesis collateral/debt; RUNNING)")
    alen = read(gl_client, vault, "audit_len")
    print(f"audit_len = {alen}")
    e0 = read(gl_client, vault, "get_audit_entry", [0])
    print(f"\naudit[0]: {json.dumps(e0, indent=2)}")

    print(f"\n{bar}\nend of card — vault LIVE (not paused), breaker RUNNING (not tripped).\n{bar}")
    # Minimal liveness asserts so this doubles as a fast smoke test.
    assert st["tripped"] is False
    assert p["paused"] is False
    assert int(cov) >= 100
