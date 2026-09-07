// cadence-check.mjs — does the page's real polling pattern (one tick every 8s,
// status + params reads) stay stable against studionet? Virtual-time-budget QA
// bursts requests and rate-limits; this reproduces REAL browser pacing.
globalThis.ethers = await import("ethers");
const { read } = await import("../gen.js");
const { CONFIG } = await import("../config.js");
const L = CONFIG.lab;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = 0, fail = 0;
for (let i = 0; i < 4; i++) {
  try {
    const s = await read(L.interlock, "status");
    const v = await read(L.vault, "params");
    const armed = String(v.guardian).toLowerCase() === String(L.interlock).toLowerCase();
    console.log(`tick ${i + 1}: OK  status.tripped=${s.tripped} vault.paused=${v.paused} coverage=${v.coverage}% armed=${armed}`);
    ok++;
  } catch (e) {
    console.log(`tick ${i + 1}: FAIL ${String(e?.message ?? e).slice(0, 70)}`);
    fail++;
  }
  if (i < 3) await sleep(8000); // real poll cadence
}
console.log(`RESULT ${ok} ok / ${fail} fail`);
process.exit(fail ? 1 : 0);
