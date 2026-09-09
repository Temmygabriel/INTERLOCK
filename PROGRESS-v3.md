# PROGRESS-v3 — Cross-Chain Extension (Base Sepolia)

Branch: `interlock-v3-crosschain`
Spec: `interlock-v3-crosschain-plan.md`
Started: 2026-09-08
Last updated: 2026-09-09 (Phase 7 — studio-dev dialect port, deploy-verified)

This is the v3 branch's own log. It lives ONLY on this branch and is separate
from the main `PROGRESS.md` (which tracks the submission-ready core on `main`).

---

## PHASE 7 — STUDIO-DEV DIALECT PORT (2026-09-09) — supersedes everything below

**The GenLayer side of v3 is now ported to the LIVE studio-dev stack (chain 61997,
v0.3.0 runner pin `5jycge4q8k23462jtb0b9fyey1s9qz928sz2nbrd9mg4sxqg2qng`).**
The old studionet (v0.1.0 dialect, pin `1j12s63…`) that the whole v3 GenLayer
stack was written for is DEAD (deploys become zombies: lifecycle accepted,
"Contract not found"). Task #29 (worktree `agent-a6f…`, branch
`interlock-v3-xchain-work`) ported and deploy-VERIFIED all three GenLayer
contracts on studio-dev:

| Contract (file) | Studio-dev address (verification instance) | Verified |
|---|---|---|
| DemoVault (`v3-crosschain/genlayer/demo_vault.py`) | `0x03a91CDffB4676935a03D6d2de31d9b88B8FbE72` | deploy FINISHED_WITH_RETURN; genesis 142%; params/coverage/audit read back |
| BridgeSender (`boilerplate/intelligent-contracts/BridgeSender.py`) | `0x1C3f35712416FeF61a714C2b5373b6ca0C7A0ea7` | deploy + `send_message` runtime write FINISHED_WITH_RETURN; stored hash `66e228ed…`; `get_message` returns relay shape (`data` 0x-hex, `target_chain_id`, `target_contract`) |
| InterlockV3 (`v3-crosschain/genlayer/interlock_v3.py`) | `0x5D3D9dc85D01D161c31fA4F8D8D50EBF8Efa7144` | deploy + `status`/`constitution_view` read back (eid 40245, effect_set, trust_model) |

The three addresses above are a **DISPOSABLE verification instance** (fresh random
deployer, not persisted, not linked/armed for the live run) — proof-of-port only.
Task #32 will deploy the final linked set on studio-dev.

**Dialect facts discovered by deploy-probing (recorded here so nobody re-derives
them):**
1. New header: `# v0.3.0` + Depends `5jyc…qng` + blank line. Base
   `gl.contract.Contract`, storage `gl.storage.TreeMap/DynArray`,
   `gl.message.raw["datetime"]`, `gl.vm.UserError(<payload>)` (read via `.data`),
   `gl.contract.get_at`, `gl.vm.run_nondet`, `.emit(on="finalized")`,
   `.emit_transfer(due, on="finalized")`.
2. **`genlayer.py.*` submodule imports DO NOT resolve on studio-dev** — neither
   `from genlayer.py.evm import MethodEncoder` nor
   `from genlayer.py.keccak import Keccak256`. Use the public `gl.evm.MethodEncoder`
   and `gl.Keccak256` instead (`gl.Keccak256().update(bytes)…digest()` is
   byte-correct EVM keccak256, verified against eth-hash).
3. **The v0.3.0 runner does NOT execute std-object construction at module scope**
   (a module-scope `MethodEncoder()`/`Keccak256()` makes the deploy finish
   FINISHED_WITH_ERROR). Build std objects inside `__init__` (as a fail-fast, which
   IS executed at deploy) or inline in the method that uses them. Every proven
   `main` contract already obeys this (only str constants at module scope).
4. Cross-contract `.emit().method()` does NOT return the child's return value, so
   `interlock_v3` records `last_trip_hash=""` honestly; the authoritative message
   hash is the key BridgeSender stored it under (`get_message_hashes()`), which is
   exactly the view the relay polls.

This commit is LOCAL to the worktree branch and NOT pushed; the coordinator
reconciles the v3 branches and rebases onto `main` (task #30) before any push.

---

## BLOCKER STATUS — read this first

**GenLayer studionet deploys are HEALTHY again (the #22 fix).** The confirmed
working pin (empirically probed by the main session; matches the vendored
boilerplate's own contracts) is:

```
# v0.1.0
# { "Depends": "py-genlayer:1j12s63yfjpva9ik2xgnffgrs6v44y1f52jvj9w7xvdn7qckd379" }
```

`interlock_v3.py` and the new `v3-crosschain/genlayer/demo_vault.py` copy carry
this two-line header (marker line first, blank line after the Depends comment).
**No GenLayer deploy was attempted this session.** Deploys are ready to run once
the studionet keystore is unlocked (`~/.genlayer/keystores/default.json`, address
`a881…466d`, holds 15 GL — password needed).

**EVM (Base Sepolia / zkSync Era Sepolia) deploys and the relay are BLOCKED on
credentials + a capable machine, not on code:**
- No funded Base Sepolia / zkSync Era Sepolia EOA and no relay private key were
  available this session. All EVM + relay commands are exact and ready
  (see `v3-crosschain/DEPLOY-NOTES.md` Phase 4 runbook).
- This machine is ~100% disk; no `npm install` (hardhat/ethers) was run and none
  should be run here. Tests/deploys must run on a machine with disk headroom.

**Nothing in this log should be read as a claim that the end-to-end run
succeeded.** It has not been executed.

---

## Phase status

| # | Phase | Status | Notes |
|---|---|---|---|
| 0 | Prerequisite check (studionet deploy healthy) | **CONFIRMED via main** | #22 fix: the v0.1.0 pin deploys. No fresh hello-world deploy attempted this session. |
| 1 | Boilerplate setup | **DONE (code)** | Vendored `genlayer-studio-bridge-boilerplate` (commit `85fe384`). EVM deploys + trust config **DEFERRED** — exact commands in `DEPLOY-NOTES.md`. |
| 2 | BaseDemoVault | **DONE (code + tests, not executed)** | `BaseDemoVault.sol` + 12 tests. Compile/test/deploy **DEFERRED** (needs `npm install` + funded wallet). |
| 3 | interlock_v3.py | **DONE (code)** | Mirrors interlock.py judgment/guard; emits narrowly-typed `TRIP` via `BridgeSender.emit().send_message(...)`. GenLayer deploy **READY** (pin confirmed) — not run. |
| 4 | Relay + receiver wiring | **CODE DONE — NOT RUN** | Destination dispatch gap closed with `BaseTripDispatcher.sol` (+ 17 tests). Full runbook in `DEPLOY-NOTES.md`. **Blocked on funded EVM EOA + relay key + GenLayer keystore password.** |
| 5 | v3 demo page | **DONE (scaffold)** | `v3-crosschain/frontend/` static page, labeled "cross-chain extension (experimental)", plan §2 honesty disclosures on-page. |
| 6 | Decision point | **NOTES PREPARED** | See "Phase 6 — go/no-go notes" below. Conversation with the user still required. |

---

## Phase 4 work completed this session (2026-09-08)

Phase 4's job was to make a real `TRIP` reach `BaseDemoVault` on Base Sepolia.
The missing piece was the **destination dispatch**. The shipped `BridgeReceiver.sol`
is a *store* (EVM→GenLayer), not a *dispatcher*: its `lzReceive` decodes a 5-field
tuple and records it; it never calls `processBridgeMessage`. The relay, meanwhile,
forwards the 4-field payload `BridgeSender.py` stores
`(uint32 srcChainId, address srcSender, address localContract, bytes message)`
— the same shape the forwarder's own same-chain branch decodes. So v3 needs a
small destination receiver, and now has one:

- **`v3-crosschain/base/BaseTripDispatcher.sol`** — LayerZero V2 receiver: only
  the endpoint may call it; only the zkSync Era Sepolia `BridgeForwarder`
  (srcEid `40305`) is trusted; it decodes the 4-field payload and calls
  `processBridgeMessage` on a whitelisted target (`BaseDemoVault`). Its address
  is registered on the forwarder as `bridgeAddresses[40245]`, and it is what
  `BaseDemoVault.bridgeReceiver` must be set to.
- **`v3-crosschain/base/contracts/lz/LzTypes.sol`** — minimal dependency-free
  `Origin` struct + `ILayerZeroReceiver` interface (layout matches
  `@layerzerolabs/lz-evm-protocol-v2` exactly; avoids a npm install of LZ deps).
- **`v3-crosschain/base/contracts/test/MockEndpoint.sol`** — test-only endpoint
  impersonation (checks `allowInitializePath`, then `lzReceive` as msg.sender).
- **`v3-crosschain/base/test/BaseTripDispatcher.test.js`** — 17 tests proving the
  whole unit path mock endpoint → dispatcher → BaseDemoVault, including
  wrong-forwarder, untrusted-target, non-TRIP payload, and non-endpoint rejection.
- **`v3-crosschain/base/scripts/deploy-dispatcher.js`** — deploy + initial
  configure (trusted forwarder + trusted target) on Base Sepolia.
- **`v3-crosschain/base/scripts/check.js`** — read `paused`/audit state on Base
  Sepolia (the Phase 4 verification step).
- **`v3-crosschain/genlayer/demo_vault.py`** — branch-isolated copy of the GenLayer
  DemoVault (code identical to `main`, header pin updated to the confirmed v0.1.0
  pin), so interlock_v3 has a fresh victim to judge without touching `main`.
- **`v3-crosschain/boilerplate/example/scripts/report-trip.ts`** — files the
  bonded `report_exploit` with `msg.value` (the `genlayer` CLI's `write` has no
  `--value` flag).
- **`v3-crosschain/boilerplate/example/scripts/check-outbox.ts`** — reads
  `BridgeSender.get_message_hashes()` / `get_message()` to watch the TRIP leave
  GenLayer.
- **`v3-crosschain/base/.env.example`**, `scripts/deploy.js` — updated for the
  dispatcher (the vault's bridge receiver is now the dispatcher, not the shipped
  `BridgeReceiver`).
- **`v3-crosschain/DEPLOY-NOTES.md`** — Phase 4 wiring section + full 8-step
  end-to-end runbook.

### What is NOT done (plainly)

- No contract was compiled or deployed (no `npm install`; no funded keys).
- No GenLayer contract was deployed (keystore not unlocked this session).
- No relay ran. `BaseDemoVault.paused` was **not** flipped to true on any chain.
- The 17 dispatcher tests were **written, not executed**.

---

## Exact commands to finish (phases 1–5)

These were NOT run this session. They are exact and ready — the full annotated
runbook is `v3-crosschain/DEPLOY-NOTES.md` (Phase 4 wiring + End-to-end run).
Summarized:

### A. EVM bridge infrastructure (minimal v3 set: zkSync forwarder only)

```bash
cd v3-crosschain/boilerplate/smart-contracts && npm install
cp .env.example .env      # PRIVATE_KEY, OWNER_ADDRESS, CALLER_ADDRESS, RPCs, LZ endpoints
CONTRACT=forwarder npx hardhat run scripts/deploy.ts --network zkSyncSepoliaTestnet
```

### B. BaseTripDispatcher + BaseDemoVault (Base Sepolia)

```bash
cd v3-crosschain/base && npm install
PRIVATE_KEY=0x... OWNER_ADDRESS=0x... TRUSTED_FORWARDER_ADDRESS=<ZK_FORWARDER> \
  npx hardhat run scripts/deploy-dispatcher.js --network baseSepoliaTestnet
PRIVATE_KEY=0x... OWNER_ADDRESS=0x... BRIDGE_RECEIVER_ADDRESS=<DISPATCHER> \
  npx hardhat run scripts/deploy.js --network baseSepoliaTestnet
npx hardhat test          # BaseDemoVault (12) + BaseTripDispatcher (15)
```

### C. Link (zkSync): point forwarder at dispatcher

```bash
cd ../boilerplate/smart-contracts
ACTION=set-bridge-address DST_EID=40245 DST_BRIDGE_ADDRESS=<DISPATCHER> \
  npx hardhat run scripts/configure.ts --network zkSyncSepoliaTestnet
```

### D. GenLayer contracts (studionet, confirmed pin)

```bash
genlayer deploy --contract v3-crosschain/boilerplate/intelligent-contracts/BridgeSender.py \
  --rpc https://studio.genlayer.com/api
genlayer deploy --contract v3-crosschain/genlayer/demo_vault.py --rpc https://studio.genlayer.com/api \
  --args 0x<GOVERNANCE> 0x<GOVERNANCE>
genlayer deploy --contract v3-crosschain/genlayer/interlock_v3.py --rpc https://studio.genlayer.com/api \
  --args 0x<DEMOVAULT> 0x<GOVERNANCE> 1 0x<BRIDGE_SENDER> 40245 "<BASEDEMOVAULT>"
```

### E. Relay

```bash
cd v3-crosschain/boilerplate/service && npm install && npm run build && npm start
# .env: BRIDGE_SENDER_ADDRESS, BRIDGE_FORWARDER_ADDRESS,
#       FORWARDER_NETWORK_RPC_URL=https://sepolia.era.zksync.dev,
#       GENLAYER_RPC_URL=https://studio.genlayer.com/api, PRIVATE_KEY=<relay key>
```

### F. End-to-end

```bash
genlayer write 0x<DEMOVAULT> borrow --rpc https://studio.genlayer.com/api --args 18
# from v3-crosschain/boilerplate/example
npx tsx scripts/report-trip.ts --interlock 0x<INTERLOCK_V3> --op-index 0 --value 1
npx tsx scripts/check-outbox.ts --bridge-sender 0x<BRIDGE_SENDER>
# wait 2-5 min for relay + LayerZero delivery
cd v3-crosschain/base && VAULT_ADDRESS=<BASEDEMOVAULT> npx hardhat run scripts/check.js --network baseSepoliaTestnet
# expect: paused == true, audit entry op=bridge_trip
```

---

## Phase 6 — go/no-go notes (decision point)

Prepared for the go/no-go conversation with the user. **No decision has been
made; this is the input to it.**

### What a "GO" buys

- The demo would show a real, externally observable artifact the core submission
  cannot: a GenLayer consensus-confirmed exploit verdict changing state on a
  *different* chain (Base Sepolia), observable on Basescan. That is a genuinely
  compelling extension of the core claim.
- All the code is in place and the path is fully documented. The remaining work
  is operational, not design: ~1-2 focused sessions with the right credentials.

### What a "NO-GO" costs

- Nothing. `main` remains the complete, honest, tested submission. The README
  already carries the one-sentence sourced fallback (per plan §5).

### The honesty constraints that apply EITHER WAY (from the plan, do not soften)

1. `BaseDemoVault` is a **toy**, not Aave, and protects no real funds.
2. The destination chain trusts the **relay** to faithfully deliver a message
   that really came from confirmed GenLayer consensus. There is **no independent
   finality proof** — trusted-relay, not consensus-authenticated. Same-chain
   Interlock never has this problem.
3. The **relay service is a real operational dependency**: if it is not running,
   a real GenLayer-side trip never reaches Base Sepolia.
4. v3 does not protect real Aave, real Base mainnet funds, or anything beyond the
   toy `BaseDemoVault`.

### Recommendation

**GO for inclusion as a clearly-labeled experimental extension** (separate page,
separate link, never folded into the core submission) IF the user can supply:
(1) a funded Base Sepolia + zkSync Era Sepolia EOA key, (2) the GenLayer studionet
keystore password (or a funded key), and (3) a machine with disk headroom for
`npm install` (hardhat/ethers + genlayer-js) — or willingness to run the exact
commands on the cloud/CI path. Without those three, **NO-GO by default**: the
code is done but the run has not happened, and a demo must not imply otherwise.

**Risk to call out:** the trust boundary is the single most important sentence.
If v3 ships, the first thing any reviewer sees must be the trusted-relay
disclosure, not the Basescan screenshot. Do not let the demo imply a trip is
instant or guaranteed without the relay running.

---

## Trust-model note (do not contradict)

Per `research/crosschain-investigation.md` (research-crosschain branch): the
GenLayer↔EVM bridge is real via GenLayer's LayerZero V2 hub-and-spoke (zkSync Era
Sepolia hub, off-chain relay), but there is **no independent finality proof**
binding an outbound message to GenLayer consensus. Today it is **trusted-relay,
not consensus-authenticated**. Same-chain Interlock never has this problem. Any
v3 text states exactly this.

## Honesty notes (do not contradict)

- `BaseDemoVault` is a **toy**, not Aave, and protects no real funds.
- v3 does **not** protect real Aave, real Base mainnet funds, or anything beyond
  the toy `BaseDemoVault`.
- The relay service is a real operational dependency: if it is not running, a
  real GenLayer-side trip never reaches Base Sepolia.
- No end-to-end run has been executed on this branch. Nothing here claims one did.
