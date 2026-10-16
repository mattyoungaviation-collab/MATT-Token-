"use strict";

// Read-only inspection. Never signs, deploys, approves, or transfers assets.
const { Interface } = require("ethers");
const manifest = require("../../config/project-dyno.ronin.example.json");
const roninUrl = process.env.RONIN_RPC_URL || "https://api.roninchain.com/rpc";
const ethereumUrl = process.env.DYNO_ETHEREUM_RPC_URL || "https://ethereum-rpc.publicnode.com";
async function rpc(url, method, params = []) {
  const response = await fetch(url, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
  const body = await response.json();
  if (body.error) throw new Error(`RPC error ${body.error.code}`);
  return body.result;
}
async function call(url, address, signature, args = []) {
  const iface = new Interface([signature]);
  const fn = iface.fragments[0];
  const result = await rpc(url, "eth_call", [{ to: address, data: iface.encodeFunctionData(fn, args) }, "latest"]);
  return iface.decodeFunctionResult(fn, result)[0];
}
async function inspect() {
  const output = { readOnly: true, observedAt: new Date().toISOString() };
  for (const [network, url] of [["ronin", roninUrl], ["ethereum", ethereumUrl]]) {
    const chainId = Number(BigInt(await rpc(url, "eth_chainId")));
    const block = Number(BigInt(await rpc(url, "eth_blockNumber")));
    const code = await rpc(url, "eth_getCode", [manifest.nftCollection, "latest"]);
    output[network] = { chainId, block, collectionCodeBytes: (code.length - 2) / 2 };
    if (code !== "0x") {
      output[network].erc721 = await call(url, manifest.nftCollection, "function supportsInterface(bytes4) view returns(bool)", ["0x80ac58cd"]);
      output[network].ownerOf1358 = await call(url, manifest.nftCollection, "function ownerOf(uint256) view returns(address)", [1358]);
      output[network].matchesProposedDepositor = output[network].ownerOf1358.toLowerCase() === manifest.nftDepositor.toLowerCase();
    }
    if (network === "ronin") {
      const code = await rpc(url, "eth_getCode", [manifest.multisig, "latest"]);
      output[network].multisigCodeBytes = (code.length - 2) / 2;
      if (code !== "0x") {
        output[network].multisigThreshold = Number(await call(url, manifest.multisig, "function getThreshold() view returns(uint256)"));
        output[network].multisigOwners = Array.from(await call(url, manifest.multisig, "function getOwners() view returns(address[])"));
      }
    }
  }
  return output;
}
if (require.main === module) inspect().then(value => console.log(JSON.stringify(value, null, 2))).catch(() => { console.error("Read-only inspection failed. Check RPC access; endpoint credentials are not logged."); process.exitCode = 1; });
module.exports = { inspect };
