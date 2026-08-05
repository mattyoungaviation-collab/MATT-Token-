(() => {
  "use strict";

  const config = window.MATT_SLOTS_CONFIG || {};
  const math = window.MattSlotsMath;
  const ethers = window.ethers;
  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];
  const ZERO = "0x0000000000000000000000000000000000000000";
  const SYMBOL_PATHS = math.SYMBOL_SLUGS.map(slug => `/assets/slots/${slug}.${slug === "dyno" ? "png" : (slug === "wild" || slug === "scatter" ? "svg" : "webp")}`);
  const CREDIT_PAID = 1;
  const CREDIT_BONUS = 2;
  const STATUS_PENDING = 1;
  const STATUS_SETTLED = 2;
  const STATUS_REFUNDED = 3;
  const BPS = 10_000n;

  const TOKEN_ABI = [
    "function balanceOf(address) view returns(uint256)",
    "function allowance(address,address) view returns(uint256)",
    "function approve(address,uint256) returns(bool)"
  ];
  const SLOTS_ABI = [
    "event SpinsPurchased(address indexed player,uint256 indexed batchIndex,uint32 indexed mathVersion,uint256 wagerPerSpin,uint8 quantity,uint256 totalCost)",
    "event SpinRequested(uint256 indexed spinId,bytes32 indexed requestHash,address indexed player,uint8 creditType,uint256 creditIndex,uint32 mathVersion,uint256 wager,uint256 maximumSessionPayout)",
    "event SpinSettled(uint256 indexed spinId,bytes32 indexed requestHash,address indexed player,uint8 creditType,uint256 sessionId,uint32 mathVersion,uint64 packedGrid,uint32 winningLinesMask,uint8 scatterCount,uint8 wildReel,uint8 freeSpinsAwarded,uint256 wager,uint256 payout,uint256 treasuryLoss)",
    "function paused() view returns(bool)",
    "function minBet() view returns(uint256)",
    "function maxBet() view returns(uint256)",
    "function currentPlayableMaxBet() view returns(uint256)",
    "function quoteRandomFee() view returns(uint256)",
    "function STALE_REQUEST_DELAY() view returns(uint256)",
    "function matt() view returns(address)",
    "function rewardVault() view returns(address)",
    "function vrfCoordinator() view returns(address)",
    "function activeMathVersion() view returns(uint32)",
    "function getMathConfiguration(uint32 version) view returns(uint256[5] reels,uint32[30] linePaysBps,uint32[3] scatterPaysBps,uint8[3] bonusAwards,uint16 declaredRtpBps,uint64 activatesAt,bool exists)",
    "function buySpins(uint256 wagerPerSpin,uint8 quantity) returns(uint256 batchIndex)",
    "function playPaid(uint256 batchIndex) payable returns(uint256 spinId,bytes32 requestHash)",
    "function playBonus(uint256 sessionId) payable returns(uint256 spinId,bytes32 requestHash)",
    "function refundPaidSpins(uint256 batchIndex,uint8 quantity)",
    "function refundStaleSpin(uint256 spinId)",
    "function paidBatchCount(address player) view returns(uint256)",
    "function paidBatchAt(address player,uint256 batchIndex) view returns(tuple(uint96 wager,uint32 remaining,uint32 purchased,uint32 mathVersion,uint64 purchasedAt))",
    "function playerBonusSessionCount(address player) view returns(uint256)",
    "function playerBonusSessionIdAt(address player,uint256 index) view returns(uint256)",
    "function bonusSessions(uint256 sessionId) view returns(address player,uint96 wager,uint32 remaining,uint32 totalAwarded,uint32 totalPlayed,uint32 mathVersion,uint64 rootSpinId,uint256 totalPayout,bool completed)",
    "function spins(uint256 spinId) view returns(address player,uint96 wager,uint64 requestedAt,uint64 previousPlayerSpinId,uint32 mathVersion,uint32 creditIndex,uint8 creditType,uint8 status,uint8 wildReel,uint8 scatterCount,uint8 freeSpinsAwarded,uint32 winningLinesMask,uint64 packedGrid,uint256 sessionId,uint256 payout,uint256 treasuryLoss,bytes32 requestHash)",
    "function getSpinGrid(uint256 spinId) view returns(uint8[15])",
    "function activeSpinOf(address player) view returns(uint256)",
    "function lastSpinOf(address player) view returns(uint256)"
  ];
  const VAULT_ABI = [
    "function claimable(address) view returns(uint256)",
    "function availableBankroll() view returns(uint256)",
    "function pendingTreasuryLoss() view returns(uint256)",
    "function matt() view returns(address)",
    "function converter() view returns(address)",
    "function controller() view returns(address)",
    "function claim()",
    "function flushTreasuryLoss(uint256 amount)"
  ];
  const CONVERTER_ABI = [
    "function pendingMatt() view returns(uint256)",
    "function totalMattConverted() view returns(uint256)",
    "function totalRonForwarded() view returns(uint256)",
    "function paused() view returns(bool)",
    "function matt() view returns(address)",
    "function sourceVault() view returns(address)",
    "function treasury() view returns(address)"
  ];

  const state = {
    readProvider: null,
    browserProvider: null,
    signer: null,
    account: null,
    readToken: null,
    token: null,
    readSlots: null,
    slots: null,
    readVault: null,
    vault: null,
    readConverter: null,
    selected: null,
    paidBatches: [],
    bonusSessions: [],
    minBet: ethers ? ethers.parseEther("500") : 0n,
    maxBet: ethers ? ethers.parseEther("50000") : 0n,
    playableMax: ethers ? ethers.parseEther("50000") : 0n,
    paused: true,
    live: false,
    busy: false,
    turbo: false,
    sound: true,
    lastSpinId: 0n,
    pendingSpin: 0n,
    pendingRequestedAt: 0,
    staleDelay: 2 * 60 * 60,
    staleTimer: null,
    activeMathVersion: 1,
    linePaysBps: [...math.LINE_PAYS_BPS],
    scatterPaysBps: [...math.SCATTER_PAYS_BPS],
    bonusAwards: [...math.BONUS_AWARDS],
    declaredRtpBps: 9700,
    currentGrid: Array.from({ length: 5 }, () => Array(3).fill(0)),
    reelTimer: null
  };

  function walletProvider() {
    const candidates = [window.ronin?.provider, window.ronin,
      ...(Array.isArray(window.ethereum?.providers) ? window.ethereum.providers : []), window.ethereum];
    return candidates.find(item => item?.request && (item.isRonin || item.isRoninWallet))
      || candidates.find(item => item?.request) || null;
  }

  function formatMatt(value, decimals = 2) {
    if (value == null || !ethers) return "—";
    const number = Number(ethers.formatEther(value));
    if (!Number.isFinite(number)) return "—";
    return `${number.toLocaleString(undefined, { maximumFractionDigits: decimals, notation: number >= 10_000_000 ? "compact" : "standard" })} MATT`;
  }
  function formatRon(value) {
    if (value == null || !ethers) return "—";
    const number = Number(ethers.formatEther(value));
    return `${number.toLocaleString(undefined, { maximumFractionDigits: 5 })} RON`;
  }
  function shortAddress(value) { return value ? `${value.slice(0, 6)}…${value.slice(-4)}` : "CONNECT RONIN"; }
  function txLink(hash, label = "View on Ronin ↗") { return `<a href="${config.explorerBase}/tx/${hash}" target="_blank" rel="noopener">${label}</a>`; }
  function addressLink(address) { return `${config.explorerBase}/address/${address}`; }
  function errorMessage(error) {
    const text = String(error?.shortMessage || error?.reason || error?.message || "Transaction failed.");
    if (/user rejected|user denied|cancel/i.test(text)) return "Transaction cancelled in Ronin Wallet.";
    if (/insufficient funds/i.test(text)) return "Not enough RON for the VRF request and gas.";
    if (/allowance|transfer amount exceeds|insufficient balance|ERC20InsufficientBalance/i.test(text)) return "Not enough MATT or the approval did not complete.";
    if (/ActiveSpinExists/i.test(text)) return "This wallet already has a spin waiting for Ronin VRF.";
    if (/InsufficientBankroll/i.test(text)) return "The reward vault cannot safely cover that spin value right now.";
    return text.replace(/^execution reverted:\s*/i, "").slice(0, 260);
  }
  function setStatus(message, type = "") {
    const element = $("#action-status");
    element.innerHTML = message;
    element.className = `action-status ${type}`.trim();
  }
  function setBusy(busy) {
    state.busy = busy;
    updateButtons();
  }
  async function ensureRonin(provider) {
    const current = String(await provider.request({ method: "eth_chainId" })).toLowerCase();
    if (current !== config.chainHex) {
      await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: config.chainHex }] });
    }
  }

  function buildReels() {
    const root = $("#reels");
    root.textContent = "";
    for (let reel = 0; reel < 5; reel += 1) {
      const column = document.createElement("div");
      column.className = "reel";
      column.dataset.reel = reel;
      for (let row = 0; row < 3; row += 1) {
        const cell = document.createElement("div");
        cell.className = "symbol-cell";
        cell.dataset.reel = reel;
        cell.dataset.row = row;
        const image = document.createElement("img");
        image.src = SYMBOL_PATHS[state.currentGrid[reel][row]];
        image.alt = math.SYMBOL_NAMES[state.currentGrid[reel][row]];
        cell.append(image);
        column.append(cell);
      }
      root.append(column);
    }
    requestAnimationFrame(drawPaylines);
  }

  function drawPaylines() {
    const overlay = $("#payline-overlay");
    const reels = $("#reels");
    if (!overlay || !reels.clientWidth) return;
    overlay.textContent = "";
    const width = overlay.clientWidth;
    const height = overlay.clientHeight;
    const reelWidth = width / 5;
    const rowHeight = height / 3;
    const palette = ["#ff3d57", "#3fd2ff", "#ffcf2d", "#72ef87", "#c17dff"];
    math.LINES.forEach((line, index) => {
      for (let reel = 0; reel < 4; reel += 1) {
        const x1 = reelWidth * (reel + .5);
        const y1 = rowHeight * (line[reel] + .5);
        const x2 = reelWidth * (reel + 1.5);
        const y2 = rowHeight * (line[reel + 1] + .5);
        const length = Math.hypot(x2 - x1, y2 - y1);
        const angle = Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI;
        const segment = document.createElement("i");
        segment.className = "payline-segment";
        segment.style.left = `${x1}px`;
        segment.style.top = `${y1}px`;
        segment.style.width = `${length}px`;
        segment.style.transform = `rotate(${angle}deg)`;
        segment.style.background = palette[index % palette.length];
        segment.style.boxShadow = `0 0 7px ${palette[index % palette.length]}`;
        overlay.append(segment);
      }
    });
  }

  function showGrid(grid, result = {}) {
    state.currentGrid = grid;
    $$(".symbol-cell").forEach(cell => {
      const reel = Number(cell.dataset.reel);
      const row = Number(cell.dataset.row);
      const symbol = grid[reel][row];
      const image = cell.querySelector("img");
      image.src = SYMBOL_PATHS[symbol];
      image.alt = math.SYMBOL_NAMES[symbol];
      cell.classList.remove("win", "scatter-win");
    });
    const mask = Number(result.winningLinesMask || 0);
    math.LINES.forEach((line, index) => {
      if (((mask >>> index) & 1) === 0) return;
      line.forEach((row, reel) => document.querySelector(`.symbol-cell[data-reel="${reel}"][data-row="${row}"]`)?.classList.add("win"));
    });
    if (Number(result.scatterCount || 0) >= 3) {
      $$(".symbol-cell").forEach(cell => {
        const symbol = grid[Number(cell.dataset.reel)][Number(cell.dataset.row)];
        if (symbol === math.SCATTER) cell.classList.add("scatter-win");
      });
    }
  }

  function randomPreviewGrid() {
    const values = new Uint32Array(6);
    crypto.getRandomValues(values);
    const stops = [...values.slice(0, 5)].map(value => value & 63);
    return math.gridFromStops(stops, -1);
  }

  function cycleReels(active = true) {
    if (state.reelTimer) { clearInterval(state.reelTimer); state.reelTimer = null; }
    $$(".reel").forEach(reel => reel.classList.toggle("spinning", active));
    if (!active) return () => {};
    state.reelTimer = setInterval(() => {
      $$(".symbol-cell img").forEach(image => {
        const symbol = Math.floor(Math.random() * 8);
        image.src = SYMBOL_PATHS[symbol];
        image.alt = "Reels spinning";
      });
    }, state.turbo ? 65 : 95);
    return () => cycleReels(false);
  }

  async function animateToGrid(grid, result = {}) {
    const stopCycle = cycleReels(true);
    await new Promise(resolve => setTimeout(resolve, state.turbo ? 350 : 900));
    stopCycle();
    for (let reel = 0; reel < 5; reel += 1) {
      for (let row = 0; row < 3; row += 1) {
        const cell = document.querySelector(`.symbol-cell[data-reel="${reel}"][data-row="${row}"]`);
        const image = cell.querySelector("img");
        image.src = SYMBOL_PATHS[grid[reel][row]];
        image.alt = math.SYMBOL_NAMES[grid[reel][row]];
      }
      beep(210 + reel * 45, .035);
      await new Promise(resolve => setTimeout(resolve, state.turbo ? 80 : 260));
    }
    showGrid(grid, result);
  }

  function beep(frequency = 440, duration = .05) {
    if (!state.sound) return;
    try {
      const Context = window.AudioContext || window.webkitAudioContext;
      if (!Context) return;
      const ctx = beep.ctx || (beep.ctx = new Context());
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(.035, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(.0001, ctx.currentTime + duration);
      oscillator.connect(gain).connect(ctx.destination);
      oscillator.start(); oscillator.stop(ctx.currentTime + duration);
    } catch {}
  }

  function renderPaytable() {
    const root = $("#paytable-grid");
    root.innerHTML = math.SYMBOL_NAMES.slice(0, 9).map((name, symbol) => {
      const offset = symbol * 3;
      const values = state.linePaysBps.slice(offset, offset + 3);
      return `<article class="paytable-card"><img src="${SYMBOL_PATHS[symbol]}" alt="${name}"><div><h3>${name}</h3><div class="pay-values">${values.map((bps, index) => `<span>${index + 3} MATCH<b>${formatMultiplier(bps)}</b></span>`).join("")}</div></div></article>`;
    }).join("");
  }
  function renderBonusRules() {
    const rules = [
      ["#scatter-three-rule", state.scatterPaysBps[0], state.bonusAwards[0]],
      ["#scatter-four-rule", state.scatterPaysBps[1], state.bonusAwards[1]],
      ["#scatter-five-rule", state.scatterPaysBps[2], state.bonusAwards[2]]
    ];
    for (const [selector, payout, spins] of rules) {
      const element = $(selector);
      if (element) element.textContent = `${formatMultiplier(payout)} + ${spins} FREE SPINS`;
    }
    const rtp = (state.declaredRtpBps / 100).toLocaleString(undefined, { maximumFractionDigits: 2 });
    const pill = $("#rtp-pill");
    if (pill) pill.textContent = `Working ${rtp}% RTP • Math V${state.activeMathVersion}`;
  }

  function formatMultiplier(bps) {
    const value = Number(bps) / 10_000;
    return `${value.toLocaleString(undefined, { maximumFractionDigits: 4 })}×`;
  }

  function betValue() {
    const raw = $("#bet-input").value.replace(/,/g, "").trim();
    if (!/^\d+$/.test(raw)) throw new Error("Enter a whole-MATT spin value.");
    return ethers.parseEther(raw);
  }
  function clampBet(value) {
    let amount = BigInt(value);
    if (amount < state.minBet) amount = state.minBet;
    if (amount > state.playableMax) amount = state.playableMax;
    $("#bet-input").value = Number(ethers.formatEther(amount)).toLocaleString(undefined, { maximumFractionDigits: 0 });
    updateSummary();
  }
  function betStep(amount) {
    const numeric = Number(ethers.formatEther(amount));
    if (numeric < 1_000) return ethers.parseEther("500");
    if (numeric < 5_000) return ethers.parseEther("1000");
    if (numeric < 25_000) return ethers.parseEther("5000");
    return ethers.parseEther("10000");
  }
  function updateSummary() {
    let wager;
    try { wager = betValue(); } catch { wager = 0n; }
    const quantity = Number($("#spin-quantity").value);
    $("#spin-quantity-output").textContent = String(quantity);
    $("#summary-quantity").textContent = String(quantity);
    $("#summary-bet").textContent = formatMatt(wager, 0);
    $("#summary-total").textContent = formatMatt(wager * BigInt(quantity), 0);
    $("#summary-max").textContent = formatMatt(wager * 500n, 0);
    $$("#bet-presets button").forEach(button => button.classList.toggle("active", ethers.parseEther(button.dataset.bet) === wager));
    updateButtons();
  }

  async function initializeReads() {
    if (!ethers || !math) throw new Error("The Slots libraries did not load.");
    state.readProvider = new ethers.JsonRpcProvider(new URL(config.rpcUrl, location.origin).href, config.chainId, { staticNetwork: true, batchMaxCount: 1 });
    state.readToken = new ethers.Contract(config.tokenAddress, TOKEN_ABI, state.readProvider);
    const addresses = [config.slotsAddress, config.rewardVaultAddress, config.converterAddress];
    state.live = addresses.every(address => address && address !== ZERO);
    if (!state.live) {
      $("#mode-label").textContent = "PRACTICE BUILD • CONTRACTS NOT DEPLOYED";
      $("#contract-state").textContent = "PRACTICE";
      setStatus("The complete interface is staged. Practice uses the published math; live MATT remains locked until the verified contracts are deployed.");
      updateContractLinks();
      updateButtons();
      return;
    }
    state.readSlots = new ethers.Contract(config.slotsAddress, SLOTS_ABI, state.readProvider);
    state.readVault = new ethers.Contract(config.rewardVaultAddress, VAULT_ABI, state.readProvider);
    state.readConverter = new ethers.Contract(config.converterAddress, CONVERTER_ABI, state.readProvider);
    const [
      slotsCode, vaultCode, converterCode, paused, minBet, maxBet, playableMax, staleDelay,
      deployedMatt, deployedVault, deployedCoordinator, vaultMatt, vaultConverter, vaultController,
      converterMatt, converterSourceVault, converterTreasury
    ] = await Promise.all([
      state.readProvider.getCode(config.slotsAddress),
      state.readProvider.getCode(config.rewardVaultAddress),
      state.readProvider.getCode(config.converterAddress),
      state.readSlots.paused(),
      state.readSlots.minBet(),
      state.readSlots.maxBet(),
      state.readSlots.currentPlayableMaxBet(),
      state.readSlots.STALE_REQUEST_DELAY(),
      state.readSlots.matt(),
      state.readSlots.rewardVault(),
      state.readSlots.vrfCoordinator(),
      state.readVault.matt(),
      state.readVault.converter(),
      state.readVault.controller(),
      state.readConverter.matt(),
      state.readConverter.sourceVault(),
      state.readConverter.treasury()
    ]);
    if ([slotsCode, vaultCode, converterCode].includes("0x")) throw new Error("A configured Slots contract is missing from Ronin.");
    const same = (left, right) => String(left).toLowerCase() === String(right).toLowerCase();
    if (
      !same(deployedMatt, config.tokenAddress)
        || !same(deployedVault, config.rewardVaultAddress)
        || !same(deployedCoordinator, config.vrfCoordinatorAddress)
        || !same(vaultMatt, config.tokenAddress)
        || !same(vaultConverter, config.converterAddress)
        || !same(vaultController, config.slotsAddress)
        || !same(converterMatt, config.tokenAddress)
        || !same(converterSourceVault, config.rewardVaultAddress)
        || !same(converterTreasury, config.treasuryAddress)
    ) throw new Error("The configured Slots contracts are not linked to the official MATT deployment.");
    state.staleDelay = Number(staleDelay);
    state.paused = paused;
    state.minBet = minBet;
    state.maxBet = maxBet;
    state.playableMax = playableMax < maxBet ? playableMax : maxBet;
    const activeMathVersion = await state.readSlots.activeMathVersion();
    const activeMath = await state.readSlots.getMathConfiguration(activeMathVersion);
    if (!activeMath.exists) throw new Error("The active Slots math configuration is missing.");
    state.activeMathVersion = Number(activeMathVersion);
    state.linePaysBps = Array.from(activeMath.linePaysBps, Number);
    state.scatterPaysBps = Array.from(activeMath.scatterPaysBps, Number);
    state.bonusAwards = Array.from(activeMath.bonusAwards, Number);
    state.declaredRtpBps = Number(activeMath.declaredRtpBps);
    renderPaytable();
    renderBonusRules();
    $("#mode-label").textContent = paused ? "DEPLOYED • PAUSED" : "LIVE ON RONIN • ONE VRF PER SPIN";
    $("#contract-state").textContent = paused ? "PAUSED" : "LIVE";
    $("#bet-limit-label").textContent = `Max ${Number(ethers.formatEther(state.playableMax)).toLocaleString()}`;
    clampBet(ethers.parseEther(config.defaultBet));
    updateContractLinks();
    await refreshTreasury();
  }

  function updateContractLinks() {
    [["#slots-contract-link", config.slotsAddress, "Slots contract"], ["#vault-contract-link", config.rewardVaultAddress, "Reward vault"], ["#converter-contract-link", config.converterAddress, "Treasury converter"]].forEach(([selector, address, label]) => {
      const link = $(selector);
      if (address && address !== ZERO) { link.href = addressLink(address); link.textContent = `${label} ↗`; link.removeAttribute("aria-disabled"); }
      else { link.href = "#"; link.textContent = `${label} pending`; link.setAttribute("aria-disabled", "true"); }
    });
  }

  async function connectWallet({ silent = false } = {}) {
    const injected = walletProvider();
    if (!injected) { if (!silent) throw new Error("Ronin Wallet was not detected."); return; }
    const accounts = await injected.request({ method: silent ? "eth_accounts" : "eth_requestAccounts" });
    if (!accounts?.[0]) { if (!silent) throw new Error("No wallet account was approved."); return; }
    await ensureRonin(injected);
    state.browserProvider = new ethers.BrowserProvider(injected);
    state.signer = await state.browserProvider.getSigner();
    state.account = await state.signer.getAddress();
    state.token = new ethers.Contract(config.tokenAddress, TOKEN_ABI, state.signer);
    if (state.live) {
      state.slots = new ethers.Contract(config.slotsAddress, SLOTS_ABI, state.signer);
      state.vault = new ethers.Contract(config.rewardVaultAddress, VAULT_ABI, state.signer);
    }
    $("#wallet-button").textContent = shortAddress(state.account);
    $("#wallet-address").textContent = shortAddress(state.account);
    await refreshAll();
  }

  async function refreshAll() {
    if (!state.account) return;
    const balance = await state.readToken.balanceOf(state.account);
    $("#wallet-balance").textContent = formatMatt(balance);
    await Promise.all([loadInventory(), loadHistory(), refreshTreasury()]);
    const active = state.live ? await state.readSlots.activeSpinOf(state.account) : 0n;
    state.pendingSpin = BigInt(active || 0);
    if (state.pendingSpin) {
      state.lastSpinId = state.pendingSpin;
      const pending = await state.readSlots.spins(state.pendingSpin);
      state.pendingRequestedAt = Number(pending.requestedAt);
      showPending(state.pendingSpin, "A previous spin is still waiting for Ronin VRF.");
      configureStaleRestore(state.pendingSpin, state.pendingRequestedAt);
      pollSpin(state.pendingSpin).catch(error => setStatus(errorMessage(error), "bad"));
    } else {
      clearPendingState();
    }
    updateButtons();
  }

  async function refreshTreasury() {
    if (!state.live) { $("#pending-conversion").textContent = "DEPLOYMENT PENDING"; $("#ron-forwarded").textContent = "—"; return; }
    try {
      const [queued, converterPending, ron] = await Promise.all([
        state.readVault.pendingTreasuryLoss(), state.readConverter.pendingMatt(), state.readConverter.totalRonForwarded()
      ]);
      $("#pending-conversion").textContent = formatMatt(queued + converterPending, 0);
      $("#ron-forwarded").textContent = formatRon(ron);
    } catch { $("#pending-conversion").textContent = "Unavailable"; }
  }

  async function loadInventory() {
    if (!state.account || !state.live) { renderInventory(); return; }
    const [batchCountRaw, sessionCountRaw, claimable] = await Promise.all([
      state.readSlots.paidBatchCount(state.account), state.readSlots.playerBonusSessionCount(state.account), state.readVault.claimable(state.account)
    ]);
    const batchCount = Number(batchCountRaw);
    const sessionCount = Number(sessionCountRaw);
    state.paidBatches = [];
    state.bonusSessions = [];
    for (let index = 0; index < batchCount; index += 1) {
      const batch = await state.readSlots.paidBatchAt(state.account, index);
      if (Number(batch.remaining) > 0) state.paidBatches.push({ type: "paid", index, wager: BigInt(batch.wager), remaining: Number(batch.remaining), mathVersion: Number(batch.mathVersion) });
    }
    for (let index = 0; index < sessionCount; index += 1) {
      const id = await state.readSlots.playerBonusSessionIdAt(state.account, index);
      const session = await state.readSlots.bonusSessions(id);
      if (!session.completed && Number(session.remaining) > 0) state.bonusSessions.push({ type: "bonus", id: BigInt(id), wager: BigInt(session.wager), remaining: Number(session.remaining), totalPayout: BigInt(session.totalPayout), mathVersion: Number(session.mathVersion) });
    }
    $("#claimable-total").textContent = formatMatt(claimable, 0).replace(" MATT", "");
    state.claimable = claimable;
    const all = [...state.bonusSessions, ...state.paidBatches];
    if (!state.selected || !all.some(item => inventoryKey(item) === inventoryKey(state.selected))) state.selected = all[0] || null;
    renderInventory();
  }
  function inventoryKey(item) { return item ? `${item.type}:${item.type === "paid" ? item.index : item.id}` : ""; }
  function renderInventory() {
    const paid = state.paidBatches.reduce((sum, item) => sum + item.remaining, 0);
    const bonus = state.bonusSessions.reduce((sum, item) => sum + item.remaining, 0);
    $("#paid-total").textContent = String(paid);
    $("#bonus-total").textContent = String(bonus);
    const root = $("#inventory-list");
    if (!state.account) { root.innerHTML = "<p>Connect your wallet to load purchased spins.</p>"; updateButtons(); return; }
    if (!state.live) { root.innerHTML = "<p>Live inventory will appear after the paused contracts are deployed and configured.</p>"; updateButtons(); return; }
    const items = [...state.bonusSessions, ...state.paidBatches];
    if (!items.length) { root.innerHTML = "<p>No spin credits yet. Choose a value and buy 1–25 spins.</p>"; updateButtons(); return; }
    root.innerHTML = items.map(item => `<label class="inventory-item ${inventoryKey(item) === inventoryKey(state.selected) ? "selected" : ""}"><input type="radio" name="inventory" value="${inventoryKey(item)}" ${inventoryKey(item) === inventoryKey(state.selected) ? "checked" : ""}><div><strong>${item.type === "bonus" ? "FREE SPINS" : "PAID SPINS"} · ${formatMatt(item.wager, 0)}</strong><span>${item.type === "bonus" ? `Session #${item.id}` : `Batch #${item.index}`} · Math V${item.mathVersion}</span></div><b>${item.remaining}</b></label>`).join("");
    $$('input[name="inventory"]').forEach(input => input.addEventListener("change", () => {
      state.selected = items.find(item => inventoryKey(item) === input.value) || null; renderInventory();
    }));
    updateButtons();
  }

  function updateButtons() {
    const walletReady = state.live && state.account && !state.busy;
    const playReady = walletReady && !state.paused;
    let validBet = false;
    try { const wager = betValue(); validBet = wager >= state.minBet && wager <= state.playableMax; } catch {}
    $("#buy-button").disabled = !playReady || !validBet;
    $("#buy-button").textContent = !state.account ? "CONNECT RONIN TO BUY" : !state.live ? "CONTRACT DEPLOYMENT PENDING" : state.paused ? "SLOTS ARE PAUSED" : "BUY SPINS WITH MATT";
    $("#spin-button").disabled = !playReady || !state.selected || Boolean(state.pendingSpin);
    $("#spin-button span").textContent = state.pendingSpin ? "VERIFYING" : state.selected?.type === "bonus" ? "SPIN FREE" : "SPIN";
    $("#claim-button").disabled = !walletReady || !state.claimable;
    $("#refund-button").disabled = !walletReady || state.selected?.type !== "paid";
  }

  async function buySpins() {
    if (!state.slots) return connectWallet();
    const wager = betValue();
    const quantity = Number($("#spin-quantity").value);
    if (wager < state.minBet || wager > state.playableMax) throw new Error("Choose a spin value inside the current contract limits.");
    const total = wager * BigInt(quantity);
    setBusy(true);
    try {
      const allowance = await state.readToken.allowance(state.account, config.slotsAddress);
      if (allowance < total) {
        setStatus(`Approve exactly ${formatMatt(total, 0)} for this spin purchase in Ronin Wallet.`);
        const approval = await state.token.approve(config.slotsAddress, total);
        setStatus(`Approval submitted. ${txLink(approval.hash)}`);
        await approval.wait();
      }
      setStatus(`Confirm the purchase of ${quantity} spin${quantity === 1 ? "" : "s"}.`);
      const transaction = await state.slots.buySpins(wager, quantity);
      setStatus(`Spin purchase submitted. ${txLink(transaction.hash)}`);
      await transaction.wait();
      setStatus(`${quantity} verified spin credit${quantity === 1 ? "" : "s"} added to your wallet.`, "good");
      await refreshAll();
    } finally { setBusy(false); }
  }

  async function playSelected() {
    if (!state.selected || !state.slots) return;
    setBusy(true);
    try {
      const quotedFee = await state.readSlots.quoteRandomFee();
      const fee = (quotedFee * 11_500n + 9_999n) / 10_000n;
      setStatus(`Confirm one ${state.selected.type === "bonus" ? "free" : "paid"} spin. The small RON value funds this spin's VRF request; unused fee is refunded by the coordinator.`);
      const transaction = state.selected.type === "paid"
        ? await state.slots.playPaid(state.selected.index, { value: fee })
        : await state.slots.playBonus(state.selected.id, { value: fee });
      showPending(0n, "Spin transaction sent. Waiting for its onchain ID.");
      const receipt = await transaction.wait();
      let spinId = 0n;
      for (const log of receipt.logs) {
        try { const parsed = state.slots.interface.parseLog(log); if (parsed?.name === "SpinRequested") { spinId = parsed.args.spinId; break; } } catch {}
      }
      if (!spinId) spinId = await state.readSlots.activeSpinOf(state.account);
      if (!spinId) throw new Error("The spin request was confirmed but its ID was not found.");
      state.lastSpinId = spinId;
      state.pendingSpin = spinId;
      const pending = await state.readSlots.spins(spinId);
      state.pendingRequestedAt = Number(pending.requestedAt);
      configureStaleRestore(spinId, state.pendingRequestedAt);
      showPending(spinId, `Spin #${spinId} requested. Waiting for Ronin VRF.`);
      setStatus(`Spin #${spinId} requested. ${txLink(transaction.hash)}`);
      await pollSpin(spinId);
    } finally { setBusy(false); }
  }

  function clearPendingState() {
    state.pendingSpin = 0n;
    state.pendingRequestedAt = 0;
    if (state.staleTimer) { clearTimeout(state.staleTimer); state.staleTimer = null; }
    const button = $("#stale-refund-button");
    if (button) button.hidden = true;
  }

  function configureStaleRestore(spinId, requestedAt) {
    if (state.staleTimer) clearTimeout(state.staleTimer);
    const button = $("#stale-refund-button");
    if (!button) return;
    const reveal = () => {
      button.hidden = !(state.pendingSpin && BigInt(spinId) === BigInt(state.pendingSpin));
      updateButtons();
    };
    const remainingMs = Math.max(0, (Number(requestedAt) + state.staleDelay) * 1000 - Date.now());
    button.hidden = remainingMs > 0;
    if (remainingMs > 0) state.staleTimer = setTimeout(reveal, Math.min(remainingMs + 250, 2_147_000_000));
  }

  async function restoreStaleSpin() {
    if (!state.pendingSpin || !state.slots) return;
    setBusy(true);
    try {
      const spinId = state.pendingSpin;
      const transaction = await state.slots.refundStaleSpin(spinId);
      setStatus(`Stale-spin restoration submitted. ${txLink(transaction.hash)}`);
      await transaction.wait();
      clearPendingState();
      $("#pending-screen").hidden = true;
      cycleReels(false);
      setStatus(`Spin #${spinId} was restored to its original paid or free credit.`, "good");
      await refreshAll();
    } finally { setBusy(false); }
  }

  function showPending(spinId, detail) {
    $("#pending-screen").hidden = false;
    $("#pending-detail").textContent = detail;
    $("#result-kicker").textContent = spinId ? `SPIN #${spinId}` : "PENDING";
    $("#result-title").textContent = "RONIN IS VERIFYING";
    $("#result-detail").textContent = "The browser cannot select or change the result.";
    cycleReels(true);
  }

  async function pollSpin(spinId) {
    const started = Date.now();
    while (Date.now() - started < 15 * 60_000) {
      const spin = await state.readSlots.spins(spinId);
      const status = Number(spin.status);
      if (status === STATUS_SETTLED) {
        clearPendingState();
        $("#pending-screen").hidden = true;
        cycleReels(false);
        const flat = await state.readSlots.getSpinGrid(spinId);
        const grid = Array.from({ length: 5 }, (_, reel) => Array.from({ length: 3 }, (_, row) => Number(flat[reel * 3 + row])));
        await animateToGrid(grid, spin);
        showResult(spinId, spin);
        await refreshAll();
        return;
      }
      if (status === STATUS_REFUNDED) {
        clearPendingState();
        $("#pending-screen").hidden = true; cycleReels(false);
        setStatus(`Spin #${spinId} was restored as a credit after its VRF request expired.`, "good");
        await refreshAll(); return;
      }
      await new Promise(resolve => setTimeout(resolve, 2_500));
    }
    cycleReels(false);
    $("#pending-screen").hidden = true;
    throw new Error(`Spin #${spinId} is still pending. It remains protected onchain and becomes refundable after two hours.`);
  }

  function showResult(spinId, spin) {
    const wager = BigInt(spin.wager);
    const payout = BigInt(spin.payout);
    const loss = BigInt(spin.treasuryLoss);
    const isBonus = Number(spin.creditType) === CREDIT_BONUS;
    const multiplier = wager ? Number(payout * 10_000n / wager) / 10_000 : 0;
    const panel = $(".win-display");
    panel.classList.toggle("big", multiplier >= 5);
    $("#result-kicker").textContent = `SPIN #${spinId} • ${isBonus ? "FREE" : "PAID"}`;

    if (isBonus) {
      if (payout > 0n) {
        $("#result-title").textContent = multiplier >= 100 ? "LEGENDARY FREE-SPIN WIN" : multiplier >= 20 ? "MEGA FREE-SPIN WIN" : multiplier >= 5 ? "BIG FREE-SPIN WIN" : "FREE-SPIN WIN";
        $("#result-detail").textContent = `${formatMatt(payout)} added to claimable MATT • ${multiplier.toLocaleString(undefined, { maximumFractionDigits: 4 })}× spin value`;
        beep(multiplier >= 20 ? 880 : 660, .2);
      } else {
        $("#result-title").textContent = "FREE SPIN COMPLETE";
        $("#result-detail").textContent = "No MATT was wagered and no treasury loss was created.";
      }
    } else if (payout > wager) {
      $("#result-title").textContent = multiplier >= 100 ? "LEGENDARY MATT WIN" : multiplier >= 20 ? "MEGA WIN" : multiplier >= 5 ? "BIG WIN" : "MATT WIN";
      $("#result-detail").textContent = `${formatMatt(payout)} returned • +${formatMatt(payout - wager)} net • ${multiplier.toLocaleString(undefined, { maximumFractionDigits: 4 })}×`;
      beep(multiplier >= 20 ? 880 : 660, .2);
    } else if (payout === wager) {
      $("#result-title").textContent = "SPIN VALUE RETURNED";
      $("#result-detail").textContent = `${formatMatt(payout)} returned • break even`;
    } else if (payout > 0n) {
      $("#result-title").textContent = "PARTIAL RETURN";
      $("#result-detail").textContent = `${formatMatt(payout)} returned • ${formatMatt(loss)} net loss queued for treasury RON`;
    } else {
      $("#result-title").textContent = "NO PAYING LINE";
      $("#result-detail").textContent = `${formatMatt(loss)} queued for treasury RON`;
    }
    if (Number(spin.freeSpinsAwarded) > 0) $("#result-detail").textContent += ` • +${spin.freeSpinsAwarded} FREE SPINS`;
  }

  async function claim() {
    setBusy(true);
    try {
      const transaction = await state.vault.claim();
      setStatus(`MATT claim submitted. ${txLink(transaction.hash)}`);
      await transaction.wait();
      setStatus("Your claimable MATT was sent to your wallet.", "good"); await refreshAll();
    } finally { setBusy(false); }
  }
  async function refundSelected() {
    if (state.selected?.type !== "paid") return;
    setBusy(true);
    try {
      const transaction = await state.slots.refundPaidSpins(state.selected.index, state.selected.remaining);
      setStatus(`Refund submitted for ${state.selected.remaining} unused spins. ${txLink(transaction.hash)}`);
      await transaction.wait(); setStatus("Unused spin credits returned at their original MATT value.", "good"); await refreshAll();
    } finally { setBusy(false); }
  }

  function practiceSpin() {
    if (state.busy) return;
    setBusy(true);
    const grid = randomPreviewGrid();
    const result = math.evaluateGrid(grid);
    animateToGrid(grid, result).then(() => {
      const wager = (() => { try { return betValue(); } catch { return ethers.parseEther(config.defaultBet); } })();
      const payout = wager * BigInt(result.multiplierBps) / BPS;
      $("#result-kicker").textContent = "PRACTICE • NO TOKENS MOVED";
      $("#result-title").textContent = payout > wager ? "PRACTICE WIN" : payout > 0n ? "PRACTICE RETURN" : "PRACTICE RESULT";
      $("#result-detail").textContent = `${formatMatt(payout)} simulated • ${formatMultiplier(result.multiplierBps)} • live results come only from Ronin VRF`;
      if (result.freeSpins) $("#result-detail").textContent += ` • would award ${result.freeSpins} free spins`;
    }).finally(() => setBusy(false));
  }

  async function loadHistory() {
    const body = $("#history-body");
    if (!state.account || !state.live) { body.innerHTML = `<tr><td colspan="7">${state.account ? "History becomes available after deployment." : "Connect a wallet to load spin history."}</td></tr>`; return; }
    let spinId = await state.readSlots.lastSpinOf(state.account);
    if (!spinId) { body.innerHTML = '<tr><td colspan="7">No completed or pending spins for this wallet.</td></tr>'; return; }
    const rows = [];
    for (let count = 0; spinId && count < 20; count += 1) {
      const spin = await state.readSlots.spins(spinId);
      const payout = BigInt(spin.payout);
      const wager = BigInt(spin.wager);
      const loss = BigInt(spin.treasuryLoss);
      const status = Number(spin.status);
      const hash = spin.requestHash;
      const isBonus = Number(spin.creditType) === CREDIT_BONUS;
      const netClass = isBonus ? (payout ? "net-positive" : "") : payout > wager ? "net-positive" : loss ? "net-negative" : "";
      const netText = isBonus ? (payout ? `+${formatMatt(payout, 0)}` : "—") : payout > wager ? `+${formatMatt(payout - wager, 0)}` : loss ? `−${formatMatt(loss, 0)}` : "EVEN";
      rows.push(`<tr><td>#${spinId}<br><small>${status === STATUS_SETTLED ? "SETTLED" : status === STATUS_PENDING ? "PENDING" : "RESTORED"}</small></td><td>${isBonus ? "FREE" : "PAID"}</td><td>${isBonus ? `${formatMatt(wager, 0)} basis` : formatMatt(wager, 0)}</td><td>${formatMatt(payout, 0)}</td><td class="${netClass}">${netText}</td><td>${Number(spin.freeSpinsAwarded) ? `+${spin.freeSpinsAwarded} free` : Number(spin.scatterCount) >= 3 ? `${spin.scatterCount} vaults` : "—"}</td><td>${hash && hash !== ethers.ZeroHash ? `<a href="${config.explorerBase}/address/${config.slotsAddress}#events" target="_blank" rel="noopener">verify ↗</a>` : "—"}</td></tr>`);
      spinId = BigInt(spin.previousPlayerSpinId);
    }
    body.innerHTML = rows.join("");
  }

  function bindEvents() {
    $("#wallet-button").addEventListener("click", () => connectWallet().catch(error => setStatus(errorMessage(error), "bad")));
    $("#buy-button").addEventListener("click", () => buySpins().catch(error => { setStatus(errorMessage(error), "bad"); setBusy(false); }));
    $("#spin-button").addEventListener("click", () => playSelected().catch(error => { $("#pending-screen").hidden = true; cycleReels(false); setStatus(errorMessage(error), "bad"); setBusy(false); }));
    $("#practice-button").addEventListener("click", practiceSpin);
    $("#claim-button").addEventListener("click", () => claim().catch(error => { setStatus(errorMessage(error), "bad"); setBusy(false); }));
    $("#refund-button").addEventListener("click", () => refundSelected().catch(error => { setStatus(errorMessage(error), "bad"); setBusy(false); }));
    $("#stale-refund-button").addEventListener("click", () => restoreStaleSpin().catch(error => { setStatus(errorMessage(error), "bad"); setBusy(false); }));
    $("#refresh-button").addEventListener("click", () => refreshAll().catch(error => setStatus(errorMessage(error), "bad")));
    $("#history-refresh").addEventListener("click", () => loadHistory().catch(error => setStatus(errorMessage(error), "bad")));
    $("#spin-quantity").addEventListener("input", updateSummary);
    $("#quantity-minus").addEventListener("click", () => { $("#spin-quantity").value = Math.max(1, Number($("#spin-quantity").value) - 1); updateSummary(); });
    $("#quantity-plus").addEventListener("click", () => { $("#spin-quantity").value = Math.min(25, Number($("#spin-quantity").value) + 1); updateSummary(); });
    $("#bet-input").addEventListener("input", updateSummary);
    $("#bet-input").addEventListener("blur", () => { try { clampBet(betValue()); } catch { clampBet(state.minBet); } });
    $("#bet-minus").addEventListener("click", () => { try { const current = betValue(); clampBet(current - betStep(current)); } catch { clampBet(state.minBet); } });
    $("#bet-plus").addEventListener("click", () => { try { const current = betValue(); clampBet(current + betStep(current)); } catch { clampBet(state.minBet); } });
    $$("#bet-presets button").forEach(button => button.addEventListener("click", () => clampBet(ethers.parseEther(button.dataset.bet))));
    $("#lines-button").addEventListener("click", event => { event.currentTarget.classList.toggle("active"); $("#payline-overlay").classList.toggle("show"); });
    $("#turbo-button").addEventListener("click", event => { state.turbo = !state.turbo; event.currentTarget.classList.toggle("active", state.turbo); });
    $("#sound-button").addEventListener("click", event => { state.sound = !state.sound; event.currentTarget.classList.toggle("active", state.sound); event.currentTarget.setAttribute("aria-pressed", String(state.sound)); event.currentTarget.firstChild.textContent = state.sound ? "🔊" : "🔇"; });
    window.addEventListener("resize", drawPaylines);
    const injected = walletProvider();
    injected?.on?.("accountsChanged", () => location.reload());
    injected?.on?.("chainChanged", () => location.reload());
  }

  async function start() {
    buildReels(); renderPaytable(); renderBonusRules(); bindEvents();
    $("#spin-quantity").value = String(config.defaultQuantity || 10);
    updateSummary();
    try { await initializeReads(); await connectWallet({ silent: true }); }
    catch (error) { setStatus(errorMessage(error), "bad"); }
    updateButtons();
  }
  start();
})();
