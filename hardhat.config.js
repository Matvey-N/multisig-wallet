require("@nomicfoundation/hardhat-toolbox");
const { vars } = require("hardhat/config");

// Only needed for a testnet deployment. Secrets live in Hardhat's vars store:
//   npx hardhat vars set TESTNET_PRIVATE_KEY   private key of a TEST account
//   npx hardhat vars set TESTNET_RPC_URL       optional, defaults to a public Sepolia RPC
//   npx hardhat vars set ETHERSCAN_API_KEY     optional, only for source verification
const RPC_URL = vars.get("TESTNET_RPC_URL", "https://ethereum-sepolia-rpc.publicnode.com");
const PRIVATE_KEY = vars.get("TESTNET_PRIVATE_KEY", "");

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.28",
    settings: { optimizer: { enabled: true, runs: 200 } },
  },
  networks: {
    localhost: { url: "http://127.0.0.1:8545" },
    testnet: {
      url: RPC_URL,
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
    },
  },
  etherscan: { apiKey: vars.get("ETHERSCAN_API_KEY", "") },
  sourcify: { enabled: false },
  gasReporter: { enabled: process.env.REPORT_GAS === "true" },
};
