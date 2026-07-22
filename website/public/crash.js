(() => {
  "use strict";

  const STORAGE_KEY = "matt-crash-v3";
  const STARTING_BALANCE = 10_000_000;
  const HOUSE_EDGE = 0.01;
  const BETTING_MS = 15_000;
  const POLL_MS = 500;
  const $ = id => document.getElementById(id);
  const els = {
    canvas: $("crash-canvas"), card: $("flight-card"), multiplier: $("multiplier"), phase: $("phase-label"), countdown: $("countdown"), rocket: $("rocket"), flash: $("crash-flash"), crashTitle: $("crash-title"), milestone: $("milestone-banner"),
    roundNumber: $("round-number"), history: $("history-strip"), playerCount: $("player-count"), roundTotal: $("round-total"), largestBet: $("largest-bet"),
    balance: $("demo-balance"), betAmount: $("bet-amount"), autoEnabled: $("auto-enabled"), autoMultiplier: $("auto-multiplier"), potential: $("potential-payout"),
    action: $("primary-action"), repeat: $("repeat-bet"), resetBalance: $("reset-balance"), clearStats: $("clear-stats"), message: $("game-message"), playersBody: $("players-body"), liveStatus: $("live-status"),
    fairRound: $("fair-round"), fairCommitment: $("fair-commitment"), fairSeed: $("fair-seed"), fairResult: $("fair-result"), verify: $("verify-round"), verifyMessage: $("verify-message"),
    sound: $("sound-toggle"), statRounds: $("stat-rounds"), statWins: $("stat-wins"), statBest: $("stat-best"), statPayout: $("stat-payout"), statStreak: $("stat-streak"), statProfit: $("stat-profit")
  };

  const ctx = els.canvas.getContext("2d", { alpha: true });
  let state = loadState();
  let server = null;
  let localBet = null;
  let lastRound = null;
  let clockOffset = 0;
  let displayedMultiplier = 1;
  let displayedProgress = 0;
  let audioContext = null;
  let lastFrameAt = performance.now();
  let lastUiUpdateAt = 0;
  let lastMilestone = 1;
  let crashFxRound = null;
  let scene = createScene();

  function defaults() {
    return { balance: STARTING_BALANCE, lastBet: 100_000, sound: true, stats: { rounds: 0, wins: 0, best: 0, biggestPayout: 0, streak: 0, net: 0 } };
  }
  function loadState() {
    try {
      const current = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
      const older = JSON.parse(localStorage.getItem("matt-crash-v2") || "{}");
      const saved = Object.keys(current).length ? current : older;
      return { ...defaults(), ...saved, stats: { ...defaults().stats, ...(saved.stats || {}) } };
    } catch { return defaults(); }
  }
  function saveState() { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
  function formatMatt(value) { return `${Math.floor(value || 0).toLocaleString()} MATT`; }
  function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }
  function lerp(a, b, amount) { return a + (b - a) * amount; }
  function elapsedToMultiplier(milliseconds) { const seconds = Math.max(0, milliseconds / 1000); return Math.exp(0.055 * seconds + 0.0028 * seconds * seconds); }
  async function sha256(text) { const bytes = new TextEncoder().encode(text); const digest = await crypto.subtle.digest("SHA-256", bytes); return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join(""); }
  async function crashFromSeed(seed, number) { const hash = await sha256(`${seed}:${number}:MATT-CRASH-V2`); const h = parseInt(hash.slice(0, 13), 16); const e = 2 ** 52; return clamp(Math.floor((((1 - HOUSE_EDGE) * e) / (e - h)) * 100) / 100, 1, 1000); }
  function message(text, type = "") { els.message.textContent = text; els.message.className = `game-message ${type}`; }

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
    els.history.innerHTML = history.length ? history.map(item => {
      const v = item.crashPoint;
      const cls = v >= 100 ? "legendary" : v >= 10 ? "high" : v >= 2 ? "mid" : "";
      return `<span class="history-pill ${cls}" title="Round #${item.roundNumber}">${v.toFixed(2)}x</span>`;
    }).join("") : `<span class="history-pill">Loading shared history…</span>`;
  }

  function currentRoundView() {
    if (!server) return null;
    const r = server.round;
    const now = Date.now() + clockOffset;
    let multiplier = r.multiplier;
    if (r.phase === "flying") multiplier = Math.max(1, elapsedToMultiplier(now - (r.startAt + BETTING_MS)));
    else if (r.phase === "betting") multiplier = 1;
    else if (r.phase === "crashed") multiplier = r.crashPoint || r.multiplier;
    return { ...r, multiplier, now, left: Math.max(0, r.phaseEndsAt - now) };
  }

  function renderPlayers(round) {
    if (!server || !round) return;
    const bots = server.bots.map(bot => {
      let status = "queued", cashout = null, payout = 0;
      if (round.phase === "flying") {
        if (round.multiplier >= bot.target) { status = "won"; cashout = bot.target; payout = Math.floor(bot.bet * bot.target); }
        else status = "playing";
      } else if (round.phase === "crashed") {
        if (bot.target < round.crashPoint) { status = "won"; cashout = bot.target; payout = Math.floor(bot.bet * bot.target); }
        else status = "lost";
      }
      return { ...bot, status, cashout, payout };
    });
    const rows = localBet ? [{ name: "YOU", bet: localBet.amount, status: localBet.status, cashout: localBet.cashout, payout: localBet.payout }, ...bots] : bots;
    els.playersBody.innerHTML = rows.map(p => `<tr class="${p.name === "YOU" ? "you" : ""}"><td>${p.name}</td><td>${formatMatt(p.bet)}</td><td>${p.status === "won" ? `${p.cashout.toFixed(2)}x` : p.status === "playing" ? "FLYING" : p.status === "lost" ? "IMPACT" : "QUEUED"}</td><td>${p.payout ? formatMatt(p.payout) : "—"}</td></tr>`).join("");
    const bets = rows.map(p => p.bet);
    els.playerCount.textContent = rows.length.toLocaleString();
    els.roundTotal.textContent = formatMatt(bets.reduce((sum, v) => sum + v, 0));
    els.largestBet.textContent = formatMatt(Math.max(0, ...bets));
  }

  function updatePotential() { const bet = validBet(false); const auto = clamp(Number(els.autoMultiplier.value) || 2, 1.01, 1000); els.potential.textContent = formatMatt(bet * auto); }
  function placeBet(amount = null) {
    const round = currentRoundView();
    if (!round || round.phase !== "betting" || localBet) return;
    if (amount != null) els.betAmount.value = amount;
    const bet = validBet();
    if (!bet) return;
    state.balance -= bet; state.lastBet = bet; state.stats.rounds += 1; state.stats.net -= bet;
    localBet = { round: round.number, amount: bet, status: "queued", cashout: null, payout: 0 };
    saveState(); renderStats(); tone(440, .06); message(`Your ${formatMatt(bet)} demo bet is locked for flight #${round.number}.`);
  }
  function cashOut(auto = false) {
    const round = currentRoundView();
    if (!round || !localBet || localBet.round !== round.number || localBet.status !== "playing") return;
    const multiplier = Math.max(1, Math.floor(displayedMultiplier * 100) / 100);
    const payout = Math.floor(localBet.amount * multiplier);
    localBet.status = "won"; localBet.cashout = multiplier; localBet.payout = payout;
    state.balance += payout; state.stats.wins += 1; state.stats.net += payout; state.stats.streak += 1;
    state.stats.best = Math.max(state.stats.best, multiplier); state.stats.biggestPayout = Math.max(state.stats.biggestPayout, payout);
    saveState(); renderStats(); tone(880, .14); message(`${auto ? "Auto cash-out!" : "Safe landing!"} You won ${formatMatt(payout)} at ${multiplier.toFixed(2)}x.`, "win");
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
    if (lastRound !== round.number) {
      localBet = null; lastRound = round.number; displayedMultiplier = 1; displayedProgress = 0; lastMilestone = 1; crashFxRound = null;
      scene.particles.length = 0; scene.shockwaves.length = 0;
      els.card.classList.remove("crashed", "warp", "flying");
      els.crashTitle.classList.remove("active");
    }
    if (localBet?.round === round.number) {
      if (round.phase === "flying" && localBet.status === "queued") localBet.status = "playing";
      if (round.phase === "crashed" && localBet.status === "playing") {
        localBet.status = "lost"; state.stats.streak = 0; saveState(); renderStats();
        message(`MATT DOWN at ${round.crashPoint.toFixed(2)}x. Your demo bet was lost.`, "loss");
      }
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

  function rocketPosition(progress, width, height) {
    const x = width * (.09 + progress * .78);
    const y = height * (.79 - progress * .57 - Math.sin(progress * Math.PI) * .04);
    return { x, y };
  }

  function spawnExplosion(x, y) {
    const rng = random((lastRound || 1) * 7919);
    for (let i = 0; i < 100; i += 1) {
      const angle = rng() * Math.PI * 2;
      const speed = 80 + rng() * 420;
      scene.particles.push({ x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, life: .6 + rng() * 1.1, maxLife: 1.7, size: 2 + rng() * 8, type: i % 5 === 0 ? "coin" : "spark", spin: rng() * 8 });
    }
    scene.shockwaves.push({ x, y, radius: 5, life: 1, maxLife: 1 });
  }

  function updateScene(dt, multiplier, phase) {
    scene.time += dt;
    const speed = phase === "flying" ? clamp(.06 + Math.log(Math.max(1, multiplier)) * .09, .06, .7) : phase === "betting" ? .025 : .01;
    for (const star of scene.stars) {
      star.x -= speed * dt * star.z;
      if (star.x < -.05) { star.x = 1.05; star.y = Math.random(); }
    }
    for (const asteroid of scene.asteroids) {
      asteroid.x -= speed * dt * (.35 + asteroid.z);
      asteroid.angle += asteroid.spin * dt;
      if (asteroid.x < -.15) { asteroid.x = 1.15 + Math.random() * .3; asteroid.y = .08 + Math.random() * .68; }
    }
    for (const coin of scene.coins) {
      coin.x -= speed * dt * (.42 + coin.z);
      coin.angle += dt * (1.2 + coin.z);
      if (coin.x < -.12) { coin.x = 1.12 + Math.random() * .4; coin.y = .08 + Math.random() * .7; }
    }
    for (let i = scene.particles.length - 1; i >= 0; i -= 1) {
      const p = scene.particles[i]; p.life -= dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= .985; p.vy = p.vy * .985 + 90 * dt; p.spin += dt * 5;
      if (p.life <= 0) scene.particles.splice(i, 1);
    }
    for (let i = scene.shockwaves.length - 1; i >= 0; i -= 1) {
      const wave = scene.shockwaves[i]; wave.life -= dt; wave.radius += 420 * dt;
      if (wave.life <= 0) scene.shockwaves.splice(i, 1);
    }
  }

  function drawScene(multiplier, phase, progress) {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const width = els.canvas.clientWidth, height = els.canvas.clientHeight;
    const pixelWidth = Math.max(1, Math.floor(width * ratio)), pixelHeight = Math.max(1, Math.floor(height * ratio));
    if (els.canvas.width !== pixelWidth || els.canvas.height !== pixelHeight) { els.canvas.width = pixelWidth; els.canvas.height = pixelHeight; }
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const bg = ctx.createRadialGradient(width * .62, height * .36, 0, width * .52, height * .48, width * .8);
    bg.addColorStop(0, phase === "flying" ? "rgba(39,31,82,.42)" : "rgba(25,34,62,.32)");
    bg.addColorStop(.45, "rgba(5,12,27,.35)");
    bg.addColorStop(1, "rgba(0,2,8,.75)");
    ctx.fillStyle = bg; ctx.fillRect(0, 0, width, height);

    const warp = phase === "flying" && multiplier >= 10;
    for (const star of scene.stars) {
      const x = star.x * width, y = star.y * height;
      const alpha = .35 + .45 * (.5 + Math.sin(scene.time * 2 + star.twinkle) * .5);
      ctx.strokeStyle = `rgba(218,235,255,${alpha})`;
      ctx.fillStyle = `rgba(235,245,255,${alpha})`;
      if (warp) {
        const length = 8 + Math.log(multiplier) * 9 * star.z;
        ctx.lineWidth = Math.max(.5, star.size * star.z);
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + length, y); ctx.stroke();
      } else {
        ctx.beginPath(); ctx.arc(x, y, star.size * star.z, 0, Math.PI * 2); ctx.fill();
      }
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
    for (let i = 0; i <= 12; i += 1) {
      const t = i / 12; const y = horizon + Math.pow(t, 2.2) * (height - horizon);
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
    }
    const offset = (scene.time * (phase === "flying" ? 80 + Math.log(multiplier) * 35 : 18)) % 80;
    for (let x = -width; x < width * 2; x += 80) {
      ctx.beginPath(); ctx.moveTo(width / 2, horizon); ctx.lineTo(x - offset, height); ctx.stroke();
    }
    ctx.restore();
  }

  function drawAsteroid(a, width, height, warp) {
    const x = a.x * width, y = a.y * height, size = a.size * (.55 + a.z);
    ctx.save(); ctx.translate(x, y); ctx.rotate(a.angle); ctx.fillStyle = `rgba(98,105,121,${.28 + a.z * .35})`; ctx.strokeStyle = `rgba(190,196,208,${.15 + a.z * .25})`; ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < 8; i += 1) { const angle = i / 8 * Math.PI * 2; const radius = size * (.72 + ((i * a.seed) % 5) / 14); const px = Math.cos(angle) * radius, py = Math.sin(angle) * radius; i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); }
    ctx.closePath(); ctx.fill(); ctx.stroke();
    if (warp) { ctx.strokeStyle = "rgba(160,180,210,.18)"; ctx.beginPath(); ctx.moveTo(size, 0); ctx.lineTo(size + 30 * a.z, 0); ctx.stroke(); }
    ctx.restore();
  }

  function drawCoin(c, width, height) {
    const x = c.x * width, y = c.y * height, size = c.size * (.55 + c.z);
    ctx.save(); ctx.translate(x, y); ctx.rotate(c.angle); ctx.scale(.35 + Math.abs(Math.cos(c.angle)) * .65, 1);
    const gradient = ctx.createRadialGradient(-size * .25, -size * .25, 1, 0, 0, size);
    gradient.addColorStop(0, "#fff0ad"); gradient.addColorStop(.45, "#ffc83d"); gradient.addColorStop(1, "#7b4305");
    ctx.fillStyle = gradient; ctx.strokeStyle = "rgba(255,240,175,.75)"; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(0, 0, size, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = "rgba(20,12,2,.75)"; ctx.font = `900 ${Math.max(8, size)}px system-ui`; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText("M", 0, 1);
    ctx.restore();
  }

  function drawFlightTrail(width, height, multiplier, phase, progress) {
    const end = rocketPosition(progress, width, height);
    const startX = width * .055, startY = height * .81;
    const controlX = width * .43, controlY = height * (.83 - progress * .28);
    ctx.save();
    ctx.lineCap = "round";
    ctx.shadowBlur = phase === "crashed" ? 30 : 20;
    ctx.shadowColor = phase === "crashed" ? "#ff4f64" : multiplier >= 10 ? "#bd73ff" : "#ffc83d";
    const gradient = ctx.createLinearGradient(startX, startY, end.x, end.y);
    gradient.addColorStop(0, "rgba(73,220,255,.06)");
    gradient.addColorStop(.55, multiplier >= 10 ? "rgba(189,115,255,.55)" : "rgba(255,200,61,.48)");
    gradient.addColorStop(1, phase === "crashed" ? "#ff4f64" : multiplier >= 10 ? "#bd73ff" : "#ffc83d");
    ctx.strokeStyle = gradient; ctx.lineWidth = 7;
    ctx.beginPath(); ctx.moveTo(startX, startY); ctx.quadraticCurveTo(controlX, controlY, end.x, end.y); ctx.stroke();
    ctx.shadowBlur = 0; ctx.strokeStyle = "rgba(255,255,255,.65)"; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(startX, startY); ctx.quadraticCurveTo(controlX, controlY, end.x, end.y); ctx.stroke();
    ctx.restore();
  }

  function drawParticles() {
    for (const wave of scene.shockwaves) {
      ctx.save(); ctx.globalAlpha = clamp(wave.life / wave.maxLife, 0, 1); ctx.strokeStyle = "#ffc83d"; ctx.lineWidth = 5 * wave.life; ctx.beginPath(); ctx.arc(wave.x, wave.y, wave.radius, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
    }
    for (const p of scene.particles) {
      const alpha = clamp(p.life / p.maxLife, 0, 1);
      ctx.save(); ctx.globalAlpha = alpha; ctx.translate(p.x, p.y); ctx.rotate(p.spin);
      if (p.type === "coin") {
        ctx.fillStyle = "#ffc83d"; ctx.strokeStyle = "#fff1ad"; ctx.lineWidth = 1; ctx.beginPath(); ctx.ellipse(0, 0, p.size, p.size * .45, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      } else {
        ctx.fillStyle = Math.random() > .5 ? "#ff4f64" : "#ffc83d"; ctx.shadowBlur = 10; ctx.shadowColor = ctx.fillStyle; ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size);
      }
      ctx.restore();
    }
  }

  function updateRocket(progress, multiplier, phase) {
    const width = els.canvas.clientWidth, height = els.canvas.clientHeight;
    const pos = rocketPosition(progress, width, height);
    const angle = -12 + progress * 3 + Math.sin(scene.time * 8) * (phase === "flying" ? .8 : .15);
    const scale = phase === "flying" ? 1 + clamp(Math.log(Math.max(1, multiplier)) * .035, 0, .22) : 1;
    els.rocket.style.left = `${pos.x}px`;
    els.rocket.style.bottom = `${height - pos.y}px`;
    els.rocket.style.transform = `translate(-50%,50%) rotate(${angle}deg) scale(${scale})`;
    els.card.classList.toggle("flying", phase === "flying");
    els.card.classList.toggle("warp", phase === "flying" && multiplier >= 10);
  }

  function updateUi(round, shown, now) {
    const left = Math.max(0, round.phaseEndsAt - now);
    els.roundNumber.textContent = `#${String(round.number).padStart(6, "0")}`;
    els.fairRound.textContent = `#${String(round.number).padStart(6, "0")}`;
    els.fairCommitment.textContent = round.commitment;
    els.fairSeed.textContent = round.seed || "Revealed after crash";
    els.fairResult.textContent = round.crashPoint ? `${round.crashPoint.toFixed(2)}x` : "Waiting for round";
    els.verify.disabled = !round.seed;
    els.verifyMessage.textContent = round.seed ? "Seed revealed. Verify this shared flight now." : "The server commitment was locked before launch.";
    els.multiplier.textContent = `${shown.toFixed(2)}x`;
    els.multiplier.style.color = round.phase === "crashed" ? "var(--red)" : shown >= 50 ? "var(--cyan)" : shown >= 10 ? "var(--purple)" : shown >= 2 ? "var(--gold)" : "var(--text)";
    els.phase.textContent = round.phase === "betting" ? "LAUNCH WINDOW" : round.phase === "flying" ? "MATT IN FLIGHT" : "MATT DOWN";
    els.liveStatus.textContent = round.phase === "betting" ? "BETTING OPEN" : round.phase === "flying" ? "SHARED FLIGHT" : "IMPACT";
    els.countdown.textContent = round.phase === "betting" ? `Launch in ${(left / 1000).toFixed(1)}s` : round.phase === "flying" ? (shown >= 10 ? "Warp speed — cash out before impact" : "Cash out before impact") : `Next launch in ${(left / 1000).toFixed(1)}s`;

    if (round.phase === "betting") {
      els.action.classList.remove("cashout"); els.action.disabled = Boolean(localBet); els.action.textContent = localBet ? "BET LOCKED" : "PLACE BET";
      els.repeat.disabled = Boolean(localBet) || !state.lastBet || state.lastBet > state.balance;
    } else if (round.phase === "flying" && localBet?.status === "playing") {
      els.action.classList.add("cashout"); els.action.disabled = false; els.action.textContent = `CASH OUT • ${shown.toFixed(2)}x`;
      const auto = clamp(Number(els.autoMultiplier.value) || 2, 1.01, 1000); if (els.autoEnabled.checked && shown >= auto) cashOut(true);
    } else {
      els.action.classList.remove("cashout"); els.action.disabled = true; els.action.textContent = round.phase === "crashed" ? `IMPACT • ${round.multiplier.toFixed(2)}x` : "FLIGHT IN PROGRESS"; els.repeat.disabled = true;
    }
    renderPlayers({ ...round, multiplier: shown });
  }

  function renderFrame(timestamp) {
    const dt = clamp((timestamp - lastFrameAt) / 1000, 0, .05); lastFrameAt = timestamp;
    const round = currentRoundView();
    if (round) {
      handleRoundTransition(round);
      const target = round.multiplier;
      const smoothing = 1 - Math.exp(-dt * (round.phase === "crashed" ? 22 : 12));
      displayedMultiplier = lerp(displayedMultiplier, target, smoothing);
      if (Math.abs(target - displayedMultiplier) < .0002) displayedMultiplier = target;
      const shown = round.phase === "crashed" ? round.multiplier : displayedMultiplier;
      const targetProgress = clamp(Math.log(Math.max(1, shown)) / Math.log(60), 0, 1);
      displayedProgress = lerp(displayedProgress, targetProgress, 1 - Math.exp(-dt * 8));
      updateScene(dt, shown, round.phase);
      drawScene(shown, round.phase, displayedProgress);
      updateRocket(displayedProgress, shown, round.phase);
      if (round.phase === "flying") checkMilestones(shown);
      if (timestamp - lastUiUpdateAt > 45) { updateUi(round, shown, round.now); lastUiUpdateAt = timestamp; }
    }
    requestAnimationFrame(renderFrame);
  }

  async function poll() {
    try {
      const started = Date.now();
      const response = await fetch("/api/crash/state", { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      const latency = (Date.now() - started) / 2;
      const measuredOffset = payload.serverTime + latency - Date.now();
      clockOffset += (measuredOffset - clockOffset) * .18;
      server = payload;
      renderHistory();
    } catch {
      els.liveStatus.textContent = "RECONNECTING";
      message("Shared flight server unavailable. Reconnecting automatically…");
    }
  }

  function tone(frequency, duration, type = "sine", volume = .05) {
    if (!state.sound) return;
    try {
      audioContext ||= new AudioContext();
      const oscillator = audioContext.createOscillator(); const gain = audioContext.createGain();
      oscillator.type = type; oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(volume, audioContext.currentTime); gain.gain.exponentialRampToValueAtTime(.001, audioContext.currentTime + duration);
      oscillator.connect(gain).connect(audioContext.destination); oscillator.start(); oscillator.stop(audioContext.currentTime + duration);
    } catch {}
  }

  els.action.addEventListener("click", () => currentRoundView()?.phase === "flying" ? cashOut(false) : placeBet());
  els.repeat.addEventListener("click", () => placeBet(state.lastBet));
  els.resetBalance.addEventListener("click", () => { state.balance = STARTING_BALANCE; saveState(); renderStats(); message("Demo balance reset to 10,000,000 MATT."); });
  els.clearStats.addEventListener("click", () => { state.stats = defaults().stats; saveState(); renderStats(); message("Your local flight stats were cleared."); });
  els.betAmount.addEventListener("input", updatePotential);
  els.autoMultiplier.addEventListener("input", updatePotential);
  document.querySelectorAll("[data-bet-action]").forEach(button => button.addEventListener("click", () => {
    const current = Math.max(1000, Math.floor(Number(els.betAmount.value) || 1000));
    const action = button.dataset.betAction;
    els.betAmount.value = action === "half" ? Math.max(1000, Math.floor(current / 2)) : action === "double" ? Math.min(state.balance, current * 2) : state.balance;
    updatePotential();
  }));
  document.querySelectorAll("[data-copy]").forEach(button => button.addEventListener("click", async () => {
    const target = $(button.dataset.copy); if (!target || !navigator.clipboard) return;
    try { await navigator.clipboard.writeText(target.textContent); button.textContent = "COPIED"; setTimeout(() => button.textContent = "COPY", 900); } catch {}
  }));
  els.sound.addEventListener("click", () => { state.sound = !state.sound; saveState(); renderStats(); if (state.sound) tone(660, .08); });
  els.verify.addEventListener("click", async () => {
    if (!server?.round.seed) return;
    const commitment = await sha256(server.round.seed); const result = await crashFromSeed(server.round.seed, server.round.number);
    const valid = commitment === server.round.commitment && Math.abs(result - server.round.crashPoint) < .001;
    els.verifyMessage.textContent = valid ? `VERIFIED: commitment and ${result.toFixed(2)}x result match.` : "Verification failed. Do not trust this round.";
    els.verifyMessage.className = valid ? "verify-message verified" : "verify-message failed";
  });

  renderStats();
  poll();
  setInterval(poll, POLL_MS);
  requestAnimationFrame(renderFrame);
})();
