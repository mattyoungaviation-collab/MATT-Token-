"use strict";
// Read-only transaction preparation. No wallet, signing key, or broadcast path.
const fs = require("fs");
const { JsonRpcProvider, Contract, Interface } = require("ethers");
async function preparePrizePayouts(manifest, roundId, provider) {
  const actualChainId = Number(BigInt(await provider.send("eth_chainId", [])));
  if (actualChainId !== manifest.chainId) throw new Error("Raffle RPC chain mismatch");
  const abi = require("../../packages/abis/ProjectDynoRaffleManager.json").abi;
  const manager = new Contract(manifest.raffleProxy, abi, provider);
  if ((await manager.multisig()).toLowerCase() !== manifest.multisig.toLowerCase()) throw new Error("Manifest multisig does not match the raffle authority");
  if (Number((await manager.getRoundStatus(roundId)).phase) !== 8) throw new Error("Round must be settled before preparing prize payments");
  const transactions = [];
  for (let i = 0; i < 5; i += 1) {
    if (await manager.prizePaid(roundId, i)) continue;
    const ticketId = await manager.getWinnerTicketId(roundId, i);
    const ticket = await manager.getTicket(ticketId);
    const amount = await manager.prizeAmount(roundId, i);
    transactions.push({ chainId: actualChainId, from: manifest.multisig, target: manifest.raffleProxy, value: "0", data: manager.interface.encodeFunctionData("attemptPrizePayout", [roundId, i]), meaning: `Manually send ${amount} native base units from reserved raffle funds to winner ${ticket.originalWallet}`, draw: i + 1, winnerTicketId: ticketId.toString(), receiver: ticket.originalWallet, prizeAmount: amount.toString(), submitted: false });
  }
  const nft = await manager.getNftPrize(roundId);
  if (nft.winner === "0x0000000000000000000000000000000000000000") throw new Error("NFT winner is not assigned");
  const iface = new Interface(["function safeTransferFrom(address,address,uint256)"]);
  return { warning: "PREPARATION ONLY. Verify all recipients/amounts and sign on the stated chain. Never fund these RON calls again; value is zero because prizes are already reserved.", roundId: String(roundId), ronTransactions: transactions, nftTransaction: { chainId: Number(nft.chainId), from: nft.depositor, target: nft.collection, value: "0", data: iface.encodeFunctionData("safeTransferFrom", [nft.depositor, nft.winner, nft.tokenId]), receiver: nft.winner, tokenId: nft.tokenId.toString(), submitted: false, meaning: "Owner sends the external NFT last. Check ownership and do not resend a successful transfer. Report its real hash on Ronin afterward; receipt verification establishes delivery." } };
}
if (require.main === module) {
  const [file, roundId = "1"] = process.argv.slice(2);
  if (!file) { console.error("Usage: node scripts/dyno/prepare-prize-payouts.js manifest.json [roundId]"); process.exitCode = 1; }
  else {
    const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
    const rpc = process.env[manifest.rpcUrlEnv];
    if (!rpc) { console.error("Private raffle RPC environment variable is required"); process.exitCode = 1; }
    else preparePrizePayouts(manifest, roundId, new JsonRpcProvider(rpc)).then(result => console.log(JSON.stringify(result, null, 2))).catch(() => { console.error("Prize preparation failed. Verify settled round, deployment addresses and RPC; credentials are not logged."); process.exitCode = 1; });
  }
}
module.exports = { preparePrizePayouts };
