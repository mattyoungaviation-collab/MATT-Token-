"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { adaptForkConfig } = require("./fork-runtime-compat");

test("fork bridge preserves exact chain/hardfork values without mutating source or ordinary runtime", () => {
  const ordinary = { chainId: 31337n };
  assert.equal(adaptForkConfig(ordinary), ordinary);
  const history = [{ condition: { blockNumber: 43254600n }, hardfork: "Cancun" }];
  const source = { ...ordinary, fork: { blockNumber: 62188916n, chainOverrides: [{ chainId: 2020n, name: "Ronin", hardforks: history }] } };
  const result = adaptForkConfig(source);
  assert.equal(result.fork.blockNumber, source.fork.blockNumber);
  assert.equal(result.fork.chainOverrides[0].chainId, 2020n);
  assert.equal(result.fork.chainOverrides[0].hardforkActivationOverrides, history);
  assert.equal(source.fork.chainOverrides[0].hardforks, history);
  assert.equal(result.fork.chainOverrides[0].hardforks, undefined);
  assert.deepEqual(adaptForkConfig(result), result);
});
