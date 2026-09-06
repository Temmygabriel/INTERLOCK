// tx.js — build + sign + broadcast a GenLayer write from the browser.
//
// A GenLayer "write to a contract" is NOT a call to that contract. It is a
// standard EVM transaction whose `to` is GenLayer's consensus-main contract
// and whose `data` ABI-calls:
//
//     addTransaction(sender, recipient, numOfInitialValidators,
//                    maxRotations, calldata, validUntil)
//
// where `calldata` is the RLP([glEncode({method,args}), 0x00]) blob from gen.js
// and `value` carries any msg.value (e.g. a report bond). Because the envelope
// is a standard EIP-1559 transaction, it can be signed by ethers (browser
// identity) OR by MetaMask via eth_sendTransaction — see identity.js.
//
// Requires `globalThis.ethers` (ethers v6). The browser loads the UMD build
// before this module; Node tests do `globalThis.ethers = await import('ethers')`.

import { CONSENSUS, CHAIN_ID, INITIAL_VALIDATORS, MAX_ROTATIONS, callData, rpc, read } from "./gen.js";

const { Interface } = globalThis.ethers;

// The consensus-main addTransaction on studionet has FIVE params:
//   addTransaction(address _sender, address _recipient, uint256 _numOfInitialValidators,
//                  uint256 _maxRotations, bytes _calldata)
// (selector 0x27241a99). There is NO _validUntil — the SDK only appends one when
// its ABI has >=6 params, and studionet's has 5. Passing a 6-param signature
// changes the selector (0xe71d5196) and consensus-main can then not decode the
// call: the tx is treated as targeting consensus-main itself, value is never
// credited, and the write cancels.
const CONSENSUS_IFACE = new Interface([
  "function addTransaction(address _sender, address _recipient, uint256 _numOfInitialValidators, uint256 _maxRotations, bytes _calldata)",
  "event NewTransaction(bytes32 txId, address recipient, address activator)",
]);

/** Calldata for consensus-main addTransaction(recipient, ourContractCall). */
export function addTransactionData(from, recipient, method, args, validators = INITIAL_VALIDATORS, rotations = MAX_ROTATIONS) {
  return CONSENSUS_IFACE.encodeFunctionData("addTransaction", [
    from, recipient, validators, rotations, callData(method, args),
  ]);
}

export async function getNonce(from) {
  const r = await rpc("eth_getTransactionCount", [from, "latest"]);
  return BigInt(r);
}

export async function estimateGas(tx) {
  const r = await rpc("eth_estimateGas", [{ ...tx, from: undefined && undefined, ...(tx.from ? {} : {}) }]);
  // genlayer_py passes the full tx incl. from; studionet ignores from.
  return BigInt(r);
}

async function baseFee() {
  const block = await rpc("eth_getBlockByNumber", ["latest", false]);
  const bf = block?.baseFeePerGas ?? "0x0";
  return BigInt(bf);
}

/**
 * Sign a GenLayer write with an ethers signer (Wallet or a MetaMask/jsonrpc
 * signer) and broadcast it. Returns the *GenLayer* transaction id (bytes32 hex)
 * once the outer EVM tx is mined, so the caller can watch it finalize.
 *
 * IMPORTANT (studionet): the SDK signs a LEGACY type-0 EIP-155 tx here
 * (gasPrice 0, gas ~500000), NOT an EIP-1559 typed tx. The hosted network
 * accepts a type-2 tx at the EVM layer (receipt + NewTransaction) but its
 * ledger cannot then settle `value` (value_credited never happens) and the
 * consensus write fails. Match the SDK shape exactly.
 */
export async function sendWrite(signer, recipient, method, args, opts = {}) {
  const from = await signer.getAddress();
  const value = opts.value ?? 0n;
  const data = addTransactionData(from, recipient, method, args);

  const nonce = await getNonce(from);
  const tx = {
    to: CONSENSUS,
    data,
    value,
    nonce,
    chainId: CHAIN_ID,
    gasPrice: 0n,                 // legacy type-0, as the Python SDK signs
  };

  let gas;
  try {
    gas = await estimateGas({ from, to: CONSENSUS, data, value });
  } catch (e) {
    // studionet sometimes refuses estimateGas for fresh senders; fall back to
    // the 500000 the SDK's eth_estimateGas returns on the happy path.
    gas = 500_000n;
  }
  tx.gasLimit = gas;

  let raw;
  if (typeof signer.signTransaction === "function") {
    raw = await signer.signTransaction(tx);            // browser identity / ethers
  } else {
    raw = await signer.sendTransaction(tx);            // EIP-1193 (MetaMask): already broadcast
  }

  let evmHash;
  if (typeof raw === "string") {
    evmHash = await rpc("eth_sendRawTransaction", [raw]);
  } else {
    evmHash = raw.hash;
  }

  return waitConsensusTxId(evmHash);
}

/** Resolve the GenLayer transaction id for a broadcast EVM hash.
 *
 * On studionet the GenLayer txId equals the EVM tx hash, so we return the hash as
 * soon as the outer receipt is mined OR the GenLayer record leaves PENDING — the
 * receipt can lag the consensus verdict by a minute+, and vice versa. If a
 * distinct NewTransaction txId is ever present we prefer it.
 */
async function waitConsensusTxId(evmHash) {
  const deadline = Date.now() + 180_000;
  let txId = evmHash;
  for (;;) {
    // GenLayer record status (fastest terminal signal on studionet)
    const gt = await rpc("eth_getTransactionByHash", [evmHash]).catch(() => null);
    const gs = gt?.status ?? "PENDING";
    if (gs !== "PENDING") {
      if (gt?.tx_id && gt.tx_id !== evmHash) txId = gt.tx_id;
      return txId;
    }
    // Outer EVM receipt, in case it mines with a distinct NewTransaction id first
    const rec = await rpc("eth_getTransactionReceipt", [evmHash]).catch(() => null);
    if (rec && rec.status === "0x1") {
      for (const log of rec.logs ?? []) {
        try {
          const parsed = CONSENSUS_IFACE.parseLog({ topics: log.topics, data: log.data });
          if (parsed && parsed.name === "NewTransaction") {
            txId = parsed.args.txId;
            return txId;                       // distinct id seen — good enough
          }
        } catch { /* other logs */ }
      }
    }
    if (rec && rec.status && rec.status !== "0x1") {
      throw new Error("consensus tx reverted on chain (status " + rec.status + ")");
    }
    if (Date.now() > deadline) throw new Error("timeout waiting for consensus receipt " + evmHash);
    await new Promise((r) => setTimeout(r, 4000));
  }
}

/** Wait until the GenLayer transaction id reaches FINALIZED. */
export async function waitFinalized(txId) {
  const deadline = Date.now() + 180_000;
  for (;;) {
    const tx = await rpc("eth_getTransactionByHash", [txId]).catch(() => null);
    const status = tx?.consensus_data?.finalized === true ||
                   tx?.status_name === "FINALIZED" ||
                   (tx?.consensus_data?.status ?? "").includes("FINAL");
    if (status) return tx;
    // Also treat ACCEPTED-with-execution-success at finalization boundary as done
    if (Date.now() > deadline) throw new Error("timeout finalizing GenLayer tx " + txId);
    await new Promise((r) => setTimeout(r, 5000));
  }
}

/** Full convenience: sign+broadcast+await finalize, return the GenLayer tx id. */
export async function genWrite(signer, recipient, method, args, opts = {}) {
  const txId = await sendWrite(signer, recipient, method, args, opts);
  await waitFinalized(txId);
  return txId;
}

export { read };
