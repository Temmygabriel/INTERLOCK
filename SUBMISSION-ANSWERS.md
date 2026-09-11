# Interlock — submission application answers

Copy-paste source for the hackathon application form. Each answer is drawn
verbatim (or condensed) from the README so the repo and the form never
disagree. Deadline: 2026-09-17 15:30 UTC.

---

## 1. Who is it for?

DeFi protocols that need a *kill-switch with no human in the loop*. Today a
protocol pauses via a multisig or an admin key — a single point of capture, a
person you can lobby or hack, and a decision that can be quietly reverted.
Interlock replaces that with a breaker that acts on **independently proven
evidence**: when GenLayer's validator network confirms an exploit, the pause
happens on its own. It is not an AI guardrail that "recommends" — it is a
circuit breaker wired to consensus, so the verdict that pauses the protocol is
the same verdict a court of validators would arrive at, not one operator's
judgment.

## 2. What does GenLayer decide?

Exactly one thing, and nothing else. GenLayer's validator consensus decides
whether a reported exploit is **real**:

- A visitor files a report with a bond against a pinned exploit entry in the
  target contract's audit log.
- The contract re-reads the evidence itself (it never trusts the reporter's
  claim) and classifies it against its frozen constitution.
- Validators independently re-derive the classification; consensus is reached
  only when they agree on the closed verdict — `EXPLOIT_CONFIRMED` or
  `NOT_CONFIRMED`.
- A confirmed verdict trips the breaker: a `TRIP` message is emitted to the
  bridge outbox, and a relay carries it to the target protocol on Base
  Sepolia, where it pauses.

GenLayer never holds, moves, or controls the target protocol's tokens. It
decides a question of fact and produces one bit of effect: `paused = true`.

## 3. Equivalence principles

The judgment layer is built on a **custom validator, not a single AI answer**.
Inside `report_exploit` the contract runs the classification twice under
GenLayer's equivalence rule:

1. **Leader** produces a verdict from the re-read evidence.
2. **Validator re-runs the full classification independently** and compares only
   the closed enum (`EXPLOIT_CONFIRMED` / `NOT_CONFIRMED`), *not* free-form
   reasoning. The validator cannot be satisfied by the leader having formatted
   its answer correctly — it must arrive at the same substantive verdict.

This is the "independent re-derivation" property: consensus binds only the
verdict that matters, and no single LLM call is ever trusted on its own. The
constitution itself is written exactly once, at deployment, with no setter.

## 4. Security section

- **The contract cannot move a token.** It holds no authority over the target
  vault's funds. Its single value-transfer primitive is the bond escrow, and
  that transfers a reporter's *own* bond back to the *same* reporter after a
  confirmed verdict — there is exactly one write site for the refundable
  amount, in the confirmed-verdict branch, and a false report has no refund
  path at all (its bond is locked forever).
- **One-shot breaker.** Once tripped there is no un-trip and no admin path back
  to an actionable state. A breaker you can quietly un-trip is not a breaker.
- **Closed verdict enum.** Only `EXPLOIT_CONFIRMED` / `NOT_CONFIRMED` can be
  stored; a re-derivation that disagrees cannot record a trip.
- **Replay-proofed trip.** `interlock_v3` is one-shot; the target vault's
  `trip()` is guarded by `if (!paused)`; the forwarder keeps a `usedTxHash`
  guard; the relay checks `isHashUsed()` per message. Overlapping relay runs
  are safe.
- **Relay is constrained even if malicious.** It validates target EID, target
  contract, envelope `localContract`, and a canonical `"TRIP"` payload before
  sending; the dispatcher reverts `UntrustedTarget` for anything else. A fully
  malicious relay cannot reach a non-whitelisted target.
- **Pinned runner.** The contract pins an exact GenVM runner version at
  deployment; `test`/`latest` aliases never reach a network.

## 5. What is still trusted? (honest disclosure)

- **The relay hop.** GenLayer→EVM delivery is performed by a scheduled relay
  job that reads the `BridgeSender` outbox and forwards messages. The
  destination chain trusts it to faithfully forward a message that really came
  from confirmed consensus; there is no independent finality proof binding the
  outbound message to the verdict. This is disclosed in the README's trust
  model and never claimed as consensus-authenticated.
- **Deploy-time constitution.** The rules are set once, at deployment, by the
  deployer. They are immutable afterward, but they are a deploy-time trust
  input.
- **Latency.** The relay runs on a schedule that polls the outbox roughly every
  20 seconds; GitHub may delay scheduled runs under load. Effective latency is
  "~20 seconds to a few minutes", never instant.
- **Testnet scope.** The live demo runs on studio-dev, zkSync Era Sepolia, and
  Base Sepolia — no real funds, no mainnet authority.
