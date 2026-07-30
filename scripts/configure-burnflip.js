const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

const poolAbi = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function factory() view returns (address)",
  "function liquidity() view returns (uint128)",
  "function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)",
  "function observe(uint32[] secondsAgos) view returns (int56[] tickCumulatives,uint160[] secondsPerLiquidityCumulativeX128s)",
  "function increaseObservationCardinalityNext(uint16) external",
];

function loadConfig() {
  const file = process.env.BURNFLIP_CONFIG
    || path.join(__dirname, "..", "config", "burnflip.ronin.json");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

async function consult(pool, secondsAgo) {
  const [ticks, secondsPerLiquidity] = await pool.observe([secondsAgo, 0]);
  const tickDelta = ticks[1] - ticks[0];
  let meanTick = tickDelta / BigInt(secondsAgo);
  if (tickDelta < 0n && tickDelta % BigInt(secondsAgo) !== 0n) meanTick -= 1n;
  const liquidityDelta = secondsPerLiquidity[1] - secondsPerLiquidity[0];
  if (liquidityDelta === 0n) throw new Error("zero oracle liquidity delta");
  const harmonicLiquidity = BigInt(secondsAgo) * ((1n << 160n) - 1n)
    / (liquidityDelta << 32n);
  return { meanTick, harmonicLiquidity };
}

async function waitForConsistentQuote(game, asset, amount) {
  let lastError;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      return await game.quoteMatt(asset, amount);
    } catch (error) {
      lastError = error;
      if (attempt < 5) {
        console.log(`Quote read-back pending RPC consistency (${attempt}/5)`);
        await new Promise((resolve) => setTimeout(resolve, 4_000));
      }
    }
  }
  throw lastError;
}

async function validatePool(config, asset, pool) {
  const [factory, token0, token1, liquidity, slot0] = await Promise.all([
    pool.factory(),
    pool.token0(),
    pool.token1(),
    pool.liquidity(),
    pool.slot0(),
  ]);
  if (factory.toLowerCase() !== config.katanaV3Factory.toLowerCase()) {
    throw new Error(`${asset.symbol}: noncanonical factory ${factory}`);
  }
  const pair = [token0.toLowerCase(), token1.toLowerCase()].sort();
  const expected = [asset.oracleToken.toLowerCase(), config.matt.toLowerCase()].sort();
  if (pair[0] !== expected[0] || pair[1] !== expected[1]) {
    throw new Error(`${asset.symbol}: pool token pair mismatch`);
  }
  if (liquidity === 0n) throw new Error(`${asset.symbol}: pool has zero active liquidity`);
  return {
    cardinality: Number(slot0[3]),
    cardinalityNext: Number(slot0[4]),
  };
}

async function main() {
  const config = loadConfig();
  const network = await hre.ethers.provider.getNetwork();
  if (Number(network.chainId) !== config.chainId) {
    throw new Error(`Expected chain ${config.chainId}, connected to ${network.chainId}`);
  }
  const [signer] = await hre.ethers.getSigners();
  if (!signer || signer.address.toLowerCase() !== config.admin.toLowerCase()) {
    throw new Error(`Configuration must be signed by admin ${config.admin}`);
  }

  const gameDeploymentName =
    process.env.BURNFLIP_GAME_DEPLOYMENT || "MattCoinFlipBurn";
  const gameDeployment = await hre.deployments.get(gameDeploymentName);
  const vaultDeployment = await hre.deployments.get("MattRewardVault");
  const game = await hre.ethers.getContractAt(
    "MattCoinFlipBurn",
    gameDeployment.address,
    signer,
  );
  const vault = await hre.ethers.getContractAt(
    "MattRewardVault",
    vaultDeployment.address,
    signer,
  );
  const prepareOnly =
    String(process.env.BURNFLIP_PREPARE_ONLY || "").toLowerCase() === "true";

  if ((await vault.burnFlip()) === hre.ethers.ZeroAddress) {
    await (await vault.configureBurnFlip(game.target)).wait();
  }

  const enabledAssets = config.assets.filter(
    (asset) => asset.enabled !== false,
  );
  for (const asset of enabledAssets) {
    const isMatt = asset.asset.toLowerCase() === config.matt.toLowerCase();
    if (isMatt) {
      if (prepareOnly) {
        console.log(`${asset.symbol}: exact 1:1 identity pricing needs no oracle preparation`);
        continue;
      }
      const current = await game.assetConfigs(asset.asset);
      if (!current.supported) {
        console.log(`${asset.symbol}: adding exact 1:1 identity pricing`);
        await (await game.addSupportedAsset(
          asset.asset,
          hre.ethers.ZeroAddress,
          0,
        )).wait(3);
      } else if (
        current.pool !== hre.ethers.ZeroAddress
        || current.minHarmonicLiquidity !== 0n
      ) {
        throw new Error(`${asset.symbol}: invalid on-chain identity configuration`);
      } else {
        console.log(`${asset.symbol}: already configured at exact 1:1`);
      }
      const quote = await waitForConsistentQuote(
        game,
        asset.asset,
        hre.ethers.parseEther("1"),
      );
      if (quote[0] !== hre.ethers.parseEther("1")) {
        throw new Error(`${asset.symbol}: identity quote is not exactly 1:1`);
      }
      console.log(`${asset.symbol}: ready (exact 1 MATT = 1 MATT)`);
      continue;
    }
    if (!asset.pool || asset.pool === hre.ethers.ZeroAddress) {
      throw new Error(`${asset.symbol}: enabled oracle asset has no pool`);
    }
    const pool = new hre.ethers.Contract(asset.pool, poolAbi, signer);
    const details = await validatePool(config, asset, pool);
    if (details.cardinalityNext < 32) {
      console.log(`${asset.symbol}: increasing observation cardinality to 32`);
      await (await pool.increaseObservationCardinalityNext(32)).wait();
    }
    if (prepareOnly) continue;

    let observation;
    try {
      observation = await consult(pool, config.twapWindowSeconds);
    } catch (error) {
      throw new Error(
        `${asset.symbol}: ${config.twapWindowSeconds}s TWAP is not ready. `
        + "Run with BURNFLIP_PREPARE_ONLY=true, wait for observations/swaps, then retry. "
        + `(${error.shortMessage || error.message})`,
      );
    }

    const minLiquidity = observation.harmonicLiquidity
      * BigInt(config.minimumLiquidityBpsOfObserved) / 10_000n;
    if (minLiquidity === 0n) {
      throw new Error(`${asset.symbol}: derived liquidity floor is zero`);
    }

    const current = await game.assetConfigs(asset.asset);
    if (!current.supported) {
      console.log(`${asset.symbol}: adding ${asset.asset} with pool ${asset.pool}`);
      await (await game.addSupportedAsset(
        asset.asset,
        asset.pool,
        minLiquidity,
      )).wait(3);
    } else if (current.pool.toLowerCase() !== asset.pool.toLowerCase()) {
      console.log(`${asset.symbol}: updating pool/liquidity floor`);
      await (await game.updateV3Pool(
        asset.asset,
        asset.pool,
        minLiquidity,
      )).wait(3);
    } else {
      console.log(
        `${asset.symbol}: already configured; preserving liquidity floor `
        + current.minHarmonicLiquidity,
      );
    }

    const unit = 10n ** BigInt(asset.symbol === "USDC" ? 6 : 18);
    await waitForConsistentQuote(game, asset.asset, unit);
    console.log(
      `${asset.symbol}: ready (tick ${observation.meanTick}, `
      + `harmonic liquidity ${observation.harmonicLiquidity})`,
    );
  }

  if (prepareOnly) {
    console.log("Observation preparation complete. Contracts remain paused.");
    return;
  }

  const matt = await hre.ethers.getContractAt("IERC20", await game.matt());
  console.log(
    `Vault: ${vault.target} (paused=${await vault.paused()}, `
    + `balance=${await matt.balanceOf(vault.target)})`,
  );
  console.log(`Game: ${game.target} (paused=${await game.paused()})`);
  console.log(
    "Fund and unpause the vault, verify every quote, then unpause BurnFlip explicitly.",
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
