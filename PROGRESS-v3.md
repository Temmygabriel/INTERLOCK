# PROGRESS-v3 — Cross-Chain Extension (Base Sepolia)

Branch: `interlock-v3-crosschain`
Spec: `interlock-v3-crosschain-plan.md`
Started: 2026-09-08

This is the v3 branch's own log. It lives ONLY on this branch and is separate
from the main `PROGRESS.md` (which tracks the submission-ready core on `main`).

---

## BLOCKER STATUS — read this first

**GenLayer studionet deploys are GATED.** As of 2026-09-08, studionet was
rejecting all new deploys with `invalid_contract absent_runner_comment`: the
previously-pinned runner hash was no longer recognized. The main session has
since confirmed the current accepted runner (v0.3.0):

```
# v0.3.0
# { "Depends": "py-genlayer:5jycge4q8k23462jtb0b9fyey1s9qz928sz2nbrd9mg4sxqg2qng" }
```

`interlock_v3.py` already carries this two-line header, but **no GenLayer deploy
has been attempted or verified this session.** Phase 0 (hello-world re-check)
and all Phase 3/4 GenLayer deploys remain GATED until a real studionet deploy
succeeds post-re-pin.

EVM (Base Sepolia / zkSync Era Sepolia) deploys need a funded testnet wallet +
Node toolchain; none were executed this session (see per-phase notes).

---

## Phase status

| # | Phase | Status | Notes |
|---|---|---|---|
| 0 | Prerequisite check (studionet deploy healthy) | **GATED** | Runner re-pin identified; no deploy attempted this session. |
| 1 | Boilerplate setup | **DONE (code)** | Vendored `genlayer-studio-bridge-boilerplate` into `v3-crosschain/boilerplate/`. EVM deploys + trust config are **DEFERRED** (need funded wallet) — exact commands in `v3-crosschain/DEPLOY-NOTES.md`. |
| 2 | BaseDemoVault | **DONE (code + test)** | `v3-crosschain/base/BaseDemoVault.sol` + Hardhat test. Deploy to Base Sepolia **DEFERRED** — exact command in `DEPLOY-NOTES.md`. |
| 3 | interlock_v3.py | **DONE (code)** | `v3-crosschain/genlayer/interlock_v3.py` mirrors the interlock.py judgment/guard pattern; emits a narrowly-typed `TRIP` message via `BridgeSender.emit().send_message(...)`. GenLayer deploy **GATED** on runner re-pin. |
| 4 | Relay + receiver wiring | **DEFERRED** | Requires phases 1–3 to be live. Commands in `DEPLOY-NOTES.md`. |
| 5 | v3 demo page | **DONE (scaffold)** | `v3-crosschain/frontend/` static page, labeled "cross-chain extension (experimental)", with plan §2 honesty disclosures. |
| 6 | Decision point | OPEN | Go/no-go with the user on including v3 in the submission. |

---

## Trust-model note (do not contradict)

Per `research/crosschain-investigation.md`: the GenLayer↔EVM bridge is real via
GenLayer's LayerZero V2 hub-and-spoke (zkSync Era Sepolia hub, off-chain relay),
but there is **no independent finality proof** binding an outbound message to
GenLayer consensus. Today it is **trusted-relay, not consensus-authenticated**.
Same-chain Interlock never has this problem. Any v3 text states exactly this.

## Honesty notes (do not contradict)

- `BaseDemoVault` is a **toy**, not Aave, and protects no real funds.
- v3 does **not** protect real Aave, real Base mainnet funds, or anything beyond
  the toy `BaseDemoVault`.
- The relay service is a real operational dependency: if it is not running, a
  real GenLayer-side trip never reaches Base Sepolia.
