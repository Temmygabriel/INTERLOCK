# DEPLOY-NOTES — v3 cross-chain bridge (Base Sepolia)

This file records the **exact deployment steps** for the v3 cross-chain
extension, quoted from the vendored boilerplate's own README
(`v3-crosschain/boilerplate/README.md`). Do not improvise these steps.

## Vendored boilerplate

- Origin: `https://github.com/genlayer-foundation/genlayer-studio-bridge-boilerplate`
- Vendored commit: `85fe384` ("Update references from ZKsync to ZKsync Era")
- Location: `v3-crosschain/boilerplate/` (nested `.git` removed — it is a plain
  vendored copy on this branch)
- License: MIT (see `v3-crosschain/boilerplate/LICENSE`)

The bridge uses GenLayer's LayerZero V2 **hub-and-spoke** model with **zkSync
Era Sepolia** as the hub for GenLayer's interactions with the wider EVM
ecosystem. Endpoint IDs: ZKsync Era Sepolia `40305`, Base Sepolia `40245`.

---

## Trust-model disclosure (from the plan §2, do not soften)

The destination chain **trusts the relay** to faithfully deliver a message that
really came from confirmed GenLayer consensus. There is **no independent
finality proof** binding an outbound message to validator consensus finality.
Today the model is **trusted-relay, not consensus-authenticated**. Same-chain
Interlock never has this problem.

---

## PHASE 4 WIRING — read this first (destination dispatch gap, resolved)

The shipped boilerplate's `BridgeReceiver.sol` is a **store**, not a **dispatcher**:
its `lzReceive` decodes a 5-field tuple `(uint32, address, address, bytes, bytes32)`
and records the message for the EVM→GenLayer relay to poll. It never calls
`processBridgeMessage` on a target, so it **cannot** be the destination receiver for
the GenLayer→EVM direction. The relay, meanwhile, forwards the payload that GenLayer
`BridgeSender.py` stores — a **4-field** tuple
`abi.encode(uint32 srcChainId, address srcSender, address localContract, bytes message)`
— which is exactly the shape the `BridgeForwarder`'s own same-chain (local) branch
decodes. The fix (Phase 4, this branch):

**`v3-crosschain/base/BaseTripDispatcher.sol`** — a minimal LayerZero V2 receiver
that fills the gap:
1. only the LayerZero Endpoint may invoke `lzReceive` (msg.sender check);
2. `allowInitializePath`/`lzReceive` accept only the configured trusted forwarder
   (the zkSync Era Sepolia `BridgeForwarder`, srcEid `40305`);
3. it decodes the 4-field payload and forwards `message` to the whitelisted
   `localContract`'s `processBridgeMessage(srcChainId, srcSender, message)`;
4. the payload's `localContract` must be on an owner-managed whitelist
   (`setTrustedTarget`), so a compromised relay could not re-point it elsewhere.

Its address is registered on the zkSync `BridgeForwarder` as
`bridgeAddresses[40245]` (the `set-bridge-address` destination), and it is what
`BaseDemoVault.bridgeReceiver` must be set to — **not** the shipped `BridgeReceiver`.

`BaseDemoVault` (the toy victim) is unchanged. `interlock_v3.py` is unchanged.
The end-to-end path is:

```
report_exploit ─▶ interlock_v3.py ─▶ BridgeSender.py (GenLayer outbox)
   ─▶ relay polls get_message_hashes/get_message
   ─▶ BridgeForwarder.callRemoteArbitrary (zkSync Era Sepolia, dstEid 40245)
   ─▶ LayerZero V2 delivers to BaseTripDispatcher (Base Sepolia)
   ─▶ BaseTripDispatcher → BaseDemoVault.processBridgeMessage("TRIP")
   ─▶ BaseDemoVault.paused == true (observable on Basescan)
```

The four test files proving this path at the unit level are
`v3-crosschain/base/test/BaseTripDispatcher.test.js` (+
`contracts/test/MockEndpoint.sol`): 17 tests drive mock-endpoint → dispatcher →
`BaseDemoVault`, including wrong-forwarder, untrusted-target, non-TRIP payload and
non-endpoint-caller rejection. Run them with `npx hardhat test` from
`v3-crosschain/base` (after `npm install`).

---

## 0. Prerequisites (from boilerplate README §"Prerequisites")

- **Node.js**: v18+ & **npm**: v9+
- **GenLayer Studio**: [GenLayer Studio](https://studio.genlayer.com/)
- **Wallet**: a private key with testnet funds on:
  - **Base Sepolia** (example target chain)
  - **ZKsync Era Sepolia** (hub chain)

---

## 1. Installation (boilerplate README §"1. Installation")

```bash
# 1. Install Smart Contracts dependencies (EVM)
cd smart-contracts && npm install && cd ..

# 2. Install Bridge Service dependencies (Relayer)
cd service && npm install && cd ..
```

## 2. Configuration (boilerplate README §"2. Configuration")

Create your environment files.

**Smart Contracts (`.env`)** — `v3-crosschain/boilerplate/smart-contracts/`:

```bash
cp smart-contracts/.env.example smart-contracts/.env
# EDIT: Add your PRIVATE_KEY and RPC URLs
```

**Service (`.env`)** — `v3-crosschain/boilerplate/service/`:

```bash
cp service/.env.example service/.env
# EDIT: Add your PRIVATE_KEY and GENLAYER_RPC_URL (e.g. https://studio.genlayer.com/api/rpc)
```

The `.env.example` files are committed in the vendored copy. Copy each to
`.env`, then fill in `PRIVATE_KEY`, RPC URLs, and (after deploys) the bridge
addresses. `.env` files are gitignored — never commit a private key.

## 3. Deploy EVM Infrastructure (boilerplate README §"3. Deploy EVM Infrastructure")

Deploy the "mailbox" contracts to the EVM chains. From `smart-contracts/`:

```bash
cd smart-contracts

# 1. Deploy Receiver (Target & Hub)
CONTRACT=receiver npx hardhat run scripts/deploy.ts --network baseSepoliaTestnet
CONTRACT=receiver npx hardhat run scripts/deploy.ts --network zkSyncSepoliaTestnet

# 2. Deploy Forwarder (Hub - ZKsync Era)
CONTRACT=forwarder npx hardhat run scripts/deploy.ts --network zkSyncSepoliaTestnet

# 3. Deploy Sender (Target - Base)
CONTRACT=sender npx hardhat run scripts/deploy.ts --network baseSepoliaTestnet
```

## 4. Link EVM Contracts (boilerplate README §"4. Link EVM Contracts")

Configure the trust relationships so messages can flow securely. From
`smart-contracts/`:

```bash
# Configure Hub (ZKsync Era)
ACTION=set-trusted-forwarder npx hardhat run scripts/configure.ts --network zkSyncSepoliaTestnet
ACTION=set-authorized-relayer npx hardhat run scripts/configure.ts --network zkSyncSepoliaTestnet
ACTION=set-bridge-address npx hardhat run scripts/configure.ts --network zkSyncSepoliaTestnet

# Configure Target (Base)
ACTION=set-sender-receiver npx hardhat run scripts/configure.ts --network baseSepoliaTestnet
ACTION=set-trusted-forwarder npx hardhat run scripts/configure.ts --network baseSepoliaTestnet
```

Required env vars per action (from `scripts/configure.ts`):
- `set-trusted-forwarder`: `BRIDGE_RECEIVER_ADDRESS`, `TRUSTED_FORWARDER_ADDRESS`, `SRC_EID`
- `set-authorized-relayer`: `BRIDGE_RECEIVER_ADDRESS`, `RELAYER_ADDRESS` (or `OWNER_ADDRESS`)
- `set-bridge-address`: `BRIDGE_FORWARDER_ADDRESS`, `DST_EID`, `DST_BRIDGE_ADDRESS`
- `set-sender-receiver`: `BRIDGE_SENDER_ADDRESS`, `ZKSYNC_BRIDGE_RECEIVER_ADDRESS` (EID default `40305`)

## 5. Deploy GenLayer "Brain" (boilerplate README §"5. Deploy GenLayer 'Brain'")

Deploy the Intelligent Contracts via GenLayer Studio:

1. **Deploy `BridgeSender.py`** — the exit point for results returning to EVM.
   - _No constructor args._
2. **Deploy `BridgeReceiver.py`** — receives and dispatches incoming requests to
   target ICs.
   - _No constructor args. After deployment, call `set_authorized_relayer(wallet_address, true)`._

> **GATED → UNGATED:** studionet studio deploys are healthy again (the #22 fix).
> The empirically-confirmed pin is `py-genlayer:1j12s63yfjpva9ik2xgnffgrs6v44y1f52jvj9w7xvdn7qckd379`
> (marker line `# v0.1.0` first; the vendored boilerplate's own contracts and
> `v3-crosschain/genlayer/demo_vault.py` put a blank line after the Depends
> comment, `interlock_v3.py` carries the same pin plus a note line). No fresh
> GenLayer deploy has been attempted on this branch yet; it is ready to run once
> the studionet keystore is unlocked.

## 6. Activate the Resolution Layer (boilerplate README §"6. Activate the Resolution Layer")

Update `service/.env` with your new contract addresses:

```env
BRIDGE_SENDER_ADDRESS=<GenLayer BridgeSender Address>
BRIDGE_RECEIVER_IC_ADDRESS=<GenLayer BridgeReceiver Address>
ZKSYNC_BRIDGE_FORWARDER_ADDRESS=<ZKsync Era BridgeForwarder Address>
ZKSYNC_BRIDGE_RECEIVER_ADDRESS=<ZKsync Era BridgeReceiver Address>
```

Start the relay:

```bash
cd service
npm run build
npm start
```

_The service is now polling. Your bridge is live._

> **Operational dependency:** the relay must run continuously during any live v3
> demo. If it is not running, a real GenLayer-side trip will never reach Base
> Sepolia. A trip is not instant or guaranteed without it.

---

## v3-specific: deploy BaseDemoVault

`BaseDemoVault.sol` is a normal EVM contract (implements
`IGenLayerBridgeReceiver`) and deploys on **Base Sepolia**. Once the bridge
infrastructure (steps 1–4) is live, deploy it with the **`BaseTripDispatcher`
address** as its configured bridge receiver (the contract that will call
`processBridgeMessage` — NOT the shipped `BridgeReceiver.sol`, which only stores
EVM→GenLayer messages):

```bash
cd v3-crosschain/base
npm install   # if not already done
npx hardhat run scripts/deploy.js --network baseSepoliaTestnet
```

Constructor arg: `_bridgeReceiver` = the deployed `BaseTripDispatcher` address,
and `_owner` = the governance address. The same wallet that owns the dispatcher
should own this vault. If the vault is already deployed with a different bridge
receiver, the owner can re-point it with `setBridgeReceiver(<dispatcher>)`.

## v3-specific: deploy BaseTripDispatcher

Deploy the destination dispatcher on **Base Sepolia** (see the Phase 4 wiring
section above for why it exists):

```bash
cd v3-crosschain/base
npm install   # if not already done
PRIVATE_KEY=0x... OWNER_ADDRESS=0x... \
  TRUSTED_FORWARDER_ADDRESS=<zkSync BridgeForwarder> \
  BASEDEMOVAULT_ADDRESS=<BaseDemoVault (optional now, or later)> \
  npx hardhat run scripts/deploy-dispatcher.js --network baseSepoliaTestnet
```

Required env vars (see `v3-crosschain/base/.env.example`):
- `PRIVATE_KEY` — deployer (Base Sepolia funded EOA)
- `OWNER_ADDRESS` — governance address that owns the dispatcher
- `BASESEPOLIATESTNET_ENDPOINT` — LayerZero V2 endpoint on Base Sepolia
  (`0x6EDCE65403992e310A62460808c4b910D972f10f`)
- `ZKSYNC_EID` — `40305` (zkSync Era Sepolia, the forwarder's source EID)
- `TRUSTED_FORWARDER_ADDRESS` — the zkSync `BridgeForwarder.sol` address
  (`setTrustedForwarder(40305, addr)` is called right after deploy)
- `BASEDEMOVAULT_ADDRESS` — the vault to whitelist (`setTrustedTarget(addr, true)`)

Then, on the zkSync `BridgeForwarder`, register the dispatcher as the Base
destination so LayerZero delivers TRIP payloads to it:

```bash
# from v3-crosschain/boilerplate/smart-contracts
ACTION=set-bridge-address DST_EID=40245 DST_BRIDGE_ADDRESS=<BaseTripDispatcher> \
  npx hardhat run scripts/configure.ts --network zkSyncSepoliaTestnet
```

## v3-specific: deploy interlock_v3.py

Deploy via GenLayer Studio after the runner re-pin is confirmed. Constructor
args:
- `bridge_sender` — the GenLayer `BridgeSender.py` address
- `target_vault` — the GenLayer `DemoVault` address (the same-chain victim)
- `governance` — governance address (informational)
- `min_bond` — minimum report bond
- `target_chain_eid` — `40245` (Base Sepolia)
- `target_contract` — the deployed `BaseDemoVault.sol` address

## End-to-end run (Phase 4) — GenLayer → Base Sepolia

The goal: a real `report_exploit` on `interlock_v3.py` → consensus confirms →
`BridgeSender` outbox → relay delivers → `BaseTripDispatcher` → `BaseDemoVault`
`trip()` → `paused == true` on Base Sepolia.

### 0. Prerequisites (credentials you must supply)

- A funded EOA with Base Sepolia ETH **and** zkSync Era Sepolia ETH. One key is
  enough for EVM deploys + the relay (same wallet becomes the forwarder's
  `CALLER_ROLE` holder and the authorized relayer). Get testnet ETH from the Base
  Sepolia / zkSync Era Sepolia faucets.
- A GenLayer studionet account with GL (the existing encrypted keystore
  `~/.genlayer/keystores/default.json`, address `a881…466d`, holds 15 GL — its
  password is needed to unlock; or any funded key).
- RPCs are public and need no key: `https://sepolia.base.org`,
  `https://sepolia.era.zksync.dev`, `https://studio.genlayer.com/api`.

### 1. EVM infrastructure — deploy the zkSync hub forwarder

Only the GenLayer→EVM leg is needed for v3, so the minimal set is the zkSync
`BridgeForwarder` (the Base `BridgeSender.sol`, both `BridgeReceiver.sol`s and
GenLayer `BridgeReceiver.py` belong to the EVM→GenLayer direction v3 does not use).

```bash
# from v3-crosschain/boilerplate/
cd smart-contracts && npm install && cd ..

# .env: PRIVATE_KEY, OWNER_ADDRESS, CALLER_ADDRESS (relay wallet), RPCs, LZ endpoints
cp smart-contracts/.env.example smart-contracts/.env

CONTRACT=forwarder npx hardhat run scripts/deploy.ts --network zkSyncSepoliaTestnet
# COPY: <ZK_FORWARDER>
```

### 2. Deploy + configure BaseTripDispatcher (Base Sepolia)

```bash
cd v3-crosschain/base
npm install
PRIVATE_KEY=0x... OWNER_ADDRESS=0x... \
  TRUSTED_FORWARDER_ADDRESS=<ZK_FORWARDER> \
  npx hardhat run scripts/deploy-dispatcher.js --network baseSepoliaTestnet
# COPY: <DISPATCHER>
```

### 3. Deploy BaseDemoVault (Base Sepolia), bridged by the dispatcher

```bash
PRIVATE_KEY=0x... OWNER_ADDRESS=0x... BRIDGE_RECEIVER_ADDRESS=<DISPATCHER> \
  npx hardhat run scripts/deploy.js --network baseSepoliaTestnet
# COPY: <BASEDEMOVAULT>
```

### 4. Point the forwarder at the dispatcher (zkSync)

```bash
cd ../boilerplate/smart-contracts
ACTION=set-bridge-address DST_EID=40245 DST_BRIDGE_ADDRESS=<DISPATCHER> \
  npx hardhat run scripts/configure.ts --network zkSyncSepoliaTestnet
```

Whitelist the vault on the dispatcher (if not done at deploy — re-run the deploy
script; it skips the forwarder when `TRUSTED_FORWARDER_ADDRESS` is unset):

```bash
cd v3-crosschain/base
BASEDEMOVAULT_ADDRESS=<BASEDEMOVAULT> \
  npx hardhat run scripts/deploy-dispatcher.js --network baseSepoliaTestnet
```

### 5. Deploy the GenLayer contracts (studionet, confirmed v0.1.0 pin)

Deploy each via GenLayer Studio **or** the CLI (needs the keystore unlocked):

```bash
# BridgeSender.py — no constructor args
genlayer deploy --contract v3-crosschain/boilerplate/intelligent-contracts/BridgeSender.py \
  --rpc https://studio.genlayer.com/api

# demo_vault.py (v3 branch copy with the confirmed pin) — (owner, guardian)
genlayer deploy --contract v3-crosschain/genlayer/demo_vault.py --rpc https://studio.genlayer.com/api \
  --args 0x<GOVERNANCE> 0x<GOVERNANCE>

# interlock_v3.py — (target_vault, governance, min_bond, bridge_sender, 40245, target_contract)
genlayer deploy --contract v3-crosschain/genlayer/interlock_v3.py --rpc https://studio.genlayer.com/api \
  --args 0x<DEMOVAULT> 0x<GOVERNANCE> 1 0x<BRIDGE_SENDER> 40245 "<BASEDEMOVAULT>"
```

> `target_contract` is typed `str` on the GenLayer side and embedded in the
> payload by `BridgeSender.py`; it must be the BaseDemoVault address as a string.

### 6. Start the relay

```bash
# from v3-crosschain/boilerplate/
cd service && npm install
cp service/.env.example service/.env
# service/.env:
#   BRIDGE_SENDER_ADDRESS=<GenLayer BridgeSender>
#   BRIDGE_FORWARDER_ADDRESS=<ZK_FORWARDER>
#   FORWARDER_NETWORK_RPC_URL=https://sepolia.era.zksync.dev
#   GENLAYER_RPC_URL=https://studio.genlayer.com/api
#   PRIVATE_KEY=<relay wallet key — must hold CALLER_ROLE on the forwarder and
#                ETH on zkSync Era Sepolia for LayerZero fees>
npm run build
npm start
```

The relay polls `get_message_hashes()` and calls
`BridgeForwarder.callRemoteArbitrary` (quotes + pays the LayerZero fee). Keep it
running for the whole demo.

### 7. Drive the exploit + trip

1. **Borrow undercollateralized on the GenLayer DemoVault** (audit entry 0):

   ```bash
   genlayer write 0x<DEMOVAULT> borrow --rpc https://studio.genlayer.com/api --args 18
   # -> coverage 98% (< 100%): the pinned exploit incident
   ```

2. **File the bonded report** on interlock_v3.py. The `genlayer` CLI has no
   `--value` flag, so either use GenLayer Studio's Run-and-Debug (attach
   `>= min_bond` GL) or the included script:

   ```bash
   # from v3-crosschain/boilerplate/example (after npm install)
   export PRIVATE_KEY=0x... GENLAYER_RPC_URL=https://studio.genlayer.com/api
   npx tsx scripts/report-trip.ts --interlock 0x<INTERLOCK_V3> --op-index 0 --value 1
   ```

3. **Watch the outbox** (should show one `TRIP` message, dst chain 40245):

   ```bash
   npx tsx scripts/check-outbox.ts --bridge-sender 0x<BRIDGE_SENDER>
   ```

### 8. Verify on Base Sepolia

Wait 2–5 minutes for the relay + LayerZero delivery. Then:

```bash
cd v3-crosschain/base
VAULT_ADDRESS=<BASEDEMOVAULT> npx hardhat run scripts/check.js --network baseSepoliaTestnet
# simplest: Basescan for <BASEDEMOVAULT>, read `paused` and the audit log
```

or the demo page: `v3-crosschain/frontend/?vault=<BASEDEMOVAULT>` (public RPC,
read-only).

`BaseDemoVault.paused` should read `true`, with a `bridge_trip` entry on the
audit log. That is the Phase 4 done-when.

> **Status on this machine (2026-09-08): NOT RUN.** No funded Base/zkSync EOA,
> no relay key, and the GenLayer keystore password were available this session,
> and the ~100%-full disk forbade `npm install` (hardhat/ethers). All code +
> docs above are complete; the run is blocked on those credentials. Nothing in
> this file should be read as a claim that the run succeeded.

---

## Development & debugging CLI (boilerplate README §"Development & Debugging")

```bash
cd service

# Check ZKsync Era BridgeReceiver state
npx ts-node cli.ts check-receiver

# Check Base BridgeSender state
npx ts-node cli.ts check-sender

# Check ZKsync Era BridgeForwarder state
npx ts-node cli.ts check-forwarder

# Verify all configurations
npx ts-node cli.ts check-config

# List pending messages on ZKsync Era
npx ts-node cli.ts pending-messages

# Debug a specific transaction
npx ts-node cli.ts debug-tx <hash>
```

## Observed boilerplate inconsistency (checked against vendored commit `85fe384`)

The boilerplate README states: "LayerZero delivers to `BridgeReceiver` on
destination chain (Target)" and "`BridgeReceiver` dispatches to target contract
via `processBridgeMessage()`". **The shipped `BridgeReceiver.sol` does not do
that dispatch** — its `lzReceive` decodes `(uint32, address, address, bytes,
bytes32)` and stores the message for the EVM→GenLayer hub flow; it never calls
`processBridgeMessage` on a target. The only shipped code path that calls
`processBridgeMessage` on a target is `BridgeForwarder.callRemoteArbitrary`'s
same-chain (local) branch.

Implication for v3's GenLayer→Base flow: `interlock_v3.py` emits `TRIP` into the
GenLayer `BridgeSender`, the relay calls `BridgeForwarder.callRemoteArbitrary`
on zkSync Era Sepolia with destination EID `40245`, and LayerZero delivers to
whatever address is registered as that EID's `bridgeAddresses[40245]` on the
forwarder. That registered address must be a contract that (a) implements
`ILayerZeroReceiver.lzReceive`, (b) decodes the relayed `(uint32, address,
address, bytes)` payload, and (c) calls `processBridgeMessage(srcChainId,
srcSender, innerMessage)` on the `BaseDemoVault`. The plain shipped
`BridgeReceiver.sol` is not such a dispatcher for this direction.

This is documented here as an observed gap in the boilerplate's docs-vs-code —
it is **not** a license to improvise the deployment steps. For phase 4, the
operator should either:
1. deploy/register a small dispatcher that matches the forwarder's local-call
   semantics (`IGenLayerBridgeReceiver(localContract).processBridgeMessage(...)`),
   following the interface exactly, or
2. use the forwarder's same-chain (local) branch if the demo is kept on one chain.

**Resolved on this branch (Phase 4): option 1 is implemented.**
`v3-crosschain/base/BaseTripDispatcher.sol` is that dispatcher — a LayerZero V2
receiver that (a) accepts only the LayerZero Endpoint, (b) trusts only the zkSync
Era Sepolia `BridgeForwarder` (srcEid `40305`), (c) decodes the 4-field payload,
and (d) forwards to a whitelisted target's `processBridgeMessage`. See the Phase 4
wiring section at the top of this file.

The example's `StringReceiver.sol` is the reference for what the target must
implement (`processBridgeMessage`); `BaseDemoVault.sol` follows it exactly.

## Troubleshooting (boilerplate README §"Troubleshooting")

- **Service Logs**: the `service` console is the best debugging tool; it tracks
  every step of the relay.
- **Gas**: ensure the relayer wallet has ETH on both Base Sepolia and ZKsync Era
  Sepolia.
- **Trust**: if messages fail to deliver, check that `set-trusted-forwarder` was
  run on the target chain.
- **LayerZero Endpoints**: ensure you are using the correct Endpoint IDs —
  ZKsync Era Sepolia `40305`, Base Sepolia `40245`.
