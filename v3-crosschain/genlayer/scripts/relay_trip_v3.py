"""relay_trip_v3.py — the relay hop of the Interlock v3 cross-chain run.

Reads the TRIP message the GenLayer `BridgeSender` outbox is holding, then does
exactly what the Foundation relay service (`service/src/relay/GenLayerToEvm.ts`)
does, in one observable shot:

    BridgeForwarder.callRemoteArbitrary(hash, 40245, envelope, options)
      on zkSync Era Sepolia, paying the quoted LayerZero native fee
        -> LayerZero V2 -> BaseTripDispatcher.lzReceive (Base Sepolia)
        -> BaseDemoVault.processBridgeMessage("TRIP") -> trip() -> paused = true

TRUST MODEL (do not soften): this step is the whole point of the disclosure. The
destination chain trusts THIS relay to faithfully deliver a message that really
came from confirmed GenLayer consensus. There is no independent finality proof
binding the outbound message to validator consensus. If this script does not run,
a real GenLayer-side trip never reaches Base Sepolia.

Run:
    V3_RELAY_KEY=0x<hex> "$LOCALAPPDATA/Temp/glpy019/venv/Scripts/python.exe" \
        v3-crosschain/genlayer/scripts/relay_trip_v3.py [--quote-only]
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

ZKSYNC_RPC = "https://sepolia.era.zksync.dev"
BASE_RPC = "https://sepolia.base.org"
BASE_EID = 40245
FORWARDER = "0x1567e63787e0fE93653dfe0cC1eaEf554EB237A5"
VAULT = "0xCF3EfC03eb49F36f7a806FD39eDcDD3Db8EaB567"
BRIDGE_SENDER = "0x751885dB21a891FE52619eD785b5EE9e22eAa17B"

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


def build_lz_options(gas: int = 1_000_000, value: int = 0) -> bytes:
    executor_opts = b"\x01" + gas.to_bytes(16, "big") + value.to_bytes(16, "big")
    return b"\x00\x03" + b"\x01" + len(executor_opts).to_bytes(2, "big") + executor_opts


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--quote-only", action="store_true")
    args = ap.parse_args()

    bar = "=" * 72
    print(f"{bar}\nV3 RELAY — GenLayer outbox -> zkSync forwarder -> LayerZero -> Base\n{bar}")

    # ---- 1. read the outbox (no key needed) --------------------------------
    # The SDK refuses read_contract without a connected account, so attach a
    # throwaway one: these are pure views, nothing is signed with it.
    gl_client = create_client(chain=studio_devnet, account=create_account())
    hashes = gl_client.read_contract(BRIDGE_SENDER, "get_message_hashes")
    print(f"outbox hashes: {json.dumps(hashes, default=str)}")
    if not hashes:
        print("FATAL: the GenLayer outbox is empty — nothing to relay")
        return 1
    if len(hashes) > 1:
        print(f"WARNING: {len(hashes)} messages in the outbox; relaying the first")
    msg_hash = hashes[0]
    msg = gl_client.read_contract(BRIDGE_SENDER, "get_message", [msg_hash])
    data = msg["data"] if isinstance(msg, dict) else None
    print(f"message hash      : {msg_hash}")
    print(f"target_chain_id   : {msg.get('target_chain_id')}")
    print(f"target_contract   : {msg.get('target_contract')}")
    print(f"data ({len(bytes.fromhex(data[2:]))} bytes): {data[:130]}…")

    if int(msg["target_chain_id"]) != BASE_EID:
        print("FATAL: target_chain_id is not Base Sepolia 40245")
        return 1
    if str(msg["target_contract"]).lower() != VAULT.lower():
        print("FATAL: target_contract is not the BaseDemoVault")
        return 1

    src_chain_id, src_sender, local_contract, inner = _decode_envelope(data)
    print("\ndecoded envelope:")
    print(f"  srcChainId    : {src_chain_id}")
    print(f"  srcSender     : {src_sender}   (expect interlock_v3 0x49499d…)")
    print(f"  localContract : {local_contract}   (expect BaseDemoVault {VAULT})")
    inner_tag = decode(["string"], inner)[0]
    canonical = inner == encode(["string"], ["TRIP"])
    print(f"  message       : {inner_tag!r} (abi.encode(string); canonical={canonical})")
    if local_contract.lower() != VAULT.lower():
        print("FATAL: envelope localContract is not the whitelisted BaseDemoVault")
        return 1
    if inner_tag != "TRIP":
        print("FATAL: envelope payload does not decode to the TRIP tag")
        return 1

    # ---- 2. quote + send on zkSync -----------------------------------------
    zk = Web3(Web3.HTTPProvider(ZKSYNC_RPC, request_kwargs={"timeout": 60}))
    fwd = zk.eth.contract(address=Web3.to_checksum_address(FORWARDER), abi=FORWARDER_ABI)
    payload = bytes.fromhex(data[2:])
    options = build_lz_options()
    native_fee, _ = fwd.functions.quoteCallRemoteArbitrary(BASE_EID, payload, options).call()
    print(f"\nquoted LZ native fee: {Web3.from_wei(native_fee, 'ether')} ETH")
    print(f"already relayed?    : {fwd.functions.isHashUsed(bytes.fromhex(msg_hash)).call()}")

    if args.quote_only:
        print("(--quote-only: stopping before sending)")
        return 0

    key = os.environ.get("V3_RELAY_KEY", "").strip()
    if not key:
        print("FATAL: set V3_RELAY_KEY", file=sys.stderr)
        return 2
    if not key.startswith("0x"):
        key = "0x" + key
    acct = zk.eth.account.from_key(key)
    print(f"relay signer: {acct.address}")
    bal = zk.eth.get_balance(acct.address)
    print(f"relay zkSync balance: {Web3.from_wei(bal, 'ether')} ETH")
    if bal < native_fee:
        print("FATAL: relay balance does not cover the quoted LayerZero fee")
        return 1

    fn = fwd.functions.callRemoteArbitrary(bytes.fromhex(msg_hash), BASE_EID, payload, options)
    gas = int(fn.estimate_gas({"from": acct.address, "value": native_fee}) * 1.5)
    tx = fn.build_transaction(
        {
            "from": acct.address,
            "value": native_fee,
            "nonce": zk.eth.get_transaction_count(acct.address),
            "chainId": zk.eth.chain_id,
            "gas": gas,
            "maxFeePerGas": zk.eth.gas_price * 2,
            "maxPriorityFeePerGas": zk.eth.max_priority_fee or 0,
        }
    )
    signed = acct.sign_transaction(tx)
    raw = getattr(signed, "raw_transaction", None) or signed.rawTransaction
    tx_hash = zk.eth.send_raw_transaction(raw)
    print(f"\ncallRemoteArbitrary TX: {tx_hash.hex()}")
    rec = zk.eth.wait_for_transaction_receipt(tx_hash, timeout=600)
    print(f"receipt status: {rec.status}  block: {rec.blockNumber}  gasUsed: {rec.gasUsed}")
    if rec.status != 1:
        print("FATAL: forwarder tx reverted")
        return 1
    for ev in fwd.events.RemoteBridgeSent().process_receipt(rec):
        print(f"RemoteBridgeSent -> dstEid={ev.args.dstEid} receiver=0x{ev.args.dstBridgeAddress.hex()[-40:]}")

    # ---- 3. watch Base Sepolia for the trip --------------------------------
    base = Web3(Web3.HTTPProvider(BASE_RPC, request_kwargs={"timeout": 30}))
    vlt = base.eth.contract(address=Web3.to_checksum_address(VAULT), abi=VAULT_ABI)
    print("\nwaiting for LayerZero delivery + BaseDemoVault.trip()…")
    deadline = time.time() + 420
    paused = False
    while time.time() < deadline and not paused:
        try:
            paused = vlt.functions.paused().call()
        except Exception as e:  # noqa: BLE001 — RPC lag must never be fatal
            print(f"  (read error: {type(e).__name__}: {str(e)[:120]})")
        if not paused:
            print(f"  paused=False ({(deadline - time.time()):.0f}s left)")
            time.sleep(20)
    if paused:
        print(f"\n*** BaseDemoVault.paused = TRUE  (coverage {vlt.functions.coverage().call()}%, "
              f"audit_len {vlt.functions.auditLen().call()}) ***")
        print(f"*** https://sepolia.basescan.org/address/{VAULT} ***")
        return 0
    print("\nFAIL: paused is still false after the polling window — re-check the vault; "
          "the LayerZero delivery may simply be slow")
    return 1


def _decode_envelope(data_hex: str):
    return decode(["uint32", "address", "address", "bytes"], bytes.fromhex(data_hex[2:]))


if __name__ == "__main__":
    sys.exit(main())
