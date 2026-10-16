const { subtask } = require("hardhat/config");
const { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } = require("hardhat/builtin-tasks/task-names");
require("dotenv").config();
require("@nomicfoundation/hardhat-toolbox");
require("@openzeppelin/hardhat-upgrades");
require("hardhat-deploy");

const privateKey = process.env.DEPLOYER_PRIVATE_KEY;
const accounts = privateKey ? [privateKey] : [];
const dynoForkRequested = Boolean(process.env.DYNO_FORK_RPC_URL && process.env.DYNO_FORK_MANIFEST && process.env.DYNO_FORK_BLOCK);

module.exports = {
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: true,
      evmVersion: "cancun",
    },
    overrides: {
      "contracts/dyno/ProjectDynoRaffleManager.sol": {
        version: "0.8.28",
        settings: { optimizer: { enabled: true, runs: 1 }, viaIR: true, evmVersion: "cancun" },
      },
    },
  },
  namedAccounts: { deployer: { default: 0 } },
  networks: {
    hardhat: {
      ...(dynoForkRequested ? {
      // Ronin is not included in Hardhat's built-in historical fork table.
      // This explicit entry supports current DYNO forks; older Ronin forks are
      // deliberately not inferred from Ethereum activation dates.
      // Source: ronin-chain/ronin params/config.go, RoninMainnetChainConfig.
      hardfork: "cancun",
      chains: { 2020: { hardforkHistory: { cancun: 43254600 } } },
        forking: {
          url: process.env.DYNO_FORK_RPC_URL,
          blockNumber: Number(process.env.DYNO_FORK_BLOCK),
        },
      } : {}),
    },
    saigon: {
      chainId: 202601,
      url: process.env.SAIGON_RPC_URL || "https://saigon-testnet.roninchain.com/rpc",
      accounts,
    },
    ronin: {
      chainId: 2020,
      url: process.env.RONIN_RPC_URL || "https://api.roninchain.com/rpc",
      accounts,
    },
  },
  sourcify: { enabled: false },
};

// Use the npm-pinned compiler, avoiding an unpinned download during builds.
subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD, async ({ solcVersion }, hre, runSuper) => {
  if (solcVersion === "0.8.28") {
    return {
      compilerPath: require.resolve("solc/soljson.js"),
      isSolcJs: true,
      version: "0.8.28",
      longVersion: require("solc").version(),
    };
  }
  return runSuper();
});
