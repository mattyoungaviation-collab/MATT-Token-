const { ethers } = require("ethers");

const DEFAULT_VAULT = "0x715C79bcb0AA4DBccc79AfE2C19176B81193F842";
const DEFAULT_MATT = "0xa5450417BDCa0BDfB058ffE41205400FfDA1174d";
const EXPECTED_CHAIN_ID = 2020n;

const VAULT_ABI = [
  "function paused() view returns (bool)",
  "function settlementOperator() view returns (address)",
  "function availableBankroll() view returns (uint256)",
  "function claimable(address) view returns (uint256)",
  "function wagers(bytes32) view returns (address player,uint128 amount,uint64 openedAt,bool settled)",
  "function settleWager(bytes32 wagerId,uint8 outcome)",
  "event WagerOpened(bytes32 indexed wagerId,bytes32 indexed roundId,address indexed player,uint256 amount)",
  "event WagerSettled(bytes32 indexed wagerId,address indexed player,uint8 outcome,uint256 returnedPrincipal,uint256 profit,uint256 burned)"
];

function createBlackjackChain() {
  const rpcUrl = String(process.env.RONIN_RPC_URL || "https://api.roninchain.com/rpc").trim();
  const vaultAddress = String(process.env.BLACKJACK_VAULT_ADDRESS || DEFAULT_VAULT).trim();
  const operatorKey = String(process.env.BLACKJACK_OPERATOR_PRIVATE_KEY || "").trim();
  const enabled = ethers.isAddress(vaultAddress) && /^0x[0-9a-fA-F]{64}$/.test(operatorKey);

  const provider = new ethers.JsonRpcProvider(rpcUrl, Number(EXPECTED_CHAIN_ID), { staticNetwork: true });
  const reader = new ethers.Contract(vaultAddress, VAULT_ABI, provider);
  const signer = enabled ? new ethers.Wallet(operatorKey, provider) : null;
  const writer = signer ? reader.connect(signer) : null;
  const iface = new ethers.Interface(VAULT_ABI);

  async function health() {
    try {
      const network = await provider.getNetwork();
      const [paused, operator, bankroll] = await Promise.all([
        reader.paused(),
        reader.settlementOperator(),
        reader.availableBankroll()
      ]);
      const signerAddress = signer ? await signer.getAddress() : null;
      return {
        configured: enabled,
        connected: network.chainId === EXPECTED_CHAIN_ID,
        chainId: Number(network.chainId),
        vaultAddress,
        mattAddress: DEFAULT_MATT,
        paused,
        operator,
        signerAddress,
        operatorMatches: Boolean(signerAddress && operator.toLowerCase() === signerAddress.toLowerCase()),
        availableBankroll: bankroll.toString()
      };
    } catch (error) {
      return { configured: enabled, connected: false, vaultAddress, mattAddress: DEFAULT_MATT, error: safeError(error) };
    }
  }

  async function playerStatus(wallet) {
    if (!ethers.isAddress(wallet)) throw new Error("Invalid player wallet.");
    const [claimable, paused, bankroll] = await Promise.all([
      reader.claimable(wallet),
      reader.paused(),
      reader.availableBankroll()
    ]);
    return { claimable: claimable.toString(), paused, availableBankroll: bankroll.toString() };
  }

  async function verifyOpenWager({ txHash, player, roundId, amountMatt }) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(String(txHash || ""))) throw new Error("A valid wager transaction hash is required.");
    if (!ethers.isAddress(player)) throw new Error("Invalid player wallet.");
    if (!/^0x[0-9a-fA-F]{64}$/.test(String(roundId || ""))) throw new Error("Invalid contract round ID.");

    const receipt = await provider.waitForTransaction(txHash, 1, 120_000);
    if (!receipt || receipt.status !== 1) throw new Error("Wager transaction was not confirmed.");
    const expectedAmount = ethers.parseUnits(String(amountMatt), 18);

    for (const log of receipt.logs) {
      if (String(log.address).toLowerCase() !== vaultAddress.toLowerCase()) continue;
      try {
        const parsed = iface.parseLog(log);
        if (parsed?.name !== "WagerOpened") continue;
        const [wagerId, eventRoundId, eventPlayer, eventAmount] = parsed.args;
        if (String(eventRoundId).toLowerCase() !== String(roundId).toLowerCase()) throw new Error("Wager used the wrong table round.");
        if (String(eventPlayer).toLowerCase() !== String(player).toLowerCase()) throw new Error("Wager belongs to a different wallet.");
        if (eventAmount !== expectedAmount) throw new Error("Wager amount does not match the selected bet.");
        return { wagerId: String(wagerId), txHash: receipt.hash, blockNumber: receipt.blockNumber };
      } catch (error) {
        if (/wrong table|different wallet|does not match/.test(String(error.message))) throw error;
      }
    }
    throw new Error("The transaction did not open a wager in the configured blackjack vault.");
  }

  async function settleWager(wagerId, outcome) {
    if (!writer) throw new Error("Blackjack settlement operator is not configured on the server.");
    const state = await reader.wagers(wagerId);
    if (!state.player || state.player === ethers.ZeroAddress || state.settled) {
      return { alreadySettled: true, txHash: null };
    }
    const tx = await writer.settleWager(wagerId, outcome);
    const receipt = await tx.wait(1);
    return { alreadySettled: false, txHash: receipt.hash, blockNumber: receipt.blockNumber };
  }

  return { enabled, vaultAddress, mattAddress: DEFAULT_MATT, health, playerStatus, verifyOpenWager, settleWager };
}

function safeError(error) {
  return String(error?.shortMessage || error?.reason || error?.message || error).slice(0, 240);
}

module.exports = { createBlackjackChain };