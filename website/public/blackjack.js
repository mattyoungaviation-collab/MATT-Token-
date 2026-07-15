(() => {
  const state = { wallet: null, token: null, seat: null, bet: 0, lastBet: 0, table: null, stream: null };
  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];
  const fmt = value => `${Number(value || 0).toLocaleString()} MATT`;
  const short = value => value ? `${value.slice(0, 6)}…${value.slice(-4)}` : "Open seat";

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
    $("#leave-seat").disabled = state.seat === null || !state.token;
    const allowed = new Set(me?.allowedActions || []);
    $$('[data-action]').forEach(button => { button.disabled = !state.token || !allowed.has(button.dataset.action); });
    $("#activity-feed").innerHTML = (table.activity || []).slice(-20).reverse().map(item => `<li><time>${new Date(item.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>${escapeHtml(item.text)}</li>`).join("");
  }

  function escapeHtml(value) {
    const div = document.createElement("div");
    div.textContent = String(value);
    return div.innerHTML;
  }

  async function api(path, body, authenticated = true) {
    const headers = { "content-type": "application/json" };
    if (authenticated && state.token) headers.authorization = `Bearer ${state.token}`;
    const response = await fetch(path, { method: "POST", headers, body: JSON.stringify(body || {}) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401 && authenticated) clearSession();
      throw new Error(payload.message || "Request failed");
    }
    return payload;
  }

  async function signMessage(account, message) {
    try { return await window.ethereum.request({ method: "personal_sign", params: [message, account] }); }
    catch (error) {
      if (error?.code === 4001) throw error;
      return window.ethereum.request({ method: "personal_sign", params: [account, message] });
    }
  }

  async function connectWallet() {
    if (!window.ethereum) throw new Error("Open this page in Ronin Wallet or install a compatible wallet.");
    const [account] = await window.ethereum.request({ method: "eth_requestAccounts" });
    const wallet = String(account).toLowerCase();
    const challenge = await api("/api/blackjack/auth/challenge", { wallet }, false);
    const signature = await signMessage(wallet, challenge.message);
    const session = await api("/api/blackjack/auth/verify", { wallet, signature }, false);
    state.wallet = session.wallet;
    state.token = session.token;
    localStorage.setItem("mattBlackjackWallet", session.wallet);
    localStorage.setItem("mattBlackjackToken", session.token);
    $("#wallet-address").textContent = short(session.wallet);
    $("#wallet-button").textContent = `SIGNED IN ${short(session.wallet)}`;
    if (state.table) render(state.table);
  }

  function clearSession() {
    state.wallet = null;
    state.token = null;
    state.seat = null;
    localStorage.removeItem("mattBlackjackWallet");
    localStorage.removeItem("mattBlackjackToken");
    $("#wallet-address").textContent = "Not signed in";
    $("#wallet-button").textContent = "SIGN IN WITH WALLET";
    if (state.table) render(state.table);
  }

  function restoreSession() {
    const wallet = localStorage.getItem("mattBlackjackWallet");
    const token = localStorage.getItem("mattBlackjackToken");
    if (!wallet || !token) return;
    state.wallet = wallet;
    state.token = token;
    $("#wallet-address").textContent = short(wallet);
    $("#wallet-button").textContent = `SIGNED IN ${short(wallet)}`;
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
  $("#place-bet").addEventListener("click", async () => { try { if (!state.token) await connectWallet(); if (state.seat === null) throw new Error("Take a seat first."); await api("/api/blackjack/bet", { amount: state.bet }); state.lastBet = state.bet; } catch (error) { alert(error.message); } });
  $("#seat-grid").addEventListener("click", async event => { const seat = event.target.closest("[data-seat]"); if (!seat) return; try { if (!state.token) await connectWallet(); await api("/api/blackjack/join", { seat: Number(seat.dataset.seat) }); } catch (error) { alert(error.message); } });
  $("#leave-seat").addEventListener("click", () => api("/api/blackjack/leave", {}).catch(error => alert(error.message)));
  $(".actions").addEventListener("click", event => { const action = event.target.dataset.action; if (action) api("/api/blackjack/action", { action }).catch(error => alert(error.message)); });
  window.ethereum?.on?.("accountsChanged", () => clearSession());
  setInterval(refreshCountdown, 250);
  restoreSession();
  connectStream();
})();