(() => {
  "use strict";

  const engine = window.MattPlinkoV2Engine;
  if (!engine) throw new Error("MATT Plinko V2 result engine did not load.");

  const CHAIN_ID = 2020;
  const CHAIN_HEX = "0x7e4";
  const RPC_URL = "https://api.roninchain.com/rpc";
  const MATT_ADDRESS = "0xa5450417BDCa0BDfB058ffE41205400FfDA1174d";
  // Deployment-safe placeholder. Set only after the V2 contract is independently verified.
  const PLINKO_V2_ADDRESS = "0x76c226908b7C1f075669d5448ADA135d73088307";
  const VRF_FEE_BUFFER_BPS = 12_500n;
  const TX_GAS_BUFFER_BPS = 12_000n;
  const BPS_SCALE = 10_000n;
  const MAX_BATCH_SIZE = 100;
  const RESULT_POLL_ATTEMPTS = 120;
  const RESULT_POLL_MS = 2_000;
  const RAPID_FIRE_INTERVAL_MS = 115;
  const REDUCED_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const PLINKO_ABI = [
    "event BatchRequested(bytes32 indexed requestHash,address indexed player,uint8 coinCount,uint256 wager)",
    "function purchaseBatch(uint8 coinCount) payable returns(bytes32)",
    "function quoteRandomFee() view returns(uint256)",
    "function batches(bytes32) view returns(address player,uint96 wager,uint64 openedAt,uint8 coinCount,uint8 status,uint256 payout,uint256 packedSlotsA,uint256 packedSlotsB)",
    "function batchSlots(bytes32) view returns(uint8[])",
    "function claimable(address) view returns(uint256)",
    "function unreservedBankroll() view returns(uint256)",
    "function paused() view returns(bool)",
    "function withdraw()"
  ];
  const TOKEN_ABI = [
    "function balanceOf(address) view returns(uint256)",
    "function allowance(address,address) view returns(uint256)",
    "function approve(address,uint256) returns(bool)"
  ];

  const state = {
    account: null,
    browserProvider: null,
    signer: null,
    contract: null,
    token: null,
    readProvider: null,
    readContract: null,
    quantity: 10,
    paused: true,
    purchasing: false,
    rapidFiring: false,
    requestHash: null,
    slots: [],
    nextIndex: 0,
    completed: 0,
    displayedReturn: 0,
    onchainClaimable: 0n,
    revealBase: 0n,
    revealBaseKnown: false,
    revealActive: false,
    practice: false,
    activeBalls: [],
    landedCoins: [],
    animationFrame: null,
    lastLandedSlot: null
  };

  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];
  const deployed = ethers.isAddress(PLINKO_V2_ADDRESS) && PLINKO_V2_ADDRESS !== ethers.ZeroAddress;
  const canvas = $("#plinko-board");
  const ctx = canvas.getContext("2d");
  const logo = new Image();
  logo.src = "/assets/matt-logo-512.png";

  function short(value) {
    return value ? `${value.slice(0, 6)}…${value.slice(-4)}` : "Not connected";
  }

  function formatMatt(value, precision = 0) {
    const number = typeof value === "bigint" ? Number(ethers.formatEther(value)) : Number(value);
    return number.toLocaleString(undefined, { maximumFractionDigits: precision });
  }

  function setStatus(message, type = "") {
    $("#game-status").textContent = message;
    $("#game-status").className = `status ${type}`.trim();
  }

  function errorMessage(error) {
    const revertData = error?.data || error?.info?.error?.data || error?.error?.data;
    if (typeof revertData === "string" && revertData.startsWith("0x025dbdd4")) {
      return "Ronin VRF cost changed while the batch was submitted. No MATT moved. Please retry.";
    }
    const message = error?.shortMessage || error?.reason || error?.message || "Transaction failed.";
    if (/insufficientbankroll/i.test(message)) return "The V2 bankroll cannot safely cover this batch. Try fewer coins.";
    if (/user rejected|user denied/i.test(message)) return "Transaction cancelled in Ronin Wallet.";
    return message;
  }

  function withBuffer(amount, basisPoints) {
    return (amount * basisPoints + BPS_SCALE - 1n) / BPS_SCALE;
  }

  function roninProvider() {
    const candidates = [
      window.ronin?.provider,
      window.ronin,
      ...(Array.isArray(window.ethereum?.providers) ? window.ethereum.providers : []),
      window.ethereum
    ];
    const provider = candidates.find(item => item?.request && (item.isRonin || item.isRoninWallet))
      || candidates.find(item => item?.request);
    if (!provider) throw new Error("Ronin Wallet was not detected. Install or unlock it, then refresh.");
    return provider;
  }

  async function ensureRonin(provider) {
    const current = String(await provider.request({ method: "eth_chainId" })).toLowerCase();
    if (current === CHAIN_HEX) return;
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN_HEX }] });
  }

  async function connectWallet() {
    const injected = roninProvider();
    const accounts = await injected.request({ method: "eth_requestAccounts" });
    if (!accounts?.[0]) throw new Error("Ronin Wallet did not return an account.");
    await ensureRonin(injected);

    state.browserProvider = new ethers.BrowserProvider(injected);
    state.signer = await state.browserProvider.getSigner();
    state.account = await state.signer.getAddress();
    state.token = new ethers.Contract(MATT_ADDRESS, TOKEN_ABI, state.signer);
    if (deployed) state.contract = new ethers.Contract(PLINKO_V2_ADDRESS, PLINKO_ABI, state.signer);

    $("#wallet-button").textContent = short(state.account);
    $("#wallet-address").textContent = state.account;
    restoreSavedRevealState();
    await refreshAccount();
    await resumeSavedBatch();
    updateControls();
  }

  async function refreshAccount() {
    if (!state.account || !state.token) return;
    const balance = await state.token.balanceOf(state.account);
    let claimable = 0n;
    let bankroll = 0n;
    if (state.contract) {
      claimable = await state.contract.claimable(state.account);
      bankroll = await state.contract.unreservedBankroll();
    }
    state.onchainClaimable = claimable;
    $("#matt-balance").textContent = `${formatMatt(balance)} MATT`;
    renderClaimable();
    $("#bankroll-balance").textContent = deployed ? `${formatMatt(bankroll)} MATT` : "V2 PENDING";
    updateWithdrawControl();
  }

  function updateWithdrawControl() {
    $("#withdraw-button").disabled = !state.contract
      || state.onchainClaimable === 0n
      || state.purchasing
      || state.revealActive
      || state.activeBalls.length > 0;
  }

  function renderClaimable() {
    if (!deployed) {
      $("#claimable-balance").textContent = "V2 PENDING";
      return;
    }
    const visible = state.revealActive && !state.practice
      ? engine.revealedClaimableWei(state.revealBase, state.displayedReturn)
      : state.onchainClaimable;
    $("#claimable-balance").textContent = `${formatMatt(visible)} MATT`;
  }

  async function initContract() {
    sizeCanvas();
    drawBoard();
    updatePurchaseSummary();
    updateControls();
    if (!deployed) return;

    state.readProvider = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID);
    state.readContract = new ethers.Contract(PLINKO_V2_ADDRESS, PLINKO_ABI, state.readProvider);
    if (await state.readProvider.getCode(PLINKO_V2_ADDRESS) === "0x") {
      throw new Error("No V2 contract exists at the configured address.");
    }
    state.paused = await state.readContract.paused();
    $("#mode-pill").textContent = state.paused ? "V2 PAUSED" : "LIVE ON RONIN";
    $("#contract-link").href = `https://app.roninchain.com/address/${PLINKO_V2_ADDRESS}`;
    $("#contract-link").textContent = "VERIFY V2 CONTRACT";
    $("#contract-link").removeAttribute("aria-disabled");
    updateControls();
  }

  function selectedTotal() {
    return state.quantity * engine.COIN_PRICE;
  }

  function setQuantity(value) {
    if (state.purchasing || hasInventory()) return;
    const quantity = Math.max(1, Math.min(MAX_BATCH_SIZE, Number.parseInt(value, 10) || 1));
    state.quantity = quantity;
    $("#coin-count").value = String(quantity);
    $("#coin-count-output").textContent = String(quantity);
    $$("[data-count]").forEach(button => {
      button.classList.toggle("active", Number(button.dataset.count) === quantity);
    });
    updatePurchaseSummary();
  }

  function updatePurchaseSummary() {
    $("#purchase-total").textContent = `${selectedTotal().toLocaleString()} MATT`;
    $("#max-batch-payout").textContent = `${(selectedTotal() * 200).toLocaleString()} MATT`;
    $("#practice-button").textContent = `PREVIEW ${state.quantity} COIN${state.quantity === 1 ? "" : "S"}`;
  }

  function hasInventory() {
    return state.nextIndex < state.slots.length;
  }

  function updateInventory() {
    const remaining = Math.max(0, state.slots.length - state.nextIndex);
    $("#coins-remaining").textContent = String(remaining);
    $("#batch-return").textContent = `${state.displayedReturn.toLocaleString()} MATT`;
    renderClaimable();
    $("#inventory-pill").textContent = `${remaining} COIN${remaining === 1 ? "" : "S"} LOADED`;
    $("#inventory-pill").classList.toggle("ready", remaining > 0);
    if (!remaining && state.slots.length) {
      $("#drop-overlay").textContent = `${state.slots.length} COINS COMPLETE`;
    }
  }

  function updateControls() {
    const inventory = hasInventory();
    const animationCapacity = state.activeBalls.length < 24;
    const canDrop = inventory && !state.purchasing && animationCapacity;
    $("#purchase-button").disabled = !deployed || !state.account || state.paused || state.purchasing || inventory;
    $("#purchase-button").textContent = !deployed
      ? "V2 CONTRACT DEPLOYMENT PENDING"
      : state.paused
        ? "V2 IS PAUSED"
        : state.purchasing
          ? "LOADING MATT COINS…"
          : `BUY ${state.quantity} COIN${state.quantity === 1 ? "" : "S"} • ${selectedTotal().toLocaleString()} MATT`;
    $("#drop-one-button").disabled = !canDrop || state.rapidFiring;
    $("#canvas-drop-button").disabled = !canDrop || state.rapidFiring;
    $("#rapid-fire-button").disabled = !canDrop || state.rapidFiring;
    $("#rapid-fire-button").textContent = state.rapidFiring ? "RAPID FIRING…" : "RAPID FIRE ALL";
    $("#practice-button").disabled = state.purchasing || inventory;
    $("#coin-count").disabled = state.purchasing || inventory;
    $$("[data-count]").forEach(button => { button.disabled = state.purchasing || inventory; });
    updateInventory();
    updateWithdrawControl();
  }

  async function waitForAllowance(amount) {
    const readToken = new ethers.Contract(MATT_ADDRESS, TOKEN_ABI, state.readProvider);
    for (let attempt = 0; attempt < 12; attempt += 1) {
      if (await readToken.allowance(state.account, PLINKO_V2_ADDRESS) >= amount) return;
      await delay(1_000);
    }
    throw new Error("The approval is confirmed, but Ronin RPC has not updated yet. Wait a few seconds and retry.");
  }

  async function purchaseBatch() {
    if (!state.account || !state.contract || !state.token) throw new Error("Connect Ronin Wallet first.");
    if (hasInventory()) throw new Error("Drop the loaded coins before purchasing another batch.");

    state.requestHash = null;
    state.slots = [];
    state.nextIndex = 0;
    state.completed = 0;
    state.displayedReturn = 0;
    state.revealBase = await state.contract.claimable(state.account);
    state.onchainClaimable = state.revealBase;
    state.revealBaseKnown = true;
    state.revealActive = true;
    state.practice = false;
    state.landedCoins = [];
    state.purchasing = true;
    updateControls();
    try {
      const amount = ethers.parseEther(String(selectedTotal()));
      const allowance = await state.token.allowance(state.account, PLINKO_V2_ADDRESS);
      if (allowance < amount) {
        setStatus(`Approve exactly ${selectedTotal().toLocaleString()} MATT for this batch.`);
        const approval = await state.token.approve(PLINKO_V2_ADDRESS, amount);
        await approval.wait(1);
        await waitForAllowance(amount);
      }

      const quote = await state.readContract.quoteRandomFee();
      const fee = withBuffer(quote, VRF_FEE_BUFFER_BPS);
      const estimatedGas = await state.readContract.purchaseBatch.estimateGas(state.quantity, {
        from: state.account,
        value: fee
      });
      const gasLimit = withBuffer(estimatedGas, TX_GAS_BUFFER_BPS);
      setStatus(`Confirm ${state.quantity} Plinko coins and one refundable VRF fee in Ronin Wallet.`);
      const transaction = await state.contract.purchaseBatch(state.quantity, { value: fee, gasLimit });
      setStatus(`Batch submitted. Waiting for Ronin VRF… ${short(transaction.hash)}`);
      const receipt = await transaction.wait(1);
      const event = receipt.logs
        .map(log => {
          try { return state.contract.interface.parseLog(log); } catch { return null; }
        })
        .find(log => log?.name === "BatchRequested");
      if (!event) throw new Error("BatchRequested event was not found.");

      state.requestHash = event.args.requestHash;
      saveBatchState();
      await waitForBatch(state.requestHash);
    } catch (error) {
      if (!state.requestHash) {
        state.revealActive = false;
        state.revealBaseKnown = false;
      }
      throw error;
    } finally {
      state.purchasing = false;
      updateControls();
      await refreshAccount().catch(() => {});
    }
  }

  async function waitForBatch(requestHash) {
    const contract = state.contract || state.readContract;
    for (let attempt = 0; attempt < RESULT_POLL_ATTEMPTS; attempt += 1) {
      const batch = await contract.batches(requestHash);
      if (Number(batch.status) === 2) {
        const slots = [...await contract.batchSlots(requestHash)].map(Number);
        if (slots.some(slot => slot < 0 || slot >= engine.SLOT_COUNT)) {
          throw new Error("The contract returned an invalid V2 slot.");
        }
        state.requestHash = requestHash;
        state.slots = slots;
        state.practice = false;
        state.nextIndex = Math.min(state.nextIndex, slots.length);
        state.completed = Math.min(state.completed, state.nextIndex);
        if (!state.revealBaseKnown && state.account) {
          const claimable = await contract.claimable(state.account);
          const payout = BigInt(batch.payout);
          state.onchainClaimable = claimable;
          state.revealBase = claimable >= payout ? claimable - payout : 0n;
          state.revealBaseKnown = true;
        }
        state.revealActive = true;
        state.purchasing = false;
        setStatus(`VRF verified. Dropping ${slots.length} MATT coins now…`, "good");
        saveBatchState();
        updateControls();
        await rapidFire();
        return;
      }
      if (Number(batch.status) === 3) {
        clearBatchState();
        throw new Error("This batch was refunded because VRF did not settle in time.");
      }
      await delay(RESULT_POLL_MS);
    }
    throw new Error("Ronin VRF is still processing. This batch is saved and will resume after refresh.");
  }

  function storageKey() {
    return state.account ? `mattPlinkoV2:${state.account.toLowerCase()}` : null;
  }

  function saveBatchState() {
    const key = storageKey();
    if (!key || state.practice) return;
    localStorage.setItem(key, JSON.stringify({
      requestHash: state.requestHash,
      // Persist only visibly completed balls. A ball interrupted in motion is
      // replayed after refresh instead of being skipped.
      nextIndex: state.completed,
      completed: state.completed,
      displayedReturn: state.displayedReturn,
      revealBase: state.revealBase.toString(),
      revealBaseKnown: state.revealBaseKnown
    }));
  }

  function clearBatchState() {
    const key = storageKey();
    if (key) localStorage.removeItem(key);
    state.requestHash = null;
    state.slots = [];
    state.nextIndex = 0;
    state.completed = 0;
    state.displayedReturn = 0;
    state.revealBase = 0n;
    state.revealBaseKnown = false;
    state.revealActive = false;
    state.practice = false;
    state.landedCoins = [];
    updateControls();
  }

  async function resumeSavedBatch() {
    if (!deployed || !state.account || !state.readContract) return;
    const key = storageKey();
    let saved;
    try { saved = JSON.parse(localStorage.getItem(key)); } catch { saved = null; }
    if (!saved?.requestHash) return;

    setStatus("Restoring your saved V2 batch…");
    await waitForBatch(saved.requestHash);
  }

  function restoreSavedRevealState() {
    const key = storageKey();
    let saved;
    try { saved = JSON.parse(localStorage.getItem(key)); } catch { saved = null; }
    if (!saved?.requestHash) return;
    state.requestHash = saved.requestHash;
    state.nextIndex = Number(saved.nextIndex) || 0;
    state.completed = Number(saved.completed) || 0;
    state.displayedReturn = Number(saved.displayedReturn) || 0;
    state.revealActive = true;
    if (saved.revealBase !== undefined && saved.revealBase !== null) {
      try {
        state.revealBase = BigInt(saved.revealBase);
        state.revealBaseKnown = saved.revealBaseKnown !== false;
      } catch {
        state.revealBase = 0n;
        state.revealBaseKnown = false;
      }
    }
  }

  function practiceSlots(count) {
    const random = new Uint16Array(count);
    crypto.getRandomValues(random);
    return [...random].map(value => {
      let slot = 0;
      for (let row = 0; row < engine.ROWS; row += 1) slot += (value >> row) & 1;
      return slot;
    });
  }

  function loadPracticeBatch() {
    if (hasInventory()) return;
    state.requestHash = `practice-${Date.now()}`;
    state.slots = practiceSlots(state.quantity);
    state.nextIndex = 0;
    state.completed = 0;
    state.displayedReturn = 0;
    state.revealActive = false;
    state.practice = true;
    state.landedCoins = [];
    setStatus(`${state.quantity} preview coins loaded. No MATT will move.`);
    updateControls();
  }

  function launchOne() {
    if (!hasInventory() || state.activeBalls.length >= 24) return null;
    const index = state.nextIndex;
    const slot = state.slots[index];
    const requestKey = `${state.requestHash}:${index}`;
    state.nextIndex += 1;
    updateControls();
    saveBatchState();

    const animation = animateCoin(slot, requestKey, index);
    animation.then(() => completeCoin(slot, index)).catch(error => setStatus(errorMessage(error), "error"));
    return animation;
  }

  async function rapidFire() {
    if (!hasInventory() || state.rapidFiring) return;
    state.rapidFiring = true;
    setStatus("Rapid fire active. Every ball remains locked to its paid slot.");
    updateControls();
    try {
      while (hasInventory()) {
        if (state.activeBalls.length >= 20) {
          await delay(80);
          continue;
        }
        launchOne();
        await delay(RAPID_FIRE_INTERVAL_MS);
      }
      while (state.activeBalls.length) await delay(80);
    } finally {
      state.rapidFiring = false;
      updateControls();
    }
  }

  function completeCoin(slot, index) {
    const multiplier = engine.multiplierForSlot(slot);
    const payout = engine.payoutForSlot(slot);
    state.completed = Math.max(state.completed, index + 1);
    state.displayedReturn += payout;
    state.lastLandedSlot = slot;
    state.landedCoins.push({ slot, order: state.landedCoins.length });
    if (state.landedCoins.length > 40) state.landedCoins.shift();
    $("#drop-overlay").textContent = `${multiplier}× • ${payout.toLocaleString()} MATT`;
    $("#drop-overlay").className = `drop-overlay ${multiplier >= 1 ? "win" : "loss"}`;
    setStatus(
      `${multiplier}× landed exactly in slot ${slot + 1}. ${Math.max(0, state.slots.length - state.nextIndex)} coins remain.`,
      multiplier >= 1 ? "good" : ""
    );
    saveBatchState();
    updateControls();
    drawBoard();

    if (!hasInventory() && state.activeBalls.length === 0) {
      setStatus(
        `Batch complete: ${state.displayedReturn.toLocaleString()} MATT total return across ${state.slots.length} coins.`,
        "good"
      );
      if (!state.practice) localStorage.removeItem(storageKey());
      if (!state.practice) {
        refreshAccount()
          .then(() => {
            state.revealActive = false;
            state.revealBaseKnown = false;
            renderClaimable();
            updateControls();
          })
          .catch(() => {});
      }
    }
  }

  async function withdraw() {
    if (!state.contract) throw new Error("Connect Ronin Wallet first.");
    state.purchasing = true;
    updateControls();
    try {
      setStatus("Confirm the V2 winnings withdrawal in Ronin Wallet.");
      const transaction = await state.contract.withdraw();
      await transaction.wait(1);
      setStatus("Your V2 Plinko winnings were sent to your wallet.", "good");
      await refreshAccount();
    } finally {
      state.purchasing = false;
      updateControls();
    }
  }

  function geometry() {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const top = 68;
    const landingY = height - 31;
    const rowGap = (landingY - top - 45) / engine.ROWS;
    const slotGap = (width - 30) / engine.SLOT_COUNT;
    return { width, height, top, landingY, rowGap, slotGap, center: width / 2 };
  }

  function sizeCanvas() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(300, Math.round(canvas.clientWidth));
    const height = Math.max(500, Math.round(canvas.clientHeight));
    if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
  }

  function drawBoard() {
    sizeCanvas();
    const g = geometry();
    ctx.clearRect(0, 0, g.width, g.height);

    const zoneTop = g.landingY - 17;
    for (let slot = 0; slot < engine.SLOT_COUNT; slot += 1) {
      const x = g.center + engine.slotOffset(slot) * g.slotGap;
      const multiplier = engine.multiplierForSlot(slot);
      ctx.fillStyle = multiplier >= 100 ? "#c76d0c55" : multiplier < 1 ? "#711f1955" : "#5c451b44";
      ctx.fillRect(x - g.slotGap / 2 + 1, zoneTop, g.slotGap - 2, g.height - zoneTop);
      if (slot === state.lastLandedSlot) {
        ctx.fillStyle = "#ffc92866";
        ctx.fillRect(x - g.slotGap / 2 + 1, zoneTop, g.slotGap - 2, g.height - zoneTop);
      }
    }

    for (let row = 0; row < engine.ROWS; row += 1) {
      const count = row + 1;
      const y = g.top + row * g.rowGap;
      for (let peg = 0; peg < count; peg += 1) {
        const x = g.center + (peg - (count - 1) / 2) * g.slotGap;
        ctx.beginPath();
        ctx.arc(x, y, Math.max(2.5, Math.min(4.2, g.slotGap * 0.105)), 0, Math.PI * 2);
        ctx.fillStyle = row % 2 ? "#e0bd58" : "#fff0b3";
        ctx.shadowColor = "#ffc928";
        ctx.shadowBlur = 8;
        ctx.fill();
        ctx.shadowBlur = 0;
      }
    }

    for (let boundary = 0; boundary <= engine.SLOT_COUNT; boundary += 1) {
      const x = g.center + (boundary - 8.5) * g.slotGap;
      ctx.beginPath();
      ctx.moveTo(x, zoneTop - 7);
      ctx.lineTo(x, g.height);
      ctx.strokeStyle = "#705526";
      ctx.lineWidth = 1.4;
      ctx.stroke();
    }

    drawLandedCoins(g);
  }

  function drawLandedCoins(g) {
    const perSlot = new Map();
    for (const coin of state.landedCoins) {
      const stack = perSlot.get(coin.slot) || 0;
      perSlot.set(coin.slot, stack + 1);
      const x = g.center + engine.slotOffset(coin.slot) * g.slotGap;
      const y = g.landingY - Math.min(stack, 4) * 5;
      drawMattCoin(x, y, Math.max(5, Math.min(11, g.slotGap * 0.28)), 0, 1, 1, 0.82);
    }
  }

  function drawMattCoin(x, y, radius, rotation = 0, scaleX = 1, scaleY = 1, alpha = 1) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(x, y);
    ctx.rotate(rotation);
    ctx.scale(scaleX, scaleY);
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, Math.PI * 2);
    ctx.clip();
    if (logo.complete) {
      ctx.drawImage(logo, -radius, -radius, radius * 2, radius * 2);
    } else {
      ctx.fillStyle = "#ffc928";
      ctx.fillRect(-radius, -radius, radius * 2, radius * 2);
    }
    ctx.restore();

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(x, y);
    ctx.rotate(rotation);
    ctx.scale(scaleX, scaleY);
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, Math.PI * 2);
    ctx.strokeStyle = "#fff2a8";
    ctx.lineWidth = Math.max(1.5, radius * 0.18);
    ctx.shadowColor = "#ff9d00";
    ctx.shadowBlur = 15;
    ctx.stroke();
    ctx.restore();
  }

  function animateCoin(slot, key, index) {
    const g = geometry();
    const path = engine.pathForSlot(slot, key, g);
    if (engine.slotForSteps(path.steps) !== slot) {
      return Promise.reject(new Error("Visual path validation failed before animation."));
    }

    return new Promise(resolve => {
      const ball = {
        slot,
        index,
        path,
        startedAt: performance.now(),
        // Equal durations preserve completion order during rapid fire. The
        // key-derived left/right sequence still makes every path look unique.
        duration: REDUCED_MOTION ? 140 : 1800,
        resolve
      };
      state.activeBalls.push(ball);
      $("#drop-overlay").textContent = `COIN ${index + 1} IN MOTION`;
      $("#drop-overlay").className = "drop-overlay";
      ensureAnimationLoop();
    });
  }

  function ballFrame(ball, now) {
    // A queued animation frame can carry a timestamp from just before a
    // rapid-fire ball was created. Clamp that negative progress so it samples
    // the first path segment instead of indexing points[-1].
    const pathFrame = engine.pathFrame(
      ball.path.points,
      (now - ball.startedAt) / ball.duration
    );
    const { progress, segment, local, from, to } = pathFrame;
    const eased = local * local * (3 - 2 * local);
    const bounce = segment < engine.ROWS
      ? Math.sin(local * Math.PI) * (5 + (engine.hash32(`${ball.index}:${segment}`) % 5))
      : Math.sin(local * Math.PI) * 3;
    const x = from.x + (to.x - from.x) * eased;
    const y = from.y + (to.y - from.y) * local - bounce;
    const impact = Math.max(0, (local - 0.78) / 0.22);
    const squash = Math.sin(impact * Math.PI) * 0.16;
    return {
      done: progress >= 1,
      x: progress >= 1 ? ball.path.points.at(-1).x : x,
      y: progress >= 1 ? ball.path.points.at(-1).y : y,
      rotation: progress * Math.PI * (4 + (ball.index % 5)),
      scaleX: 1 + squash,
      scaleY: 1 - squash,
      radius: Math.max(7, Math.min(14, geometry().slotGap * 0.34))
    };
  }

  function ensureAnimationLoop() {
    if (state.animationFrame) return;
    const frame = now => {
      state.animationFrame = null;
      drawBoard();
      const completed = [];
      for (const ball of state.activeBalls) {
        const sample = ballFrame(ball, now);
        drawMattCoin(sample.x, sample.y, sample.radius, sample.rotation, sample.scaleX, sample.scaleY);
        if (sample.done) completed.push(ball);
      }
      if (completed.length) {
        state.activeBalls = state.activeBalls.filter(ball => !completed.includes(ball));
        for (const ball of completed) ball.resolve();
      }
      if (state.activeBalls.length) state.animationFrame = requestAnimationFrame(frame);
      else drawBoard();
      updateControls();
    };
    state.animationFrame = requestAnimationFrame(frame);
  }

  function delay(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
  }

  async function act(action) {
    try {
      await action();
    } catch (error) {
      state.purchasing = false;
      state.rapidFiring = false;
      updateControls();
      setStatus(errorMessage(error), "error");
    }
  }

  $("#coin-count").addEventListener("input", event => setQuantity(event.target.value));
  $$("[data-count]").forEach(button => button.addEventListener("click", () => setQuantity(button.dataset.count)));
  $("#wallet-button").addEventListener("click", () => act(connectWallet));
  $("#purchase-button").addEventListener("click", () => act(purchaseBatch));
  $("#drop-one-button").addEventListener("click", launchOne);
  $("#canvas-drop-button").addEventListener("click", event => { event.stopPropagation(); launchOne(); });
  $("#canvas-wrap").addEventListener("click", event => {
    if (event.target.closest("button")) return;
    launchOne();
  });
  $("#canvas-wrap").addEventListener("keydown", event => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      launchOne();
    }
  });
  $("#rapid-fire-button").addEventListener("click", () => act(rapidFire));
  $("#practice-button").addEventListener("click", loadPracticeBatch);
  $("#withdraw-button").addEventListener("click", () => act(withdraw));
  window.addEventListener("resize", () => drawBoard());
  logo.addEventListener("load", () => drawBoard());

  const injected = [window.ronin?.provider, window.ronin, window.ethereum].find(item => item?.on);
  injected?.on?.("accountsChanged", () => location.reload());
  injected?.on?.("chainChanged", () => location.reload());

  setQuantity(10);
  initContract().catch(error => setStatus(errorMessage(error), "error"));
})();
