#!/usr/bin/env npx tsx
/**
 * File a bonded `report_exploit` on the v3 Interlock (interlock_v3.py).
 *
 * This is the "fire the breaker" step of the Phase 4 end-to-end run: it posts a
 * report naming ONE operation index in the GenLayer DemoVault's immutable audit
 * log, attaching `min_bond` GL as the report bond (interlock_v3.py requires
 * msg.value >= min_bond). GenLayer consensus then classifies the pinned op; on
 * EXPLOIT_CONFIRMED interlock_v3 emits a TRIP message into BridgeSender.py.
 *
 * The `genlayer` CLI's `write` command has no `--value` flag, so the report must
 * go through this script (or GenLayer Studio's Run-and-Debug, which lets you
 * attach a value). Run from v3-crosschain/boilerplate/example after `npm install`.
 *
 * Usage:
 *   export PRIVATE_KEY=0x... GENLAYER_RPC_URL=https://studio.genlayer.com/api
 *   npx tsx scripts/report-trip.ts \
 *     --interlock <interlock_v3_address> \
 *     --op-index 0 \
 *     --value 1        # GL attached as the report bond (>= min_bond)
 */

import { createAccount, createClient } from "genlayer-js";
import { studionet } from "genlayer-js/chains";

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const i = args.findIndex((a) => a === flag);
    return i !== -1 ? args[i + 1] : null;
  };
  const interlock = get("--interlock");
  const opIndex = get("--op-index");
  const value = get("--value") || "1";
  if (!interlock) {
    console.error("Missing required argument: --interlock <interlock_v3_address>");
    process.exit(1);
  }
  return { interlock, opIndex: opIndex || "0", value };
}

// "1" -> "1000000000000000000", "0.5" -> "500000000000000000" (no float math).
function glToWei(gl: string): string {
  const [whole, frac = ""] = gl.split(".");
  const padded = (whole + frac.padEnd(18, "0")).replace(/^0+/, "") || "0";
  return padded;
}

async function main() {
  const { interlock, opIndex, value } = parseArgs();

  const privateKey = process.env.PRIVATE_KEY;
  const rpcUrl = process.env.GENLAYER_RPC_URL || "https://studio.genlayer.com/api";
  if (!privateKey) throw new Error("Missing PRIVATE_KEY environment variable");

  console.log("Filing bonded report on interlock_v3.py");
  console.log("  Interlock:", interlock);
  console.log(`  op_index: ${opIndex}`);
  console.log(`  value (bond): ${value} GL`);
  console.log(`  RPC: ${rpcUrl}`);

  const account = createAccount(privateKey as `0x${string}`);
  const client = createClient({
    chain: { ...studionet, rpcUrls: { default: { http: [rpcUrl] } } },
    account,
  });

  const hash = await client.writeContract({
    address: interlock as `0x${string}`,
    functionName: "report_exploit",
    args: [Number(opIndex)],
    value: glToWei(value), // GL (decimal string) -> wei
  });

  console.log("  Transaction:", hash);
  console.log("  Waiting for acceptance (consensus round)...");

  const receipt = await client.waitForTransactionReceipt({
    hash,
    status: "ACCEPTED",
    retries: 60,
  });

  console.log("\nReceipt status:", receipt.status);
  console.log("Next: check the outbox for the TRIP hash, then watch the relay.");
}

main().catch((error) => {
  console.error("\nFailed:", error);
  process.exit(1);
});
