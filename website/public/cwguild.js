(() => {
  "use strict";

  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];
  const state = {
    provider: null,
    signer: null,
    wallet: null,
    config: null,
    runId: null,
    game: null,
    recall: null,
    moves: [],
    phase: "idle",
    timer: null
  };
  const runeButtons = $$('[data-rune]');

  function formatToken(raw, maximumFractionDigits = 2) {
    if (raw == null) return "—";
    const value = Number(window.ethers.formatUnits(BigInt(raw), 18));
    return `${new Intl.NumberFormat(undefined, { maximumFractionDigits }).format(value)} CWGUILD`;
  }

  function short(address) {
    return address ? `${address.slice(0, 6)}…${address.slice(-4)}` : "Not connected";
  }

  function runStorageKey() {
    return state.wallet ? `cwguild-run:${new Date().toISOString().slice(0, 10)}:${state.wallet.toLowerCase()}` : null;
  }

  function rememberRun(runId) {
    state.runId = runId;
    const key = runStorageKey();
    if (key && runId) localStorage.setItem(key, runId);
  }

  function restoreRun() {
    const key = runStorageKey();
    state.runId = key ? localStorage.getItem(key) : null;
  }

  function setMessage(message, tone = "") {
    $("#game-message").textContent = message;
    $("#game-message").className = `game-message ${tone}`.trim();
  }

  function friendly(error) {
    const message = String(error?.shortMessage || error?.reason || error?.message || error || "Rune Run request failed.");
    if (/user rejected|user denied|4001/i.test(message)) return "Wallet signature cancelled. No funds moved.";
    if (/already used/i.test(message)) return "This wallet already used today's ladder attempt. Come back after 00:00 UTC.";
    if (/entry fee|required before starting/i.test(message)) return message;
    if (/payouts are disabled/i.test(message)) return "Paid entry is locked until real CWGUILD payouts are enabled.";
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
      restoreRun();
      button.textContent = short(state.wallet);
      await loadStatus();
      if (!state.config.live) setMessage("Paid entry is locked because real CWGUILD payouts are currently disabled.");
      else if (!state.config.run && state.config.entry?.status !== "verified" && !state.config.canAffordEntry) setMessage(`Hold at least ${formatToken(state.config.recommendedStartingBalance)} before paying: the fee plus the required remaining balance.`);
      else if (!state.config.run && state.config.entry?.status !== "verified") setMessage(`Ready to pay the non-refundable ${formatToken(state.config.entryAmount, 0)} entry fee.`);
      else if (state.config.run?.status === "decision" && state.runId) showDecision(state.config.run);
      else if (!state.config.run) setMessage("Entry verified. Sign in to start today's one-attempt ladder.");
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
    renderLadder();
    render();
  }

  function renderLadder() {
    const ladder = state.config?.rules?.ladder || [];
    $("#ladder").innerHTML = ladder.map(rule => `
      <li class="${state.config?.run?.round === rule.round ? "current" : ""}">
        <b>R${rule.round}</b><span>${rule.sequenceLength} signals · ${rule.playMs / 1000}s</span><strong>${formatToken(rule.rewardAmount, 0)}</strong>
      </li>`).join("");
  }

  function render() {
    const config = state.config;
    if (!config) return;
    $("#entry-amount").textContent = formatToken(config.entryAmount, 0);
    $("#minimum-balance").textContent = formatToken(config.minimumBalance, 0);
    $("#prize-amount").textContent = formatToken(config.rules.ladder.at(-1).rewardAmount, 0);
    $("#pool-balance").textContent = formatToken(config.poolBalance, 0);
    $("#max-payout").textContent = formatToken(config.maxPayout, 0);
    $("#payout-remaining").textContent = `${formatToken(config.remainingPayout, 0)} remaining`;
    $("#prize-mode").textContent = config.live ? "Maximum ladder cash out" : "Practice ladder · payouts off";
    $("#wallet-address").textContent = short(state.wallet);
    $("#wallet-balance").textContent = state.wallet ? formatToken(config.balance) : "Connect wallet";
    const operator = config.operatorAddress;
    $("#operator-address").textContent = operator || "Not configured";
    $("#operator-link").href = operator ? `https://explorer.roninchain.com/address/${operator}` : "#";
    $("#operator-link").toggleAttribute("aria-disabled", !operator);

    const run = config.run;
    const verifiedEntry = config.entry?.status === "verified";
    const entryComplete = Boolean(run) || verifiedEntry;
    const pay = $("#pay-entry");
    pay.disabled = state.phase !== "idle" || !state.wallet || !config.live || !config.canAffordEntry || entryComplete || !$("#entry-ack").checked;
    if (!state.wallet) pay.textContent = "CONNECT RONIN TO PAY";
    else if (!config.live) pay.textContent = "ENTRY LOCKED · PAYOUTS OFF";
    else if (run) pay.textContent = "ENTRY CONSUMED FOR TODAY'S ATTEMPT";
    else if (verifiedEntry) pay.textContent = "ENTRY VERIFIED · READY TO START";
    else if (!config.canAffordEntry) pay.textContent = `NEED ${formatToken(config.recommendedStartingBalance, 0)}`;
    else pay.textContent = `PAY ${formatToken(config.entryAmount, 0)} ENTRY`;
    const entryStatus = $("#entry-status");
    entryStatus.textContent = verifiedEntry
      ? `Verified on Ronin · ${config.entry.txHash.slice(0, 10)}…${config.entry.txHash.slice(-6)}`
      : run ? "Entry consumed by today's attempt" : "One non-refundable payment unlocks one ladder attempt";
    entryStatus.href = config.entry?.txHash ? `https://explorer.roninchain.com/tx/${config.entry.txHash}` : "#";
    entryStatus.toggleAttribute("aria-disabled", !config.entry?.txHash);

    const start = $("#start-game");
    const used = run && ["lost", "cashed", "cashing"].includes(run.status);
    const capReached = BigInt(config.remainingPayout || 0) < BigInt(config.prizeAmount || 0);
    start.disabled = state.phase !== "idle" || !state.wallet || !config.eligible || !entryComplete || used || capReached || (run?.status === "decision" && Boolean(state.runId));
    if (!state.wallet) start.textContent = "CONNECT RONIN TO PLAY";
    else if (!config.eligible) start.textContent = "MORE CWGUILD NEEDED";
    else if (!entryComplete) start.textContent = "PAY ENTRY TO UNLOCK";
    else if (used) start.textContent = run.status === "lost" ? "TODAY'S ATTEMPT LOST" : "TODAY'S CASH OUT COMPLETE";
    else if (capReached) start.textContent = "PAYOUT CEILING REACHED";
    else if (run?.status === "decision" && !state.runId) start.textContent = "SIGN TO RESUME DECISION";
    else if (run?.status === "active") start.textContent = "SIGN TO RESUME ROUND";
    else if (!config.live) start.textContent = "START PRACTICE LADDER";
    else start.textContent = "START REWARD LADDER";
    if (used && state.phase === "idle") $("#phase-title").textContent = run.status === "lost" ? "Reward forfeited" : "Cash out complete";
    if (config.claim?.txHash) showTransaction(config.claim.txHash);
  }

  function makeProgress(length) {
    $("#sequence").innerHTML = Array.from({ length }, () => "<i></i>").join("");
  }

  function progressItems() {
    return $$("#sequence i");
  }

  function resetBoard(length = 0) {
    state.moves = [];
    makeProgress(length);
    runeButtons.forEach(button => { button.disabled = true; button.classList.remove("active"); });
    clearInterval(state.timer);
    $("#timer").textContent = "—";
    $("#recall-rule").hidden = true;
    $("#decision-panel").hidden = true;
  }

  function pulseRune(name, duration = 260) {
    const button = $(`[data-rune="${name}"]`);
    if (!button) return;
    button.classList.add("active");
    setTimeout(() => button.classList.remove("active"), duration);
  }

  async function showSequence(sequence, round) {
    $("#phase-title").textContent = `Round ${round} · memorize ${sequence.length}`;
    setMessage("Watch closely. The random recall rule appears only after the signal disappears.");
    await new Promise(resolve => setTimeout(resolve, 350));
    for (const rune of sequence) {
      pulseRune(rune, 300);
      await new Promise(resolve => setTimeout(resolve, 390));
    }
  }

  function beginInput(recall) {
    state.phase = "input";
    state.recall = recall;
    $("#phase-title").textContent = `Round ${state.game.round} · timed recall`;
    const direction = recall.direction === "forward" ? "FORWARD" : "BACKWARD";
    $("#recall-rule").textContent = `START AT SIGNAL #${recall.startPosition} · MOVE ${direction}`;
    $("#recall-rule").hidden = false;
    const atRisk = BigInt(state.game.pendingAmount || 0) > 0n ? `${formatToken(state.game.pendingAmount, 0)} is at risk. ` : "";
    setMessage(`${atRisk}Complete all ${state.game.sequenceLength} moves before time expires.`);
    runeButtons.forEach(button => { button.disabled = false; });
    const deadline = recall.expiresAt || Date.now() + recall.inputMs;
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

  async function playGame(game) {
    rememberRun(game.runId || state.runId);
    state.game = game;
    resetBoard(game.sequenceLength);
    if (game.recall) {
      beginInput(game.recall);
      render();
      return;
    }
    state.phase = "preview";
    render();
    await showSequence(game.sequence, game.round);
    const recall = await api("/game/recall", {
      method: "POST",
      body: JSON.stringify({ wallet: state.wallet, runId: state.runId, gameId: game.gameId })
    });
    beginInput(recall);
  }

  async function startRun() {
    if (!state.wallet || !state.signer || state.phase !== "idle") return;
    state.phase = "signing";
    resetBoard();
    render();
    try {
      $("#phase-title").textContent = "Verify your wallet";
      setMessage("Sign the ladder entry message. It is not a transaction or token approval.");
      const challenge = await api("/auth/challenge", { method: "POST", body: JSON.stringify({ wallet: state.wallet }) });
      const signature = await state.signer.signMessage(challenge.message);
      const result = await api("/game/start", { method: "POST", body: JSON.stringify({ wallet: state.wallet, nonce: challenge.nonce, signature }) });
      rememberRun(result.runId);
      if (result.run) {
        state.phase = "decision";
        showDecision(result.run);
        return;
      }
      await playGame(result);
    } catch (error) {
      handleFailure(error);
    }
  }

  async function payEntry() {
    if (!state.wallet || !state.signer || state.phase !== "idle" || !state.config?.live) return;
    if (!$("#entry-ack").checked) return setMessage("Accept the non-refundable entry terms before opening the wallet transaction.", "error");
    state.phase = "paying";
    render();
    try {
      $("#phase-title").textContent = "Confirm the entry transfer";
      setMessage(`Ronin Wallet will ask you to transfer exactly ${formatToken(state.config.entryAmount, 0)} to ${short(state.config.operatorAddress)}. This payment is non-refundable.`);
      const token = new window.ethers.Contract(state.config.token.address, ["function transfer(address recipient,uint256 amount) returns (bool)"], state.signer);
      const transaction = await token.transfer(state.config.operatorAddress, BigInt(state.config.entryAmount));
      setMessage(`Entry submitted: ${transaction.hash.slice(0, 10)}… Waiting for two Ronin confirmations.`);
      await transaction.wait(2);
      await api("/entry/verify", {
        method: "POST",
        body: JSON.stringify({ wallet: state.wallet, txHash: transaction.hash })
      });
      state.phase = "idle";
      await loadStatus();
      $("#phase-title").textContent = "Entry verified";
      setMessage(`${formatToken(state.config.entryAmount, 0)} was received by the reward wallet. Sign in to begin the one-attempt ladder.`, "good");
    } catch (error) {
      state.phase = "idle";
      setMessage(friendly(error), "error");
      render();
    }
  }

  async function finishRun() {
    if (!state.game || !["input", "submitting"].includes(state.phase)) return;
    state.phase = "submitting";
    clearInterval(state.timer);
    runeButtons.forEach(button => { button.disabled = true; });
    $("#phase-title").textContent = "Checking your round";
    setMessage("The server is verifying the signal and timer.");
    const result = await api("/game/finish", {
      method: "POST",
      body: JSON.stringify({ wallet: state.wallet, runId: state.runId, gameId: state.game.gameId, moves: state.moves })
    });
    state.game = null;
    state.recall = null;
    if (!result.won) {
      state.phase = "idle";
      progressItems().forEach(item => item.classList.add("error"));
      $("#phase-title").textContent = "Everything at risk was lost";
      const forfeited = BigInt(result.forfeitedAmount || 0) > 0n ? ` ${formatToken(result.forfeitedAmount, 0)} was forfeited.` : "";
      setMessage(`${result.message || "The signal did not match."}${forfeited}`, "error");
      await loadStatus();
      return;
    }
    progressItems().forEach(item => item.classList.add("filled"));
    state.phase = "decision";
    showDecision({
      status: "decision",
      round: result.round,
      pendingAmount: result.pendingAmount,
      canRisk: result.canRisk,
      canCashOut: true,
      maxRounds: state.config.rules.ladder.length
    });
    await loadStatus();
  }

  function showDecision(run) {
    state.phase = "decision";
    const panel = $("#decision-panel");
    panel.hidden = false;
    $("#decision-round").textContent = `ROUND ${run.round} CLEARED`;
    $("#pending-reward").textContent = formatToken(run.pendingAmount, 0);
    $("#phase-title").textContent = run.canRisk ? "Cash out or risk everything" : "Final round cleared";
    setMessage(run.canRisk
      ? "This reward is unpaid. Cash out now, or explicitly accept the next round—one miss or timeout reduces it to zero."
      : "You reached the top. Cash out the provisional reward to request payment.", "good");
    const risk = $("#risk-next");
    risk.hidden = !run.canRisk;
    risk.textContent = run.canRisk ? `I ACCEPT THE RISK · PLAY ROUND ${run.round + 1}` : "";
    $("#cash-out").textContent = `CASH OUT ${formatToken(run.pendingAmount, 0)}`;
    runeButtons.forEach(button => { button.disabled = true; });
    $("#timer").textContent = "—";
    render();
  }

  async function riskNext() {
    if (state.phase !== "decision" || !state.runId) return;
    state.phase = "loading";
    $("#cash-out").disabled = true;
    $("#risk-next").disabled = true;
    setMessage("Risk accepted. The entire provisional reward is now exposed to the next round.");
    let accepted = false;
    try {
      const game = await api("/game/next", {
        method: "POST",
        body: JSON.stringify({ wallet: state.wallet, runId: state.runId })
      });
      accepted = true;
      await playGame(game);
    } catch (error) {
      state.phase = accepted ? "idle" : "decision";
      handleFailure(error, !accepted);
    } finally {
      $("#cash-out").disabled = false;
      $("#risk-next").disabled = false;
    }
  }

  async function cashOut() {
    if (state.phase !== "decision" || !state.runId) return;
    state.phase = "cashing";
    $("#cash-out").disabled = true;
    $("#risk-next").disabled = true;
    $("#phase-title").textContent = "Cashing out";
    setMessage("Checking the lifetime payout ceiling and reward wallet, then submitting payment.");
    try {
      const result = await api("/game/cashout", {
        method: "POST",
        body: JSON.stringify({ wallet: state.wallet, runId: state.runId })
      });
      state.phase = "idle";
      $("#decision-panel").hidden = true;
      $("#phase-title").textContent = result.paid ? "CWGUILD sent" : "Practice cash out complete";
      setMessage(result.paid ? `${formatToken(result.claim.amount, 0)} is on its way to ${short(state.wallet)}.` : result.message, "good");
      if (result.claim?.txHash) showTransaction(result.claim.txHash);
      await loadStatus();
    } catch (error) {
      state.phase = "decision";
      setMessage(friendly(error), "error");
      $("#cash-out").disabled = false;
      $("#risk-next").disabled = false;
      render();
    }
  }

  function showTransaction(hash) {
    const link = $("#transaction-link");
    link.href = `https://explorer.roninchain.com/tx/${hash}`;
    link.hidden = false;
  }

  function handleFailure(error, preserveDecision = false) {
    clearInterval(state.timer);
    state.phase = preserveDecision ? "decision" : "idle";
    if (!preserveDecision) {
      state.game = null;
      state.recall = null;
      $("#decision-panel").hidden = true;
    }
    runeButtons.forEach(button => { button.disabled = true; });
    $("#phase-title").textContent = preserveDecision ? "Decision still open" : "Run interrupted";
    setMessage(friendly(error), "error");
    render();
  }

  runeButtons.forEach(button => button.addEventListener("click", () => {
    if (state.phase !== "input" || state.moves.length >= state.game.sequenceLength) return;
    const rune = button.dataset.rune;
    state.moves.push(rune);
    pulseRune(rune, 160);
    progressItems()[state.moves.length - 1]?.classList.add("filled");
    if (state.moves.length === state.game.sequenceLength) finishRun().catch(handleFailure);
  }));

  $("#connect-wallet").addEventListener("click", connect);
  $("#start-game").addEventListener("click", startRun);
  $("#pay-entry").addEventListener("click", payEntry);
  $("#entry-ack").addEventListener("change", render);
  $("#risk-next").addEventListener("click", riskNext);
  $("#cash-out").addEventListener("click", cashOut);
  loadStatus().catch(error => {
    setMessage(`Rune Run could not load: ${friendly(error)}`, "error");
    $("#phase-title").textContent = "Service unavailable";
  });
})();
