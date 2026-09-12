# Intelligent Contracts — Interlock

This folder holds the **GenLayer intelligent contracts** behind Interlock. There are
**exactly two programs** here:

| File | Contract | Who it is |
|------|----------|-----------|
| `interlock.py` | `Interlock` | **the breaker / the guard** — the autonomous circuit breaker |
| `demo_vault.py` | `DemoVault` | **the victim** — the toy lending protocol it protects |

Both are pinned to a specific GenLayer runner (`py-genlayer:1jb45…`, first line of
each file) as GenLayer networks require.

---

## Why two contracts — the whole scenario

Interlock is **not one monolithic contract**. It is a *pair*:

- **`DemoVault`** is a small, deliberately-flawed lending pool. Its owner holds
  governance; its **guardian** slot is the one thing that can pause it
  (`apply_pause`).
- **`Interlock`** is deployed *next to* a vault and granted the guardian role. From
  then on, the vault's own operations are the evidence: every action appends an
  immutable **audit entry**, and anyone can ask consensus whether a particular entry
  was an exploit.

```
   a vault (DemoVault)                     an Interlock guard
   ─────────────────────                   ─────────────────────
   owner/governance  ── resume             target_vault  (frozen)
   guardian (the breaker) ── apply_pause   governance    (frozen)
   audit log (immutable entries)  ◄──────── reads a pinned entry
        ▲                                        │
        └──────── everyone calls report_exploit(i)┘
                       (a report is judged by GenLayer validator consensus)
```

A **running installation is one pair** (one vault + one Interlock pointing at it).
Because the same two files can be deployed any number of times, studionet currently
holds **two live pairs** — which is why it can look like "many contracts". They are
the same code, deployed twice for two different jobs:

1. **Deploy-card pair** — the permanent, healthy showcase (the "protect your
   protocol" story). Vault runs at 142% coverage and is never exploited.
   - interlock `0x2fB65F934618a17320c288d684aaB97dC00Ac300`
   - vault `0xCCB1fa65e9A85023324ccaA7aa44959b5BA448a7`

2. **Exploit-lab pair** — a disposable instance the demo is *allowed to break*.
   A real borrow pushes it under 100% coverage, a real report is judged by real
   validator consensus, and you watch the breaker **trip and pause it**. One-shot:
   a trip pauses the vault permanently, so a fresh lab pair is redeployed before
   each demo (see `tests/integration/test_lab_deploy.py`).
   - interlock `0x970a345e99800D5eb9b49E3599396a0faC633FdC`
   - vault `0x429Ada2BC4a6E240418ECE8b883CE7060C0ff15A`

(A planned third program — a tiny **adapter** — will let Interlock guard
*differently-shaped* contracts by normalizing their pause method to one guardian
slot. It is not built yet; it will live here when it is.)

---

## `interlock.py` — the breaker (read this one first)

- **Frozen constitution.** `__init__` locks in `target_vault`, `governance`,
  `min_bond`, the constitution document, and `deployed_at`. **There is no setter
  anywhere in the file** — the guard cannot be retargeted, re-owned, or rewritten
  after deployment.
- **`report_exploit(op_index)`** (`@write.payable`): anyone may report. Evidence is
  never typed in — the reporter supplies **only an integer index** into the vault's
  audit log. The bond is `msg.value`.
- **The judgment is consensus.** The contract reads the vault's audit entry at the
  pinned index (a deterministic on-chain read every validator replays identically),
  classifies it, and runs `run_nondet_unsafe` where each validator **re-derives the
  verdict itself** and they compare only a closed enum:
  `EXPLOIT_CONFIRMED` / `NOT_CONFIRMED`. A report trips **only** when validators
  independently agree it is an exploit.
- **The effect surface is hardcoded** (`ALLOWED_EFFECTS`):
  `apply_pause`, `noop_already_paused`, `noop_false_report`. A confirmed exploit
  maps to exactly one outward action — `apply_pause` on the vault. There is **no
  branch that moves funds, withdraws, resumes, or touches the constitution.**
- **Bonds.** A true report is escrowed and refundable (`withdraw_bond`); a false
  report is forfeited — there is no path to reclaim a forfeited bond.
- **Views:** `status`, `constitution_view`, `incidents`, `reports`, `refundable_of`.

> *Why this satisfies the pitch "structurally incapable of ever moving a token":*
> the guard holds no funds, its only vault call is the pause, its target is frozen,
> and no setter exists. The claim is checkable by reading `ALLOWED_EFFECTS` and
> grepping for setters — there are none.

---

## `demo_vault.py` — the target it protects

- **Owner/governance** may `resume` the vault and (only while live) set the
  guardian. **Guardian** (an Interlock) may `apply_pause`. A paused vault cannot be
  re-wired and rejects new borrows.
- Every operation — deposit, borrow, withdraw, guardian change, pause, resume —
  appends **one immutable audit entry** to `audit`. That log is what Interlock
  reads and what consensus judges.
- **The deliberate exploit:** `borrow` has **no health / maximum check**, so any
  caller can drain the pool's buffer and push coverage under 100% — exactly the
  risky entry the demo reports and trips on.
- Views: `params`, `coverage`, `audit_len`, `get_audit_entry`.

---

## Arming a pair (the one integration step)

Deploy both, then the vault **owner** calls once:

```
set_guardian(<interlock_address>)     # owner-only, only while vault is live,
                                      # recorded on the audit log
```

That single call is what makes the breaker live. It is also the *only* role the
vault grants — pause. Governance keeps everything else, including `resume`.

---

## Deploy / lint / test

```bash
# runner-pinned header check is part of lint; NEVER deploy an unpinned file
genvm-lint lint intelligent-contracts/interlock.py
genvm-lint lint intelligent-contracts/demo_vault.py

# deterministic tests (no network, fast)
python -m pytest tests/direct -q

# live tests against real studionet validator consensus (~minutes)
python -m pytest tests/integration/test_interlock_flow.py -v -s
python -m pytest tests/integration/test_deploy_card.py -v -s    # the permanent pair
python -m pytest tests/integration/test_lab_deploy.py -v -s     # a fresh exploit-lab pair
```

> **Why the refund asserts where it does:** the payout is an **EthSend** over the
> `_EoaPay` stub, and an EthSend to a plain wallet creates no intelligent-contract
> child transaction — there is no contract at the far end to run. So the tests
> verify the parent's escrow-clearing state and the emitted message, not a child
> receipt. Do **not** "fix" this by going back to
> `gl.contract.get_at(eoa).emit_transfer(...)`: that compiles to an IC→IC
> postmessage, which an externally-owned account cannot receive, so the child
> transaction errors, the wallet is never credited, and **the parent still reports
> success**. That failure is not a studionet quirk — it is what an EOA payee does
> on every GenLayer network. The rail and its live verification are described in
> `genlayer-known-money-rails-issues.md` and
> `v3-crosschain/genlayer/scripts/verify_eoa_refund.py`.

Full project narrative, live-address history, and the UI: see `PROGRESS.md` at the
repo root.
