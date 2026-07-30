const fs = require("fs");
const { Contract, JsonRpcProvider, ZeroAddress } = require("ethers");

const MATT = "0xa5450417BDCa0BDfB058ffE41205400FfDA1174d";
const KATANA_V3_FACTORY = "0x1f0B70d9A137e3cAEF0ceAcD312BC5f81Da0cC0c";
const ASSETS = [
  ["RON", "0xe514d9DEB7966c8BE0ca922de8a064264eA6bcd4"],
  ["USDC", "0x0B7007c13325C48911F73A2daD5FA5dCBf808aDc"],
  ["WATER", "0x57A8Eb80d6813AEEEB9c8e770011C016F980d581"],
  ["FIRE", "0x0E8Edc6f5CaC5dCaE036Ad77Fc0dE4E72404e2Fb"],
  ["EARTH", "0xC89384CD2970c916DC75DA8e11524eBE6d77fa07"],
  ["COIN", "0x7dc167e270d5EF683ceaf4aFCDf2efbDd667a9A7"],
  ["RONKE", "0xf988f63bf26C3Ed3fBf39922149E3E7b1e5c27cB"],
  ["NOTUS", "0x214b8ba88244587b69c609214e0b3e6cf56025d1"],
];
const FEE_TIERS = [100, 500, 2500, 3000, 10000];

const factoryAbi = [
  "function getPool(address tokenA,address tokenB,uint24 fee) view returns (address)",
];
const tokenAbi = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
];
const poolAbi = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function liquidity() view returns (uint128)",
  "function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)",
  "function observe(uint32[] secondsAgos) view returns (int56[] tickCumulatives,uint160[] secondsPerLiquidityCumulativeX128s)",
];

async function safe(call, fallback) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const result = await call();
      await new Promise((resolve) => setTimeout(resolve, 350));
      return result;
    } catch (error) {
      if (attempt === 4 || !/too many requests|429|rate limit/i.test(String(error?.message || error))) {
        return fallback;
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000 * (attempt + 1)));
    }
  }
  return fallback;
}

async function main() {
  const provider = new JsonRpcProvider(
    process.env.RONIN_RPC_URL || "https://api.roninchain.com/rpc",
    2020,
  );
  const factory = new Contract(KATANA_V3_FACTORY, factoryAbi, provider);
  const results = [];

  for (const [requestedSymbol, tokenAddress] of ASSETS) {
    const token = new Contract(tokenAddress, tokenAbi, provider);
    const onchainSymbol = await safe(() => token.symbol(), "<unavailable>");
    const decimals = await safe(() => token.decimals(), null);
    const pools = [];

    for (const fee of FEE_TIERS) {
      const address = await safe(
        () => factory.getPool(tokenAddress, MATT, fee),
        ZeroAddress,
      );
      if (address === ZeroAddress) continue;
      const pool = new Contract(address, poolAbi, provider);
      const token0 = await safe(() => pool.token0(), ZeroAddress);
      const token1 = await safe(() => pool.token1(), ZeroAddress);
      const poolFee = await safe(() => pool.fee(), fee);
      const liquidity = await safe(() => pool.liquidity(), 0n);
      const slot0 = await safe(() => pool.slot0(), [0n, 0n, 0n, 0n, 0n, 0n, false]);
      const twapReady = await safe(async () => {
        await pool.observe([1800, 0]);
        return true;
      }, false);
      pools.push({
        fee: Number(poolFee),
        address,
        token0,
        token1,
        liquidity: liquidity.toString(),
        observationCardinality: Number(slot0[3]),
        observationCardinalityNext: Number(slot0[4]),
        thirtyMinuteTwapReady: twapReady,
      });
    }

    results.push({
      requestedSymbol,
      address: tokenAddress,
      onchainSymbol,
      decimals: decimals == null ? null : Number(decimals),
      pools,
    });
  }

  const output = JSON.stringify({
    chainId: Number((await provider.getNetwork()).chainId),
    matt: MATT,
    factory: KATANA_V3_FACTORY,
    assets: results,
  }, null, 2);
  if (process.env.BURNFLIP_POOL_DISCOVERY_OUTPUT) {
    fs.writeFileSync(process.env.BURNFLIP_POOL_DISCOVERY_OUTPUT, `${output}\n`);
  }
  console.log(output);
  provider.destroy();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
