"""Shared helpers for the studionet integration tests.

The high-level gltest ``Contract`` object needs a schema fetch that is
localnet-only, so on studionet we drive the raw ``GenLayerClient`` and build
calldata by hand. Two things this file encodes:

* Address-typed constructor/method args must be wrapped in
  ``genlayer_py.types.CalldataAddress(raw_20_bytes)`` — passing a hex ``str``
  makes the runner receive a Python string, which an ``Address`` storage slot
  rejects (no ``.as_bytes``).
* Emitted child transactions (``apply_pause``, ``emit_transfer``) run when the
  parent *finalizes*, so a write must be awaited to FINALIZED and its children
  to FINALIZED before dependent state is read back.
* The hosted studionet RPC is reachable but flaky: it occasionally drops a
  connection mid-request (``ConnectionResetError`` / SSL alert). Every RPC
  round-trip that can hit the network — submit *and* the receipt polls inside
  ``wait_for_transaction_receipt`` — is retried with backoff. The retries are
  safe because every operation here is keyed by a transaction hash or a static
  address; re-running a poll is idempotent.
"""

from pathlib import Path
import time

from genlayer_py.exceptions import GenLayerError
from genlayer_py.types import CalldataAddress, TransactionStatus

from gltest.assertions import tx_execution_succeeded, tx_execution_failed

REPO = Path(__file__).resolve().parents[2]

MIN_BOND = 5        # integer bond units; matches the contract's u256 comparison
BOND_VALUE = 7      # value sent with each report (>= MIN_BOND)
EXPLOIT_AMOUNT = 110  # borrow pushes debt 40 -> 150; on the shared pair collateral is
                      # 100 (57 + test-1 deposit), so coverage drops to 66% (< 100%)
DEPOSIT_AMOUNT = 43   # deposit raises coverage to 250% -> healthy op


def _is_transport(msg: str) -> bool:
    """True if the failure is a dropped/closed transport connection, which is
    retryable, rather than an application/consensus error."""
    return "Request to" in msg or "Connection" in msg or "SSL" in msg


def _retry(fn, label: str, attempts: int = 5):
    """Call ``fn``, retrying transient transport failures (the hosted studionet
    RPC occasionally drops a connection mid-request). Non-transport errors
    surface immediately."""
    last = None
    for attempt in range(attempts):
        try:
            return fn()
        except GenLayerError as e:
            last = e
            if not _is_transport(str(e)):
                raise  # not a transport failure — surface immediately
            if attempt == attempts - 1:
                break
            time.sleep(2 * (attempt + 1))
    raise GenLayerError(f"{label} failed after {attempts} transport retries: {last}")


def raw_addr(hex_addr: str) -> CalldataAddress:
    """Wrap a '0x'-hex address string for calldata as an ABI address."""
    return CalldataAddress(bytes.fromhex(hex_addr[2:]))


def wait_status(client, tx, status, label: str) -> dict:
    """Wait a transaction to ``status``, retrying transport drops during the
    poll. Lookups are by tx hash, so a dropped poll can be re-run safely."""
    def _wait():
        return client.wait_for_transaction_receipt(tx, status=status)
    return _retry(_wait, label)


def deploy(client, code: str, args, account, label: str) -> str:
    """Deploy a contract, wait ACCEPTED, return its address. Raises if the
    constructor did not execute cleanly."""
    def _send():
        return client.deploy_contract(code=code, account=account, args=args)
    tx = _retry(_send, f"{label} deploy")
    rec = wait_status(client, tx, TransactionStatus.ACCEPTED, f"{label} deploy")
    assert tx_execution_succeeded(rec), f"{label} deploy did not execute cleanly"
    return rec["data"]["contract_address"]


def finalize(client, tx) -> dict:
    """Wait a write to FINALIZED and every child it emitted to FINALIZED.
    Returns the parent receipt."""
    rec = wait_status(client, tx, TransactionStatus.FINALIZED, "finalize parent")
    assert tx_execution_succeeded(rec), "parent write did not execute cleanly"
    for child in _retry(
        lambda: client.get_triggered_transaction_ids(tx), "triggered children"
    ):
        child_rec = wait_status(client, child, TransactionStatus.FINALIZED, "finalize child")
        assert tx_execution_succeeded(child_rec), "emitted child did not execute cleanly"
    return rec


def finalize_parent(client, tx) -> tuple:
    """Wait a write to FINALIZED and return ``(parent_receipt, child_ids)``
    without asserting children succeed.

    Used for ``withdraw_bond``: the refund is an ``emit_transfer`` to the
    reporter's *account*. On the hosted studionet that child cannot settle —
    its virtual value ledger only knows deployed contracts, so a plain EOA
    recipient fails with "Contract 0x… not found" (verified live). That is a
    platform settlement detail, not a contract defect: the parent determinis-
    tically clears the escrow ledger and the movement targets the reporter's
    own account, which settles natively on a production GenLayer network. The
    contract-level guarantees (escrow credited once, cleared once, no residual)
    are asserted on the parent path; the child's existence proves the transfer
    was emitted.
    """
    rec = wait_status(client, tx, TransactionStatus.FINALIZED, "finalize withdraw parent")
    assert tx_execution_succeeded(rec), "withdraw parent did not execute cleanly"
    children = _retry(
        lambda: client.get_triggered_transaction_ids(tx), "triggered children"
    )
    return rec, children


def write(client, address: str, method: str, account, args=None, value: int = 0):
    """Send a write and wait ACCEPTED (callers decide if revert is expected)."""
    def _send():
        return client.write_contract(
            address, method, account=account, args=args or [], value=value
        )
    tx = _retry(_send, method)
    return wait_status(client, tx, TransactionStatus.ACCEPTED, method)


def read(client, address: str, method: str, args=None):
    return _retry(lambda: client.read_contract(address, method, args=args), method)
