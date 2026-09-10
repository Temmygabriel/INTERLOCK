"""deploy_v3_studio.py — task #32: deploy the LIVE, LINKED v3 GenLayer leg on
studio-dev (chain 61997, v0.3.0 runner pin `5jycge4…qng`) and point it at the
real Base Sepolia `BaseDemoVault` deployed by task #31.

What this deploys, in order:

  demo_vault(owner, guardian)                the GenLayer victim whose immutable
                                             audit log interlock_v3 judges
  BridgeSender()                             the GenLayer -> EVM outbox (relay polls it)
  interlock_v3(target_vault=demo_vault,
                governance=owner,
                min_bond=MIN_BOND,
                bridge_sender=BridgeSender,
                target_chain_eid=40245,      Base Sepolia
                target_contract=VAULT_EVM)   the real BaseDemoVault on Base Sepolia

WHY `target_contract` IS THE VAULT (verified, not assumed — task #32):
`BridgeSender.send_message` ABI-encodes the envelope
`(u32 srcChainId, Address srcSender, Address localContract, bytes message)` where
`localContract = Address(target_contract)` and `srcSender = the caller of
send_message` (i.e. interlock_v3). `BaseTripDispatcher.lzReceive` decodes that
tuple and calls `processBridgeMessage` on `localContract` **only if
`trustedTargets[localContract]`** — and task #31 whitelisted exactly the
BaseDemoVault (`0xCF3E…B567`). So `target_contract` MUST be the BaseDemoVault,
not the dispatcher. `srcChainId` (the boilerplate hardcodes 61998) is passed
through unvalidated; `BaseDemoVault.processBridgeMessage` ignores it and only
checks that the caller is its configured `bridgeReceiver` (the dispatcher) and
that the payload decodes to the exact string "TRIP".

NOT DONE HERE: the vault is not armed (`set_guardian`) — on the v3 path
interlock_v3 has no code path that calls `apply_pause`, so the GenLayer vault's
guardian is inert and arming it would only shift the audit index of the exploit.
`resume`/`apply_pause` on the GenLayer vault are unused by v3 by construction.

Run (from the repo root; no npm, no install — uses the pre-existing venv):

    V3_GENLAYER_KEY=0x<hex> \
      "$LOCALAPPDATA/Temp/glpy019/venv/Scripts/python.exe" \
      v3-crosschain/genlayer/scripts/deploy_v3_studio.py --out <path.json>

Keys are never printed and never committed: the key comes from the environment;
the address is public and is what gets logged.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

from genlayer_py.accounts.account import create_account
from genlayer_py.chains import studio_devnet
from genlayer_py.client.client import create_client
from genlayer_py.types import CalldataAddress

REPO = Path(__file__).resolve().parents[3]
GEN = REPO / "v3-crosschain" / "genlayer"
BOILER = REPO / "v3-crosschain" / "boilerplate" / "intelligent-contracts"

VAULT_CODE = (GEN / "demo_vault.py").read_text(encoding="utf-8")
INTERLOCK_CODE = (GEN / "interlock_v3.py").read_text(encoding="utf-8")
BRIDGE_CODE = (BOILER / "BridgeSender.py").read_text(encoding="utf-8")

# --- live wiring constants (task #31 deployed + wired the EVM leg) -------------
BASE_SEPOLIA_EID = 40245
BASE_DEMO_VAULT = "0xCF3EfC03eb49F36f7a806FD39eDcDD3Db8EaB567"
MIN_BOND = 5  # integer bond units; matches the report_exploit payable floor

_TRANSIENT = (
    "Connection", "Request to", "SSL", "502", "Bad gateway", "invalid JSON",
    "Timeout", "timed out", "Too Many Requests", "429", "Internal Server",
    "Method not found", "-32601", "sim_getFeeConfig", "not supported on this chain",
    "read deadline", "Connection reset",
)


def retry(fn, label, attempts=6):
    last = None
    for i in range(attempts):
        try:
            return fn()
        except Exception as e:  # noqa: BLE001 — classify by message, re-raise if fatal
            last = e
            if any(t in str(e) for t in _TRANSIENT):
                print(f"    [retry {label}: {type(e).__name__} — backoff {i + 1}]")
                time.sleep(3 * (i + 1))
                continue
            raise
    raise last


def _addr(h: str) -> CalldataAddress:
    return CalldataAddress(bytes.fromhex(h[2:]))


def tx_hash(tx):
    return tx.get("hash") if isinstance(tx, dict) else str(tx)


def wait(client, tx, label, retries=60):
    def _w():
        return client.wait_for_transaction_receipt(
            tx_hash(tx), wait_until="finalized", interval=3, retries=retries
        )
    return retry(_w, label + " wait")


def success(rec) -> bool:
    return rec.get("txExecutionResultName") == "FINISHED_WITH_RETURN"


def deploy(client, account, code, args, label):
    fees = retry(lambda: client.estimate_transaction_fees(), label + " fees")
    tx = retry(
        lambda: client.deploy_contract(code=code, account=account, args=args, fees=fees),
        label + " deploy",
    )
    rec = wait(client, tx, label)
    addr = (rec.get("data") or {}).get("contract_address")
    ok = success(rec) and bool(addr)
    print(
        f"  {label}: exec={rec.get('txExecutionResultName')} addr={addr} "
        f"{'PASS' if ok else 'FAIL'}"
    )
    if not ok:
        raise RuntimeError(f"{label} deploy failed: {json.dumps(rec, default=str)[:800]}")
    return addr


def read(client, addr, method, args=None):
    return retry(lambda: client.read_contract(addr, method, args=args), method)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="", help="write the deploy manifest JSON here")
    ap.add_argument(
        "--target-contract",
        default=os.environ.get("V3_TARGET_CONTRACT", BASE_DEMO_VAULT),
        help=f"Base Sepolia BaseDemoVault address (default {BASE_DEMO_VAULT})",
    )
    ap.add_argument("--min-bond", type=int, default=MIN_BOND)
    ap.add_argument(
        "--arm-guardian",
        action="store_true",
        help="also call demo_vault.set_guardian(interlock_v3) — cosmetic on v3, "
        "shifts the exploit's audit index; off by default",
    )
    args = ap.parse_args()

    key = os.environ.get("V3_GENLAYER_KEY", "").strip()
    if not key:
        print("FATAL: set V3_GENLAYER_KEY (0x-hex studio-dev deployer key)", file=sys.stderr)
        return 2
    account = create_account(key if key.startswith("0x") else "0x" + key)

    target_contract = args.target_contract
    if not (target_contract.startswith("0x") and len(target_contract) == 42):
        print(f"FATAL: target_contract is not a 20-byte address: {target_contract!r}", file=sys.stderr)
        return 2

    bar = "=" * 72
    print(f"{bar}\nV3 GENLAYER LEG — LIVE DEPLOY on studio-dev (chain {studio_devnet.id})\n{bar}")
    print(f"deployer (public): {account.address}")
    print(f"target_contract  : {target_contract}  (BaseDemoVault on Base Sepolia, EID {BASE_SEPOLIA_EID})")
    print(f"min_bond         : {args.min_bond}")

    client = create_client(chain=studio_devnet, account=account)
    gov = account.address

    # ---- 1. demo_vault (the GenLayer victim being judged) ---------------------
    vault = deploy(client, account, VAULT_CODE, [_addr(gov), _addr(gov)], "demo_vault")
    p = read(client, vault, "params")
    print(f"  READ params: owner={p.get('owner')} coverage={p.get('coverage')}% "
          f"audit_len={p.get('audit_len')} paused={p.get('paused')}")
    if int(p["coverage"]) != 142 or p["paused"] is not False or int(p["audit_len"]) != 0:
        raise RuntimeError(f"demo_vault genesis unexpected: {p}")
    print("  PASS — demo_vault live, genesis healthy (142% coverage, empty audit log)")

    # ---- 2. BridgeSender (the GenLayer -> EVM outbox the relay polls) --------
    bridge = deploy(client, account, BRIDGE_CODE, [], "BridgeSender")
    hashes0 = read(client, bridge, "get_message_hashes")
    print(f"  READ get_message_hashes (fresh): {json.dumps(hashes0, default=str)}")
    if hashes0 not in ([], {}):
        raise RuntimeError(f"fresh BridgeSender is not empty: {hashes0}")
    print("  PASS — BridgeSender live, outbox empty")

    # ---- 3. interlock_v3 (linked to both) ------------------------------------
    interlock = deploy(
        client, account, INTERLOCK_CODE,
        [_addr(vault), _addr(gov), args.min_bond, _addr(bridge), BASE_SEPOLIA_EID, target_contract],
        "interlock_v3",
    )
    s = read(client, interlock, "status")
    print(f"  READ status: target={s.get('target')} bridge_sender={s.get('bridge_sender')} "
          f"eid={s.get('target_chain_eid')} target_contract={s.get('target_contract')} "
          f"tripped={s.get('tripped')} report_count={s.get('report_count')}")
    if s["target"] != vault or s["bridge_sender"] != bridge:
        raise RuntimeError(f"interlock_v3 linkage wrong: {s}")
    if int(s["target_chain_eid"]) != BASE_SEPOLIA_EID:
        raise RuntimeError(f"wrong target_chain_eid: {s}")
    if str(s["target_contract"]).lower() != target_contract.lower():
        raise RuntimeError(f"wrong target_contract: {s}")
    if s["tripped"] is not False or int(s["report_count"]) != 0:
        raise RuntimeError(f"fresh interlock_v3 is not clean: {s}")
    cc = read(client, interlock, "constitution_view")
    print(f"  READ constitution: schema={cc.get('schema')} effect_set={cc.get('effect_set')}")
    if cc.get("schema") != 1 or "trust_model" not in cc:
        raise RuntimeError(f"constitution manifest unexpected: {cc}")
    print("  PASS — interlock_v3 live, linked to demo_vault + BridgeSender + BaseDemoVault")

    # ---- 4. optional: arm the GenLayer vault's (inert on v3) guardian --------
    audit_len_after_arm = 0
    if args.arm_guardian:
        fees = retry(lambda: client.estimate_transaction_fees(), "set_guardian fees")
        tx = retry(
            lambda: client.write_contract(
                vault, "set_guardian", account=account, args=[_addr(interlock)],
                value=0, fees=fees,
            ),
            "set_guardian",
        )
        rec = wait(client, tx, "set_guardian")
        if not success(rec):
            raise RuntimeError(f"set_guardian failed: {json.dumps(rec, default=str)[:600]}")
        audit_len_after_arm = 1  # audit[0] = guardian_update
        print("  PASS — demo_vault guardian armed (cosmetic on v3)")

    manifest = {
        "network": "studio-dev",
        "chain_id": int(studio_devnet.id),
        "runner_pin": "py-genlayer:5jycge4q8k23462jtb0b9fyey1s9qz928sz2nbrd9mg4sxqg2qng",
        "deployer": gov,
        "demo_vault": vault,
        "bridge_sender": bridge,
        "interlock_v3": interlock,
        "target_chain_eid": BASE_SEPOLIA_EID,
        "target_contract": target_contract,
        "min_bond": args.min_bond,
        "armed": bool(args.arm_guardian),
        "exploit_op_index": audit_len_after_arm,
        "notes": [
            "EVM leg (Base Sepolia) deployed + wired by task #31: "
            "dispatcher 0x1567e63787e0fE93653dfe0cC1eaEf554EB237A5, "
            "vault 0xCF3EfC03eb49F36f7a806FD39eDcDD3Db8EaB567",
            "trusted-relay, not consensus-authenticated: the relay must be running "
            "for a real GenLayer trip to reach Base Sepolia",
        ],
    }
    if args.out:
        Path(args.out).write_text(json.dumps(manifest, indent=2), encoding="utf-8")
        print(f"\nmanifest -> {args.out}")
    print(f"\n{bar}\nLIVE DEPLOY PASS — v3 GenLayer leg is deployed and linked\n{bar}")
    print(json.dumps(manifest, indent=2))
    print(
        "\nNext (#33):\n"
        f"  1. borrow on the GenLayer vault to push coverage < 100%:\n"
        f"     demo_vault.borrow(18)  -> debt 58, coverage 98%  (audit[{audit_len_after_arm}])\n"
        f"  2. file report_exploit({audit_len_after_arm}) on interlock_v3 with value >= {args.min_bond}\n"
        f"  3. relay polls BridgeSender -> BridgeForwarder -> LayerZero -> BaseTripDispatcher\n"
        f"  4. expect BaseDemoVault({target_contract}).paused == true"
    )
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:  # noqa: BLE001 — surface the full failure to the operator
        print("FATAL:", type(e).__name__, str(e)[:800])
        sys.exit(1)
