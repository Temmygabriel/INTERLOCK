// qa-studio-write.mjs — prove the BROWSER write path on studio-dev end to end.
//
// run: node frontend/tools/qa-studio-write.mjs [guardAddr] [vaultAddr] [opIndex]
//
// It replicates exactly what frontend/tx.js does for a report:
//   sim_getFeeConfig -> defaultFees -> sim_estimateTransactionFees(fees=defaultFees)
//   -> recommendedPreset -> ABI-encode the v0.6 addTransaction tuple -> sign a
//   legacy gasPrice-0 EIP-155 tx with a fresh ethers.Wallet (like the browser
//   identity) -> eth_sendRawTransaction -> poll contract reads until paused.
//
// The target must be an ALREADY-EXPLOITED pair (coverage < 100%, not yet
// paused). Defaults below are the scratch pair from capture_alloc.py
// (vault 0x2D5E… / guard 0xDA60…, coverage 78%, exploit op 4).
globalThis.ethers = await import("ethers");
const { Wallet } = globalThis.ethers;

const { read } = await import("../gen.js");
const { sendWrite } = await import("../tx.js");

const [guardA = "0xDA605BaA8cc5B4756338d45c58744889abd67126",
       vaultA = "0x2D5EbE8626b715F48c519F88e494Db1E1993CF1b",
       opRaw] = process.argv.slice(2);
const BOND = 7n;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (v) => (v == null ? null : BigInt(v));

console.log("guard ", guardA);
console.log("vault ", vaultA);

const s0 = await read(guardA, "status");
const p0 = await read(vaultA, "params");
console.log("pre: tripped=", s0.tripped, "coverage=", p0.coverage?.toString(), "%", "audit_len=", p0.audit_len?.toString());
if (s0.tripped) { console.log("ALREADY TRIPPED — pick a fresh exploited pair."); process.exit(2); }
if (BigInt(p0.coverage) >= 100n) { console.log("NOT undercollateralized — nothing to report."); process.exit(2); }
const idx = BigInt(opRaw ?? 0) >= 0n && opRaw !== undefined ? BigInt(opRaw) : BigInt(p0.audit_len) - 1n;

const w = Wallet.createRandom();
console.log("reporter", w.address, "reporting op", idx.toString(), "bond", BOND.toString());

const txId = await sendWrite(w, guardA, "report_exploit", [idx], { value: BOND });
console.log("broadcast hash:", txId);

const deadline = Date.now() + 240_000;
for (;;) {
  await sleep(6000);
  const s = await read(guardA, "status").catch(() => null);
  const p = await read(vaultA, "params").catch(() => null);
  const tripped = !!s?.tripped, paused = !!p?.paused;
  const cov = p?.coverage != null ? BigInt(p.coverage).toString() : "?";
  console.log(`poll: tripped=${tripped} paused=${paused} coverage=${cov}% elapsed=${Math.round((Date.now() - deadline + 240_000) / 1000)}s`);
  // apply_pause is an internal message that finalizes a few seconds AFTER the
  // interlock round flips `tripped` — keep polling until the vault is paused.
  if (paused) {
    console.log(tripped && paused ? "PASS — vault paused, interlock tripped" : "PASS — vault paused");
    process.exit(tripped ? 0 : 3);
  }
  if (Date.now() > deadline) { console.log("FAIL — vault not paused within 240s"); process.exit(1); }
}
