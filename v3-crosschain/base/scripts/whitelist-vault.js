/**
 * Configure an EXISTING BaseTripDispatcher — no redeploy.
 *
 * Deploy order requires the vault to exist before it can be whitelisted on the
 * dispatcher, but deploy-dispatcher.js always deploys a fresh dispatcher, so it
 * cannot be re-run to whitelist the vault (that would orphan the first
 * dispatcher). This script fills the gap:
 *
 *   PRIVATE_KEY=0x... DISPATCHER_ADDRESS=0x... BASEDEMOVAULT_ADDRESS=0x... \
 *     npx hardhat run scripts/whitelist-vault.js --network baseSepoliaTestnet
 *
 * It calls setTrustedTarget(vault, true) on the dispatcher at DISPATCHER_ADDRESS
 * and verifies the mapping read-back. The dispatcher's trusted forwarder was
 * already set at its deploy (TRUSTED_FORWARDER_ADDRESS); this script never
 * touches trust relationships it did not create.
 *
 * Environment variables (also settable in .env — see .env.example):
 *   PRIVATE_KEY           - Deployer private key (the dispatcher owner)
 *   DISPATCHER_ADDRESS    - Existing BaseTripDispatcher address
 *   BASEDEMOVAULT_ADDRESS - BaseDemoVault address to whitelist
 *   BASE_SEPOLIA_RPC_URL  - optional, defaults to https://sepolia.base.org
 */
require("dotenv").config();
const { ethers } = require("hardhat");

async function main() {
  const dispatcherAddr = process.env.DISPATCHER_ADDRESS;
  const vaultAddr = process.env.BASEDEMOVAULT_ADDRESS;

  if (!dispatcherAddr || !ethers.isAddress(dispatcherAddr)) {
    throw new Error("Missing or invalid DISPATCHER_ADDRESS");
  }
  if (!vaultAddr || !ethers.isAddress(vaultAddr)) {
    throw new Error("Missing or invalid BASEDEMOVAULT_ADDRESS");
  }

  const [signer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  console.log("Network:", network.name, "chainId:", network.chainId);
  console.log("Signer:", signer.address);
  console.log("Dispatcher:", dispatcherAddr);
  console.log("Vault to whitelist:", vaultAddr);

  const dispatcher = await ethers.getContractAt("BaseTripDispatcher", dispatcherAddr, signer);

  const owner = await dispatcher.owner();
  if (owner.toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error(`Dispatcher owner is ${owner}, not signer ${signer.address} — cannot setTrustedTarget`);
  }

  console.log("Owner check passed:", owner);

  const tx = await dispatcher.setTrustedTarget(vaultAddr, true);
  console.log("setTrustedTarget TX:", tx.hash);
  await tx.wait();

  const trusted = await dispatcher.trustedTargets(vaultAddr);
  console.log("trustedTargets(vault):", trusted);
  if (!trusted) {
    throw new Error("setTrustedTarget did not stick — trustedTargets(vault) is false");
  }

  console.log("PASS — vault whitelisted on dispatcher.");
}

main().catch((error) => {
  console.error("\nWhitelist failed:", error);
  process.exitCode = 1;
});
