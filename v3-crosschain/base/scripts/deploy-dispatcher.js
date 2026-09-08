/**
 * Deploy BaseTripDispatcher to Base Sepolia and (optionally) configure it.
 *
 * BaseTripDispatcher is the destination-side LayerZero receiver for the
 * GenLayer -> EVM direction (see DEPLOY-NOTES.md §"Phase 4 wiring"). Its address
 * is what gets registered on the zkSync Era Sepolia BridgeForwarder as
 * `bridgeAddresses[40245]` (ACTION=set-bridge-address, DST_BRIDGE_ADDRESS=<this>),
 * and it is what BaseDemoVault must be configured to accept TRIP messages from.
 *
 * Prerequisites:
 * - The zkSync Era Sepolia BridgeForwarder is deployed (its address is the
 *   trusted forwarder configured here; its CALLER_ROLE holder is the relay).
 * - Deployer wallet has Base Sepolia ETH for gas.
 *
 * Usage (from v3-crosschain/base):
 *   npm install
 *   PRIVATE_KEY=0x... OWNER_ADDRESS=0x... \
 *     TRUSTED_FORWARDER_ADDRESS=<zkSync BridgeForwarder> \
 *     BASEDEMOVAULT_ADDRESS=<BaseDemoVault> \
 *     npx hardhat run scripts/deploy-dispatcher.js --network baseSepoliaTestnet
 *
 * Environment variables (also settable in .env — see .env.example):
 *   PRIVATE_KEY                  - Deployer private key
 *   OWNER_ADDRESS                - Governance address (owner of the dispatcher)
 *   BASESEPOLIATESTNET_ENDPOINT  - LayerZero V2 endpoint on Base Sepolia
 *                                  (default 0x6EDCE65403992e310A62460808c4b910D972f10f)
 *   BASE_SEPOLIA_RPC_URL         - optional, defaults to https://sepolia.base.org
 *   ETHERSCAN_API_KEY            - optional, for contract verification
 *   ZKSYNC_EID                   - source EID of the zkSync forwarder (default 40305)
 *   TRUSTED_FORWARDER_ADDRESS    - optional: zkSync Era Sepolia BridgeForwarder address
 *                                  (set as trusted forwarder right after deploy)
 *   BASEDEMOVAULT_ADDRESS        - optional: BaseDemoVault address to whitelist
 */
require("dotenv").config();
const { ethers } = require("hardhat");

const DEFAULT_BASE_SEPOLIA_ENDPOINT = "0x6EDCE65403992e310A62460808c4b910D972f10f";

function toBytes32(addr) {
  return ethers.AbiCoder.defaultAbiCoder().encode(["address"], [addr]);
}

async function main() {
  const owner = process.env.OWNER_ADDRESS;
  const endpointAddr = process.env.BASESEPOLIATESTNET_ENDPOINT || DEFAULT_BASE_SEPOLIA_ENDPOINT;

  if (!owner || !ethers.isAddress(owner)) {
    throw new Error("Missing or invalid OWNER_ADDRESS");
  }
  if (!ethers.isAddress(endpointAddr)) {
    throw new Error("Invalid BASESEPOLIATESTNET_ENDPOINT: " + endpointAddr);
  }

  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  console.log("Network:", network.name, "chainId:", network.chainId);
  console.log("Deployer:", deployer.address);
  console.log("Owner:", owner);
  console.log("LayerZero endpoint:", endpointAddr);

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("Deployer balance:", ethers.formatEther(balance), "ETH");
  if (balance === 0n) {
    throw new Error("Deployer has no ETH. Get Base Sepolia ETH from a faucet.");
  }

  const Dispatcher = await ethers.getContractFactory("BaseTripDispatcher");
  const dispatcher = await Dispatcher.deploy(endpointAddr, owner);
  const deployTx = dispatcher.deploymentTransaction();
  if (!deployTx) throw new Error("Deployment transaction not found");
  console.log("Deploy TX:", deployTx.hash);
  await dispatcher.waitForDeployment();
  const address = await dispatcher.getAddress();
  console.log("BaseTripDispatcher deployed to:", address);

  // Optional post-deploy configuration.
  const forwarder = process.env.TRUSTED_FORWARDER_ADDRESS;
  if (forwarder && ethers.isAddress(forwarder)) {
    const srcEid = parseInt(process.env.ZKSYNC_EID || "40305", 10);
    const tx = await dispatcher.setTrustedForwarder(srcEid, toBytes32(forwarder));
    await tx.wait();
    console.log(`Trusted forwarder set: srcEid=${srcEid} forwarder=${forwarder}`);
  } else {
    console.log("SKIP: no TRUSTED_FORWARDER_ADDRESS set — run setTrustedForwarder later.");
  }

  const vaultAddr = process.env.BASEDEMOVAULT_ADDRESS;
  if (vaultAddr && ethers.isAddress(vaultAddr)) {
    const tx = await dispatcher.setTrustedTarget(vaultAddr, true);
    await tx.wait();
    console.log("Trusted target set:", vaultAddr);
  } else {
    console.log("SKIP: no BASEDEMOVAULT_ADDRESS set — run setTrustedTarget later.");
  }

  console.log("\nNext steps:");
  console.log("  1. On the zkSync Era BridgeForwarder:");
  console.log("       ACTION=set-bridge-address npx hardhat run scripts/configure.ts --network zkSyncSepoliaTestnet");
  console.log("       (DST_EID=40245, DST_BRIDGE_ADDRESS=" + address + ")");
  console.log("  2. Ensure BaseDemoVault.bridgeReceiver == " + address);
  console.log("     (deploy it with BRIDGE_RECEIVER_ADDRESS=" + address + ", or call setBridgeReceiver)");
  console.log("  3. Deploy interlock_v3.py with --target-contract", address);
}

main().catch((error) => {
  console.error("\nDeployment failed:", error);
  process.exitCode = 1;
});
