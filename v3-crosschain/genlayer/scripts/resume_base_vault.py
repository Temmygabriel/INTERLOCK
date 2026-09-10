"""resume_base_vault.py — re-arm the Base Sepolia demo vault (owner-only).

`BaseDemoVault._trip()` has no replay guard but `trip()` is idempotent-guarded
(`if (!paused)`) and `borrow()` requires a live vault, so once tripped the demo
is frozen. `resume()` is the sanctioned way back: it is `onlyOwner`, clears
`paused`, and records a `governance_resume` audit entry. It does NOT clear the
audit log — the trip evidence from the previous round stays on-chain, which is
exactly what a verifier wants to see.

This is the Base half of the demo reset. The GenLayer half is a fresh trio
(`interlock_v3` is one-shot: no un-trip exists), driven by
`.github/workflows/deploy-v3-genlayer.yml`.

Run:
    V3_DEPLOYER_KEY=0x<hex> "$LOCALAPPDATA/Temp/glpy019/venv/Scripts/python.exe" \
        v3-crosschain/genlayer/scripts/resume_base_vault.py [--vault 0x…] [--manifest frontend/demo-manifest.json]

`--manifest` is what the reset workflow uses: it reads `base_sepolia.vault` /
`base_sepolia.rpc` from the same file the frontend builds from, so a redeployed
EVM leg is picked up without editing this script's defaults. The address is
logged as `RESUME_TX=<hash>` (empty when the vault was already live) so the
workflow can pass it through to the manifest.

Exit codes: 0 = vault is live (resumed now, or already live), 1 = failure.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

from web3 import Web3

BASE_RPC = "https://sepolia.base.org"
VAULT = "0xCF3EfC03eb49F36f7a806FD39eDcDD3Db8EaB567"

VAULT_ABI = json.loads(
    """[
      {"type":"function","name":"paused","stateMutability":"view","inputs":[],
       "outputs":[{"type":"bool"}]},
      {"type":"function","name":"owner","stateMutability":"view","inputs":[],
       "outputs":[{"type":"address"}]},
      {"type":"function","name":"resume","stateMutability":"nonpayable",
       "inputs":[],"outputs":[]},
      {"type":"function","name":"coverage","stateMutability":"view","inputs":[],
       "outputs":[{"type":"uint256"}]},
      {"type":"function","name":"auditLen","stateMutability":"view","inputs":[],
       "outputs":[{"type":"uint256"}]},
      {"type":"event","name":"GovernanceResumed","anonymous":false,
       "inputs":[{"indexed":true,"type":"address","name":"by"}]}
    ]"""
)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--vault", default=VAULT)
    ap.add_argument("--rpc", default=BASE_RPC)
    ap.add_argument("--manifest", default="",
                    help="read base_sepolia.vault / base_sepolia.rpc from this "
                         "manifest instead of the defaults above")
    args = ap.parse_args()

    if args.manifest:
        mp = Path(args.manifest)
        if not mp.exists():
            print(f"FATAL: manifest not found: {mp}", file=sys.stderr)
            return 2
        base = (json.loads(mp.read_text(encoding="utf-8")).get("base_sepolia") or {})
        if not base.get("vault"):
            print(f"FATAL: {mp} has no base_sepolia.vault", file=sys.stderr)
            return 2
        # Explicit flags still win over the manifest — an operator overriding on
        # the command line means it.
        if args.vault == VAULT:
            args.vault = base["vault"]
        if args.rpc == BASE_RPC and base.get("rpc"):
            args.rpc = base["rpc"]

    bar = "=" * 72
    print(f"{bar}\nBASE VAULT RESUME — re-arm the demo brake\n{bar}")

    key = os.environ.get("V3_DEPLOYER_KEY", "").strip()
    if not key:
        print("FATAL: set V3_DEPLOYER_KEY", file=sys.stderr)
        return 2
    if not key.startswith("0x"):
        key = "0x" + key

    w3 = Web3(Web3.HTTPProvider(args.rpc, request_kwargs={"timeout": 60}))
    acct = w3.eth.account.from_key(key)
    vault = w3.eth.contract(address=Web3.to_checksum_address(args.vault), abi=VAULT_ABI)

    paused = vault.functions.paused().call()
    owner = vault.functions.owner().call()
    print(f"vault            : {args.vault}")
    print(f"paused           : {paused}")
    print(f"owner            : {owner}")
    print(f"signer           : {acct.address}")
    print(f"coverage/auditLen: {vault.functions.coverage().call()}% / "
          f"{vault.functions.auditLen().call()}")

    if acct.address.lower() != owner.lower():
        print("FATAL: signer is not the vault owner — resume() would revert OwnableUnauthorized")
        return 1
    if not paused:
        print("\nvault is ALREADY live — nothing to resume (idempotent no-op)")
        # Machine-readable so the workflow can pass it to arm_v3_demo.py without
        # scraping the prose above. Empty = no resume happened this run.
        print("RESUME_TX=")
        return 0

    bal = w3.eth.get_balance(acct.address)
    print(f"base balance     : {Web3.from_wei(bal, 'ether')} ETH")
    if bal == 0:
        print("FATAL: owner has no Base Sepolia ETH for gas")
        return 1

    fn = vault.functions.resume()
    gas = int(fn.estimate_gas({"from": acct.address}) * 1.4)
    tx = fn.build_transaction({
        "from": acct.address,
        "nonce": w3.eth.get_transaction_count(acct.address),
        "chainId": w3.eth.chain_id,
        "gas": gas,
        "maxFeePerGas": w3.eth.gas_price * 2,
        "maxPriorityFeePerGas": w3.eth.max_priority_fee or 0,
    })
    signed = acct.sign_transaction(tx)
    raw = getattr(signed, "raw_transaction", None) or signed.rawTransaction
    h = w3.eth.send_raw_transaction(raw)
    print(f"\nresume() TX: {h.hex()}")
    rec = w3.eth.wait_for_transaction_receipt(h, timeout=600)
    print(f"receipt: status={rec.status} block={rec.blockNumber} gasUsed={rec.gasUsed}")
    if rec.status != 1:
        print("FATAL: resume() reverted")
        return 1
    for ev in vault.events.GovernanceResumed().process_receipt(rec):
        print(f"GovernanceResumed(by={ev.args.by})")

    # Read-back goes through a load-balanced RPC: the replica that answers can
    # lag the block the receipt came from, so poll instead of asserting on the
    # first read (observed: immediate read said True, all three RPCs said False
    # ~40s later, for a resume() whose GovernanceResumed event had already fired).
    paused_after = True
    for i in range(12):
        try:
            paused_after = vault.functions.paused().call()
        except Exception as e:  # noqa: BLE001 — RPC lag must never be fatal
            print(f"  (read error: {type(e).__name__}: {str(e)[:100]})")
            paused_after = True
        if not paused_after:
            break
        print(f"  paused still True ({i + 1}/12) — waiting for the read replica…")
        time.sleep(5)
    print(f"\npaused (after): {paused_after}")
    if paused_after:
        print("FATAL: still paused after a successful resume()")
        return 1
    print(f"PASS — vault re-armed. https://sepolia.basescan.org/tx/{h.hex()}")
    print(f"RESUME_TX={h.hex()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
