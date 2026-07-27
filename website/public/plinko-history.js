(() => {
  "use strict";

  const section = document.getElementById("plinko-records");
  if (!section) return;
  const $ = selector => section.querySelector(selector);
  const state = { offset: 0, limit: 25, loading: false, lastWallet: null };
  const MULTIPLIERS = [
    "50×", "25×", "10.0174×", "5×", "2×", "1.5×", "0.8×", "0.7×",
    "0.4848×",
    "0.7×", "0.8×", "1.5×", "2×", "5×", "10.0174×", "25×", "50×"
  ];

  function wallet() {
    const value = window.MattPlinkoV4?.account || window.MattProfiles?.currentWallet?.();
    return /^0x[a-fA-F0-9]{40}$/.test(String(value || ""))
      ? String(value).toLowerCase()
      : null;
  }
  function short(value) { return value ? `${value.slice(0, 6)}…${value.slice(-4)}` : "—"; }
  function escapeHtml(value) {
    const div = document.createElement("div");
    div.textContent = String(value);
    return div.innerHTML;
  }
  function matt(raw, precision = 2) {
    const value = BigInt(raw || "0");
    const negative = value < 0n;
    const absolute = negative ? -value : value;
    const whole = absolute / 10n ** 18n;
    const fraction = (absolute % 10n ** 18n).toString().padStart(18, "0")
      .slice(0, precision).replace(/0+$/, "");
    return `${negative ? "-" : ""}${whole.toLocaleString()}${fraction ? `.${fraction}` : ""} MATT`;
  }
  function netClass(raw) {
    const value = BigInt(raw || "0");
    return value > 0n ? "positive" : value < 0n ? "negative" : "";
  }
  function batchResult(raw) {
    const value = BigInt(raw || "0");
    return value > 0n ? ["win", "WIN"] : value < 0n ? ["loss", "LOSS"] : ["even", "EVEN"];
  }
  function playerName(player) {
    const name = player.username ? `<strong>${escapeHtml(player.username)}</strong>` : "";
    return `${name}<small>${short(player.wallet)}</small>`;
  }
  function resultSummary(slots) {
    const counts = new Map();
    for (const slot of slots || []) {
      const label = MULTIPLIERS[Number(slot)] || `slot ${Number(slot) + 1}`;
      counts.set(label, (counts.get(label) || 0) + 1);
    }
    return [...counts.entries()]
      .map(([label, count]) => `${label}${count > 1 ? ` ×${count}` : ""}`)
      .join(" · ");
  }
  async function json(url) {
    const response = await fetch(url, { cache: "no-store" });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.message || payload.error || `HTTP ${response.status}`);
    return payload;
  }

  async function loadPlayer(force = false) {
    const owner = wallet();
    state.lastWallet = owner;
    if (!owner) {
      $("#pl-player-wallet").textContent = "Connect Ronin Wallet";
      for (const id of [
        "#pl-player-batches", "#pl-player-coins", "#pl-player-wins",
        "#pl-player-losses", "#pl-player-volume", "#pl-player-net"
      ]) $(id).textContent = "—";
      $("#pl-history-body").innerHTML =
        '<tr><td colspan="8">Connect Ronin Wallet to load your past Plinko drops.</td></tr>';
      return;
    }
    $("#pl-player-wallet").textContent = short(owner);
    const payload = await json(`/api/plinko/history/${owner}?limit=100${force ? "&fresh=1" : ""}`);
    const player = payload.player;
    $("#pl-player-wallet").textContent = player.username
      ? `${player.username} · ${short(player.wallet)}`
      : short(player.wallet);
    $("#pl-player-wallet").title = player.wallet;
    $("#pl-player-batches").textContent = Number(player.batches).toLocaleString();
    $("#pl-player-coins").textContent = Number(player.coins).toLocaleString();
    $("#pl-player-wins").textContent = Number(player.winningCoins).toLocaleString();
    $("#pl-player-losses").textContent = Number(player.losingCoins).toLocaleString();
    $("#pl-player-volume").textContent = matt(player.totalWagerRaw);
    $("#pl-player-net").textContent = matt(player.netRaw);
    $("#pl-player-net").className = netClass(player.netRaw);
    $("#pl-history-body").innerHTML = player.history.length ? player.history.map(record => {
      const [resultClass, resultLabel] = batchResult(record.netRaw);
      const summary = resultSummary(record.slots);
      return `<tr>
        <td><span title="${escapeHtml(record.requestHash)}">${short(record.requestHash)}</span></td>
        <td class="numeric">${Number(record.coinCount).toLocaleString()}</td>
        <td><span class="plinko-result-pill ${resultClass}">${resultLabel}</span></td>
        <td><span class="plinko-results-summary" title="${escapeHtml(summary)}">${escapeHtml(summary)}</span></td>
        <td class="numeric">${matt(record.wagerRaw)}</td>
        <td class="numeric">${matt(record.payoutRaw)}</td>
        <td class="numeric ${netClass(record.netRaw)}">${matt(record.netRaw)}</td>
        <td><a href="https://app.roninchain.com/tx/${record.transactionHash}" target="_blank" rel="noopener">${short(record.transactionHash)}</a></td>
      </tr>`;
    }).join("") : '<tr><td colspan="8">No settled Plinko V4 batches found for this wallet.</td></tr>';
  }

  async function loadBoard({ append = false, force = false } = {}) {
    if (state.loading) return;
    state.loading = true;
    try {
      if (!append) state.offset = 0;
      const params = new URLSearchParams({
        sort: $("#pl-sort").value,
        minCoins: $("#pl-min-coins").value,
        search: $("#pl-search").value.trim(),
        offset: String(state.offset),
        limit: String(state.limit)
      });
      if (force) params.set("fresh", "1");
      const payload = await json(`/api/plinko/leaderboard?${params}`);
      const rows = payload.players.map(player => `
        <tr>
          <td>${player.rank}</td>
          <td><a class="plinko-player-link" href="https://app.roninchain.com/address/${player.wallet}" target="_blank" rel="noopener" title="${player.wallet}">${playerName(player)}</a></td>
          <td class="numeric">${Number(player.batches).toLocaleString()}</td>
          <td class="numeric">${Number(player.coins).toLocaleString()}</td>
          <td class="numeric positive">${Number(player.winningCoins).toLocaleString()}</td>
          <td class="numeric negative">${Number(player.losingCoins).toLocaleString()}</td>
          <td class="numeric">${matt(player.totalWagerRaw)}</td>
          <td class="numeric ${netClass(player.netRaw)}">${matt(player.netRaw)}</td>
          <td class="numeric">${(Number(player.winRate) * 100).toFixed(1)}%</td>
        </tr>`).join("");
      const body = $("#pl-leaderboard-body");
      body.innerHTML = append
        ? body.innerHTML + rows
        : (rows || '<tr><td colspan="9">No players match these filters.</td></tr>');
      state.offset += payload.players.length;
      $("#pl-index-status").textContent =
        `${payload.status === "INDEXING" ? "Indexing history… · " : ""}`
        + `${Number(payload.totalPlayers).toLocaleString()} players · `
        + `${Number(payload.totalBatches).toLocaleString()} batches · `
        + `${Number(payload.totalCoins).toLocaleString()} drops`;
      $("#pl-page-summary").textContent = payload.totalPlayers
        ? `Showing 1–${state.offset} of ${payload.totalPlayers}`
        : "No matching players";
      $("#pl-load-more").hidden = !payload.hasMore;
    } finally {
      state.loading = false;
    }
  }

  $("#pl-refresh-player").addEventListener("click", () =>
    loadPlayer(true).catch(error => alert(error.message))
  );
  $("#pl-refresh-board").addEventListener("click", () =>
    loadBoard({ force: true }).catch(error => alert(error.message))
  );
  $("#pl-load-more").addEventListener("click", () =>
    loadBoard({ append: true }).catch(error => alert(error.message))
  );
  $("#pl-sort").addEventListener("change", () => loadBoard().catch(() => {}));
  $("#pl-min-coins").addEventListener("change", () => loadBoard().catch(() => {}));
  let searchTimer;
  $("#pl-search").addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => loadBoard().catch(() => {}), 300);
  });
  document.addEventListener("matt:profiles-updated", () => {
    loadPlayer().catch(() => {});
    loadBoard().catch(() => {});
  });
  setInterval(() => {
    const current = wallet();
    if (current !== state.lastWallet) loadPlayer().catch(() => {});
  }, 1_500);
  setInterval(() => {
    loadPlayer().catch(() => {});
    loadBoard().catch(() => {});
  }, 30_000);
  loadPlayer().catch(() => {});
  loadBoard().catch(error => {
    $("#pl-leaderboard-body").innerHTML =
      `<tr><td colspan="9">${escapeHtml(error.message)}</td></tr>`;
  });
})();
