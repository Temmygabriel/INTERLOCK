# Interlock — Final Build Spec (GenLayer Agent Tank)

**Track:** Autonomous Protocols. **Name: Interlock — locked, do not rename.**
**Build window:** now through 2026-09-17 15:30 UTC (submissions close, hard deadline).

**Technical source of truth for all API names/signatures:** the `genlayer-dev` skill
files already in this project (`write-contract.md`, `genlayer-cli.md`,
`genvm-lint.md`, `direct-tests.md`, `integration-tests.md`). **Do not use any API name
from an external research file that isn't confirmed in these skill files** — a prior
research pass claimed a set of renamed function names that turned out to be false when
checked against the live docs. If a name in this spec ever conflicts with what's
actually installed, run the `dir()` check in `write-contract.md` and trust the
installed package.

---

## 1. The pitch, unmodified — use this exact sentence at the top of the README

> **An autonomous circuit breaker that pauses a DeFi protocol the moment an exploit is
> independently proven by GenLayer's validator consensus — and whose rulebook makes it
> structurally incapable of ever moving a single token.**

**Real audience:** lending protocols and cross-chain bridges, who today must choose
between a slow multisig/DAO vote (safe, too slow) or a single admin pause key (fast,
too centralized). Interlock is fast **and** accountable.

---

## 2. What's actually being built

**Generalize the code, specialize the story.** The contract is written so a second
bounded action (beyond pause) is a config change, not a rewrite. But the entire demo,
README, and pitch show **exactly one power: pause.** Do not market this as a general
framework — that reads as vague to a reviewer. Show one product, one verb.

### MVP scope
- A `Constitution`: a frozen, unchangeable set of rules stored at deploy time —
  what's allowed to happen (`pause`) and what can never happen (no ownership change,
  no treasury access, no changing the constitution itself, no unpause without a
  separate human governance path).
- A permissionless `report_exploit(evidence_ref, deposit)` entry point: anyone can
  submit a reference to evidence (a pinned block number / tx hash on the target EVM
  chain), backed by a small bond.
- A two-stage verification: a **deterministic, pinned read** of the referenced
  on-chain data, then an **independent LLM judgment** on whether that verified data
  matches an exploit pattern — validators re-derive the judgment themselves, they
  never just check the leader's formatting.
- A **deterministic guard** that enforces the constitution's bounds regardless of what
  the LLM/consensus layer concludes — this is plain Python, no AI involved, and it is
  what makes "pause" the only possible outcome.
- `pause()` fires automatically on confirmed consensus. **`unpause()` is not callable
  by this contract's own logic** — it requires a separate, explicitly human governance
  action. This is the core safety sentence for the pitch: *the machine may only ever
  apply the brake; releasing it stays with the protocol's own governance.*

### Explicitly out of scope for the hackathon build
- Actually adjusting fees, quorum, or other parameters — that's the generalizable
  *capability*, not the demo. One line under "extending this" in the README is enough.
- Real mainnet funds. Build and demo entirely on Testnet Asimov (chain ID 4221, free
  faucet) or GenLayer Studio (hosted, gasless) — no real money needed anywhere.

---

## 3. Architecture

Evidence and a deposit come in from outside the contract. Inside, three regions handle
it in order: **Storage** holds the frozen constitution rules; **Judgment** does a
pinned deterministic read of the evidence plus an independent AI vote on what it
means; **Guard and action** enforces that pause is the only possible outcome,
regardless of what Judgment concluded. The only thing that can ever leave the contract
is a pause event.

---

## 4. Technical implementation (verified names only)

Use the patterns from `write-contract.md` exactly:

- Contract class: `gl.Contract` subclass, storage fields as typed dataclass-style
  attributes (`TreeMap`/`DynArray` for collections — never raw `dict`/`list`).
- **Pinned deterministic read** (the on-chain evidence check): use
  `gl.eq_principle.strict_eq(fn)` — exact match required, since this is checking real
  chain data at a specific block, not an LLM judgment. This is the part any ordinary
  oracle could do — it's necessary but not sufficient.
- **The judgment call** (does this verified data prove an exploit): use the custom
  leader/validator pattern from `write-contract.md` — the validator function must
  **independently re-derive** the answer from the same pinned source data, never just
  check that the leader's output is well-formatted. This is the part that's genuinely
  load-bearing for GenLayer — a single trusted API call could not make this judgment.
- Run `genvm-lint check` after every edit to the contract, before writing tests —
  catches forbidden imports, non-deterministic patterns, and SDK misuse early.
- Fast logic tests in direct mode (`direct-tests.md`) — mock the web/LLM calls, test
  the guard's bounds-enforcement and access control exhaustively here, since this is
  cheap and fast to iterate on.
- Full consensus tests (`integration-tests.md`) against Studio or `testnet_asimov` —
  this is the only way to actually prove the validator jury independently agrees,
  which is the single most important thing to demonstrate for this hackathon.

---

## 5. Security and anti-gaming rules — non-negotiable

These come from GenLayer's own official prompt-injection guidance plus independent
security analysis, and they converged from more than one research pass — trust these
specifically, unlike the disproven API claims above.

1. **Never pass raw submitted evidence text into an LLM prompt.** The submission is a
   block number / tx hash reference only. The contract fetches and structures the
   actual on-chain data itself; the LLM only ever sees that structured, verified data.
2. **Constrain LLM output to a closed enum** (e.g. `EXPLOIT_CONFIRMED` /
   `NOT_CONFIRMED`), never open text used to drive logic.
3. **Pin evidence to an exact block number or tx hash** — never "current state." This
   guarantees the leader and every validator are looking at the identical, immutable
   data, and prevents timing games.
4. **Require a bond on `report_exploit`.** Slashed if judged false, refunded (or
   rewarded) if judged genuine — this is what stops spam/griefing submissions from
   costing nothing.
5. **The guard is the final word, not the LLM.** No matter how confident the AI
   judgment is, the deterministic guard is what actually decides whether `pause()` can
   fire, and it enforces nothing outside the constitution's frozen bounds.
6. **Be explicit and honest about who sets the constitution.** State plainly in the
   README that the constitution is fixed at deployment for this hackathon build, and
   that a production version would need a disclosed governance/bootstrap process for
   setting it — naming this trust boundary is a credibility gain, not a weakness to
   hide.
7. **Ship no setter for anything in the constitution.** Immutability by the absence of
   code, not by a permission check that could be bypassed.

### Chaos/security demo cases to actually show, not just claim

- A valid exploit report → consensus agrees → `pause()` fires.
- A report with evidence that doesn't actually support an exploit → validators
  disagree/reject → no pause.
- A report attempting to reference unpinned/"current" state → rejected before judgment.
- A report submitted without the required bond → never enters the workflow at all.
- An attempt to call anything other than `pause()` → blocked by the guard regardless
  of what any upstream logic concluded.

---

## 6. Build plan (today through Sept 17)

| Phase | Work | Done when |
|---|---|---|
| **Environment check** | Run the `dir()` check from `write-contract.md` against the installed SDK. Deploy a hello-world contract to Studio, then Testnet Asimov. Fund the account from the faucet. | A real deployed address exists and you've confirmed actual API names. |
| **Constitution + guard** | Write the frozen constitution storage and the deterministic guard. No AI yet. | Guard rejects every action except `pause()`, provably, in a direct-mode test. |
| **Pinned evidence read** | `report_exploit` + `strict_eq` deterministic check against a real pinned block. | Same input gives byte-identical results every run. |
| **Judgment layer** | Wire the custom leader/validator judgment call. Deliberately construct a case where the validator disagrees, and confirm it's rejected, not waved through. | Both agree and disagree paths observed in a real integration test. |
| **End to end on Asimov** | Full trip: submit real evidence referencing a real pinned block → consensus → `pause()` fires on a real deployed target contract. | The target contract's paused state changes, caused only by consensus. |
| **Submit early** | Public repo, README with the pitch at the top, project application filled in. Don't wait for a perfect build — submit something real now and keep editing. | Entry is live and can start collecting attention. |
| **Harden** | Add the chaos/security demo cases above as real tests, not just claims. | Every rule in section 5 has a test that fails if the rule is removed. |
| **Demo video** | Record the short (see below). | Uploaded, plain language, shows the real trip. |
| **Final polish** | Re-read the README against sections 1, 2, and 5 of this spec — make sure every claim in it is something the demo actually shows. | Nothing in the README overstates what the build does. |

---

## 7. Demo video — what to actually show

1. State the problem in one sentence: multisig votes are safe but slow; admin keys are
   fast but centralized.
2. Show the constitution — plainly, so a viewer can see what's allowed and what never
   changes.
3. Submit real evidence referencing a real pinned block on a real target contract.
4. Show the independent AI judgment happening — not just a spinner, actually show that
   more than one validator is voting.
5. Show the target contract's state changing to paused, caused by consensus, on a
   real GenLayer explorer link.
6. Close on the one sentence: the machine can only ever apply the brake.

---

## 8. Submission checklist

- [ ] Public GitHub repository (the one hard requirement)
- [ ] README leads with the exact pitch sentence from section 1
- [ ] Deployed contract address on a GenLayer explorer (Asimov, Bradbury, or Studio)
- [ ] GenLayer Studio import link, if easy to produce — lets a reviewer run it without
      cloning
- [ ] Short demo video, plain language, showing the real trip end to end
- [ ] Project application explicitly answers: who this is for, what GenLayer decides
      that nothing else can, exactly how consensus is used (name the equivalence
      principle for each check), the security section from this spec, and what is
      honestly still trusted (the constitution-setting process)
- [ ] Nothing in the README or application describes a capability that isn't actually
      demonstrated in the linked repo/video
