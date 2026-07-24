(() => {
  "use strict";

  const CHAIN_ID = 2020;
  const CHAIN_HEX = "0x7e4";
  const RPC_URL = "https://api.roninchain.com/rpc";
  const MATT_ADDRESS = "0xa5450417BDCa0BDfB058ffE41205400FfDA1174d";
  const PLINKO_ADDRESS = "0xFAefDD57E2C04EdEc6e33fA006702DaB5E194Cb2";
  const VRF_FEE_BUFFER_BPS = 12_500n;
  const BPS_SCALE = 10_000n;
  const TX_GAS_BUFFER_BPS = 12_000n;
  const BETS = [10000, 25000, 50000, 75000, 100000];
  const MULTIPLIERS = [20, 8, 3, 1.5, 0.25, 0.25, 0.25, 1.5, 3, 8, 20];
  const PLINKO_ABI = [
    "event DropRequested(bytes32 indexed requestHash,address indexed player,uint256 amount)",
    "function play(uint256 amount) payable returns(bytes32)",
    "function quoteRandomFee() view returns(uint256)",
    "function drops(bytes32) view returns(address player,uint128 amount,uint64 openedAt,uint16 multiplier,uint8 slot,bool settled)",
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
    bet: 100000,
    paused: true,
    busy: false,
    animation: null,
    lastResult: null
  };

  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];
  const deployed = ethers.isAddress(PLINKO_ADDRESS) && PLINKO_ADDRESS !== ethers.ZeroAddress;
  const canvas = $("#plinko-board");
  const ctx = canvas.getContext("2d");
  const logo = new Image();
  logo.src = "/assets/matt-logo-512.png";

  function short(address) {
    return address ? `${address.slice(0, 6)}…${address.slice(-4)}` : "Not connected";
  }

  function tokens(raw, precision = 0) {
    return Number(ethers.formatEther(raw)).toLocaleString(undefined, { maximumFractionDigits: precision });
  }

  function setStatus(message, type = "") {
    $("#game-status").textContent = message;
    $("#game-status").className = `status ${type}`.trim();
  }

  function errorMessage(error) {
    const revertData = error?.data || error?.info?.error?.data || error?.error?.data;
    if (typeof revertData === "string" && revertData.startsWith("0x025dbdd4")) {
      return "Ronin VRF fee changed before the drop was submitted. Please try again.";
    }
    return error?.shortMessage || error?.reason || error?.message || "Transaction failed.";
  }

  function withBuffer(amount, basisPoints) {
    return (amount * basisPoints + BPS_SCALE - 1n) / BPS_SCALE;
  }

  async function waitForAllowance(amount) {
    const readToken = new ethers.Contract(MATT_ADDRESS, TOKEN_ABI, state.readProvider);
    for (let attempt = 0; attempt < 12; attempt += 1) {
      if (await readToken.allowance(state.account, PLINKO_ADDRESS) >= amount) return;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    throw new Error("MATT approval is confirmed but Ronin RPC has not updated yet. Please wait a few seconds and try Drop again.");
  }

  function roninProvider() {
    const candidates = [
      window.ronin?.provider,
      window.ronin,
      ...(Array.isArray(window.ethereum?.providers) ? window.ethereum.providers : []),
      window.ethereum
    ];
    const provider = candidates.find(item => item && typeof item.request === "function" && (item.isRonin || item.isRoninWallet))
      || candidates.find(item => item && typeof item.request === "function");
    if (!provider) throw new Error("Ronin Wallet was not detected. Install or unlock Ronin Wallet, then refresh.");
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
    if (deployed) state.contract = new ethers.Contract(PLINKO_ADDRESS, PLINKO_ABI, state.signer);
    $("#wallet-button").textContent = short(state.account);
    $("#wallet-address").textContent = state.account;
    await refreshAccount();
    updateButtons();
  }

  async function refreshAccount() {
    if (!state.account || !state.token) return;
    const reads = [state.token.balanceOf(state.account)];
    if (state.contract) {
      reads.push(state.contract.claimable(state.account), state.contract.unreservedBankroll());
    }
    const [balance, claimable = 0n, bankroll = 0n] = await Promise.all(reads);
    $("#matt-balance").textContent = `${tokens(balance)} MATT`;
    $("#claimable-balance").textContent = `${tokens(claimable)} MATT`;
    $("#bankroll-balance").textContent = deployed ? `${tokens(bankroll)} MATT` : "DEPLOYMENT PENDING";
    $("#withdraw-button").disabled = !state.contract || claimable === 0n || state.busy;
  }

  async function initContract() {
    drawBoard();
    if (!deployed) {
      $("#mode-pill").textContent = "PRACTICE PREVIEW";
      return;
    }
    state.readProvider = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID);
    state.readContract = new ethers.Contract(PLINKO_ADDRESS, PLINKO_ABI, state.readProvider);
    const code = await state.readProvider.getCode(PLINKO_ADDRESS);
    if (code === "0x") throw new Error("No Plinko contract was found at the configured address.");
    state.paused = await state.readContract.paused();
    $("#mode-pill").textContent = state.paused ? "CONTRACT PAUSED" : "LIVE ON RONIN";
    $("#contract-link").href = `https://explorer.roninchain.com/address/${PLINKO_ADDRESS}`;
    $("#contract-link").textContent = "VERIFY PLINKO CONTRACT";
    $("#contract-link").removeAttribute("aria-disabled");
    updateButtons();
  }

  function updateButtons() {
    const drop = $("#drop-button");
    if (!deployed) {
      drop.disabled = true;
      drop.textContent = "CONTRACT DEPLOYMENT PENDING";
      return;
    }
    drop.disabled = !state.account || state.paused || state.busy;
    drop.textContent = state.paused ? "PLINKO IS PAUSED" : state.busy ? "DROP IN PROGRESS…" : `DROP ${state.bet.toLocaleString()} MATT`;
    $("#practice-button").disabled = state.busy;
  }

  function selectBet(amount) {
    if (!BETS.includes(amount) || state.busy) return;
    state.bet = amount;
    $$("[data-bet]").forEach(button => button.classList.toggle("active", Number(button.dataset.bet) === amount));
    $("#payout-preview").textContent = `${(amount * 20).toLocaleString()} MATT`;
    updateButtons();
  }

  async function play() {
    if (!state.account || !state.contract || !state.token) throw new Error("Connect Ronin Wallet first.");
    state.busy = true;
    updateButtons();
    try {
      const amount = ethers.parseEther(String(state.bet));
      const allowance = await state.token.allowance(state.account, PLINKO_ADDRESS);
      if (allowance < amount) {
        setStatus(`Approve exactly ${state.bet.toLocaleString()} MATT for this drop.`);
        const approval = await state.token.approve(PLINKO_ADDRESS, amount);
        await approval.wait(1);
        await waitForAllowance(amount);
      }

      const quotedFee = await state.readContract.quoteRandomFee();
      // Ronin estimates the transaction against its pending block, whose VRF
      // fee can be higher than the latest-block quote. Excess RON is refunded
      // by the coordinator to the connected player.
      const fee = withBuffer(quotedFee, VRF_FEE_BUFFER_BPS);
      const estimatedGas = await state.readContract.play.estimateGas(amount, {
        from: state.account,
        value: fee
      });
      const gasLimit = withBuffer(estimatedGas, TX_GAS_BUFFER_BPS);
      setStatus("Confirm the MATT drop and refundable Ronin VRF fee in your wallet.");
      const tx = await state.contract.play(amount, { value: fee, gasLimit });
      setStatus(`Drop submitted. Waiting for Ronin VRF… ${short(tx.hash)}`);
      const receipt = await tx.wait(1);
      const event = receipt.logs
        .map(log => { try { return state.contract.interface.parseLog(log); } catch { return null; } })
        .find(log => log?.name === "DropRequested");
      if (!event) throw new Error("DropRequested event was not found.");
      const requestHash = event.args.requestHash;
      localStorage.setItem("mattPlinkoPending", requestHash);
      await waitForResult(requestHash);
    } finally {
      state.busy = false;
      updateButtons();
      await refreshAccount().catch(() => {});
    }
  }

  async function waitForResult(requestHash) {
    const contract = state.contract || state.readContract;
    for (let attempt = 0; attempt < 90; attempt += 1) {
      const drop = await contract.drops(requestHash);
      if (drop.settled) {
        localStorage.removeItem("mattPlinkoPending");
        const slot = Number(drop.slot);
        const multiplier = Number(drop.multiplier) / 100;
        await animateDrop(slot, requestHash);
        const payout = Number(ethers.formatEther(drop.amount)) * multiplier;
        state.lastResult = { slot, multiplier };
        setStatus(
          multiplier >= 1
            ? `${multiplier}× HIT! ${payout.toLocaleString()} MATT is ready to withdraw.`
            : `Center drop: ${multiplier}× returned ${payout.toLocaleString()} MATT.`,
          multiplier >= 1 ? "good" : ""
        );
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    throw new Error("Ronin VRF is still processing. Your request is saved and can be checked after refresh.");
  }

  async function resumePending() {
    if (!deployed) return;
    const requestHash = localStorage.getItem("mattPlinkoPending");
    if (!requestHash) return;
    setStatus("Checking your pending Ronin VRF drop…");
    state.busy = true;
    updateButtons();
    try {
      await waitForResult(requestHash);
    } catch (error) {
      setStatus(errorMessage(error), "error");
    } finally {
      state.busy = false;
      updateButtons();
    }
  }

  async function withdraw() {
    if (!state.contract) throw new Error("Connect Ronin Wallet first.");
    state.busy = true;
    updateButtons();
    try {
      setStatus("Confirm the MATT withdrawal in Ronin Wallet.");
      const tx = await state.contract.withdraw();
      await tx.wait(1);
      setStatus("Your Plinko winnings have been sent to your wallet.", "good");
      await refreshAccount();
    } finally {
      state.busy = false;
      updateButtons();
    }
  }

  function randomPracticeSlot() {
    const bits = new Uint16Array(1);
    crypto.getRandomValues(bits);
    let slot = 0;
    for (let row = 0; row < 10; row++) slot += (bits[0] >> row) & 1;
    return slot;
  }

  async function practice() {
    if (state.busy) return;
    state.busy = true;
    updateButtons();
    try {
      const slot = randomPracticeSlot();
      await animateDrop(slot, `practice-${Date.now()}`);
      const multiplier = MULTIPLIERS[slot];
      const payout = state.bet * multiplier;
      setStatus(`Practice result: ${multiplier}× • ${payout.toLocaleString()} MATT preview. No tokens moved.`);
    } finally {
      state.busy = false;
      updateButtons();
    }
  }

  function boardGeometry() {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const top = 82;
    const bottom = height - 62;
    const rowGap = (bottom - top) / 10;
    const slotGap = Math.min((width - 44) / 11, 68);
    return { width, height, top, bottom, rowGap, slotGap, center: width / 2 };
  }

  function sizeCanvas() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(300, Math.round(canvas.clientWidth));
    const height = Math.max(420, Math.round(canvas.clientHeight));
    if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
  }

  function drawBoard(ball = null) {
    sizeCanvas();
    const g = boardGeometry();
    ctx.clearRect(0, 0, g.width, g.height);

    for (let row = 0; row < 10; row++) {
      const count = row + 1;
      const y = g.top + row * g.rowGap;
      for (let peg = 0; peg < count; peg++) {
        const x = g.center + (peg - (count - 1) / 2) * g.slotGap;
        ctx.beginPath();
        ctx.arc(x, y, 4.6, 0, Math.PI * 2);
        ctx.fillStyle = row % 2 ? "#d7b557" : "#fff0b3";
        ctx.shadowColor = "#ffc928";
        ctx.shadowBlur = 9;
        ctx.fill();
        ctx.shadowBlur = 0;
      }
    }

    const startX = g.center - 5.5 * g.slotGap;
    for (let slot = 0; slot <= 11; slot++) {
      const x = startX + slot * g.slotGap;
      ctx.beginPath();
      ctx.moveTo(x, g.bottom - 8);
      ctx.lineTo(x, g.height - 9);
      ctx.strokeStyle = "#60491f";
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    if (ball) drawMattCoin(ball.x, ball.y, ball.radius || 17);
  }

  function drawMattCoin(x, y, radius) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.clip();
    if (logo.complete) ctx.drawImage(logo, x - radius, y - radius, radius * 2, radius * 2);
    else {
      ctx.fillStyle = "#ffc928";
      ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
    }
    ctx.restore();
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.strokeStyle = "#fff2a8";
    ctx.lineWidth = 3;
    ctx.shadowColor = "#ff9d00";
    ctx.shadowBlur = 18;
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  function seededSteps(slot, key) {
    const steps = Array(slot).fill(1).concat(Array(10 - slot).fill(-1));
    let hash = 2166136261;
    for (const character of key) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
    for (let i = steps.length - 1; i > 0; i--) {
      hash ^= hash << 13; hash ^= hash >>> 17; hash ^= hash << 5;
      const j = Math.abs(hash) % (i + 1);
      [steps[i], steps[j]] = [steps[j], steps[i]];
    }
    return steps;
  }

  function tween(from, to, duration, update) {
    return new Promise(resolve => {
      const started = performance.now();
      const frame = now => {
        const progress = Math.min(1, (now - started) / duration);
        const eased = 1 - Math.pow(1 - progress, 3);
        update(from + (to - from) * eased, progress);
        if (progress < 1) requestAnimationFrame(frame);
        else resolve();
      };
      requestAnimationFrame(frame);
    });
  }

  async function animateDrop(slot, key) {
    const overlay = $("#drop-overlay");
    overlay.className = "drop-overlay";
    overlay.textContent = "MATT IN MOTION";
    const g = boardGeometry();
    const steps = seededSteps(slot, key);
    let x = g.center;
    let y = 38;

    for (let row = 0; row < 10; row++) {
      const nextX = x + steps[row] * g.slotGap / 2;
      const nextY = g.top + row * g.rowGap + g.rowGap * 0.7;
      const startX = x;
      const startY = y;
      await tween(0, 1, 135, (value, progress) => {
        const arc = Math.sin(progress * Math.PI) * 8;
        drawBoard({ x: startX + (nextX - startX) * value, y: startY + (nextY - startY) * value - arc });
      });
      x = nextX;
      y = nextY;
    }

    await tween(y, g.height - 32, 260, value => drawBoard({ x, y: value }));
    const multiplier = MULTIPLIERS[slot];
    overlay.textContent = `${multiplier}× • SLOT ${slot + 1}`;
    overlay.classList.add(multiplier >= 1 ? "win" : "loss");
  }

  async function act(action) {
    try {
      await action();
    } catch (error) {
      state.busy = false;
      updateButtons();
      setStatus(errorMessage(error), "error");
    }
  }

  $$("[data-bet]").forEach(button => button.addEventListener("click", () => selectBet(Number(button.dataset.bet))));
  $("#wallet-button").addEventListener("click", () => act(connectWallet));
  $("#drop-button").addEventListener("click", () => act(play));
  $("#practice-button").addEventListener("click", () => act(practice));
  $("#withdraw-button").addEventListener("click", () => act(withdraw));
  window.addEventListener("resize", () => drawBoard());
  logo.addEventListener("load", () => drawBoard());

  const injected = [window.ronin?.provider, window.ronin, window.ethereum].find(item => item?.on);
  injected?.on?.("accountsChanged", () => location.reload());
  injected?.on?.("chainChanged", () => location.reload());

  selectBet(100000);
  initContract()
    .then(resumePending)
    .catch(error => setStatus(errorMessage(error), "error"));
})();
