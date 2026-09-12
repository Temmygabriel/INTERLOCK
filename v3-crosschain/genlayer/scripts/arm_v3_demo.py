"""arm_v3_demo.py — turn a fresh v3 GenLayer trio into an ARMED demo, and point
the frontend at it.

`deploy_v3_studio.py` gives us three clean contracts (142% coverage, empty audit
log, nothing tripped). That is a *healthy* vault — a visitor has nothing to
report, and the page's report button correctly stays disabled. The demo needs the
opposite: one pinned, independently-checkable exploit entry.

This script does the second half of a reset:

  1. `demo_vault.borrow(18)` — debt 40 -> 58 against collateral 57. Coverage
     drops 142% -> 98%, and the borrow lands in the audit log at index
     `exploit_op_index`. This is a REAL state change on a REAL contract: the
     entry the visitor later reports is genuine, not staged.
  2. Verify the entry actually reads back undercollateralized. If coverage is
     not < 100% the pinned entry is not an exploit, and the report button would
     be inviting visitors to file a FALSE report — refuse and fail loudly.
  3. Merge the trio into `frontend/demo-manifest.json`, preserving the EVM legs
     (which a GenLayer-only reset does not touch) and stamping `deployed_at`.

The EVM leg addresses (Base vault/dispatcher, zkSync forwarder) and the consensus
address are carried over from the manifest being written, so a GenLayer reset
never silently rewrites addresses it did not deploy. Every one can be overridden
by env if the EVM leg is ever redeployed.

Run (from the repo root):

    V3_GENLAYER_KEY=0x<hex> \
      "$LOCALAPPDATA/Temp/glpy019/venv/Scripts/python.exe" \
      v3-crosschain/genlayer/scripts/arm_v3_demo.py \
        --from /tmp/trio.json --into frontend/demo-manifest.json

Keys are never printed and never committed.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from genlayer_py.accounts.account import create_account
from genlayer_py.chains import studio_devnet
from genlayer_py.client.client import create_client

# Same classification deploy_v3_studio.py uses: retry the transient studio-dev
# failures, die on anything that looks like a real contract/logic error.
_TRANSIENT = (
    "Connection", "Request to", "SSL", "502", "Bad gateway", "invalid JSON",
    "Timeout", "timed out", "Too Many Requests", "429", "Internal Server",
    "Method not found", "-32601", "sim_getFeeConfig", "not supported on this chain",
    "read deadline", "Connection reset",
    # A tx still in flight is not a failure: finalization waits on an appeal
    # window, so an exhausted poll budget means "not yet", not "no".
    "did not reach 'finalized'",
)

# genlayer_py's `interval` is MILLISECONDS (its own default is 3000), not
# seconds. A small value such as 3 buys ~0.2s of sleep over the entire poll
# budget, so the wait fails instantly on any tx that is not already finalized.
WAIT_INTERVAL_MS = 3000
WAIT_RETRIES = 200

BORROW_AMOUNT = 18  # debt 40 -> 58 vs collateral 57 => 98% coverage
CONSENSUS = "0xb7278A61aa25c888815aFC32Ad3cC52fF24fE575"
GENLAYER_RPC = "https://studio-dev.genlayer.com/api"


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


def tx_hash(tx):
    return tx.get("hash") if isinstance(tx, dict) else str(tx)


def success(rec) -> bool:
    return rec.get("txExecutionResultName") == "FINISHED_WITH_RETURN"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--from", dest="src", required=True,
                    help="deploy manifest written by deploy_v3_studio.py --out")
    ap.add_argument("--into", default="frontend/demo-manifest.json",
                    help="frontend manifest to rewrite (default frontend/demo-manifest.json)")
    ap.add_argument("--resume-tx", default="",
                    help="BaseDemoVault.resume() tx hash from this reset, if one ran")
    args = ap.parse_args()

    key = os.environ.get("V3_GENLAYER_KEY", "").strip()
    if not key:
        print("FATAL: set V3_GENLAYER_KEY (0x-hex studio-dev deployer key)", file=sys.stderr)
        return 2

    trio = json.loads(Path(args.src).read_text(encoding="utf-8"))
    vault = trio["demo_vault"]
    bridge = trio["bridge_sender"]
    interlock = trio["interlock_v3"]
    min_bond = int(trio["min_bond"])
    op_index = int(trio["exploit_op_index"])

    into = Path(args.into)
    # The EVM legs do not change on a GenLayer reset, so carry them over rather
    # than inventing them. A missing manifest is fatal — silently writing a
    # half-populated one would deploy a page with no destination chain.
    if not into.exists():
        print(f"FATAL: {into} does not exist — cannot carry over the EVM legs", file=sys.stderr)
        return 2
    prev = json.loads(into.read_text(encoding="utf-8"))

    base = dict(prev.get("base_sepolia") or {})
    zksync = dict(prev.get("zksync_sepolia") or {})
    base["vault"] = os.environ.get("BASE_VAULT_ADDRESS", trio.get("target_contract") or base.get("vault", ""))
    base["dispatcher"] = os.environ.get("BASE_DISPATCHER_ADDRESS", base.get("dispatcher", ""))
    base["eid"] = int(trio.get("target_chain_eid") or base.get("eid") or 40245)

    for label, addr in (("base_sepolia.vault", base.get("vault")),
                        ("base_sepolia.dispatcher", base.get("dispatcher")),
                        ("zksync_sepolia.forwarder", zksync.get("forwarder"))):
        if not (isinstance(addr, str) and addr.startswith("0x") and len(addr) == 42):
            print(f"FATAL: {label} is not a 20-byte address: {addr!r}", file=sys.stderr)
            return 2

    account = create_account(key if key.startswith("0x") else "0x" + key)
    client = create_client(chain=studio_devnet, account=account)

    bar = "=" * 72
    print(f"{bar}\nV3 DEMO RESET — arming the fresh trio\n{bar}")
    print(f"demo_vault   : {vault}\nbridge_sender: {bridge}\ninterlock_v3 : {interlock}")
    print(f"op_index     : {op_index}   min_bond: {min_bond}")
    print(f"reporter     : {account.address}  (only signs the borrow; the visitor reports)")

    # ---- 1. push coverage under 100% with a real borrow ----------------------
    before = retry(lambda: client.read_contract(vault, "params"), "params")
    print(f"  before: collateral={before['collateral']} debt={before['debt']} "
          f"coverage={before['coverage']}% audit_len={before['audit_len']}")
    if int(before["audit_len"]) != op_index:
        print(f"FATAL: expected audit_len == exploit_op_index ({op_index}) on a fresh "
              f"vault, got {before['audit_len']}. Refusing to arm a vault that is not fresh.",
              file=sys.stderr)
        return 1
    if int(before["coverage"]) < 100:
        print("FATAL: a fresh vault is already undercollateralized — unexpected genesis",
              file=sys.stderr)
        return 1

    fees = retry(lambda: client.estimate_transaction_fees(), "borrow fees")
    tx = retry(lambda: client.write_contract(
        vault, "borrow", account=account, args=[BORROW_AMOUNT], value=0, fees=fees),
        "demo_vault.borrow")
    rec = retry(lambda: client.wait_for_transaction_receipt(
        tx_hash(tx), wait_until="finalized",
        interval=WAIT_INTERVAL_MS, retries=WAIT_RETRIES), "borrow wait")
    print(f"  demo_vault.borrow({BORROW_AMOUNT}): exec={rec.get('txExecutionResultName')} "
          f"tx={tx_hash(tx)}")
    if not success(rec):
        print("    receipt:", json.dumps(rec, default=str)[:1200], file=sys.stderr)
        return 1

    # ---- 2. the pinned entry must actually BE an exploit ---------------------
    after = retry(lambda: client.read_contract(vault, "params"), "params")
    entry = retry(lambda: client.read_contract(vault, "get_audit_entry", args=[op_index]),
                  "get_audit_entry")
    print(f"  after : collateral={after['collateral']} debt={after['debt']} "
          f"coverage={after['coverage']}% audit_len={after['audit_len']}")
    print(f"  audit[{op_index}]: {json.dumps(entry, default=str)}")
    if int(after["coverage"]) >= 100:
        print("FATAL: coverage did not drop below 100% — the pinned entry is NOT an "
              "exploit, and arming the page would invite FALSE reports", file=sys.stderr)
        return 1
    if not entry or entry.get("op") != "borrow":
        print(f"FATAL: audit[{op_index}] is not the borrow we just wrote: {entry}", file=sys.stderr)
        return 1
    print(f"  PASS — audit[{op_index}] is a real undercollateralized borrow "
          f"({after['coverage']}% coverage); a report of it will be judged TRUE")

    # ---- 3. the trio must be untouched by the borrow -------------------------
    s = retry(lambda: client.read_contract(interlock, "status"), "status")
    if s["tripped"] is not False or int(s["report_count"]) != 0:
        print(f"FATAL: fresh interlock_v3 is already used: tripped={s['tripped']} "
              f"reports={s['report_count']}", file=sys.stderr)
        return 1
    hashes = retry(lambda: client.read_contract(bridge, "get_message_hashes"), "outbox")
    if hashes not in ([], {}):
        print(f"FATAL: fresh BridgeSender outbox is not empty: {hashes}", file=sys.stderr)
        return 1
    print("  PASS — interlock_v3 untouched (tripped=False, reports=0), outbox empty")

    # ---- 4. write the manifest the frontend builds from ----------------------
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    # A GenLayer-only reset does NOT re-arm the Base vault, so it must not
    # restamp `vault_armed_at` — that would date a resume() that never happened.
    # Only a run actually handed a --resume-tx may claim a fresh arm; otherwise
    # the previous real record is carried over.
    if args.resume_tx:
        armed_at, resume_tx = now, args.resume_tx
    else:
        armed_at, resume_tx = base.get("vault_armed_at") or "", base.get("resume_tx") or ""
    manifest = {
        "schema": 1,
        "network": "studio-dev",
        "chain_id": int(studio_devnet.id),
        "genlayer_rpc": GENLAYER_RPC,
        "consensus": CONSENSUS,
        "deployed_at": now,
        "min_bond": min_bond,
        "exploit_op_index": op_index,
        "genlayer": {
            "demo_vault": vault,
            "bridge_sender": bridge,
            "interlock_v3": interlock,
        },
        "base_sepolia": {
            "chain_id": int(base.get("chain_id") or 84532),
            "eid": base["eid"],
            "rpc": base.get("rpc") or "https://sepolia.base.org",
            "explorer": base.get("explorer") or "https://sepolia.basescan.org",
            "vault": base["vault"],
            "dispatcher": base["dispatcher"],
            "vault_armed_at": armed_at,
        },
        "zksync_sepolia": {
            "chain_id": int(zksync.get("chain_id") or 300),
            "rpc": zksync.get("rpc") or "https://sepolia.era.zksync.dev",
            "forwarder": zksync["forwarder"],
        },
    }
    if resume_tx:
        # Only ever a resume tx we were actually handed (or carried over). A
        # fabricated hash would link a visitor to the wrong transaction.
        manifest["base_sepolia"]["resume_tx"] = resume_tx

    into.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"\nmanifest -> {into}")
    print(json.dumps(manifest, indent=2))

    print(f"\n{bar}\nARMED — a visitor can now report entry #{op_index} and trip the breaker\n{bar}")
    print(
        "\nStill required for the trip to REACH Base Sepolia:\n"
        "  the relay must be running (relay-v3.yml on a schedule, or relay_ci.py locally).\n"
        "  Without it the guard trips on GenLayer and the Base vault never pauses."
    )
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:  # noqa: BLE001 — surface the full failure to the operator
        print("FATAL:", type(e).__name__, str(e)[:800])
        sys.exit(1)
