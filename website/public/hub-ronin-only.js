(() => {
  "use strict";

  const RONIN_CHAIN_ID = 2020;
  const RONIN_CHAIN_HEX = "0x7e4";
  const MATT_ADDRESS = "0xa5450417BDCa0BDfB058ffE41205400FfDA1174d";
  const RPC_URL = "https://api.roninchain.com/rpc";
  const $ = id => document.getElementById(id);
  let account = null;
  let rpcId = 0;

  function provider() {
    return window.ronin?.provider || null;
  }

  function short(address) {
    return `${address.slice(0, 6)}…${address.slice(-4)}`;
  }

  function format(raw, precision = 2) {
    const value = BigInt(raw || "0x0");
    const whole = value / 10n ** 18n;
    const fraction = (value % 10n ** 18n).toString().padStart(18, "0").slice(0, precision).replace(/0+$/, "");
    return fraction ? `${whole.toLocaleString()}.${fraction}` : whole.toLocaleString();
  }

  function balanceData(address) {
    return `0x70a08231${address.toLowerCase().replace("0x", "").padStart(64, "0")}`;
  }

  async function rpc(method, params) {
    const response = await fetch(RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params })
    });
    const body = await response.json();
    if (!response.ok || body.error) throw new Error(body.error?.message || `Ronin RPC ${response.status}`);
    return body.result;
  }

  function setText(id, text) {
    const element = $(id);
    if (element) element.textContent = text;
  }

  function setMissionConnected(connected) {
    const button = $("mission-connect-button");
    if (button) {
      button.textContent = connected ? "CONNECTED" : "CONNECT";
      button.disabled = connected;
    }
    const card = document.querySelector('[data-mission="connect"]');
    if (card) {
      card.classList.toggle("locked", !connected);
      card.classList.toggle("completed", connected);
      const status = card.querySelector(".mission-status");
      if (status) status.textContent = connected ? "COMPLETE" : "LOCKED";
    }
  }

  async function refreshBalances() {
    if (!account) return;
    try {
      const [ron, matt] = await Promise.all([
        rpc("eth_getBalance", [account, "latest"]),
        rpc("eth_call", [{ to: MATT_ADDRESS, data: balanceData(account) }, "latest"])
      ]);
      setText("ron-balance", `${format(ron, 4)} RON`);
      setText("matt-balance", `${format(matt, 2)} MATT`);
      const tokens = BigInt(matt) / 10n ** 18n;
      setText("holder-level", tokens >= 100000000n ? "Legendary Matt" : tokens >= 10000000n ? "Gold Matt" : tokens >= 1000000n ? "Certified Matt" : tokens >= 100000n ? "Big Matt" : tokens > 0n ? "MATT Holder" : "Future Matt");
      setText("wallet-updated", `Wallet balances updated ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.`);
    } catch (error) {
      setText("wallet-status", `Ronin Wallet connected, but balances could not load: ${error.message}`);
    }
  }

  function renderConnected(address) {
    account = address.toLowerCase();
    setText("wallet-address", short(account));
    const addressElement = $("wallet-address");
    if (addressElement) addressElement.title = account;
    setText("wallet-status", "Ronin Wallet connected to Ronin Mainnet.");
    setText("mission-reset", `Progress for ${short(account)} · Resets at midnight on this device.`);
    const connect = $("connect-wallet");
    if (connect) connect.textContent = short(account);
    setMissionConnected(true);
    localStorage.setItem("mattRoninAccount", account);
    refreshBalances();
  }

  function renderDisconnected(message = "Connect Ronin Wallet to continue.") {
    account = null;
    setText("wallet-address", "Not connected");
    setText("matt-balance", "—");
    setText("ron-balance", "—");
    setText("holder-level", "Connect wallet");
    setText("wallet-status", message);
    setText("wallet-updated", "Connect to load wallet data.");
    setText("mission-reset", "Connect Ronin Wallet to begin today’s missions.");
    const connect = $("connect-wallet");
    if (connect) connect.textContent = "CONNECT RONIN";
    setMissionConnected(false);
    localStorage.removeItem("mattRoninAccount");
  }

  async function ensureRoninChain() {
    const ronin = provider();
    const chain = await ronin.request({ method: "eth_chainId" });
    const normalized = typeof chain === "number" ? chain : Number.parseInt(String(chain), 16);
    if (normalized !== RONIN_CHAIN_ID) {
      await ronin.request({ method: "wallet_switchEthereumChain", params: [{ chainId: RONIN_CHAIN_HEX }] });
    }
  }

  async function connect() {
    const ronin = provider();
    if (!ronin) {
      renderDisconnected("Ronin Wallet was not detected. Install Ronin Wallet or open this page inside the Ronin mobile app.");
      return;
    }
    const button = $("connect-wallet");
    if (button) {
      button.disabled = true;
      button.textContent = "OPENING RONIN…";
    }
    try {
      await ensureRoninChain();
      const accounts = await ronin.request({ method: "eth_requestAccounts" });
      if (!accounts?.[0]) throw new Error("No Ronin account was approved");
      renderConnected(accounts[0]);
    } catch (error) {
      renderDisconnected(error?.message || "Ronin Wallet connection was cancelled.");
    } finally {
      if (button) button.disabled = false;
    }
  }

  function replaceButton(id) {
    const oldButton = $(id);
    if (!oldButton) return null;
    const button = oldButton.cloneNode(true);
    oldButton.replaceWith(button);
    button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      connect();
    });
    return button;
  }

  async function initialize() {
    replaceButton("connect-wallet");
    replaceButton("mission-connect-button");
    const refresh = $("refresh-wallet");
    if (refresh) refresh.addEventListener("click", event => {
      if (!account) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      refreshBalances();
    }, true);

    const ronin = provider();
    if (!ronin) return renderDisconnected("Ronin Wallet was not detected.");
    ronin.on?.("accountsChanged", accounts => accounts?.[0] ? renderConnected(accounts[0]) : renderDisconnected("Ronin Wallet is locked or disconnected."));
    ronin.on?.("chainChanged", () => location.reload());
    try {
      const accounts = await ronin.request({ method: "eth_accounts" });
      if (accounts?.[0]) renderConnected(accounts[0]);
      else renderDisconnected();
    } catch (error) {
      renderDisconnected(error?.message || "Ronin Wallet could not be read.");
    }
  }

  initialize();
})();