"use strict";

const fs = require("node:fs");
const path = require("node:path");
const hre = require("hardhat");

const RONIN_CHAIN_ID = 2020n;
const BPS = 10_000n;
const KYBER_ROUTER = "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5";
const KYBER_API_BASE = "https://aggregator-api.kyberswap.com/ronin/api/v1";
const KYBER_CLIENT_ID = "matt-token-slots";

function parseAmount(name, fallback) {
  const value = String(process.env[name] || fallback);
  if (!/^\d+(\.\d{1,18})?$/.test(value)) {
    throw new Error(`${name} must be a positive decimal amount with at most 18 decimals.`);
  }
  const amount = hre.ethers.parseEther(value);
  if (amount <= 0n) throw new Error(`${name} must be greater than zero.`);
  return { text: value, amount };
}

function parseOptionalAmount(name) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return null;
  return parseAmount(name, raw);
}

function parseInteger(name, fallback, minimum, maximum) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}

function sleep(seconds) {
  return new Promise(resolve => setTimeout(resolve, seconds * 1000));
}

function sleepMilliseconds(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function compactError(error) {
  return error?.shortMessage || error?.reason || error?.message || String(error);
}

function maxBigInt(left, right) {
  return left > right ? left : right;
}

function minBigInt(left, right) {
  return left < right ? left : right;
}

function mulDivUp(value, numerator, denominator) {
  return (value * numerator + denominator - 1n) / denominator;
}

function shrinkAmount(amount, minimum, shrinkBps) {
  let next = amount * shrinkBps / BPS;
  if (next < minimum) next = minimum;
  if (next >= amount) next = amount - 1n;
  return next;
}

function routeSources(routeSummary) {
  const sources = new Set();
  for (const route of routeSummary.route || []) {
    for (const step of route || []) {
      if (step.exchange) sources.add(step.exchange);
    }
  }
  return [...sources];
}

function isRpcRateLimitError(error) {
  let serialized = "";
  try {
    serialized = JSON.stringify(error);
  } catch {
    serialized = "";
  }
  const message = [
    error?.message,
    error?.shortMessage,
    error?.reason,
    error?.code,
    serialized
  ].filter(Boolean).join(" ");
  return /(?:^|\D)429(?:\D|$)|rate.?limit|too many requests|quota|throttl|compute units|capacity exceeded/i.test(message);
}

function installRpcRateLimiter() {
  const minimumIntervalMs = parseInteger("SLOTS_RPC_MIN_INTERVAL_MS", "500", 50, 10_000);
  const retryBaseMs = parseInteger("SLOTS_RPC_RETRY_BASE_MS", "2000", 250, 30_000);
  const maximumBackoffMs = parseInteger(
    "SLOTS_RPC_MAX_BACKOFF_MS",
    "30000",
    1_000,
    120_000
  );
  const maximumRetries = parseInteger("SLOTS_RPC_MAX_RETRIES", "8", 0, 20);
  const pollingIntervalMs = parseInteger(
    "SLOTS_RPC_POLLING_INTERVAL_MS",
    "6000",
    1_000,
    60_000
  );

  const provider = hre.network.provider;
  if (!provider || typeof provider.send !== "function") {
    throw new Error("Hardhat network provider does not expose send().");
  }

  const originalSend = provider.send.bind(provider);
  let queueTail = Promise.resolve();
  let nextAllowedAt = 0;

  provider.send = function rateLimitedSend(method, params = []) {
    const execute = async () => {
      for (let attempt = 0; ; attempt += 1) {
        const spacingDelay = nextAllowedAt - Date.now();
        if (spacingDelay > 0) await sleepMilliseconds(spacingDelay);
        nextAllowedAt = Date.now() + minimumIntervalMs;

        try {
          return await originalSend(method, params);
        } catch (error) {
          if (!isRpcRateLimitError(error) || attempt >= maximumRetries) throw error;
          const retryDelay = Math.min(
            maximumBackoffMs,
            retryBaseMs * (2 ** Math.min(attempt, 6))
          );
          nextAllowedAt = Math.max(nextAllowedAt, Date.now() + retryDelay);
          console.warn("RPC rate limit reached; backing off", {
            method,
            retry: attempt + 1,
            retryDelayMs: retryDelay
          });
        }
      }
    };

    const scheduled = queueTail.then(execute, execute);
    queueTail = scheduled.then(() => undefined, () => undefined);
    return scheduled;
  };

  try {
    hre.ethers.provider.pollingInterval = pollingIntervalMs;
  } catch {
    console.warn("RPC polling interval could not be changed; request serialization remains active.");
  }

  return {
    minimumIntervalMs,
    retryBaseMs,
    maximumBackoffMs,
    maximumRetries,
    pollingIntervalMs
  };
}

async function fetchKyberJson(endpoint, options, timeoutSeconds) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
  try {
    const response = await fetch(`${KYBER_API_BASE}${endpoint}`, {
      ...options,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-client-id": KYBER_CLIENT_ID,
        ...(options?.headers || {})
      },
      signal: controller.signal
    });
    const responseText = await response.text();
    let payload;
    try {
      payload = JSON.parse(responseText);
    } catch {
      throw new Error(`Kyber returned non-JSON HTTP ${response.status}: ${responseText.slice(0, 300)}`);
    }
    if (!response.ok || payload.code !== 0 || !payload.data) {
      throw new Error(`Kyber HTTP ${response.status}: ${payload.message || responseText.slice(0, 300)}`);
    }
    return payload.data;
  } finally {
    clearTimeout(timer);
  }
}

async function getKyberRoute(matt, wrappedRon, amountIn, timeoutSeconds) {
  const query = new URLSearchParams({
    tokenIn: matt,
    tokenOut: wrappedRon,
    amountIn: amountIn.toString()
  });
  const result = await fetchKyberJson(`/routes?${query.toString()}`, { method: "GET" }, timeoutSeconds);
  if (!result.routeSummary || !result.routerAddress) {
    throw new Error("Kyber route response is missing routeSummary or routerAddress.");
  }

  const routeSummary = result.routeSummary;
  const routerAddress = hre.ethers.getAddress(result.routerAddress);
  if (routerAddress !== hre.ethers.getAddress(KYBER_ROUTER)) {
    throw new Error(`Kyber returned unexpected router ${routerAddress}.`);
  }
  if (
    hre.ethers.getAddress(routeSummary.tokenIn) !== hre.ethers.getAddress(matt)
    || hre.ethers.getAddress(routeSummary.tokenOut) !== hre.ethers.getAddress(wrappedRon)
  ) {
    throw new Error("Kyber returned an unexpected token pair.");
  }
  if (BigInt(routeSummary.amountIn) !== amountIn) {
    throw new Error(`Kyber returned amountIn ${routeSummary.amountIn}; expected ${amountIn}.`);
  }

  return {
    routeSummary,
    routerAddress,
    amountOut: BigInt(routeSummary.amountOut)
  };
}

async function buildKyberRoute(
  routeSummary,
  converterAddress,
  slippageBps,
  deadlineSeconds,
  timeoutSeconds
) {
  const deadline = Math.floor(Date.now() / 1000) + deadlineSeconds;
  const result = await fetchKyberJson(
    "/route/build",
    {
      method: "POST",
      body: JSON.stringify({
        routeSummary,
        sender: converterAddress,
        recipient: converterAddress,
        slippageTolerance: Number(slippageBps),
        deadline,
        source: KYBER_CLIENT_ID
      })
    },
    timeoutSeconds
  );

  if (!result.routerAddress || !hre.ethers.isHexString(result.data) || result.data.length < 10) {
    throw new Error("Kyber build response is missing routerAddress or calldata.");
  }
  const routerAddress = hre.ethers.getAddress(result.routerAddress);
  if (routerAddress !== hre.ethers.getAddress(KYBER_ROUTER)) {
    throw new Error(`Kyber build returned unexpected router ${routerAddress}.`);
  }
  if (BigInt(result.transactionValue || "0") !== 0n) {
    throw new Error(`Kyber build unexpectedly requires native RON value ${result.transactionValue}.`);
  }
  if (result.amountIn && BigInt(result.amountIn) !== BigInt(routeSummary.amountIn)) {
    throw new Error(`Kyber build changed amountIn to ${result.amountIn}.`);
  }

  return {
    routerCall: result.data,
    amountOut: BigInt(result.amountOut || routeSummary.amountOut),
    gas: result.gas || routeSummary.gas
  };
}

async function main() {
  const rpcLimiter = installRpcRateLimiter();
  const quoteOnly = process.env.SLOTS_AUTO_QUOTE_ONLY === "YES";
  if (!quoteOnly && process.env.CONFIRM_AUTO_SLOTS_CONVERSION !== "YES") {
    throw new Error(
      "Automatic conversion is locked. Set CONFIRM_AUTO_SLOTS_CONVERSION=YES only after reviewing the Kyber quote and safety settings."
    );
  }

  const network = await hre.ethers.provider.getNetwork();
  if (network.chainId !== RONIN_CHAIN_ID) {
    throw new Error(`Expected Ronin mainnet chain 2020, received ${network.chainId}.`);
  }

  const deploymentPath = process.env.SLOTS_DEPLOYMENT_FILE
    || path.join(__dirname, "../deployment-exports/slots-ronin.json");
  const deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));
  const [signer] = await hre.ethers.getSigners();
  if (!signer) throw new Error("No signer is configured.");

  const converter = await hre.ethers.getContractAt(
    "MattSlotsTreasuryConverter",
    deployment.contracts.converter,
    signer
  );
  const converterAddress = await converter.getAddress();
  const owner = await converter.owner();
  const keeper = await converter.keeper();
  const signerAddress = await signer.getAddress();
  if (![owner.toLowerCase(), keeper.toLowerCase()].includes(signerAddress.toLowerCase())) {
    throw new Error(`Signer ${signerAddress} is neither converter owner nor keeper.`);
  }
  if (await converter.paused()) throw new Error("The Slots converter is paused.");

  const configuredRouter = hre.ethers.getAddress(await converter.router());
  if (configuredRouter !== hre.ethers.getAddress(KYBER_ROUTER)) {
    throw new Error(
      `Converter router is ${configuredRouter}. Run npm run configure:slots-kyber-router:ronin first.`
    );
  }

  const matt = await converter.matt();
  const wrappedRon = await converter.wrappedRon();
  const treasury = await converter.treasury();
  const { text: maxBatchText, amount: maxBatchAmount } = parseAmount(
    "SLOTS_AUTO_BATCH_MATT",
    "30000"
  );
  const { text: startBatchText, amount: startBatchAmount } = parseAmount(
    "SLOTS_AUTO_START_BATCH_MATT",
    maxBatchText
  );
  const { text: minBatchText, amount: minBatchAmount } = parseAmount(
    "SLOTS_AUTO_MIN_BATCH_MATT",
    "1000"
  );
  if (minBatchAmount > startBatchAmount || startBatchAmount > maxBatchAmount) {
    throw new Error(
      "Require SLOTS_AUTO_MIN_BATCH_MATT <= SLOTS_AUTO_START_BATCH_MATT <= SLOTS_AUTO_BATCH_MATT."
    );
  }

  const { text: minimumSignerRonText, amount: minimumSignerRon } = parseAmount(
    "SLOTS_AUTO_MIN_SIGNER_RON",
    "0.1"
  );
  const cooldownSeconds = parseInteger("SLOTS_AUTO_COOLDOWN_SECONDS", "5", 5, 86_400);
  const retrySeconds = parseInteger("SLOTS_AUTO_RETRY_SECONDS", "15", 5, 3_600);
  const requiredMarginBps = BigInt(parseInteger("SLOTS_AUTO_MARGIN_BPS", "25", 0, 500));
  const routeSlippageBps = BigInt(
    parseInteger("SLOTS_AUTO_ROUTE_SLIPPAGE_BPS", "100", 1, 500)
  );
  const growthBps = BigInt(parseInteger("SLOTS_AUTO_GROWTH_BPS", "20000", 10_001, 50_000));
  const shrinkBps = BigInt(parseInteger("SLOTS_AUTO_SHRINK_BPS", "5000", 100, 9_000));
  const maxTransactions = parseInteger("SLOTS_AUTO_MAX_TRANSACTIONS", "0", 0, 1_000_000);
  const deadlineSeconds = parseInteger("SLOTS_AUTO_DEADLINE_SECONDS", "300", 60, 1_200);
  const confirmations = parseInteger("SLOTS_AUTO_CONFIRMATIONS", "2", 1, 5);
  const apiTimeoutSeconds = parseInteger("SLOTS_KYBER_TIMEOUT_SECONDS", "15", 5, 60);
  const transactionsPerMinute = parseInteger("SLOTS_AUTO_TXS_PER_MINUTE", "0", 0, 60);
  const pacedIntervalMs = transactionsPerMinute === 0
    ? 0
    : Math.ceil(60_000 / transactionsPerMinute);

  let pending = await converter.pendingMatt();
  const requestedTarget = parseOptionalAmount("SLOTS_AUTO_TOTAL_MATT");
  const targetAmount = requestedTarget ? requestedTarget.amount : pending;
  if (targetAmount > pending) {
    throw new Error(
      `SLOTS_AUTO_TOTAL_MATT ${hre.ethers.formatEther(targetAmount)} exceeds pending MATT ${hre.ethers.formatEther(pending)}.`
    );
  }
  let remainingTarget = targetAmount;
  const scheduleStartedAt = Date.now();
  let currentBatch = startBatchAmount;
  console.log("Automatic Slots Kyber conversion started", {
    network: "Ronin mainnet",
    converter: converterAddress,
    router: configuredRouter,
    treasury,
    signer: signerAddress,
    pendingMatt: hre.ethers.formatEther(pending),
    startBatchMatt: startBatchText,
    maximumBatchMatt: maxBatchText,
    minimumBatchMatt: minBatchText,
    cooldownSeconds,
    retrySeconds,
    requiredMarginBps: requiredMarginBps.toString(),
    routeSlippageBps: routeSlippageBps.toString(),
    growthBps: growthBps.toString(),
    shrinkBps: shrinkBps.toString(),
    minimumSignerRon: minimumSignerRonText,
    maxTransactions: maxTransactions || "unlimited",
    totalTargetMatt: hre.ethers.formatEther(targetAmount),
    transactionsPerMinute: transactionsPerMinute || "cooldown mode",
    scheduledIntervalSeconds: pacedIntervalMs ? pacedIntervalMs / 1000 : null,
    rpcMinimumIntervalMs: rpcLimiter.minimumIntervalMs,
    rpcPollingIntervalMs: rpcLimiter.pollingIntervalMs,
    rpcMaximumRetries: rpcLimiter.maximumRetries,
    quoteOnly,
    note: quoteOnly
      ? "Quote-only mode: calldata will be built and simulated, but no transaction will be sent."
      : "Press Ctrl+C to stop safely. No vault loss will be flushed by this script."
  });

  let completed = 0;
  while (
    pending > 0n
    && remainingTarget > 0n
    && (maxTransactions === 0 || completed < maxTransactions)
  ) {
    if (await converter.paused()) throw new Error("Converter was paused; stopping.");
    if (hre.ethers.getAddress(await converter.router()) !== hre.ethers.getAddress(KYBER_ROUTER)) {
      throw new Error("Converter router changed while automation was running; stopping.");
    }

    const signerRon = await hre.ethers.provider.getBalance(signerAddress);
    if (signerRon < minimumSignerRon) {
      throw new Error(
        `Signer RON ${hre.ethers.formatEther(signerRon)} is below the required ${minimumSignerRonText} RON reserve.`
      );
    }

    if (pacedIntervalMs > 0 && completed > 0) {
      const scheduledAt = scheduleStartedAt + completed * pacedIntervalMs;
      const waitMilliseconds = scheduledAt - Date.now();
      if (waitMilliseconds > 0) await sleepMilliseconds(waitMilliseconds);
    }

    const amountIn = minBigInt(minBigInt(pending, remainingTarget), currentBatch);
    let twapQuote;
    let harmonicLiquidity;
    let route;
    try {
      [twapQuote, harmonicLiquidity] = await converter.quoteTwap(amountIn);
      const minimumHarmonicLiquidity = await converter.minHarmonicLiquidity();
      if (harmonicLiquidity < minimumHarmonicLiquidity) {
        throw new Error(
          `Oracle harmonic liquidity ${harmonicLiquidity} is below ${minimumHarmonicLiquidity}.`
        );
      }
      route = await getKyberRoute(matt, wrappedRon, amountIn, apiTimeoutSeconds);
    } catch (error) {
      console.warn("Kyber quote failed; no transaction sent", {
        mattIn: hre.ethers.formatEther(amountIn),
        error: compactError(error),
        retrySeconds
      });
      await sleep(retrySeconds);
      pending = await converter.pendingMatt();
      continue;
    }

    const contractSlippageBps = BigInt(await converter.maxSlippageBps());
    const contractFloor = twapQuote * (BPS - contractSlippageBps) / BPS;
    const guardedFloor = mulDivUp(contractFloor, BPS + requiredMarginBps, BPS);
    if (route.amountOut < guardedFloor) {
      if (amountIn > minBatchAmount && pending > minBatchAmount) {
        const nextBatch = shrinkAmount(amountIn, minBatchAmount, shrinkBps);
        console.log("Kyber quote below protected floor; reducing batch", {
          mattIn: hre.ethers.formatEther(amountIn),
          kyberQuoteWron: hre.ethers.formatEther(route.amountOut),
          contractFloorWron: hre.ethers.formatEther(contractFloor),
          guardedFloorWron: hre.ethers.formatEther(guardedFloor),
          nextBatchMatt: hre.ethers.formatEther(nextBatch),
          sources: routeSources(route.routeSummary)
        });
        currentBatch = nextBatch;
        await sleep(1);
        continue;
      }
      console.log("Kyber quote below protected floor at minimum batch; waiting", {
        mattIn: hre.ethers.formatEther(amountIn),
        kyberQuoteWron: hre.ethers.formatEther(route.amountOut),
        contractFloorWron: hre.ethers.formatEther(contractFloor),
        guardedFloorWron: hre.ethers.formatEther(guardedFloor),
        sources: routeSources(route.routeSummary),
        retrySeconds
      });
      await sleep(retrySeconds);
      pending = await converter.pendingMatt();
      continue;
    }

    let built;
    try {
      built = await buildKyberRoute(
        route.routeSummary,
        converterAddress,
        routeSlippageBps,
        deadlineSeconds,
        apiTimeoutSeconds
      );
    } catch (error) {
      console.warn("Kyber calldata build failed; no transaction sent", {
        mattIn: hre.ethers.formatEther(amountIn),
        error: compactError(error),
        retrySeconds
      });
      await sleep(retrySeconds);
      pending = await converter.pendingMatt();
      continue;
    }

    if (built.amountOut < guardedFloor) {
      if (amountIn > minBatchAmount && pending > minBatchAmount) {
        currentBatch = shrinkAmount(amountIn, minBatchAmount, shrinkBps);
        console.log("Kyber build quote moved below protected floor; reducing batch", {
          mattIn: hre.ethers.formatEther(amountIn),
          kyberQuoteWron: hre.ethers.formatEther(built.amountOut),
          guardedFloorWron: hre.ethers.formatEther(guardedFloor),
          nextBatchMatt: hre.ethers.formatEther(currentBatch)
        });
        await sleep(1);
        continue;
      }
      await sleep(retrySeconds);
      pending = await converter.pendingMatt();
      continue;
    }

    const routeMinimum = built.amountOut * (BPS - routeSlippageBps) / BPS;
    const minimumOut = maxBigInt(routeMinimum, guardedFloor);

    let gasEstimate;
    try {
      gasEstimate = await converter.convert.estimateGas(amountIn, minimumOut, built.routerCall);
    } catch (error) {
      console.warn("Protected Kyber conversion simulation failed; no transaction sent", {
        mattIn: hre.ethers.formatEther(amountIn),
        kyberQuoteWron: hre.ethers.formatEther(built.amountOut),
        minimumWronOut: hre.ethers.formatEther(minimumOut),
        error: compactError(error),
        retrySeconds
      });
      await sleep(retrySeconds);
      pending = await converter.pendingMatt();
      continue;
    }

    const routeReport = {
      mattIn: hre.ethers.formatEther(amountIn),
      kyberQuoteWron: hre.ethers.formatEther(built.amountOut),
      twapQuoteWron: hre.ethers.formatEther(twapQuote),
      contractFloorWron: hre.ethers.formatEther(contractFloor),
      minimumWronOut: hre.ethers.formatEther(minimumOut),
      harmonicLiquidity: harmonicLiquidity.toString(),
      sources: routeSources(route.routeSummary),
      routeId: route.routeSummary.routeID,
      estimatedGas: gasEstimate.toString()
    };

    if (quoteOnly) {
      console.log("Protected Kyber route is executable; no transaction sent", routeReport);
      return;
    }

    const ronBefore = await converter.totalRonForwarded();
    const tx = await converter.convert(amountIn, minimumOut, built.routerCall, {
      gasLimit: gasEstimate * 120n / 100n
    });
    console.log("Kyber conversion broadcast", {
      batch: completed + 1,
      hash: tx.hash,
      ...routeReport
    });

    const receipt = await tx.wait(confirmations);
    if (!receipt || receipt.status !== 1) {
      throw new Error(`Kyber conversion failed or was not confirmed: ${tx.hash}`);
    }

    const ronAfter = await converter.totalRonForwarded();
    completed += 1;
    pending = await converter.pendingMatt();
    remainingTarget -= amountIn;
    console.log("Kyber conversion confirmed", {
      batch: completed,
      hash: tx.hash,
      blockNumber: receipt.blockNumber,
      mattConverted: hre.ethers.formatEther(amountIn),
      ronForwarded: hre.ethers.formatEther(ronAfter - ronBefore),
      pendingMatt: hre.ethers.formatEther(pending),
      targetRemainingMatt: hre.ethers.formatEther(remainingTarget)
    });

    if (
      pending === 0n
      || remainingTarget === 0n
      || (maxTransactions !== 0 && completed >= maxTransactions)
    ) break;

    let grown = currentBatch * growthBps / BPS;
    if (grown <= currentBatch) grown = currentBatch + 1n;
    currentBatch = minBigInt(maxBatchAmount, grown);
    if (pacedIntervalMs === 0) await sleep(cooldownSeconds);
  }

  console.log("Automatic Slots Kyber conversion stopped", {
    transactions: completed,
    pendingMatt: hre.ethers.formatEther(await converter.pendingMatt()),
    targetRemainingMatt: hre.ethers.formatEther(remainingTarget)
  });
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
