# v0.3.0
# { "Depends": "py-genlayer:5jycge4q8k23462jtb0b9fyey1s9qz928sz2nbrd9mg4sxqg2qng" }

"""StringSender: Example that sends strings from GenLayer to EVM via BridgeSender.

Ported to the studio-dev v0.3.0 dialect (chain 61997) alongside BridgeSender.py.
This is the boilerplate's own GenLayer->EVM example and is NOT on the v3 TRIP
critical path (interlock_v3 calls BridgeSender directly). It is structurally
ported but was NOT deploy-verified the way BridgeSender.py / demo_vault.py /
interlock_v3.py were — treat its first deploy as the verification.

Dialect changes mirror the deploy-verified BridgeSender.py:
- ``import genlayer as gl`` + ``from genlayer.types import *`` (no ``genlayer.py.*``
  submodule imports — they do not resolve on this runner).
- Encoder is built inline inside the method (the runner does not execute
  std-object construction at module scope).
- ``gl.contract.get_at`` replaces ``gl.get_contract_at``; cross-contract emit is
  ``.emit(on="finalized")``.
- Owner guards raise ``gl.vm.UserError(...)`` like every other contract on the
  branch; the EID is kept as a plain ``int`` to match BridgeSender's
  ``send_message(target_chain_id: int, ...)`` signature.
"""

import genlayer as gl
from genlayer.types import *  # Address (Encoder is gl.evm.MethodEncoder)


class StringSender(gl.contract.Contract):
    bridge_sender: Address
    target_chain_eid: int
    target_contract: str
    sent_strings: gl.storage.DynArray[str]
    owner: Address

    def __init__(self, bridge_sender: str, target_chain_eid: int, target_contract: str):
        self.bridge_sender = Address(bridge_sender)
        self.target_chain_eid = target_chain_eid
        self.target_contract = target_contract
        self.owner = gl.message.sender_address

    @gl.public.write
    def set_bridge_sender(self, bridge_sender: str):
        if gl.message.sender_address != self.owner:
            raise gl.vm.UserError("Only owner")
        self.bridge_sender = Address(bridge_sender)

    @gl.public.write
    def set_target(self, target_chain_eid: int, target_contract: str):
        if gl.message.sender_address != self.owner:
            raise gl.vm.UserError("Only owner")
        self.target_chain_eid = target_chain_eid
        self.target_contract = target_contract

    @gl.public.write
    def send_string(self, message: str):
        """Send a string to target EVM chain via bridge."""
        encoder = gl.evm.MethodEncoder("", (str,), bool)
        message_bytes = encoder.encode_call((message,))[4:]  # Remove method selector

        bridge_contract = gl.contract.get_at(self.bridge_sender)
        bridge_contract.emit(on="finalized").send_message(
            self.target_chain_eid, self.target_contract, message_bytes
        )
        self.sent_strings.append(message)

    @gl.public.view
    def get_sent_strings(self) -> list[str]:
        return list(self.sent_strings)

    @gl.public.view
    def get_sent_count(self) -> int:
        return len(self.sent_strings)

    @gl.public.view
    def get_config(self) -> dict:
        return {
            "bridge_sender": str(self.bridge_sender),
            "target_chain_eid": self.target_chain_eid,
            "target_contract": self.target_contract,
            "owner": str(self.owner),
        }
