"""verify_v3.py — the v3 "done-when": read the finished cross-chain trip back off
Base Sepolia and print the full evidence trail. Read-only.

Checks, all against the live chain:
  * BaseDemoVault.paused()          == true       (the brake engaged)
  * BaseDemoVault.auditLen()        == 1          (the trip recorded an entry)
  * BaseDemoVault.audit(0)          op == "bridge_trip"
  * VaultTripped event              the on-chain receipt of the trip
  * BaseTripDispatcher TripForwarded event  (srcChainId, srcSender, target, message)

Run:
    "$LOCALAPPDATA/Temp/glpy019/venv/Scripts/python.exe" \
        v3-crosschain/genlayer/scripts/verify_v3.py [--blocks 5000]
"""
from __future__ import annotations

import argparse
import json
import sys

from eth_abi import decode
from web3 import Web3

BASE_RPC = "https://sepolia.base.org"
VAULT = "0xCF3EfC03eb49F36f7a806FD39eDcDD3Db8EaB567"
DISPATCHER = "0x1567e63787e0fE93653dfe0cC1eaEf554EB237A5"

VAULT_ABI = json.loads(
    """[
      {"type":"function","name":"paused","stateMutability":"view","inputs":[],
       "outputs":[{"type":"bool"}]},
      {"type":"function","name":"auditLen","stateMutability":"view","inputs":[],
       "outputs":[{"type":"uint256"}]},
      {"type":"function","name":"coverage","stateMutability":"view","inputs":[],
       "outputs":[{"type":"uint256"}]},
      {"type":"function","name":"collateral","stateMutability":"view","inputs":[],
       "outputs":[{"type":"uint256"}]},
      {"type":"function","name":"debt","stateMutability":"view","inputs":[],
       "outputs":[{"type":"uint256"}]},
      {"type":"function","name":"bridgeReceiver","stateMutability":"view","inputs":[],
       "outputs":[{"type":"address"}]},
      {"type":"function","name":"audit","stateMutability":"view",
       "inputs":[{"type":"uint256"}],
       "outputs":[{"type":"uint256","name":"seq"},{"type":"string","name":"op"},
                  {"type":"uint256","name":"amount"},{"type":"uint256","name":"collateral"},
                  {"type":"uint256","name":"debt"},{"type":"uint256","name":"coverage"},
                  {"type":"uint256","name":"time"}]},
      {"type":"event","name":"VaultTripped","anonymous":false,
       "inputs":[{"indexed":true,"type":"address","name":"by"}]},
      {"type":"event","name":"AuditRecorded","anonymous":false,
       "inputs":[{"indexed":true,"type":"uint256","name":"seq"},
                 {"indexed":false,"type":"string","name":"op"},
                 {"indexed":false,"type":"uint256","name":"amount"},
                 {"indexed":false,"type":"uint256","name":"coverage"}]}
    ]"""
)

DISPATCHER_ABI = json.loads(
    """[
      {"type":"event","name":"TripForwarded","anonymous":false,
       "inputs":[{"indexed":false,"type":"uint32","name":"srcChainId"},
                 {"indexed":false,"type":"address","name":"srcSender"},
                 {"indexed":false,"type":"address","name":"targetContract"},
                 {"indexed":false,"type":"bytes","name":"message"}]}
    ]"""
)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--blocks", type=int, default=20000,
                    help="how far back to scan for the delivery events")
    args = ap.parse_args()

    bar = "=" * 72
    base = Web3(Web3.HTTPProvider(BASE_RPC, request_kwargs={"timeout": 30}))
    latest = base.eth.block_number
    print(f"{bar}\nV3 TRIP VERIFICATION — Base Sepolia @ block {latest}\n{bar}")

    vlt = base.eth.contract(address=Web3.to_checksum_address(VAULT), abi=VAULT_ABI)
    dis = base.eth.contract(address=Web3.to_checksum_address(DISPATCHER), abi=DISPATCHER_ABI)

    paused = vlt.functions.paused().call()
    n = vlt.functions.auditLen().call()
    cov = vlt.functions.coverage().call()
    col = vlt.functions.collateral().call()
    debt = vlt.functions.debt().call()
    br = vlt.functions.bridgeReceiver().call()
    print(f"BaseDemoVault      : {VAULT}")
    print(f"  paused           : {paused}")
    print(f"  collateral/debt  : {col} / {debt}  (coverage {cov}%)")
    print(f"  auditLen         : {n}")
    print(f"  bridgeReceiver   : {br}  == dispatcher {DISPATCHER}: {br.lower() == DISPATCHER.lower()}")

    if n:
        a = vlt.functions.audit(0).call()
        print(f"  audit[0]         : seq={a[0]} op={a[1]!r} amount={a[2]} "
              f"collateral={a[3]} debt={a[4]} coverage={a[5]} time={a[6]}")

    print("\n-- delivery events --")
    frm = max(0, latest - args.blocks)
    trips = vlt.events.VaultTripped().get_logs(from_block=frm, to_block=latest)
    for ev in trips:
        print(f"  VaultTripped(by={ev.args.by}) in {ev.transactionHash.hex()}")
        print(f"    https://sepolia.basescan.org/tx/{ev.transactionHash.hex()}")
    fwds = dis.events.TripForwarded().get_logs(from_block=frm, to_block=latest)
    for ev in fwds:
        inner = decode(["string"], ev.args.message)[0]
        print(f"  TripForwarded(srcChainId={ev.args.srcChainId}, srcSender={ev.args.srcSender}, "
              f"target={ev.args.targetContract}, message={inner!r}) in {ev.transactionHash.hex()}")

    ok = paused is True and n == 1 and bool(trips) and bool(fwds)
    print(f"\n{bar}")
    print("TRIP VERIFIED on Base Sepolia — paused=true, bridge_trip recorded, "
          "TripForwarded + VaultTripped emitted" if ok
          else "VERIFICATION INCOMPLETE — see the values above")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
