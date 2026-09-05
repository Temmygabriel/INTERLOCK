# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }

from genlayer import *

import json

ERROR_EXPECTED = "[EXPECTED]"


class DemoVault(gl.Contract):
    """DemoVault: a toy lending pool that Interlock protects.

    It is intentionally small and legible. Every state-changing operation appends
    one immutable, pinned entry to ``audit`` (an on-chain audit trail). Interlock
    reads a single entry at a pinned index and asks GenLayer consensus whether that
    verified operation is an exploit.

    The one deliberate flaw: ``borrow`` has no health / maximum check, so any caller
    can borrow an amount that leaves the pool insolvent (coverage below 100%). That
    undercollateralized borrow is the "exploit incident" the demo trips on.

    Interlock is the ``guardian``: only it may call ``apply_pause``. Unpausing
    (``resume``) is reserved for the ``owner`` (a human governance address) and is
    never reachable from Interlock's own logic. The owner alone may *install* the
    breaker (``set_guardian``) while the vault is live — that is how the protocol
    grants its Interlock pause keys before go-live.
    """

    # --- configuration ---
    owner: Address       # human governance: may resume the vault, install guardian
    guardian: Address    # Interlock: may pause the vault (owner-installed)
    collateral: u256     # total supplied collateral (integer units)
    debt: u256           # total outstanding debt (integer units)

    # --- working state ---
    paused: bool
    seq: u256
    audit: DynArray[str]

    def __init__(self, owner: Address, guardian: Address):
        self.owner = owner
        self.guardian = guardian
        # Genesis state: 57 collateral against 40 debt => 142% coverage, healthy.
        self.collateral = u256(57)
        self.debt = u256(40)
        self.paused = False
        self.seq = u256(0)
        # audit starts empty; every operation appends one immutable entry

    # ------------------------------------------------------------------ utils

    def _now(self) -> str:
        return str(gl.message_raw["datetime"])

    def _coverage_pct(self) -> int:
        # Whole-percent coverage. If there is no debt the pool is fully safe -> 10000.
        if self.debt == 0:
            return 10000
        return int(self.collateral * u256(100) // self.debt)

    def _record(self, op: str, amount: int) -> None:
        entry = {
            "seq": int(self.seq) + 1,
            "op": op,
            "amount": amount,
            "collateral": int(self.collateral),
            "debt": int(self.debt),
            "coverage": self._coverage_pct(),
            "time": self._now(),
        }
        self.audit.append(json.dumps(entry))
        self.seq = self.seq + u256(1)

    def _require_live(self) -> None:
        if self.paused:
            raise gl.vm.UserError(
                message=ERROR_EXPECTED + " vault is paused (guardian tripped)"
            )

    # ------------------------------------------------------------ public views

    @gl.public.view
    def params(self) -> dict:
        return {
            "owner": str(self.owner),
            "guardian": str(self.guardian),
            "collateral": int(self.collateral),
            "debt": int(self.debt),
            "coverage": self._coverage_pct(),
            "paused": self.paused,
            "audit_len": int(self.seq),
        }

    @gl.public.view
    def coverage(self) -> int:
        return self._coverage_pct()

    @gl.public.view
    def audit_len(self) -> int:
        return int(self.seq)

    @gl.public.view
    def get_audit_entry(self, index: u256) -> dict:
        i = int(index)
        if i < 0 or i >= int(self.seq):
            return {"found": False, "index": i}
        return json.loads(self.audit[i])

    # ------------------------------------------------------------ public writes

    @gl.public.write
    def deposit(self, amount: u256) -> None:
        self._require_live()
        if amount <= 0:
            raise gl.vm.UserError(message=ERROR_EXPECTED + " amount must be positive")
        self.collateral = self.collateral + amount
        self._record("deposit", int(amount))

    @gl.public.write
    def borrow(self, amount: u256) -> None:
        self._require_live()
        if amount <= 0:
            raise gl.vm.UserError(message=ERROR_EXPECTED + " amount must be positive")
        # FLAW (intentional): no health / maximum check. A borrower may take out an
        # undercollateralized loan, leaving the pool insolvent. This is the incident
        # the demo reports to Interlock.
        self.debt = self.debt + amount
        self._record("borrow", int(amount))

    @gl.public.write
    def withdraw(self, amount: u256) -> None:
        self._require_live()
        if amount <= 0:
            raise gl.vm.UserError(message=ERROR_EXPECTED + " amount must be positive")
        if amount > self.collateral:
            raise gl.vm.UserError(message=ERROR_EXPECTED + " withdraw exceeds collateral")
        new_collateral = self.collateral - amount
        if self.debt > 0 and new_collateral * u256(100) < self.debt * u256(100):
            raise gl.vm.UserError(
                message=ERROR_EXPECTED + " withdraw would leave the vault undercollateralized"
            )
        self.collateral = new_collateral
        self._record("withdraw", int(amount))

    @gl.public.write
    def apply_pause(self) -> None:
        """The brake. Only the guardian (Interlock) may call this. Idempotent."""
        if gl.message.sender_address != self.guardian:
            raise gl.vm.UserError(message=ERROR_EXPECTED + " not guardian")
        if not self.paused:
            self.paused = True
            self._record("guardian_pause", 0)

    @gl.public.write
    def resume(self) -> None:
        """Human governance only. Interlock has no code path that calls this."""
        if gl.message.sender_address != self.owner:
            raise gl.vm.UserError(message=ERROR_EXPECTED + " not owner")
        if self.paused:
            self.paused = False
            self._record("governance_resume", 0)

    @gl.public.write
    def set_guardian(self, new_guardian: Address) -> None:
        """BOOTSTRAP: the protocol owner arms the breaker by installing it as the
        pause guardian — the one authority that may freeze this vault. This models
        how a real protocol grants its Interlock pause keys before go-live.

        It is the vault (the protected protocol) that mutates here, never the
        Interlock rulebook. Owner-only, and only while the vault is live: a paused
        vault cannot be re-wired, and the swap is itself recorded on the audit log
        Interlock later reads.
        """
        if gl.message.sender_address != self.owner:
            raise gl.vm.UserError(message=ERROR_EXPECTED + " not owner")
        if self.paused:
            raise gl.vm.UserError(
                message=ERROR_EXPECTED + " vault is paused — cannot change guardian"
            )
        self.guardian = new_guardian
        self._record("guardian_update", 0)
