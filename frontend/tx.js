// tx.js — build + sign + broadcast a GenLayer write from the browser.
//
// A GenLayer "write to a contract" is NOT a call to that contract. It is a
// standard EVM transaction whose `to` is GenLayer's consensus-main contract and
// whose `data` ABI-calls the v0.6 FEE-AWARE form:
//
//     addTransaction((address sender, address recipient,
//                     uint256 numOfInitialValidators, uint256 maxRotations,
//                     uint256 validUntil, uint256 saltNonce, uint256 userValue,
//                     tuple feesDistribution, bytes txCalldata,
//                     tuple[] messageAllocations))
//
// where `txCalldata` is the RLP([glEncode({method,args}), 0x80]) blob from gen.js
// and the outer EVM `value` = userValue + feeValue. The fee packet is NOT
// computable client-side: it must reserve GEN for the validator round AND for
// any internal message the write triggers (report_exploit -> apply_pause on the
// vault). The browser therefore asks the RPC itself:
//
//   1. sim_getFeeConfig          -> its own defaultFees (the policy math lives
//                                   server-side; we never replicate it)
//   2. sim_estimateTransactionFees(fees = defaultFees) -> recommendedPreset,
//      the authoritative distribution + feeValue + messageAllocations. A report
//      encoded from that preset was verified (2026-09-08) to SETTLE on
//      studio-dev — vault paused, interlock tripped, FINISHED_WITH_RETURN.
//   3. ABI-encode the tuple from the preset, sign a legacy gasPrice-0 EIP-155 tx
//      with the browser identity (identity.js), raw-broadcast.
//
// The envelope is a standard legacy EVM transaction, so it can be signed by
// ethers offline (browser identity). MetaMask is intentionally display-only in
// this app: a report carries a GEN bond and studio-dev has no faucet to fund a
// wallet, so MetaMask is never asked to sign. Because every write is
// fee-aware, plain writes (borrow) go through the SAME sim+encode path.

import {
  CONSENSUS, CHAIN_ID, INITIAL_VALIDATORS, MAX_ROTATIONS,
  callData, rpc, estimateWriteFees, feeConfig, read,
} from "./gen.js";

const { Interface } = globalThis.ethers;

// v0.6 consensus-main addTransaction — JSON ABI fragment for the single
// AddTransactionParams struct (exact member order from the on-chain ABI,
// consensus_main_abi_v06.json). Arrays are passed positionally to ethers.
const ADD_TRANSACTION = {
  type: "function",
  name: "addTransaction",
  stateMutability: "payable",
  inputs: [{
    name: "_params",
    type: "tuple",
    components: [
      { name: "sender", type: "address" },
      { name: "recipient", type: "address" },
      { name: "numOfInitialValidators", type: "uint256" },
      { name: "maxRotations", type: "uint256" },
      { name: "validUntil", type: "uint256" },
      { name: "saltNonce", type: "uint256" },
      { name: "userValue", type: "uint256" },
      {
        name: "feesDistribution", type: "tuple", components: [
          { name: "leaderTimeunitsAllocation", type: "uint256" },
          { name: "validatorTimeunitsAllocation", type: "uint256" },
          { name: "appealRounds", type: "uint256" },
          { name: "executionBudgetPerRound", type: "uint256" },
          { name: "executionConsumed", type: "uint256" },
          { name: "totalMessageFees", type: "uint256" },
          { name: "rotations", type: "uint256[]" },
          { name: "maxPriceGenPerTimeUnit", type: "uint256" },
          { name: "storageFeeMaxGasPrice", type: "uint256" },
          { name: "receiptFeeMaxGasPrice", type: "uint256" },
        ],
      },
      { name: "txCalldata", type: "bytes" },
      {
        name: "messageAllocations", type: "tuple[]", components: [
          { name: "messageType", type: "uint8" },
          { name: "onAcceptance", type: "bool" },
          { name: "parentIndex", type: "uint256" },
          { name: "recipient", type: "address" },
          { name: "callKey", type: "bytes32" },
          { name: "budget", type: "uint256" },
          { name: "feeParams", type: "bytes" },
        ],
      },
    ],
  }],
};

const CONSENSUS_IFACE = new Interface([ADD_TRANSACTION]);

/** losslessParse helper exposed for callers that also fetch sim responses. */
export { losslessParse } from "./gen.js";

/** Validate+normalize an address (lowercase hex) so tuple encoding is stable. */
const addr = (s) => {
  const a = String(s).toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(a)) throw new Error("bad address: " + s);
  return a;
};

// Ethers encodes each tuple field positionally in the array order above.
const FEE_DIST_ORDER = [
  "leaderTimeunitsAllocation", "validatorTimeunitsAllocation", "appealRounds",
  "executionBudgetPerRound", "executionConsumed", "totalMessageFees", "rotations",
  "maxPriceGenPerTimeUnit", "storageFeeMaxGasPrice", "receiptFeeMaxGasPrice",
];
const ALLOC_ORDER = [
  "messageType", "onAcceptance", "parentIndex", "recipient", "callKey", "budget", "feeParams",
];

function toBig(v) { return typeof v === "bigint" ? v : BigInt(v); }

/** Build the addTransaction tuple value + outer EVM `value` from a
 *  recommendedPreset (estimateWriteFees result).
 *  @returns {{ data: string, value: bigint, preset: object }} */
export function buildAddTransactionData({ from, recipient, method, args, value, preset }) {
  const userValue = toBig(value ?? 0);
  const dist = preset?.distribution ?? {};
  const allocs = preset?.messageAllocations ?? [];
  const feeValue = toBig(preset?.feeValue ?? 0);

  const feesDistribution = FEE_DIST_ORDER.map((k) => {
    if (k === "rotations") return (dist.rotations ?? []).map((r) => toBig(r));
    return toBig(dist[k] ?? 0);
  });

  const messageAllocations = allocs.map((a) => [
    toBig(a.messageType),
    Boolean(a.onAcceptance),
    toBig(a.parentIndex),
    addr(a.recipient),
    String(a.callKey ?? "0x0000000000000000000000000000000000000000000000000000000000000000"),
    toBig(a.budget ?? 0),
    String(a.feeParams ?? "0x"),
  ]);

  const validUntil = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const params = [
    addr(from), addr(recipient),
    BigInt(INITIAL_VALIDATORS), BigInt(MAX_ROTATIONS),
    validUntil, 0n, userValue,
    feesDistribution,
    callData(method, args),
    messageAllocations,
  ];
  const data = CONSENSUS_IFACE.encodeFunctionData("addTransaction", [params]);
  return { data, value: userValue + feeValue, feeValue, preset };
}

export async function getNonce(from) {
  const r = await rpc("eth_getTransactionCount", [addr(from), "latest"]);
  return BigInt(r);
}

const WIRE_NET = /fetch failed|Failed to fetch|ECONNRESET|ENOTFOUND|ETIMEDOUT|aborted|AbortError|timeout|502|Bad gateway|Internal|invalid json|Method not found/i;
async function rpcRetry(fn, tries = 4) {
  let last;
  for (let t = 0; t < tries; t++) {
    try { return await fn(); }
    catch (e) {
      last = e;
      if (!WIRE_NET.test(String(e?.message ?? e))) throw e;
      await new Promise((r) => setTimeout(r, 1500 * (t + 1)));
    }
  }
  throw last;
}

export async function estimateGas(tx) {
  // eth_estimateGas wants hex quantities; BigInt would break JSON serialization.
  const jsonTx = {};
  for (const [k, v] of Object.entries(tx)) {
    jsonTx[k] = typeof v === "bigint" ? "0x" + v.toString(16) : v;
  }
  const r = await rpc("eth_estimateGas", [jsonTx]);
  return BigInt(r);
}

/**
 * Sign a GenLayer write with the browser identity's ethers.Wallet and broadcast
 * it. Returns the outer EVM transaction hash once broadcast — the app then
 * watches the result by polling contract reads (report_count / paused), never
 * by trusting a receipt, because studio-dev's ledger settles asynchronously.
 *
 * Fee path (studio-dev v0.6): every write goes through sim_getFeeConfig +
 * sim_estimateTransactionFees to get the authoritative fee packet (see top of
 * file). Nonce/gas are fetched with transport-level retry (safe — nothing
 * signed yet); the signed broadcast is never auto-retried.
 */
export async function sendWrite(signer, recipient, method, args, opts = {}) {
  const from = await signer.getAddress();
  const value = opts.value ?? 0n;
  const dataBlob = callData(method, args);

  const cfg = await rpcRetry(() => feeConfig());
  const preset = await rpcRetry(() => estimateWriteFees(recipient, from, dataBlob, value, cfg?.defaultFees));
  if (!preset) throw new Error("sim_estimateTransactionFees returned no recommendedPreset");
  const { data, value: outerValue } = buildAddTransactionData({
    from, recipient, method, args, value, preset,
  });

  const nonce = await rpcRetry(() => getNonce(from));
  const base = {
    from,
    to: CONSENSUS,
    data,
    value: outerValue,
    nonce,
    chainId: CHAIN_ID,
    gasPrice: 0n,                    // legacy type-0, as the Python SDK signs
  };

  let gas;
  try {
    gas = await estimateGas(base);
  } catch (e) {
    if (!WIRE_NET.test(String(e?.message ?? e))) throw e;
    gas = 600_000n;                  // estimate gateway flake — SDK happy path ~this
  }
  base.gasLimit = gas;

  // ethers.Wallet (browser identity): sign offline exactly as built above, then
  // raw-broadcast. studio-dev settles bonded writes from any 0-balance key.
  const raw = await signer.signTransaction(base);
  return rpc("eth_sendRawTransaction", [raw]);
}

// studio-dev chain params (chainId 61997 decimal = 0xF22D) used only to switch a
// connected MetaMask to studio-dev for DISPLAY. Gasless + virtual value.
// blockExplorerUrls intentionally omitted — studio-dev has no public explorer.
export const STUDIO_DEV_CHAIN = {
  chainId: "0xf22d",
  chainName: "GenLayer Studio Dev (studio-dev)",
  nativeCurrency: { name: "GEN", symbol: "GEN", decimals: 18 },
  rpcUrls: ["https://studio-dev.genlayer.com/api"],
};

/** Ensure an EIP-1193 provider has studio-dev added AND selected. Used on the
 * display-only MetaMask connect so the wallet shows the right network. 4902 =
 * "chain not added yet" (MetaMask's wallet_switchEthereumChain error). */
export async function ensureStudioDev(provider) {
  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: STUDIO_DEV_CHAIN.chainId }],
    });
  } catch (e) {
    if (e && e.code === 4902) {
      await provider.request({ method: "wallet_addEthereumChain", params: [STUDIO_DEV_CHAIN] });
      await provider.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: STUDIO_DEV_CHAIN.chainId }],
      });
    } else {
      throw e;
    }
  }
}

// Back-compat alias for callers that still reference the studionet name.
export const ensureStudionet = ensureStudioDev;

export { read };
