const {
  Contract,
  JsonRpcProvider,
  Wallet,
  ZeroAddress,
  getAddress
} = require("ethers");

const POOL_ABI = [
  "function matt() view returns (address)",
  "function treasury() view returns (address)",
  "function operator() view returns (address)",
  "function ENTRY_FEE() view returns (uint256)",
  "function TREASURY_FEE_PER_ENTRY() view returns (uint256)",
  "function PRIZE_PER_ENTRY() view returns (uint256)",
  "function roundSettled(uint256 roundId) view returns (bool)",
  "function availablePrize(uint256 roundId) view returns (uint256)",
  "function settleRound(uint256 roundId,address first,address second,address third)"
];

const ENTRY_FEE = 50_000n * 10n ** 18n;
const TREASURY_FEE = 1_000n * 10n ** 18n;
const PRIZE_PER_ENTRY = 49_000n * 10n ** 18n;

function createFlappyMattSettlement(options = {}) {
  const rpcUrl = String(options.rpcUrl || process.env.RONIN_RPC_URL || "https://api.roninchain.com/rpc").trim();
  const contractAddress = normalizeAddress(options.contractAddress || process.env.FLAPPY_MATT_POT_ADDRESS);
  const expectedMatt = normalizeAddress(options.expectedMatt || process.env.MATT_CONTRACT);
  const expectedTreasury = normalizeAddress(options.expectedTreasury || process.env.MATT_TREASURY);
  const privateKey = normalizePrivateKey(options.privateKey || process.env.FLAPPY_MATT_OPERATOR_PRIVATE_KEY);

  let provider = null;
  let wallet = null;
  let contract = null;
  let status = {
    enabled: false,
    ready: false,
    contractAddress,
    walletAddress: null,
    operatorAddress: null,
    operatorMatches: false,
    contractMatches: false,
    lastCheckedAt: null,
    lastSettlementAt: null,
    lastSettlementRoundId: null,
    lastTxHash: null,
    lastError: null
  };

  try {
    if (!contractAddress) throw new Error("FLAPPY_MATT_POT_ADDRESS is missing or invalid.");
    if (!privateKey) throw new Error("FLAPPY_MATT_OPERATOR_PRIVATE_KEY is missing or invalid.");
    if (!expectedMatt || !expectedTreasury) throw new Error("MATT contract or treasury configuration is missing.");
    provider = new JsonRpcProvider(rpcUrl, 2020, { staticNetwork: true });
    wallet = new Wallet(privateKey, provider);
    contract = new Contract(contractAddress, POOL_ABI, wallet);
    status.enabled = true;
    status.walletAddress = wallet.address.toLowerCase();
  } catch (error) {
    status.lastError = safe(error);
  }

  async function refreshHealth() {
    if (!status.enabled || !contract || !provider || !wallet) return publicStatus();
    try {
      const [code, network, operator, matt, treasury, entryFee, treasuryFee, prizePerEntry] = await Promise.all([
        provider.getCode(contractAddress),
        provider.getNetwork(),
        contract.operator(),
        contract.matt(),
        contract.treasury(),
        contract.ENTRY_FEE(),
        contract.TREASURY_FEE_PER_ENTRY(),
        contract.PRIZE_PER_ENTRY()
      ]);
      const operatorAddress = getAddress(operator).toLowerCase();
      const contractMatches =
        code !== "0x" &&
        Number(network.chainId) === 2020 &&
        getAddress(matt).toLowerCase() === expectedMatt &&
        getAddress(treasury).toLowerCase() === expectedTreasury &&
        BigInt(entryFee) === ENTRY_FEE &&
        BigInt(treasuryFee) === TREASURY_FEE &&
        BigInt(prizePerEntry) === PRIZE_PER_ENTRY;
      const operatorMatches = operatorAddress === wallet.address.toLowerCase();
      status = {
        ...status,
        ready: contractMatches && operatorMatches,
        operatorAddress,
        operatorMatches,
        contractMatches,
        lastCheckedAt: new Date().toISOString(),
        lastError: contractMatches && operatorMatches
          ? null
          : !contractMatches
            ? "The configured prize contract does not match the official Flappy MATT rules."
            : "The backend keeper wallet is not the contract operator."
      };
    } catch (error) {
      status = {
        ...status,
        ready: false,
        lastCheckedAt: new Date().toISOString(),
        lastError: safe(error)
      };
    }
    return publicStatus();
  }

  async function settle(round) {
    if (!status.ready || !contract) throw new Error(status.lastError || "Flappy MATT settlement is not ready.");
    const roundId = Number(round?.chainRoundId);
    if (!Number.isSafeInteger(roundId) || roundId < 0) throw new Error("The completed round has an invalid on-chain round ID.");

    const alreadySettled = await contract.roundSettled(roundId);
    if (alreadySettled) {
      return { alreadySettled: true, roundId, txHash: null };
    }

    const prize = BigInt(await contract.availablePrize(roundId));
    if (prize === 0n) return { noPrize: true, roundId, txHash: null };

    const [first, second, third] = winnerAddresses(round);
    const transaction = await contract.settleRound(roundId, first, second, third);
    const receipt = await transaction.wait(1);
    const txHash = receipt?.hash || transaction.hash;
    status = {
      ...status,
      lastSettlementAt: new Date().toISOString(),
      lastSettlementRoundId: roundId,
      lastTxHash: txHash,
      lastError: null
    };
    return { alreadySettled: false, noPrize: false, roundId, txHash, blockNumber: receipt?.blockNumber ?? null };
  }

  function publicStatus() {
    return { ...status };
  }

  return {
    refreshHealth,
    settle,
    status: publicStatus,
    isReady: () => Boolean(status.ready)
  };
}

function winnerAddresses(round) {
  const winners = Array.isArray(round?.winners) ? round.winners.slice(0, 3) : [];
  const addresses = winners.map(winner => normalizeAddress(winner?.wallet)).filter(Boolean);
  while (addresses.length < 3) addresses.push(ZeroAddress);
  return addresses;
}

function normalizeAddress(value) {
  const address = String(value || "").trim();
  try { return address ? getAddress(address).toLowerCase() : null; }
  catch { return null; }
}

function normalizePrivateKey(value) {
  const key = String(value || "").trim();
  return /^0x[0-9a-fA-F]{64}$/.test(key) ? key : null;
}

function safe(error) {
  return String(error?.shortMessage || error?.reason || error?.message || error || "Unknown error").slice(0, 240);
}

module.exports = { createFlappyMattSettlement, winnerAddresses };
