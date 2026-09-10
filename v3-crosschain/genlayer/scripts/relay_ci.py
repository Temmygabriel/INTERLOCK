"""relay_ci.py — the always-on relay hop, built for CI (scheduled workflow).

This is the port of `relay_trip_v3.py` that can run unattended: every address
comes from `frontend/demo-manifest.json`, so a demo reset that redeploys the
GenLayer trio (new `bridge_sender`) is picked up with no code change. The older
script hardcoded the BridgeSender and silently read the WRONG outbox after a
redeploy — that class of bug is why this one takes a manifest.

What it does, per message hash found in the GenLayer outbox:

    validate envelope (target eid / target contract / localContract / "TRIP")
      -> quote the LayerZero native fee
      -> BridgeForwarder.callRemoteArbitrary(hash, dstEid, payload, options)
         on zkSync Era Sepolia
      -> LayerZero V2 -> BaseTripDispatcher.lzReceive
      -> BaseDemoVault.processBridgeMessage("TRIP") -> trip() -> paused = true

It polls the outbox for a bounded window and exits 0 when there is nothing to
relay — an empty outbox is a normal outcome, not a failure. Consecutive runs are
expected to OVERLAP (the workflow is scheduled every 5 min and each run covers
~4.5 min), which is what keeps effective relay latency near the poll interval;
the per-message `isHashUsed` check on the forwarder makes double-delivery safe.

TRUST MODEL (do not soften): the destination chain trusts THIS relay to
faithfully forward a message that really came from confirmed GenLayer consensus.
Nothing here is an independent finality proof. If this workflow stops running, a
genuine GenLayer-side trip never reaches Base Sepolia.

Run:
    V3_RELAY_KEY=0x<hex> "$LOCALAPPDATA/Temp/glpy019/venv/Scripts/python.exe" \
        v3-crosschain/genlayer/scripts/relay_ci.py [--window 270] [--poll 20] \
        [--once] [--manifest frontend/demo-manifest.json]
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

from eth_abi import decode, encode
from genlayer_py.accounts.account import create_account
from genlayer_py.chains import studio_devnet
from genlayer_py.client.client import create_client
from web3 import Web3
from web3.logs import DISCARD

_TRANSIENT = (
    "Connection", "Request to", "SSL", "502", "Bad gateway", "invalid JSON",
    "Timeout", "timed out", "Too Many Requests", "429", "Internal Server",
    "Method not found", "-32601", "sim_getFeeConfig", "not supported on this chain",
    "read deadline", "Connection reset", "aborted", "503", "504",
)

FORWARDER_ABI = json.loads(
    """[
      {"type":"function","name":"callRemoteArbitrary","stateMutability":"payable",
       "inputs":[{"type":"bytes32"},{"type":"uint32"},{"type":"bytes"},{"type":"bytes"}],
       "outputs":[]},
      {"type":"function","name":"quoteCallRemoteArbitrary","stateMutability":"view",
       "inputs":[{"type":"uint32"},{"type":"bytes"},{"type":"bytes"}],
       "outputs":[{"type":"uint256"},{"type":"uint256"}]},
      {"type":"function","name":"isHashUsed","stateMutability":"view",
       "inputs":[{"type":"bytes32"}],"outputs":[{"type":"bool"}]},
      {"type":"event","name":"RemoteBridgeSent","anonymous":false,
       "inputs":[{"indexed":true,"type":"uint32","name":"dstEid"},
                 {"indexed":true,"type":"bytes32","name":"dstBridgeAddress"},
                 {"indexed":false,"type":"bytes","name":"data"}]}
    ]"""
)

VAULT_ABI = json.loads(
    """[
      {"type":"function","name":"paused","stateMutability":"view","inputs":[],
       "outputs":[{"type":"bool"}]},
      {"type":"function","name":"auditLen","stateMutability":"view","inputs":[],
       "outputs":[{"type":"uint256"}]},
      {"type":"function","name":"coverage","stateMutability":"view","inputs":[],
       "outputs":[{"type":"uint256"}]}
    ]"""
)


def retry(fn, label, attempts=5):
    """studio-dev drops connections mid-request; every RPC here is idempotent."""
    last = None
    for i in range(attempts):
        try:
            return fn()
        except Exception as e:  # noqa: BLE001
            last = e
            if any(t in str(e) for t in _TRANSIENT):
                print(f"    [retry {label}: {type(e).__name__} — backoff {i + 1}]", flush=True)
                time.sleep(3 * (i + 1))
                continue
            raise
    raise last


def build_lz_options(gas: int = 1_000_000, value: int = 0) -> bytes:
    """LayerZero V2 options, type 3: 0x0003 | workerId 0x01 | uint16 len | (type 0x01, gas, value)."""
    executor_opts = b"\x01" + gas.to_bytes(16, "big") + value.to_bytes(16, "big")
    return b"\x00\x03" + b"\x01" + len(executor_opts).to_bytes(2, "big") + executor_opts


def decode_envelope(data_hex: str):
    return decode(["uint32", "address", "address", "bytes"], bytes.fromhex(data_hex[2:]))


class Relay:
    def __init__(self, manifest: dict):
        self.m = manifest
        gl = manifest["genlayer"]
        base = manifest["base_sepolia"]
        zk = manifest["zksync_sepolia"]
        self.bridge_sender = gl["bridge_sender"]
        self.vault = base["vault"]
        self.dst_eid = int(base["eid"])
        self.forwarder = zk["forwarder"]
        self.base_rpc = base["rpc"]
        self.zk_rpc = zk["rpc"]

        self.gl = create_client(chain=studio_devnet, account=create_account())
        self.zk = Web3(Web3.HTTPProvider(self.zk_rpc, request_kwargs={"timeout": 60}))
        self.base = Web3(Web3.HTTPProvider(self.base_rpc, request_kwargs={"timeout": 30}))
        self.fwd = self.zk.eth.contract(
            address=Web3.to_checksum_address(self.forwarder), abi=FORWARDER_ABI)
        self.vlt = self.base.eth.contract(
            address=Web3.to_checksum_address(self.vault), abi=VAULT_ABI)
        self.options = build_lz_options()

        key = os.environ.get("V3_RELAY_KEY", "").strip()
        if not key:
            raise SystemExit("FATAL: set V3_RELAY_KEY")
        if not key.startswith("0x"):
            key = "0x" + key
        self.acct = self.zk.eth.account.from_key(key)

    # -- outbox -------------------------------------------------------------
    def outbox(self):
        return retry(lambda: self.gl.read_contract(self.bridge_sender, "get_message_hashes"),
                     "outbox")

    def pending(self):
        """Hashes in the GenLayer outbox that the forwarder has NOT yet relayed."""
        out = []
        for h in self.outbox():
            used = retry(lambda: self.fwd.functions.isHashUsed(bytes.fromhex(h)).call(),
                         "isHashUsed")
            if not used:
                out.append(h)
        return out

    # -- one message --------------------------------------------------------
    def relay(self, msg_hash: str) -> bool:
        print(f"\n-- relaying {msg_hash} --", flush=True)
        msg = retry(lambda: self.gl.read_contract(self.bridge_sender, "get_message", [msg_hash]),
                    "get_message")
        data = msg["data"] if isinstance(msg, dict) else None
        if not data:
            print("  SKIP: message has no data")
            return False
        if int(msg["target_chain_id"]) != self.dst_eid:
            print(f"  SKIP: target_chain_id {msg['target_chain_id']} != {self.dst_eid}")
            return False
        if str(msg["target_contract"]).lower() != self.vault.lower():
            print(f"  SKIP: target_contract {msg['target_contract']} != vault {self.vault}")
            return False

        src_chain_id, src_sender, local_contract, inner = decode_envelope(data)
        tag = decode(["string"], inner)[0]
        canonical = inner == encode(["string"], ["TRIP"])
        print(f"  srcChainId={src_chain_id} srcSender={src_sender} "
              f"localContract={local_contract} message={tag!r} canonical={canonical}")
        if local_contract.lower() != self.vault.lower():
            print("  SKIP: envelope localContract is not the whitelisted vault "
                  "(dispatcher would revert UntrustedTarget)")
            return False
        if tag != "TRIP":
            print(f"  SKIP: payload does not decode to TRIP (got {tag!r})")
            return False

        payload = bytes.fromhex(data[2:])
        native_fee, _ = retry(
            lambda: self.fwd.functions.quoteCallRemoteArbitrary(
                self.dst_eid, payload, self.options).call(), "quote")
        bal = self.zk.eth.get_balance(self.acct.address)
        print(f"  quoted LZ fee: {Web3.from_wei(native_fee, 'ether')} ETH   "
              f"relay balance: {Web3.from_wei(bal, 'ether')} ETH")
        if bal < native_fee:
            print("  FAIL: relay balance does not cover the quoted LayerZero fee")
            return False

        fn = self.fwd.functions.callRemoteArbitrary(
            bytes.fromhex(msg_hash), self.dst_eid, payload, self.options)
        try:
            gas = int(fn.estimate_gas({"from": self.acct.address, "value": native_fee}) * 1.5)
        except Exception as e:  # noqa: BLE001 — already-relayed race lands here
            print(f"  estimate_gas failed ({type(e).__name__}: {str(e)[:160]}) — "
                  "likely a concurrent run won the race")
            return False
        tx = fn.build_transaction({
            "from": self.acct.address,
            "value": native_fee,
            "nonce": self.zk.eth.get_transaction_count(self.acct.address),
            "chainId": self.zk.eth.chain_id,
            "gas": gas,
            "maxFeePerGas": self.zk.eth.gas_price * 2,
            "maxPriorityFeePerGas": self.zk.eth.max_priority_fee or 0,
        })
        signed = self.acct.sign_transaction(tx)
        raw = getattr(signed, "raw_transaction", None) or signed.rawTransaction
        h = self.zk.eth.send_raw_transaction(raw)
        print(f"  callRemoteArbitrary TX: {h.hex()}", flush=True)
        rec = self.zk.eth.wait_for_transaction_receipt(h, timeout=600)
        print(f"  receipt status={rec.status} block={rec.blockNumber}")
        if rec.status != 1:
            print("  FAIL: forwarder tx reverted")
            return False
        for ev in self.fwd.events.RemoteBridgeSent().process_receipt(rec, errors=DISCARD):
            print(f"  RemoteBridgeSent -> dstEid={ev.args.dstEid}")
        return True

    # -- delivery watch -----------------------------------------------------
    def wait_paused(self, deadline_s: int = 240) -> bool:
        """LayerZero delivery is a separate hop; poll the vault, never assume."""
        if retry(lambda: self.vlt.functions.paused().call(), "paused") is True:
            return True
        end = time.time() + deadline_s
        while time.time() < end:
            time.sleep(20)
            try:
                if self.vlt.functions.paused().call() is True:
                    return True
            except Exception as e:  # noqa: BLE001 — RPC lag must never be fatal
                print(f"  (read error: {type(e).__name__}: {str(e)[:100]})")
        return False


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest", default="frontend/demo-manifest.json")
    ap.add_argument("--window", type=int, default=270,
                    help="seconds to keep polling the outbox (overlaps the 5-min schedule)")
    ap.add_argument("--poll", type=int, default=20, help="seconds between outbox polls")
    ap.add_argument("--once", action="store_true", help="single poll, then exit")
    args = ap.parse_args()

    bar = "=" * 72
    print(f"{bar}\nINTERLOCK V3 RELAY (CI) — GenLayer outbox -> zkSync -> LZ -> Base\n{bar}",
          flush=True)

    path = Path(args.manifest)
    if not path.exists():
        print(f"FATAL: manifest not found: {path}", file=sys.stderr)
        return 2
    manifest = json.loads(path.read_text(encoding="utf-8"))
    r = Relay(manifest)
    print(f"bridge_sender : {r.bridge_sender}")
    print(f"forwarder     : {r.forwarder}  (zkSync Era Sepolia)")
    print(f"vault         : {r.vault}  (Base Sepolia, eid {r.dst_eid})")
    print(f"relay signer  : {r.acct.address}")
    print(f"vault paused  : {retry(lambda: r.vlt.functions.paused().call(), 'paused')}")

    deadline = time.time() + (0 if args.once else args.window)
    relayed = 0
    while True:
        try:
            todo = r.pending()
        except Exception as e:  # noqa: BLE001 — a flaky outbox read must not kill the run
            print(f"  (outbox read failed: {type(e).__name__}: {str(e)[:140]})", flush=True)
            todo = []
        if todo:
            print(f"\noutbox: {len(todo)} unrelayed message(s)", flush=True)
            for h in todo:
                if r.relay(h):
                    relayed += 1
            if relayed and r.wait_paused():
                print(f"\n*** BaseDemoVault.paused = TRUE (coverage "
                      f"{r.vlt.functions.coverage().call()}%, "
                      f"auditLen {r.vlt.functions.auditLen().call()}) ***")
                print(f"*** https://sepolia.basescan.org/address/{r.vault} ***")
                break
        else:
            print(f"  outbox clear ({time.strftime('%H:%M:%S')})", flush=True)

        if args.once or time.time() >= deadline:
            break
        time.sleep(args.poll)

    if relayed == 0:
        print("\nNo unrelayed messages — nothing to do (exit 0).")
    else:
        print(f"\nRelayed {relayed} message(s).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
