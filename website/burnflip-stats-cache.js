const { Interface, isAddress } = require("ethers");

const CONTRACT = String(process.env.BURNFLIP_CONTRACT_ADDRESS || "").trim();
const DEPLOYMENT_BLOCK = Number.parseInt(
  process.env.BURNFLIP_DEPLOYMENT_BLOCK || "",
  10,
);
const CONFIGURED = isAddress(CONTRACT)
  && Number.isSafeInteger(DEPLOYMENT_BLOCK)
  && DEPLOYMENT_BLOCK >= 0;
const ABI = [
  "function totalMattBurned() view returns (uint256)",
  "function availableRewardBalance() view returns (uint256)",
  "function totalGames() view returns (uint256)",
  "function totalMattPaid() view returns (uint256)",
];
const iface = new Interface(ABI);

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function installBurnFlipStatsCache(app, options) {
  const rpcRequest = options?.rpcRequest;
  if (typeof rpcRequest !== "function") {
    throw new Error("BurnFlip stats cache requires rpcRequest");
  }
  const cacheTtlMs = positiveInteger(
    process.env.BURNFLIP_STATS_CACHE_TTL_MS,
    15_000,
  );
  let snapshot = null;
  let refreshPromise = null;
  let lastError = null;

  if (!CONFIGURED) {
    app.get("/api/burnflip-stats", (_req, res) => {
      res.set("Cache-Control", "no-store");
      return res.status(503).json({
        status: "CONFIG_PENDING",
        message: "Set BURNFLIP_CONTRACT_ADDRESS and BURNFLIP_DEPLOYMENT_BLOCK after deployment.",
      });
    });
    return {
      getStatus: () => ({
        ready: false,
        updating: false,
        indexedThroughBlock: null,
        lastError: "BurnFlip deployment is not configured",
      }),
    };
  }

  async function contractRead(name) {
    const data = iface.encodeFunctionData(name);
    const raw = await rpcRequest("eth_call", [{ to: CONTRACT, data }, "latest"]);
    return BigInt(iface.decodeFunctionResult(name, raw)[0]);
  }

  async function refresh() {
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
      const [burned, available, totalGames, totalPaid, latest] = await Promise.all([
        contractRead("totalMattBurned"),
        contractRead("availableRewardBalance"),
        contractRead("totalGames"),
        contractRead("totalMattPaid"),
        rpcRequest("eth_blockNumber", []),
      ]);
      snapshot = {
        contractAddress: CONTRACT,
        deploymentBlock: DEPLOYMENT_BLOCK,
        indexedThroughBlock: Number(BigInt(latest)),
        totalBurnedRaw: burned.toString(),
        availableRewardRaw: available.toString(),
        totalGames: totalGames.toString(),
        totalPaidRaw: totalPaid.toString(),
        updatedAt: new Date().toISOString(),
        generatedAt: Date.now(),
      };
      lastError = null;
      return snapshot;
    })().catch((error) => {
      lastError = safeMessage(error);
      console.warn("BurnFlip stats refresh failed:", lastError);
      return snapshot;
    }).finally(() => {
      refreshPromise = null;
    });
    return refreshPromise;
  }

  app.get("/api/burnflip-stats", async (req, res) => {
    const force = String(req.query.fresh || "") === "1";
    const stale = !snapshot
      || Date.now() - Number(snapshot.generatedAt || 0) >= cacheTtlMs;
    if (!snapshot || force || stale) await refresh();
    if (!snapshot) {
      res.set("Cache-Control", "no-store");
      return res.status(503).json({
        status: "UNAVAILABLE",
        message: lastError || "BurnFlip statistics are unavailable.",
      });
    }
    res.set(
      "Cache-Control",
      force ? "no-store" : "public, max-age=5, stale-while-revalidate=30",
    );
    return res.json({
      status: "READY",
      updating: Boolean(refreshPromise),
      ...snapshot,
    });
  });

  refresh();
  return {
    getStatus: () => ({
      ready: Boolean(snapshot),
      updating: Boolean(refreshPromise),
      indexedThroughBlock: snapshot?.indexedThroughBlock ?? null,
      lastError,
    }),
  };
}

function safeMessage(error) {
  return String(error?.message || error || "Unknown error").slice(0, 220);
}

module.exports = { installBurnFlipStatsCache };
