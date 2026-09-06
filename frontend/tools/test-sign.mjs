// PROOF (run: node frontend/tools/test-sign.mjs)
//
// Proves the browser-signing path end to end on live studionet:
//   1. The JS wire codec decodes real reads identically to the Python SDK.
//   2. A brand-new keypair (the kind MetaMask / a browser identity produce)
//      builds the consensus-main addTransaction envelope, signs a standard
//      EIP-155 tx, broadcasts via eth_sendRawTransaction, and a VALUE-BEARING
//      write (a 7-unit report bond) EXECUTES through real validator consensus —
//      i.e. the exact artifact a MetaMask signature would produce is accepted
//      and acted on by the chain.
//
// The live pair is the DEPLOY CARD pair (see PROGRESS.md). It reports audit
// op_index 0 (a healthy guardian_update, coverage 142%) as if it were an
// exploit, so consensus must answer NOT_CONFIRMED: no pause, bond forfeited.
// That exercises a full LLM judgment round over a browser-signed transaction.
//
// Historical note: earlier attempts CANCELED because the addTransaction ABI was
// hand-written with a 6th _validUntil param (selector 0xe71d5196); studionet's
// consensus-main addTransaction has FIVE params (selector 0x27241a99), so the
// payload was undecodable and the tx targeted consensus-main itself.

globalThis.ethers = await import("ethers");
const { Wallet } = globalThis.ethers;

const { read } = await import("../gen.js");
const { sendWrite } = await import("../tx.js");

const INTERLOCK = "0x2fB65F934618a17320c288d684aaB97dC00Ac300";
const VAULT = "0xCCB1fa65e9A85023324ccaA7aa44959b5BA448a7";
const BOND = 7n;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hr = () => console.log("-".repeat(64));

async function waitUntil(fn, what, ms = 300_000, step = 8000) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > deadline) throw new Error("timeout: " + what);
    await sleep(step);
  }
}

const reporter = Wallet.createRandom();

console.log(hr());
console.log("STEP 0 — wire codec vs live state (must match Python SDK reads)");
const st0 = await read(INTERLOCK, "status");
const cov = await read(VAULT, "coverage");
const alen = await read(VAULT, "audit_len");
console.log("status.report_count:", st0.report_count?.toString());
console.log("status.tripped:     ", st0.tripped);
console.log("vault.coverage:     ", cov?.toString());
console.log("vault.audit_len:    ", alen?.toString());
if (cov !== 142n) throw new Error("codec read mismatch: coverage != 142");
if (alen !== 1n) throw new Error("codec read mismatch: audit_len != 1");
const before = Number(st0.report_count ?? 0n);

console.log(hr());
console.log("STEP 1 — MetaMask-parity signer (brand-new key, like a MetaMask account)");
console.log("reporter (browser/MetaMask-style key):", reporter.address);

console.log(hr());
console.log("STEP 2 — sign + broadcast report_exploit(0) with bond", BOND.toString());
console.log("(target interlock " + INTERLOCK + ")");
const txId = await sendWrite(reporter, INTERLOCK, "report_exploit", [0], { value: BOND });
console.log("consensus txId:", txId);

console.log(hr());
console.log("STEP 3 — wait for real validator consensus on the report…");
await waitUntil(async () => {
  const s = await read(INTERLOCK, "status");
  return Number(s.report_count ?? 0n) > before;
}, "report_count to increment");

const st1 = await read(INTERLOCK, "status");
const paused = await read(VAULT, "params");
const incN = await read(INTERLOCK, "get_incident", [before]); // the incident just created
const rb = await read(INTERLOCK, "refundable_of", [reporter.address.toLowerCase()]);
console.log("status.report_count:", st1.report_count?.toString(), "(was", before + ")");
console.log("vault paused:        ", paused.paused);
console.log("new incident.kind:   ", incN.kind, "effect:", incN.effect);
console.log("refundable_of(reporter):", rb?.toString());

console.log(hr());
const ok =
  Number(st1.report_count ?? 0n) > before &&
  paused.paused === false &&
  incN.kind === "FALSE_REPORT_REJECTED" &&
  incN.effect === "noop_false_report" &&
  rb === 0n;
console.log(ok
  ? "PROOF PASSED — a MetaMask-style EIP-155 signature was accepted and a value-bearing\n  write executed through GenLayer consensus (false report rejected, bond forfeited)."
  : "PROOF FAILED — see state above.");
process.exit(ok ? 0 : 1);
