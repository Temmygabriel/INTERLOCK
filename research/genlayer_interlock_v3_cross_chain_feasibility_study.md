# Interlock v3 — Cross-Chain Circuit Breaker Feasibility Study

**Research date:** 7 September 2026  
**Question:** Can a GenLayer Intelligent Contract read/judge a protocol on another chain and cause a pause on that other chain?  
**Scope:** Primary GenLayer / Foundation sources first; LayerZero primary documentation for the transport/security path; no claims beyond what was actually checked.

---

# 1. Executive verdict

- **Feasible today for a testnet / builder deployment, under a trusted-relay transport model.** The GenLayer Foundation has a public bridge boilerplate implementing arbitrary byte-message transport between GenLayer Intelligent Contracts and external EVM chains via a GenLayer-side outbox, an off-chain relay service, a zkSync Era hub, and LayerZero V2. The Foundation's own blog calls the bridge "ready for builders" and says the current relay is deployed alongside the contracts.  
  Source: https://genlayer.com/blog/opening-genlayer-to-all-blockchains  
  Source: https://github.com/genlayer-foundation/genlayer-studio-bridge-boilerplate/blob/main/README.md

- **The GenLayer IC is not itself a LayerZero Endpoint.** The current implementation has the IC write an outbound message to `BridgeSender`; an off-chain Node.js service polls that outbox and submits `BridgeForwarder.callRemoteArbitrary()` on the zkSync hub, which then sends through LayerZero V2.  
  Source: https://github.com/genlayer-foundation/genlayer-studio-bridge-boilerplate/blob/main/intelligent-contracts/BridgeSender.py  
  Source: https://github.com/genlayer-foundation/genlayer-studio-bridge-boilerplate/blob/main/service/src/relay/GenLayerToEvm.ts  
  Source: https://github.com/genlayer-foundation/genlayer-studio-bridge-boilerplate/blob/main/smart-contracts/contracts/BridgeForwarder.sol

- **A cross-chain pause is therefore not currently a purely "GenLayer-consensus-authenticated" destination action.** GenLayer consensus can determine the decision and can emit the instruction, but the destination execution path depends on the bridge stack and its relay/transport trust configuration. The Foundation's current blog explicitly says the off-chain bridge service is required today and says relaying becomes native when mainnet launches.  
  Source: https://genlayer.com/blog/opening-genlayer-to-all-blockchains

- **Reading an external chain into GenLayer consensus is feasible today through `gl.nondet.web`, but this is an evidence/oracle path, not a cryptographic cross-chain state proof.** The validators can independently fetch a pinned finalized block/event from an external RPC and compare the resulting canonical data under a strict equivalence rule. What I did **not** find in the checked GenLayer docs is a shipped GenLayer light client, state-root proof verifier, or other general cryptographic proof mechanism for proving an external chain's finality inside an Intelligent Contract.  
  Sources: https://docs.genlayer.com/developers/intelligent-contracts/features/non-deterministic-operations  
  Source: https://docs.genlayer.com/developers/intelligent-contracts/equivalence-principle

- **For Interlock v3, the credible design is an intentionally constrained destination-chain adapter.** The adapter should have only the protocol's pause/emergency-stop permission; it should accept only a single `TRIP` action family; it should authenticate the source bridge/peer; it should reject replayed or stale messages; and it should have no unpause, token-transfer, arbitrary-call, or upgrade authority.

- **The biggest blocker is not whether a message can technically reach another EVM chain. It can. The blocker is what security claim Interlock can honestly make.** With today's Foundation bridge architecture, the strongest accurate claim is: **"GenLayer-consensus-selected decision delivered through an externally relayed cross-chain message to a least-privilege adapter."** It is not yet accurate to claim: **"The destination chain cryptographically verifies GenLayer consensus without trusting a relay/bridge path."**

---

# 2. Question 1 — Cross-chain messaging out of GenLayer

## 2.1 Primary GenLayer / Foundation evidence

The clearest primary source is the Foundation's article **Opening GenLayer to All Blockchains**.

URL: https://genlayer.com/blog/opening-genlayer-to-all-blockchains

Relevant quote:
> "We chose LayerZero as our first transport layer"

and:
> "GenLayer operates as a hub, with other blockchains connecting as spokes."

The article explicitly describes the bridge as accepting **standard byte payloads**, not just tokens:

> "The bridge itself is agnostic to what you're sending since it uses standard byte payloads, so it works with any dApp logic."

That directly supports **general arbitrary-message transport**, not a token-transfer-only bridge.

It also explicitly describes a current off-chain relay:

> "We've built an off-chain service that you deploy alongside your contracts. It polls and forwards messages between chains, giving you the full developer experience today."

And it explicitly characterizes the relay as temporary in the current roadmap:

> "When mainnet launches, relaying becomes native to the protocol and this service is no longer needed."

This is the source of truth for the critical present-vs-future distinction.

## 2.2 Current Foundation bridge repository

URL: https://github.com/genlayer-foundation/genlayer-studio-bridge-boilerplate

The repository README states:

> "This boilerplate provides the complete infrastructure to connect GenLayer Intelligent Contracts with EVM chains (Base, Ethereum, etc.) via LayerZero V2."

and describes GenLayer as the "Brain" and the external chain as the "Backbone".

Repository README:
https://github.com/genlayer-foundation/genlayer-studio-bridge-boilerplate/blob/main/README.md

## 2.3 The actual GenLayer → EVM code path

The Foundation's Python example `BridgeSender.py` shows an Intelligent Contract writing a bridge message:

URL: https://github.com/genlayer-foundation/genlayer-studio-bridge-boilerplate/blob/main/example/intelligent-contracts/StringSender.py

Relevant code pattern:
```python
bridge_contract = gl.get_contract_at(self.bridge_sender)
bridge_contract.emit().send_message(
    self.target_chain_eid,
    self.target_contract,
    message_bytes,
)
```

This proves that the **Intelligent Contract originates the logical outbound message**.

It does not prove that the IC itself directly talks to LayerZero. The rest of the repository shows that it does not.

## 2.4 The relay service is a real, separate execution component

URL:
https://github.com/genlayer-foundation/genlayer-studio-bridge-boilerplate/blob/main/service/src/relay/GenLayerToEvm.ts

Relevant description:
> "Polls GenLayer BridgeSender for pending messages and relays them via zkSync BridgeForwarder to destination EVM chains."

The code then:

1. reads pending message hashes from the GenLayer `BridgeSender`;
2. reads the message body;
3. obtains a LayerZero fee quote;
4. calls `BridgeForwarder.callRemoteArbitrary()`;
5. waits for the destination-hub transaction receipt.

This is decisive: **the current GenLayer IC is not the transaction signer that directly submits the LayerZero message to the external chain. The relay service is.**

## 2.5 BridgeForwarder is deployed on the zkSync hub, not as a GenLayer Endpoint

URL:
https://github.com/genlayer-foundation/genlayer-studio-bridge-boilerplate/blob/main/smart-contracts/contracts/BridgeForwarder.sol

Relevant quote:
> "Forwards GenLayer->EVM messages via LayerZero. Deployed on zkSync."

Its `callRemoteArbitrary()` function:

- checks the caller has `CALLER_ROLE`;
- checks the message hash has not already been used;
- resolves the destination bridge address for the destination EID;
- submits a LayerZero `MessagingParams` object to the LayerZero Endpoint.

That means the architecture is:

```text
GenLayer IC
   |
   | emit bridge message
   v
GenLayer BridgeSender / outbox
   |
   | polled by off-chain service
   v
Off-chain relay
   |
   | signed EVM tx
   v
zkSync Era BridgeForwarder
   |
   | LayerZero Endpoint.send()
   v
LayerZero
   |
   v
Destination-chain BridgeReceiver / adapter
```

## 2.6 Is GenLayer itself a LayerZero Endpoint?

**Not supported / not found in the checked GenLayer sources.**

The Foundation implementation instead puts `BridgeForwarder.sol` on zkSync and uses LayerZero there. The README describes zkSync Era as the central hub and the relay service as the component connecting GenLayer to that hub.

Source:
https://github.com/genlayer-foundation/genlayer-studio-bridge-boilerplate/blob/main/README.md

Therefore, do not document the architecture as:

```text
GenLayer = LayerZero Endpoint
```

Document it as:

```text
GenLayer → outbox → relay → zkSync hub → LayerZero → destination chain
```

## 2.7 Who is allowed to submit the relay transaction?

In the Foundation boilerplate, `BridgeForwarder.sol` uses an explicit `CALLER_ROLE`.

URL:
https://github.com/genlayer-foundation/genlayer-studio-bridge-boilerplate/blob/main/smart-contracts/contracts/BridgeForwarder.sol

Relevant code facts:

- `_grantRole(CALLER_ROLE, _caller)` happens at construction.
- `callRemoteArbitrary()` uses `onlyRole(CALLER_ROLE)`.
- `updateCaller()` is controlled by `OWNER_ROLE`.

So the current relay submission key is **permissioned at the hub contract**.

The external EVM-side receiver also has explicit trust configuration.

URL:
https://github.com/genlayer-foundation/genlayer-studio-bridge-boilerplate/blob/main/smart-contracts/contracts/BridgeReceiver.sol

Relevant quote/code behavior:
> `require(msg.sender == address(endpoint), "BridgeReceiver: only Endpoint can call")`

and:
> `require(trustedForwarders[_origin.srcEid] == _origin.sender, "BridgeReceiver: untrusted forwarder")`

Thus the destination-side bridge does not simply accept arbitrary EOAs.

## 2.8 What chains are actually reachable today?

### Verified from the Foundation bridge itself

The README gives a concrete deployment example using:

- **Base Sepolia** as the target EVM chain;
- **zkSync Era Sepolia** as the hub.

Source:
https://github.com/genlayer-foundation/genlayer-studio-bridge-boilerplate/blob/main/README.md

The repository README says the boilerplate connects to EVM chains "Base, Ethereum, etc." via LayerZero V2. That establishes the intended generality, but a chain being supported by LayerZero does **not** automatically prove that the GenLayer Foundation bridge has a deployed and configured endpoint/peer on that chain.

### LayerZero endpoint IDs independently verified

LayerZero's own deployment documentation gives:

- Ethereum mainnet: **EID 30101**
  Source: https://docs.layerzero.network/v2/deployments/chains/ethereum

- Base Sepolia: **EID 40245**
  Source: https://docs.layerzero.network/v2/get-started/create-lz-oapp/adding-networks

- Ethereum Sepolia: **EID 40161**
  Source: https://docs.layerzero.network/v2/deployments/chains/sepolia

- Arbitrum Sepolia: **EID 40231**
  Source: https://docs.layerzero.network/v2/deployments/chains/arbitrum-sepolia

These EIDs prove LayerZero has endpoints for those networks. They do **not** by themselves prove that GenLayer's bridge is currently wired to all of them.

### What I will and will not claim

**Verified concrete GenLayer bridge target:** Base Sepolia.

**Architecturally advertised:** Base, Ethereum, and other LayerZero-connected EVM chains.

**Not verified from the checked GenLayer Foundation deployment/configuration:** a live GenLayer bridge deployment on Ethereum mainnet, Base mainnet, Arbitrum, or every other LayerZero chain.

Therefore, for an Interlock hackathon/demo claim, the safe statement is:

> "The Foundation provides a current bridge boilerplate demonstrated on Base Sepolia, and its architecture is designed to target external EVM chains through LayerZero V2. Production/mainnet target-chain availability must be verified per deployment."

---

# 3. Question 2 — Verifiable GenLayer finality / attestation on another chain

## 3.1 What GenLayer currently exposes

GenLayer's current finality documentation says an Intelligent Contract transaction is final only after the appeal process is exhausted and the transaction moves to `Finalized`.

URL:
https://docs.genlayer.com/understand-genlayer-protocol/core-concepts/optimistic-democracy/finality

Relevant quote:
> "An Intelligent Contract transaction is final when the consensus decision can no longer be appealed and the protocol has moved it to `Finalized`."

It also says that anyone can submit the on-chain finalization action once the appeal window ends.

Source:
https://docs.genlayer.com/understand-genlayer-protocol/core-concepts/optimistic-democracy/finality

## 3.2 What I found NOT supported in the checked GenLayer docs

I searched the current GenLayer documentation and Foundation GitHub material for a general destination-chain verification mechanism that would let an Ethereum/Base contract independently verify:

```text
"This GenLayer transaction is finalized and this exact IC state/output is authoritative"
```

through one of the following mechanisms:

- a GenLayer light client on the destination chain;
- a state-root commitment consumed by a destination EVM contract;
- a succinct/zk validity proof that a destination contract can verify;
- a shipped signature/attestation scheme over finalized GenLayer blocks intended for arbitrary external chains;
- a Solidity verifier contract for GenLayer finality;
- a trustless LayerZero message whose payload authenticity is tied cryptographically to GenLayer consensus rather than the Foundation bridge relay.

**I did not find such a mechanism in the checked GenLayer docs or Foundation bridge repository.**

That is an important negative finding.

## 3.3 EVM compatibility / zkSync stack does not itself solve this

GenLayer's current network documentation says the GenLayer Chain is an underlying zkSync Elastic Chain and exposes a normal EVM JSON-RPC surface.

URL:
https://docs.genlayer.com/developers/networks

Relevant quote:
> "GenLayer Chain is the underlying L2 (zkSync Elastic Chain) that handles standard Ethereum operations (`eth_*` methods)."

That is useful for EVM compatibility, but I found **no shipped proof bridge derived from this property** that allows an arbitrary external EVM contract to verify GenLayer finality.

Therefore:

```text
EVM-compatible
```

is **not equivalent to**:

```text
external-chain-verifiable GenLayer finality proof
```

## 3.4 Consequence for Interlock

A destination-chain adapter cannot currently be specified as:

```text
"Execute only if the adapter verifies a GenLayer finality proof on Ethereum."
```

unless we build such a proof/attestation system ourselves, which is outside the set of already-shipped building blocks verified here.

The honest current design is therefore:

```text
GenLayer finality
   ↓
Bridge outbox
   ↓
trusted/permissioned relay
   ↓
LayerZero verification/transport
   ↓
destination adapter
```

not:

```text
GenLayer finality
   ↓
cryptographic proof carried to destination
   ↓
destination adapter verifies GenLayer directly
```

---

# 4. Question 3 — Safe destination-chain adapter

## 4.1 What LayerZero V2 natively gives the destination contract

LayerZero's current OApp documentation explicitly supports arbitrary cross-chain messages that can update state on a destination chain.

URL:
https://docs.layerzero.network/v2/developers/evm/oapp/overview

Relevant quote:
> "The OApp standard lets your contract send and receive arbitrary messages across chains."

It further states that an OApp receiver enforces:

> "Only the LayerZero Endpoint can call this method"

and:

> "the sender is a registered peer (`peers[srcEid] == origin.sender`)"

This is the correct base authentication model to rely on.

## 4.2 LayerZero V2 destination authentication

LayerZero's technical documentation describes the destination execution flow.

URL:
https://docs.layerzero.network/v2/developers/evm/protocol-contracts-overview

Relevant facts from the checked source:

1. The Endpoint is the contract that receives/executed verified messages.
2. `lzReceive()` clears the stored payload before execution.
3. The receiver verifies the Endpoint is `msg.sender`.
4. The OApp verifies that the message source sender equals the configured `peers[srcEid]`.

LayerZero's OApp reference says the same thing:

URL:
https://docs.layerzero.network/v2/concepts/technical-reference/oapp-reference

Relevant quote:
> "Only the Endpoint may call `lzReceive`."

and:
> "Immediately validate that `_origin.sender == peers[_origin.srcEid]`."

## 4.3 Nonces and replay protection

LayerZero V2 tracks outbound nonces per sender, destination endpoint and receiver.

URL:
https://docs.layerzero.network/v2/developers/evm/protocol-contracts-overview

Relevant documented mapping:
```solidity
mapping(address sender => mapping(uint32 dstEid => mapping(bytes32 receiver => uint64 nonce))) public outboundNonce;
```

LayerZero's API documentation also describes inbound nonce/payload-hash tracking.

URL:
https://docs.layerzero.network/v2/developers/evm/technical-reference/api

Relevant quote:
> "Nonces ensure that messages are delivered in order and without duplication."

The LayerZero endpoint documentation states that inbound payload hashes are indexed by sender/source endpoint/nonce.

URL:
https://docs.layerzero.network/v2/developers/evm/technical-reference/api

## 4.4 Minimal Interlock adapter

The adapter should be substantially narrower than a generic OApp.

Recommended state:

```solidity
address public immutable LAYERZERO_ENDPOINT;
bytes32 public immutable TRUSTED_GENLAYER_PEER;
uint32 public immutable TRUSTED_SRC_EID;
address public immutable PAUSE_TARGET;
bytes32 public immutable PAUSE_SELECTOR_OR_ACTION;
uint64 public lastAcceptedNonce;
uint256 public latestAcceptedDecisionTime;
bytes32 public latestDecisionId;
```

Recommended message schema:

```text
TRIP
- version
- decisionId
- sourceEid
- sourcePeer
- nonce
- targetProtocol
- reasonCode
- observedAt / decisionTime
- expiry
```

The adapter should enforce:

```text
1. msg.sender == LayerZero Endpoint
2. _origin.srcEid == configured source EID
3. _origin.sender == configured trusted peer
4. message version supported
5. decisionId not processed before
6. nonce strictly acceptable for this pathway
7. message not expired
8. target protocol matches immutable configured target
9. action == TRIP / PAUSE only
10. no arbitrary calldata field
11. no destination chosen by message
12. call only the immutable pause target
```

The final operation should be something as narrow as:

```solidity
pauseTarget.pause();
```

or, for a protocol whose pause interface is selector-based but fixed at deployment:

```solidity
(bool ok, ) = PAUSE_TARGET.call(abi.encodeWithSelector(FIXED_PAUSE_SELECTOR));
require(ok);
```

The latter should only be used if the selector is immutable and the target is fixed; a generic `address target + bytes calldata` execution method would defeat the whole safety model.

## 4.5 No unpause

The adapter should deliberately not contain:

```text
unpause()
```

and should not be granted any protocol role beyond the narrow emergency-stop role.

This means the recovery path remains outside Interlock, preferably with the protocol's pre-existing governance/admin/multisig process.

## 4.6 No arbitrary calls

The adapter should not implement:

```solidity
execute(address target, bytes calldata data)
```

because that would turn an emergency pause guardian into a generic remote execution wallet.

The entire allowed action set should be one of:

```text
TRIP
```

or an enumerated set such as:

```text
TRIP_MARKET
TRIP_VAULT
TRIP_BORROWING
```

where each maps to a preconfigured destination function.

## 4.7 Replay and stale-message handling

A minimum replay model is:

```text
lastProcessedDecisionId
+
lastProcessedNonce
+
expiry timestamp / max age
```

Because LayerZero itself provides pathway-level nonce and payload handling, the adapter does not need to reinvent the base packet replay mechanism. But Interlock should still maintain an application-level decision ID because one GenLayer decision may be represented by one or more bridge messages.

For a one-way emergency-stop channel, the safest semantics are monotonically increasing decisions:

```text
nonce 41 accepted
nonce 40 rejected
nonce 41 replay rejected
nonce 42 accepted
```

and optionally:

```text
block.timestamp <= decisionExpiry
```

The timestamp must never be used as the sole authentication mechanism; it is an anti-staleness condition only.

---

# 5. LayerZero security does not remove the GenLayer relay trust boundary

This is the key adversarial analysis.

LayerZero provides its own destination-side message-verification model through Endpoint/DVN/peer configuration.

Source:
https://docs.layerzero.network/v2/developers/evm/protocol-contracts-overview

But the GenLayer Foundation bridge currently inserts an additional component:

```text
GenLayer outbox
       ↓
permissioned relay caller
       ↓
zkSync BridgeForwarder
       ↓
LayerZero
```

The `BridgeForwarder` only permits its configured `CALLER_ROLE` to call `callRemoteArbitrary()`.

Source:
https://github.com/genlayer-foundation/genlayer-studio-bridge-boilerplate/blob/main/smart-contracts/contracts/BridgeForwarder.sol

Therefore the relay service is a real trust/liveness boundary.

## 5.1 What a compromised relay key can potentially do

If the trusted relay key controlling `CALLER_ROLE` is compromised, the attacker can call the bridge forwarder with arbitrary `_txHash`, destination EID and message bytes, subject to the forwarding contract's configured bridge addresses and the destination LayerZero/OApp authentication path.

This means a compromised relay can potentially:

- send unauthorized bridge messages;
- cause unnecessary messages / denial-of-service or fee expenditure;
- submit malformed payloads;
- repeatedly attempt delivery under fresh message hashes.

Whether it can make the **Interlock adapter** execute a false TRIP depends on the final destination authentication scheme.

A properly configured LayerZero OApp will not accept a message unless the source peer is the trusted peer for the source EID.

Source:
https://docs.layerzero.network/v2/developers/evm/oapp/overview

So a key design question is: **what source address does the destination chain consider authoritative?**

If the GenLayer bridge's LayerZero source identity is itself a trusted bridge-forwarder contract, then the relay has authority to make that forwarder emit a message but does not automatically become the source peer on LayerZero. That distinction is valuable.

However, the currently checked Foundation boilerplate is still a purpose-built bridge stack rather than a cryptographic attestation of GenLayer consensus state.

## 5.2 Residual trust assumption

The current honest trust statement is:

> **Interlock trusts the configured GenLayer bridge deployment, the bridge's relay operator for liveness/correct message extraction, the zkSync hub bridge contracts, and LayerZero's configured message-verification/security stack. The destination adapter itself adds a least-privilege safety boundary, but it does not independently prove GenLayer consensus finality.**

That is the strongest statement I would sign my name to from the sources checked.

---

# 6. Question 4 — Reading another chain into GenLayer consensus

## 6.1 GenLayer web access is built for this kind of non-deterministic evidence

GenLayer's architecture documentation says Intelligent Contracts isolate non-deterministic operations and let validators independently evaluate their outputs under an application-defined equivalence rule.

Sources:
https://docs.genlayer.com/understand-genlayer-protocol
https://docs.genlayer.com/developers/intelligent-contracts/equivalence-principle

The equivalence documentation explicitly supports custom validation patterns and comparing validator results.

URL:
https://docs.genlayer.com/developers/intelligent-contracts/equivalence-principle

## 6.2 Proposed external-chain read pattern

Suppose the target protocol is on an EVM L2.

The contract's nondeterministic block could ask each validator to retrieve a canonical evidence object from a public RPC:

```text
external RPC
   ↓
eth_getBlockByNumber(finalized block)
eth_getLogs(filter + block range = one block)
   ↓
normalize event fields
   ↓
return typed tuple
```

For example:

```text
{
  chainId: 8453,
  blockNumber: 12345678,
  blockHash: 0x..., 
  txHash: 0x...,
  logIndex: 7,
  contract: 0x...,
  topic0: PauseRelevantEvent,
  decodedFields: ...
}
```

The validators should return a **closed typed structure**, not arbitrary prose.

Then the equivalence condition can be strict:

```text
strict_eq(canonical_evidence)
```

or a deterministic comparison of selected fields.

## 6.3 Is this sound?

**Yes as a consensus/evidence design, provided the decision is about a pinned external-chain point rather than "current state".**

It is not cryptographically trustless.

The validators are independently querying external RPC endpoints, and GenLayer consensus determines whether they agree on the resulting evidence.

The benefit is that the trust assumption is distributed across validators rather than concentrated in one off-chain oracle.

The key is to pin a finalized block or transaction/event, because multiple validators querying "latest" at slightly different times could legitimately see different chain states.

GenLayer's own current reading docs distinguish final state from non-final state and warn that the newest non-final state can move.

Source:
https://docs.genlayer.com/developers/decentralized-applications/reading-data

Relevant quote:
> "The newest available non-final state ... can still move."

## 6.4 Honest failure modes

### RPC censorship

An RPC may refuse a request or omit data.

Effect: that validator may return an external-data failure. A correctly designed validator function should classify transient/external errors consistently rather than treating missing data as a valid negative fact.

Source:
https://docs.genlayer.com/developers/intelligent-contracts/equivalence-principle

The current docs explicitly distinguish external/transient errors in validator handling.

### RPC split / inconsistent providers

Two validators could query different RPC providers that disagree about a non-final block or temporarily lag.

Effect: strict comparison can produce `Disagree`, forcing retry/rotation rather than a false positive.

### Rate limiting

An RPC provider can return errors or throttle requests.

Effect: liveness degradation; it should not be silently interpreted as `safe` or `trip`.

### Latency

A slow RPC can make a validator miss an execution deadline.

Effect: timeout/undetermined behavior rather than an authenticated false decision.

### Block pinning

If the contract says "latest block" rather than a specific finalized block number/hash, different validators can legitimately fetch different states.

Effect: unstable equivalence and exploitable timing.

### Reorgs

If the target-chain block is not final, the event/state may disappear or change.

Effect: wrong evidence object or disagreement.

Therefore the evidence target should be:

```text
specific finalized block number + block hash
```

where the target chain's finality semantics support that concept.

---

# 7. Recommended v3 architecture

```text
                         TARGET CHAIN
              (Base / Ethereum / other EVM L2)

        ┌──────────────────────────────────────────────┐
        │                                              │
        │   Existing DeFi Protocol                     │
        │   e.g. vault / lending market                │
        │            ▲                                 │
        │            │ pause role only                 │
        │            │                                 │
        │   ┌────────┴─────────┐                       │
        │   │ Interlock        │                       │
        │   │ Emergency        │                       │
        │   │ Adapter          │                       │
        │   │                  │                       │
        │   │ TRIP only        │                       │
        │   │ no unpause       │                       │
        │   │ no transfer      │                       │
        │   │ no arbitrary call│                       │
        │   └────────▲─────────┘                       │
        │            │                                 │
        │      LayerZero delivery                     │
        │            │                                 │
        └────────────┼─────────────────────────────────┘
                     │
                     │
               LayerZero V2
                     │
                     │
              ┌──────▼────────┐
              │ zkSync Hub    │
              │ BridgeForwarder│
              └──────▲────────┘
                     │
              off-chain relay
                     │
              ┌──────┴────────┐
              │ GenLayer      │
              │ BridgeSender  │
              │   outbox      │
              └──────▲────────┘
                     │
              Intelligent Contract
              ┌───────────────────────┐
              │ Interlock IC          │
              │                       │
              │ 1. Read pinned       │
              │    external evidence │
              │ 2. LLM classify      │
              │ 3. validators agree  │
              │ 4. finality          │
              │ 5. emit TRIP         │
              └──────────▲────────────┘
                         │
                target-chain RPCs
                         │
              finalized block/event
```

## 7.1 Native today vs built/assumed

| Component | Status | Evidence |
|---|---|---|
| GenLayer IC + validator consensus | **Native today** | https://docs.genlayer.com/understand-genlayer-protocol/optimistic-democracy-how-genlayer-works |
| `gl.nondet.web` / nondeterministic external data | **Native today** | https://docs.genlayer.com/developers/intelligent-contracts/features/non-deterministic-operations |
| Application-defined equivalence | **Native today** | https://docs.genlayer.com/developers/intelligent-contracts/equivalence-principle |
| GenLayer outbound bridge message / outbox | **Foundation bridge today** | https://github.com/genlayer-foundation/genlayer-studio-bridge-boilerplate |
| Off-chain GenLayer→EVM relay | **Today; required by current bridge** | https://github.com/genlayer-foundation/genlayer-studio-bridge-boilerplate/blob/main/service/src/relay/GenLayerToEvm.ts |
| zkSync hub BridgeForwarder | **Today in Foundation boilerplate** | https://github.com/genlayer-foundation/genlayer-studio-bridge-boilerplate/blob/main/smart-contracts/contracts/BridgeForwarder.sol |
| LayerZero V2 transport | **Today** | https://docs.layerzero.network/v2/developers/evm/protocol-contracts-overview |
| Destination-chain LayerZero receiver authentication | **Today** | https://docs.layerzero.network/v2/developers/evm/oapp/overview |
| Interlock least-privilege pause adapter | **Must be built** | Design proposed in this study |
| External-chain finalized block/event fetching in IC | **Supported by web/nondeterminism; application implementation required** | https://docs.genlayer.com/developers/intelligent-contracts/features/non-deterministic-operations |
| Cryptographic GenLayer-finality proof verified on destination chain | **Not supported / not found in checked GenLayer docs** | Negative finding from checked docs/repo |
| Native protocol relaying without external relay | **Not current; Foundation says future/mainnet** | https://genlayer.com/blog/opening-genlayer-to-all-blockchains |

---

# 8. What Interlock should claim

## Strongest technically defensible claim

> **Interlock v3 can use GenLayer's validator consensus to decide whether pinned, independently fetched external-chain evidence indicates an exploit, then emit a narrowly scoped cross-chain TRIP message that an authenticated destination-chain adapter can use to call only the protocol's pause function.**

## Claims to avoid

Do not say:

> "GenLayer directly calls Aave on Ethereum."

Not the current architecture.

Do not say:

> "Ethereum cryptographically verifies that GenLayer finalized the decision."

Not found in the checked GenLayer stack.

Do not say:

> "The bridge is trustless."

The current Foundation implementation includes a permissioned relay and hub bridge layer.

Do say:

> "GenLayer provides the decentralized judgment layer; the current bridge provides asynchronous cross-chain delivery; the destination adapter provides least-privilege enforcement."

---

# 9. Is today's cross-chain pause a consensus-authenticated action?

## Precise answer

**No — not in the strongest cryptographic meaning of that phrase.**

It is better described as:

> **a GenLayer-consensus-decided action delivered through a trusted/permissioned relay and LayerZero transport to a constrained destination adapter.**

GenLayer consensus authenticates the decision **inside GenLayer's consensus process**.

The destination chain does not, from the checked sources, independently verify a cryptographic proof that:

```text
"this exact GenLayer consensus result is final"
```

Instead, the destination trusts the bridge configuration and cross-chain transport.

This distinction is fundamental and should be preserved in every security document and judge-facing architecture slide.

---

# 10. Strongest argument for building it anyway

The important value proposition survives the trust caveat.

A conventional external-chain keeper has to answer:

```text
Who decided the protocol should pause?
```

Interlock can answer:

```text
A GenLayer Intelligent Contract evaluated pinned evidence,
validators independently assessed the decision under the
contract's equivalence rule, the result finalized under
Optimistic Democracy, and a least-privilege adapter delivered
only the pre-authorized emergency-stop action.
```

Even though transport is currently relayed, the **decision authority** can still be decentralized and auditable.

That is a meaningful improvement over:

```text
one monitoring server
   ↓
private key
   ↓
pause()
```

The security claim just has to stop where the evidence stops.

---

# 11. Strongest counterargument / skeptic steelman

The skeptical judge's strongest argument is:

> "You have not eliminated the trusted oracle. You have moved the trusted boundary from a single keeper to a GenLayer judgment process plus a bridge/relay stack. If the relay can censor, delay, or alter which GenLayer outbox messages get delivered, then your emergency-stop system still depends on an off-chain operator. If the destination chain cannot verify GenLayer finality itself, why should the destination protocol trust that the message really came from the consensus result rather than from a compromised bridge deployment?"

That argument is serious.

A second skeptical argument is operational:

> "For a safety system, asynchronous bridging may be too slow during a fast exploit. A cross-chain pause that arrives after the attacker has drained the protocol is not useful merely because its authorization path is elegant."

A third:

> "If the adapter can only call `pause()`, the blast radius is small — but if the pause role itself exists only in a protocol's emergency architecture and no realistic protocol is willing to grant it cross-chain authority, the product has no adoption path."

These are the conditions under which v3 would not be worth building.

---

# 12. Open problems ranked by risk

## 1. Destination authentication / bridge trust — CRITICAL

The biggest unresolved issue is not message transport. It is the absence of a verified cryptographic path from GenLayer finality to the destination adapter.

Current state: **relay + hub + LayerZero**, not a GenLayer light-client/proof verifier.

Why it matters: this determines whether Interlock is a decentralized security primitive or a sophisticated trusted bridge/oracle.

## 2. Emergency-response latency — HIGH

The path is asynchronous and currently requires polling plus multiple transactions.

Why it matters: a breaker is only valuable if it can react before economically meaningful damage occurs.

Mitigation for MVP: demonstrate a low-latency path on Base Sepolia and measure:

```text
GenLayer finalization → relay detection → hub tx → destination execution
```

Do not claim a latency SLA before measuring it.

## 3. External-chain evidence integrity — HIGH

RPC-based evidence is powerful but not cryptographic.

A validator can fail to obtain the right block/event or query stale/forked data.

Mitigation: pin a finalized block number/hash and compare a closed, typed evidence object under strict equivalence.

## 4. Relay liveness / censorship — HIGH

The current bridge depends on an off-chain relay service.

A malicious or offline relay can delay transport.

Mitigation: redundant independently operated relays would improve liveness, but **I did not verify a Foundation-provided multi-relay consensus mechanism in the checked sources**, so that must be treated as a deployment design, not a current GenLayer primitive.

## 5. Protocol integration / pause semantics — MEDIUM-HIGH

Not every DeFi protocol exposes a simple pauser role.

The feasibility of Interlock therefore depends on finding real protocols whose emergency architecture can grant a narrowly scoped cross-chain pause authority without accidentally giving the adapter broader administrative power.

This should be validated per protocol before promising "Aave support" or naming another production deployment.

---

# 13. Prior art

## 13.1 GenLayer Foundation — Bridge Boilerplate

URL:
https://github.com/genlayer-foundation/genlayer-studio-bridge-boilerplate

Why it matters: this is the closest direct prior art. It already implements GenLayer Intelligent Contracts producing arbitrary byte messages that are relayed through zkSync and LayerZero to external EVM chains.

## 13.2 GenLayer Foundation — Opening GenLayer to All Blockchains

URL:
https://genlayer.com/blog/opening-genlayer-to-all-blockchains

Why it matters: the Foundation explicitly positions GenLayer as a cross-chain "Resolution Layer" and documents the current relay-based bridge model plus the intended future native relay architecture.

## 13.3 GenLayer Foundation — Internet Court

URL:
https://github.com/genlayer-foundation/internetcourt

Why it matters: real GenLayer + Base architecture where a GenLayer Intelligent Contract performs an AI-jury decision and returns the verdict to Base via LayerZero. The repository describes Base as the escrow chain and GenLayer as the AI-jury chain.

Important limitation: this is **not an emergency pause design** and the repository itself identifies the bridge integration and fallback behavior as areas requiring care. It is proof of cross-chain AI adjudication, not proof of cryptographically verified GenLayer-finality-to-Base enforcement.

## 13.4 LayerZero V2 OApp standard

URL:
https://docs.layerzero.network/v2/developers/evm/oapp/overview

Why it matters: demonstrates the standard cross-chain pattern where a verified inbound message can execute arbitrary destination-chain state changes. The receiver pattern specifically authenticates the Endpoint and registered source peer.

## 13.5 Wormhole VAA model

URL:
https://docs.wormhole.com/protocol/infrastructure/vaas/

Why it matters: useful comparison for what a stronger cryptographic cross-chain attestation model looks like. Wormhole describes Guardian signatures forming a VAA that the target chain verifies.

This is a comparison, not a statement that GenLayer currently uses Wormhole's model.

---

# 14. What would a stronger future architecture look like?

The current limitation suggests a clear future hardening path:

```text
GenLayer consensus finality
          |
          | proof / attestation
          v
Destination-chain verifier
          |
          | "GenLayer decision X is finalized"
          v
Interlock Adapter
          |
          | fixed pause()
          v
Protocol
```

That verifier would need a real, checkable proof/attestation format and a destination-chain verifier contract.

**This is not a shipped GenLayer feature I verified in the current docs. It is therefore a future research/build item, not a current capability claim.**

The important engineering decision is whether that additional cryptographic layer is necessary for the intended threat model. For a hackathon demonstration, the current bridge + least-privilege adapter may be enough to demonstrate the concept. For production security guarantees around billions of dollars, the relay/attestation boundary becomes much harder to ignore.

---

# 15. Practical v3 MVP recommendation

## Build / validate only this flow

```text
1. Pick one external EVM testnet protocol with a real pause/guardian role.

2. Deploy Interlock Adapter on that external chain.

3. Grant the adapter ONLY pause authority.

4. Deploy Interlock Intelligent Contract on GenLayer.

5. Read a pinned finalized block/event from the target chain via RPC.

6. Validators independently fetch the same pinned evidence.

7. Use a closed enum result:
      SAFE | TRIP

8. Require GenLayer transaction finalization.

9. Emit exactly one TRIP bridge message.

10. Relay through the Foundation bridge.

11. LayerZero authenticates the destination path.

12. Adapter verifies source/peer/nonce/expiry and calls pause().

13. Adapter exposes no unpause and no arbitrary call.
```

## Do not build in v3 MVP

```text
- arbitrary cross-chain contract calls
- token movement
- treasury movement
- upgrade execution
- AI-generated calldata
- "latest" external-state queries
- mutable evidence URLs without a pinned block/snapshot
- a custom cryptographic GenLayer light client unless separately researched
```

---

# 16. Final recommendation

## Recommendation: BUILD v3, but change the security narrative

The technical feasibility question is now answered positively:

> **GenLayer can participate in a real cross-chain circuit breaker for a protocol deployed on another EVM chain today, using the Foundation's current bridge infrastructure.**

But the security claim must be narrower than a pure cross-chain consensus bridge.

The architecture today is best characterized as:

```text
Decentralized decision
        +
Pinned external evidence
        +
GenLayer finality
        +
Permissioned bridge relay
        +
LayerZero transport/security
        +
Least-privilege destination adapter
```

That is still a strong and novel architecture for Interlock.

The right pitch is **not**:

> "GenLayer replaces the bridge and directly controls Aave."

The right pitch is:

> **"Interlock turns GenLayer's decentralized judgment into a narrowly scoped emergency authority for protocols that remain on their native chains."**

And the strongest security statement is:

> **"The destination adapter can only pause the protected protocol. GenLayer decides when to issue the TRIP; the current bridge transports that decision asynchronously; LayerZero authenticates the configured cross-chain path; the adapter independently enforces the least-privilege action boundary."**

That is technically grounded in the sources checked.

---

# 17. Sources actually checked

## Primary GenLayer / Foundation

1. GenLayer — Opening GenLayer to All Blockchains  
   https://genlayer.com/blog/opening-genlayer-to-all-blockchains

2. Foundation bridge boilerplate — README  
   https://github.com/genlayer-foundation/genlayer-studio-bridge-boilerplate/blob/main/README.md

3. Foundation bridge — Intelligent Contract StringSender  
   https://github.com/genlayer-foundation/genlayer-studio-bridge-boilerplate/blob/main/example/intelligent-contracts/StringSender.py

4. Foundation bridge — GenLayer→EVM relay  
   https://github.com/genlayer-foundation/genlayer-studio-bridge-boilerplate/blob/main/service/src/relay/GenLayerToEvm.ts

5. Foundation bridge — BridgeForwarder.sol  
   https://github.com/genlayer-foundation/genlayer-studio-bridge-boilerplate/blob/main/smart-contracts/contracts/BridgeForwarder.sol

6. Foundation bridge — BridgeReceiver.sol  
   https://github.com/genlayer-foundation/genlayer-studio-bridge-boilerplate/blob/main/smart-contracts/contracts/BridgeReceiver.sol

7. Foundation bridge — destination interface  
   https://github.com/genlayer-foundation/genlayer-studio-bridge-boilerplate/blob/main/example/smart-contracts/contracts/interfaces/IGenLayerBridgeReceiver.sol

8. Foundation bridge — example destination receiver  
   https://github.com/genlayer-foundation/genlayer-studio-bridge-boilerplate/blob/main/example/smart-contracts/contracts/StringReceiver.sol

9. GenLayer Docs — Networks  
   https://docs.genlayer.com/developers/networks

10. GenLayer Docs — Messages / Ghost Contracts  
    https://docs.genlayer.com/developers/intelligent-contracts/features/messages

11. GenLayer Docs — Equivalence Principle  
    https://docs.genlayer.com/developers/intelligent-contracts/equivalence-principle

12. GenLayer Docs — Finality  
    https://docs.genlayer.com/understand-genlayer-protocol/core-concepts/optimistic-democracy/finality

13. GenLayer Docs — How GenLayer Works  
    https://docs.genlayer.com/understand-genlayer-protocol/optimistic-democracy-how-genlayer-works

14. GenLayer Docs — Reading Data  
    https://docs.genlayer.com/developers/decentralized-applications/reading-data

15. Foundation — Internet Court architecture  
    https://github.com/genlayer-foundation/internetcourt/blob/main/ARCHITECTURE.md

## LayerZero primary documentation

16. LayerZero — OApp Quickstart / receiver authentication  
    https://docs.layerzero.network/v2/developers/evm/oapp/overview

17. LayerZero — Protocol Contracts Overview  
    https://docs.layerzero.network/v2/developers/evm/protocol-contracts-overview

18. LayerZero — OApp Technical Reference  
    https://docs.layerzero.network/v2/concepts/technical-reference/oapp-reference

19. LayerZero — Technical API / nonce and payload tracking  
    https://docs.layerzero.network/v2/developers/evm/technical-reference/api

20. LayerZero — Endpoint deployments  
    https://docs.layerzero.network/v2/developers/evm/technical-reference/endpoints

21. LayerZero — Base Sepolia / network configuration examples  
    https://docs.layerzero.network/v2/get-started/create-lz-oapp/adding-networks

22. LayerZero — Ethereum Mainnet deployment  
    https://docs.layerzero.network/v2/deployments/chains/ethereum

23. LayerZero — Ethereum Sepolia deployment  
    https://docs.layerzero.network/v2/deployments/chains/sepolia

24. LayerZero — Arbitrum Sepolia deployment  
    https://docs.layerzero.network/v2/deployments/chains/arbitrum-sepolia

## Comparison / prior-art source

25. Wormhole — Verified Action Approvals (VAAs)  
    https://docs.wormhole.com/protocol/infrastructure/vaas/

---

# 18. Sources / capabilities expected but NOT verified

The following were deliberately left unclaimed because I did not find sufficient primary-source evidence in the checked GenLayer material:

1. **A native GenLayer LayerZero Endpoint directly implemented as part of GenLayer Chain** — not found.

2. **A destination-chain smart contract that cryptographically verifies GenLayer consensus finality via a shipped GenLayer proof/attestation format** — not found.

3. **A GenLayer light client deployed on Ethereum/Base that verifies GenLayer block headers/state roots** — not found.

4. **A zk proof verifier proving a GenLayer Intelligent Contract final state to an arbitrary external EVM chain** — not found.

5. **A live Foundation-operated production/mainnet relay that removes the off-chain relay dependency today** — not found; the Foundation's current article instead says native relaying is for mainnet/future and the present builder flow uses a deployed off-chain service.

6. **A Foundation-published list proving that every LayerZero-supported chain is currently configured as a GenLayer bridge destination** — not found.

7. **A published GenLayer bridge EID for GenLayer itself as a LayerZero endpoint** — not found because the checked architecture does not expose GenLayer itself as the LayerZero endpoint.

8. **A Foundation guarantee of permissionless/redundant relay execution today** — not found. The checked boilerplate uses a configured `CALLER_ROLE` on the hub forwarder.

---

# 19. Bottom line in one sentence

> **Interlock v3 is technically feasible today as a cross-chain, relay-mediated emergency breaker: GenLayer can perform the decentralized external-evidence judgment and emit the decision, the Foundation's current bridge can carry arbitrary bytes to an external EVM chain, and a least-privilege LayerZero-compatible adapter can execute only `pause()` there — but today's path should be described as trusted-relay/bridge-mediated enforcement, not as a destination chain independently cryptographically authenticating GenLayer finality.**
