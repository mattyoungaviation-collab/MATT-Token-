"use strict";

const fs = require("fs");
const { AbiCoder, getAddress, keccak256, solidityPacked } = require("ethers");

function draw(seed, chainId, proxy, roundId, prizeIndex, eligibleTicketIds) {
  const max = (1n << 256n) - 1n;
  const count = BigInt(eligibleTicketIds.length);
  const limit = max - (max % count);
  const coder = AbiCoder.defaultAbiCoder();
  for (let counter = 0n; ; counter += 1n) {
    const hash = BigInt(keccak256(coder.encode(
      ["uint256", "uint256", "address", "uint256", "uint8", "uint256"],
      [BigInt(seed), BigInt(chainId), getAddress(proxy), BigInt(roundId), prizeIndex, counter]
    )));
    if (hash < limit) return { index: Number(hash % count), ticketId: String(eligibleTicketIds[Number(hash % count)]), counter: counter.toString() };
  }
}

function replay(input) {
  if (!Array.isArray(input.eligibleTicketIds) || input.eligibleTicketIds.length !== 1000) throw new Error("eligibleTicketIds must contain the frozen 1,000-member index order");
  return Array.from({ length: 6 }, (_, prizeIndex) => ({ prizeIndex, ...draw(input.seed, input.chainId, input.proxy, input.roundId, prizeIndex, input.eligibleTicketIds) }));
}

if (require.main === module) {
  const file = process.argv[2];
  if (!file) throw new Error("Usage: node scripts/dyno/replay-winners.js replay-input.json");
  console.log(JSON.stringify(replay(JSON.parse(fs.readFileSync(file, "utf8"))), null, 2));
}
module.exports = { draw, replay };
