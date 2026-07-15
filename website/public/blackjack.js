(() => {
  const state = { wallet: null, token: null, seat: null, bet: 0, lastBet: 0, table: null, stream: null, config: null, busy: false };
  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];
  const fmt = value => `${Number(value || 0).toLocaleString()} MATT`;
  const short = value => value ? `${value.slice(0, 6)}…${value.slice(-4)}` : "Open seat";
  const TOKEN_ABI = ["function allowance(address owner,address spender) view returns (uint256)", "function approve(address spender,uint256 amount) returns (bool)"];
  const VAULT_ABI = ["function openWager(bytes32 roundId,uint256 amount) returns (bytes32)", "function withdraw()"];

  function roninProvider() {
    const candidates = [window.ronin?.provider, window.ronin];
    const provider = candidates.find(candidate => candidate && typeof candidate.request === "function");
    if (!provider) throw new Error("Ronin Wallet was not detected. Unlock the Ronin Wallet extension and refresh this page.");
    return provider;
  }

  function cardMarkup(card) {
    if (!card || card.hidden) return '<div class="card back" aria-label="Hidden card"></div>';
    const red = card.suit === "♥" || card.suit === "♦";
    return `<div class="card ${red ? "red" : ""}" aria-label="${card.rank} of ${card.suit}"><span>${card.rank}${card.suit}</span><span class="center">${card.suit}</span></div>`;
  }

  function countdownText(table) {
    if (table.phase !== "PLAYER_TURNS" || !table.turnDeadline || table.activeSeat == null) return table.message || "Waiting for players.";
    const seconds = Math.max(0, Math.ceil((Number(table.turnDeadline) - Date.now()) / 1000));
    const active = table.seats[table.activeSeat];
    const mine = active && state.wallet && active.wallet.toLowerCase() === state.wallet.toLowerCase();
    return `${mine ? "Your turn" : `${short(active?.wallet)} is acting`} • ${seconds}s remaining`;
  }

  function refreshCountdown() {
    if (state.table) $("#round-message").textContent = countdownText(state.table);
  }

  function render(table) {
    state.table = table;
    $("#round-id").textContent = table.roundId || "Waiting";
    refreshCountdown();
    $("#dealer-total").textContent = table.dealer?.total ?? "—";
    $("#dealer-hand").innerHTML = (table.dealer?.cards || []).map(cardMarkup).join("");
    $("#server-commit").textContent = table.commitment || "Waiting for round";
    $("#deck-hash").textContent = table.deckHash || "Revealed after settlement";
    $("#settlement-status").textContent = table.settlement || "No active wager";
    $("#player-count").textContent = `${table.seats.filter(Boolean).length} / 5 seated`;

    $("#seat-grid").innerHTML = table.seats.map((player, index) => {
      if (!player) return `<article class="seat empty"><button data-seat="${index}">SEAT ${index + 1}<br>JOIN</button></article>`;
      const mine = state.wallet && player.wallet.toLowerCase() === state.wallet.toLowerCase();
      return `<article class="seat ${mine ? "active" : ""} ${player.isActive ? "turn" : ""}"><strong>${mine ? "YOU" : short(player.wallet)}</strong><span>${fmt(player.bet)}</span><div class="hand">${(player.cards || []).map(cardMarkup).join("")}</div><b>${player.total ?? "—"}</b><small>${player.status || "Waiting"}</small></article>`;
    }).join("");

    const me = table.seats.find(player => player && state.wallet && player.wallet.toLowerCase() === state.wallet.toLowerCase());
    state.seat = me ? table.seats.indexOf(me) : null;
    $("#leave-seat").disabled = state.seat === null || !state.token || state.busy;
    const allowed = new Set((me?.allowedActions || []).filter(action => ["hit", "stand", "surrender"].includes(action)));
    $$('[data-action]').forEach(button => { button.disabled = state.busy || !state.token || !allowed.has(button.dataset.action); });
    $("#activity-feed").innerHTML = (table.activity || []).slice(-20).reverse().map(item => `<li><time>${new Date(item.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>${escapeHtml(item.text)}</li>`).join("");
  }

  function escapeHtml(value) {
    const div = document.createElement("div");
    div.textContent = String(value);
    return div.innerHTML;
  }

  async function post(path, body, authenticated = true) {
    const headers = { "content-type": "application/json" };
    if (authenticated && state.token) headers.authorization = `Bearer ${state.token}`;
    const response = await fetch(path, { method: "POST", headers, body: JSON.stringify(body || {}) });
    return handleResponse(response, authenticated);
  }

  async function get(path, authenticated = false) {
    const headers = {};
    if (authenticated && state.token) headers.authorization = `Bearer ${state.token}`;
    const response = await fetch(path, { headers, cache: "no-store" });
    return handleResponse(response, authenticated);
  }

  async function handleResponse(response, authenticated) {
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401 && authenticated) clearSession();
      throw new Error(payload.message || "Request failed");
    }
    return payload;
  }

  async function loadConfig() {
    const config = await get("/api/blackjack/config");
    state.config = config;
    $("#vault-address").textContent = config.vaultAddress || "Not configured";
    if (!config.connected) $("#vault-status").textContent = "Ronin offline";
    else if (config.paused) $("#vault-status").textContent = "PAUSED";
    else if (!config.operatorMatches) $("#vault-status").textContent = "Operator mismatch";
    else $("#vault-status").textContent = "LIVE ON RONIN";
    return config;
  }

  async function ensureRonin() {
    const provider = roninProvider();
    const chainId = await provider.request({ method: "eth_chainId" });
    if (String(chainId).toLowerCase() === "0x7e4") return provider;
    try {
      await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x7e4" }] });
      return provider;
    } catch {
      throw new Error("Switch Ronin Wallet to Ronin mainnet before placing a wager.");
    }
  }

  async function signMessage(provider, account, message) {
    try { return await provider.request({ method: "personal_sign", params: [message, account] }); }
    catch (error) {
      if (error?.code === 4001) throw error;
      return provider.request({ method: "personal_sign", params: [account, message] });
    }
  }

  async function connectWallet() {
    const provider = roninProvider();
    const [account] = await provider.request({ method: "eth_requestAccounts" });
    if (!account) throw new Error("Ronin Wallet did not return an account.");
    const wallet = String(account).toLowerCase();
    const challenge = await post("/api/blackjack/auth/challenge", { wallet }, false);
    const signature = await signMessage(provider, wallet, challenge.message);
    const session = await post("/api/blackjack/auth/verify", { wallet, signature }, false);
    state.wallet = session.wallet;
    state.token = session.token;
    localStorage.setItem("mattBlackjackWallet", session.wallet);
    localStorage.setItem("mattBlackjackToken", session.token);
    $("#wallet-address").textContent = short(session.wallet);
    $("#wallet-button").textContent = `RONIN CONNECTED ${short(session.wallet)}`;
    $("#auth-status").textContent = "Ronin Wallet ownership verified.";
    await refreshAccount();
    if (state.table) render(state.table);
  }

  function clearSession() {
    state.wallet = null;
    state.token = null;
    state.seat = null;
    localStorage.removeItem("mattBlackjackWallet");
    localStorage.removeItem("mattBlackjackToken");
    $("#wallet-address").textContent = "Not connected";
    $("#wallet-button").textContent = "CONNECT RONIN WALLET";
    $("#claimable-balance").textContent = "0 MATT";
    $("#withdraw-winnings").disabled = true;
    if (state.table) render(state.table);
  }

  function restoreSession() {
    const wallet = localStorage.getItem("mattBlackjackWallet");
    const token = localStorage.getItem("mattBlackjackToken");
    if (!wallet || !token) return;
    state.wallet = wallet;
    state.token = token;
    $("#wallet-address").textContent = short(wallet);
    $("#wallet-button").textContent = `RONIN CONNECTED ${short(wallet)}`;
  }

  async function refreshAccount() {
    if (!state.token || !window.ethers) return;
    try {
      const account = await get("/api/blackjack/account", true);
      const claimable = window.ethers.formatUnits(account.claimable || "0", 18);
      $("#claimable-balance").textContent = `${Number(claimable).toLocaleString(undefined, { maximumFractionDigits: 4 })} MATT`;
      $("#withdraw-winnings").disabled = BigInt(account.claimable || "0") === 0n || state.busy;
    } catch (error) {
      $("#auth-status").textContent = error.message;
    }
  }

  async function refreshSettlement() {
    if (!state.token) return;
    try {
      const payload = await get("/api/blackjack/settlements", true);
      const settlement = payload.settlement;
      if (!settlement) return;
      if (settlement.status === "pending") $("#settlement-tx").textContent = "Settlement pending on Ronin";
      else if (settlement.status === "failed") $("#settlement-tx").textContent = `Failed: ${settlement.message}`;
      else if (settlement.txHash) $("#settlement-tx").innerHTML = `<a target="_blank" rel="noopener" href="https://app.roninchain.com/tx/${settlement.txHash}">${short(settlement.txHash)}</a>`;
      await refreshAccount();
    } catch {}
  }

  async function placeOnChainBet() {
    if (state.busy) return;
    if (!state.token) await connectWallet();
    if (state.seat === null) throw new Error("Take a seat first.");
    if (!Number.isSafeInteger(state.bet) || state.bet < 10_000) throw new Error("Choose a bet of at least 10,000 MATT.");
    if (!window.ethers) throw new Error("The wallet library did not load. Refresh the page.");

    state.busy = true;
    $("#place-bet").disabled = true;
    try {
      const config = await loadConfig();
      if (!config.connected) throw new Error("The server cannot reach Ronin right now.");
      if (config.paused) throw new Error("The vault is still paused. The treasury must fund and unpause it before live wagering.");
      if (!config.operatorMatches) throw new Error("Settlement operator configuration does not match the vault.");
      const ronin = await ensureRonin();
      const provider = new window.ethers.BrowserProvider(ronin);
      const signer = await provider.getSigner();
      const signerAddress = (await signer.getAddress()).toLowerCase();
      if (signerAddress !== state.wallet.toLowerCase()) throw new Error("The connected Ronin account changed. Connect again.");

      const amountWei = window.ethers.parseUnits(String(state.bet), 18);
      const token = new window.ethers.Contract(config.mattAddress, TOKEN_ABI, signer);
      const vault = new window.ethers.Contract(config.vaultAddress, VAULT_ABI, signer);
      const allowance = await token.allowance(signerAddress, config.vaultAddress);
      if (allowance < amountWei) {
        $("#auth-status").textContent = "Approve MATT in Ronin Wallet…";
        const approval = await token.approve(config.vaultAddress, amountWei);
        await approval.wait(1);
      }

      $("#auth-status").textContent = "Confirm the wager in Ronin Wallet…";
      const wagerTx = await vault.openWager(config.contractRoundId, amountWei);
      await wagerTx.wait(1);
      $("#auth-status").textContent = "Verifying wager with the live table…";
      await post("/api/blackjack/bet", { amount: state.bet, txHash: wagerTx.hash, roundId: config.contractRoundId });
      state.lastBet = state.bet;
      $("#auth-status").textContent = `Wager confirmed: ${short(wagerTx.hash)}`;
    } finally {
      state.busy = false;
      $("#place-bet").disabled = false;
      if (state.table) render(state.table);
    }
  }

  async function withdrawWinnings() {
    if (state.busy) return;
    if (!window.ethers || !state.config) throw new Error("Vault configuration is unavailable.");
    state.busy = true;
    try {
      const ronin = await ensureRonin();
      const provider = new window.ethers.BrowserProvider(ronin);
      const signer = await provider.getSigner();
      const vault = new window.ethers.Contract(state.config.vaultAddress, VAULT_ABI, signer);
      const tx = await vault.withdraw();
      await tx.wait(1);
      $("#auth-status").textContent = `Winnings withdrawn: ${short(tx.hash)}`;
      await refreshAccount();
    } finally {
      state.busy = false;
    }
  }

  function connectStream() {
    state.stream?.close();
    state.stream = new EventSource("/api/blackjack/events");
    state.stream.addEventListener("table", event => render(JSON.parse(event.data)));
    state.stream.onopen = () => { $(".live").classList.add("online"); $("#connection-label").textContent = "Live table connected"; };
    state.stream.onerror = () => { $(".live").classList.remove("online"); $("#connection-label").textContent = "Reconnecting"; };
  }

  $("#wallet-button").addEventListener("click", () => connectWallet().catch(error => alert(error.message)));
  $("#chip-row").addEventListener("click", event => { const chip = Number(event.target.dataset.chip); if (!chip) return; state.bet = Math.min(5_000_000, state.bet + chip); $("#bet-display").textContent = fmt(state.bet); });
  $("#clear-bet").addEventListener("click", () => { state.bet = 0; $("#bet-display").textContent = fmt(0); });
  $("#repeat-bet").addEventListener("click", () => { state.bet = state.lastBet; $("#bet-display").textContent = fmt(state.bet); });
  $("#place-bet").addEventListener("click", () => placeOnChainBet().catch(error => { state.busy = false; $("#place-bet").disabled = false; alert(error.message); }));
  $("#withdraw-winnings").addEventListener("click", () => withdrawWinnings().catch(error => { state.busy = false; alert(error.message); }));
  $("#seat-grid").addEventListener("click", async event => { const seat = event.target.closest("[data-seat]"); if (!seat) return; try { if (!state.token) await connectWallet(); await post("/api/blackjack/join", { seat: Number(seat.dataset.seat) }); } catch (error) { alert(error.message); } });
  $("#leave-seat").addEventListener("click", () => post("/api/blackjack/leave", {}).catch(error => alert(error.message)));
  $(".actions").addEventListener("click", event => { const action = event.target.dataset.action; if (action) post("/api/blackjack/action", { action }).catch(error => alert(error.message)); });
  try { roninProvider().on?.("accountsChanged", () => clearSession()); } catch {}
  setInterval(refreshCountdown, 250);
  setInterval(refreshSettlement, 3_000);
  setInterval(loadConfig, 15_000);
  restoreSession();
  loadConfig().catch(() => {});
  refreshAccount();
  connectStream();
})();