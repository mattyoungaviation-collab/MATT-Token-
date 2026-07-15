(() => {
  const state = { wallet: null, seat: null, bet: 0, lastBet: 0, table: null, stream: null };
  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];
  const fmt = value => `${Number(value || 0).toLocaleString()} MATT`;
  const short = value => value ? `${value.slice(0, 6)}…${value.slice(-4)}` : "Open seat";

  function cardMarkup(card) {
    if (!card || card.hidden) return '<div class="card back" aria-label="Hidden card"></div>';
    const red = card.suit === "♥" || card.suit === "♦";
    return `<div class="card ${red ? "red" : ""}" aria-label="${card.rank} of ${card.suit}"><span>${card.rank}${card.suit}</span><span class="center">${card.suit}</span></div>`;
  }

  function render(table) {
    state.table = table;
    $("#round-id").textContent = table.roundId || "Waiting";
    $("#round-message").textContent = table.message || "Waiting for players.";
    $("#dealer-total").textContent = table.dealer?.total ?? "—";
    $("#dealer-hand").innerHTML = (table.dealer?.cards || []).map(cardMarkup).join("");
    $("#server-commit").textContent = table.commitment || "Waiting for round";
    $("#deck-hash").textContent = table.deckHash || "Revealed after settlement";
    $("#settlement-status").textContent = table.settlement || "No active wager";
    $("#player-count").textContent = `${table.seats.filter(Boolean).length} / 5 seated`;

    $("#seat-grid").innerHTML = table.seats.map((player, index) => {
      if (!player) return `<article class="seat empty"><button data-seat="${index}">SEAT ${index + 1}<br>JOIN</button></article>`;
      const mine = state.wallet && player.wallet.toLowerCase() === state.wallet.toLowerCase();
      return `<article class="seat ${mine ? "active" : ""}"><strong>${mine ? "YOU" : short(player.wallet)}</strong><span>${fmt(player.bet)}</span><div class="hand">${(player.cards || []).map(cardMarkup).join("")}</div><b>${player.total ?? "—"}</b><small>${player.status || "Waiting"}</small></article>`;
    }).join("");

    const me = table.seats.find(player => player && state.wallet && player.wallet.toLowerCase() === state.wallet.toLowerCase());
    state.seat = me ? table.seats.indexOf(me) : null;
    $("#leave-seat").disabled = state.seat === null;
    const allowed = new Set(me?.allowedActions || []);
    $$('[data-action]').forEach(button => { button.disabled = !allowed.has(button.dataset.action); });
    $("#activity-feed").innerHTML = (table.activity || []).slice(-20).reverse().map(item => `<li><time>${new Date(item.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>${escapeHtml(item.text)}</li>`).join("");
  }

  function escapeHtml(value) {
    const div = document.createElement("div");
    div.textContent = String(value);
    return div.innerHTML;
  }

  async function api(path, body) {
    const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.message || "Request failed");
    return payload;
  }

  async function connectWallet() {
    if (!window.ethereum) throw new Error("Open this page in Ronin Wallet or install a compatible wallet.");
    const [account] = await window.ethereum.request({ method: "eth_requestAccounts" });
    state.wallet = account;
    $("#wallet-address").textContent = short(account);
    $("#wallet-button").textContent = short(account);
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
  $("#place-bet").addEventListener("click", async () => { try { if (!state.wallet) await connectWallet(); if (state.seat === null) throw new Error("Take a seat first."); await api("/api/blackjack/bet", { wallet: state.wallet, amount: state.bet }); state.lastBet = state.bet; } catch (error) { alert(error.message); } });
  $("#seat-grid").addEventListener("click", async event => { const seat = event.target.closest("[data-seat]"); if (!seat) return; try { if (!state.wallet) await connectWallet(); await api("/api/blackjack/join", { wallet: state.wallet, seat: Number(seat.dataset.seat) }); } catch (error) { alert(error.message); } });
  $("#leave-seat").addEventListener("click", () => api("/api/blackjack/leave", { wallet: state.wallet }).catch(error => alert(error.message)));
  $(".actions").addEventListener("click", event => { const action = event.target.dataset.action; if (action) api("/api/blackjack/action", { wallet: state.wallet, action }).catch(error => alert(error.message)); });
  connectStream();
})();
