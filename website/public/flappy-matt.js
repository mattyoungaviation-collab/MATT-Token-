(() => {
  "use strict";

  const $ = selector => document.querySelector(selector);
  const state = {
    config: null,
    wallet: null,
    token: null,
    busy: false,
    running: false,
    runtime: null,
    run: null,
    events: [],
    lastFrameAt: 0,
    animationFrame: null,
    leaderboard: []
  };
  const canvas = $("#game-canvas");
  const context = canvas.getContext("2d");
  const engine = window.FlappyMattEngine;
  const TOKEN_ABI = ["function transfer(address to,uint256 amount) returns (bool)"];

  function roninProvider() {
    const candidates = [window.ronin?.provider, window.ronin];
    const provider = candidates.find(candidate => candidate && typeof candidate.request === "function");
    if (!provider) throw new Error("Ronin Wallet was not detected. Unlock the Ronin Wallet extension and refresh this page.");
    return provider;
  }

  async function ensureRonin() {
    const provider = roninProvider();
    const chainId = await provider.request({ method: "eth_chainId" });
    if (String(chainId).toLowerCase() === "0x7e4") return provider;
    try {
      await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x7e4" }] });
      return provider;
    } catch {
      throw new Error("Switch Ronin Wallet to Ronin mainnet before playing.");
    }
  }

  async function signMessage(provider, account, message) {
    try { return await provider.request({ method: "personal_sign", params: [message, account] }); }
    catch (error) {
      if (error?.code === 4001) throw error;
      return provider.request({ method: "personal_sign", params: [account, message] });
    }
  }

  async function request(path, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (options.body !== undefined) headers["content-type"] = "application/json";
    if (options.auth !== false && state.token) headers.authorization = `Bearer ${state.token}`;
    const response = await fetch(path, {
      method: options.method || "GET",
      headers,
      cache: "no-store",
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401) clearSession();
      throw new Error(payload.message || "Flappy MATT request failed.");
    }
    return payload;
  }

  async function connectWallet() {
    const provider = roninProvider();
    const [account] = await provider.request({ method: "eth_requestAccounts" });
    if (!account) throw new Error("Ronin Wallet did not return an account.");
    const wallet = String(account).toLowerCase();
    setStatus("Sign the login message in Ronin Wallet. This does not move tokens.");
    const challenge = await request("/api/flappy/auth/challenge", { method: "POST", body: { wallet }, auth: false });
    const signature = await signMessage(provider, wallet, challenge.message);
    const session = await request("/api/flappy/auth/verify", { method: "POST", body: { wallet, signature }, auth: false });
    state.wallet = session.wallet;
    state.token = session.token;
    localStorage.setItem("flappyMattWallet", state.wallet);
    localStorage.setItem("flappyMattToken", state.token);
    $("#wallet-button").textContent = `RONIN ${short(state.wallet)}`;
    $("#play-button").textContent = playButtonText();
    setStatus("Wallet verified. Your next flight is ready.");
    renderLeaderboard();
  }

  function restoreSession() {
    const wallet = localStorage.getItem("flappyMattWallet");
    const token = localStorage.getItem("flappyMattToken");
    if (!wallet || !token) return;
    state.wallet = wallet;
    state.token = token;
    $("#wallet-button").textContent = `RONIN ${short(wallet)}`;
  }

  function clearSession() {
    state.wallet = null;
    state.token = null;
    localStorage.removeItem("flappyMattWallet");
    localStorage.removeItem("flappyMattToken");
    $("#wallet-button").textContent = "CONNECT RONIN WALLET";
    $("#play-button").textContent = "CONNECT TO PLAY";
  }

  async function loadConfig() {
    const config = await request("/api/flappy/config", { auth: false });
    state.config = config;
    renderRound(config.round);
    $("#entry-value").textContent = config.mode === "PAID" ? `${formatMatt(config.entryRaw)} MATT` : "PRACTICE";
    $("#play-button").textContent = state.wallet ? playButtonText() : "CONNECT TO PLAY";
    $("#mode-notice").textContent = config.notice;
    return config;
  }

  async function loadLeaderboard() {
    const payload = await request("/api/flappy/leaderboard", { auth: false });
    state.leaderboard = payload.leaders || [];
    renderRound(payload.round);
    renderLeaderboard();
    renderPrevious(payload.previous);
  }

  function renderRound(round) {
    if (!round) return;
    if (state.config) state.config.round = round;
    $("#round-id").textContent = `Round ${round.id}`;
    $("#round-label").textContent = `${round.playerCount.toLocaleString()} players • ${round.entries.toLocaleString()} flights`;
    $("#pot-value").textContent = `${formatMatt(round.potRaw)} MATT`;
    $("#entry-count").textContent = `${round.entries.toLocaleString()} paid flight${round.entries === 1 ? "" : "s"}`;
    const pot = BigInt(round.potRaw || "0");
    const first = pot * 50n / 100n;
    const second = pot * 35n / 100n;
    const third = pot - first - second;
    $("#first-prize").textContent = `${formatMatt(first)} MATT`;
    $("#second-prize").textContent = `${formatMatt(second)} MATT`;
    $("#third-prize").textContent = `${formatMatt(third)} MATT`;
  }

  function renderLeaderboard() {
    const list = $("#leaderboard-list");
    if (!state.leaderboard.length) {
      list.innerHTML = '<li class="empty">No verified flights yet. The first score owns first place.</li>';
      return;
    }
    list.innerHTML = state.leaderboard.slice(0, 15).map(player => {
      const mine = state.wallet && player.wallet.toLowerCase() === state.wallet.toLowerCase();
      return `<li class="${mine ? "mine" : ""}"><span class="rank">#${player.rank}</span><span class="wallet"><strong>${mine ? "YOU" : short(player.wallet)}</strong><small>${player.attempts.toLocaleString()} flight${player.attempts === 1 ? "" : "s"}</small></span><span class="score">${player.score.toLocaleString()}</span></li>`;
    }).join("");
    const mine = state.leaderboard.find(player => state.wallet && player.wallet.toLowerCase() === state.wallet.toLowerCase());
    if (mine) $("#personal-best").textContent = mine.score.toLocaleString();
  }

  function renderPrevious(round) {
    const section = $("#previous-round");
    if (!round?.winners?.length) {
      section.hidden = true;
      return;
    }
    section.hidden = false;
    $("#previous-winners").innerHTML = round.winners.map(winner => `<span class="winner-pill"><strong>#${winner.rank} ${short(winner.wallet)}</strong> · ${winner.score} pts · ${formatMatt(winner.payoutRaw)} MATT</span>`).join("");
  }

  function playButtonText() {
    if (!state.config) return "LOADING";
    return state.config.mode === "PAID" ? `FLY FOR ${formatMatt(state.config.entryRaw)} MATT` : "START PRACTICE";
  }

  async function startRun() {
    if (state.busy || state.running) return;
    state.busy = true;
    $("#play-button").disabled = true;
    try {
      if (!state.token) await connectWallet();
      const config = await loadConfig();
      let txHash = null;
      if (config.mode === "PAID") {
        if (!window.ethers) throw new Error("The wallet library did not load. Refresh the page.");
        setStatus(`Confirm the ${formatMatt(config.entryRaw)} MATT flight entry in Ronin Wallet.`);
        const injected = await ensureRonin();
        const provider = new window.ethers.BrowserProvider(injected);
        const signer = await provider.getSigner();
        const signerAddress = (await signer.getAddress()).toLowerCase();
        if (signerAddress !== state.wallet.toLowerCase()) throw new Error("The connected Ronin account changed. Connect again.");
        const token = new window.ethers.Contract(config.mattAddress, TOKEN_ABI, signer);
        const transaction = await token.transfer(config.potAddress, BigInt(config.entryRaw));
        setStatus("Entry sent. Waiting for Ronin confirmation.");
        await transaction.wait(1);
        txHash = transaction.hash;
      }
      setStatus("Building your verified flight.");
      const run = await request("/api/flappy/run/start", { method: "POST", body: { txHash } });
      beginGame(run);
      await loadLeaderboard();
    } finally {
      state.busy = false;
      $("#play-button").disabled = false;
    }
  }

  function beginGame(run) {
    state.run = run;
    state.runtime = engine.createRuntime(run.seed);
    state.events = [];
    state.running = true;
    state.lastFrameAt = performance.now();
    $("#live-score").textContent = "0";
    $("#game-overlay").classList.add("hidden");
    flap();
    cancelAnimationFrame(state.animationFrame);
    state.animationFrame = requestAnimationFrame(frame);
  }

  function frame(now) {
    if (!state.running || !state.runtime) return;
    const delta = Math.min(80, Math.max(0, now - state.lastFrameAt));
    state.lastFrameAt = now;
    const snapshot = state.runtime.advance(delta);
    draw(snapshot);
    $("#live-score").textContent = snapshot.score.toLocaleString();
    if (!snapshot.alive) {
      finishRun(snapshot);
      return;
    }
    state.animationFrame = requestAnimationFrame(frame);
  }

  function flap() {
    if (!state.running || !state.runtime) return;
    const snapshot = state.runtime.snapshot();
    if (!snapshot.alive || state.events.length >= engine.CONFIG.maxFlaps) return;
    state.events.push(snapshot.timeMs);
    state.runtime.flap();
  }

  async function finishRun(snapshot) {
    state.running = false;
    cancelAnimationFrame(state.animationFrame);
    $("#game-overlay").classList.remove("hidden");
    $("#overlay-title").textContent = `SCORE ${snapshot.score}`;
    $("#overlay-copy").textContent = "Verifying every tap against the server physics replay…";
    $("#play-button").disabled = true;
    try {
      const result = await request("/api/flappy/run/finish", {
        method: "POST",
        body: { runId: state.run.runId, events: state.events, durationMs: snapshot.timeMs }
      });
      if (result.eligible) {
        $("#overlay-copy").textContent = result.improved
          ? `Verified. New personal best${result.rank ? ` and current rank #${result.rank}` : ""}.`
          : `Verified. Your leaderboard best remains ${result.personalBest}.`;
      } else {
        const best = Math.max(Number(localStorage.getItem("flappyMattPracticeBest") || 0), result.score);
        localStorage.setItem("flappyMattPracticeBest", String(best));
        $("#personal-best").textContent = best.toLocaleString();
        $("#overlay-copy").textContent = `Practice score verified. Best practice flight: ${best}.`;
      }
      state.leaderboard = result.leaders || state.leaderboard;
      renderRound(result.round);
      renderLeaderboard();
      $("#play-button").textContent = playButtonText();
      setStatus(result.eligible ? "Score accepted by the 24 hour leaderboard." : "Practice score verified. Paid leaderboard mode is not enabled yet.");
    } catch (error) {
      $("#overlay-copy").textContent = error.message;
      setStatus(error.message);
    } finally {
      state.run = null;
      state.runtime = null;
      state.events = [];
      $("#play-button").disabled = false;
    }
  }

  function draw(snapshot) {
    const width = canvas.width;
    const height = canvas.height;
    const floorY = height - engine.CONFIG.floorHeight;
    const sky = context.createLinearGradient(0, 0, 0, floorY);
    sky.addColorStop(0, "#5fd7ff");
    sky.addColorStop(1, "#c7f3ff");
    context.fillStyle = sky;
    context.fillRect(0, 0, width, height);

    context.fillStyle = "rgba(255,255,255,.55)";
    for (let index = 0; index < 6; index += 1) {
      const x = (index * 93 - snapshot.timeMs * 0.012) % (width + 120) - 50;
      const y = 70 + (index % 3) * 82;
      context.beginPath();
      context.ellipse(x, y, 32, 13, 0, 0, Math.PI * 2);
      context.ellipse(x + 26, y + 2, 24, 10, 0, 0, Math.PI * 2);
      context.fill();
    }

    for (const pipe of snapshot.pipes) drawPipe(pipe.x, pipe.gapCenter);

    context.fillStyle = "#e7b735";
    context.fillRect(0, floorY, width, engine.CONFIG.floorHeight);
    context.fillStyle = "#7ccb4e";
    context.fillRect(0, floorY, width, 10);
    context.fillStyle = "#ffffff35";
    for (let x = -40; x < width + 40; x += 46) context.fillRect(x - (snapshot.timeMs * .04 % 46), floorY + 19, 24, 6);

    drawBird(engine.CONFIG.birdX, snapshot.birdY, snapshot.velocityY);
  }

  function drawPipe(x, center) {
    const gapTop = center - engine.CONFIG.pipeGap / 2;
    const gapBottom = center + engine.CONFIG.pipeGap / 2;
    const width = engine.CONFIG.pipeWidth;
    context.fillStyle = "#32b96d";
    context.fillRect(x, 0, width, gapTop);
    context.fillRect(x, gapBottom, width, canvas.height - gapBottom - engine.CONFIG.floorHeight);
    context.fillStyle = "#48e38b";
    context.fillRect(x + 7, 0, 10, gapTop);
    context.fillRect(x + 7, gapBottom, 10, canvas.height - gapBottom - engine.CONFIG.floorHeight);
    context.fillStyle = "#16874b";
    context.fillRect(x + width - 9, 0, 9, gapTop);
    context.fillRect(x + width - 9, gapBottom, 9, canvas.height - gapBottom - engine.CONFIG.floorHeight);
    context.fillStyle = "#2cae65";
    context.fillRect(x - 6, gapTop - 24, width + 12, 24);
    context.fillRect(x - 6, gapBottom, width + 12, 24);
  }

  function drawBird(x, y, velocity) {
    context.save();
    context.translate(x, y);
    context.rotate(Math.max(-.45, Math.min(.65, velocity / 800)));
    context.fillStyle = "#ffc93d";
    context.beginPath();
    context.arc(0, 0, 19, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = "#fff";
    context.beginPath();
    context.arc(7, -6, 7, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = "#08111b";
    context.beginPath();
    context.arc(9, -6, 3, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = "#ff7b3d";
    context.beginPath();
    context.moveTo(16, 1);context.lineTo(31, 6);context.lineTo(16, 10);context.closePath();context.fill();
    context.fillStyle = "#0b1624";
    context.font = "1000 17px system-ui";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText("M", -4, 3);
    context.restore();
  }

  function drawIdle() {
    const runtime = engine.createRuntime(12345);
    runtime.flap();
    draw(runtime.snapshot());
  }

  function updateCountdown() {
    const endsAt = Number(state.config?.round?.endsAt || 0);
    if (!endsAt) return;
    const remaining = Math.max(0, endsAt - Date.now());
    const hours = Math.floor(remaining / 3_600_000);
    const minutes = Math.floor((remaining % 3_600_000) / 60_000);
    const seconds = Math.floor((remaining % 60_000) / 1000);
    $("#countdown").textContent = [hours, minutes, seconds].map(value => String(value).padStart(2, "0")).join(":");
    if (remaining === 0) Promise.all([loadConfig(), loadLeaderboard()]).catch(() => {});
  }

  function setStatus(message) { $("#game-status").textContent = message; }
  function short(value) { return value ? `${value.slice(0, 6)}…${value.slice(-4)}` : "Unknown"; }
  function formatMatt(value) {
    const raw = typeof value === "bigint" ? value : BigInt(value || "0");
    const whole = raw / 10n ** 18n;
    const fraction = (raw % 10n ** 18n).toString().padStart(18, "0").slice(0, 2).replace(/0+$/, "");
    return `${Number(whole).toLocaleString()}${fraction ? `.${fraction}` : ""}`;
  }

  function handleGameInput(event) {
    if (!state.running) return;
    if (event.type === "keydown" && !["Space", "ArrowUp"].includes(event.code)) return;
    event.preventDefault();
    flap();
  }

  $("#wallet-button").addEventListener("click", () => connectWallet().catch(error => setStatus(error.message)));
  $("#play-button").addEventListener("click", () => startRun().catch(error => {
    $("#game-overlay").classList.remove("hidden");
    $("#overlay-title").textContent = "FLIGHT BLOCKED";
    $("#overlay-copy").textContent = error.message;
    setStatus(error.message);
    state.busy = false;
    $("#play-button").disabled = false;
  }));
  $("#refresh-board").addEventListener("click", () => loadLeaderboard().catch(error => setStatus(error.message)));
  canvas.addEventListener("pointerdown", handleGameInput);
  window.addEventListener("keydown", handleGameInput, { passive: false });
  window.ronin?.provider?.on?.("accountsChanged", () => clearSession());
  window.ronin?.provider?.on?.("chainChanged", () => { if (state.running) location.reload(); });

  restoreSession();
  $("#personal-best").textContent = Number(localStorage.getItem("flappyMattPracticeBest") || 0).toLocaleString();
  drawIdle();
  Promise.all([loadConfig(), loadLeaderboard()]).catch(error => setStatus(error.message));
  setInterval(updateCountdown, 1000);
  setInterval(() => loadLeaderboard().catch(() => {}), 10_000);
})();
