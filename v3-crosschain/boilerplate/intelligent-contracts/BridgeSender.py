# v0.3.0
# { "Depends": "py-genlayer:5jycge4q8k23462jtb0b9fyey1s9qz928sz2nbrd9mg4sxqg2qng" }

"""BridgeSender: Sends messages from GenLayer to EVM chains via the bridge service.

Ported from the Foundation boilerplate to the studio-dev v0.3.0 dialect (chain
61997). Two dialect changes vs. the Foundation original, both deploy-verified on
studio-dev:

1. Hashing uses ``gl.Keccak256`` (the v0.3.0 public API). The Foundation import
   ``from genlayer.py.keccak import Keccak256`` does NOT resolve on this runner;
   the runner re-exports the class at the top level of ``genlayer`` (``gl``).
   The hasher API is unchanged: ``Keccak256().update(bytes)...digest().hex()``,
   byte-identical to EVM keccak256.

2. The per-message timestamp salt uses ``gl.message.raw["datetime"]`` (chain time,
   the same anchor every other contract on this branch reads) instead of stdlib
   ``datetime.now()``, so the stored hash is deterministic across validators.

Also disclosed: messages are stored as JSON strings in a
``gl.storage.TreeMap[str, str]`` rather than a ``@allow_storage`` dataclass value
(the dataclass-in-TreeMap form is unverified on the v0.3.0 runner). The PUBLIC
view shapes the relay consumes are UNCHANGED: ``get_message(hash)`` /
``get_messages()`` still return dicts with the keys ``data`` /
``target_chain_id`` / ``target_contract``, where ``data`` is the 0x-hex string of
the stored per-message envelope bytes (the relay's GenLayerToEvm normalizer
already accepts a 0x-hex string). The ABI envelope
``[u32, Address, Address, bytes]`` is preserved verbatim; the EVM-side decode
contract is unchanged.

Construction rule learned the hard way (probe-verified): the v0.3.0 runner does
NOT execute std-object construction at module scope (a module-scope
``MethodEncoder``/``Keccak256`` makes the deploy finish FINISHED_WITH_ERROR), so
every encoder/hasher is built inside ``__init__`` (fail-fast) or inside the method
that uses it.
"""

import json
from typing import Any

import genlayer as gl
from genlayer.types import *  # u32, Address (Keccak256 is gl.Keccak256)


class BridgeSender(gl.contract.Contract):
    messages: gl.storage.TreeMap[str, str]  # message_hash -> JSON string

    def __init__(self):
        # FAIL-FAST at deploy: exercise the exact runtime primitives send_message
        # uses (gl.evm.MethodEncoder envelope, Address(str), sender .as_bytes,
        # gl.Keccak256 hasher), so a dialect/API drift fails the deploy loudly
        # rather than surfacing only on the first real cross-chain send. Module
        # scope cannot hold these on the v0.3.0 runner, so they are validated
        # here and built inline inside send_message.
        enc = gl.evm.MethodEncoder("", (u32, Address, Address, bytes), bool)
        _boot_blob = enc.encode_call(
            (61998, gl.message.sender_address, Address("0x" + "00" * 20), b"\x00probe")
        )
        _boot_hash = gl.Keccak256()
        _boot_hash.update(gl.message.sender_address.as_bytes)
        _ = _boot_hash.digest()

    @gl.public.write
    def send_message(self, target_chain_id: int, target_contract: str, data: bytes) -> str:
        """Send a message to be bridged. Returns message hash for tracking."""
        hasher = gl.Keccak256()
        hasher.update(str(gl.message.raw["datetime"]).encode())
        hasher.update(gl.message.sender_address.as_bytes)
        hasher.update(target_contract.encode())
        hasher.update(data)

        message_hash = hasher.digest().hex()

        encoder = gl.evm.MethodEncoder("", (u32, Address, Address, bytes), bool)
        message_bytes = encoder.encode_call(
            (61998, gl.message.sender_address, Address(target_contract), data)
        )[4:]  # Remove method selector

        self.messages[message_hash] = json.dumps(
            {
                "target_chain_id": int(target_chain_id),
                "target_contract": target_contract,
                "data": "0x" + message_bytes.hex(),
            }
        )
        return message_hash

    @gl.public.view
    def get_message(self, message_hash: str) -> dict[str, Any]:
        raw = self.messages.get(message_hash, "")
        if raw == "":
            return {"found": False, "message_hash": message_hash}
        return json.loads(raw)

    @gl.public.view
    def get_messages(self) -> dict[str, dict[str, Any]]:
        out: dict[str, dict[str, Any]] = {}
        for k in self.messages.keys():
            out[k] = json.loads(self.messages[k])
        return out

    @gl.public.view
    def get_message_hashes(self) -> list[str]:
        return list(self.messages.keys())
