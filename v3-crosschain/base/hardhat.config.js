require("@nomicfoundation/hardhat-toolbox");

// Hardhat project for the Interlock v3 BaseDemoVault (toy EVM twin).
// Sources are at the project root (BaseDemoVault.sol) plus the vendored
// boilerplate's IGenLayerBridgeReceiver.sol (pulled in via relative import).

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.20",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  paths: {
    sources: "./",
    tests: "./test",
  },
  networks: {
    hardhat: {
      chainId: 31337,
    },
    baseSepoliaTestnet: {
      url: process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org",
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      chainId: 84532,
    },
  },
  etherscan: {
    apiKey: {
      baseSepoliaTestnet: process.env.ETHERSCAN_API_KEY || "",
    },
    customChains: [
      {
        network: "baseSepoliaTestnet",
        chainId: 84532,
        urls: {
          apiURL: "https://api.etherscan.io/v2/api?chainid=84532",
          browserURL: "https://sepolia.basescan.org",
        },
      },
    ],
  },
};
