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

> **GATED:** GenLayer studio deploys were rejected this session
> (`invalid_contract absent_runner_comment`) until the runner re-pin. The v3
> contract headers already carry the empirically-confirmed v0.1.0 pin
> (`py-genlayer:1j12s63yfjpva9ik2xgnffgrs6v44y1f52jvj9w7xvdn7qckd379` — the
> same pin the vendored boilerplate's own contracts use). Re-run this step
> after a hello-world deploy confirms studionet accepts new contracts.

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
infrastructure (steps 1–4) is live, deploy it with the Base `BridgeReceiver`
address as its configured bridge receiver:

```bash
cd v3-crosschain/base
npm install   # if not already done
npx hardhat run scripts/deploy.js --network baseSepoliaTestnet
```

Constructor arg: `_bridgeReceiver` = the Base Sepolia `BridgeReceiver.sol`
address (the contract that will call `processBridgeMessage`), and `_owner` = the
governance address. The same wallet that owns the bridge receiver should own
this vault.

## v3-specific: deploy interlock_v3.py

Deploy via GenLayer Studio after the runner re-pin is confirmed. Constructor
args:
- `bridge_sender` — the GenLayer `BridgeSender.py` address
- `target_vault` — the GenLayer `DemoVault` address (the same-chain victim)
- `governance` — governance address (informational)
- `min_bond` — minimum report bond
- `target_chain_eid` — `40245` (Base Sepolia)
- `target_contract` — the deployed `BaseDemoVault.sol` address

## End-to-end test (GenLayer → EVM, adapted from example README)

After phases 1–4 are live, file a real `report_exploit` on `interlock_v3.py`
pointed at a real exploit in the GenLayer `DemoVault` audit log. When consensus
confirms it, `interlock_v3.py` emits a `TRIP` message into `BridgeSender.py`.
Wait 2–5 minutes, then check Base Sepolia:

```bash
cd boilerplate/example/smart-contracts
npx hardhat run scripts/check-messages.ts --network baseSepoliaTestnet --contract <BASEDEMOVAULT_ADDRESS>
```

`BaseDemoVault.paused` should read `true` on a Base Sepolia block explorer.

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
