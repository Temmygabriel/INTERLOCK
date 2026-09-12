# v0.3.0
# { "Depends": "py-genlayer:5jycge4q8k23462jtb0b9fyey1s9qz928sz2nbrd9mg4sxqg2qng" }

#
# ============================================================================
# interlock.py — Interlock, the AUTONOMOUS CIRCUIT BREAKER (the "guard").
#
# ROLE   This is the breaker itself. A protocol deploys one Interlock pointed at
#        the contract it wants protected, then grants it the pause role. It never
#        holds or moves funds: the ONLY outward action its rulebook can take is
#        `apply_pause` on its one target — and only after GenLayer's validator
#        consensus independently confirms an exploit in the reported audit entry.
#        Its constitution (target, governance, min_bond, rules) is frozen at
#        deploy time; no setter for it exists anywhere in this file.
#
# PARTNER  Protects ONE DemoVault (demo_vault.py). The two are deployed as a
#          pair and armed via vault.set_guardian(interlock). Multiple on-chain
#          instances (the deploy-card pair + the exploit-lab pair) are just
#          these same two files deployed again — see ./README.md.
# ============================================================================

import genlayer as gl
from genlayer.types import *

import json

ERROR_EXPECTED = "[EXPECTED]"
ERROR_LLM = "[LLM_ERROR]"

VERDICT_CONFIRMED = "EXPLOIT_CONFIRMED"
VERDICT_CLEAR = "NOT_CONFIRMED"

# Allowed effect surface of the guard. An "exploit confirmed" verdict maps to
# exactly one outward vault action (apply_pause) or nothing (already paused).
# A false report maps to nothing at all. There is no branch that moves funds to a
# third party, withdraws from the vault, calls resume, or touches the constitution.
ALLOWED_EFFECTS = ("apply_pause", "noop_already_paused", "noop_false_report")

# The ONLY way this contract can pay a plain wallet. A
# `gl.contract.get_at(eoa).emit_transfer(...)` compiles to an IC->IC PostMessage,
# and an externally-owned account has no contract deployed at it to receive one:
# the child transfer errors, the wallet is never credited, and the parent tx
# still reports success. Routing the identical transfer through an external EVM
# contract-interface stub compiles to an EthSend, which credits a chain-layer EOA
# normally. External messages execute only on finality, so the reentrancy safety
# of the old `on="finalized"` form is preserved. Construct the stub at CALL time
# — the v0.3.0 runner does not execute std-object construction at module scope.
@gl.evm.contract_interface
class _EoaPay:
    class View:
        pass

    class Write:
        pass


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


class Interlock(gl.contract.Contract):
    """Interlock — an autonomous circuit breaker for a DeFi protocol.

    One job, stated as a rule that cannot be bent by the contract's own logic:

        A DeFi protocol (``target_vault``) is protected by a *guardian* that only
        Interlock may exercise. When anyone posts a bonded report naming one
        operation in the vault's immutable audit log, GenLayer consensus —
        not this contract, not the reporter — decides whether that verified
        operation is an exploit. Only if consensus independently confirms the
        exploit does Interlock pause the vault. Every other outcome does nothing.

    The constitution (target, governance authority, minimum bond, doctrine) is
    written once in the constructor and has no setter anywhere in this file. The
    guard is deterministic after consensus: it maps the two possible verdicts onto
    a hard-coded effect set, and no effect can move a token out of the vault or
    out of this contract to a third party. ``resume`` is not reachable from here —
    it exists only on the vault and only for its human owner.
    """

    # --- FROZEN constitution (written once in __init__, no setter exists) ---
    target_vault: Address     # the protected protocol (a DemoVault)
    governance: Address       # human authority over the target (informational)
    min_bond: u256            # minimum bond required to file a report
    constitution: str         # JSON manifest of the immutable rulebook
    deployed_at: str          # ISO datetime of deployment (chain time anchor)

    # --- working state (never affects the rulebook, only history) ---
    tripped: bool             # has the breaker ever fired
    last_trip_at: str
    last_check_time: str
    report_seq: u256
    reports: gl.storage.DynArray[str]   # one JSON record per filed report
    incidents: gl.storage.DynArray[str]  # actionable events only: TRIPPED / FALSE_REPORT_REJECTED
    refundable: gl.storage.TreeMap[str, u256]  # honest reporter address -> bond owed back
    rejections: gl.storage.TreeMap[str, str]   # reporter key -> why a report was rejected+refunded

    def __init__(self, target_vault: Address, governance: Address, min_bond: u256):
        if min_bond <= 0:
            raise gl.vm.UserError(ERROR_EXPECTED + " min_bond must be positive")

        self.target_vault = target_vault
        self.governance = governance
        self.min_bond = min_bond
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
            "bond": "genuine report -> bond returned to the reporter's wallet "
                    "(external EthSend rail, not an IC->IC postmessage); false "
                    "report -> bond forfeited (locked, no withdrawal path exists); "
                    "a caller-fixable rejection (bond below minimum, op_index out "
                    "of range) is refunded in the same transaction, never retained",
            "effect_set": list(ALLOWED_EFFECTS),
            "unpause": "impossible from this contract; exists only on the target, "
                       "owner-only, by human governance",
        }
        self.constitution = json.dumps(manifest, sort_keys=True)

        self.tripped = False
        self.last_trip_at = ""
        self.last_check_time = self.deployed_at
        self.report_seq = u256(0)
        # DynArray / TreeMap storage starts empty; nothing further to initialize.

    # ------------------------------------------------------------------ utils

    def _now(self) -> str:
        # Chain-time anchor from the message context (available on every call,
        # including deploy). gl.vm.get_timestamp() is NOT reliable on this RC.
        return str(gl.message.raw["datetime"])

    def _is_vault_paused(self) -> bool:
        vault = gl.contract.get_at(self.target_vault)
        return bool(vault.view().params()["paused"])

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

    # ------------------------------------------------------ payable rejection

    def _reject_payable(self, reason: str, reporter_key: str, op_index: int) -> dict:
        """Refuse a payable report WITHOUT reverting, so the bond goes home.

        A revert on a payable call does not refund: the contract simply retains
        the attached value with no ledger entry. So every caller-fixable
        rejection accepts the call, pays the bond straight back to the
        reporter's wallet over the external EthSend rail, records why, and
        returns normally. The contract's balance is unchanged by the round trip.

        Deliberately does NO other work: no evidence read, no consensus, and no
        cross-contract call. Anything that could itself fail here would revert
        the transaction and re-trap the bond, which is the exact defect this
        path exists to avoid.
        """
        paid = int(gl.message.value)
        if paid > 0:
            _EoaPay(gl.message.sender_address).emit_transfer(value=u256(paid))
        note = (
            reason
            + " — rejected and refunded "
            + str(paid)
            + " atto in this transaction; the contract retained nothing"
        )
        self.rejections[reporter_key] = note
        self.last_check_time = self._now()
        return {
            "report_id": 0,
            "op_index": op_index,
            "verdict": "",
            "status": "REJECTED_REFUNDED",
            "bond": paid,
            "effect": "noop_rejected_refunded",
            "tripped": self.tripped,
            "rejection": note,
        }

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
            "tripped": self.tripped,
            "last_trip_at": self.last_trip_at,
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

    @gl.public.view
    def get_rejection(self, reporter: str) -> str:
        """Why the last report from ``reporter`` was refused, or "" if none was.

        A rejected payable call SUCCEEDS (see ``_reject_payable``), so there is no
        revert string to read — the reason is stored on-chain and read back here.
        """
        return self.rejections.get(_canon_str(reporter), "")

    # ---------------------------------------------------------- the report path

    @gl.public.write.payable
    def report_exploit(self, op_index: u256) -> dict:
        """Bonded report of a suspected exploit at a pinned audit-log index.

        Evidence is *never* taken from the reporter — only an integer index into the
        target's immutable audit log. Consensus (not this contract, not the reporter)
        classifies the pinned operation. The guard then applies the deterministic
        effect for the consensus verdict.
        """
        reporter = gl.message.sender_address
        reporter_key = _canon_addr(reporter)
        bond = int(gl.message.value)
        idx = int(op_index)

        # Caller-fixable rejections must NOT revert: a revert on a payable call
        # retains the attached value in the contract with no ledger entry. Refund
        # in the same transaction instead and return normally (see _reject_payable).
        if bond < int(self.min_bond):
            return self._reject_payable(
                ERROR_EXPECTED + " bond below minimum — send at least min_bond with the report",
                reporter_key,
                idx,
            )

        audit_len = self._audit_len()
        if idx < 0 or idx >= audit_len:
            return self._reject_payable(
                ERROR_EXPECTED + " op_index out of range (audit length " + str(audit_len) + ")",
                reporter_key,
                idx,
            )

        # ---- 1. PINNED READ ------------------------------------------------
        # Evidence is the target's committed on-chain audit entry at the pinned
        # index. This read is DETERMINISTIC: it is shared, finalized storage that
        # every validator replays identically, so the evidence string is inherently
        # consensus-pinned — which is also why inter-contract calls are legal here
        # (they are forbidden only inside non-deterministic blocks). Only structured,
        # on-chain, already-committed data is ever shown to the model — never
        # reporter text. (Had the evidence lived off-chain — e.g. a tx body fetched
        # from an RPC — this read would instead be wrapped in
        # gl.eq_principle.strict_eq so validators agreed on the exact bytes.)
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

        # A judgment failure that surfaces as a catchable UserError is still a
        # caller-visible failure on a payable call — refund rather than retain.
        # (A VM-level consensus abort — Disagree — cannot be caught here; the
        # fully-safe form is the two-phase split, see PROGRESS-v3.md Phase 17.)
        try:
            raw_result = gl.vm.run_nondet(classify, validate)
        except gl.vm.UserError as e:
            return self._reject_payable(
                ERROR_LLM + " judgment could not be completed: " + _err_message(e),
                reporter_key,
                idx,
            )
        # run_nondet returns the leader's verdict directly (or wraps it in a
        # Result). Unwrap defensively, then proceed only on a real verdict dict.
        if isinstance(raw_result, gl.vm.Return):
            raw_result = raw_result.calldata
        result = raw_result
        # If validators ever disagree the VM is terminated (Disagree), so no code
        # after this point runs on a non-verdict — the guard fails shut by
        # construction and no bond is ever escrowed on an unverified outcome.
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
        # that reaches the vault or the escrow.
        if verdict == VERDICT_CONFIRMED:
            fired = False
            if not self._is_vault_paused():
                gl.contract.get_at(self.target_vault).emit(on="finalized").apply_pause()
                fired = True
            effect = "apply_pause" if fired else "noop_already_paused"
            self.tripped = True
            self.last_trip_at = now
            self.refundable[reporter_key] = u256(bond)  # honest reporter gets bond back
            self.incidents.append(
                json.dumps(
                    {
                        "kind": "TRIPPED",
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
            "paused": self._is_vault_paused(),
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
        # External EthSend rail: a plain wallet has no contract to receive an
        # IC->IC transfer, so `gl.contract.get_at(eoa).emit_transfer(...)` would
        # finalize with the child in error and credit nobody. The stub compiles
        # to an EthSend, which credits an EOA normally, and runs only on finality.
        _EoaPay(sender).emit_transfer(value=u256(due))


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
