# Interlock

> **An autonomous circuit breaker that pauses a DeFi protocol the moment an exploit is
> independently proven by GenLayer's validator consensus — and whose rulebook makes it
> structurally incapable of ever moving a single token.**

**Track:** Autonomous Protocols · **Live demo:** https://interlock-three.vercel.app/

Lending protocols and cross-chain bridges face a bad choice when they are being drained:
a multisig or DAO vote is safe but far too slow, and a single admin pause key is fast but
re-centralizes the exact thing the protocol was built to decentralize. Interlock is the
third option — **fast and accountable**. Anyone may file a bonded report about a specific,
already-committed on-chain state. GenLayer validators independently re-derive whether that
state is an exploit. If consensus confirms it, the protocol's brake is applied
automatically, on another chain, with no human in the loop.

The contract can pause. It cannot do anything else. That is enforced by construction, not
by policy.

---

## 1. Why this is not "an AI that can pause things"

Two design choices do the real work, and both are testable in this repo.

**The decision is pinned to committed chain state, never to a reporter's words.** A report
does not carry evidence — it carries an *index*. `report_exploit(op_index)` resolves that
index against the target contract's own immutable audit log, read deterministically from
finalized storage. Every validator replays byte-identical evidence from genesis. There is
no prompt-injection surface because **no human-authored text ever reaches the model**; the
only thing the model sees is a JSON object that the chain itself produced.

**The model's verdict cannot become an action on its own.** Consensus produces one value
from a closed two-value enum — `EXPLOIT_CONFIRMED` or `NOT_CONFIRMED`. A deterministic
guard, plain Python with no AI involved, is the only code that can act on it, and it is a
total function over exactly two inputs. There is no other code path to the bridge sender,
the escrow, or the target. If validators disagree, the VM terminates and nothing
downstream runs — **the breaker fails shut, not open.**

---

## 2. The live path

The far end of this pipeline is a real DeFi vault on Base Sepolia that really does get
paused. Nothing in the diagram below is simulated.

```
  anyone                     GenLayer (studio-dev, chain 61997)              zkSync Era Sepolia       Base Sepolia
    │                                    │                                        │                      │
    │  report_exploit(idx) + bond        │                                        │                      │
    ├───────────────────────────────────►│                                        │                      │
    │                                    │ 1. PINNED READ                         │                      │
    │                                    │    target.get_audit_entry(idx)         │                      │
    │                                    │    ── deterministic, replayed ──       │                      │
    │                                    │                                        │                      │
    │                                    │ 2. JUDGMENT  (custom validator)        │                      │
    │                                    │    each validator RE-RUNS the          │                      │
    │                                    │    classification and compares         │                      │
    │                                    │    only the closed-enum verdict        │                      │
    │                                    │                                        │                      │
    │                                    │ 3. DETERMINISTIC GUARD                 │                      │
    │                                    │    CONFIRMED  ──► emit TRIP            │                      │
    │                                    │    REJECTED   ──► noop_false_report    │                      │
    │                                    │                                        │                      │
    │                                    │ BridgeSender.send_message(eid 40245)   │                      │
    │                                    ├───────────────────────────────────────►│                      │
    │                                    │                                        │ BridgeForwarder     │
    │                                    │                                        │ .callRemoteArbitrary │
    │                                    │                                        ├─────────────────────►│
    │                                    │                                        │   LayerZero V2       │
    │                                    │                                        │                      │ BaseTripDispatcher
    │                                    │                                        │                      │     .lzReceive
    │                                    │                                        │                      │        │
    │                                    │                                        │                      │ BaseDemoVault
    │                                    │                                        │                      │ .processBridgeMessage
    │                                    │                                        │                      │   ("TRIP") → paused = true
```

**Deployed and linked**

| Role | Chain | Address |
|---|---|---|
| `interlock_v3` (the breaker) | GenLayer studio-dev | `0x198b4f9D7d226a59592a17dc39c8D4Af15f3c0Bb` |
| `demo_vault` (judged target) | GenLayer studio-dev | `0x35ce13653edd7862348A4cAF446F53ECC2654049` |
| `BridgeSender` (outbox) | GenLayer studio-dev | `0xDf6041aC7Cf024F7903867C4Fcc8391Cf37fec4E` |
| `BridgeForwarder` | zkSync Era Sepolia | [`0x1567e63787e0fE93653dfe0cC1eaEf554EB237A5`](https://sepolia.explorer.zksync.io/address/0x1567e63787e0fE93653dfe0cC1eaEf554EB237A5) |
| `BaseTripDispatcher` | Base Sepolia | [`0x1567e63787e0fE93653dfe0cC1eaEf554EB237A5`](https://sepolia.basescan.org/address/0x1567e63787e0fE93653dfe0cC1eaEf554EB237A5) |
| `BaseDemoVault` (the victim) | Base Sepolia | [`0xCF3EfC03eb49F36f7a806FD39eDcDD3Db8EaB567`](https://sepolia.basescan.org/address/0xCF3EfC03eb49F36f7a806FD39eDcDD3Db8EaB567) |

> The zkSync forwarder and the Base dispatcher share an address because both were deployed
> by the same deployer at the same nonce — they are different contracts on different
> chains, not a typo.

---

## 3. How consensus is actually used

**Equivalence rule: a custom validator function via `gl.vm.run_nondet(leader, validator)`.**

This was chosen over `strict_eq` (which would be wrong — two LLM runs of the same
classification are not bit-identical) and over `prompt_comparative` (which is a
convenience wrapper around exactly this, with less control). The contract needs an explicit
rule about *which fields must match*, so it writes the validator directly.

The rule, in full:

| Stage | What happens | Why it is safe |
|---|---|---|
| **Pinned read** | `target_vault.get_audit_entry(op_index)` — a cross-contract read of finalized storage | Deterministic. Every validator replays the identical bytes, so the evidence needs no equivalence rule at all. Cross-contract calls are legal here precisely because this is *not* inside a non-deterministic block. |
| **Leader** | `gl.nondet.exec_prompt(prompt, response_format="json")` over the pinned JSON, normalized to a closed enum | The prompt is built by deterministic code from chain data. No reporter-supplied text is ever interpolated into it. |
| **Validator** | **Re-runs the entire classification independently** over the same evidence. Compares only `verdict`. | This is the part that matters. The validator does *not* check that the leader's JSON is well-formed, that the reason string is non-empty, or that the enum is in range — all of which would trust the leader's substantive answer 100%. It derives its own answer and compares. |
| **Disagreement** | `run_nondet` terminates the VM | No code after it runs. No bond is escrowed, no message is emitted, no state changes. The guard fails shut. |

Malformed model output raises an `[LLM_ERROR]` and the validator turns it into
disagreement — forcing a consensus retry, never a one-sided verdict. Deterministic
business errors (`[EXPECTED]`) are compared by exact string equality, so two validators
that both correctly reject a bad index agree rather than spinning.

---

## 4. Why it can never move a token

This is the claim the pitch rests on, so it is worth being precise about the mechanism
rather than the intention.

1. **The constitution is frozen at deploy time.** The effect set is storage written in
   `__init__` and never written again. There is no method anywhere in the contract that
   mutates it. A reviewer can confirm this by reading `interlock_v3.py` for writes to the
   constitution fields — there are none.

2. **Verdict → effect is a closed mapping.** The only reachable effects are `send_trip`,
   `noop_already_tripped`, and `noop_false_report`. Exactly one of them touches the bridge
   sender, and it emits a payload that is ABI-encoded from the literal string `"TRIP"`.

3. **The destination accepts nothing else.** `BaseDemoVault.processBridgeMessage` decodes
   the payload and accepts **only** the exact tag `"TRIP"`. This is deliberately not a
   generic arbitrary-call: the payload can never name a function, an amount, or a
   recipient.

4. **The dispatcher only talks to a whitelisted target.** `BaseTripDispatcher` requires
   `trustedTargets[localContract]`, so a message cannot be redirected at an arbitrary
   contract even by a compromised relay.

5. **There is no unpause path.** `unpause` is not callable by this contract's own logic —
   not by the owner, not by consensus, not by a validator. Releasing the brake requires a
   separate human governance action on the target. *The machine may only ever apply the
   brake.*

**About the one value transfer that does exist.** An earlier draft of this file claimed the
contract has no transfer primitive at all. That was wrong, and the correction is worth
stating precisely rather than quietly fixing. The contract has exactly **one** value-moving
statement — `gl.contract.get_at(sender).emit_transfer(due, on="finalized")`, inside
`withdraw_bond()` — and it returns a reporter's **own** escrowed bond to that **same**
reporter. That is the whole of it:

- The recipient is always the sender of the withdrawal, looked up by their own address.
  There is no parameter naming a recipient, so no third party can be paid.
- It is funded from exactly one storage map, `refundable[reporter]`, which has exactly one
  write site: the branch that handles a **confirmed** verdict.
- A **false** report creates no `refundable` entry, so the bond is simply **locked** — it is
  not swept to the owner, a treasury, or anywhere else. No code path can ever return a
  forfeited bond.

So the precise claim is narrower than "no transfer call", but it is the one that matters:
the contract can return a reporter's own money to that reporter, and it has no code path
that can send value — of the protocol's or of anyone else's — to any other party. It holds
no position in the target protocol, has no approval call, and has no arbitrary-call
primitive. "Structurally incapable of moving a token" means *the target's* tokens, and that
is a statement about the absence of those code paths, checkable by reading the file.

---

## 5. Security

| Threat | Mitigation |
|---|---|
| **Prompt injection via evidence** | Structurally impossible: reporters submit an *index*, not text. The model only ever sees a JSON object built by deterministic code from finalized chain storage. |
| **Griefing / spam reports** | A bond is required and is **slashed on `noop_false_report`**. Filing junk costs the reporter real value. |
| **Leader-model misbehaviour** | The validator re-derives independently. A malformed or hallucinated verdict becomes disagreement, which terminates the VM rather than being accepted. |
| **A validator that just rubber-stamps** | The comparison is on the closed-enum verdict derived by a full re-run — not on formatting, length, or schema validity. |
| **Replay / double-trip** | `interlock_v3` is one-shot (`noop_already_tripped`); `BaseDemoVault.trip()` is guarded by `if (!paused)`; the forwarder keeps a `usedTxHash` guard and the relay checks `isHashUsed()` per message. Overlapping relay runs are safe. |
| **Relay sends garbage to Base** | The relay validates target EID, target contract, envelope `localContract`, and a canonical `"TRIP"` payload before sending. Anything else is skipped. Even a fully malicious relay cannot reach a non-whitelisted target — the dispatcher reverts `UntrustedTarget`. |
| **Consensus layer concludes something absurd** | The deterministic guard is downstream of consensus and independent of it. It does not consult the model; it maps an enum to an effect. |

---

## 6. What is honestly still trusted

An honest system description names its trusted components. Interlock currently has two.

**1. The relay hop is trusted, not consensus-authenticated.** The GenLayer→EVM delivery is
performed by a relay job that reads the `BridgeSender` outbox and forwards messages over
LayerZero V2. There is **no independent finality proof binding the outbound EVM message to
GenLayer validator consensus** — the destination chain trusts this relay to faithfully
forward a message that really came from a confirmed verdict. If the relay stops running, a
genuine GenLayer-side trip never reaches Base Sepolia. Closing this would mean an on-chain
light client or a signed-consensus-attestation verifier on the destination chain. That is
the single largest upgrade this design needs, and it is not implemented.

**2. The constitution is set at deploy time by the deployer.** The rulebook cannot be
changed afterwards, which is the property that matters — but *who chose the initial rules*
is a deployment-time trust assumption. For a hackathon build the deployer is a single key.
The credible production path is community/governance ratification of the constitution
before deployment, after which the same immutability applies.

**Latency, stated plainly.** The relay runs on a schedule that polls the outbox roughly
every 20 seconds for about 5 minutes per run, and consecutive runs overlap, so a message
is normally picked up within tens of seconds. It is not instant, GitHub Actions can delay
scheduled runs under load, and schedules are disabled after 60 days of repository
inactivity. Treat end-to-end delivery as **~20 seconds to a few minutes**.

---

## 7. What is proven, and what is not

This section exists because a demo that exaggerates is worse than a smaller honest one.

**Proven, observed, with the transactions to show for it**

- The **full live cross-chain path**, end to end: GenLayer consensus confirmed a real
  exploit → TRIP emitted → relayed over LayerZero → `BaseDemoVault.paused == true` on Base
  Sepolia. LayerZero delivery tx `0xe4494091…`.
- The **browser path**: the page's "file a bonded report" button drives a real signed
  write from a browser identity, real validator consensus (~10 s), a real trip. Verified
  twice against throwaway trios, including a regression test holding the page open for
  75 s after the verdict.
- The **same-chain build's judgment and guard layers**: `tests/direct/` (16 tests,
  deterministic VM, no network) plus `tests/integration/` (2 tests against real GenLayer
  consensus on studionet) — the live pair includes a genuine confirmed exploit that really
  called `apply_pause`, and a benign report that was correctly rejected with the bond
  forfeited. Full suite: 18 green.

**Written and partially exercised — do not read the untested half as working**

- `deploy-v3-genlayer.yml` and `reset-v3-demo.yml` have never been run in CI. All four
  workflows parse as YAML and every `run:` block passes `bash -n`, but static validation is
  not execution. The reset path (`resume()` + fresh trio) has never been executed as a unit.
- `relay-v3.yml` has run in CI, but only its no-op path: a real run read the manifest,
  polled the outbox nine times, and exited 0 on an empty outbox. A run that actually
  forwards a message has never happened.

**Two known current gaps.**

1. **The relay's CI *send* path has never fired.** The relay is scheduled (`*/5`, plus
   manual dispatch) and its empty-outbox path is CI-proven. But no run has ever executed a
   real `callRemoteArbitrary` from a GitHub runner — that hop has been proven only from a
   laptop (tx `0x8e176d73…`). Proving it means a controlled trip through CI, which consumes
   the current GenLayer trio and trips+resumes the shared Base vault, so it is not done
   casually.

2. **The deployed page's same-chain section is currently inert.** Its lab pair is populated
   only by explicit env vars and deliberately does not fall back to the v3 addresses, so
   `lab` is `null` in the current build and the section renders its deploy-card state rather
   than a live instrument. The same-chain build was proven on **studionet**; re-verifying the
   ported contracts on **studio-dev** (the network the cross-chain stack runs on) is still
   outstanding.

---

## 8. The same-chain build

The cross-chain pipeline above generalizes the original same-chain contract, which is kept
in `intelligent-contracts/` and still passes its suite. Same judgment layer, same guard,
same one-shot brake — but the target is a `DemoVault` on GenLayer itself instead of a vault
on Base Sepolia, and the only effect is a direct `apply_pause` call with no bridge in the
path. It is the smaller, easier-to-audit version of the same idea, and it is what the
"extending this" claim rests on: adding a *second* bounded action is a constitution and
target change, not a rewrite of the judgment or guard layers.

It is also the part of this project with the deepest test coverage — `tests/direct/` runs
the guard rules against a deterministic in-process VM (16 tests: false report forfeits the
bond and never escrows, no refund path exists for a forfeited bond, no constitution setter
exists, the verdict enum is closed, the guard fails shut, a second withdraw reverts), and
`tests/integration/` runs two full flows against real GenLayer consensus. See §7 for what
is and is not currently live on the deployed page.

---

## 9. Repository layout

```
intelligent-contracts/       the same-chain build (contract + deployment tooling)
frontend/                    the demo page — cross-chain panel leads, same-chain below
  demo-manifest.json           single source of truth for every v3 address
  build.mjs                    bakes the manifest into dist/config.js at build time
v3-crosschain/
  genlayer/                  interlock_v3.py, demo_vault.py, and the operator scripts
    scripts/deploy_v3_studio.py    fresh GenLayer trio, linked to the Base vault
    scripts/arm_v3_demo.py         pins a real exploit entry and writes the manifest
    scripts/relay_ci.py            the relay hop (polls the outbox, forwards)
    scripts/resume_base_vault.py   re-arms BaseDemoVault in place for a reset
  base/                      BaseDemoVault, BaseTripDispatcher, their tests
  boilerplate/               vendored GenLayer bridge boilerplate (BridgeSender, forwarder)
.github/workflows/           deploy-v3-evm.yml (works); relay/reset workflows (see §7)
```

**Re-arming the demo.** `interlock_v3` is deliberately one-shot — there is no un-trip, so
a reset means a fresh GenLayer trio. The Base vault, by contrast, is re-armed *in place*
with `resume()`, which leaves the previous round's trip evidence on the audit log where a
verifier can still see it.

---

## 10. Further reading

- `interlock-build-spec.md` — the specification this was built against
- `SUBMISSION-ANSWERS.md` — copy-paste answers for the application form, drawn from this
  README so the repo and the form never disagree
- `PROGRESS.md` / `PROGRESS-v3.md` — the engineering logs, including failure modes and
  bugs found by testing, kept because the record of what broke is more useful than a
  claim that nothing did
