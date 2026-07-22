(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const state = { wallet: "", endAt: 0, xVerified: false };
  const short = value => value ? `${value.slice(0, 6)}…${value.slice(-4)}` : "—";
  const message = (text, kind = "") => { const el = $("raffle-message"); if (!el) return; el.textContent = text; el.className = `raffle-message ${kind}`.trim(); };

  async function json(url, options) {
    const response = await fetch(url, { cache: "no-store", ...options });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || body.message || `Request failed (${response.status})`);
    return body;
  }

  async function walletAddress() {
    const provider = window.ronin?.provider;
    if (!provider) throw new Error("Open Ronin Wallet or install the Ronin Wallet extension.");
    const accounts = await provider.request({ method: "eth_requestAccounts" });
    if (!accounts?.[0]) throw new Error("No wallet was approved.");
    state.wallet = window.ethers.getAddress(accounts[0]).toLowerCase();
    $("raffle-wallet-status").textContent = short(state.wallet);
    return state.wallet;
  }

  async function loadConfig() {
    const config = await json("/api/dyno-raffle/config");
    state.endAt = Date.parse(config.endAt);
    $("raffle-wager-note").textContent = config.wagerBonusEnabled ? "Live on-chain verification" : "Activates when game vaults are configured";
    tick();
  }

  function tick() {
    const remaining = Math.max(0, state.endAt - Date.now());
    const units = [
      ["raffle-days", Math.floor(remaining / 86400000)],
      ["raffle-hours", Math.floor(remaining / 3600000) % 24],
      ["raffle-minutes", Math.floor(remaining / 60000) % 60],
      ["raffle-seconds", Math.floor(remaining / 1000) % 60],
    ];
    for (const [id, value] of units) if ($(id)) $(id).textContent = String(value).padStart(2, "0");
  }

  async function loadXStatus() {
    const status = await json("/api/x/status");
    state.xVerified = status.verified === true;
    if (status.wallet) state.wallet = status.wallet;
    $("raffle-x-status").textContent = status.verified ? `@${status.username}` : "NOT VERIFIED";
    if (status.wallet) $("raffle-wallet-status").textContent = short(status.wallet);
  }

  async function verifyX() {
    try {
      const wallet = state.wallet || await walletAddress();
      location.href = `/api/x/start?wallet=${encodeURIComponent(wallet)}`;
    } catch (error) { message(error.message, "error"); }
  }

  async function enter() {
    const button = $("raffle-enter");
    button.disabled = true;
    try {
      const wallet = state.wallet || await walletAddress();
      await loadXStatus();
      if (!state.xVerified) throw new Error("Verify your X account first so one person cannot enter through multiple wallets.");
      message("Check Ronin Wallet and sign the raffle message…");
      const nonce = await json("/api/dyno-raffle/nonce", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ wallet }) });
      const provider = new window.ethers.BrowserProvider(window.ronin.provider);
      const signer = await provider.getSigner(wallet);
      const signature = await signer.signMessage(nonce.message);
      const result = await json("/api/dyno-raffle/enter", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ wallet, signature }) });
      message(`Entered with ${result.entry.tickets} ticket${result.entry.tickets === 1 ? "" : "s"} today.`, "success");
      await loadEntries();
    } catch (error) { message(error.message, "error"); }
    finally { button.disabled = false; }
  }

  async function loadEntries() {
    const body = await json("/api/dyno-raffle/entries");
    $("raffle-entry-count").textContent = Number(body.summary.entryCount).toLocaleString();
    $("raffle-ticket-count").textContent = Number(body.summary.totalTickets).toLocaleString();
    const list = $("raffle-entry-list");
    if (!body.entries.length) { list.innerHTML = '<p class="raffle-empty">No entries yet. The first verified holder can take the top spot.</p>'; return; }
    list.replaceChildren(...body.entries.map(entry => {
      const row = document.createElement("article");
      row.className = "raffle-entry";
      const bonuses = [entry.burnBonus ? "burn +1" : "", entry.wagerBonus ? "wager +1" : ""].filter(Boolean).join(" · ") || "holder tickets";
      row.innerHTML = `<span class="ticket"></span><div><b></b><small></small></div><span class="wallet"></span><small class="entry-time"></small>`;
      row.querySelector(".ticket").textContent = `${entry.tickets} TICKET${entry.tickets === 1 ? "" : "S"}`;
      row.querySelector("b").textContent = `@${entry.username}`;
      row.querySelector("div small").textContent = bonuses;
      row.querySelector(".wallet").textContent = short(entry.wallet);
      row.querySelector(".entry-time").textContent = new Date(entry.enteredAt).toLocaleString();
      return row;
    }));
  }

  $("raffle-connect")?.addEventListener("click", () => walletAddress().catch(error => message(error.message, "error")));
  $("raffle-verify-x")?.addEventListener("click", verifyX);
  $("raffle-enter")?.addEventListener("click", enter);
  loadConfig().catch(error => message(error.message, "error"));
  loadXStatus().catch(() => {});
  loadEntries().catch(error => message(error.message, "error"));
  setInterval(tick, 1000);
  setInterval(loadEntries, 30_000);
})();
