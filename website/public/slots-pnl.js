(() => {
  "use strict";

  const root = document.getElementById("slots-pnl-ledger");
  if (!root) return;

  const explorerBase = "https://explorer.roninchain.com/address/";
  const unit = 10n ** 18n;
  const state = {
    sort: "pnl-desc",
    search: "",
    offset: 0,
    limit: 25,
    controller: null,
    loading: false
  };
  const sortLabels = {
    "pnl-desc": "biggest winners",
    "pnl-asc": "biggest losses",
    "spent-desc": "highest volume",
    "won-desc": "most MATT won",
    "biggest-desc": "biggest single wins",
    "win-rate-desc": "highest win rate",
    "spins-desc": "most spins",
    "recent-desc": "most recently active"
  };

  const find = selector => root.querySelector(selector);
  const findAll = selector => [...root.querySelectorAll(selector)];
  const elements = {
    status: find("#pnl-status"),
    searchForm: find("#pnl-search-form"),
    searchInput: find("#pnl-search-input"),
    clearSearch: find("#pnl-clear-search"),
    refresh: find("#pnl-refresh"),
    tableBody: find("#pnl-table-body"),
    empty: find("#pnl-empty"),
    pageSummary: find("#pnl-page-summary"),
    previous: find("#pnl-previous"),
    next: find("#pnl-next"),
    walletCard: find("#pnl-wallet-card")
  };

  function formatMatt(raw, fractionDigits = 2, includeSymbol = true) {
    let value;
    try { value = BigInt(raw || 0); } catch { value = 0n; }
    const negative = value < 0n;
    if (negative) value = -value;
    const whole = value / unit;
    const fraction = (value % unit).toString().padStart(18, "0")
      .slice(0, fractionDigits).replace(/0+$/, "");
    const amount = `${negative ? "-" : ""}${whole.toLocaleString()}${fraction ? `.${fraction}` : ""}`;
    return includeSymbol ? `${amount} MATT` : amount;
  }

  function formatPnl(raw, fractionDigits = 2) {
    let value;
    try { value = BigInt(raw || 0); } catch { value = 0n; }
    const amount = formatMatt(value, fractionDigits);
    return value > 0n ? `+${amount}` : amount;
  }

  function amountClass(raw) {
    let value;
    try { value = BigInt(raw || 0); } catch { value = 0n; }
    return value > 0n ? "is-positive" : value < 0n ? "is-negative" : "is-even";
  }

  function formatPercent(bps) {
    return `${(Number(bps || 0) / 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}%`;
  }

  function shortAddress(address) {
    const text = String(address || "");
    return text.length > 13 ? `${text.slice(0, 7)}...${text.slice(-5)}` : text;
  }

  function setText(selector, value) {
    const element = find(selector);
    if (element) element.textContent = value;
  }

  function setStatus(message, type = "") {
    elements.status.textContent = message;
    elements.status.classList.toggle("is-error", type === "error");
    elements.status.classList.toggle("is-loading", type === "loading");
  }

  function createCell(text, className = "") {
    const cell = document.createElement("td");
    cell.textContent = text;
    if (className) cell.className = className;
    return cell;
  }

  function selectWallet(wallet) {
    elements.searchInput.value = wallet;
    state.search = wallet.toLowerCase();
    state.offset = 0;
    load();
  }

  function renderRows(payload) {
    elements.tableBody.replaceChildren();
    for (const player of payload.players) {
      const row = document.createElement("tr");
      const rank = createCell(`#${Number(player.rank).toLocaleString()}`, "pnl-rank");
      const walletCell = document.createElement("td");
      const walletButton = document.createElement("button");
      walletButton.type = "button";
      walletButton.className = "pnl-wallet-link";
      walletButton.textContent = shortAddress(player.wallet);
      walletButton.title = `View ${player.wallet}`;
      walletButton.addEventListener("click", () => selectWallet(player.wallet));
      walletCell.append(walletButton);
      const pnl = createCell(formatPnl(player.pnlRaw), `pnl-number ${amountClass(player.pnlRaw)}`);
      const spent = createCell(formatMatt(player.spentRaw), "pnl-number");
      const won = createCell(formatMatt(player.wonRaw), "pnl-number");
      const biggest = createCell(formatMatt(player.biggestWinRaw), "pnl-number");
      const winRate = createCell(formatPercent(player.winRateBps), "pnl-number");
      const spins = createCell(Number(player.paidSpins).toLocaleString(), "pnl-number");
      row.append(rank, walletCell, pnl, spent, won, biggest, winRate, spins);
      elements.tableBody.append(row);
    }
    elements.empty.hidden = payload.players.length !== 0;
  }

  function renderSummary(payload) {
    const summary = payload.summary;
    setText("#pnl-total-players", Number(summary.totalPlayers).toLocaleString());
    setText("#pnl-total-spins", Number(summary.totalPaidSpins).toLocaleString());
    setText("#pnl-total-spent", formatMatt(summary.totalSpentRaw));
    setText("#pnl-total-won", formatMatt(summary.totalWonRaw));
    setText("#pnl-global-net", formatPnl(summary.totalPnlRaw));
    const globalNet = find("#pnl-global-net");
    globalNet.className = amountClass(summary.totalPnlRaw);
    setText("#pnl-biggest-win", formatMatt(summary.biggestWinRaw));
    setText("#pnl-biggest-wallet", summary.biggestWinWallet
      ? `${shortAddress(summary.biggestWinWallet)} / spin #${summary.biggestWinSpinId}`
      : "Waiting for the first settled spin");
  }

  function renderWalletCard(payload) {
    const normalized = state.search.startsWith("ronin:")
      ? `0x${state.search.slice(6)}`
      : state.search;
    const exact = /^0x[0-9a-f]{40}$/.test(normalized)
      ? payload.players.find(player => player.wallet === normalized)
      : null;
    elements.walletCard.hidden = !exact;
    if (!exact) return;

    setText("#pnl-wallet-title", shortAddress(exact.wallet));
    const explorer = find("#pnl-wallet-explorer");
    explorer.href = `${explorerBase}${exact.wallet}`;
    setText("#pnl-wallet-pnl", formatPnl(exact.pnlRaw));
    find("#pnl-wallet-pnl").className = amountClass(exact.pnlRaw);
    setText("#pnl-wallet-spent", formatMatt(exact.spentRaw));
    setText("#pnl-wallet-won", formatMatt(exact.wonRaw));
    setText("#pnl-wallet-biggest", formatMatt(exact.biggestWinRaw));
    setText("#pnl-wallet-rate", formatPercent(exact.winRateBps));
    setText("#pnl-wallet-spins", Number(exact.paidSpins).toLocaleString());
  }

  function renderPagination(payload) {
    const start = payload.players.length ? state.offset + 1 : 0;
    const end = state.offset + payload.players.length;
    const total = Number(payload.summary.matchingPlayers);
    elements.pageSummary.textContent = state.search
      ? `Showing ${start.toLocaleString()}-${end.toLocaleString()} of ${total.toLocaleString()} matching wallets.`
      : `Showing ${start.toLocaleString()}-${end.toLocaleString()} of ${total.toLocaleString()} players by ${sortLabels[state.sort]}.`;
    elements.previous.disabled = !payload.pagination.hasPrevious;
    elements.next.disabled = !payload.pagination.hasMore;
  }

  async function load({ fresh = false } = {}) {
    if (state.controller) state.controller.abort();
    state.controller = new AbortController();
    state.loading = true;
    elements.refresh.disabled = true;
    setStatus("Reading verified Slots settlements from Ronin...", "loading");
    const params = new URLSearchParams({
      sort: state.sort,
      search: state.search,
      offset: String(state.offset),
      limit: String(state.limit)
    });
    if (fresh) params.set("fresh", "1");

    try {
      const response = await fetch(`/api/slots/pnl?${params}`, {
        cache: "no-store",
        signal: state.controller.signal
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || `PNL service returned HTTP ${response.status}`);
      renderSummary(payload);
      renderRows(payload);
      renderWalletCard(payload);
      renderPagination(payload);
      const updated = payload.summary.updatedAt
        ? new Date(payload.summary.updatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
        : "just now";
      setStatus(`Verified through Ronin block ${Number(payload.summary.indexedThroughBlock).toLocaleString()} / updated ${updated}.`);
    } catch (error) {
      if (error?.name !== "AbortError") {
        setStatus(`${error?.message || "Global Slots PNL is temporarily unavailable."} No wallet action is required.`, "error");
        elements.empty.hidden = elements.tableBody.children.length !== 0;
      }
    } finally {
      state.loading = false;
      elements.refresh.disabled = false;
    }
  }

  elements.searchForm.addEventListener("submit", event => {
    event.preventDefault();
    state.search = elements.searchInput.value.trim().toLowerCase();
    state.offset = 0;
    elements.clearSearch.hidden = !state.search;
    load();
  });
  elements.clearSearch.addEventListener("click", () => {
    elements.searchInput.value = "";
    elements.clearSearch.hidden = true;
    state.search = "";
    state.offset = 0;
    load();
  });
  elements.refresh.addEventListener("click", () => load({ fresh: true }));
  elements.previous.addEventListener("click", () => {
    state.offset = Math.max(0, state.offset - state.limit);
    load();
  });
  elements.next.addEventListener("click", () => {
    state.offset += state.limit;
    load();
  });
  findAll("[data-pnl-sort]").forEach(button => button.addEventListener("click", () => {
    state.sort = button.dataset.pnlSort;
    state.offset = 0;
    findAll("[data-pnl-sort]").forEach(item => item.classList.toggle("is-active", item === button));
    load();
  }));

  load();
  window.setInterval(() => {
    if (!document.hidden && !state.loading) load();
  }, 30_000);
})();
