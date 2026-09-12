"""run_trip_v3.py — task #33, the LIVE cross-chain run, staged so each step is
observable on its own.

Stages (run in order; each is idempotent-checked against on-chain state):

  borrow   demo_vault.borrow(18) on studio-dev: debt 40 -> 58 against collateral
           57 => coverage 98% (< 100%). audit[0] is the pinned exploit incident.
  report   interlock_v3.report_exploit(0) with value = min_bond (5). GenLayer
           validators independently re-classify the pinned entry; on a CONFIRMED
           verdict the guard emits BridgeSender.send_message(40245, <BaseDemoVault>,
           abi.encode("TRIP")) as a finalized child transaction.
  outbox   read the BridgeSender outbox: the message hash + the exact envelope the
           relay will forward, and interlock_v3's incident record.

The relay hop (zkSync -> LayerZero -> Base Sepolia) is `relay_trip_v3.py`; keeping
it separate means the GenLayer-side facts are captured before any EVM tx is sent.

Run:
    V3_GENLAYER_KEY=0x<hex> "$LOCALAPPDATA/Temp/glpy019/venv/Scripts/python.exe" \
        v3-crosschain/genlayer/scripts/run_trip_v3.py --stage borrow
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

MANIFEST = Path(r"C:\Users\USER\AppData\Local\Temp\glpy019\v3_live_deploy.json")

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
# seconds. A value like 4 buys ~0.5s of sleep over the whole poll budget.
WAIT_INTERVAL_MS = 3000
WAIT_RETRIES = 200


def retry(fn, label, attempts=8):
    last = None
    for i in range(attempts):
        try:
            return fn()
        except Exception as e:  # noqa: BLE001
            last = e
            if any(t in str(e) for t in _TRANSIENT):
                print(f"    [retry {label}: {type(e).__name__} — backoff {i + 1}]")
                time.sleep(3 * (i + 1))
                continue
            raise
    raise last


def tx_hash(tx):
    return tx.get("hash") if isinstance(tx, dict) else str(tx)


def wait(client, tx, label, retries=WAIT_RETRIES):
    def _w():
        return client.wait_for_transaction_receipt(
            tx_hash(tx), wait_until="finalized",
            interval=WAIT_INTERVAL_MS, retries=retries,
        )
    return retry(_w, label + " wait", attempts=3)


def success(rec) -> bool:
    return rec.get("txExecutionResultName") == "FINISHED_WITH_RETURN"


def read(client, addr, method, args=None):
    return retry(lambda: client.read_contract(addr, method, args=args), method)


def write(client, account, addr, method, args, label, value=0, fees_for_write=False):
    """Send a write and wait for FINALIZED.

    ``fees_for_write=True`` uses ``estimate_transaction_fees_for_write``, which
    SIMULATES the call and returns a fee object carrying ``messageAllocations``
    for every message the call emits. That is required for ``report_exploit``:
    its confirmed branch emits ``BridgeSender.send_message`` via
    ``.emit(on="finalized")``, and the plain ``estimate_transaction_fees()``
    budget carries no message allocation at all — the parent then finalizes with
    ``contract_error: "fee no_matching_allocation # internal"`` AFTER consensus
    has already agreed on the verdict (observed live, 2026-09-10).
    """
    if fees_for_write:
        fees = retry(
            lambda: client.estimate_transaction_fees_for_write(
                addr, method, account=account, args=args, value=value
            ),
            label + " fees(for-write)",
        )
        allocs = fees.get("messageAllocations") or fees.get("message_allocations")
        print(f"  {label}: fee estimate carries messageAllocations={allocs}")
    else:
        fees = retry(lambda: client.estimate_transaction_fees(), label + " fees")
    tx = retry(
        lambda: client.write_contract(
            addr, method, account=account, args=args, value=value, fees=fees
        ),
        label,
    )
    rec = wait(client, tx, label)
    print(f"  {label}: exec={rec.get('txExecutionResultName')} tx={tx_hash(tx)}")
    if not success(rec):
        print("    receipt:", json.dumps(rec, default=str)[:1200])
    return tx, rec


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--stage", choices=["borrow", "report", "outbox"], required=True)
    ap.add_argument("--manifest", default=str(MANIFEST))
    args = ap.parse_args()

    m = json.loads(Path(args.manifest).read_text(encoding="utf-8"))
    vault, bridge, interlock = m["demo_vault"], m["bridge_sender"], m["interlock_v3"]
    min_bond = int(m["min_bond"])
    op_index = int(m["exploit_op_index"])

    key = os.environ.get("V3_GENLAYER_KEY", "").strip()
    if not key:
        print("FATAL: set V3_GENLAYER_KEY", file=sys.stderr)
        return 2
    account = create_account(key if key.startswith("0x") else "0x" + key)
    client = create_client(chain=studio_devnet, account=account)

    bar = "=" * 72
    print(f"{bar}\nV3 LIVE TRIP — stage: {args.stage}\n{bar}")
    print(f"demo_vault   : {vault}\nbridge_sender: {bridge}\ninterlock_v3 : {interlock}")
    print(f"op_index     : {op_index}   min_bond: {min_bond}   reporter: {account.address}")

    # ---------------------------------------------------------------- borrow
    if args.stage == "borrow":
        before = read(client, vault, "params")
        print(f"  before: collateral={before['collateral']} debt={before['debt']} "
              f"coverage={before['coverage']}% audit_len={before['audit_len']}")
        if int(before["audit_len"]) > 0:
            print("  audit log already has entries — refusing to add another; "
                  "use --stage report against the existing index.")
            return 1
        tx, rec = write(client, account, vault, "borrow", [18], "demo_vault.borrow(18)")
        if not success(rec):
            return 1
        after = read(client, vault, "params")
        e0 = read(client, vault, "get_audit_entry", [0])
        print(f"  after : collateral={after['collateral']} debt={after['debt']} "
              f"coverage={after['coverage']}% audit_len={after['audit_len']}")
        print(f"  audit[0]: {json.dumps(e0, default=str)}")
        if int(after["coverage"]) >= 100:
            print("  !! coverage is not < 100% — the pinned entry is not an exploit")
            return 1
        print("  PASS — undercollateralized borrow recorded at audit[0] (98% coverage)")
        return 0

    # ---------------------------------------------------------------- report
    if args.stage == "report":
        v = read(client, vault, "params")
        print(f"  vault: coverage={v['coverage']}% audit_len={v['audit_len']}")
        st = read(client, interlock, "status")
        print(f"  interlock before: tripped={st['tripped']} reports={st['report_count']}")

        tx, rec = write(
            client, account, interlock, "report_exploit", [op_index],
            f"interlock_v3.report_exploit({op_index})", value=min_bond,
            fees_for_write=True,
        )
        print("  --- report receipt ---")
        print("  " + json.dumps(rec, default=str)[:2500])
        if not success(rec):
            print("  !! report did NOT execute cleanly")
            return 1

        st = read(client, interlock, "status")
        print(f"  interlock after : tripped={st['tripped']} reports={st['report_count']} "
              f"incidents={st['incident_count']} last_trip_at={st['last_trip_at']}")
        n = int(st["incident_count"])
        if n:
            inc = read(client, interlock, "get_incident", [n - 1])
            print(f"  incident[{n - 1}]: {json.dumps(inc, default=str)}")

        # The `emit(on="finalized")` child is a SEPARATE transaction. Surface its id
        # so the next stage can wait on it rather than guess.
        try:
            children = retry(
                lambda: client.get_triggered_transaction_ids(tx_hash(tx)), "triggered children"
            )
            print(f"  triggered child tx ids: {json.dumps(children, default=str)}")
        except Exception as e:  # noqa: BLE001 — informational, never fatal
            print(f"  (could not list triggered children: {type(e).__name__}: {str(e)[:200]})")
        return 0

    # ---------------------------------------------------------------- outbox
    if args.stage == "outbox":
        st = read(client, interlock, "status")
        print(f"  interlock: tripped={st['tripped']} reports={st['report_count']} "
              f"incidents={st['incident_count']}")
        n = int(st["incident_count"])
        for i in range(n):
            print(f"  incident[{i}]: {json.dumps(read(client, interlock, 'get_incident', [i]), default=str)}")

        hashes = read(client, bridge, "get_message_hashes")
        print(f"  BridgeSender.get_message_hashes(): {json.dumps(hashes, default=str)}")
        if not hashes:
            print("  !! outbox is EMPTY — the bridge message was not stored")
            return 1
        for h in hashes:
            msg = read(client, bridge, "get_message", [h])
            print(f"  get_message({h}): {json.dumps(msg, default=str)[:600]}")
        print("  PASS — TRIP message is in the GenLayer outbox, ready for the relay")
        return 0

    return 2


if __name__ == "__main__":
    sys.exit(main())
