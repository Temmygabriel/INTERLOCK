# PROGRESS-v3 — Cross-Chain Extension (Base Sepolia)

Branch: `interlock-v3-crosschain`
Spec: `interlock-v3-crosschain-plan.md`
Started: 2026-09-08

This is the v3 branch's own log. It lives ONLY on this branch and is separate
from the main `PROGRESS.md` (which tracks the submission-ready core on `main`).

---

## BLOCKER STATUS — read this first

**GenLayer studionet deploys were GATED.** As of 2026-09-08, studionet was
rejecting all new deploys with `invalid_contract absent_runner_comment`: the
previously-pinned runner hash was no longer recognized. The main session then
empirically probed candidate pins on studionet: the old `1jb45aa8…` pin and a
`5jycge4…` v0.3.0 pin were both rejected, but the **boilerplate's own v0.1.0
pin deploys successfully**. Only the Depends hash matters — the `# v0.x.y`
marker line is ignored by validation.

The confirmed working pin (matching the vendored boilerplate's own contracts):

```
# v0.1.0
# { "Depends": "py-genlayer:1j12s63yfjpva9ik2xgnffgrs6v44y1f52jvj9w7xvdn7qckd379" }
```

`interlock_v3.py` carries this two-line header, but **no GenLayer deploy has
been attempted or verified this session.** Phase 0 (hello-world re-check) and
all Phase 3/4 GenLayer deploys remain GATED until a real studionet deploy
succeeds with this pin.

EVM (Base Sepolia / zkSync Era Sepolia) deploys need a funded testnet wallet +
a Node toolchain. **No `npm install` was completed this session** (the machine
is ~99% disk; the background install was discarded to free space). All EVM
deploy/test steps are DEFERRED with exact commands below.

---

## Phase status

| # | Phase | Status | Notes |
|---|---|---|---|
| 0 | Prerequisite check (studionet deploy healthy) | **GATED** | Runner pin empirically confirmed; no deploy attempted this session. |
| 1 | Boilerplate setup | **DONE (code)** | Vendored `genlayer-studio-bridge-boilerplate` (commit `85fe384`) into `v3-crosschain/boilerplate/`. EVM deploys + trust config **DEFERRED** — exact commands in `v3-crosschain/DEPLOY-NOTES.md`. |
| 2 | BaseDemoVault | **DONE (code + test, not executed)** | `v3-crosschain/base/BaseDemoVault.sol` + `test/BaseDemoVault.test.js` + standalone Hardhat project. Compile/test/deploy **DEFERRED** (needs `npm install` + funded wallet). Commands below. |
| 3 | interlock_v3.py | **DONE (code)** | `v3-crosschain/genlayer/interlock_v3.py` mirrors the interlock.py judgment/guard pattern; emits a narrowly-typed `TRIP` message via `BridgeSender.emit().send_message(...)`. Header carries the confirmed pin. GenLayer deploy **GATED** pending a successful studionet deploy. |
| 4 | Relay + receiver wiring | **DEFERRED** | Requires phases 1–3 to be live; relay must run during any demo. See `DEPLOY-NOTES.md` (including the observed destination-dispatch gap in the shipped `BridgeReceiver.sol`). |
| 5 | v3 demo page | **DONE (scaffold)** | `v3-crosschain/frontend/` static page (HTML/CSS/JS, no build step), labeled "cross-chain extension (experimental)", with the plan §2 honesty disclosures on-page. |
| 6 | Decision point | OPEN | Go/no-go with the user on including v3 in the submission. |

---

## Exact commands to finish (phases 1–5)

These were NOT run this session (deferred). Run them on this branch from the
repo root once a funded testnet wallet + Node toolchain are available and the
studionet pin is verified.

### A. EVM bridge infrastructure (boilerplate — copy its README steps verbatim)

```bash
# from v3-crosschain/boilerplate/
cd smart-contracts && npm install && cd ..
cd service && npm install && cd ..

# configure env (never commit .env)
cp smart-contracts/.env.example smart-contracts/.env   # PRIVATE_KEY + RPC URLs
cp service/.env.example service/.env                   # PRIVATE_KEY + GENLAYER_RPC_URL

# deploy EVM infrastructure
cd smart-contracts
CONTRACT=receiver   npx hardhat run scripts/deploy.ts --network baseSepoliaTestnet
CONTRACT=receiver   npx hardhat run scripts/deploy.ts --network zkSyncSepoliaTestnet
CONTRACT=forwarder  npx hardhat run scripts/deploy.ts --network zkSyncSepoliaTestnet
CONTRACT=sender     npx hardhat run scripts/deploy.ts --network baseSepoliaTestnet

# link EVM contracts (trust config)
ACTION=set-trusted-forwarder  npx hardhat run scripts/configure.ts --network zkSyncSepoliaTestnet
ACTION=set-authorized-relayer npx hardhat run scripts/configure.ts --network zkSyncSepoliaTestnet
ACTION=set-bridge-address     npx hardhat run scripts/configure.ts --network zkSyncSepoliaTestnet
ACTION=set-sender-receiver    npx hardhat run scripts/configure.ts --network baseSepoliaTestnet
ACTION=set-trusted-forwarder  npx hardhat run scripts/configure.ts --network baseSepoliaTestnet
```

### B. GenLayer "Brain" (GATED on a working studionet deploy — use the confirmed pin)

Deploy via GenLayer Studio: `boilerplate/intelligent-contracts/BridgeSender.py`
(no args) and `BridgeReceiver.py` (no args; then
`set_authorized_relayer(wallet_address, true)`). Then set the addresses in
`service/.env` (see `DEPLOY-NOTES.md` §6) and start the relay:

```bash
cd v3-crosschain/boilerplate/service
npm run build
npm start
```

### C. BaseDemoVault — compile, test, deploy

```bash
cd v3-crosschain/base
npm install                 # deferred to free disk this session
npx hardhat test            # 12 tests: flaw, audit log, trip() ACL, TRIP tag, resume, etc.
PRIVATE_KEY=0x... OWNER_ADDRESS=0x... BRIDGE_RECEIVER_ADDRESS=<Base BridgeReceiver.sol> \
  npx hardhat run scripts/deploy.js --network baseSepoliaTestnet
```

### D. interlock_v3.py deploy (GATED on the pin)

Deploy via GenLayer Studio with the confirmed v0.1.0 pin. Constructor args:
`target_vault` (GenLayer DemoVault), `governance`, `min_bond`,
`bridge_sender` (GenLayer BridgeSender.py), `target_chain_eid` = `40245`
(Base Sepolia), `target_contract` = deployed BaseDemoVault address.

### E. End-to-end check

File a real `report_exploit` on `interlock_v3.py` against a real exploit in the
GenLayer `DemoVault` audit log. On `EXPLOIT_CONFIRMED`, confirm the outbound
message in the GenLayer-side outbox (`BridgeSender.get_message_hashes()`), wait
2–5 min, then check `BaseDemoVault.paused == true` on Base Sepolia (also via
`v3-crosschain/frontend/?vault=<address>`).

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
