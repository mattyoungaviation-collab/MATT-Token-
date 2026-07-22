(() => {
  "use strict";
  if (!window.ethers) return;

  const CHAIN_ID = 2020;
  const RPC_URL = "https://api.roninchain.com/rpc";
  const WALLETCONNECT_PROJECT_ID = "10907bb3eaa077bbb82e0559005400d7";
  const WALLETCONNECT_MODULE_URL = "https://esm.sh/@walletconnect/ethereum-provider@2?bundle";
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

  let walletConnectProvider = null;
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

  function say(text, type = "") {
    els.message.textContent = text;
    els.message.className = `game-message ${type}`;
  }
  function shortAddress(address) { return address ? `${address.slice(0, 6)}…${address.slice(-4)}` : "CONNECT WALLET"; }
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
  function accountFromSession() {
    const namespaces = walletConnectProvider?.session?.namespaces || {};
    const accounts = Object.values(namespaces).flatMap(namespace => namespace?.accounts || []);
    const account = accounts.find(value => String(value).toLowerCase().startsWith(`eip155:${CHAIN_ID}:`));
    return account ? account.split(":").pop() : null;
  }
  async function initializeWalletConnect() {
    if (walletConnectProvider) return walletConnectProvider;
    const module = await import(WALLETCONNECT_MODULE_URL);
    const EthereumProvider = module.EthereumProvider || module.default;
    if (!EthereumProvider?.init) throw new Error("WalletConnect provider did not load");
    walletConnectProvider = await EthereumProvider.init({
      projectId: WALLETCONNECT_PROJECT_ID,
      metadata: {
        name: "MATT Hub",
        description: "Connect to MATT Hub on Ronin Mainnet.",
        url: window.location.origin,
        icons: [`${window.location.origin}/assets/matt-logo-512.png`]
      },
      showQrModal: true,
      optionalChains: [CHAIN_ID],
      optionalMethods: ["eth_accounts", "eth_requestAccounts", "eth_sendTransaction", "personal_sign", "eth_signTypedData", "eth_signTypedData_v4", "wallet_switchEthereumChain"],
      optionalEvents: ["accountsChanged", "chainChanged", "disconnect", "connect"],
      rpcMap: { [CHAIN_ID]: RPC_URL },
      qrModalOptions: { themeMode: "dark" }
    });
    walletConnectProvider.on("accountsChanged", () => restoreHubWallet().catch(error => say(error.message, "loss")));
    walletConnectProvider.on("chainChanged", () => restoreHubWallet().catch(error => say(error.message, "loss")));
    walletConnectProvider.on("disconnect", () => {
      wallet = signer = browserProvider = vault = token = null;
      els.connect.textContent = "CONNECT IN MATT HUB";
      say("WalletConnect disconnected. Connect again through MATT Hub.");
    });
    return walletConnectProvider;
  }
  async function activateProvider(provider, expectedAccount = null) {
    browserProvider = new window.ethers.BrowserProvider(provider);
    signer = expectedAccount ? await browserProvider.getSigner(expectedAccount) : await browserProvider.getSigner();
    wallet = await signer.getAddress();
    if (!liveState?.vaultAddress || !liveState?.tokenAddress) throw new Error("Live contract configuration is not available yet.");
    vault = new window.ethers.Contract(liveState.vaultAddress, VAULT_ABI, signer);
    token = new window.ethers.Contract(liveState.tokenAddress, TOKEN_ABI, signer);
    els.connect.textContent = shortAddress(wallet);
    say("MATT Hub wallet session restored. Real MATT mode is active.", "win");
    await refreshAccount(true);
  }
  async function restoreHubWallet() {
    await initializeWalletConnect();
    const sessionAccount = accountFromSession();
    if (!walletConnectProvider.session || !sessionAccount) return false;
    await activateProvider(walletConnectProvider, sessionAccount);
    return true;
  }
  async function connect() {
    try {
      pending = true;
      if (await restoreHubWallet()) return;
      say("No active MATT Hub wallet session. Opening the same WalletConnect flow…");
      await walletConnectProvider.connect();
      const sessionAccount = accountFromSession();
      if (!sessionAccount) throw new Error("The wallet did not approve a Ronin Mainnet account");
      await activateProvider(walletConnectProvider, sessionAccount);
    } catch (error) { say(error.shortMessage || error.message || "Wallet connection failed.", "loss"); }
    finally { pending = false; }
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
        say("Approve MATT in your connected Hub wallet, then confirm the wager.");
        await (await token.approve(liveState.vaultAddress, amount)).wait();
      }
      say("Confirming your mainnet wager…");
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
      say("Confirm the withdrawal in your connected Hub wallet…");
      await (await vault.withdraw()).wait();
      say("Winnings withdrawn to your wallet.", "win");
      await refreshAccount(true);
    } finally { pending = false; }
  }
  async function verifyRound() {
    if (!liveState?.round?.seed || !liveState?.round?.roundId || !vault) return say("Connect your MATT Hub wallet to verify this round.");
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
    if (!wallet) { els.action.disabled = false; els.action.textContent = "USE MATT HUB WALLET"; return; }
    if (pending) { els.action.disabled = true; els.action.textContent = "WAITING FOR WALLET"; return; }
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
  poll();
  restoreHubWallet().catch(error => console.warn("No reusable MATT Hub wallet session", error));
  setInterval(poll, 250);
  setInterval(() => refreshAccount(), 3_000);
  setInterval(enforceLiveUi, 80);
})();