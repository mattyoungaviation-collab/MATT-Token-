(() => {
  "use strict";

  const MATT = "0xa5450417BDCa0BDfB058ffE41205400FfDA1174d";
  const CHAIN_ID = 2020;
  const CHAIN_HEX = "0x7e4";
  const TOKEN_ABI = ["function balanceOf(address) view returns (uint256)"];
  const $ = id => document.getElementById(id);
  const formatCompact = value => Number(value || 0).toLocaleString(undefined, { notation: "compact", maximumFractionDigits: 2 });
  const formatMattRaw = raw => {
    try { return `${Number(window.ethers.formatEther(BigInt(raw || 0))).toLocaleString(undefined, { maximumFractionDigits: 0 })} MATT`; }
    catch { return "—"; }
  };
  const shortAddress = value => value ? `${value.slice(0, 6)}…${value.slice(-4)}` : "CONNECT RONIN";

  let browserProvider = null;
  let signer = null;
  let wallet = null;
  let token = null;

  function roninProvider() { return window.ronin?.provider || null; }

  async function ensureRoninChain() {
    const provider = roninProvider();
    if (!provider) throw new Error("Ronin Wallet was not detected.");
    const chain = await provider.request({ method: "eth_chainId" });
    const normalized = typeof chain === "number" ? chain : String(chain).startsWith("0x") ? Number.parseInt(String(chain), 16) : Number(chain);
    if (normalized !== CHAIN_ID) await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN_HEX }] });
  }

  async function activate(address) {
    await ensureRoninChain();
    browserProvider = new window.ethers.BrowserProvider(roninProvider());
    signer = await browserProvider.getSigner(window.ethers.getAddress(address));
    wallet = await signer.getAddress();
    token = new window.ethers.Contract(MATT, TOKEN_ABI, signer);
    $("wallet-label").textContent = shortAddress(wallet);
    await refreshWalletBalance();
  }

  async function refreshWalletBalance() {
    if (!wallet || !token) return;
    try {
      const balance = await token.balanceOf(wallet);
      $("wallet-balance").textContent = formatMattRaw(balance);
    } catch {
      $("wallet-balance").textContent = "BALANCE UNAVAILABLE";
    }
  }

  async function connectWallet() {
    try {
      const provider = roninProvider();
      if (!provider) throw new Error("Install Ronin Wallet or open this site inside the Ronin mobile app.");
      await ensureRoninChain();
      const accounts = await provider.request({ method: "eth_requestAccounts" });
      if (!accounts?.[0]) throw new Error("No Ronin account was approved.");
      await activate(accounts[0]);
    } catch (error) {
      $("wallet-label").textContent = "CONNECTION FAILED";
      $("wallet-balance").textContent = String(error.message || error).slice(0, 40);
    }
  }

  async function restoreWallet() {
    const provider = roninProvider();
    if (!provider) return;
    try {
      const accounts = await provider.request({ method: "eth_accounts" });
      if (accounts?.[0]) await activate(accounts[0]);
      provider.on?.("accountsChanged", accountsChanged => {
        if (accountsChanged?.[0]) activate(accountsChanged[0]).catch(() => {});
        else {
          wallet = token = signer = browserProvider = null;
          $("wallet-label").textContent = "CONNECT RONIN";
          $("wallet-balance").textContent = "WALLET";
        }
      });
    } catch (error) { console.warn("Homepage wallet restore failed", error); }
  }

  async function loadTokenStats() {
    await Promise.allSettled([loadMarketStats(), loadHolderStats()]);
  }

  async function loadMarketStats() {
    try {
      const response = await fetch(`https://api.dexscreener.com/token-pairs/v1/ronin/${MATT}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`Market API ${response.status}`);
      const pairs = await response.json();
      const best = (Array.isArray(pairs) ? pairs : []).sort((a, b) => Number(b.liquidity?.usd || 0) - Number(a.liquidity?.usd || 0))[0];
      if (!best) throw new Error("No MATT market pair was returned");
      const price = Number(best.priceUsd || 0);
      const marketCap = Number(best.marketCap || best.fdv || 0);
      const change = Number(best.priceChange?.h24 || 0);
      $("stat-price").textContent = price > 0 ? `$${price < 0.0001 ? price.toPrecision(4) : price.toLocaleString(undefined, { maximumFractionDigits: 8 })}` : "—";
      $("stat-market-cap").textContent = marketCap > 0 ? `$${formatCompact(marketCap)}` : "—";
      $("stat-change").textContent = Number.isFinite(change) ? `${change >= 0 ? "+" : ""}${change.toFixed(2)}% / 24H` : "LIVE MARKET DATA";
      $("stat-change").style.color = change >= 0 ? "var(--green)" : "var(--red)";
    } catch (error) {
      console.warn("MATT market stats unavailable", error);
      $("stat-price").textContent = "LIVE ON KATANA";
      $("stat-market-cap").textContent = "VIEW MARKET";
      $("stat-change").textContent = "DATA TEMPORARILY UNAVAILABLE";
    }
  }

  async function loadHolderStats() {
    try {
      const response = await fetch("/api/holders?limit=1", { cache: "no-store" });
      const body = await response.json();
      if (!response.ok && response.status !== 202) throw new Error(body.message || `Holder API ${response.status}`);
      const count = body.summary?.holderCount;
      const burned = body.summary?.burnedRaw;
      $("stat-holders").textContent = count == null ? "INDEXING" : Number(count).toLocaleString();
      $("stat-burned").textContent = burned == null ? "INDEXING" : formatMattRaw(burned).replace(" MATT", "");
    } catch (error) {
      console.warn("MATT holder stats unavailable", error);
      $("stat-holders").textContent = "UPDATING";
      $("stat-burned").textContent = "UPDATING";
    }
  }

  function activityCard(title, detail, kind = "live") {
    const article = document.createElement("article");
    article.className = "activity-card";
    article.innerHTML = `<span class="pulse"></span><div><b></b><small></small></div>`;
    article.querySelector("b").textContent = title;
    article.querySelector("small").textContent = detail;
    if (kind === "burn") article.querySelector(".pulse").style.background = "var(--orange)";
    if (kind === "flight") article.querySelector(".pulse").style.background = "var(--blue)";
    return article;
  }

  async function loadActivity() {
    const grid = $("activity-grid");
    const cards = [];
    try {
      const response = await fetch("/api/crash/state", { cache: "no-store" });
      if (response.ok) {
        const crash = await response.json();
        const round = crash.round;
        if (round) cards.push(activityCard(`Space Flight #${round.number} is ${String(round.phase).toUpperCase()}`, `${Number(crash.summary?.playerCount || 0)} players · ${formatMattRaw(crash.summary?.roundTotal || 0)} wagered`, "flight"));
      }
    } catch (error) { console.warn("Crash activity unavailable", error); }

    try {
      const response = await fetch("/api/burnflip/leaderboard?limit=1", { cache: "no-store" });
      if (response.ok) {
        const burnflip = await response.json();
        cards.push(activityCard("BurnFlip is active", `${Number(burnflip.totalSettlements || 0).toLocaleString()} completed flips indexed`, "burn"));
      }
    } catch (error) { console.warn("BurnFlip activity unavailable", error); }

    try {
      const response = await fetch("/api/holders?limit=1", { cache: "no-store" });
      const holders = await response.json();
      if (holders.summary?.holderCount != null) cards.push(activityCard("MATT holder network", `${Number(holders.summary.holderCount).toLocaleString()} addresses currently hold MATT`));
    } catch (error) { console.warn("Holder activity unavailable", error); }

    if (!cards.length) cards.push(activityCard("MATT is live on Ronin", "Market, games, burns, and community activity continue on-chain."));
    grid.replaceChildren(...cards.slice(0, 3));
  }

  function setupCopy() {
    const address = $("contract-address").textContent.trim();
    $("copy-contract").addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(address);
        $("copy-status").textContent = "Official MATT contract copied.";
      } catch {
        $("copy-status").textContent = "Copy failed. Select the address manually.";
      }
    });
  }

  $("connect-wallet").addEventListener("click", connectWallet);
  setupCopy();
  restoreWallet();
  loadTokenStats();
  loadActivity();
  setInterval(loadTokenStats, 60_000);
  setInterval(loadActivity, 20_000);
  setInterval(refreshWalletBalance, 30_000);
})();
