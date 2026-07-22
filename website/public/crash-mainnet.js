(() => {
  "use strict";
  if (!window.ethers) return;

  const CHAIN_ID = 2020;
  const CHAIN_HEX = "0x7e4";
  const RPC_URL = "https://api.roninchain.com/rpc";
  const BETTING_MS = 15_000;
  const STATE_POLL_MS = 650;
  const ACCOUNT_POLL_MS = 5_000;
  const STATS_PREFIX = "matt-crash-mainnet-stats";
  const $ = id => document.getElementById(id);
  const els = {
    canvas: $("crash-canvas"), card: $("flight-card"), multiplier: $("multiplier"), phase: $("phase-label"), countdown: $("countdown"), rocket: $("rocket"), flash: $("crash-flash"), crashTitle: $("crash-title"), milestone: $("milestone-banner"),
    roundNumber: $("round-number"), history: $("history-strip"), playerCount: $("player-count"), roundTotal: $("round-total"), largestBet: $("largest-bet"),
    connect: $("connect-wallet"), balance: $("demo-balance"), balanceLabel: $("balance-label"), betAmount: $("bet-amount"), autoEnabled: $("auto-enabled"), autoMultiplier: $("auto-multiplier"), potential: $("potential-payout"),
    action: $("primary-action"), withdraw: $("repeat-bet"), resetBalance: $("reset-balance"), clearStats: $("clear-stats"), message: $("game-message"), warning: $("mode-warning"), playersBody: $("players-body"), liveStatus: $("live-status"),
    fairRound: $("fair-round"), fairCommitment: $("fair-commitment"), fairSeed: $("fair-seed"), fairResult: $("fair-result"), verify: $("verify-round"), verifyMessage: $("verify-message"),
    sound: $("sound-toggle"), statRounds: $("stat-rounds"), statWins: $("stat-wins"), statBest: $("stat-best"), statPayout: $("stat-payout"), statStreak: $("stat-streak"), statProfit: $("stat-profit")
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

  const ctx = els.canvas.getContext("2d", { alpha: true });
  let liveState = null;
  let clockOffset = 0;
  let statePolling = false;
  let accountPolling = false;
  let browserProvider = null;
  let readProvider = null;
  let signer = null;
  let wallet = null;
  let vault = null;
  let readVault = null;
  let token = null;
  let account = null;
  let pendingAction = "";
  let currentWagerId = null;
  let currentWagerRoundId = null;
  let syncedRoundId = null;
  let cashoutSentForRound = null;
  let crashSessionToken = null;
  let crashSessionExpiresAt = 0;
  let displayedMultiplier = 1;
  let displayedProgress = 0;
  let lastRoundNumber = null;
  let lastFrameAt = performance.now();
  let lastUiAt = 0;
  let lastHistoryKey = "";
  let lastPlayersKey = "";
  let lastMilestone = 1;
  let crashFxRound = null;
  let audioContext = null;
  let scene = createScene();
  let stats = loadStats();

  function roninProvider() { return window.ronin?.provider || null; }
  function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }
  function lerp(a, b, amount) { return a + (b - a) * amount; }
  function elapsedToMultiplier(milliseconds) { const seconds = Math.max(0, milliseconds / 1000); return Math.exp(0.055 * seconds + 0.0028 * seconds * seconds); }
  function shortAddress(address) { return address ? `${address.slice(0, 6)}…${address.slice(-4)}` : "CONNECT RONIN"; }
  function escapeHtml(value) { return String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char])); }
  function tokenNumber(raw) {
    try { return Number(window.ethers.formatEther(BigInt(raw || 0))); }
    catch { return 0; }
  }
  function formatMattRaw(raw, precision = 0) {
    const value = tokenNumber(raw);
    return `${value.toLocaleString(undefined, { maximumFractionDigits: precision })} MATT`;
  }
  function formatMattNumber(value, precision = 0) { return `${Number(value || 0).toLocaleString(undefined, { maximumFractionDigits: precision })} MATT`; }
  function say(text, type = "") { els.message.textContent = text; els.message.className = `game-message ${type}`; }
  function statsKey() { return `${STATS_PREFIX}:${wallet ? wallet.toLowerCase() : "guest"}`; }
  function defaultStats() { return { sound: true, rounds: 0, wins: 0, best: 0, biggestPayout: 0, streak: 0, net: 0, results: {} }; }
  function loadStats() {
    try {
      const saved = JSON.parse(localStorage.getItem(statsKey()) || "{}");
      return { ...defaultStats(), ...saved, results: { ...(saved.results || {}) } };
    } catch { return defaultStats(); }
  }
  function saveStats() {
    const entries = Object.entries(stats.results || {});
    if (entries.length > 120) stats.results = Object.fromEntries(entries.slice(-120));
    localStorage.setItem(statsKey(), JSON.stringify(stats));
  }
  function renderStats() {
    els.sound.textContent = stats.sound ? "SOUND ON" : "SOUND OFF";
    els.sound.setAttribute("aria-pressed", String(stats.sound));
    els.statRounds.textContent = Number(stats.rounds || 0).toLocaleString();
    els.statWins.textContent = Number(stats.wins || 0).toLocaleString();
    els.statBest.textContent = stats.best ? `${Number(stats.best).toFixed(2)}x` : "—";
    els.statPayout.textContent = formatMattNumber(stats.biggestPayout || 0);
    els.statStreak.textContent = Number(stats.streak || 0).toLocaleString();
    els.statProfit.textContent = `${stats.net >= 0 ? "+" : "−"}${formatMattNumber(Math.abs(stats.net || 0))}`;
    els.statProfit.style.color = stats.net >= 0 ? "var(--green)" : "var(--red)";
  }
  function recordPlacement(roundId, amountRaw) {
    if (!roundId) return;
    const existing = stats.results[roundId] || {};
    if (existing.placed) return;
    const amount = tokenNumber(amountRaw);
    stats.results[roundId] = { ...existing, placed: true, amount, resolved: false };
    stats.rounds += 1;
    stats.net -= amount;
    saveStats(); renderStats();
  }
  function recordResult(roundId, player) {
    if (!roundId || !player || !["won", "lost"].includes(player.status)) return;
    const existing = stats.results[roundId] || {};
    if (!existing.placed) recordPlacement(roundId, player.amount);
    const refreshed = stats.results[roundId] || {};
    if (refreshed.resolved) return;
    const payout = tokenNumber(player.payout);
    if (player.status === "won") {
      const cashout = Number(player.cashout || 0);
      stats.wins += 1;
      stats.streak += 1;
      stats.net += payout;
      stats.best = Math.max(stats.best || 0, cashout);
      stats.biggestPayout = Math.max(stats.biggestPayout || 0, payout);
    } else stats.streak = 0;
    stats.results[roundId] = { ...refreshed, resolved: true, status: player.status, payout };
    saveStats(); renderStats();
  }

  async function fetchJson(url, init) {
    const response = await fetch(url, { cache: "no-store", ...init });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.message || body.error || `HTTP ${response.status}`);
    return body;
  }
  function crashSessionStorageKey() {
    return `matt-crash-session:${String(liveState?.vaultAddress || "pending").toLowerCase()}:${String(wallet || "guest").toLowerCase()}`;
  }
  function restoreCrashSession() {
    try {
      const saved = JSON.parse(localStorage.getItem(crashSessionStorageKey()) || "{}");
      if (saved.token && Number(saved.expiresAt) > Date.now() + 60_000) {
        crashSessionToken = String(saved.token);
        crashSessionExpiresAt = Number(saved.expiresAt);
        return true;
      }
    } catch {}
    crashSessionToken = null;
    crashSessionExpiresAt = 0;
    return false;
  }
  function saveCrashSession(token, expiresAt) {
    crashSessionToken = String(token || "");
    crashSessionExpiresAt = Number(expiresAt || 0);
    localStorage.setItem(crashSessionStorageKey(), JSON.stringify({ token: crashSessionToken, expiresAt: crashSessionExpiresAt }));
  }
  function cashoutAttemptKey(roundId) {
    return `matt-crash-cashout-attempt:${String(liveState?.vaultAddress || "").toLowerCase()}:${String(wallet || "").toLowerCase()}:${roundId}`;
  }
  function hasCashoutAttempt(roundId) {
    try { return Boolean(localStorage.getItem(cashoutAttemptKey(roundId))); } catch { return false; }
  }
  function markCashoutAttempt(roundId) {
    try { localStorage.setItem(cashoutAttemptKey(roundId), String(Date.now())); } catch {}
  }
  async function ensureCrashSession(force = false) {
    if (!wallet || !signer || !liveState?.vaultAddress) throw new Error("Connect Ronin Wallet before activating Crash.");
    if (!force && ((crashSessionToken && crashSessionExpiresAt > Date.now() + 60_000) || restoreCrashSession())) return crashSessionToken;
    const challenge = await fetchJson("/api/crash/session/challenge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ wallet })
    });
    say("Sign once to activate instant cash-outs for the next 12 hours.");
    const signature = await signer.signMessage(challenge.message);
    const session = await fetchJson("/api/crash/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ wallet, message: challenge.message, signature })
    });
    saveCrashSession(session.token, session.expiresAt);
    return crashSessionToken;
  }
  async function ensureRoninChain() {
    const provider = roninProvider();
    if (!provider) throw new Error("Ronin Wallet was not detected. Install Ronin Wallet or open this page inside the Ronin mobile app.");
    const chain = await provider.request({ method: "eth_chainId" });
    const normalized = typeof chain === "number" ? chain : String(chain).startsWith("0x") ? Number.parseInt(String(chain), 16) : Number(chain);
    if (normalized !== CHAIN_ID) await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN_HEX }] });
  }
  function ensureContracts() {
    if (!liveState?.vaultAddress || !liveState?.tokenAddress) return;
    if (!readProvider) readProvider = new window.ethers.JsonRpcProvider(RPC_URL, CHAIN_ID, { staticNetwork: true });
    if (!readVault) readVault = new window.ethers.Contract(liveState.vaultAddress, VAULT_ABI, readProvider);
    if (signer) {
      vault = new window.ethers.Contract(liveState.vaultAddress, VAULT_ABI, signer);
      token = new window.ethers.Contract(liveState.tokenAddress, TOKEN_ABI, signer);
    }
  }
  async function activate(address) {
    const provider = roninProvider();
    if (!provider) throw new Error("Ronin Wallet was not detected.");
    await ensureRoninChain();
    browserProvider = new window.ethers.BrowserProvider(provider);
    const checksum = window.ethers.getAddress(address);
    signer = await browserProvider.getSigner(checksum);
    wallet = await signer.getAddress();
    stats = loadStats(); renderStats();
    if (!liveState?.vaultAddress) await pollState(true);
    ensureContracts();
    els.connect.textContent = shortAddress(wallet);
    syncedRoundId = null;
    await ensureCrashSession();
    await refreshAccount(true);
    await syncWagerForCurrentRound(true);
    say("Ronin Wallet connected. Instant cash-outs are active for 12 hours.", "win");
  }
  async function restoreRonin() {
    const provider = roninProvider();
    if (!provider) return false;
    const accounts = await provider.request({ method: "eth_accounts" });
    if (!accounts?.[0]) return false;
    await activate(accounts[0]);
    return true;
  }
  async function connectRonin() {
    if (pendingAction) return;
    pendingAction = "connect";
    try {
      const provider = roninProvider();
      if (!provider) throw new Error("Ronin Wallet was not detected. Install Ronin Wallet or open this page inside the Ronin mobile app.");
      await ensureRoninChain();
      const accounts = await provider.request({ method: "eth_requestAccounts" });
      if (!accounts?.[0]) throw new Error("No Ronin account was approved.");
      await activate(accounts[0]);
    } catch (error) { say(error.shortMessage || error.message || "Ronin Wallet connection failed.", "loss"); }
    finally { pendingAction = ""; }
  }
  function disconnectLocal() {
    browserProvider = signer = vault = token = null;
    wallet = account = currentWagerId = currentWagerRoundId = null;
    crashSessionToken = null;
    crashSessionExpiresAt = 0;
    syncedRoundId = null;
    stats = loadStats(); renderStats();
    els.connect.textContent = "CONNECT RONIN";
    els.balance.textContent = "CONNECT RONIN";
  }
  async function refreshAccount(force = false) {
    if (!wallet || accountPolling || (!force && pendingAction)) return;
    accountPolling = true;
    try {
      account = await fetchJson(`/api/crash/account/${wallet}`);
      els.balance.textContent = formatMattRaw(account.balance);
      const claimable = BigInt(account.claimable || "0");
      els.withdraw.disabled = claimable === 0n || Boolean(pendingAction);
      els.withdraw.textContent = claimable > 0n ? `WITHDRAW ${formatMattRaw(claimable)}` : "NO WINNINGS TO WITHDRAW";
    } catch (error) { console.warn("Crash account refresh failed", error); }
    finally { accountPolling = false; }
  }
  function wagerId(roundId) {
    return window.ethers.keccak256(window.ethers.solidityPacked(["uint256", "address", "bytes32", "address"], [BigInt(CHAIN_ID), liveState.vaultAddress, roundId, wallet]));
  }
  async function syncWagerForCurrentRound(force = false) {
    const roundId = liveState?.round?.roundId;
    if (!wallet || !vault || !roundId) return;
    if (!force && syncedRoundId === roundId) return;
    syncedRoundId = roundId;
    try {
      const id = wagerId(roundId);
      const data = await vault.wagers(id);
      const matches = String(data.player).toLowerCase() === wallet.toLowerCase();
      currentWagerId = matches && !data.settled ? id : null;
      currentWagerRoundId = currentWagerId ? roundId : null;
      if (currentWagerId && hasCashoutAttempt(roundId)) cashoutSentForRound = roundId;
    } catch (error) {
      syncedRoundId = null;
      console.warn("Crash wager sync failed", error);
    }
  }

  function parsedBet() {
    const amount = Number(els.betAmount.value);
    const min = tokenNumber(liveState?.limits?.minWager || "0");
    const max = tokenNumber(liveState?.limits?.maxWager || "0");
    if (!Number.isFinite(amount) || amount < min || amount > max) throw new Error(`Bet must be between ${min.toLocaleString()} and ${max.toLocaleString()} MATT.`);
    return window.ethers.parseEther(String(Math.floor(amount)));
  }
  async function placeBet() {
    if (!wallet) return connectRonin();
    const round = liveState?.round;
    if (!liveState || liveState.mode !== "LIVE_MAINNET" || liveState.paused) throw new Error("Live wagering is not open.");
    if (!round || round.phase !== "betting") throw new Error("Betting is closed for this flight.");
    if (currentWagerId) throw new Error("You already have a wager in this round.");
    const amount = parsedBet();
    pendingAction = "bet";
    try {
      await ensureCrashSession();
      ensureContracts();
      const allowance = await token.allowance(wallet, liveState.vaultAddress);
      if (allowance < amount) {
        say("Approve MATT in Ronin Wallet, then confirm the wager.");
        await (await token.approve(liveState.vaultAddress, amount)).wait();
      }
      say("Confirming your mainnet wager in Ronin Wallet…");
      const tx = await vault.openWager(round.roundId, amount);
      await tx.wait();
      currentWagerId = wagerId(round.roundId);
      currentWagerRoundId = round.roundId;
      syncedRoundId = round.roundId;
      recordPlacement(round.roundId, amount);
      say(`${formatMattRaw(amount)} locked for flight #${round.number}.`, "win");
      await Promise.all([refreshAccount(true), pollState(true)]);
    } finally { pendingAction = ""; }
  }
  async function cashOut(auto = false) {
    const round = liveState?.round;
    if (!wallet || !currentWagerId || currentWagerRoundId !== round?.roundId || round?.phase !== "flying") throw new Error("No active wager to cash out.");
    if (cashoutSentForRound === round.roundId || pendingAction) return;
    if (!crashSessionToken || crashSessionExpiresAt <= Date.now()) throw new Error("Crash session expired. Sign once to reactivate instant cash-outs before placing another wager.");
    const cashoutRoundId = round.roundId;
    cashoutSentForRound = cashoutRoundId;
    pendingAction = "cashout";
    say(`${auto ? "Auto cash-out" : "Cash-out"} sent. Cashing Out…`);
    try {
      let lastError = null;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const result = await fetchJson("/api/crash/cashout", {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${crashSessionToken}` },
            body: JSON.stringify({ roundId: cashoutRoundId })
          });
          markCashoutAttempt(cashoutRoundId);
          say(`${auto ? "Auto cash-out" : "Cash-out"} locked at ${Number(result.multiplier).toFixed(2)}x. Settlement follows impact.`, "win");
          await pollState(true);
          return;
        } catch (error) {
          lastError = error;
          if (/CRASH_SESSION_REQUIRED|ROUND_NOT_CURRENT|ROUND_NOT_FLYING|TOO_LATE|NO_OPEN_WAGER/.test(String(error.message))) throw error;
          say(`Cash-out response was unclear. Retrying the same server-idempotent request…`);
          await new Promise(resolve => setTimeout(resolve, 350 * (attempt + 1)));
        }
      }
      await pollState(true);
      throw lastError || new Error("Cash-out request failed.");
    } catch (error) {
      const player = ownPlayer();
      if (player?.status === "won") {
        markCashoutAttempt(cashoutRoundId);
        say(`${auto ? "Auto cash-out" : "Cash-out"} recovered at ${Number(player.cashout || 0).toFixed(2)}x.`, "win");
        return;
      }
      cashoutSentForRound = null;
      say(`Cash-out was not accepted: ${error.message}. You may retry while the round is still flying.`, "loss");
      throw error;
    } finally { pendingAction = ""; }
  }
  async function withdraw() {
    if (!wallet) return connectRonin();
    if (!account || BigInt(account.claimable || "0") === 0n) throw new Error("There are no settled winnings to withdraw.");
    if (pendingAction) return;
    pendingAction = "withdraw";
    try {
      say("Confirm the withdrawal in Ronin Wallet…");
      await (await vault.withdraw()).wait();
      say("Winnings withdrawn to your Ronin Wallet.", "win");
      await refreshAccount(true);
    } finally { pendingAction = ""; }
  }
  async function verifyRound() {
    const round = liveState?.round;
    if (!round?.seed || !round?.roundId) return say("Verification unlocks after impact.");
    ensureContracts();
    const verifier = vault || readVault;
    if (!verifier) throw new Error("Verification provider is unavailable.");
    const bps = await verifier.calculateCrashPointBps(round.seed, round.roundId);
    const calculated = Number(bps) / 10_000;
    const matches = Math.abs(calculated - Number(round.crashPoint)) < 0.0001;
    els.verifyMessage.textContent = matches ? `Verified on-chain: ${calculated.toFixed(4)}x.` : "Verification failed. Do not continue playing.";
    els.verifyMessage.className = matches ? "verify-message verified" : "verify-message failed";
  }

  async function pollState(_force = false) {
    if (statePolling) return;
    statePolling = true;
    try {
      const started = Date.now();
      const payload = await fetchJson("/api/crash/state");
      const latency = (Date.now() - started) / 2;
      const measuredOffset = Number(payload.serverTime || Date.now()) + latency - Date.now();
      clockOffset += (measuredOffset - clockOffset) * 0.2;
      const previousRoundId = liveState?.round?.roundId || null;
      liveState = payload;
      ensureContracts();
      const nextRoundId = liveState?.round?.roundId || null;
      if (previousRoundId !== nextRoundId) {
        currentWagerId = null;
        currentWagerRoundId = null;
        syncedRoundId = null;
        cashoutSentForRound = null;
      }
      if (wallet && nextRoundId && syncedRoundId !== nextRoundId) syncWagerForCurrentRound().catch(() => {});
      reconcileOwnPlayer();
      renderHistory();
      renderPlayers();
    } catch (error) {
      els.liveStatus.textContent = "RECONNECTING";
      say(`Live flight server unavailable: ${error.message}. Reconnecting automatically…`, "loss");
    } finally { statePolling = false; }
  }
  async function stateLoop() {
    await pollState();
    setTimeout(stateLoop, STATE_POLL_MS);
  }
  async function accountLoop() {
    await refreshAccount();
    setTimeout(accountLoop, ACCOUNT_POLL_MS);
  }

  function ownPlayer() {
    if (!wallet) return null;
    return (liveState?.players || []).find(player => String(player.wallet).toLowerCase() === wallet.toLowerCase()) || null;
  }
  function reconcileOwnPlayer() {
    const round = liveState?.round;
    const player = ownPlayer();
    if (!round || !player) return;
    recordPlacement(round.roundId, player.amount);
    if (["queued", "locked", "playing"].includes(player.status)) {
      currentWagerId = player.wagerId;
      currentWagerRoundId = round.roundId;
    }
    if (player.status === "won") cashoutSentForRound = round.roundId;
    if (round.phase === "crashed") {
      recordResult(round.roundId, player);
      currentWagerId = null;
      currentWagerRoundId = null;
      setTimeout(() => refreshAccount(true), 800);
    }
  }
  function renderHistory() {
    const history = liveState?.history || [];
    const key = history.map(item => `${item.roundNumber}:${item.crashPoint}`).join("|");
    if (key === lastHistoryKey) return;
    lastHistoryKey = key;
    els.history.innerHTML = history.length ? history.map(item => {
      const value = Number(item.crashPoint || 0);
      const cls = value >= 100 ? "legendary" : value >= 10 ? "high" : value >= 2 ? "mid" : "";
      return `<span class="history-pill ${cls}" title="Round #${Number(item.roundNumber)}">${value.toFixed(2)}x</span>`;
    }).join("") : `<span class="history-pill">Waiting for completed mainnet flights…</span>`;
  }
  function renderPlayers() {
    const players = liveState?.players || [];
    const round = liveState?.round;
    const key = `${round?.roundId || "none"}:${round?.phase || "none"}:${players.map(player => `${player.wagerId}:${player.status}:${player.cashoutBps}`).join("|")}`;
    if (key === lastPlayersKey) return;
    lastPlayersKey = key;
    if (!players.length) {
      els.playersBody.innerHTML = `<tr><td colspan="4" style="text-align:center;color:var(--muted);padding:24px">No live wagers in this flight yet.</td></tr>`;
    } else {
      els.playersBody.innerHTML = players.map(player => {
        const isYou = wallet && String(player.wallet).toLowerCase() === wallet.toLowerCase();
        const label = isYou ? "YOU" : shortAddress(String(player.wallet));
        const status = player.status === "won" ? `${Number(player.cashout || 0).toFixed(2)}x` : player.status === "playing" ? "FLYING" : player.status === "lost" ? "IMPACT" : player.status === "locked" ? "LOCKED" : "QUEUED";
        const payout = BigInt(player.payout || "0") > 0n ? formatMattRaw(player.payout) : "—";
        return `<tr class="${isYou ? "you" : ""}"><td title="${escapeHtml(player.wallet)}">${escapeHtml(label)}</td><td>${formatMattRaw(player.amount)}</td><td><span class="player-status ${escapeHtml(player.status)}">${escapeHtml(status)}</span></td><td>${payout}</td></tr>`;
      }).join("");
    }
    const summary = liveState?.summary || {};
    els.playerCount.textContent = Number(summary.playerCount ?? players.length).toLocaleString();
    els.roundTotal.textContent = formatMattRaw(summary.roundTotal || "0");
    els.largestBet.textContent = formatMattRaw(summary.largestBet || "0");
  }

  function currentRoundView() {
    const round = liveState?.round;
    if (!round) return null;
    const now = Date.now() + clockOffset;
    let multiplier = Number(round.multiplier || 1);
    if (round.phase === "flying") {
      const flightStartedAt = Number(round.flightStartedAt || (Number(round.startAt || now) + Number(liveState?.timing?.bettingMs || BETTING_MS)));
      multiplier = Math.max(1, elapsedToMultiplier(now - flightStartedAt));
    } else if (["preparing", "betting", "launching"].includes(round.phase)) multiplier = 1;
    else if (round.phase === "crashed") multiplier = Number(round.crashPoint || round.multiplier || 1);
    return { ...round, multiplier, now, left: Math.max(0, Number(round.phaseEndsAt || now) - now) };
  }
  function phaseLabel(phase) {
    if (phase === "preparing") return "PREPARING ROUND";
    if (phase === "betting") return "LAUNCH WINDOW";
    if (phase === "launching") return "IGNITION";
    if (phase === "flying") return "MATT IN FLIGHT";
    return "MATT DOWN";
  }
  function liveStatusLabel(phase) {
    if (phase === "preparing") return "PREPARING";
    if (phase === "betting") return "BETTING OPEN";
    if (phase === "launching") return "LAUNCHING";
    if (phase === "flying") return "LIVE FLIGHT";
    return "IMPACT";
  }
  function countdownLabel(round, shown) {
    if (round.phase === "preparing") return "Keeper is committing the next flight on-chain";
    if (round.phase === "betting") return `Launch in ${(round.left / 1000).toFixed(1)}s`;
    if (round.phase === "launching") return "Seed reveal confirmed — engines starting";
    if (round.phase === "flying") return shown >= 10 ? "Warp speed — cash out before impact" : "Cash out before impact";
    return `Next launch in ${(round.left / 1000).toFixed(1)}s`;
  }
  function updatePotential() {
    const amount = Math.max(0, Number(els.betAmount.value || 0));
    const auto = clamp(Number(els.autoMultiplier.value || 2), 1.01, Number(liveState?.limits?.maxCashoutBps || 100_000) / 10_000 || 10);
    els.potential.textContent = formatMattNumber(amount * auto);
  }
  function renderControls(round, shown) {
    els.balanceLabel.textContent = "WALLET BALANCE";
    els.warning.textContent = liveState?.mode === "LIVE_MAINNET" ? "LIVE RONIN MAINNET • REAL MATT • WAGERS CANNOT BE REVERSED" : liveState?.paused ? "MAINNET VAULT PAUSED • WAGERING LOCKED" : "LIVE MODE IS NOT CONFIGURED";
    els.action.classList.remove("cashout");
    if (!wallet) {
      els.action.disabled = false;
      els.action.textContent = "CONNECT RONIN";
      return;
    }
    if (pendingAction) {
      els.action.disabled = true;
      els.action.textContent = pendingAction === "cashout" ? "CASHING OUT…" : pendingAction === "bet" ? "CONFIRM IN RONIN" : "WAITING FOR RONIN";
      return;
    }
    if (!round || liveState?.mode !== "LIVE_MAINNET" || liveState?.paused) {
      els.action.disabled = true;
      els.action.textContent = "WAGERING LOCKED";
      return;
    }
    if (round.phase === "betting") {
      els.action.disabled = Boolean(currentWagerId);
      els.action.textContent = currentWagerId ? "BET PLACED" : "PLACE REAL MATT BET";
      return;
    }
    if (round.phase === "flying" && currentWagerId && currentWagerRoundId === round.roundId && cashoutSentForRound !== round.roundId) {
      els.action.disabled = false;
      els.action.classList.add("cashout");
      els.action.textContent = `CASH OUT • ${shown.toFixed(2)}x`;
      const auto = Number(els.autoMultiplier.value || 0);
      if (els.autoEnabled.checked && auto >= 1.01 && shown >= auto) cashOut(true).catch(error => say(error.message, "loss"));
      return;
    }
    els.action.disabled = true;
    if (cashoutSentForRound === round.roundId) els.action.textContent = "CASH-OUT LOCKED";
    else if (round.phase === "launching") els.action.textContent = "LAUNCHING";
    else if (round.phase === "crashed") els.action.textContent = `IMPACT • ${shown.toFixed(2)}x`;
    else els.action.textContent = "FLIGHT IN PROGRESS";
  }
  function updateUi(round, shown) {
    if (!round) {
      els.roundNumber.textContent = "—";
      els.phase.textContent = "PREPARING";
      els.countdown.textContent = "Waiting for the mainnet keeper…";
      els.multiplier.textContent = "1.00x";
      els.liveStatus.textContent = "CONNECTING";
      renderControls(null, 1);
      return;
    }
    els.roundNumber.textContent = `#${String(round.number).padStart(6, "0")}`;
    els.fairRound.textContent = `#${String(round.number).padStart(6, "0")}`;
    els.fairCommitment.textContent = round.commitment || "Preparing…";
    els.fairSeed.textContent = round.seed || "Revealed after impact";
    els.fairResult.textContent = round.crashPoint ? `${Number(round.crashPoint).toFixed(4)}x` : "Waiting for impact";
    els.verify.disabled = !round.seed;
    if (!round.seed) els.verifyMessage.textContent = "The commitment was written on-chain before the launch window closed.";
    els.multiplier.textContent = `${shown.toFixed(2)}x`;
    els.multiplier.style.color = round.phase === "crashed" ? "var(--red)" : shown >= 50 ? "var(--cyan)" : shown >= 10 ? "var(--purple)" : shown >= 2 ? "var(--gold)" : "var(--text)";
    els.phase.textContent = phaseLabel(round.phase);
    els.liveStatus.textContent = liveStatusLabel(round.phase);
    els.countdown.textContent = countdownLabel(round, shown);
    renderControls(round, shown);
  }

  function random(seed) {
    let value = seed >>> 0;
    return () => {
      value += 0x6D2B79F5;
      let t = value;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function createScene() {
    const rng = random(0x4d415454);
    const stars = Array.from({ length: 150 }, () => ({ x: rng(), y: rng(), z: .15 + rng() * .85, size: .4 + rng() * 1.8, twinkle: rng() * Math.PI * 2 }));
    const asteroids = Array.from({ length: 10 }, (_, index) => ({ x: rng(), y: .08 + rng() * .7, z: .2 + rng() * .8, size: 8 + rng() * 26, angle: rng() * Math.PI * 2, spin: (rng() - .5) * .7, seed: index + 1 }));
    const coins = Array.from({ length: 9 }, () => ({ x: rng(), y: .08 + rng() * .7, z: .25 + rng() * .75, size: 8 + rng() * 13, angle: rng() * Math.PI * 2 }));
    return { stars, asteroids, coins, particles: [], shockwaves: [], time: 0 };
  }
  function rocketPosition(progress, width, height) {
    return { x: width * (.09 + progress * .78), y: height * (.79 - progress * .57 - Math.sin(progress * Math.PI) * .04) };
  }
  function spawnExplosion(x, y) {
    const rng = random((lastRoundNumber || 1) * 7919);
    for (let i = 0; i < 100; i += 1) {
      const angle = rng() * Math.PI * 2;
      const speed = 80 + rng() * 420;
      scene.particles.push({ x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, life: .6 + rng() * 1.1, maxLife: 1.7, size: 2 + rng() * 8, type: i % 5 === 0 ? "coin" : "spark", spin: rng() * 8 });
    }
    scene.shockwaves.push({ x, y, radius: 5, life: 1, maxLife: 1 });
  }
  function triggerCrashFx(round) {
    if (crashFxRound === round.number) return;
    crashFxRound = round.number;
    els.card.classList.remove("crashed"); void els.card.offsetWidth; els.card.classList.add("crashed");
    els.flash.classList.remove("active"); void els.flash.offsetWidth; els.flash.classList.add("active");
    els.crashTitle.classList.remove("active"); void els.crashTitle.offsetWidth; els.crashTitle.classList.add("active");
    const position = rocketPosition(displayedProgress, els.canvas.clientWidth, els.canvas.clientHeight);
    spawnExplosion(position.x, position.y);
    tone(78, .42, "sawtooth", .09);
    setTimeout(() => tone(42, .5, "sine", .07), 70);
  }
  function handleRoundTransition(round) {
    if (lastRoundNumber !== round.number) {
      lastRoundNumber = round.number;
      displayedMultiplier = 1;
      displayedProgress = 0;
      lastMilestone = 1;
      crashFxRound = null;
      scene.particles.length = 0;
      scene.shockwaves.length = 0;
      els.card.classList.remove("crashed", "warp", "flying");
      els.crashTitle.classList.remove("active");
    }
    if (round.phase === "crashed") triggerCrashFx(round);
  }
  function checkMilestones(multiplier) {
    const milestones = [2, 5, 10, 25, 50, 100];
    const reached = milestones.filter(value => multiplier >= value).pop();
    if (!reached || reached <= lastMilestone) return;
    lastMilestone = reached;
    const labels = { 2: "ORBIT REACHED", 5: "DEEP SPACE", 10: "HYPERDRIVE", 25: "MATT VELOCITY", 50: "WARP FLIGHT", 100: "LEGENDARY MATT" };
    els.milestone.textContent = `${labels[reached]} • ${reached}x`;
    els.milestone.classList.remove("show"); void els.milestone.offsetWidth; els.milestone.classList.add("show");
    tone(reached >= 50 ? 1100 : 660 + reached * 12, .16, "triangle", .04);
  }
  function updateScene(dt, multiplier, phase) {
    scene.time += dt;
    const speed = phase === "flying" ? clamp(.06 + Math.log(Math.max(1, multiplier)) * .09, .06, .7) : phase === "betting" ? .025 : .01;
    for (const star of scene.stars) { star.x -= speed * dt * star.z; if (star.x < -.05) { star.x = 1.05; star.y = Math.random(); } }
    for (const asteroid of scene.asteroids) { asteroid.x -= speed * dt * (.35 + asteroid.z); asteroid.angle += asteroid.spin * dt; if (asteroid.x < -.15) { asteroid.x = 1.15 + Math.random() * .3; asteroid.y = .08 + Math.random() * .68; } }
    for (const coin of scene.coins) { coin.x -= speed * dt * (.42 + coin.z); coin.angle += dt * (1.2 + coin.z); if (coin.x < -.12) { coin.x = 1.12 + Math.random() * .4; coin.y = .08 + Math.random() * .7; } }
    for (let i = scene.particles.length - 1; i >= 0; i -= 1) { const p = scene.particles[i]; p.life -= dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= .985; p.vy = p.vy * .985 + 90 * dt; p.spin += dt * 5; if (p.life <= 0) scene.particles.splice(i, 1); }
    for (let i = scene.shockwaves.length - 1; i >= 0; i -= 1) { const wave = scene.shockwaves[i]; wave.life -= dt; wave.radius += 420 * dt; if (wave.life <= 0) scene.shockwaves.splice(i, 1); }
  }
  function drawScene(multiplier, phase, progress) {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const width = els.canvas.clientWidth, height = els.canvas.clientHeight;
    const pixelWidth = Math.max(1, Math.floor(width * ratio)), pixelHeight = Math.max(1, Math.floor(height * ratio));
    if (els.canvas.width !== pixelWidth || els.canvas.height !== pixelHeight) { els.canvas.width = pixelWidth; els.canvas.height = pixelHeight; }
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0); ctx.clearRect(0, 0, width, height);
    const bg = ctx.createRadialGradient(width * .62, height * .36, 0, width * .52, height * .48, width * .8);
    bg.addColorStop(0, phase === "flying" ? "rgba(39,31,82,.42)" : "rgba(25,34,62,.32)"); bg.addColorStop(.45, "rgba(5,12,27,.35)"); bg.addColorStop(1, "rgba(0,2,8,.75)"); ctx.fillStyle = bg; ctx.fillRect(0, 0, width, height);
    const warp = phase === "flying" && multiplier >= 10;
    for (const star of scene.stars) {
      const x = star.x * width, y = star.y * height; const alpha = .35 + .45 * (.5 + Math.sin(scene.time * 2 + star.twinkle) * .5);
      ctx.strokeStyle = `rgba(218,235,255,${alpha})`; ctx.fillStyle = `rgba(235,245,255,${alpha})`;
      if (warp) { const length = 8 + Math.log(multiplier) * 9 * star.z; ctx.lineWidth = Math.max(.5, star.size * star.z); ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + length, y); ctx.stroke(); }
      else { ctx.beginPath(); ctx.arc(x, y, star.size * star.z, 0, Math.PI * 2); ctx.fill(); }
    }
    drawHorizonGrid(width, height, multiplier, phase);
    for (const asteroid of scene.asteroids) drawAsteroid(asteroid, width, height, warp);
    for (const coin of scene.coins) drawCoin(coin, width, height);
    drawFlightTrail(width, height, multiplier, phase, progress);
    drawParticles();
  }
  function drawHorizonGrid(width, height, multiplier, phase) {
    const horizon = height * .68;
    ctx.save(); ctx.strokeStyle = phase === "flying" ? "rgba(73,220,255,.13)" : "rgba(73,220,255,.075)"; ctx.lineWidth = 1;
    for (let i = 0; i <= 12; i += 1) { const t = i / 12; const y = horizon + Math.pow(t, 2.2) * (height - horizon); ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke(); }
    const offset = (scene.time * (phase === "flying" ? 80 + Math.log(multiplier) * 35 : 18)) % 80;
    for (let x = -width; x < width * 2; x += 80) { ctx.beginPath(); ctx.moveTo(width / 2, horizon); ctx.lineTo(x - offset, height); ctx.stroke(); }
    ctx.restore();
  }
  function drawAsteroid(a, width, height, warp) {
    const x = a.x * width, y = a.y * height, size = a.size * (.55 + a.z);
    ctx.save(); ctx.translate(x, y); ctx.rotate(a.angle); ctx.fillStyle = `rgba(98,105,121,${.28 + a.z * .35})`; ctx.strokeStyle = `rgba(190,196,208,${.15 + a.z * .25})`; ctx.lineWidth = 1; ctx.beginPath();
    for (let i = 0; i < 8; i += 1) { const angle = i / 8 * Math.PI * 2; const radius = size * (.72 + ((i * a.seed) % 5) / 14); const px = Math.cos(angle) * radius, py = Math.sin(angle) * radius; i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); }
    ctx.closePath(); ctx.fill(); ctx.stroke(); if (warp) { ctx.strokeStyle = "rgba(160,180,210,.18)"; ctx.beginPath(); ctx.moveTo(size, 0); ctx.lineTo(size + 30 * a.z, 0); ctx.stroke(); } ctx.restore();
  }
  function drawCoin(c, width, height) {
    const x = c.x * width, y = c.y * height, size = c.size * (.55 + c.z);
    ctx.save(); ctx.translate(x, y); ctx.rotate(c.angle); ctx.scale(.35 + Math.abs(Math.cos(c.angle)) * .65, 1);
    const gradient = ctx.createRadialGradient(-size * .25, -size * .25, 1, 0, 0, size); gradient.addColorStop(0, "#fff0ad"); gradient.addColorStop(.45, "#ffc83d"); gradient.addColorStop(1, "#7b4305");
    ctx.fillStyle = gradient; ctx.strokeStyle = "rgba(255,240,175,.75)"; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(0, 0, size, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = "rgba(20,12,2,.75)"; ctx.font = `900 ${Math.max(8, size)}px system-ui`; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText("M", 0, 1); ctx.restore();
  }
  function drawFlightTrail(width, height, multiplier, phase, progress) {
    const end = rocketPosition(progress, width, height); const startX = width * .055, startY = height * .81; const controlX = width * .43, controlY = height * (.83 - progress * .28);
    ctx.save(); ctx.lineCap = "round"; ctx.shadowBlur = phase === "crashed" ? 30 : 20; ctx.shadowColor = phase === "crashed" ? "#ff4f64" : multiplier >= 10 ? "#bd73ff" : "#ffc83d";
    const gradient = ctx.createLinearGradient(startX, startY, end.x, end.y); gradient.addColorStop(0, "rgba(73,220,255,.06)"); gradient.addColorStop(.55, multiplier >= 10 ? "rgba(189,115,255,.55)" : "rgba(255,200,61,.48)"); gradient.addColorStop(1, phase === "crashed" ? "#ff4f64" : multiplier >= 10 ? "#bd73ff" : "#ffc83d");
    ctx.strokeStyle = gradient; ctx.lineWidth = 7; ctx.beginPath(); ctx.moveTo(startX, startY); ctx.quadraticCurveTo(controlX, controlY, end.x, end.y); ctx.stroke();
    ctx.shadowBlur = 0; ctx.strokeStyle = "rgba(255,255,255,.65)"; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(startX, startY); ctx.quadraticCurveTo(controlX, controlY, end.x, end.y); ctx.stroke(); ctx.restore();
  }
  function drawParticles() {
    for (const wave of scene.shockwaves) { ctx.save(); ctx.globalAlpha = clamp(wave.life / wave.maxLife, 0, 1); ctx.strokeStyle = "#ffc83d"; ctx.lineWidth = 5 * wave.life; ctx.beginPath(); ctx.arc(wave.x, wave.y, wave.radius, 0, Math.PI * 2); ctx.stroke(); ctx.restore(); }
    for (const p of scene.particles) {
      const alpha = clamp(p.life / p.maxLife, 0, 1); ctx.save(); ctx.globalAlpha = alpha; ctx.translate(p.x, p.y); ctx.rotate(p.spin);
      if (p.type === "coin") { ctx.fillStyle = "#ffc83d"; ctx.strokeStyle = "#fff1ad"; ctx.lineWidth = 1; ctx.beginPath(); ctx.ellipse(0, 0, p.size, p.size * .45, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); }
      else { ctx.fillStyle = Math.random() > .5 ? "#ff4f64" : "#ffc83d"; ctx.shadowBlur = 10; ctx.shadowColor = ctx.fillStyle; ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size); }
      ctx.restore();
    }
  }
  function updateRocket(progress, multiplier, phase) {
    const width = els.canvas.clientWidth, height = els.canvas.clientHeight; const pos = rocketPosition(progress, width, height);
    const angle = -12 + progress * 3 + Math.sin(scene.time * 8) * (phase === "flying" ? .8 : .15); const scale = phase === "flying" ? 1 + clamp(Math.log(Math.max(1, multiplier)) * .035, 0, .22) : 1;
    els.rocket.style.left = `${pos.x}px`; els.rocket.style.bottom = `${height - pos.y}px`; els.rocket.style.transform = `translate(-50%,50%) rotate(${angle}deg) scale(${scale})`;
    els.card.classList.toggle("flying", phase === "flying"); els.card.classList.toggle("warp", phase === "flying" && multiplier >= 10);
  }
  function renderFrame(timestamp) {
    const dt = clamp((timestamp - lastFrameAt) / 1000, 0, .05); lastFrameAt = timestamp;
    const round = currentRoundView();
    if (round) {
      handleRoundTransition(round);
      const target = round.multiplier; const smoothing = 1 - Math.exp(-dt * (round.phase === "crashed" ? 22 : 12));
      displayedMultiplier = lerp(displayedMultiplier, target, smoothing); if (Math.abs(target - displayedMultiplier) < .0002) displayedMultiplier = target;
      const shown = round.phase === "crashed" ? round.multiplier : displayedMultiplier;
      const targetProgress = clamp(Math.log(Math.max(1, shown)) / Math.log(60), 0, 1); displayedProgress = lerp(displayedProgress, targetProgress, 1 - Math.exp(-dt * 8));
      updateScene(dt, shown, round.phase); drawScene(shown, round.phase, displayedProgress); updateRocket(displayedProgress, shown, round.phase);
      if (round.phase === "flying") checkMilestones(shown);
      if (timestamp - lastUiAt > 80) { updateUi(round, shown); lastUiAt = timestamp; }
    } else {
      updateScene(dt, 1, "preparing"); drawScene(1, "preparing", 0); updateRocket(0, 1, "preparing");
      if (timestamp - lastUiAt > 200) { updateUi(null, 1); lastUiAt = timestamp; }
    }
    requestAnimationFrame(renderFrame);
  }
  function tone(frequency, duration, type = "sine", volume = .05) {
    if (!stats.sound) return;
    try { audioContext ||= new AudioContext(); const oscillator = audioContext.createOscillator(); const gain = audioContext.createGain(); oscillator.type = type; oscillator.frequency.value = frequency; gain.gain.setValueAtTime(volume, audioContext.currentTime); gain.gain.exponentialRampToValueAtTime(.001, audioContext.currentTime + duration); oscillator.connect(gain).connect(audioContext.destination); oscillator.start(); oscillator.stop(audioContext.currentTime + duration); } catch {}
  }

  function capture(button, handler) {
    button.addEventListener("click", event => { event.preventDefault(); Promise.resolve(handler()).catch(error => say(error.shortMessage || error.message || "Transaction failed.", "loss")); });
  }
  els.connect.textContent = "CONNECT RONIN";
  els.resetBalance.style.display = "none";
  els.betAmount.min = "1000"; els.betAmount.max = "25000"; els.betAmount.value = "1000";
  els.autoMultiplier.min = "1.01"; els.autoMultiplier.max = "10";
  els.connect.addEventListener("click", connectRonin);
  capture(els.action, () => !wallet ? connectRonin() : currentRoundView()?.phase === "flying" ? cashOut(false) : placeBet());
  capture(els.withdraw, withdraw);
  capture(els.verify, verifyRound);
  els.betAmount.addEventListener("input", updatePotential);
  els.autoMultiplier.addEventListener("input", updatePotential);
  els.clearStats.addEventListener("click", () => { stats = defaultStats(); saveStats(); renderStats(); say("Your local mainnet flight stats were cleared."); });
  els.sound.addEventListener("click", () => { stats.sound = !stats.sound; saveStats(); renderStats(); if (stats.sound) tone(660, .08); });
  document.querySelectorAll("[data-bet-action]").forEach(button => button.addEventListener("click", () => {
    const min = tokenNumber(liveState?.limits?.minWager || window.ethers.parseEther("1000"));
    const max = tokenNumber(liveState?.limits?.maxWager || window.ethers.parseEther("25000"));
    const current = Math.max(min, Number(els.betAmount.value || min));
    if (button.dataset.betAction === "half") els.betAmount.value = String(Math.max(min, Math.floor(current / 2)));
    if (button.dataset.betAction === "double") els.betAmount.value = String(Math.min(max, current * 2));
    if (button.dataset.betAction === "max") els.betAmount.value = String(max);
    updatePotential();
  }));
  document.querySelectorAll("[data-copy]").forEach(button => button.addEventListener("click", async () => {
    const target = $(button.dataset.copy); if (!target || !navigator.clipboard) return;
    try { await navigator.clipboard.writeText(target.textContent); const prior = button.textContent; button.textContent = "COPIED"; setTimeout(() => button.textContent = prior, 900); } catch {}
  }));
  const injected = roninProvider();
  injected?.on?.("accountsChanged", accounts => {
    if (accounts?.[0]) activate(accounts[0]).catch(error => say(error.message, "loss"));
    else disconnectLocal();
  });
  injected?.on?.("chainChanged", () => restoreRonin().catch(error => say(error.message, "loss")));

  renderStats(); updatePotential();
  stateLoop(); accountLoop();
  setTimeout(() => restoreRonin().catch(error => console.warn("No approved Ronin account", error)), 250);
  requestAnimationFrame(renderFrame);
})();
