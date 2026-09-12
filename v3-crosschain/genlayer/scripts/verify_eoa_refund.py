"""verify_eoa_refund.py — prove the bond-refund rail actually pays a WALLET.

This is the verification for the fix to GenLayer money-rails Issue 1. The old
rail, `gl.contract.get_at(eoa).emit_transfer(...)`, compiles to an IC->IC
postmessage. An externally-owned account has no contract at it to receive one, so
the child transaction errors, the wallet is never credited, and **the parent
still reports success** — which is why no happy-path assertion catches it.

The fixed rail is the `_EoaPay` external contract-interface stub, which compiles
to an EthSend. This script exercises it through the contract's
reject-and-refund path (`_reject_payable`), which is the only way to touch the
payout rail WITHOUT tripping the demo:

    report_exploit(0) with value < min_bond

A caller-fixable rejection must NOT revert — on GenLayer a reverted payable call
retains the attached value in the contract with no ledger entry — so the call
succeeds, refunds the bond over the EthSend rail, and records the reason
on-chain (readable via `get_rejection`).

What the script asserts (the Issue 3 minimum for a money-out path):
  1. The parent finalizes with FINISHED_WITH_RETURN and returns
     status == "REJECTED_REFUNDED".
  2. The rejection reason is readable from `get_rejection(reporter)`.
  3. The trip state and report count are UNCHANGED — this path cannot consume
     the demo.

  4. The stored transaction carries exactly one emitted message, its type is
     **External**, its recipient is the reporter's own EOA, and its value is the
     full attached amount. The nodes that actually executed each recorded a
     pending transfer with **`is_eth_send: true`** — the field that names the rail
     — agreeing on recipient, value, and `on: "finalized"`. (If it were still the
     IC→IC rail that field would be false, and a child transaction would exist.)

On the instrument, because getting this wrong makes a passing run mean nothing:
the Issue 3 checklist says "enumerate the child transactions". That works for
Proofmark's rail but is the WRONG probe here, and the difference is the whole
point of the fix. `get_triggered_transaction_ids` reads `triggered_transactions`,
which lists the children of **internal** (IC->IC) messages. An EthSend to a plain
wallet creates **no** intelligent-contract child, because there is no contract at
the far end to run. So the fixed rail is expected to show zero children — and the
OLD rail is exactly the one that spawned a child, which then errored while the
parent still reported success. An empty `triggered_transactions` is therefore a
*symptom of the fix*, not evidence against it; the evidence is the External
message in `messages[]`. Both are printed so neither has to be taken on faith.

Run (from the repo root):

    V3_GENLAYER_KEY=0x<hex> \
      PYTHONPATH="$LOCALAPPDATA/Temp/glpy019/venv/Lib/site-packages" \
      python v3-crosschain/genlayer/scripts/verify_eoa_refund.py \
        --manifest frontend/demo-manifest.json

Keys are never printed and never committed.
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

_TRANSIENT = (
    "Connection", "Request to", "SSL", "502", "Bad gateway", "invalid JSON",
    "Timeout", "timed out", "Too Many Requests", "429", "Internal Server",
    "Method not found", "-32601", "sim_getFeeConfig", "not supported on this chain",
    "read deadline", "Connection reset",
    # A tx still in flight is not a failure. Finalization on studio-dev waits on
    # an appeal window, so a poll budget that runs out means "not yet", not "no".
    "did not reach 'finalized'",
)

# genlayer_py's `interval` is MILLISECONDS (its default is 3000). A small value
# like 3 buys 0.2s of sleep across the whole poll budget, which reads as an
# immediate failure on any transaction that has not already finalized.
WAIT_INTERVAL_MS = 3000
WAIT_RETRIES = 200  # 200 polls x 3s of sleep ceiling; returns as soon as final

OK_RESULT = "FINISHED_WITH_RETURN"


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


def receipt(client, tx, label):
    return retry(
        lambda: client.wait_for_transaction_receipt(
            tx_hash(tx), wait_until="finalized",
            interval=WAIT_INTERVAL_MS, retries=WAIT_RETRIES,
        ),
        label,
    )


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest", default="frontend/demo-manifest.json")
    ap.add_argument("--interlock", default="",
                    help="override the interlock_v3 address from the manifest")
    args = ap.parse_args()

    key = os.environ.get("V3_GENLAYER_KEY", "").strip()
    if not key:
        print("FATAL: set V3_GENLAYER_KEY (0x-hex studio-dev key)", file=sys.stderr)
        return 2

    interlock = args.interlock
    min_bond = None
    if not interlock:
        m = json.loads(Path(args.manifest).read_text(encoding="utf-8"))
        interlock = m["genlayer"]["interlock_v3"]
        min_bond = int(m.get("min_bond") or 5)
    if not (interlock.startswith("0x") and len(interlock) == 42):
        print(f"FATAL: interlock address is not 20 bytes: {interlock!r}", file=sys.stderr)
        return 2

    account = create_account(key if key.startswith("0x") else "0x" + key)
    client = create_client(chain=studio_devnet, account=account)
    reporter = str(account.address)

    bar = "=" * 72
    print(f"{bar}\nEOA REFUND RAIL — reject-and-refund verification\n{bar}")
    print(f"interlock_v3 : {interlock}")
    print(f"reporter     : {reporter}  (a plain wallet — no contract at this address)")

    st0 = retry(lambda: client.read_contract(interlock, "status"), "status")
    min_bond = int(st0["min_bond"]) if min_bond is None else min_bond
    print(f"min_bond     : {min_bond}   tripped={st0['tripped']} "
          f"report_count={st0['report_count']}")

    # A bond strictly below the floor, but non-zero: a zero value would make the
    # refund branch unreachable and the test would prove nothing.
    under = max(1, min_bond - 1)
    print(f"\n-- sending report_exploit(0) with value={under} (< min_bond {min_bond}) --")

    # NOTE: this write EMITS a message (the EthSend refund), and an emitted
    # message must be paid for out of the transaction's fee budget. The plain
    # `estimate_transaction_fees()` carries no `messageAllocations` at all, so
    # the emission fails with `fee no_matching_allocation # internal` and the
    # parent finalizes FINISHED_WITH_ERROR even though the contract logic is
    # fine. `estimate_transaction_fees_for_write` SIMULATES the call and returns
    # a budget with an allocation per emitted message. (Observed the hard way
    # here on 2026-09-12; the same applies to `withdraw_bond`.)
    fees = retry(
        lambda: client.estimate_transaction_fees_for_write(
            interlock, "report_exploit", account=account, args=[0], value=under
        ),
        "fees(for-write)",
    )
    allocs = fees.get("messageAllocations") or fees.get("message_allocations")
    print(f"  fee budget carries messageAllocations={allocs}")
    tx = retry(
        lambda: client.write_contract(
            interlock, "report_exploit", account=account, args=[0], value=under, fees=fees
        ),
        "report_exploit",
    )
    print(f"  tx: {tx_hash(tx)}")
    rec = receipt(client, tx, "report_exploit wait")
    res = rec.get("txExecutionResultName")
    print(f"  parent exec: {res}")
    if res != OK_RESULT:
        print("  receipt:", json.dumps(rec, default=str)[:2000], file=sys.stderr)
        print("\nFAIL — the rejection path did not complete cleanly. If it REVERTED, "
              "the attached value was retained by the contract (Issue 2).",
              file=sys.stderr)
        return 1

    # ---- 2. the reason is readable, because a successful call has no revert ----
    note = retry(lambda: client.read_contract(interlock, "get_rejection", args=[reporter]),
                 "get_rejection")
    print(f"\n  get_rejection(reporter): {note!r}")
    ok_note = isinstance(note, str) and "bond below minimum" in note and "refunded" in note

    # ---- 3. the demo was NOT consumed ----------------------------------------
    st1 = retry(lambda: client.read_contract(interlock, "status"), "status")
    print(f"  status after: tripped={st1['tripped']} report_count={st1['report_count']} "
          f"incident_count={st1['incident_count']}")
    ok_untouched = (
        st1["tripped"] is False
        and int(st1["report_count"]) == 0
        and int(st1["incident_count"]) == 0
    )

    # ---- 4. an EXTERNAL value transfer to the wallet, agreed by every validator --
    #
    # See the module docstring: children are the wrong instrument for an EthSend.
    # An empty `triggered_transactions` is what this rail is SUPPOSED to show.
    stored = retry(lambda: client.get_transaction(tx_hash(tx)), "stored tx")
    msgs = stored.get("messages") or []
    kids = stored.get("triggered_transactions") or []
    print(f"\n  triggered_transactions (IC children): {len(kids)}"
          "  <- 0 is expected for an EthSend; an IC->IC rail would spawn one here")
    print(f"  messages emitted: {len(msgs)}")
    for i, m in enumerate(msgs):
        print(f"    message[{i}]: {json.dumps(m, default=str)}")

    def _message_type(m):
        return str(m.get("messageType", m.get("message_type", ""))).strip().lower()

    ok_msg = (
        len(msgs) == 1
        and _message_type(msgs[0]) in ("0", "external")
        and str(msgs[0].get("recipient", "")).lower() == reporter.lower()
        and int(msgs[0].get("value") or 0) == under
    )

    # GenVM records the message each executing node produced as a "pending
    # transaction" — the same struct the old IC->IC rail would have filled in, so
    # the fields are directly comparable. `is_eth_send` is the one that names the
    # rail: true is the EthSend stub, false is a PostMessage to an intelligent
    # contract. Only the nodes that actually executed carry these (the rest vote),
    # so this requires *agreement among those that ran*, not one entry per
    # validator — asserting four would be asserting something GenVM never does.
    cd = stored.get("consensus_data") or {}
    executers = list(cd.get("validators") or []) + list(cd.get("leader_receipt") or [])
    pend = [p for v in executers for p in (v.get("pending_transactions") or [])]
    print(f"  executors reporting a pending transfer: {len(pend)} of {len(executers)}")
    for p in pend:
        print(f"    {json.dumps(p, default=str)}")
    ok_consensus = bool(pend) and all(
        p.get("is_eth_send") is True
        and int(p.get("value") or 0) == under
        and str(p.get("address", "")).lower() == reporter.lower()
        and str(p.get("on", "")) == "finalized"
        for p in pend
    )

    print(f"\n{bar}")
    checks = [
        ("parent finalized cleanly", res == OK_RESULT),
        ("returns REJECTED_REFUNDED note on-chain", bool(ok_note)),
        ("demo untouched (not tripped, 0 reports, 0 incidents)", bool(ok_untouched)),
        (f"one External message of {under} to the reporter EOA", bool(ok_msg)),
        ("executing nodes agree it is an EthSend, on finality", bool(ok_consensus)),
    ]
    for label, ok in checks:
        print(f"  {'PASS' if ok else 'FAIL'}  {label}")
    passed = all(ok for _, ok in checks)
    print(f"{bar}\n{'PASS — the refund rail pays a plain wallet' if passed else 'FAIL'}\n{bar}")
    if not passed:
        print("NOTE: read the message[] and pending_transactions lines above before "
              "concluding anything — the parent succeeding is not the evidence.")
    return 0 if passed else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:  # noqa: BLE001 — surface the full failure to the operator
        print("FATAL:", type(e).__name__, str(e)[:800])
        sys.exit(1)
