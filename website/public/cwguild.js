(() => {
  "use strict";

  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];
  const state = { provider: null, signer: null, wallet: null, config: null, game: null, recall: null, moves: [], phase: "idle", timer: null };
  const runeButtons = $$("[data-rune]");
  const progress = $$("#sequence i");

  function formatToken(raw, maximumFractionDigits = 2) {
    if (raw == null) return "—";
    const value = Number(window.ethers.formatUnits(BigInt(raw), 18));
    return `${new Intl.NumberFormat(undefined, { maximumFractionDigits }).format(value)} CWGUILD`;
  }

  function short(address) {
    return address ? `${address.slice(0, 6)}…${address.slice(-4)}` : "Not connected";
  }

  function setMessage(message, tone = "") {
    $("#game-message").textContent = message;
    $("#game-message").className = `game-message ${tone}`.trim();
  }

  function friendly(error) {
    const message = String(error?.shortMessage || error?.reason || error?.message || error || "Rune Run request failed.");
    if (/user rejected|user denied|4001/i.test(message)) return "Wallet signature cancelled. No funds moved.";
    if (/already earned/i.test(message)) return "This wallet already earned today's prize. Come back after 00:00 UTC.";
    if (/payout ceiling/i.test(message)) return "The 2,000,000 CWGUILD Rune Run payout ceiling has been reached.";
    if (/hold at least/i.test(message)) return message;
    return message.replace(/^Error:\s*/i, "").slice(0, 220);
  }

  async function api(path, options = {}) {
    const response = await fetch(`/api/cwguild${path}`, {
      cache: "no-store",
      ...options,
      headers: { ...(options.body ? { "content-type": "application/json" } : {}), ...(options.headers || {}) }
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(payload.error || "Rune Run request failed."), { status: response.status, payload });
    return payload;
  }

  function injectedProvider() {
    const candidates = [window.ronin?.provider, window.ronin, ...(Array.isArray(window.ethereum?.providers) ? window.ethereum.providers : []), window.ethereum];
    const provider = candidates.find(candidate => candidate && typeof candidate.request === "function");
    if (!provider) throw new Error("Ronin Wallet was not detected. Open this page in Ronin Wallet or install the browser extension.");
    return provider;
  }

  async function ensureRonin(injected) {
    let chainId = await injected.request({ method: "eth_chainId" });
    if (BigInt(chainId) === 2020n) return;
    try {
      await injected.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x7e4" }] });
      chainId = await injected.request({ method: "eth_chainId" });
      if (BigInt(chainId) !== 2020n) throw new Error("wrong chain");
    } catch {
      throw new Error("Switch Ronin Wallet to Ronin Mainnet (chain 2020).");
    }
  }

  async function connect() {
    const button = $("#connect-wallet");
    button.disabled = true;
    button.textContent = "CONNECTING…";
    try {
      const injected = injectedProvider();
      await ensureRonin(injected);
      state.provider = new window.ethers.BrowserProvider(injected);
      await state.provider.send("eth_requestAccounts", []);
      state.signer = await state.provider.getSigner();
      state.wallet = await state.signer.getAddress();
      button.textContent = short(state.wallet);
      await loadStatus();
      setMessage(state.config.eligible ? "Wallet ready. Start a run and sign the plain-text entry message." : `This wallet needs ${formatToken(state.config.minimumBalance)} to enter.`);
    } catch (error) {
      state.wallet = null;
      state.signer = null;
      button.textContent = "CONNECT RONIN";
      setMessage(friendly(error), "error");
    } finally {
      button.disabled = false;
      render();
    }
  }

  async function loadStatus() {
    const query = state.wallet ? `?wallet=${encodeURIComponent(state.wallet)}` : "";
    state.config = await api(`/status${query}`);
    render();
  }

  function render() {
    const config = state.config;
    if (!config) return;
    $("#minimum-balance").textContent = formatToken(config.minimumBalance);
    $("#prize-amount").textContent = formatToken(config.prizeAmount);
    $("#pool-balance").textContent = formatToken(config.poolBalance, 0);
    $("#max-payout").textContent = formatToken(config.maxPayout, 0);
    $("#payout-remaining").textContent = `${formatToken(config.remainingPayout, 0)} remaining`;
    $("#prize-mode").textContent = config.live ? "Funded operator payout" : "Practice mode · payouts off";
    $("#wallet-address").textContent = short(state.wallet);
    $("#wallet-balance").textContent = state.wallet ? formatToken(config.balance) : "Connect wallet";
    const operator = config.operatorAddress;
    $("#operator-address").textContent = operator || "Not configured";
    $("#operator-link").href = operator ? `https://explorer.roninchain.com/address/${operator}` : "#";
    $("#operator-link").toggleAttribute("aria-disabled", !operator);

    const start = $("#start-game");
    const alreadyWon = Boolean(config.claim);
    const capReached = BigInt(config.remainingPayout || 0) < BigInt(config.prizeAmount || 0);
    start.disabled = state.phase !== "idle" || !state.wallet || !config.eligible || alreadyWon || capReached;
    if (!state.wallet) start.textContent = "CONNECT RONIN TO PLAY";
    else if (!config.eligible) start.textContent = "MORE CWGUILD NEEDED";
    else if (alreadyWon) start.textContent = "TODAY'S PRIZE COMPLETE";
    else if (capReached) start.textContent = "PAYOUT CEILING REACHED";
    else if (!config.live) start.textContent = "START PRACTICE RUN";
    else start.textContent = "START PRIZE RUN";
    $("#phase-title").textContent = alreadyWon ? "Prize secured" : state.phase === "idle" ? "Ready for a new signal" : $("#phase-title").textContent;
    if (config.claim?.txHash) showTransaction(config.claim.txHash);
  }

  function resetBoard() {
    state.moves = [];
    progress.forEach(item => { item.className = ""; });
    runeButtons.forEach(button => { button.disabled = true; button.classList.remove("active"); });
    clearInterval(state.timer);
    $("#timer").textContent = "—";
    $("#recall-rule").hidden = true;
  }

  function pulseRune(name, duration = 260) {
    const button = $(`[data-rune="${name}"]`);
    if (!button) return;
    button.classList.add("active");
    setTimeout(() => button.classList.remove("active"), duration);
  }

  async function showSequence(sequence) {
    $("#phase-title").textContent = "Memorize the signal";
    setMessage("Watch closely. The rune controls unlock after the sequence ends.");
    await new Promise(resolve => setTimeout(resolve, 350));
    for (const rune of sequence) {
      pulseRune(rune, 300);
      await new Promise(resolve => setTimeout(resolve, 390));
    }
  }

  function beginInput(recall) {
    state.phase = "input";
    state.recall = recall;
    $("#phase-title").textContent = "Timed recall round";
    const direction = recall.direction === "forward" ? "FORWARD" : "BACKWARD";
    const instruction = `START AT SIGNAL #${recall.startPosition} · MOVE ${direction}`;
    $("#recall-rule").textContent = instruction;
    $("#recall-rule").hidden = false;
    setMessage("The rule was revealed after the pattern. Complete all six moves before time expires.");
    runeButtons.forEach(button => { button.disabled = false; });
    const deadline = Date.now() + recall.inputMs;
    const tick = () => {
      const remaining = Math.max(0, deadline - Date.now());
      $("#timer").textContent = `${(remaining / 1000).toFixed(1)}s`;
      if (remaining <= 0) {
        clearInterval(state.timer);
        finishRun().catch(handleFailure);
      }
    };
    tick();
    state.timer = setInterval(tick, 100);
  }

  async function startRun() {
    if (!state.wallet || !state.signer || state.phase !== "idle") return;
    state.phase = "signing";
    resetBoard();
    render();
    try {
      $("#phase-title").textContent = "Verify your wallet";
      setMessage("Sign the Rune Run entry message. It is not a transaction or token approval.");
      const challenge = await api("/auth/challenge", { method: "POST", body: JSON.stringify({ wallet: state.wallet }) });
      const signature = await state.signer.signMessage(challenge.message);
      const game = await api("/game/start", { method: "POST", body: JSON.stringify({ wallet: state.wallet, nonce: challenge.nonce, signature }) });
      state.game = game;
      state.phase = "preview";
      await showSequence(game.sequence);
      const recall = await api("/game/recall", { method: "POST", body: JSON.stringify({ wallet: state.wallet, gameId: game.gameId }) });
      beginInput(recall);
    } catch (error) {
      handleFailure(error);
    }
  }

  async function finishRun() {
    if (!state.game || !["input", "submitting"].includes(state.phase)) return;
    state.phase = "submitting";
    clearInterval(state.timer);
    runeButtons.forEach(button => { button.disabled = true; });
    $("#phase-title").textContent = "Checking your run";
    setMessage("The server is verifying the sequence and daily prize status.");
    const result = await api("/game/finish", { method: "POST", body: JSON.stringify({ wallet: state.wallet, gameId: state.game.gameId, moves: state.moves }) });
    state.game = null;
    state.recall = null;
    state.phase = "idle";
    if (!result.won) {
      progress.forEach(item => item.classList.add("error"));
      $("#phase-title").textContent = "Signal missed";
      setMessage(result.message || "The rune order did not match. Try a fresh signal.", "error");
      render();
      return;
    }
    progress.forEach(item => item.classList.add("filled"));
    $("#phase-title").textContent = result.paid ? "CWGUILD sent" : "Practice complete";
    setMessage(result.paid ? `${formatToken(result.claim.amount)} is on its way to ${short(state.wallet)}.` : result.message, "good");
    if (result.claim?.txHash) showTransaction(result.claim.txHash);
    await loadStatus();
  }

  function showTransaction(hash) {
    const link = $("#transaction-link");
    link.href = `https://explorer.roninchain.com/tx/${hash}`;
    link.hidden = false;
  }

  function handleFailure(error) {
    clearInterval(state.timer);
    state.phase = "idle";
    state.game = null;
    state.recall = null;
    runeButtons.forEach(button => { button.disabled = true; });
    $("#phase-title").textContent = "Run interrupted";
    setMessage(friendly(error), "error");
    render();
  }

  runeButtons.forEach(button => button.addEventListener("click", () => {
    if (state.phase !== "input" || state.moves.length >= 6) return;
    const rune = button.dataset.rune;
    state.moves.push(rune);
    pulseRune(rune, 160);
    progress[state.moves.length - 1]?.classList.add("filled");
    if (state.moves.length === 6) finishRun().catch(handleFailure);
  }));

  $("#connect-wallet").addEventListener("click", connect);
  $("#start-game").addEventListener("click", startRun);
  loadStatus().catch(error => {
    setMessage(`Rune Run could not load: ${friendly(error)}`, "error");
    $("#phase-title").textContent = "Service unavailable";
  });
})();
