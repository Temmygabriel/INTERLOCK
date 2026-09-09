# v0.3.0
# { "Depends": "py-genlayer:5jycge4q8k23462jtb0b9fyey1s9qz928sz2nbrd9mg4sxqg2qng" }

# ============================================================================
# interlock_v3.py — Interlock v3, the CROSS-CHAIN CIRCUIT BREAKER (the "guard").
#
# ROLE   Same judgment/guard pattern as interlock.py (the same-chain breaker):
#        a permissionless bonded report names one operation in the target vault's
#        immutable audit log; GenLayer validator consensus — not this contract,
#        not the reporter — independently classifies the pinned operation. On a
#        CONFIRMED exploit, the final action is NOT a same-chain `apply_pause`
#        but a narrowly-typed `TRIP` message sent through the Foundation's
#        BridgeSender to a vault that lives on Base Sepolia (BaseDemoVault).
#        It never holds or moves funds; the ONLY outward action its rulebook can
#        take is `BridgeSender.send_message` carrying the exact string "TRIP" —
#        never a generic arbitrary-call payload.
#
#        Dialect: this copy is ported to the studio-dev v0.3.0 dialect (chain
#        61997) alongside main's interlock.py. Storage/API follow the ported
#        same-chain breaker exactly; the confirmed-effect branch emits the TRIP
#        bridge message via gl.contract.get_at(...).emit(on="finalized").
#
# PARTNER  Judges the audit log of ONE GenLayer DemoVault (demo_vault.py) and
#          trips ONE EVM twin (v3-crosschain/base/BaseDemoVault.sol).
#
# TRUST MODEL (must be disclosed, not glossed over): the destination chain
#          trusts the relay to faithfully deliver a message that really came from
#          confirmed GenLayer consensus. There is NO independent finality proof
#          binding an outbound message to GenLayer consensus today — this is
#          trusted-relay, NOT consensus-authenticated. Same-chain Interlock never
#          has this problem. If the relay is not running, a real GenLayer-side
#          trip never reaches Base Sepolia.
# ============================================================================

import genlayer as gl
from genlayer.types import *

import json

ERROR_EXPECTED = "[EXPECTED]"
ERROR_LLM = "[LLM_ERROR]"

VERDICT_CONFIRMED = "EXPLOIT_CONFIRMED"
VERDICT_CLEAR = "NOT_CONFIRMED"

# The TRIP message tag. BaseDemoVault.processBridgeMessage accepts ONLY this
# exact string and rejects anything else (see BaseDemoVault.sol).
TRIP_TAG = "TRIP"

# The narrowly-typed TRIP payload is `(str,)` calldata carrying the exact string
# "TRIP", method selector stripped ([4:]). NOTE on the v0.3.0 dialect: the runner
# does NOT execute std-object construction at module scope (a module-scope
# gl.evm.MethodEncoder makes the deploy finish FINISHED_WITH_ERROR), so the
# encoder is built inline at report time and validated once in __init__ so a bad
# encoder / gl.evm path still fails the DEPLOY loudly.

# Allowed effect surface of the guard. A confirmed exploit maps to exactly one
# outward action (send the TRIP bridge message) or nothing (already sent).
# A false report maps to nothing at all. There is no branch that moves funds,
# pauses the same-chain vault, or touches the constitution.
ALLOWED_EFFECTS = ("send_trip", "noop_already_tripped", "noop_false_report")


def _err_message(x) -> str:
    """Extract a comparable message from a UserError result or exception.

    v0.6 UserError carries an arbitrary calldata-encodable payload accessed via
    `.data` (the old `.message` no longer exists). The payload is either the
    message string itself or a dict carrying a "message" key.
    """
    data = getattr(x, "data", None)
    if data is None:
        data = getattr(x, "message", None)
    if data is None:
        return str(x)
    if isinstance(data, dict):
        return str(data.get("message", ""))
    return str(data)


class InterlockV3(gl.contract.Contract):
    """Interlock v3 — a cross-chain circuit breaker for a DeFi protocol.

    One job, stated as a rule that cannot be bent by the contract's own logic:

        A DeFi protocol (``target_vault``) on GenLayer is judged by consensus.
        When anyone posts a bonded report naming one operation in the vault's
        immutable audit log, GenLayer consensus — not this contract, not the
        reporter — decides whether that verified operation is an exploit. Only
        if consensus independently confirms the exploit does Interlock v3 emit a
        narrowly-typed ``TRIP`` bridge message toward a vault on an EVM chain.
        Every other outcome does nothing.

    The constitution (target, bridge sender, destination chain/contract,
    governance authority, minimum bond, doctrine) is written once in the
    constructor and has no setter anywhere in this file. The guard is
    deterministic after consensus: it maps the two possible verdicts onto a
    hard-coded effect set, and no effect can move a token out of the vault or
    out of this contract to a third party. ``resume`` is not reachable from
    here — it exists only on BaseDemoVault and only for its human owner.

    Honesty: BaseDemoVault is a toy, not Aave, and protects no real funds.
    The destination chain trusts the relay (trusted-relay, not
    consensus-verified); there is no independent finality proof yet.
    """

    # --- FROZEN constitution (written once in __init__, no setter exists) ---
    target_vault: Address     # the protected protocol on GenLayer (a DemoVault)
    governance: Address       # human authority over the target (informational)
    min_bond: u256            # minimum bond required to file a report
    bridge_sender: Address    # GenLayer BridgeSender.py (the GL->EVM outbox)
    target_chain_eid: u256    # LayerZero endpoint id of the destination chain
    target_contract: str      # BaseDemoVault address on the destination chain
    constitution: str         # JSON manifest of the immutable rulebook
    deployed_at: str          # ISO datetime of deployment (chain time anchor)

    # --- working state (never affects the rulebook, only history) ---
    tripped: bool             # has the breaker ever emitted a TRIP
    last_trip_at: str
    last_trip_hash: str       # BridgeSender message hash of the last TRIP
    last_check_time: str
    report_seq: u256
    reports: gl.storage.DynArray[str]   # one JSON record per filed report
    incidents: gl.storage.DynArray[str]  # actionable events only: TRIP_SENT / FALSE_REPORT_REJECTED
    refundable: gl.storage.TreeMap[str, u256]  # honest reporter address -> bond owed back

    def __init__(
        self,
        target_vault: Address,
        governance: Address,
        min_bond: u256,
        bridge_sender: Address,
        target_chain_eid: int,
        target_contract: str,
    ):
        if min_bond <= 0:
            raise gl.vm.UserError(ERROR_EXPECTED + " min_bond must be positive")

        self.target_vault = target_vault
        self.governance = governance
        self.min_bond = min_bond
        self.bridge_sender = bridge_sender
        self.target_chain_eid = u256(target_chain_eid)
        self.target_contract = target_contract
        self.deployed_at = self._now()

        manifest = {
            "schema": 1,
            "doctrine": (
                "An operation on the target's audit log is an EXPLOIT if and only "
                "if it leaves lenders unable to be made whole: outstanding debt "
                "exceeds available collateral (coverage below 100%), or it removes "
                "collateral without discharging debt such that coverage drops below "
                "100%. Healthy operations keep coverage >= 100%."
            ),
            "evidence_source": "on-chain audit log of the target vault (immutable, "
                               "index-pinned, replayed from genesis)",
            "pinning": "deterministic cross-contract read of committed on-chain "
                       "state — replayed identically by every validator, so the "
                       "pinned evidence is inherently consensus-identical",
            "judgment": "independent validator re-classification over the pinned "
                        "entry; only the closed enum verdict is compared",
            "bond": "genuine report -> bond returned to reporter; false report -> "
                    "bond forfeited (locked, no withdrawal path exists)",
            "effect_set": list(ALLOWED_EFFECTS),
            "final_action": (
                "on confirmed exploit, emit BridgeSender.send_message("
                + str(self.target_chain_eid)
                + ", "
                + self.target_contract
                + ", abi-encoded '" + TRIP_TAG + "') — a narrowly-typed TRIP "
                "message, NEVER a generic arbitrary-call payload"
            ),
            "trust_model": (
                "trusted-relay, not consensus-authenticated: the destination "
                "chain trusts the off-chain relay to deliver a message that "
                "really came from confirmed GenLayer consensus. No independent "
                "finality proof exists yet. Same-chain Interlock does not have "
                "this trust boundary."
            ),
            "unpause": "impossible from this contract; exists only on "
                       "BaseDemoVault, owner-only, by human governance",
        }
        self.constitution = json.dumps(manifest, sort_keys=True)

        self.tripped = False
        self.last_trip_at = ""
        self.last_trip_hash = ""
        self.last_check_time = self.deployed_at
        self.report_seq = u256(0)
        # DynArray / TreeMap storage starts empty; nothing further to initialize.

        # FAIL-FAST at deploy: exercise the exact TRIP ABI-encode the confirmed
        # branch uses (gl.evm.MethodEncoder over the (str,) TRIP payload), so a
        # dialect/API drift fails the deploy loudly rather than surfacing only on
        # the first real confirmed report. Module scope cannot hold std objects on
        # the v0.3.0 runner, so this is validated here and built inline at report.
        _boot_enc = gl.evm.MethodEncoder("", (str,), bool)
        _ = _boot_enc.encode_call((TRIP_TAG,))

    # ------------------------------------------------------------------ utils

    def _now(self) -> str:
        # Chain-time anchor from the message context (available on every call,
        # including deploy). gl.vm.get_timestamp() is NOT reliable on this RC.
        return str(gl.message.raw["datetime"])

    def _audit_len(self) -> int:
        vault = gl.contract.get_at(self.target_vault)
        return int(vault.view().audit_len())

    def _evidence_prompt(self, evidence_json: str) -> str:
        manifest = json.loads(self.constitution)
        return (
            "You are the independent judge inside an autonomous safety interlock "
            "for a lending protocol.\n"
            "You are shown ONE operation from the protocol's immutable on-chain "
            "audit log. Every number in it is cryptographically pinned and verified "
            "on-chain; do not second-guess them.\n\n"
            "DOCTRINE (the only law):\n"
            + manifest["doctrine"]
            + "\n\n"
            "PINNED OPERATION:\n"
            + evidence_json
            + "\n\n"
            "Classify the operation under the doctrine. Respond ONLY as JSON with "
            'exactly two fields: "verdict" (one of "'
            + VERDICT_CONFIRMED
            + '" or "'
            + VERDICT_CLEAR
            + '") and "reason" (one short sentence).'
        )

    # ------------------------------------------------------------ public views

    @gl.public.view
    def constitution_view(self) -> dict:
        return json.loads(self.constitution)

    @gl.public.view
    def status(self) -> dict:
        return {
            "target": str(self.target_vault),
            "governance": str(self.governance),
            "min_bond": int(self.min_bond),
            "bridge_sender": str(self.bridge_sender),
            "target_chain_eid": int(self.target_chain_eid),
            "target_contract": self.target_contract,
            "tripped": self.tripped,
            "last_trip_at": self.last_trip_at,
            "last_trip_hash": self.last_trip_hash,
            "last_check_time": self.last_check_time,
            "report_count": int(self.report_seq),
            "incident_count": len(self.incidents),
            "deployed_at": self.deployed_at,
        }

    @gl.public.view
    def incident_count(self) -> int:
        return len(self.incidents)

    @gl.public.view
    def get_incident(self, index: u256) -> dict:
        i = int(index)
        if i < 0 or i >= len(self.incidents):
            return {"found": False}
        return json.loads(self.incidents[i])

    @gl.public.view
    def report_count(self) -> int:
        return int(self.report_seq)

    @gl.public.view
    def get_report(self, index: u256) -> dict:
        i = int(index)
        if i < 0 or i >= len(self.reports):
            return {"found": False}
        return json.loads(self.reports[i])

    @gl.public.view
    def refundable_of(self, reporter: str) -> int:
        """Bond escrowed for an honest reporter, waiting to be withdrawn.

        Addresses are canonicalized (lowercased hex) so lookups from any client
        framing match the key written during the report.
        """
        return int(self.refundable.get(_canon_str(reporter), u256(0)))

    # ---------------------------------------------------------- the report path

    @gl.public.write.payable
    def report_exploit(self, op_index: u256) -> dict:
        """Bonded report of a suspected exploit at a pinned audit-log index.

        Evidence is *never* taken from the reporter — only an integer index into the
        target's immutable audit log. Consensus (not this contract, not the reporter)
        classifies the pinned operation. The guard then applies the deterministic
        effect for the consensus verdict: on a confirmed exploit it emits the
        narrowly-typed TRIP bridge message toward BaseDemoVault.
        """
        reporter = gl.message.sender_address
        reporter_key = _canon_addr(reporter)
        bond = int(gl.message.value)

        if bond < int(self.min_bond):
            raise gl.vm.UserError(
                ERROR_EXPECTED
                + " bond below minimum — send at least min_bond with the report"
            )

        idx = int(op_index)
        audit_len = self._audit_len()
        if idx < 0 or idx >= audit_len:
            raise gl.vm.UserError(
                ERROR_EXPECTED + " op_index out of range (audit length " + str(audit_len) + ")"
            )

        # ---- 1. PINNED READ ------------------------------------------------
        # Evidence is the target's committed on-chain audit entry at the pinned
        # index. This read is DETERMINISTIC: it is shared, finalized storage that
        # every validator replays identically, so the evidence string is inherently
        # consensus-pinned — which is also why inter-contract calls are legal here
        # (they are forbidden only inside non-deterministic blocks). Only structured,
        # on-chain, already-committed data is ever shown to the model — never
        # reporter text.
        vault = gl.contract.get_at(self.target_vault)
        entry = vault.view().get_audit_entry(u256(idx))
        entry["pinned"] = {
            "vault": str(self.target_vault),
            "op_index": idx,
            "source": "on-chain immutable audit log, replayed from genesis",
        }
        evidence_json = json.dumps(entry, sort_keys=True)
        judge_prompt = self._evidence_prompt(evidence_json)  # deterministic

        # ---- 2. JUDGMENT ---------------------------------------------------
        # Independent re-derivation: the validator does NOT format-check the leader's
        # answer. It re-runs the whole classification over the same pinned evidence
        # and only the closed-enum verdict is compared. Malformed output raises an
        # LLM error, which the validator turns into disagreement -> consensus retry,
        # never a one-sided verdict.
        def classify() -> dict:
            raw = gl.nondet.exec_prompt(judge_prompt, response_format="json")
            return _normalize_verdict(raw)

        def validate(leaders_res: gl.vm.Result) -> bool:
            if isinstance(leaders_res, gl.vm.Return):
                try:
                    own = classify()
                except gl.vm.UserError:
                    return False  # validator could not derive a verdict -> disagree
                return own["verdict"] == leaders_res.calldata["verdict"]
            # Leader did not return (errored / failed).
            leader_msg = _err_message(leaders_res)
            try:
                classify()  # rerun the same task independently
                return False  # leader failed, validator succeeded -> disagree
            except gl.vm.UserError as e:
                msg = _err_message(e)
                if msg.startswith(ERROR_EXPECTED) and msg == leader_msg:
                    return True  # identical deterministic business error
                return False  # LLM / unknown error -> disagree, force retry
            except Exception:
                return False

        raw_result = gl.vm.run_nondet(classify, validate)
        # run_nondet returns the leader's verdict directly (or wraps it in a
        # Result). Unwrap defensively, then proceed only on a real verdict dict.
        # If validators ever disagree the VM is terminated (Disagree), so no code
        # after this point runs on a non-verdict — the guard fails shut by
        # construction and no bond is ever escrowed on an unverified outcome.
        if isinstance(raw_result, gl.vm.Return):
            raw_result = raw_result.calldata
        result = raw_result
        verdict = result["verdict"]
        reason = str(result.get("reason", ""))[:200]

        now = self._now()
        self.last_check_time = now
        self.report_seq = self.report_seq + u256(1)
        report_id = int(self.report_seq)

        evidence = json.loads(evidence_json)
        coverage_after = int(evidence.get("coverage", -1))

        # ---- 3. DETERMINISTIC GUARD -----------------------------------------
        # Verdict -> effect is a total function over exactly two inputs. Nothing
        # outside this mapping can ever fire, because there is no other code path
        # that reaches the bridge sender or the escrow.
        trip_hash = ""
        if verdict == VERDICT_CONFIRMED:
            fired = False
            if not self.tripped:
                # Narrowly-typed TRIP payload: ABI-encode the exact string "TRIP"
                # (a `(str,)` ABI, method selector stripped). BaseDemoVault decodes
                # this and accepts ONLY the "TRIP" tag — this is never a generic
                # arbitrary-call payload that could invoke any function on the
                # destination. Mirrors the boilerplate's StringSender example.
                encoder = gl.evm.MethodEncoder("", (str,), bool)
                message_bytes = encoder.encode_call((TRIP_TAG,))[4:]  # Remove selector

                bridge = gl.contract.get_at(self.bridge_sender)
                bridge.emit(on="finalized").send_message(
                    self.target_chain_eid,
                    self.target_contract,
                    message_bytes,
                )
                # HONESTY: the `.emit()` cross-contract proxy does not surface the
                # child's return value (it returns None), so send_message's message
                # hash cannot be captured here. We record "" rather than fabricate
                # a hash. The authoritative hash is the key BridgeSender stored the
                # message under — read it from BridgeSender.get_message_hashes()
                # (exactly the view the off-chain relay polls).
                self.tripped = True
                fired = True
            effect = "send_trip" if fired else "noop_already_tripped"
            self.last_trip_at = now
            self.refundable[reporter_key] = u256(bond)  # honest reporter gets bond back
            self.incidents.append(
                json.dumps(
                    {
                        "kind": "TRIP_SENT" if fired else "ALREADY_TRIPPED",
                        "report": report_id,
                        "op_index": idx,
                        "coverage_after": coverage_after,
                        "effect": effect,
                        "trip_hash": trip_hash,
                        "reason": reason,
                        "time": now,
                    },
                    sort_keys=True,
                )
            )
            status = "CONFIRMED"
        elif verdict == VERDICT_CLEAR:
            # False report: no refundable entry is created, so the bond is forfeited.
            # No code path in this contract can ever return a forfeited bond.
            effect = "noop_false_report"
            self.incidents.append(
                json.dumps(
                    {
                        "kind": "FALSE_REPORT_REJECTED",
                        "report": report_id,
                        "op_index": idx,
                        "coverage_after": coverage_after,
                        "effect": effect,
                        "reason": reason,
                        "time": now,
                    },
                    sort_keys=True,
                )
            )
            status = "REJECTED"
        else:
            # Unreachable (normalize returns only the two enum values or raises),
            # but a guard must fail shut: if a verdict is ever unrecognized, do not
            # act and do not escrow the bond.
            raise gl.vm.UserError(ERROR_EXPECTED + " unrecognized verdict — no action taken")

        self.reports.append(
            json.dumps(
                {
                    "id": report_id,
                    "reporter": reporter_key,
                    "op_index": idx,
                    "bond": bond,
                    "verdict": verdict,
                    "status": status,
                    "effect": effect,
                    "time": now,
                },
                sort_keys=True,
            )
        )

        return {
            "report_id": report_id,
            "op_index": idx,
            "verdict": verdict,
            "status": status,
            "bond": bond,
            "effect": effect,
            "trip_hash": trip_hash,
            "tripped": self.tripped,
        }

    # ------------------------------------------------------------ bond escrow

    @gl.public.write
    def withdraw_bond(self) -> None:
        """An honest reporter reclaims their exact bond. No other movement exists."""
        sender = gl.message.sender_address
        key = _canon_addr(sender)
        due = self.refundable.get(key, u256(0))
        if due <= 0:
            raise gl.vm.UserError(ERROR_EXPECTED + " nothing to withdraw")
        self.refundable[key] = u256(0)
        gl.contract.get_at(sender).emit_transfer(due, on="finalized")


def _canon_addr(addr) -> str:
    """Canonical map key for an on-chain address: lowercase 0x-hex."""
    return str(addr).lower()


def _canon_str(s: str) -> str:
    """Canonical map key from an external address string (any framing/case)."""
    return s.strip().lower()


def _normalize_verdict(raw) -> dict:
    """Coerce an LLM response onto the closed enum, or raise an LLM error.

    Accepts exact tokens plus a short, conservative alias table. Anything else is a
    formatting failure -> ERROR_LLM, which validators treat as disagreement.
    """
    if not isinstance(raw, dict):
        raise gl.vm.UserError(ERROR_LLM + " model returned non-dict: " + str(type(raw)))

    raw_v = raw.get("verdict")
    if raw_v is None:
        for alt in ("classification", "result", "outcome", "decision", "label"):
            if alt in raw:
                raw_v = raw[alt]
                break
    if raw_v is None:
        raise gl.vm.UserError(
            ERROR_LLM + " missing verdict field; keys=" + str(sorted(raw.keys()))
        )

    s = str(raw_v).strip().lower().replace("_", " ").replace("-", " ")
    if s in (
        "exploit confirmed",
        "confirmed",
        "exploit",
        "true",
        "yes",
        "exploited",
        "undercollateralized",
        "insolvent",
    ):
        return {"verdict": VERDICT_CONFIRMED, "reason": str(raw.get("reason", ""))}
    if s in (
        "not confirmed",
        "clear",
        "benign",
        "normal",
        "false",
        "no",
        "safe",
        "healthy",
    ):
        return {"verdict": VERDICT_CLEAR, "reason": str(raw.get("reason", ""))}
    raise gl.vm.UserError(ERROR_LLM + " unrecognized verdict value: " + s)
