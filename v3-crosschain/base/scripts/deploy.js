/**
 * Deploy BaseDemoVault to Base Sepolia.
 *
 * Prerequisites:
 * - The v3 bridge infrastructure is deployed and configured (see
 *   v3-crosschain/DEPLOY-NOTES.md), in particular the BaseTripDispatcher that
 *   will receive LayerZero TRIP messages and call trip() on this vault.
 *   (BRIDGE_RECEIVER_ADDRESS must be the BaseTripDispatcher address — NOT the
 *   shipped BridgeReceiver.sol, which only stores EVM->GenLayer messages.)
 * - Deployer wallet has Base Sepolia ETH for gas.
 *
 * Usage (from v3-crosschain/base):
 *   npm install
 *   PRIVATE_KEY=0x... OWNER_ADDRESS=0x... BRIDGE_RECEIVER_ADDRESS=0x... \
 *     npx hardhat run scripts/deploy.js --network baseSepoliaTestnet
 *
 * Environment variables (also settable in .env — see .env.example):
 *   PRIVATE_KEY            - Deployer private key
 *   OWNER_ADDRESS          - Governance address (may resume, install bridge receiver)
 *   BRIDGE_RECEIVER_ADDRESS- BaseTripDispatcher address (the one authorized to trip)
 *   BASE_SEPOLIA_RPC_URL   - optional, defaults to https://sepolia.base.org
 */
require("dotenv").config();
const { ethers } = require("hardhat");

async function main() {
  const owner = process.env.OWNER_ADDRESS;
  const bridgeReceiver = process.env.BRIDGE_RECEIVER_ADDRESS;

  if (!owner || !ethers.isAddress(owner)) {
    throw new Error("Missing or invalid OWNER_ADDRESS");
  }
  if (!bridgeReceiver || !ethers.isAddress(bridgeReceiver)) {
    throw new Error("Missing or invalid BRIDGE_RECEIVER_ADDRESS");
  }

  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  console.log("Network:", network.name, "chainId:", network.chainId);
  console.log("Deployer:", deployer.address);
  console.log("Owner:", owner);
  console.log("BridgeReceiver:", bridgeReceiver);

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("Deployer balance:", ethers.formatEther(balance), "ETH");
  if (balance === 0n) {
    throw new Error("Deployer has no ETH. Get Base Sepolia ETH from a faucet.");
  }

  const BaseDemoVault = await ethers.getContractFactory("BaseDemoVault");
  const vault = await BaseDemoVault.deploy(owner, bridgeReceiver);
  const deployTx = vault.deploymentTransaction();
  if (!deployTx) throw new Error("Deployment transaction not found");
  console.log("Deploy TX:", deployTx.hash);
  await vault.waitForDeployment();

  const address = await vault.getAddress();
  console.log("BaseDemoVault deployed to:", address);

  // Informational only. Public RPCs (sepolia.base.org) are load-balanced and the
  // node serving this call can lag the just-mined deploy block, returning "0x"
  // (ethers BAD_DATA). Retry briefly, then warn — this read must NEVER fail the
  // deploy, whose address is already logged above.
  let p = null;
  for (let attempt = 1; attempt <= 5 && !p; attempt++) {
    try {
      p = await vault.params();
    } catch (e) {
      console.log(`params() read attempt ${attempt} failed: ${e.shortMessage || e.message}`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  if (p) {
    console.log("Genesis params:", {
      owner: p.owner_,
      bridgeReceiver: p.bridgeReceiver_,
      collateral: p.collateral_.toString(),
      debt: p.debt_.toString(),
      coverage: p.coverage_.toString(),
      paused: p.paused_,
    });
  } else {
    console.log("WARN: could not read params() after retries (RPC lag); deploy itself succeeded.");
  }

  console.log("\nNext steps:");
  console.log("  1. On the zkSync Era BridgeForwarder, register this vault's dispatcher:");
  console.log("     ACTION=set-bridge-address ... DST_EID=40245 DST_BRIDGE_ADDRESS=<BaseTripDispatcher>");
  console.log("  2. Deploy interlock_v3.py on GenLayer with --target-contract", address);
  console.log("  3. File a real report_exploit on interlock_v3.py");
  console.log("  4. Wait for the relay to deliver the TRIP message");
  console.log("  5. Check BaseDemoVault.paused -> true on Base Sepolia explorer");
}

main().catch((error) => {
  console.error("\nDeployment failed:", error);
  process.exitCode = 1;
});
