# Interlock v3 — Cross-Chain Extension Plan (Base Sepolia)

**Read this before touching anything.** This document adds a new capability
alongside the existing project. It does not replace, modify, or risk the current
submission-ready state on `main`.

---

## 0. Non-negotiable: branch isolation

```
git checkout main
git pull
git checkout -b interlock-v3-crosschain
```

**Every single change described below happens on this branch, and only this
branch.** Rules, no exceptions:

1. **`main` is not touched.** Not `interlock.py`, not `demo_vault.py`, not
   `frontend/`, not `PROGRESS.md`'s existing entries. `main` stays exactly as it
   is right now — deploy-card pair live, page-claims audit done, 18 tests green,
   README as the only remaining task before submission.
2. **No merge back to `main` without explicit, separate approval.** v3 is an
   experiment layered on top of a working submission, not a replacement for it.
   If v3 doesn't finish cleanly, `main` must still be submittable exactly as it
   is today.
3. **New files only, in a new folder** — `v3-crosschain/` at repo root, plus a
   new `PROGRESS-v3.md` for this branch's own log. Do not edit the existing
   `PROGRESS.md` — append a single line there at most, noting the branch exists.
4. **If at any point finishing v3 would require changing anything on the proven
   path** (`interlock.py`, `demo_vault.py`, the live frontend), stop and flag it
   — that is a sign v3 should be a fully separate contract pair, not a
   modification of the existing ones. The plan below is written to avoid this
   entirely by keeping v3 as new, additional contracts.

---

## 1. Current state — what already works, stated plainly

- **Two GenLayer Intelligent Contracts**, proven with real consensus tests:
  `interlock.py` (the breaker) and `demo_vault.py` (the GenLayer-native victim).
  Pattern: permissionless bonded report → pinned on-chain read → independent
  validator re-derivation → deterministic guard → `apply_pause()` on the target,
  nothing else possible.
- **Two live pairs on studionet**: the deploy-card pair (permanent, healthy,
  142%, the "protect your protocol" showcase) and the exploit-lab pair
  (disposable, redeployed before each demo, the one that actually trips).
- **Frontend**: fully built, blueprint design (v2), MetaMask closed to
  display-only by a deliberate, documented decision — do not reopen that
  decision as part of v3 work.
- **Known external blocker, check first:** as of the last update, studionet
  new-contract deploys were returning `execution_result: "ERROR"` (empty
  stdout/stderr, external to this repo). **Before starting any v3 work, redeploy
  a trivial hello-world contract to studionet and confirm deploys are healthy
  again.** If they're still broken, v3 cannot proceed — a v3 Interlock contract
  needs a fresh GenLayer-side deploy just as much as anything on `main` does.
- **Cross-chain research already exists** on a separate `research-crosschain`
  branch (docs-only, no code) — the verdict there: real via GenLayer's LayerZero
  V2 bridge, but not yet trust-minimized (no independent proof binding an
  outbound message to validator consensus finality on the destination chain —
  today's trust model is trusted-relay, not consensus-authenticated). **v3 must
  not contradict or soften this finding.** State it exactly this way in any v3
  README section.

---

## 2. What v3 actually adds

**One new capability: a real pause on a contract that lives on Base Sepolia, not
on GenLayer.** Same judgment pattern as the existing `interlock.py` — pinned
evidence, independent validator re-derivation, deterministic guard — but the
final action is a bridge message instead of a direct same-chain call.

### New contracts (all new files, nothing existing is touched)

| File | Location | Role |
|---|---|---|
| `v3-crosschain/genlayer/interlock_v3.py` | GenLayer | Same judgment/guard pattern as `interlock.py`, but on confirmed exploit it calls the bridge sender instead of a direct `apply_pause()` |
| `v3-crosschain/base/BaseDemoVault.sol` | Base Sepolia | A Solidity twin of `demo_vault.py` — same intentional flaw (unhealthy borrow with no check), same audit-log pattern, plus a `trip()` method only the bridge receiver may call |
| Foundation's `BridgeSender.py` / `BridgeForwarder.sol` / `BridgeReceiver.sol` | GenLayer / zkSync Era Sepolia / Base Sepolia | Reused as-is from `genlayer-foundation/genlayer-studio-bridge-boilerplate` — do not reimplement, import/deploy the real boilerplate |
| relay service | off-chain, `v3-crosschain/relay/` | The Node.js process from the same boilerplate — must run continuously during any live v3 demo |

### Honesty requirements for v3 specifically

- **`BaseDemoVault` is not real Aave.** State this exactly as plainly as
  `demo_vault.py`'s own docs do — a toy contract with a deliberate flaw, not a
  claim of protecting a real production protocol.
- **The trust boundary must be disclosed, not glossed over.** Say plainly: the
  destination chain currently trusts the relay to faithfully deliver a message
  that really came from confirmed GenLayer consensus — there is no independent
  finality proof yet. This is the single most important sentence in any v3
  README section.
- **The relay service is a real operational dependency.** If it is not running,
  a real GenLayer-side trip will never reach Base Sepolia. Document this
  clearly; do not let the demo imply a trip is instant or guaranteed without it.

---

## 3. Build phases (on the `interlock-v3-crosschain` branch only)

| Phase | Work | Done when |
|---|---|---|
| **0 — Prerequisite check** | Confirm studionet deploys are healthy again (deploy a throwaway hello-world contract). | A fresh contract deploys cleanly on studionet. |
| **1 — Boilerplate setup** | Clone/vendor the real Foundation bridge boilerplate into `v3-crosschain/`. Deploy `BridgeForwarder`/`BridgeReceiver` on zkSync Era Sepolia and Base Sepolia exactly per its own README — do not improvise the deployment steps. | The boilerplate's own example (`StringSender`/`StringReceiver`) works end to end, proving the bridge path itself before any Interlock-specific code touches it. |
| **2 — BaseDemoVault** | Write the Solidity twin, deploy to Base Sepolia. | A real borrow pushes it under-collateralized, exactly like `demo_vault.py`'s Python version, with an equivalent audit trail. |
| **3 — interlock_v3.py** | Copy the judgment/guard pattern from `interlock.py`. Replace the final `apply_pause()` call with a `BridgeSender.emit().send_message(...)` call carrying a narrowly-typed `TRIP` payload — never a generic arbitrary-call payload. | A confirmed exploit produces a real outbound bridge message, verified in the GenLayer-side outbox. |
| **4 — Relay + receiver wiring** | Run the relay service. Confirm a real `TRIP` message reaches Base Sepolia and calls `trip()` on `BaseDemoVault`. | An end-to-end real run: report on GenLayer → consensus confirms → relay delivers → `BaseDemoVault.paused` flips to true, observable on a Base Sepolia block explorer. |
| **5 — v3 demo page (separate, linked)** | A new, separate page (e.g. `v3-crosschain/frontend/`) — do not fold this into the existing `frontend/`. Link to it from the main site as "cross-chain extension (experimental)," clearly labeled as separate from the core submission. | A visitor can see the real Base Sepolia state change, with the trust-boundary disclosure visible on the same page. |
| **6 — Decision point** | Once phases 0-5 are proven (or once time runs out), decide with the user whether v3 is included in the submission at all, and how. | Explicit go/no-go conversation — not an assumption either way. |

---

## 4. What NOT to do

- Do not touch `interlock.py`, `demo_vault.py`, or anything in `frontend/`.
- Do not attempt to reopen the MetaMask decision as part of this work.
- Do not claim v3 protects real Aave, real Base mainnet funds, or anything
  beyond the toy `BaseDemoVault`.
- Do not describe the bridge as trustless or consensus-verified on the
  destination chain — the honest claim is trusted-relay, per the existing
  research.
- Do not merge to `main` without a separate, explicit conversation confirming
  the current submission-ready state on `main` is not put at risk.

---

## 5. If time or the studionet outage makes v3 impractical

That's a fine outcome, not a failure — say so plainly rather than forcing it.
`main` already has a complete, honest, tested submission. The fallback, already
decided and sitting in the current README plan, is one sourced sentence citing
the real bridge architecture as a natural extension — true, ambitious, and
costs nothing to include even if v3 never ships.
