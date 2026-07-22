(() => {
  "use strict";
  if (!window.ethers) return;

  const CHAIN_ID = 2020;
  const CHAIN_HEX = "0x7e4";
  const $ = id => document.getElementById(id);
  const els = {
    connect: $("connect-wallet"), action: $("primary-action"), withdraw: $("repeat-bet"),
    balance: $("demo-balance"), balanceLabel: $("balance-label"), message: $("game-message"),
    warning: $("mode-warning"), betAmount: $("bet-amount"), autoEnabled: $("auto-enabled"),
    autoMultiplier: $("auto-multiplier"), verify: $("verify-round"), verifyMessage: $("verify-message")
  };

  const VAULT_ABI = [
    "function openWager(bytes32 roundId,uint256 amount) returns (bytes32)",
    "function withdraw()",
    "function wagers(bytes32) view returns (address player,bytes32 roundId,uint128 amount,uint64 openedAt,bool settled)",
    "function claimable(address) view returns (uint256)",
    "function calculateCrashPointBps(bytes32 seed,bytes32 roundId) pure returns (uint256)"
  ];
  const TOKEN_ABI = [
    "function balanceOf(address) view returns (uint256)",
    "function allowance(address,address) view returns (uint256)",
    "function approve(address,uint256) returns (bool)"
  ];

  let browserProvider = null;
  let signer = null;
  let wallet = null;
  let vault = null;
  let token = null;
  let liveState = null;
  let account = null;
  let pending = false;
  let cashoutSentForRound = null;
  let currentWagerId = null;

  function roninProvider() { return window.ronin?.provider || null; }
  function say(text, type = "") { els.message.textContent = text; els.message.className = `game-message ${type}`; }
  function shortAddress(address) { return address ? `${address.slice(0, 6)}…${address.slice(-4)}` : "CONNECT RONIN"; }
  function formatUnits(value) {
    try { return `${Math.floor(Number(window.ethers.formatEther(value))).toLocaleString()} MATT`; }
    catch { return "0 MATT"; }
  }
  async function fetchJson(url, init) {
    const response = await fetch(url, { cache: "no-store", ...init });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.message || body.error || `HTTP ${response.status}`);
    return body;
  }
  async function ensureRoninChain() {
    const provider = roninProvider();
    if (!provider) throw new Error("Ronin Wallet was not detected. Install Ronin Wallet or open this page in the Ronin mobile app.");
    const chain = await provider.request({ method: "eth_chainId" });
    const normalized = typeof chain === "number" ? chain : Number.parseInt(String(chain), 16);
    if (normalized !== CHAIN_ID) await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN_HEX }] });
  }
  async function activate(address) {
    const provider = roninProvider();
    if (!provider) throw new Error("Ronin Wallet was not detected.");
    await ensureRoninChain();
    browserProvider = new window.ethers.BrowserProvider(provider);
    signer = await browserProvider.getSigner(address);
    wallet = await signer.getAddress();
    if (!liveState?.vaultAddress || !liveState?.tokenAddress) throw new Error("Live contract configuration is not available yet.");
    vault = new window.ethers.Contract(liveState.vaultAddress, VAULT_ABI, signer);
    token = new window.ethers.Contract(liveState.tokenAddress, TOKEN_ABI, signer);
    els.connect.textContent = shortAddress(wallet);
    say("Ronin Wallet connected. Real MATT mode is active.", "win");
    await refreshAccount(true);
  }
  async function restoreRonin() {
    const provider = roninProvider();
    if (!provider) return false;
    const accounts = await provider.request({ method: "eth_accounts" });
    if (!accounts?.[0]) return false;
    await activate(accounts[0]);
    return true;
  }
  async function connect() {
    pending = true;
    try {
      const provider = roninProvider();
      if (!provider) throw new Error("Ronin Wallet was not detected. Install Ronin Wallet or open this page in the Ronin mobile app.");
      await ensureRoninChain();
      const accounts = await provider.request({ method: "eth_requestAccounts" });
      if (!accounts?.[0]) throw new Error("No Ronin account was approved.");
      await activate(accounts[0]);
    } catch (error) {
      say(error.shortMessage || error.message || "Ronin Wallet connection failed.", "loss");
    } finally { pending = false; }
  }
  async function refreshAccount(force = false) {
    if (!wallet || (!force && pending)) return;
    try {
      account = await fetchJson(`/api/crash/account/${wallet}`);
      els.balance.textContent = formatUnits(account.balance);
      els.withdraw.disabled = BigInt(account.claimable || "0") === 0n;
      els.withdraw.textContent = BigInt(account.claimable || "0") > 0n ? `WITHDRAW ${formatUnits(account.claimable)}` : "NO WINNINGS TO WITHDRAW";
      await syncWager();
    } catch (error) { console.warn("Crash account refresh failed", error); }
  }
  function wagerId(roundId) {
    return window.ethers.keccak256(window.ethers.solidityPacked(["uint256", "address", "bytes32", "address"], [BigInt(CHAIN_ID), liveState.vaultAddress, roundId, wallet]));
  }
  async function syncWager() {
    currentWagerId = null;
    if (!wallet || !vault || !liveState?.round?.roundId) return;
    const id = wagerId(liveState.round.roundId);
    const data = await vault.wagers(id);
    if (String(data.player).toLowerCase() === wallet.toLowerCase() && !data.settled) currentWagerId = id;
  }
  function parsedBet() {
    const amount = Number(els.betAmount.value);
    const min = Number(window.ethers.formatEther(liveState?.limits?.minWager || "0"));
    const max = Number(window.ethers.formatEther(liveState?.limits?.maxWager || "0"));
    if (!Number.isFinite(amount) || amount < min || amount > max) throw new Error(`Bet must be between ${min.toLocaleString()} and ${max.toLocaleString()} MATT.`);
    return window.ethers.parseEther(String(Math.floor(amount)));
  }
  async function placeBet() {
    if (!wallet) return connect();
    if (!liveState || liveState.mode !== "LIVE_MAINNET" || liveState.paused) throw new Error("Live wagering is not open.");
    if (!liveState.round || liveState.round.phase !== "betting") throw new Error("Betting is closed for this flight.");
    if (currentWagerId) throw new Error("You already have a wager in this round.");
    const amount = parsedBet();
    pending = true;
    try {
      const allowance = await token.allowance(wallet, liveState.vaultAddress);
      if (allowance < amount) {
        say("Approve MATT in Ronin Wallet, then confirm the wager.");
        await (await token.approve(liveState.vaultAddress, amount)).wait();
      }
      say("Confirming your mainnet wager in Ronin Wallet…");
      await (await vault.openWager(liveState.round.roundId, amount)).wait();
      currentWagerId = wagerId(liveState.round.roundId);
      say(`${formatUnits(amount)} locked for flight #${liveState.round.number}.`, "win");
      await refreshAccount(true);
    } finally { pending = false; }
  }
  function cashoutText(timestamp) {
    return `MATT SPACE FLIGHT CASHOUT\nVault:${window.ethers.getAddress(liveState.vaultAddress)}\nRound:${liveState.round.roundId}\nWallet:${window.ethers.getAddress(wallet)}\nTimestamp:${timestamp}`;
  }
  async function cashOut(auto = false) {
    if (!wallet || !signer || !currentWagerId || !liveState?.round || liveState.round.phase !== "flying") throw new Error("No active wager to cash out.");
    if (cashoutSentForRound === liveState.round.roundId) return;
    pending = true;
    try {
      const timestamp = Date.now();
      const signature = await signer.signMessage(cashoutText(timestamp));
      const result = await fetchJson("/api/crash/cashout", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ wallet, roundId: liveState.round.roundId, timestamp, signature }) });
      cashoutSentForRound = liveState.round.roundId;
      say(`${auto ? "Auto cash-out" : "Cash-out"} locked at ${Number(result.multiplier).toFixed(2)}x. Settlement follows impact.`, "win");
    } finally { pending = false; }
  }
  async function withdraw() {
    if (!wallet) return connect();
    if (!account || BigInt(account.claimable || "0") === 0n) throw new Error("There are no settled winnings to withdraw.");
    pending = true;
    try {
      say("Confirm the withdrawal in Ronin Wallet…");
      await (await vault.withdraw()).wait();
      say("Winnings withdrawn to your Ronin Wallet.", "win");
      await refreshAccount(true);
    } finally { pending = false; }
  }
  async function verifyRound() {
    if (!liveState?.round?.seed || !liveState?.round?.roundId || !vault) return say("Connect Ronin Wallet to verify this round.");
    const bps = await vault.calculateCrashPointBps(liveState.round.seed, liveState.round.roundId);
    const calculated = Number(bps) / 10000;
    const matches = Math.abs(calculated - Number(liveState.round.crashPoint)) < 0.0001;
    els.verifyMessage.textContent = matches ? `Verified on-chain: ${calculated.toFixed(2)}x.` : "Verification failed. Do not continue playing.";
    els.verifyMessage.style.color = matches ? "var(--green)" : "var(--red)";
  }
  function enforceLiveUi() {
    els.balanceLabel.textContent = "WALLET BALANCE";
    els.warning.textContent = liveState?.mode === "LIVE_MAINNET" ? "LIVE RONIN MAINNET • REAL MATT • WAGERS CANNOT BE REVERSED" : liveState?.paused ? "MAINNET VAULT PAUSED • WAGERING LOCKED" : "LIVE MODE IS NOT CONFIGURED";
    const round = liveState?.round;
    if (!wallet) { els.action.disabled = false; els.action.textContent = "CONNECT RONIN"; return; }
    if (pending) { els.action.disabled = true; els.action.textContent = "WAITING FOR RONIN"; return; }
    if (!round || liveState.mode !== "LIVE_MAINNET") { els.action.disabled = true; els.action.textContent = "WAGERING LOCKED"; return; }
    if (round.phase === "betting") {
      els.action.disabled = Boolean(currentWagerId);
      els.action.classList.remove("cashout");
      els.action.textContent = currentWagerId ? "BET PLACED" : "PLACE REAL MATT BET";
    } else if (round.phase === "flying" && currentWagerId && cashoutSentForRound !== round.roundId) {
      els.action.disabled = false;
      els.action.classList.add("cashout");
      els.action.textContent = `CASH OUT • ${Number(round.multiplier).toFixed(2)}x`;
      const auto = Number(els.autoMultiplier.value || 0);
      if (els.autoEnabled.checked && auto >= 1 && Number(round.multiplier) >= auto) cashOut(true).catch(error => say(error.message, "loss"));
    } else {
      els.action.disabled = true;
      els.action.classList.remove("cashout");
      els.action.textContent = cashoutSentForRound === round.roundId ? "CASH-OUT LOCKED" : "ROUND IN PROGRESS";
    }
  }
  async function poll() {
    try {
      liveState = await fetchJson("/api/crash/state");
      if (wallet && liveState.round?.roundId && (!currentWagerId || liveState.round.phase === "betting")) await syncWager();
      if (cashoutSentForRound && liveState.round?.roundId !== cashoutSentForRound) cashoutSentForRound = null;
    } catch (error) { console.warn("Live Crash state unavailable", error); }
  }
  function capture(button, handler) {
    button.addEventListener("click", event => {
      event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation();
      Promise.resolve(handler()).catch(error => say(error.shortMessage || error.message || "Transaction failed.", "loss"));
    }, true);
  }

  els.connect.textContent = "CONNECT RONIN";
  els.connect.addEventListener("click", connect);
  capture(els.action, () => liveState?.round?.phase === "flying" ? cashOut(false) : placeBet());
  capture(els.withdraw, withdraw);
  capture(els.verify, verifyRound);
  $("reset-balance").style.display = "none";
  els.betAmount.min = "1000";
  els.betAmount.max = "25000";
  els.betAmount.value = "1000";
  document.querySelectorAll("[data-bet-action]").forEach(button => {
    button.addEventListener("click", event => {
      event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation();
      const current = Number(els.betAmount.value || 1000);
      if (button.dataset.betAction === "half") els.betAmount.value = String(Math.max(1000, Math.floor(current / 2)));
      if (button.dataset.betAction === "double") els.betAmount.value = String(Math.min(25000, current * 2));
      if (button.dataset.betAction === "max") els.betAmount.value = "25000";
    }, true);
  });
  const injected = roninProvider();
  injected?.on?.("accountsChanged", accounts => accounts?.[0] ? activate(accounts[0]).catch(error => say(error.message, "loss")) : location.reload());
  injected?.on?.("chainChanged", () => location.reload());
  poll();
  setTimeout(() => restoreRonin().catch(error => console.warn("No approved Ronin account", error)), 300);
  setInterval(poll, 250);
  setInterval(() => refreshAccount(), 3_000);
  setInterval(enforceLiveUi, 80);
})();