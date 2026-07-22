(() => {
  "use strict";

  const STORAGE_KEY = "matt-crash-v2";
  const STARTING_BALANCE = 10_000_000;
  const HOUSE_EDGE = 0.01;
  const BETTING_MS = 15_000;
  const $ = id => document.getElementById(id);
  const els = {
    canvas: $("crash-canvas"), multiplier: $("multiplier"), phase: $("phase-label"), countdown: $("countdown"), rocket: $("rocket"), flash: $("crash-flash"),
    roundNumber: $("round-number"), history: $("history-strip"), playerCount: $("player-count"), roundTotal: $("round-total"), largestBet: $("largest-bet"),
    balance: $("demo-balance"), betAmount: $("bet-amount"), autoEnabled: $("auto-enabled"), autoMultiplier: $("auto-multiplier"), potential: $("potential-payout"),
    action: $("primary-action"), repeat: $("repeat-bet"), message: $("game-message"), playersBody: $("players-body"), liveStatus: $("live-status"),
    fairRound: $("fair-round"), fairCommitment: $("fair-commitment"), fairSeed: $("fair-seed"), fairResult: $("fair-result"), verify: $("verify-round"), verifyMessage: $("verify-message"),
    sound: $("sound-toggle"), statRounds: $("stat-rounds"), statWins: $("stat-wins"), statBest: $("stat-best"), statPayout: $("stat-payout"), statStreak: $("stat-streak"), statProfit: $("stat-profit")
  };

  const ctx = els.canvas.getContext("2d");
  let state = loadState();
  let server = null;
  let localBet = null;
  let lastRound = null;
  let clockOffset = 0;
  let displayedMultiplier = 1;
  let audioContext = null;

  function defaults() { return { balance: STARTING_BALANCE, lastBet: 100_000, sound: true, stats: { rounds: 0, wins: 0, best: 0, biggestPayout: 0, streak: 0, net: 0 } }; }
  function loadState() { try { const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}"); return { ...defaults(), ...saved, stats: { ...defaults().stats, ...(saved.stats || {}) } }; } catch { return defaults(); } }
  function saveState() { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
  function formatMatt(value) { return `${Math.floor(value || 0).toLocaleString()} MATT`; }
  function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }
  function elapsedToMultiplier(milliseconds) { const seconds = Math.max(0, milliseconds / 1000); return Math.exp(0.055 * seconds + 0.0028 * seconds * seconds); }
  async function sha256(text) { const bytes = new TextEncoder().encode(text); const digest = await crypto.subtle.digest("SHA-256", bytes); return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join(""); }
  async function crashFromSeed(seed, number) { const hash = await sha256(`${seed}:${number}:MATT-CRASH-V2`); const h = parseInt(hash.slice(0, 13), 16); const e = 2 ** 52; return clamp(Math.floor((((1 - HOUSE_EDGE) * e) / (e - h)) * 100) / 100, 1, 1000); }
  function message(text, type = "") { els.message.textContent = text; els.message.className = `game-message ${type}`; }

  function validBet(show = true) {
    const amount = Math.floor(Number(els.betAmount.value));
    if (!Number.isFinite(amount) || amount < 1000) { if (show) message("Minimum demo bet is 1,000 MATT.", "loss"); return 0; }
    if (amount > state.balance) { if (show) message("That bet is larger than your demo balance.", "loss"); return 0; }
    return amount;
  }

  function renderStats() {
    els.balance.textContent = formatMatt(state.balance);
    els.sound.textContent = state.sound ? "SOUND ON" : "SOUND OFF";
    els.sound.setAttribute("aria-pressed", String(state.sound));
    els.statRounds.textContent = state.stats.rounds.toLocaleString();
    els.statWins.textContent = state.stats.wins.toLocaleString();
    els.statBest.textContent = state.stats.best ? `${state.stats.best.toFixed(2)}x` : "—";
    els.statPayout.textContent = formatMatt(state.stats.biggestPayout);
    els.statStreak.textContent = state.stats.streak.toLocaleString();
    els.statProfit.textContent = `${state.stats.net >= 0 ? "+" : "−"}${formatMatt(Math.abs(state.stats.net))}`;
    els.statProfit.style.color = state.stats.net >= 0 ? "var(--green)" : "var(--red)";
    updatePotential();
  }

  function renderHistory() {
    const history = server?.history || [];
    els.history.innerHTML = history.length ? history.map(item => { const v = item.crashPoint; const cls = v >= 100 ? "legendary" : v >= 10 ? "high" : v >= 2 ? "mid" : ""; return `<span class="history-pill ${cls}" title="Round #${item.roundNumber}">${v.toFixed(2)}x</span>`; }).join("") : `<span class="history-pill">Loading shared history…</span>`;
  }

  function currentRoundView() {
    if (!server) return null;
    const r = server.round;
    const now = Date.now() + clockOffset;
    let phase = r.phase;
    let multiplier = r.multiplier;
    if (phase === "flying") {
      const flightStartedAt = r.startAt + BETTING_MS;
      multiplier = elapsedToMultiplier(now - flightStartedAt);
      if (r.crashPoint != null) multiplier = Math.min(multiplier, r.crashPoint);
      multiplier = Math.max(1, multiplier);
    } else if (phase === "betting") multiplier = 1;
    else if (phase === "crashed") multiplier = r.crashPoint || r.multiplier;
    return { ...r, phase, multiplier, now, left: Math.max(0, r.phaseEndsAt - now) };
  }

  function renderPlayers(round) {
    if (!server || !round) return;
    const bots = server.bots.map(bot => {
      let status = "queued", cashout = null, payout = 0;
      if (round.phase === "flying") { if (round.multiplier >= bot.target) { status = "won"; cashout = bot.target; payout = Math.floor(bot.bet * bot.target); } else status = "playing"; }
      else if (round.phase === "crashed") { if (bot.target < round.crashPoint) { status = "won"; cashout = bot.target; payout = Math.floor(bot.bet * bot.target); } else status = "lost"; }
      return { ...bot, status, cashout, payout };
    });
    const rows = localBet ? [{ name: "YOU", bet: localBet.amount, status: localBet.status, cashout: localBet.cashout, payout: localBet.payout }, ...bots] : bots;
    els.playersBody.innerHTML = rows.map(p => `<tr class="${p.name === "YOU" ? "you" : ""}"><td>${p.name}</td><td>${formatMatt(p.bet)}</td><td>${p.status === "won" ? `${p.cashout.toFixed(2)}x` : p.status === "playing" ? "PLAYING" : p.status === "lost" ? "CRASHED" : "QUEUED"}</td><td>${p.payout ? formatMatt(p.payout) : "—"}</td></tr>`).join("");
    const bets = rows.map(p => p.bet);
    els.playerCount.textContent = rows.length.toLocaleString();
    els.roundTotal.textContent = formatMatt(bets.reduce((sum, v) => sum + v, 0));
    els.largestBet.textContent = formatMatt(Math.max(0, ...bets));
  }

  function updatePotential() { const bet = validBet(false); const auto = clamp(Number(els.autoMultiplier.value) || 2, 1.01, 1000); els.potential.textContent = formatMatt(bet * auto); }
  function placeBet(amount = null) { if (!server || server.round.phase !== "betting" || localBet) return; if (amount != null) els.betAmount.value = amount; const bet = validBet(); if (!bet) return; state.balance -= bet; state.lastBet = bet; state.stats.rounds += 1; state.stats.net -= bet; localBet = { round: server.round.number, amount: bet, status: "queued", cashout: null, payout: 0 }; saveState(); renderStats(); tone(440, .05); message(`Your ${formatMatt(bet)} demo bet is locked for shared round #${server.round.number}.`); }
  function cashOut(auto = false) { const round = currentRoundView(); if (!round || !localBet || localBet.round !== round.number || localBet.status !== "playing") return; const multiplier = Math.max(1, Math.floor(round.multiplier * 100) / 100); const payout = Math.floor(localBet.amount * multiplier); localBet.status = "won"; localBet.cashout = multiplier; localBet.payout = payout; state.balance += payout; state.stats.wins += 1; state.stats.net += payout; state.stats.streak += 1; state.stats.best = Math.max(state.stats.best, multiplier); state.stats.biggestPayout = Math.max(state.stats.biggestPayout, payout); saveState(); renderStats(); tone(880, .12); message(`${auto ? "Auto cash-out!" : "Safe!"} You won ${formatMatt(payout)} at ${multiplier.toFixed(2)}x.`, "win"); }

  function handleRoundTransition(round) {
    if (lastRound !== round.number) { localBet = null; lastRound = round.number; displayedMultiplier = 1; }
    if (localBet?.round === round.number) {
      if (round.phase === "flying" && localBet.status === "queued") localBet.status = "playing";
      if (round.phase === "crashed" && localBet.status === "playing") { localBet.status = "lost"; state.stats.streak = 0; saveState(); renderStats(); message(`CRASHED at ${round.crashPoint.toFixed(2)}x. Your demo bet was lost.`, "loss"); tone(110, .3); els.flash.classList.remove("active"); void els.flash.offsetWidth; els.flash.classList.add("active"); }
    }
  }

  function renderFrame() {
    const r = currentRoundView();
    if (r) {
      handleRoundTransition(r);
      displayedMultiplier += (r.multiplier - displayedMultiplier) * (r.phase === "crashed" ? .35 : .18);
      if (Math.abs(r.multiplier - displayedMultiplier) < .0005) displayedMultiplier = r.multiplier;
      const shown = r.phase === "crashed" ? r.multiplier : displayedMultiplier;
      els.roundNumber.textContent = `#${String(r.number).padStart(6, "0")}`;
      els.fairRound.textContent = `#${String(r.number).padStart(6, "0")}`;
      els.fairCommitment.textContent = r.commitment;
      els.fairSeed.textContent = r.seed || "Revealed after crash";
      els.fairResult.textContent = r.crashPoint ? `${r.crashPoint.toFixed(2)}x` : "Waiting for round";
      els.verify.disabled = !r.seed;
      els.multiplier.textContent = `${shown.toFixed(2)}x`;
      els.multiplier.style.color = r.phase === "crashed" ? "var(--red)" : shown >= 10 ? "var(--purple)" : shown >= 2 ? "var(--gold)" : "var(--text)";
      els.phase.textContent = r.phase === "betting" ? "NEXT FLIGHT" : r.phase === "flying" ? "FLYING" : "MATT DOWN";
      els.liveStatus.textContent = r.phase === "betting" ? "BETTING OPEN" : r.phase === "flying" ? "SHARED FLIGHT" : "CRASHED";
      els.countdown.textContent = r.phase === "betting" ? `Flight begins in ${(r.left / 1000).toFixed(1)}s` : r.phase === "flying" ? "Cash out before the shared crash" : `Next flight in ${(r.left / 1000).toFixed(1)}s`;
      if (r.phase === "betting") { els.action.classList.remove("cashout"); els.action.disabled = Boolean(localBet); els.action.textContent = localBet ? "BET PLACED" : "PLACE BET"; els.repeat.disabled = Boolean(localBet) || !state.lastBet || state.lastBet > state.balance; }
      else if (r.phase === "flying" && localBet?.status === "playing") { els.action.classList.add("cashout"); els.action.disabled = false; els.action.textContent = `CASH OUT • ${shown.toFixed(2)}x`; const auto = clamp(Number(els.autoMultiplier.value) || 2, 1.01, 1000); if (els.autoEnabled.checked && shown >= auto) cashOut(true); }
      else { els.action.classList.remove("cashout"); els.action.disabled = true; els.action.textContent = r.phase === "crashed" ? `CRASHED • ${r.multiplier.toFixed(2)}x` : "ROUND IN PROGRESS"; els.repeat.disabled = true; }
      renderPlayers({ ...r, multiplier: shown });
      drawChart(shown, r.phase);
    }
    requestAnimationFrame(renderFrame);
  }

  function drawChart(multiplier, phase) {
    const ratio = window.devicePixelRatio || 1, width = els.canvas.clientWidth, height = els.canvas.clientHeight;
    if (els.canvas.width !== Math.floor(width * ratio) || els.canvas.height !== Math.floor(height * ratio)) { els.canvas.width = Math.floor(width * ratio); els.canvas.height = Math.floor(height * ratio); }
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0); ctx.clearRect(0, 0, width, height);
    ctx.strokeStyle = "rgba(255,255,255,.07)"; ctx.lineWidth = 1;
    for (let i = 1; i < 5; i++) { ctx.beginPath(); ctx.moveTo(0, height * i / 5); ctx.lineTo(width, height * i / 5); ctx.stroke(); }
    const progress = clamp(Math.log(Math.max(1, multiplier)) / Math.log(20), 0, 1);
    const endX = width * (.08 + progress * .82), endY = height * (.80 - progress * .62);
    const gradient = ctx.createLinearGradient(width * .06, height * .82, endX, endY); gradient.addColorStop(0, "rgba(255,200,61,.15)"); gradient.addColorStop(1, phase === "crashed" ? "#ff4f64" : multiplier >= 2 ? "#ffc83d" : "#f7f8fb");
    ctx.strokeStyle = gradient; ctx.lineWidth = 5; ctx.lineCap = "round"; ctx.beginPath(); ctx.moveTo(width * .06, height * .82); ctx.quadraticCurveTo(width * .45, height * (.82 - progress * .3), endX, endY); ctx.stroke();
    els.rocket.style.left = `${8 + progress * 80}%`; els.rocket.style.bottom = `${18 + progress * 62}%`;
  }

  async function poll() { try { const response = await fetch("/api/crash/state", { cache: "no-store" }); if (!response.ok) throw new Error(`HTTP ${response.status}`); const payload = await response.json(); const measuredOffset = payload.serverTime - Date.now(); clockOffset += (measuredOffset - clockOffset) * .2; server = payload; renderHistory(); } catch { els.liveStatus.textContent = "RECONNECTING"; message("Shared round server unavailable. Reconnecting automatically…"); } }
  function tone(frequency, duration) { if (!state.sound) return; try { audioContext ||= new AudioContext(); const oscillator = audioContext.createOscillator(), gain = audioContext.createGain(); oscillator.frequency.value = frequency; gain.gain.setValueAtTime(.05, audioContext.currentTime); gain.gain.exponentialRampToValueAtTime(.001, audioContext.currentTime + duration); oscillator.connect(gain).connect(audioContext.destination); oscillator.start(); oscillator.stop(audioContext.currentTime + duration); } catch {} }

  els.action.addEventListener("click", () => server?.round.phase === "flying" ? cashOut(false) : placeBet());
  els.repeat.addEventListener("click", () => placeBet(state.lastBet));
  els.betAmount.addEventListener("input", updatePotential); els.autoMultiplier.addEventListener("input", updatePotential);
  document.querySelectorAll("[data-bet-action]").forEach(button => button.addEventListener("click", () => { const current = Math.max(1000, Math.floor(Number(els.betAmount.value) || 1000)); const action = button.dataset.betAction; els.betAmount.value = action === "half" ? Math.max(1000, Math.floor(current / 2)) : action === "double" ? Math.min(state.balance, current * 2) : state.balance; updatePotential(); }));
  els.sound.addEventListener("click", () => { state.sound = !state.sound; saveState(); renderStats(); if (state.sound) tone(660, .08); });
  els.verify.addEventListener("click", async () => { if (!server?.round.seed) return; const commitment = await sha256(server.round.seed), result = await crashFromSeed(server.round.seed, server.round.number); const valid = commitment === server.round.commitment && Math.abs(result - server.round.crashPoint) < .001; els.verifyMessage.textContent = valid ? `VERIFIED: commitment and ${result.toFixed(2)}x result match.` : "Verification failed. Do not trust this round."; els.verifyMessage.className = valid ? "verify-message verified" : "verify-message failed"; });
  $("reset-balance").addEventListener("click", () => { state.balance = STARTING_BALANCE; saveState(); renderStats(); });
  $("clear-stats").addEventListener("click", () => { state.stats = defaults().stats; saveState(); renderStats(); });
  document.querySelectorAll("[data-copy]").forEach(button => button.addEventListener("click", async () => { const text = $(button.dataset.copy)?.textContent || ""; try { await navigator.clipboard.writeText(text); button.textContent = "COPIED"; setTimeout(() => button.textContent = "COPY", 900); } catch {} }));

  renderStats(); poll(); renderFrame(); setInterval(poll, 500);
})();