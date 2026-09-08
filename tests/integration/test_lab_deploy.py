"""LAB PAIR deployer (one-shot, studionet).

Deploys a SECOND DemoVault<->Interlock pair that the demo OWNS — a lab where a
real borrow may push coverage under 100% and trip the breaker, without touching
the canonical DEPLOY CARD pair (whose healthy 142% story must stay intact).

Why the owner key is NOT retained: studionet test accounts are ephemeral per
process, and we deliberately do not persist them. That is fine — `deposit`,
`borrow` and `report_exploit` are all permissionless on this pair, so any key
(the browser identity, or a Node driver) can seed entries and drive a trip.
Resuming a tripped lab vault is owner-only, so the lab is redeployed fresh for
each presentation (addresses rotate per run; studionet persists the deployed
pair until the next run supersedes it).

Run:
    python -m pytest tests/integration/test_lab_deploy.py -v -s

Output:
  * prints a LAB CARD (vault/interlock/audit_len/coverage)
  * writes repo-root `lab-card.json` (gitignored) with the live addresses

Seeding is deterministic writes only (no LLM rounds): deposit x2 + a HEALTHY
borrow, so the dropdown has real sentences and coverage stays > 200%. The risky
borrow that trips the breaker is deliberately NOT done here — that is the demo.
"""

import json
from pathlib import Path

from gltest.assertions import tx_execution_failed

from ._helpers import (
    MIN_BOND,
    REPO,
    deploy,
    finalize,
    read,
    raw_addr,
    write,
)

VAULT_CODE = (REPO / "intelligent-contracts" / "demo_vault.py").read_text(encoding="utf-8")
INTERLOCK_CODE = (REPO / "intelligent-contracts" / "interlock.py").read_text(encoding="utf-8")

# seed ops (deterministic, no LLM round): 57 + 60 + 5 collateral, 40 + 5 debt
SEED = [("deposit", 60), ("borrow", 5), ("deposit", 5)]


def test_deploy_lab_pair(gl_client, default_account, accounts):
    owner, *_ = accounts
    bar = "=" * 72
    print(f"\n{bar}\nLAB DEPLOYMENT CARD  (live studionet pair — this run)\n{bar}")
    print(f"deployer: {default_account.address}   owner(governance): {owner.address}")

    vault = deploy(gl_client, VAULT_CODE,
                   [raw_addr(owner.address), raw_addr(owner.address)],
                   default_account, "lab-vault")
    interlock = deploy(gl_client, INTERLOCK_CODE,
                       [raw_addr(vault), raw_addr(owner.address), MIN_BOND],
                       default_account, "lab-interlock")
    print(f"\nvault (DemoVault):    {vault}")
    print(f"interlock (guard):    {interlock}")

    # arm the breaker (owner-only, live-only; recorded as audit[0] guardian_update)
    rec = write(gl_client, vault, "set_guardian", owner, args=[raw_addr(interlock)])
    assert not tx_execution_failed(rec), "set_guardian did not execute cleanly"

    # seed a short audit history with real plain-language entries (all healthy)
    for op, amount in SEED:
        w = write(gl_client, vault, op, default_account, args=[amount])
        finalize(gl_client, w)
        print(f"  seeded  {op:8} {amount:>3} GEN")

    p = read(gl_client, vault, "params")
    print(f"\naudit_len = {p['audit_len']}   coverage = {p['coverage']}%  (RUNNING, healthy)")
    assert p["paused"] is False
    assert int(p["coverage"]) >= 100

    card = {
        "vault": vault,
        "interlock": interlock,
        "audit_len": int(p["audit_len"]),
        "coverage_pct": int(p["coverage"]),
        "note": "Redeploy fresh before each demo. Risky borrow/trip is NOT seeded here.",
    }
    card_path = REPO / "lab-card.json"
    card_path.write_text(json.dumps(card, indent=2), encoding="utf-8")
    print(f"\ncard written -> {card_path}")
    print(f"{bar}\nLAB vault LIVE (not paused), breaker RUNNING (not tripped).\n{bar}")
