"use strict";
const { Interface } = require("ethers");
const nftEvents = new Interface(["event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)"]);

function verifyNftReceipt(receipt, { chainId, expectedChainId, collection, tokenId, depositor, winner, head, finalityBlocks, canonicalBlockHash }) {
  const invalid = reason => ({ verified: false, status: "INVALID", reason });
  if (Number(chainId) !== Number(expectedChainId)) return invalid("WRONG_CHAIN");
  if (!receipt) return { verified: false, status: "PENDING_RECEIPT" };
  if (Number(receipt.status) !== 1) return invalid("REVERTED_TRANSFER");
  if (!canonicalBlockHash || receipt.blockHash.toLowerCase() !== canonicalBlockHash.toLowerCase()) return invalid("NONCANONICAL_RECEIPT");
  let matches = 0;
  let finalReceiver;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== collection.toLowerCase()) continue;
    try {
      const event = nftEvents.parseLog(log);
      if (event?.name === "Transfer" && event.args.tokenId === BigInt(tokenId)) finalReceiver = event.args.to;
      if (event?.name === "Transfer" && event.args.from.toLowerCase() === depositor.toLowerCase() && event.args.to.toLowerCase() === winner.toLowerCase() && event.args.tokenId === BigInt(tokenId)) matches += 1;
    } catch {}
  }
  if (matches !== 1 || finalReceiver?.toLowerCase() !== winner.toLowerCase()) return invalid("EXPECTED_TRANSFER_NOT_FOUND");
  const confirmations = Math.max(0, Number(head) - Number(receipt.blockNumber) + 1);
  if (confirmations < finalityBlocks) return { verified: false, status: "PENDING_CONFIRMATIONS", confirmations, required: finalityBlocks };
  return { verified: true, status: "CONFIRMED_DELIVERY", transactionHash: receipt.hash, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, confirmations, chainId: Number(chainId), receiver: winner, tokenId: String(tokenId) };
}

async function verifyReportedNftDelivery({ manager, roninProvider, nftProvider, roundId, raffleChainId, finalityBlocks }) {
  if (Number(BigInt(await roninProvider.send("eth_chainId", []))) !== raffleChainId) throw new Error("Raffle RPC chain mismatch");
  const round = await manager.getRoundStatus(roundId);
  if (Number(round.phase) !== 8) return { verified: false, status: "NOT_SETTLED" };
  const prize = await manager.getNftPrize(roundId);
  const hash = await manager.reportedNftDelivery(roundId);
  if (/^0x0{64}$/.test(hash)) return { verified: false, status: "AWAITING_OWNER_DELIVERY" };
  const chainId = Number(BigInt(await nftProvider.send("eth_chainId", [])));
  const receipt = await nftProvider.getTransactionReceipt(hash);
  const head = await nftProvider.getBlockNumber();
  const block = receipt ? await nftProvider.getBlock(receipt.blockNumber) : null;
  return verifyNftReceipt(receipt, { chainId, expectedChainId: Number(prize.chainId), collection: prize.collection, tokenId: prize.tokenId, depositor: prize.depositor, winner: prize.winner, head, finalityBlocks, canonicalBlockHash: block?.hash });
}
module.exports = { verifyNftReceipt, verifyReportedNftDelivery };
