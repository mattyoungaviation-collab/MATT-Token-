(() => {
  "use strict";

  const STORAGE_KEY = "matt-crash-v1";
  const STARTING_BALANCE = 10_000_000;
  const BETTING_SECONDS = 6;
  const POST_CRASH_SECONDS = 3;
  const HOUSE_EDGE = 0.01;
  const BOT_NAMES = ["DynoKing", "LuckyMatt", "BurnBoss", "0x69…df4d", "GoldMatt", "RoninRider", "MoonDyno", "MattLegend", "FlipMaster", "CraftLord"];

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
  let round = null;
  let animationFrame = null;
  let audioContext = null;

  function defaultState() {
    return { balance: STARTING_BALANCE, roundNumber: 1, history: [], lastBet: 100_000, sound: true, stats: { rounds: 0, wins: 0, best: 0, biggestPayout: 0, streak: 0, net: 0 } };
  }

  function loadState() {
    try { return { ...defaultState(), ...JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") }; }
    catch { return defaultState(); }
  }
  function saveState() { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
  function formatMatt(value) { return `${Math.floor(value).toLocaleString()} MATT`; }
  function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }
  function randomBytesHex(length = 32) { const bytes = new Uint8Array(length); crypto.getRandomValues(bytes); return [...bytes].map(b => b.toString(16).padStart(2, "0")).join(""); }
  async function sha256(text) { const bytes = new TextEncoder().encode(text); const digest = await crypto.subtle.digest("SHA-256", bytes); return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join(""); }
  async function crashFromSeed(seed, roundNumber) {
    const hash = await sha256(`${seed}:${roundNumber}:MATT-CRASH-V1`);
    const h = parseInt(hash.slice(0, 13), 16);
    const e = 2 ** 52;
    const raw = Math.floor(((1 - HOUSE_EDGE) * e / (e - h)) * 100) / 100;
    return clamp(Number.isFinite(raw) ? raw : 1, 1, 1000);
  }

  function renderPersistent() {
    els.balance.textContent = formatMatt(state.balance);
    els.roundNumber.textContent = `#${String(state.roundNumber).padStart(6, "0")}`;
    els.sound.textContent = state.sound ? "SOUND ON" : "SOUND OFF";
    els.sound.setAttribute("aria-pressed", String(state.sound));
    els.statRounds.textContent = state.stats.rounds.toLocaleString();
    els.statWins.textContent = state.stats.wins.toLocaleString();
    els.statBest.textContent = state.stats.best ? `${state.stats.best.toFixed(2)}x` : "—";
    els.statPayout.textContent = formatMatt(state.stats.biggestPayout);
    els.statStreak.textContent = state.stats.streak.toLocaleString();
    els.statProfit.textContent = `${state.stats.net >= 0 ? "+" : "−"}${formatMatt(Math.abs(state.stats.net))}`;
    els.statProfit.style.color = state.stats.net >= 0 ? "var(--green)" : "var(--red)";
    renderHistory();
    updatePotential();
  }

  function renderHistory() {
    els.history.innerHTML = state.history.length ? state.history.map(value => `<span class="history-pill ${value >= 100 ? "legendary" : value >= 10 ? "high" : value >= 2 ? "mid" : ""}">${value.toFixed(2)}x</span>`).join("") : `<span class="history-pill">No completed rounds yet</span>`;
  }

  function updatePotential() {
    const bet = validBet(false);
    const auto = clamp(Number(els.autoMultiplier.value) || 2, 1.01, 1000);
    els.potential.textContent = formatMatt(bet * auto);
  }

  function validBet(showMessage = true) {
    const amount = Math.floor(Number(els.betAmount.value));
    if (!Number.isFinite(amount) || amount < 1000) { if (showMessage) setMessage("Minimum demo bet is 1,000 MATT.", "loss"); return 0; }
    if (amount > state.balance) { if (showMessage) setMessage("That bet is larger than your demo balance.", "loss"); return 0; }
    return amount;
  }

  function setMessage(text, type = "") { els.message.textContent = text; els.message.className = `game-message ${type}`; }

  function createBots() {
    const count = 5 + Math.floor(Math.random() * 5);
    return [...BOT_NAMES].sort(() => Math.random() - .5).slice(0, count).map((name, i) => {
      const bet = Math.round((20_000 + Math.random() * 1_480_000) / 1000) * 1000;
      return { id: `bot-${i}`, name, bet, target: 1.08 + Math.pow(Math.random(), 2.2) * 10, status: "queued", payout: 0 };
    });
  }

  async function prepareRound() {
    cancelAnimationFrame(animationFrame);
    const seed = randomBytesHex();
    const commitment = await sha256(seed);
    const crashPoint = await crashFromSeed(seed, state.roundNumber);
    round = { number: state.roundNumber, seed, commitment, crashPoint, phase: "betting", startedAt: 0, bet: null, bots: createBots(), current: 1, points: [], lastFrame: 0 };
    els.fairRound.textContent = `#${String(round.number).padStart(6, "0")}`;
    els.fairCommitment.textContent = commitment;
    els.fairSeed.textContent = "Revealed after crash";
    els.fairResult.textContent = "Waiting for round";
    els.verify.disabled = true;
    els.verifyMessage.textContent = "The commitment is locked before betting closes.";
    els.action.disabled = false;
    els.action.textContent = "PLACE BET";
    els.action.classList.remove("cashout");
    els.repeat.disabled = !state.lastBet || state.lastBet > state.balance;
    els.phase.textContent = "NEXT FLIGHT";
    els.multiplier.textContent = "1.00x";
    els.multiplier.style.color = "var(--text)";
    els.rocket.style.left = "7%";
    els.rocket.style.bottom = "18%";
    els.liveStatus.textContent = "BETTING OPEN";
    renderPlayers();
    updateRoundSummary();
    drawChart(true);
    await countdown(BETTING_SECONDS);
    if (round.phase === "betting") launchRound();
  }

  function countdown(seconds) {
    return new Promise(resolve => {
      let remaining = seconds;
      els.countdown.textContent = `Flight begins in ${remaining}s`;
      const timer = setInterval(() => {
        if (!round || round.phase !== "betting") { clearInterval(timer); resolve(); return; }
        remaining -= 1;
        els.countdown.textContent = remaining > 0 ? `Flight begins in ${remaining}s` : "Locking bets…";
        if (remaining <= 0) { clearInterval(timer); resolve(); }
      }, 1000);
    });
  }

  function placeBet(amount = null) {
    if (!round || round.phase !== "betting" || round.bet) return;
    if (amount != null) els.betAmount.value = amount;
    const bet = validBet();
    if (!bet) return;
    state.balance -= bet;
    state.lastBet = bet;
    round.bet = { name: "YOU", bet, status: "queued", payout: 0, cashout: null };
    state.stats.rounds += 1;
    state.stats.net -= bet;
    saveState(); renderPersistent(); renderPlayers(); updateRoundSummary();
    els.action.textContent = "BET PLACED"; els.action.disabled = true; els.repeat.disabled = true;
    setMessage(`Your ${formatMatt(bet)} demo bet is locked for round #${round.number}.`);
    tone(440, .05);
  }

  function launchRound() {
    round.phase = "flying";
    round.startedAt = performance.now();
    round.bots.forEach(bot => bot.status = "playing");
    if (round.bet) round.bet.status = "playing";
    els.phase.textContent = "FLYING";
    els.countdown.textContent = "Cash out before the crash";
    els.liveStatus.textContent = "IN FLIGHT";
    if (round.bet) { els.action.disabled = false; els.action.textContent = "CASH OUT • 1.00x"; els.action.classList.add("cashout"); }
    else { els.action.disabled = true; els.action.textContent = "ROUND IN PROGRESS"; }
    round.lastFrame = performance.now();
    animationFrame = requestAnimationFrame(tick);
  }

  function tick(now) {
    if (!round || round.phase !== "flying") return;
    const elapsed = (now - round.startedAt) / 1000;
    round.current = Math.max(1, Math.exp(0.095 * elapsed + 0.0062 * elapsed * elapsed));
    round.points.push(round.current);
    els.multiplier.textContent = `${round.current.toFixed(2)}x`;
    els.multiplier.style.color = round.current >= 10 ? "var(--purple)" : round.current >= 2 ? "var(--gold)" : "var(--text)";
    if (round.bet?.status === "playing") els.action.textContent = `CASH OUT • ${round.current.toFixed(2)}x`;
    if (els.autoEnabled.checked && round.bet?.status === "playing" && round.current >= clamp(Number(els.autoMultiplier.value) || 2, 1.01, 1000)) cashOut(true);
    round.bots.forEach(bot => { if (bot.status === "playing" && round.current >= bot.target) settleBot(bot, round.current); });
    moveRocket(elapsed);
    drawChart(false);
    if (round.current >= round.crashPoint) { crashRound(); return; }
    animationFrame = requestAnimationFrame(tick);
  }

  function moveRocket(elapsed) {
    const x = clamp(7 + elapsed * 5.2, 7, 87);
    const y = clamp(18 + Math.pow(elapsed, 1.22) * 2.7, 18, 74);
    els.rocket.style.left = `${x}%`; els.rocket.style.bottom = `${y}%`;
  }

  function cashOut(auto = false) {
    if (!round?.bet || round.phase !== "flying" || round.bet.status !== "playing") return;
    const multiplier = Math.max(1, Math.floor(round.current * 100) / 100);
    const payout = Math.floor(round.bet.bet * multiplier);
    round.bet.status = "won"; round.bet.cashout = multiplier; round.bet.payout = payout;
    state.balance += payout; state.stats.wins += 1; state.stats.net += payout; state.stats.streak += 1;
    state.stats.best = Math.max(state.stats.best, multiplier); state.stats.biggestPayout = Math.max(state.stats.biggestPayout, payout);
    saveState(); renderPersistent(); renderPlayers();
    els.action.disabled = true; els.action.classList.remove("cashout"); els.action.textContent = `CASHED OUT AT ${multiplier.toFixed(2)}x`;
    setMessage(`${auto ? "Auto cash-out!" : "Safe!"} You won ${formatMatt(payout)} at ${multiplier.toFixed(2)}x.`, "win");
    tone(880, .12);
  }

  function settleBot(bot, multiplier) { bot.status = "won"; bot.cashout = Math.floor(multiplier * 100) / 100; bot.payout = Math.floor(bot.bet * bot.cashout); renderPlayers(); }

  function crashRound() {
    round.phase = "crashed";
    round.current = round.crashPoint;
    round.bots.forEach(bot => { if (bot.status === "playing") bot.status = "lost"; });
    if (round.bet?.status === "playing") {
      round.bet.status = "lost"; state.stats.streak = 0; saveState(); renderPersistent();
      setMessage(`CRASHED at ${round.crashPoint.toFixed(2)}x. Your demo bet was lost.`, "loss");
    } else if (!round.bet) setMessage(`Round crashed at ${round.crashPoint.toFixed(2)}x. Place a bet on the next flight.`);
    els.phase.textContent = "CRASHED"; els.multiplier.textContent = `${round.crashPoint.toFixed(2)}x`; els.multiplier.style.color = "var(--red)";
    els.countdown.textContent = "Next flight preparing"; els.liveStatus.textContent = "CRASHED";
    els.action.disabled = true; els.action.classList.remove("cashout"); els.action.textContent = `CRASHED • ${round.crashPoint.toFixed(2)}x`;
    els.flash.classList.remove("active"); void els.flash.offsetWidth; els.flash.classList.add("active");
    els.rocket.style.filter = "brightness(3) blur(2px)"; setTimeout(() => els.rocket.style.filter = "", 700);
    tone(110, .3); renderPlayers(); drawChart(false);
    state.history.unshift(round.crashPoint); state.history = state.history.slice(0, 18); state.roundNumber += 1; saveState(); renderPersistent();
    els.fairSeed.textContent = round.seed; els.fairResult.textContent = `${round.crashPoint.toFixed(2)}x`; els.verify.disabled = false;
    els.verifyMessage.textContent = "Seed revealed. Verify the commitment and crash result now.";
    setTimeout(prepareRound, POST_CRASH_SECONDS * 1000);
  }

  function renderPlayers() {
    if (!round) return;
    const rows = [...(round.bet ? [round.bet] : []), ...round.bots].sort((a,b) => b.bet - a.bet);
    els.playersBody.innerHTML = rows.map(player => `<tr><td>${player.name}</td><td>${formatMatt(player.bet).replace(" MATT", "")}</td><td class="player-status ${player.status}">${player.status === "won" ? `${player.cashout.toFixed(2)}x` : player.status === "lost" ? "CRASHED" : player.status === "playing" ? "PLAYING" : "READY"}</td><td>${player.payout ? formatMatt(player.payout).replace(" MATT", "") : "—"}</td></tr>`).join("");
  }

  function updateRoundSummary() {
    if (!round) return;
    const all = [...round.bots, ...(round.bet ? [round.bet] : [])];
    els.playerCount.textContent = all.length.toLocaleString();
    els.roundTotal.textContent = formatMatt(all.reduce((sum,p) => sum + p.bet, 0));
    els.largestBet.textContent = formatMatt(Math.max(...all.map(p => p.bet), 0));
  }

  function drawChart(clearOnly) {
    const rect = els.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    if (els.canvas.width !== Math.floor(rect.width*dpr) || els.canvas.height !== Math.floor(rect.height*dpr)) { els.canvas.width = Math.floor(rect.width*dpr); els.canvas.height = Math.floor(rect.height*dpr); }
    ctx.setTransform(dpr,0,0,dpr,0,0); ctx.clearRect(0,0,rect.width,rect.height);
    if (clearOnly || !round?.points.length) return;
    const points = round.points; const max = Math.max(2, ...points); const left=42,right=rect.width-30,top=50,bottom=rect.height-86;
    ctx.beginPath(); points.forEach((v,i) => { const x=left+(i/Math.max(1,points.length-1))*(right-left); const y=bottom-((v-1)/(max-1))*(bottom-top); i?ctx.lineTo(x,y):ctx.moveTo(x,y); });
    const gradient=ctx.createLinearGradient(left,0,right,0); gradient.addColorStop(0,"#49dcff"); gradient.addColorStop(.65,"#ffc83d"); gradient.addColorStop(1,"#ff4f64");
    ctx.strokeStyle=gradient; ctx.lineWidth=5; ctx.lineCap="round"; ctx.lineJoin="round"; ctx.shadowColor="#49dcff"; ctx.shadowBlur=18; ctx.stroke(); ctx.shadowBlur=0;
  }

  async function verifyLastRound() {
    if (!round?.seed || round.phase !== "crashed") { els.verifyMessage.textContent = "The next round has already started. Verify after its crash."; return; }
    const commitment = await sha256(round.seed); const result = await crashFromSeed(round.seed, round.number);
    const valid = commitment === round.commitment && result === round.crashPoint;
    els.verifyMessage.textContent = valid ? `VERIFIED: commitment matches and recalculates to ${result.toFixed(2)}x.` : "Verification failed. The displayed round data does not match.";
    els.verifyMessage.style.color = valid ? "var(--green)" : "var(--red)";
  }

  function tone(frequency, duration) {
    if (!state.sound) return;
    try { audioContext ||= new (window.AudioContext || window.webkitAudioContext)(); const oscillator=audioContext.createOscillator(); const gain=audioContext.createGain(); oscillator.frequency.value=frequency; gain.gain.setValueAtTime(.05,audioContext.currentTime); gain.gain.exponentialRampToValueAtTime(.0001,audioContext.currentTime+duration); oscillator.connect(gain).connect(audioContext.destination); oscillator.start(); oscillator.stop(audioContext.currentTime+duration); } catch {}
  }

  els.action.addEventListener("click", () => { if (round?.phase === "betting") placeBet(); else if (round?.phase === "flying") cashOut(false); });
  els.repeat.addEventListener("click", () => placeBet(state.lastBet));
  els.betAmount.addEventListener("input", updatePotential); els.autoMultiplier.addEventListener("input", updatePotential);
  document.querySelectorAll("[data-bet-action]").forEach(button => button.addEventListener("click", () => { const current=Math.max(1000,Math.floor(Number(els.betAmount.value)||1000)); const action=button.dataset.betAction; els.betAmount.value=action==="half"?Math.max(1000,Math.floor(current/2/1000)*1000):action==="double"?Math.min(state.balance,current*2):state.balance; updatePotential(); }));
  $("reset-balance").addEventListener("click", () => { if (round?.bet?.status === "playing") return; state.balance=STARTING_BALANCE; saveState(); renderPersistent(); setMessage("Demo balance reset to 10,000,000 MATT."); });
  $("clear-stats").addEventListener("click", () => { state.stats=defaultState().stats; saveState(); renderPersistent(); });
  els.sound.addEventListener("click", () => { state.sound=!state.sound; saveState(); renderPersistent(); tone(600,.05); });
  els.verify.addEventListener("click", verifyLastRound);
  document.querySelectorAll("[data-copy]").forEach(button => button.addEventListener("click", async () => { const text=$(button.dataset.copy).textContent; await navigator.clipboard.writeText(text); button.textContent="COPIED"; setTimeout(()=>button.textContent="COPY",900); }));
  window.addEventListener("resize", () => drawChart(!round?.points.length));

  renderPersistent(); prepareRound();
})();
