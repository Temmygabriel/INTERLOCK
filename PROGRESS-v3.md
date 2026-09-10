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

---

## Phase 8 — v3 EVM leg DEPLOYED + WIRED on live testnets (task #31, 2026-09-10)

Deployed entirely via GitHub Actions (`.github/workflows/deploy-v3-evm.yml`) —
never from the local 8GB PC. Deploy run **34462322988**, wiring run **34463919827**
(both green).

| Role | Chain | Address |
|------|-------|---------|
| BridgeForwarder (hub) | zkSync Era Sepolia | `0x1567e63787e0fE93653dfe0cC1eaEf554EB237A5` |
| BaseTripDispatcher (LZ V2 receiver) | Base Sepolia | `0x1567e63787e0fE93653dfe0cC1eaEf554EB237A5` |
| BaseDemoVault (toy victim) | Base Sepolia | `0xCF3EfC03eb49F36f7a806FD39eDcDD3Db8EaB567` |

Deployer `0x687B7C90b2EcB18cC812f04B2417ea28f6662B8e` owns all three; relay
`0x6F539bD20033eE4cEC78784eac4C91fcAAc01f5b` is the forwarder's CALLER_ROLE
holder (set at construction).

**Wiring verified ON-CHAIN** (not merely logged):
- `dispatcher.trustedForwarders[40305]` = forwarder `0x1567…237A5` ✓ (set at dispatcher deploy)
- `vault.bridgeReceiver()` = dispatcher `0x1567…237A5` ✓ (constructor arg)
- `dispatcher.trustedTargets[vault]` = **true** ✓ (tx `0xe114ed…ef1f`)
- `forwarder.bridgeAddresses[40245]` = dispatcher `0x1567…237A5` ✓ (tx `0xb22a67…f6b8`, `BridgeAddressSet` event)

The forwarder and dispatcher share an address: same deployer, nonce 0 on each
chain, so the CREATE addresses coincide. Harmless (different chains) — and since
the value the dispatcher must trust *is* the zkSync forwarder's address, it is
also correct.

### CI failures diagnosed en route (all fixed; the workflow is now a proven path)

1. **HH1006 on Base compile** — `paths.sources: "./"` made hardhat scan
   `node_modules` (eth-gas-reporter's mock `.sol`). Fix: self-contained
   `base/contracts/` tree (vendored `interfaces/IGenLayerBridgeReceiver.sol`,
   plus `lz/LzTypes.sol`), `sources: "./contracts"`.
2. **Invisible deploy errors across three runs** — the runner launches every
   `run:` step with `bash -e`, so a failing `LOG=$(npx hardhat …)` command
   substitution killed the script *before* `st=$?` / `printf` / the `::error::`
   guard, hiding the real error. Fix: `set +e` first in the capture-based steps.
3. **zkSync deployer underfunded** — `insufficient funds for gas + value`,
   balance 0.0004 ETH vs fee ~0.00055. User topped up to 0.0025 ETH.
4. **Post-deploy `params()` BAD_DATA (vault step)** — the vault *deployed fine*
   (`0xCF3E…B567`, tx `0xf8b4…2b7f`); the failure was a cosmetic read racing the
   load-balanced public Base RPC. Fix: retry, then warn (never fatal).
5. **`trustedTargets(vault)` stale `false` (whitelist step)** — the
   `setTrustedTarget` tx succeeded (`status 0x1`, event fired, mapping true), but
   an immediate read hit a lagging node. `retryRead` only retried *thrown* errors,
   and `false` is a valid return, so it never helped. Fix: poll-until-true.

Because 4–5 were script/wiring issues, not contract issues, the workflow gained a
**`mode=configure`** input that replays ONLY the two wiring steps against existing
addresses — used to finish the wiring without orphaning verified contracts or
spending more deploy gas.

### Still not done (do not overclaim)
- No GenLayer-side v3 deploy on studio-dev yet (**#32**); no relay run (**#33**).
- The relay wallet `0x6F53…f5b` holds ~0.0005 ETH on zkSync Era Sepolia — likely
  enough for one LZ `callRemoteArbitrary`, but top up if the send fails.

---

## Phase 9 — v3 LIVE cross-chain TRIP VERIFIED END-TO-END (task #33, 2026-09-10)

The whole point of v3: a real GenLayer TRIP, produced by validator consensus on a
GenLayer contract, pauses a vault on **Base Sepolia**. It ran live, in one
unbroken chain of custody, and every hop was read back off the chain.

### GenLayer leg (studio-dev, task #32) — deployed + linked

| Role | Address |
|------|---------|
| `demo_vault` (pinned-evidence victim) | `0x747a46E92DbC5214C84AD7c8eCDbcB3fF63B5D58` |
| `BridgeSender` (outbox) | `0x751885dB21a891FE52619eD785b5EE9e22eAa17B` |
| `interlock_v3` (the guard) | `0x49499dB82Ad857AD992c278CAb290FeB1B592165` |
| deployer / governance / reporter | `0xB83f5B6A1E39598280A16aBEAeD95e05077b8750` |

`interlock_v3.target_contract` is set to the **BaseDemoVault**, NOT the dispatcher.
That is load-bearing: `BaseTripDispatcher` checks `trustedTargets[localContract]`,
and `BridgeSender` writes `localContract = Address(target_contract)` into the
envelope. Pointing `target_contract` at the dispatcher would have produced
envelopes the dispatcher rejects.

### The run — 6 hops, each verified on-chain

1. **Exploit** — `demo_vault.borrow(18)` → collateral 57, debt 40 → 58, coverage
   **98%**. `audit[0]` is the pinned incident (tx `0xea41c13d…`).
2. **Report** — `interlock_v3.report_exploit(0)` with `value = 5` (min_bond).
   Validators independently re-derived the verdict: **`EXPLOIT_CONFIRMED`**
   ("Coverage is 98%, below 100%…"). `tripped = True`; `incident[0]` =
   `{"kind":"TRIP_SENT","effect":"send_trip","coverage_after":98}`.
   tx `0x0c5726caa55a18e3adb4cf3130b6728fd6f0440535b34588d87cc29483b9a555`,
   `FINISHED_WITH_RETURN`.
3. **Emit** — the `bridge.emit(on="finalized").send_message(40245, <vault>,
   abi.encode("TRIP"))` child finalized on its own:
   child tx `0x7b480025cf7d9ec67b21f51f92bfd6db2ea5765ede325f3956da2f45d21a2e1e`
   → message hash `f47db7052efbd1d085fadbbb6f0cc39518f0e449cf60244161e3f5e31d8bd089`.
4. **Outbox decoded** — `srcChainId 61998`, `srcSender` = interlock_v3,
   `localContract` = BaseDemoVault, message = `'TRIP'` (canonical
   `abi.encode(string)`), `target_chain_id 40245`. Every field asserted, not assumed.
5. **Relay** — `BridgeForwarder.callRemoteArbitrary(hash, 40245, envelope,
   options)` on zkSync Era Sepolia, paying the quoted LZ fee.
   tx `0x8e176d7335557aa46f49396e0caccf2c9e13d2c16908e27c9d3efae89cfebd58`
   (status 1, block 8437191, gasUsed 499247, fee 0.000116157288929968 ETH),
   emitting `RemoteBridgeSent(dstEid=40245)`.
6. **Delivery** — LayerZero V2 → `BaseTripDispatcher.lzReceive` → vault.
   Base Sepolia tx `5eeacc02517667614b0a9c509280b51283accaa8e57102366bfabdeee4fe0e60`:
   `TripForwarded(srcChainId=61998, srcSender=0x49499d…, target=0xCF3E…B567, message='TRIP')`
   and `VaultTripped(by=dispatcher)`.

**Final state read back off Base Sepolia: `BaseDemoVault.paused = True`,
`auditLen = 1`, `audit[0] op = 'bridge_trip'`.**

Scripts (all committed with this phase): `deploy_v3_studio.py`,
`preflight_v3.py`, `run_trip_v3.py --stage borrow|report|outbox`,
`relay_trip_v3.py`, `verify_v3.py` (the done-when evidence reader).

### Two platform facts root-caused live (both cost real debugging)

1. **A cross-contract `.emit(on="finalized")` needs a *message allocation* in
   the parent's fee budget — and the plain fee estimator does not produce one.**
   `client.estimate_transaction_fees()` returns a parent-only budget
   (`max_messages_per_tx: 0`, `messageFeesBudgetTotal: 0`), so `report_exploit`
   finalized with `contract_error: "fee no_matching_allocation # internal"`
   **after consensus had already agreed on the verdict** — the trip was real but
   the send was dropped. Fix: `client.estimate_transaction_fees_for_write(
   address, function_name, account=…, args=…, value=…)`, which simulates the call
   and returns `message_allocations` covering the emitted child (observed:
   `callKey 0x73656e645f6d657373616765…` = `"send_message"`).
   This is the SDK-side form of what the browser path already does — see the
   `sim_estimateTransactionFees` note in `frontend/gen.js`, which passes the full
   calldata precisely so the preset carries `messageAllocations`. Any same-chain
   `interlock.py` test that exercises the emitted `apply_pause` child needs the
   same treatment (*relevant to task #27*).
2. **`sepolia.base.org` rejects wide `eth_getLogs` ranges with
   `HTTPError: 413 Payload Too Large`.** `verify_v3.py --blocks 20000` fails;
   ~2500-block windows work. Not a contract issue — a public-RPC limit.

### TRUST MODEL — do not soften

The destination chain trusts **this relay** to faithfully forward a message that
really came from confirmed GenLayer consensus. There is no independent finality
proof binding the outbound message to validator consensus. If the relay does not
run, a genuine GenLayer-side trip never reaches Base Sepolia. This is the honest
boundary of the v3 demo and must be stated as such in the pitch.

### Still not done (do not overclaim)
- The relay is a **manual script**, not a deployed service. Nothing restarts it.
- Only one trip is demonstrated, and the vault is now permanently `paused`; a
  second live run needs a fresh vault (or `resume()` from the owner).
- No Base Sepolia → GenLayer return path is exercised (v3 is one-directional).

---

## Phase 10 — browser write path PROVEN, and the relay made autonomous (2026-09-10)

### Task #34 — the browser write path against `interlock_v3` (PASSED)

This was the gating risk for the whole interactive design: the SDK path was
proven in Phase 9, but a *browser* report had to produce a fee packet carrying
the `send_message` emit allocation, and that was unverified.

The test did not re-implement anything — it imported the real
`frontend/gen.js` + `frontend/tx.js` in Node (ethers UMD in `globalThis.ethers`,
exactly as `index.html` loads it) and drove them with a fresh random browser
identity, mirroring `app.js submitReport()`:

```
preset.messageAllocations = [ { messageType: 1 (Internal), onAcceptance: false,
  parentIndex: 2^256-1, recipient: 0xd7120c9a… (BridgeSender),
  callKeyDecoded: "send_message", budget: 153453600002588 } ]
```

`ALLOCATION COUNT: 1` — the emit allocation is present. The broadcast then
settled from a 0-balance browser key, the guard tripped (`reports=1`), and the
outbox filled ~30 s later:

```
message hash : f9128ef616d63f07d74c1fbf05db5c59bfbf0942667be25386aaf97f6f69584f
target_chain : 40245      target_contract: 0xCF3EfC03eb49F36f7a806FD39eDcDD3Db8EaB567
```

**The trap that makes this test easy to get wrong:** it MUST run against an
UNTRIPPED trio. A tripped guard takes the `noop_already_tripped` branch, emits
nothing, needs no allocation — and the identical test passes *vacuously*. A
fresh trio (`demo_vault 0x0a38c140…`, `bridge_sender 0xD7120c9A…`,
`interlock_v3 0xB4502c37…`) was deployed for exactly this reason, and
`demo_vault.borrow(18)` pinned `audit[0]` at 98% coverage.

### Task #35 — the always-on relay

`v3-crosschain/genlayer/scripts/relay_ci.py` + `.github/workflows/relay-v3.yml`
(cron `*/5`, plus dispatch). Every address comes from
`frontend/demo-manifest.json`.

**A real bug this fixed:** `relay_trip_v3.py` hardcoded the BridgeSender. After
the fresh trio was deployed it silently read the *previous* trio's outbox and
reported `already relayed? True` — while the current trio's message sat pending.
Any hardcoded address in the relay is a latent "the relay is running but
delivering nothing" failure, which looks identical to "no exploit yet". The
manifest removes that class of bug.

Runs deliberately **overlap** (300 s window against a 5-min cron, and no
`concurrency` block — a group with `cancel-in-progress: false` would queue each
run behind the previous one and destroy the overlap). Effective latency is
~20-60 s, not 5 minutes. `isHashUsed` + the forwarder's `usedTxHash` make
double-delivery safe across overlapping runs.

Verified live, with this code, in one continuous sequence:

| step | evidence |
|---|---|
| `resume_base_vault.py` | Base tx `b2283dc2…`, `GovernanceResumed`, `paused → false` |
| `relay_ci.py` (window 120 s) | found `f9128ef6…` unrelayed, validated envelope, zkSync tx `c555118f…` |
| delivery | `RemoteBridgeSent -> dstEid=40245` |
| result | `BaseDemoVault.paused = TRUE`, `auditLen 3` |

That is the **complete claimed path, with the browser as its origin**:
browser identity → GenLayer validator consensus → `BridgeSender` outbox →
CI relay → LayerZero V2 → `BaseDemoVault.paused = true`.

**`resume()` re-arms the vault without redeploying it** (owner-only, records
`governance_resume`, leaves the audit log intact — the previous trip's evidence
stays on-chain). One gotcha: its read-back must POLL, because the
load-balanced Base RPC answered from a replica lagging the receipt block and
reported `paused = true` for a resume whose event had already fired.

### Blocker: pushing `.github/workflows/`

The GitHub credential in use (both the git credential helper and the `gh` CLI)
carries only `gist`, `read:org`, `repo`. GitHub refuses to create or update any
file under `.github/workflows/` without the `workflow` scope, so `relay-v3.yml`
could not be pushed. The scripts and the manifest ARE pushed (`91f5478`, on
`main` and `interlock-v3-crosschain`); the workflow file sits on disk awaiting
`gh auth refresh -h github.com -s workflow`.

### Still not done (do not overclaim)
- The relay workflow has not yet run on GitHub — its send path is proven only
  by the local run of the identical script.
- The demo trio deployed this phase is now TRIPPED (the #34 test consumed it).
  A fresh trio is still needed for the live demo.
- No Base Sepolia → GenLayer return path is exercised (v3 is one-directional).

## Phase 11 — the page becomes the v3 product (2026-09-10)

Task #37. `main` now deploys a page whose PRIMARY section is the cross-chain
breaker; the same-chain instrument is demoted to FIG. 3 / FIG. 4 below it.

### What changed
- `frontend/crosschain.js` (new) — reads all three systems: guard `status()` +
  latest incident, the `BridgeSender` outbox, and `BaseDemoVault` on Base Sepolia
  read straight from the page with ethers (the public Base RPCs send
  `Access-Control-Allow-Origin: *`, so no proxy). Reads never throw: every
  failure returns `{ok:false, error}` and the panel says what is actually wrong.
- `frontend/index.html` — hero rewritten around the mandated pitch; new FIG. 2
  `#crosschain` section, three live stages with ids `#xstage1..3`.
- `frontend/style.css` — `.xchain`/`.xstage` grid, `data-state` accents.
- `frontend/build.mjs` + `frontend/config.js` — the primary pair now points at
  the v3 trio; the 8+ cross-chain addresses come from
  `frontend/demo-manifest.json`, baked at build. **No Vercel env var needed
  renaming — only its value.**

### Two design corrections made while building this
1. **`config.js` claimed a plain static serve would resolve the cross-chain
   panel. It did not** — the manifest only reached the page when `build.mjs`
   ran, so serving `frontend/` directly rendered "not configured".
   `initCrossChain()` now fetches `demo-manifest.json` at runtime when the build
   step did not bake it. One source of truth, both paths work.
2. **The relay row asserted "scheduled workflow"** while `relay-v3.yml` is still
   unpushable (no `workflow` scope). That is exactly the unverified claim the
   task-#21 discipline forbids. The row now reports only what the page can
   observe: `idle` / `carrying…` / `delivered`, and `#xNote` describes the trust
   boundary and the relay's real latency without asserting a deployment.

### Verification (headless, against live networks)
`xchain_render_test.mjs` stands up a fake DOM, imports the REAL built
`dist/app.js`, and lets `init() → tick() → renderCrossChain()` run:

| stage | readout | value |
|---|---|---|
| 1 | breaker / coverage / reports / incidents | TRIPPED / 98% / 1 / 1 |
| 2 | outbox / message hash / target / relay | 1 message / `f9128ef6…` / chain 40245 / delivered |
| 3 | paused / coverage / audit / receiver | TRUE / 142% / 3 / `0x1567e6…` |

No blank readouts; stage 3's link resolves to the real LayerZero delivery tx
`0xe4494091…`. The same-chain instrument still renders underneath.

**Caveats:** this proves the panel paints real state and never throws. It does
NOT prove layout or CSS — that needs a browser. And it ran against the already
TRIPPED trio, so the *interactive* report path (`reportCrossChain`) still has no
live run; the write it performs is the one proven in Phase 10.

### A caught bug worth keeping
`await renderCrossChain().catch(() => {})` swallowed every failure, so a broken
panel rendered as silent blanks. It now logs via `console.warn` — which is how
the harness caught that `applyReadouts` was throwing in a stub DOM.

## Phase 12 — the visitor path, proven and then corrected (2026-09-11)

Task #36 + the last untested piece of #37. The page is armed and the report
button has now been driven end to end.

### The demo is interactive again
The trio from Phase 10/11 was consumed by the browser-write test and the Base
vault was left paused, so the page had nothing to offer a visitor. Both halves
re-armed:

| | |
|---|---|
| Base Sepolia | `resume()` tx `0x819e2560…`, vault live (auditLen 4) |
| GenLayer | fresh `demo_vault 0x35ce1365…`, `BridgeSender 0xDf6041aC…`, `interlock_v3 0x198b4f9D…` |
| exploit | `borrow(18)` → audit[0], coverage 98% |

Confirmed armed at the end of the session: `tripped=False, report_count=0,
incident_count=0, audit_len=1, coverage=98%, outbox=0`. **All testing since has
run against throwaway trios, so the armed trio is untouched.**

`build.mjs` now resolves the PRIMARY pair from `demo-manifest.json` instead of
the committed `config.js` defaults. Those defaults go stale on every redeploy,
so resolving from them meant each reset also needed a Vercel dashboard edit.
The manifest is now the one file a reset rewrites and the one file to commit.

### The visitor path, clicked for real
`xchain_click_test.mjs` records the click handler app.js wires to `#xReport`
and invokes it, so this is the real handler, real bonded write, real consensus:

```
[+  6s] stage1="RUNNING" badge="exploit pinned"  #xReport disabled=false
[+  6s] CLICKING #xReport
[+ 11s] Step 1/3 — signing a bonded report on entry #0 …
[+ 21s] Step 2/3 — report broadcast (0x0e81ef01…) …
[+ 31s] Step 3/3 — consensus CONFIRMED the exploit and the guard tripped.
FINAL  stage1=done/tripped/reports=1/incidents=1
       stage2=done/queued/1 message/hash c6ca01fb…/relay=carrying…
       stage3=live/paused=false   #xReport disabled=true
```

Consensus took **~10 s**. Stage 2 reading `carrying…` with stage 3 still `live`
is correct and honest — the message is queued and nothing has relayed it.

### Two bugs the click test found
1. **The outcome line was clobbered.** `syncCrossChainButton()` runs on every
   poll, so the instant the guard tripped it overwrote "consensus CONFIRMED the
   exploit" with the generic "this guard has already tripped — re-arming takes a
   fresh guard". A visitor who had just successfully tripped the breaker was
   told it was already tripped and would read their own success as a refusal.
   Fixed with an `xReported` latch plus holding `xBusy` across the relay wait.
   Verified: the line survives 75 s of polling after the trip.
2. **"Still judging" and "judged false" read identically.** A report consensus
   REJECTS (`effect: noop_false_report`) fell into the same timeout branch as a
   verdict that had not arrived. The branch now distinguishes them.

### Also
- `resume_base_vault.py` called `time.sleep` without importing `time`, so a
  SUCCESSFUL resume threw `NameError` during its own confirmation read and
  reported failure for work that had succeeded. Fixed.
- `deploy-v3-evm.yml`'s checkout `ref:` moved `interlock-v3-crosschain` → `main`.
  **This edit is on disk but cannot be committed or pushed** — see below.
- `relay_ci.py --once` run against the armed manifest: reads the new addresses,
  finds the outbox clear, exits 0. The CI no-op path is proven; the send path is
  still only proven by the local run of the identical script.

### Still not done (do not overclaim)
- **The relay is not running anywhere.** Nothing carries a queued message to
  Base, so a visitor's report trips GenLayer and stage 3 never flips. The
  workflow is written but unpushable without the GitHub `workflow` scope.
- Layout/CSS of the cross-chain panel has never been seen in a browser — the
  headless harness proves state, not pixels.

### The `workflow` scope blocks more than the workflows
The credential GitHub has here carries `gist`, `read:org` and `repo` — but not
`workflow`. GitHub refuses any push whose commits touch a path under
`.github/workflows/`, and it refuses the **whole push**, not just that path:

```
! [remote rejected] HEAD -> main (refusing to allow an OAuth App to create or
  update workflow `.github/workflows/deploy-v3-evm.yml` without `workflow` scope)
```

The first attempt at this commit bundled the one-line `deploy-v3-evm.yml` `ref:`
change with the app.js fix, so a trivial workflow edit silently made the frontend
fix unpushable too. Split apart: the app.js fix and this file push normally, and
the workflow edit sits uncommitted on disk. Anything destined for
`.github/workflows/` must stay out of commits until `gh auth refresh -h
github.com -s workflow` has been run.

**Uncommitted, on disk only:** `.github/workflows/deploy-v3-evm.yml` (ref →
main), `.github/workflows/relay-v3.yml` (untracked), and the two reset workflows
still to be written.

