/**
 * Deploy BaseDemoVault to Base Sepolia.
 *
 * Prerequisites:
 * - The v3 bridge infrastructure is deployed and configured (see
 *   v3-crosschain/DEPLOY-NOTES.md), in particular the Base Sepolia
 *   BridgeReceiver.sol that will deliver GenLayer TRIP messages.
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
 *   BRIDGE_RECEIVER_ADDRESS- Base Sepolia BridgeReceiver.sol address
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

  const p = await vault.params();
  console.log("Genesis params:", {
    owner: p.owner_,
    bridgeReceiver: p.bridgeReceiver_,
    collateral: p.collateral_.toString(),
    debt: p.debt_.toString(),
    coverage: p.coverage_.toString(),
    paused: p.paused_,
  });

  console.log("\nNext steps:");
  console.log("  1. Deploy interlock_v3.py on GenLayer with --target-contract", address);
  console.log("  2. File a real report_exploit on interlock_v3.py");
  console.log("  3. Wait for the relay to deliver the TRIP message");
  console.log("  4. Check BaseDemoVault.paused -> true on Base Sepolia explorer");
}

main().catch((error) => {
  console.error("\nDeployment failed:", error);
  process.exitCode = 1;
});
