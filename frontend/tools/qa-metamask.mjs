// QA — MetaMask request shape + chain-ensure sequencing (run: node frontend/tools/qa-metamask.mjs)
//
// Offline proof, no network, no wallet. Verifies the two things that determine
// whether MetaMask signs a studionet report cleanly:
//   1. metaMaskRequest() produces the EXACT JSON-RPC tx object handed to
//      eth_sendTransaction: an explicit LEGACY type-0x0 tx with gasPrice 0x0,
//      a fixed hex gas, hex nonce/value, and NO chainId (so MetaMask signs for
//      whatever network ensureStudionet selected). Nothing is left for MetaMask
//      to re-estimate or re-type — the failure mode that made it ask for a fee.
//   2. ensureStudionet() adds+selects studionet (chainId 0xF22F) in the right
//      order: switch -> (4902) -> add -> switch. If the chain is missing and we
//      signed anyway, MetaMask cannot reason about the zero fee.
// Plus: the ethers.Wallet signTransaction branch in tx.js is asserted byte-for-
// byte unchanged (the browser-identity path has its own live e2e proof,
// tools/test-sign.mjs, and must not move).

import assert from "node:assert/strict";

globalThis.ethers = await import("ethers");

const { metaMaskRequest, ensureStudionet, STUDIONET_CHAIN } = await import("../tx.js");
const fs = await import("node:fs");
const path = await import("node:path");

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log("  ok  — " + name); }
  catch (e) { failures++; console.log("  FAIL — " + name + "\n        " + e.message); }
};
const hr = () => console.log("-".repeat(64));

console.log("qa-metamask: offline MetaMask request shape + chain sequencing");
hr();

// ---------------------------------------------------------------- 1 · request shape
check("metaMaskRequest is a legacy type-0 tx with hex fields only", () => {
  const req = metaMaskRequest(
    {
      to: "0xb7278A61aa25c888815aFC32Ad3cC52fF24fE575",
      data: "0x27241a99000000000000000000000000",
      value: 7n,
      nonce: 3n,
      gasLimit: 500_000n,
      gasPrice: 0n,
    },
    "0x046A16eBE9B5AF83aA0F8e7C8178b6E0b56d441f",
  );
  assert.equal(req.type, "0x0", "type must be explicit legacy 0x0");
  assert.equal(req.from, "0x046A16eBE9B5AF83aA0F8e7C8178b6E0b56d441f", "from passthrough");
  assert.equal(req.to, "0xb7278A61aa25c888815aFC32Ad3cC52fF24fE575", "to passthrough");
  assert.equal(req.data, "0x27241a99000000000000000000000000", "data passthrough");
  assert.equal(req.nonce, "0x3", "nonce hex-encoded");
  assert.equal(req.gas, "0x7a120", "gas hex = 0x7a120 (500000)");
  assert.equal(req.gasPrice, "0x0", "gasPrice 0x0 — gasless, nothing for MetaMask to fee-multiply");
  assert.equal(req.value, "0x7", "value hex-encoded");
  assert.equal("chainId" in req, false, "chainId omitted — MetaMask signs the network ensureStudionet selected");
  assert.deepEqual(Object.keys(req).sort(), ["data", "from", "gas", "gasPrice", "nonce", "to", "type", "value"].sort(),
    "exactly the 8 fields, nothing MetaMask must guess");
});

check("metaMaskRequest zero-fields still hex (no raw bigint leaks)", () => {
  const req = metaMaskRequest({ to: "0x1", data: "0x", value: 0n, nonce: 0n, gasLimit: 0n, gasPrice: 0n }, "0xabc");
  assert.equal(req.nonce, "0x0");
  assert.equal(req.gas, "0x0");
  assert.equal(req.value, "0x0");
});

// ---------------------------------------------------------------- 2 · chain ensure
check("STUDIONET_CHAIN is chainId 0xF22F (61999) + studio RPC", () => {
  assert.equal(STUDIONET_CHAIN.chainId, "0xf22f");
  assert.equal(STUDIONET_CHAIN.rpcUrls[0], "https://studio.genlayer.com/api");
  assert.equal(STUDIONET_CHAIN.nativeCurrency.symbol, "GEN");
  assert.equal(STUDIONET_CHAIN.nativeCurrency.decimals, 18);
});

check("ensureStudionet: already added -> single switch, no add", async () => {
  const calls = [];
  const provider = { request: async (o) => { calls.push(o); return null; } };
  await ensureStudionet(provider);
  assert.equal(calls.length, 1, "one request only");
  assert.equal(calls[0].method, "wallet_switchEthereumChain");
  assert.deepEqual(calls[0].params, [{ chainId: "0xf22f" }]);
});

check("ensureStudionet: 4902 (not added) -> add THEN switch, both fire", async () => {
  const calls = [];
  const provider = {
    request: async (o) => {
      calls.push(o);
      if (o.method === "wallet_switchEthereumChain" && calls.filter((c) => c.method === "wallet_switchEthereumChain").length === 1) {
        throw Object.assign(new Error("Unrecognized chain ID"), { code: 4902 });
      }
      return null;
    },
  };
  await ensureStudionet(provider);
  const methods = calls.map((c) => c.method);
  assert.deepEqual(methods, ["wallet_switchEthereumChain", "wallet_addEthereumChain", "wallet_switchEthereumChain"]);
  assert.deepEqual(calls[1].params[0], STUDIONET_CHAIN, "add carries the full chain params");
});

check("ensureStudionet: unrelated error (e.g. 4001 user reject) re-throws", async () => {
  const provider = {
    request: async () => { throw Object.assign(new Error("User rejected"), { code: 4001 }); },
  };
  await assert.rejects(() => ensureStudionet(provider), /User rejected/);
});

// ---------------------------------------------------------------- 3 · browser-identity branch untouched
check("tx.js ethers.Wallet branch byte-identical (signTransaction -> sendRawTransaction)", () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, "../tx.js"), "utf8");
  const branch = `if (typeof signer.signTransaction === "function") {
    // ethers.Wallet (browser identity): sign offline, exactly as built above.
    const raw = await signer.signTransaction(tx);
    evmHash = await rpc("eth_sendRawTransaction", [raw]);
  } else if (typeof signer.request === "function") {`;
  assert.ok(src.includes(branch), "Wallet branch must stay on signTransaction + eth_sendRawTransaction");
});

hr();
if (failures) { console.log(failures + " check(s) FAILED"); process.exit(1); }
console.log("ALL CHECKS PASSED — eth_sendTransaction payload is legacy type-0 / gasPrice 0x0 / fixed gas,");
console.log("chain-ensure order is switch->(4902)add->switch, and the browser-identity branch is untouched.");
