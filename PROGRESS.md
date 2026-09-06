# Interlock — PROGRESS (keep current; update + commit on every milestone)

**Deadline:** 2026-09-17 15:30 UTC — GenLayer hackathon, Autonomous Protocols.
**Deploy/test home:** this repo (`github.com/Temmygabriel/INTERLOCK`), cloud GenLayer = studionet (gasless).

## Status: SAFETY PANEL DEPLOY-READY (tasks #12 + #13 done) — a static, Vercel-ready panel in `frontend/`, wired LIVE to the deploy-card pair. Headless-verified (Edge): RUNNING @ 142% coverage, browser identity auto-created (chip filled), all incidents rendered, connecting-placeholder cleared. QA caught + fixed one real bug: `identity.js` built Wallets as `new eth().Wallet(k)` (constructing the arrow helper) → now `new (eth().Wallet)(k)`. Next: user deploys `frontend` on Vercel to view it, then #9 README + #14 optional real-MetaMask signer.

## Task list
- [x] #1 Environment check (CLI, genvm-lint, gltest, networks)
- [x] #2 Scaffold (contracts/, tests/, .gitignore, gltest.config.yaml; initial commit pushed 7dc3975)
- [x] #3 Frozen Constitution storage + deterministic guard  (interlock.py)
- [x] #4 DemoVault target + pause path                      (demo_vault.py)
- [x] #5 Pinned deterministic evidence read in report_exploit (interlock.py; on-chain read, NOT strict_eq — see design note below)
- [x] #6 Judgment layer: independent validator re-derivation (interlock.py run_nondet_unsafe)
- [x] #7 Guard → pause on consensus; bond refund/forfeit    (interlock.py)
- [x] #8 Chaos/security demo tests (one per build-spec section-5 rule)  — DONE
- [x] #10 Diagnose MetaMask signing + prove ethers/browser sign path live  — DONE (see frontend section below)
- [x] #11 JS GenLayer wire module (read + sign + broadcast) — DONE (`frontend/gen.js`, `frontend/tx.js`)
- [x] #12 Safety-panel UI (interlock-design-spec.md) + live demo wiring  — DONE (static, Vercel-deployable: `frontend/index.html` + `style.css` + `app.js`)
- [x] #13 Identity chip (browser keypair default + MetaMask display-only; NOT branded "Aegis")  — DONE (`frontend/identity.js`; auto-created signer chip in header)
- [ ] #14 Optional real MetaMask signer mode + test
- [ ] #9 README (pitch leads verbatim) + deploy/submission artifacts  ← NEXT after UI

## Frontend / browser-signing — PROVEN live (task #10, #11)
- Files: `frontend/gen.js` (GenLayer typed wire codec + RLP envelope + reads), `frontend/tx.js` (consensus-main addTransaction builder + legacy sign + broadcast), `frontend/tools/test-sign.mjs` (end-to-end proof, `node frontend/tools/test-sign.mjs`). ethers v6 in `frontend/package.json` for Node tooling only (browser loads UMD from CDN).
- **DEPLOY CARD live pair:** interlock `0x2fB65F934618a17320c288d684aaB97dC00Ac300`, vault `0xCCB1fa65e9A85023324ccaA7aa44959b5BA448a7`. Deployed 2026-09-05 by `tests/integration/test_deploy_card.py`; state persists on studionet (report_count now 3 from proof runs; all FALSE_REPORT_REJECTED; vault never paused).
- **Root cause of every earlier CANCELED/UNDETERMINED write — WRONG addTransaction ABI.** A GenLayer write is a normal EVM tx to consensus-main `0xb7278A61aa25c888815aFC32Ad3cC52fF24fE575` whose `data` ABI-calls addTransaction(sender, recipient, validators, rotations, _calldata). studionet's addTransaction has **FIVE params → selector `0x27241a99`**. A hand-written 6-param signature incl. `_validUntil` gives selector `0xe71d5196`; consensus-main then cannot decode `_recipient`, treats the tx as targeting itself (`recipient` = consensus-main in the record), never credits value (`value_credited:false`), and the write CANCELED / went UNDETERMINED. Fixed in `frontend/tx.js`; the SDK only appends validUntil when its ABI has ≥6 params (studionet has 5).
- **Tx shape that settles:** legacy type-0 EIP-155, `gasPrice: 0`, `gas: 500000`, `to` = consensus-main, `value` = bond, `chainId 61999`. (A type-2/1559 envelope is accepted at the EVM layer but the ledger won't credit value.) SDK `_prepare_transaction` signs this legacy shape even on studionet.
- **No account funding needed** — studionet value is virtual/cosmetic; a brand-new random key (0-balance, never seen) settles bonded writes. `value_credited:true` on the record.
- Full proof log (2026-09-06): STEP 0 codec reads match Python; fresh key `0x046A16eBE…` → `sendWrite(report_exploit, [0], {value:7})` → `consensus txId` → report_count 2→3 → vault not paused → incident `FALSE_REPORT_REJECTED/noop_false_report` → `refundable_of(reporter)==0`.

## Safety-panel UI — DEPLOY-READY (tasks #12 + #13, 2026-09-06)
- **Files** (static, no build step): `frontend/index.html`, `frontend/style.css` (design-spec tokens: housing #26282B / face #3A3D40 / running #3B8B4A / tripped #C23B2E / hazard-yellow stripes only / readout #E7E4DC; Archivo Black + IBM Plex Mono), `frontend/app.js`, `frontend/identity.js`. Reuses `gen.js`/`tx.js`. ethers v6 UMD from cdnjs loaded before the ESM modules (tx.js reads `globalThis.ethers`).
- **Deploy to Vercel:** create project from repo root, Framework Preset = Other, **Root Directory = `frontend`** (or drag the `frontend` folder as a standalone static project). HTTPS required (RPC fetch + clipboard). No env vars. The panel hardcodes the DEPLOY CARD pair (interlock `0x2fB6…c300`, vault `0xCCB1…8a7`) at the top of `app.js` — swap the two consts to point at any vault + guard.
- **What it shows (all real, nothing fabricated):** status lamp RUNNING/CHECKING/TRIPPED + note; TARGET + guardian/armed; COVERAGE % meter (100% solvency mark; red < 100%); supplied/debt; LAST CHECK; reports & incidents counters; MIN BOND; a report unit (choose a pinned **audit entry index** — evidence is never typed in, only an index; the panel previews the pinned entry from `get_audit_entry`); the verdict checklist marks only verifiable phases (pinned read ✓ → broadcast tx ✓ → "validator consensus — awaiting verdict" with a live elapsed counter); the outcome is the real incident (FALSE REPORT — REJECTED, bond forfeited, or EXPLOIT CONFIRMED → TRIPPED). Reset plate: always "LOCKED · GOVERNANCE ONLY"; on a confirmed trip the red plate slides across (500ms) — the one animated moment, plus the light flip. `prefers-reduced-motion` skips both. Incident log = flat list, newest last-12.
- **Honest-state choices:** studionet does not stream mid-flight validator votes, so the design-spec "vote chips landing one at a time" is rendered as a real phase checklist instead — no fabricated per-vote chips. If the RPC is unreachable on first load the panel says OFFLINE (it never claims RUNNING without a live read); later network errors keep the last-known state and flag the netline.
- **Identity chip (task #13):** header chip + popover. Browser-keypair default: on first visit the panel auto-creates a key in localStorage (filled green dot = present) and labels it clearly; the popover offers reveal/copy key, import-existing, regenerate, remove; a line states the key never leaves the browser. MetaMask is **display-only** (never asked to sign) and only appears if the wallet is detected. NOT branded Aegis — the aegis doc is only the reference pattern.
- **QA (headless Edge against the live pair):** rendered RUNNING @ 142%, 3/3 incidents, identity chip created, connecting placeholder cleared. **Real bug found + fixed:** `identity.js` originally built wallets as `new eth().Wallet(k)` where `eth` is an arrow helper → `TypeError: eth is not a constructor` swallowed by `catch{}` → `loadIdentity()` always null → chip "no identity". Fixed via `new (eth().Wallet)(k)`. Caught only because a headless DOM dump showed the chip empty while every RPC value rendered.

## Test suite — 18 green (last full run 2026-09-05)
- `tests/direct/` (16) — deterministic VM, no network, fast (~1s): `test_demo_vault.py` (11) + `test_interlock_isolated.py` (5). Rule-level security asserts: false report forfeits bond & never escrows; no refund path for forfeited bond; no constitution setter; VERDICT enum only; guard fail-shut; second withdraw reverts.
- `tests/integration/test_interlock_flow.py` (2 live, ~7 min vs real studionet consensus) on a shared module-scope pair:
  1. **Healthy op reported → NOT_CONFIRMED**, vault stays live, incident FALSE_REPORT_REJECTED/noop_false_report, `refundable_of(liar)==0` (bond forfeited). PASSES.
  2. **Undercollateralized borrow (66% coverage) reported → EXPLOIT_CONFIRMED**: vault paused (apply_pause child), incident TRIPPED, honest reporter escrowed BOND_VALUE; paused vault rejects new borrow; redundant 2nd report of same exploit → noop_already_paused but still refunds liar; withdraw clears escrow (`refundable_of==0`) and a 2nd withdraw reverts. PASSES.
- Bootstrap: vault owner arms the breaker — `vault.set_guardian(interlock)` after both deploys (solves the vault↔interlock circular frozen anchor; the vault may be re-wired by its own governance; Interlock's rulebook is the immutable one). `set_guardian` is owner-only, allowed only while vault is live, recorded on the audit log Interlock reads.

## Contracts (both lint: 3 checks pass)
- `contracts/demo_vault.py` — DemoVault: immutable `audit` JSON log; owner(governance)=resume, guardian(Interlock)=apply_pause; genesis 57 collateral/40 debt = 142% coverage; `borrow` intentionally has NO health check (the exploit); deposit/borrow/withdraw/apply_pause/resume/set_guardian; views params/coverage/audit_len/get_audit_entry.
- `contracts/interlock.py` — frozen constitution in `__init__` (no setter anywhere); `report_exploit(op_index)` `@write.payable`, bond=msg.value, only an integer index accepted (never raw text); deterministic pinned read of vault audit entry → judge prompt → `run_nondet_unsafe(classify, validate)` where validate re-runs the full classification and compares only the closed enum EXPLOIT_CONFIRMED / NOT_CONFIRMED; guard maps verdict→hardcoded effect (apply_pause / noop_already_paused / noop_false_report); genuine→refundable escrow, false→bond forfeited; **escrow keys canonicalized** (`_canon_addr`/`_canon_str`, lowercase 0x-hex) so client lookups match on-chain keys (real product bug caught by integration testing); `withdraw_bond` refunds own escrow via emit_transfer. Views: status/constitution_view/incidents/reports/refundable_of.

## Design note — pinned read
Inter-contract calls are FORBIDDEN inside nondet blocks (linter-enforced). Evidence is the vault's own committed on-chain audit entry at the pinned index — a deterministic read every validator replays identically ⇒ inherently consensus-pinned, so NO `gl.eq_principle.strict_eq` wrapper (strict_eq is for off-chain/external sources). Documented in constitution manifest.

## studionet verified facts (drive the RAW client; full list in Claude memory `genlayer-verified-apis.md`)
- Gasless + virtual value (writes + value-bearing pays work from 0-balance accounts; `value_credited`). Reachable at https://studio.genlayer.com/api.
- gltest config loads ONLY via the pytest plugin from cwd `gltest.config.yaml` — a standalone `get_gl_client()` fails.
- High-level typed `Contract` object needs schema fetch = **localnet-only** → on studionet drive raw `GenLayerClient`; Address args must be `CalldataAddress(raw_20_bytes)` (hex str becomes Python str; Address slots reject it).
- `emit_transfer` to a plain EOA **cannot settle on studionet** — its virtual value ledger only knows deployed contracts → child errors `"Contract 0x… not found"`. Contract logic is correct; the withdraw test asserts the parent escrow clear + that the transfer child WAS emitted, not the child's EOA settlement (production GenLayer settles natively). Documented in `_helpers.finalize_parent`.
- Hosted RPC drops connections mid-request (ConnectionResetError 10054 / SSL alert). Every RPC — submit AND the receipt polls inside `wait_for_transaction_receipt` — is retried with backoff in `_helpers._retry` (all ops keyed by tx hash/address ⇒ idempotent re-polls). **Remove the temp diagnostic file pattern** — use `finalize_parent` + read-back instead.

## Environment gotchas (Windows)
- PATH: add `C:\Users\USER\AppData\Roaming\Python\Python314\Scripts`.
- `export PYTHONUTF8=1` before `genvm-lint` (prints ✓/✗; crashes cp1252 otherwise).
- NEVER `genvm-lint check/validate` (SDK re-extraction; disk is 99% full, ~3GB free). Use `lint` only.
- Push: `GIT_TERMINAL_PROMPT=0 git -c credential.interactive=never push -u origin main`.
