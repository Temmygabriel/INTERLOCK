"""preflight_v3.py — verify the LIVE v3 cross-chain wiring on-chain and quote the
LayerZero fee BEFORE filing the real report (task #33 preflight).

Read-only. No keys, no signing, no state change. Every check below is a fact
read back from the chain, not an assumption:

  zkSync Era Sepolia (hub)
    * forwarder.endpoint()                    == the LZ V2 endpoint
    * forwarder.hasRole(CALLER_ROLE, relay)   the relay may call callRemoteArbitrary
    * forwarder.bridgeAddresses(40245)        == BaseTripDispatcher
    * relay native balance                    must cover gas + the quoted LZ fee
    * quoteCallRemoteArbitrary(40245, dummy, options) -> nativeFee
      (a malformed LayerZero `options` blob makes this revert, so a returned fee
       doubles as a validation of the hand-built options encoding)
  Base Sepolia (destination)
    * dispatcher.trustedForwarders(40305)     == forwarder
    * dispatcher.trustedTargets(vault)        == true
    * vault.bridgeReceiver()                  == dispatcher
    * vault.paused()                          == false (before the trip)

Run:
    "$LOCALAPPDATA/Temp/glpy019/venv/Scripts/python.exe" \
        v3-crosschain/genlayer/scripts/preflight_v3.py
"""
from __future__ import annotations

import json
import sys

from eth_utils import keccak
from web3 import Web3

# --- live addresses (tasks #31 EVM leg, #32 GenLayer leg) ---------------------
ZKSYNC_RPC = "https://sepolia.era.zksync.dev"
BASE_RPC = "https://sepolia.base.org"

ZKSYNC_EID = 40305
BASE_EID = 40245

FORWARDER = "0x1567e63787e0fE93653dfe0cC1eaEf554EB237A5"  # zkSync Era Sepolia
DISPATCHER = "0x1567e63787e0fE93653dfe0cC1eaEf554EB237A5"  # Base Sepolia
VAULT = "0xCF3EfC03eb49F36f7a806FD39eDcDD3Db8EaB567"       # Base Sepolia
RELAY = "0x6F539bD20033eE4cEC78784eac4C91fcAAc01f5b"        # relay EOA (CALLER_ROLE)

FORWARDER_ABI = json.loads(
    """[
      {"type":"function","name":"endpoint","stateMutability":"view","inputs":[],
       "outputs":[{"type":"address"}]},
      {"type":"function","name":"hasRole","stateMutability":"view",
       "inputs":[{"type":"bytes32"},{"type":"address"}],"outputs":[{"type":"bool"}]},
      {"type":"function","name":"bridgeAddresses","stateMutability":"view",
       "inputs":[{"type":"uint32"}],"outputs":[{"type":"bytes32"}]},
      {"type":"function","name":"quoteCallRemoteArbitrary","stateMutability":"view",
       "inputs":[{"type":"uint32"},{"type":"bytes"},{"type":"bytes"}],
       "outputs":[{"type":"uint256"},{"type":"uint256"}]}
    ]"""
)

DISPATCHER_ABI = json.loads(
    """[
      {"type":"function","name":"trustedForwarders","stateMutability":"view",
       "inputs":[{"type":"uint32"}],"outputs":[{"type":"bytes32"}]},
      {"type":"function","name":"trustedTargets","stateMutability":"view",
       "inputs":[{"type":"address"}],"outputs":[{"type":"bool"}]},
      {"type":"function","name":"owner","stateMutability":"view","inputs":[],
       "outputs":[{"type":"address"}]}
    ]"""
)

VAULT_ABI = json.loads(
    """[
      {"type":"function","name":"bridgeReceiver","stateMutability":"view","inputs":[],
       "outputs":[{"type":"address"}]},
      {"type":"function","name":"owner","stateMutability":"view","inputs":[],
       "outputs":[{"type":"address"}]},
      {"type":"function","name":"paused","stateMutability":"view","inputs":[],
       "outputs":[{"type":"bool"}]},
      {"type":"function","name":"coverage","stateMutability":"view","inputs":[],
       "outputs":[{"type":"uint256"}]},
      {"type":"function","name":"auditLen","stateMutability":"view","inputs":[],
       "outputs":[{"type":"uint256"}]}
    ]"""
)

CALLER_ROLE = keccak(text="CALLER_ROLE")
LZ_ENDPOINT_ZKSYNC = "0xe2Ef622A13e71D9Dd2BBd12cd4b27e1516FA8a09"
LZ_ENDPOINT_BASE = "0x6EDCE65403992e310A62460808c4b910D972f10f"

FAILURES: list[str] = []


def check(label: str, ok: bool, detail: str) -> None:
    print(f"  [{'PASS' if ok else 'FAIL'}] {label}: {detail}")
    if not ok:
        FAILURES.append(f"{label} — {detail}")


def build_lz_options(gas: int = 1_000_000, value: int = 0) -> bytes:
    """LayerZero V2 'type 3' options: executor lzReceive(gas, value).

    Layout: 0x0003 | workerId 0x01 | uint16 len(executorOpts) | executorOpts
    where executorOpts = optionType 0x01 | uint128 gas | uint128 value.
    The quote call on the real endpoint validates this encoding.
    """
    executor_opts = b"\x01" + gas.to_bytes(16, "big") + value.to_bytes(16, "big")
    return b"\x00\x03" + b"\x01" + len(executor_opts).to_bytes(2, "big") + executor_opts


def dummy_envelope() -> bytes:
    """A (uint32, address, address, bytes) envelope of the same shape the real
    TRIP message will carry, so the quoted fee matches the live send."""
    from eth_abi import encode

    return encode(
        ["uint32", "address", "address", "bytes"],
        [61998, Web3.to_checksum_address(RELAY), Web3.to_checksum_address(VAULT),
         bytes.fromhex("00" * 32 + "54" + "52" + "49" + "50")],  # abi.encode("TRIP")-ish
    )


def main() -> int:
    bar = "=" * 72
    print(f"{bar}\nV3 CROSS-CHAIN PREFLIGHT — on-chain wiring + LZ fee quote\n{bar}")

    zk = Web3(Web3.HTTPProvider(ZKSYNC_RPC, request_kwargs={"timeout": 30}))
    base = Web3(Web3.HTTPProvider(BASE_RPC, request_kwargs={"timeout": 30}))
    print(f"zkSync Era Sepolia block: {zk.eth.block_number}")
    print(f"Base Sepolia       block: {base.eth.block_number}")

    fwd = zk.eth.contract(address=Web3.to_checksum_address(FORWARDER), abi=FORWARDER_ABI)
    dis = base.eth.contract(address=Web3.to_checksum_address(DISPATCHER), abi=DISPATCHER_ABI)
    vlt = base.eth.contract(address=Web3.to_checksum_address(VAULT), abi=VAULT_ABI)

    print("\n-- zkSync Era Sepolia (hub) --")
    ep = fwd.functions.endpoint().call()
    check("forwarder.endpoint()", ep.lower() == LZ_ENDPOINT_ZKSYNC.lower(), ep)

    has_role = fwd.functions.hasRole(CALLER_ROLE, Web3.to_checksum_address(RELAY)).call()
    check("forwarder.hasRole(CALLER_ROLE, relay)", bool(has_role), f"relay={RELAY} -> {has_role}")

    b = fwd.functions.bridgeAddresses(BASE_EID).call()
    b_addr = Web3.to_checksum_address(b[-20:])
    check(
        f"forwarder.bridgeAddresses({BASE_EID})",
        b_addr.lower() == DISPATCHER.lower(),
        f"{b_addr} (expected {DISPATCHER})",
    )

    bal = zk.eth.get_balance(Web3.to_checksum_address(RELAY))
    print(f"  [INFO] relay zkSync balance: {Web3.from_wei(bal, 'ether')} ETH")

    opts = build_lz_options()
    env = dummy_envelope()
    print(f"  [INFO] options blob ({len(opts)} bytes): 0x{opts.hex()}")
    print(f"  [INFO] dummy envelope ({len(env)} bytes)")
    try:
        native_fee, lz_token_fee = fwd.functions.quoteCallRemoteArbitrary(
            BASE_EID, env, opts
        ).call()
        print(f"  [INFO] quoted LZ native fee: {Web3.from_wei(native_fee, 'ether')} ETH "
              f"(lzTokenFee={lz_token_fee})")
        check("quoteCallRemoteArbitrary accepted our options+envelope", True,
              f"{Web3.from_wei(native_fee, 'ether')} ETH")
        if bal < native_fee:
            check("relay balance covers quoted LZ fee", False,
                  f"{Web3.from_wei(bal, 'ether')} ETH < {Web3.from_wei(native_fee, 'ether')} ETH")
        else:
            check("relay balance covers quoted LZ fee", True,
                  f"{Web3.from_wei(bal, 'ether')} ETH >= {Web3.from_wei(native_fee, 'ether')} ETH "
                  f"(plus gas headroom needed)")
    except Exception as e:  # noqa: BLE001 — a revert here is the finding
        check("quoteCallRemoteArbitrary accepted our options+envelope", False,
              f"reverted: {type(e).__name__}: {str(e)[:300]}")

    print("\n-- Base Sepolia (destination) --")
    tf = dis.functions.trustedForwarders(ZKSYNC_EID).call()
    tf_addr = Web3.to_checksum_address(tf[-20:])
    check(f"dispatcher.trustedForwarders({ZKSYNC_EID})", tf_addr.lower() == FORWARDER.lower(),
          f"{tf_addr} (expected {FORWARDER})")

    tt = dis.functions.trustedTargets(Web3.to_checksum_address(VAULT)).call()
    check("dispatcher.trustedTargets(vault)", bool(tt), f"{VAULT} -> {tt}")

    br = vlt.functions.bridgeReceiver().call()
    check("vault.bridgeReceiver()", br.lower() == DISPATCHER.lower(),
          f"{br} (expected {DISPATCHER})")

    paused = vlt.functions.paused().call()
    check("vault.paused() == false (pre-trip)", paused is False, str(paused))
    print(f"  [INFO] vault coverage: {vlt.functions.coverage().call()}%  "
          f"audit_len: {vlt.functions.auditLen().call()}  owner: {vlt.functions.owner().call()}")

    print(f"\n{bar}")
    if FAILURES:
        print(f"PREFLIGHT FAILED — {len(FAILURES)} check(s):")
        for f in FAILURES:
            print("  -", f)
        return 1
    print("PREFLIGHT PASS — wiring verified on-chain, fee quoted")
    return 0


if __name__ == "__main__":
    sys.exit(main())
