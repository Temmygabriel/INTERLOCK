# Interlock v3 — Cross-Chain Circuit Breaker: Feasibility Investigation

**Status:** RESEARCH-ONLY. Produces a document and a verdict, never a diff.
**Branch:** `research-crosschain` (docs-only, based on pre-v2 `main` — deliberately
kept away from the UI build on `design-v2` and from `main`).
**Companion file:** [`GPT-investigation-prompt.md`](./GPT-investigation-prompt.md) —
a ready-to-paste, source-disciplined prompt for a second, independent investigation.
**Date:** 2026-09-07.

> Scope note (unchanged): the v2 design spec declares cross-chain **out of scope
> for the hackathon build** and this repo's demo stays same-chain. This file exists
> to answer one question honestly: *could* an Interlock-style, consensus-judged
> breaker protect a protocol living on *another* chain — and what would it take?
> The answer informs exactly one README line today and a possible v3 roadmap later.

---

## 1. Executive verdict (my synthesis)

1. **Feasible to *demonstrate* today on testnets — not yet *trust-minimized*.** GenLayer
   has a **general (arbitrary-bytes, not token-only) LayerZero V2 bridge path**
   GL → other EVM chains via a **ZKsync Era hub**, and it can carry a `TRIP` message
   to an adapter contract. A studionet → Base-Sepolia proof is realistic.
2. **The dominant gap is message authenticity, not transport.** GenLayer is **not
   itself a LayerZero endpoint**. An intelligent contract writes to an on-chain
   outbox; an **off-chain relay service** (today the *only* permitted submitter) then
   calls the hub's `BridgeForwarder.callRemoteArbitrary(...)`. There is **no inclusion
   proof binding the outbound message to validator consensus**, so today that relay/hub
   operator could forge a GenLayer-sourced `TRIP`. Same-chain Interlock never has this
   problem — the consensus-validated contract *itself* executes `apply_pause`.
3. **Verifiable finality of the GenLayer ledger on chain X is not shipped.** The ledger
   is ZK-Stack-based (per GenLayer docs), so a zkSync-style validity proof / light client
   over `ConsensusMain` state is *architecturally plausible* but does not exist today,
   and studionet is a dev testnet.
4. **Reading chain-X state *into* consensus is the most credible leg** — but it is
   web-oracle nondeterminism (validators independently `gl.nondet.web`-fetch a pinned
   chain-X block and compare), strictly weaker than the current deterministic same-chain
   cross-contract read, and it needs independent/censorship-resistant RPCs.
5. **Latency economics is an open question** — LLM consensus round + appeal window +
   relay + chain-X finality vs. how fast an attacker drains. A pause that lands after
   the money is gone proves nothing.

**Bottom line:** cross-chain is a *credible v3 direction* built on GenLayer's own
bridge, and the pattern is validated by prior art (InternetCourt moves GenLayer jury
verdicts to Base over the same bridge). But shipping it as a real Interlock claim would
require solving proof-of-consensus delivery — a serious protocol-level problem, not a
wrapper. It must **not** go in the hackathon README's core pitch.

---

## 2. The four questions, answered (sources in §5)

### Q1 — Does GenLayer offer generalized cross-chain messaging?
**Yes — general message passing, not token-only.** GenLayer's bridge "uses standard
byte payloads, so it works with any dApp logic"; hub-and-spoke with **ZKsync Era as the
relay hub** and other chains as spokes (endpoint IDs e.g. ZKsync Era Sepolia 40305,
Base Sepolia 40245). The flow: intelligent contract calls `BridgeSender.send_message`
(an outbox on the GenLayer EVM ledger) → the Node **relay** polls
`get_message_hashes()` / `get_message()` → calls
`BridgeForwarder.quoteCallRemoteArbitrary()` / `callRemoteArbitrary()` on the ZKsync
hub → LayerZero delivers to `BridgeReceiver` on the destination chain →
`processBridgeMessage()` dispatches. Security today is **authorized relayers** ("the
only ones permitted to submit messages…"), explicitly temporary: "When mainnet
launches, relaying becomes native to the protocol." Transport is not LZ-locked
(Axelar / Hyperlane / CCIP / IBC named as drop-in).

### Q2 — Can another chain cryptographically verify a GenLayer verdict?
- The GenLayer EVM ledger **is verifiable in principle**: "GenLayer Chain is an
  EVM-compatible chain built with the ZK Stack" and "inherits its rollup settlement
  properties from its ZK Stack and Ethereum configuration." No light client or
  proof-posting is described or shipped.
- **No validator signature/attestation scheme** over finalized verdicts is exposed;
  consensus steps are ordinary chain transactions.
- Honest model today: **relayer/oracle**. A watcher reads `ConsensusMain`/IC state;
  the target-chain adapter can only verify what the bridge (relay + LayerZero peers)
  tells it.
- Doc warning that matters: an IC transaction reaches **protocol finality only after
  the consensus decision and appeal window complete** — a cross-chain sender must not
  act on the enclosing EVM receipt alone.

### Q3 — Minimal safe adapter on chain X
- Role split: the protocol grants the adapter a **`PAUSE_ROLE` only** (mirror of
  Interlock's "cannot move tokens"); the adapter is a **one-way latch**: a single
  `trip(evidenceRef, targetBlock)` → `protocol.pause()`, then latched; it has **no
  unpause** (chain-X governance/timelock recovers) and cannot move value or make
  arbitrary calls.
- Authentication on the LayerZero path is the OApp standard: only the LZ Endpoint can
  invoke; the adapter whitelists the delivering `BridgeReceiver` as
  `peers[srcEid]`. Replay/staleness handled by LZ's per-(src,dst) nonce plus an
  adapter-side freshness window on `targetBlock`.
- **Who relays / pays:** the off-chain bridge service pays LZ fees quoted on the hub.
- **Residual risk to state plainly:** without a consensus inclusion proof (Q1/Q2), a
  compromised relay or hub controller can forge trips — the adapter cannot distinguish
  a genuine finalized verdict. That must be a stated trust assumption, not hidden.

### Q4 — Reading chain-X state into consensus
- Feasible and consistent with GenLayer design: contracts fetch URLs via
  `gl.nondet.web.*` inside a nondeterministic block wrapped in an equivalence
  principle; GenLayer's own docs treat **blockchain RPC responses as stable/canonical**
  → `strict_eq` over a pinned finalized chain-X block is the natural rule
  (leader + validators fetch the same `eth_getBlockByNumber`/`eth_getLogs` JSON and
  compare). Error paths → `gl.UserError` → validators Disagree.
- Honest caveats: validators need **independent, uncensored RPCs** (an RPC split biases
  the jury); latency/rate limits multiply; the verdict must name the exact chain-X
  block it judged; it is web-oracle nondeterminism — weaker than the same-chain read
  (though the exploit classification itself is already an LLM nondeterministic step).

---

## 3. Recommended v3 architecture (honest-trust version)

```
 Chain X (Base / ETH / L2)                  GenLayer (ledger, ConsensusMain finality)
┌────────────────────────────┐             ┌────────────────────────────────────────┐
│ Protocol (X)               │             │ Interlock IC (GenVM)                    │
│   pause() ← PAUSE_ROLE     │             │  1. nondet-fetch pinned ChainX block    │
│        ▲                   │ grants      │  2. LLM classify → closed enum           │
│        │ trip() only       ├─PAUSE_ROLE─▶│  3. validator re-derives, equivalence   │
│  AdapterX (one-way latch,  │             │  4. EXPLOIT_CONFIRMED ⇒                  │
│   no value, no unpause)    │             │     BridgeSender.send_message(          │
│        ▲                   │             │        dstEid, adapterX, TRIP(blockRef)) │
└────────┼───────────────────┘             └────────────────────┬───────────────────┘
         │ LZ V2 Endpoint → BridgeReceiver → AdapterX           │ outbox (EVM ledger)
         │ (endpoint-only auth; peers[dstEid]=BridgeReceiver)   │
         │       ▲                                              │ poll get_message()
         │       │ callRemoteArbitrary(+fee)                    ▼
         ▼       └────────────────────────  ZKsync Era HUB: BridgeForwarder  ◀── relay
```

**What changes vs. same-chain Interlock (why it is NOT a wrapper):**
same-chain, the pause is executed *by the very contract consensus validated*;
cross-chain, an untrusted transport sits between the verdict and the action.

---

## 4. Open problems, ranked by risk
1. **No consensus→message inclusion proof.** Relay/hub can forge a `TRIP`. Needs
   native relaying with an on-chain proof that the message came from a finalized
   consensus transaction, or a ZK light client of the GenLayer ledger on chain X.
2. **No shipped verifiable finality for the GenLayer ledger** (ZK-Stack proofs/light
   client not yet present; studionet is a dev net). Today a cross-chain trip is a
   trusted-bridge/oracle trip, not a cryptographic one.
3. **Cross-chain state reads are web-oracle nondeterminism** — RPC independence,
   split-RPC censorship risk, per-validator latency/rate limits, block-pinning.
4. **Adapter surface** — who grants `PAUSE_ROLE` on chain X; governance/timelock
   unpause path; key-compromise analysis; one-trip-per-incident + freshness window.
5. **Latency economics** — consensus round + relay + chain-X finality vs. drain speed.

## 5. Sources
- GenLayer bridge blog: *Opening GenLayer to All Blockchains* — https://genlayer.com/blog/opening-genlayer-to-all-blockchains
- Bridge reference: genlayer-studio-bridge-boilerplate — https://github.com/genlayer-foundation/genlayer-studio-bridge-boilerplate
- Rollup integration (ZK-Stack EVM ledger): https://docs.genlayer.com/understand-genlayer-protocol/core-concepts/rollup-integration
- Optimistic Democracy / how GenLayer works (consensus as chain tx; appeal window): https://docs.genlayer.com/understand-genlayer-protocol/optimistic-democracy-how-genlayer-works
- FAQ (IC finality vs EVM receipt): https://docs.genlayer.com/faq
- Web access (gl.nondet.web + equivalence): https://docs.genlayer.com/developers/intelligent-contracts/features/web-access
- Equivalence principle: https://sdk.genlayer.com/v0.3.x/overview/key-concepts.html
- LayerZero OApp standard (endpoint-only auth, peer checks): https://docs.layerzero.network/v2/concepts/applications/oapp-standard
- LayerZero EVM OApp overview: https://docs.layerzero.network/v2/developers/evm/oapp/overview
- Cross-chain pause pattern guide: https://chainscorelabs.com/guides/smart-contract-development/cross-chain-smart-contract-security/how-to-implement-a-cross-chain-pause-mechanism
- Arbitrum escape hatch vs LZ pause (protocol circuit-breaker prior art): https://chainscorelabs.com/comparisons/bridges-trustless-vs-trusted-architectures/failure-recovery/arbitrum-escape-hatch-vs-layerzero-pause

## 6. Prior art worth citing if this ever ships
- **InternetCourt** (genlayer-foundation) — a GenLayer AI-jury verdict moving a Base
  escrow over the same LayerZero V2 bridge; the closest working pattern to Interlock v3.
  https://github.com/genlayer-foundation/internetcourt/blob/main/ARCHITECTURE.md
- GenLayer bridge boilerplate (above).
- Stargate/Security-Council style pause, per the chainscorelabs prior-art page.

## 7. What this changes in the repo today
- **Nothing in contracts or frontend.** This is a document.
- Suggested README line (when README task #9 is written) — keep it to one sourced
  sentence, e.g.: *"Interlock is same-chain on GenLayer today. GenLayer's own
  LayerZero-based bridge already carries arbitrary messages to other chains (see
  research/crosschain-investigation.md), so a cross-chain adapter is a real, if
  future, direction — but delivering a pause whose authenticity is bound to validator
  consensus is still an open protocol problem, and we don't claim it."*
