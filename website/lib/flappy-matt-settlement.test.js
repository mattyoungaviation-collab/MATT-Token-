const assert = require("assert");
const { ZeroAddress } = require("ethers");
const { createFlappyMattSettlement, winnerAddresses } = require("./flappy-matt-settlement");

const FIRST = "0x1111111111111111111111111111111111111111";
const SECOND = "0x2222222222222222222222222222222222222222";

assert.deepStrictEqual(
  winnerAddresses({ winners: [{ wallet: FIRST }, { wallet: SECOND }] }),
  [FIRST, SECOND, ZeroAddress]
);

assert.deepStrictEqual(
  winnerAddresses({ winners: [] }),
  [ZeroAddress, ZeroAddress, ZeroAddress]
);

const disabled = createFlappyMattSettlement({
  rpcUrl: "https://api.roninchain.com/rpc",
  contractAddress: "0x3333333333333333333333333333333333333333",
  expectedMatt: "0xa5450417BDCa0BDfB058ffE41205400FfDA1174d",
  expectedTreasury: "0xf79913cb83cc9cabd95d0ba9250103fbb939f984",
  privateKey: ""
});

assert.strictEqual(disabled.isReady(), false);
assert.strictEqual(disabled.status().enabled, false);
assert.match(disabled.status().lastError, /operator_private_key/i);

console.log("Flappy MATT settlement helper tests passed.");
