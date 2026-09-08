#!/usr/bin/env npx tsx
/**
 * Check the GenLayer BridgeSender outbox for pending TRIP messages.
 *
 * After a confirmed report, interlock_v3.py emits `BridgeSender.send_message(...)`;
 * the relay polls exactly this list. This script shows the hashes and their
 * destination so you can watch the message leave GenLayer and arrive on Base.
 *
 * Usage:
 *   export PRIVATE_KEY=0x... GENLAYER_RPC_URL=https://studio.genlayer.com/api
 *   npx tsx scripts/check-outbox.ts --bridge-sender <BridgeSender_py_address>
 */

import { createAccount, createClient } from "genlayer-js";
import { studionet } from "genlayer-js/chains";

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const i = args.findIndex((a) => a === flag);
    return i !== -1 ? args[i + 1] : null;
  };
  const bridgeSender = get("--bridge-sender");
  if (!bridgeSender) {
    console.error("Missing required argument: --bridge-sender <address>");
    process.exit(1);
  }
  return { bridgeSender };
}

async function main() {
  const { bridgeSender } = parseArgs();
  const privateKey = process.env.PRIVATE_KEY;
  const rpcUrl = process.env.GENLAYER_RPC_URL || "https://studio.genlayer.com/api";
  if (!privateKey) throw new Error("Missing PRIVATE_KEY environment variable");

  const account = createAccount(privateKey as `0x${string}`);
  const client = createClient({
    chain: { ...studionet, rpcUrls: { default: { http: [rpcUrl] } } },
    account,
  });

  const hashes: string[] = await client.readContract({
    address: bridgeSender as `0x${string}`,
    functionName: "get_message_hashes",
    args: [],
    stateStatus: "accepted",
  });

  console.log(`BridgeSender outbox: ${hashes.length} message(s)`);
  for (const hash of hashes) {
    const m: Map<string, unknown> = await client.readContract({
      address: bridgeSender as `0x${string}`,
      functionName: "get_message",
      args: [hash],
      stateStatus: "accepted",
    });
    console.log("  hash:", hash);
    console.log("    target_chain_id:", m.get("target_chain_id"));
    console.log("    target_contract:", m.get("target_contract"));
    console.log("    data:", m.get("data"));
  }
}

main().catch((error) => {
  console.error("\nFailed:", error);
  process.exit(1);
});
