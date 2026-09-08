/**
 * Read BaseDemoVault state on Base Sepolia — the Phase 4 verification step.
 *
 * Usage (from v3-crosschain/base):
 *   npm install
 *   VAULT_ADDRESS=0x... npx hardhat run scripts/check.js --network baseSepoliaTestnet
 *   # or: npx hardhat run scripts/check.js --network baseSepoliaTestnet --vault 0x...
 *
 * Environment variables:
 *   VAULT_ADDRESS       - BaseDemoVault address on Base Sepolia
 *   BASE_SEPOLIA_RPC_URL - optional, defaults to https://sepolia.base.org
 */
require("dotenv").config();
const { ethers } = require("hardhat");

const ABI = [
  "function paused() view returns (bool)",
  "function coverage() view returns (uint256)",
  "function collateral() view returns (uint256)",
  "function debt() view returns (uint256)",
  "function auditLen() view returns (uint256)",
  "function bridgeReceiver() view returns (address)",
  "function owner() view returns (address)",
  "function getAuditEntry(uint256) view returns (bool, tuple)",
];

async function main() {
  const argv = process.argv;
  const flagIndex = argv.indexOf("--vault");
  const vaultAddr = (flagIndex !== -1 ? argv[flagIndex + 1] : process.env.VAULT_ADDRESS) || "";

  if (!ethers.isAddress(vaultAddr)) {
    throw new Error("Missing or invalid VAULT_ADDRESS (env VAULT_ADDRESS or --vault 0x...)");
  }

  const [signer] = await ethers.getSigners();
  const vault = new ethers.Contract(vaultAddr, ABI, signer.provider);

  const [paused, coverage, collateral, debt, auditLen, bridgeReceiver, owner] =
    await Promise.all([
      vault.paused(),
      vault.coverage(),
      vault.collateral(),
      vault.debt(),
      vault.auditLen(),
      vault.bridgeReceiver(),
      vault.owner(),
    ]);

  console.log("BaseDemoVault:", vaultAddr);
  console.log("  paused:", paused);
  console.log("  coverage:", coverage.toString() + "%");
  console.log("  collateral:", collateral.toString());
  console.log("  debt:", debt.toString());
  console.log("  auditLen:", auditLen.toString());
  console.log("  bridgeReceiver:", bridgeReceiver);
  console.log("  owner:", owner);

  for (let i = 0; i < Number(auditLen); i++) {
    const [found, entry] = await vault.getAuditEntry(i);
    if (found) {
      console.log(`  audit[${i}]: op=${entry.op} seq=${entry.seq.toString()} coverage=${entry.coverage.toString()}%`);
    }
  }

  console.log("\n" + (paused ? "TRIPPED — BaseDemoVault is paused." : "NOT tripped — paused == false."));
  process.exitCode = paused ? 0 : 1;
}

main().catch((error) => {
  console.error("\nCheck failed:", error);
  process.exitCode = 1;
});
