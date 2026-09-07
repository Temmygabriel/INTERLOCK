// WATCH-DRIVER (run: node frontend/tools/drive-watch.mjs)
//
// Reproduces EXACTLY what the UI's "Watch it happen" button does, end to end,
// against the live exploit-lab pair (CONFIG.lab) — proving the JS wire path for
// BOTH writes the demo needs: a plain borrow (value 0) and a value-bearing
// report. Steps:
//   1. read the lab vault params;
//   2. if coverage >= 100, borrow `collateral` GEN (permissionless on the demo
//      vault — the missing health check is the exploit) and poll until a new
//      audit entry lands with coverage < 100;
//   3. report that entry to the lab interlock with the min_bond as value;
//   4. poll until the vault pauses or an incident names our reporter.
//
// This spends the lab vault (a confirmed trip pauses it permanently — resume is
// governance-only). Redeploy a fresh lab pair for the next run:
//   python -m pytest tests/integration/test_lab_deploy.py -v -s

globalThis.ethers = await import("ethers");
const { Wallet } = globalThis.ethers;

const { read } = await import("../gen.js");
const { sendWrite } = await import("../tx.js");
const { CONFIG } = await import("../config.js");

if (!CONFIG.lab || !CONFIG.lab.interlock || !CONFIG.lab.vault) {
  console.error("No CONFIG.lab configured — nothing to drive. Deploy the lab pair first.");
  process.exit(2);
}
const INTERLOCK = CONFIG.lab.interlock;
const VAULT = CONFIG.lab.vault;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hr = () => console.log("-".repeat(64));
const num = (v) => Number(v ?? 0n);
const canon = (a) => String(a).toLowerCase();

async function waitUntil(fn, what, ms = 420_000, step = 8000) {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      if (await fn()) return true;
    } catch { /* transient studionet drop — retry */ }
    if (Date.now() > deadline) throw new Error("TIMEOUT: " + what);
    await sleep(step);
  }
}

hr();
console.log("WATCH-DRIVER against the exploit-lab pair");
console.log("  interlock " + INTERLOCK);
console.log("  vault     " + VAULT);

const reporter = Wallet.createRandom(); // a fresh 0-balance key — like the browser identity
console.log("  reporter  " + reporter.address);

const p0 = await read(VAULT, "params");
console.log("  vault is " + (p0.paused ? "PAUSED (spent)" : "live") +
  " · coverage " + num(p0.coverage) + "% · audit_len " + num(p0.audit_len));

if (p0.paused) { console.error("Lab vault already paused — redeploy it."); process.exit(1); }

let idx;
if (num(p0.coverage) >= 100) {
  const len0 = num(p0.audit_len);
  const amount = num(p0.collateral); // debt += collateral ⇒ coverage < 100%
  hr();
  console.log("STEP 1/3 — pushing a risky " + amount + " GEN borrow…");
  const tx1 = await sendWrite(reporter, VAULT, "borrow", [amount], { value: 0 });
  console.log("  borrow broadcast: " + tx1);
  await waitUntil(async () => {
    const p = await read(VAULT, "params");
    return num(p.audit_len) > len0 && num(p.coverage) < 100;
  }, "borrow to settle below 100%");
  const p1 = await read(VAULT, "params");
  idx = num(p1.audit_len) - 1;
  console.log("  borrow landed — coverage now " + num(p1.coverage) + "%, new entry #" + idx);
} else {
  idx = num(p0.audit_len) - 1;
  hr();
  console.log("STEP 1/3 — vault already under 100%; reporting newest entry #" + idx);
}

hr();
const s0 = await read(INTERLOCK, "status");
const bond = BigInt(num(s0.min_bond));
console.log("STEP 2/3 — reporting entry #" + idx + " with a " + bond + "-GEN bond…");
const tx2 = await sendWrite(reporter, INTERLOCK, "report_exploit", [idx], { value: bond });
console.log("  report broadcast: " + tx2);

hr();
console.log("STEP 3/3 — awaiting real validator consensus…");
const beforeCount = num(s0.report_count);
let paused = false;
await waitUntil(async () => {
  const p = await read(VAULT, "params");
  paused = p.paused === true;
  if (paused) return true;
  const s = await read(INTERLOCK, "status");
  return num(s.report_count) > beforeCount;
}, "verdict (report_count bump or pause)");

console.log("  vault paused = " + paused);

// find our incident: newest one matching reporter + op_index
const st = await read(INTERLOCK, "status");
let found = null;
for (let i = 0; i < num(st.incident_count); i++) {
  const inc = await read(INTERLOCK, "get_incident", [i]);
  if (!inc || inc.found === false) continue;
  const rep = await read(INTERLOCK, "get_report", [num(inc.report) - 1]).catch(() => null);
  if (rep && canon(rep.reporter) === canon(reporter.address) && num(rep.op_index) === num(idx)) {
    found = inc; break;
  }
}
hr();
if (found && found.kind === "TRIPPED") {
  console.log("RESULT: EXPLOIT CONFIRMED — vault PAUSED by validator consensus.");
  console.log("  incident #" + num(found.report) + " · op #" + num(found.op_index) +
    " · " + found.effect + " · " + found.time);
  console.log("  This is exactly what the Watch button drives in the UI. The lab vault is now spent.");
  process.exit(0);
} else if (found) {
  console.log("RESULT: FALSE-REPORT/REJECTED — " + (found.reason || found.kind) + " (vault not paused).");
  console.log("  The breaker refused to trip; bond forfeited. Try again on a fresh lab.");
  process.exit(1);
} else {
  console.log("RESULT: no incident matched our reporter within the window.");
  console.log("  vault paused = " + paused + " — check the lab interlock incident log directly.");
  process.exit(1);
}
