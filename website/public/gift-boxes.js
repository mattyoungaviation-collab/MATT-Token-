(() => {
  "use strict";

  if (!window.ethers) throw new Error("The wallet library did not load.");

  const CHAIN_ID = 2020;
  const CHAIN_HEX = "0x7e4";
  const OWNER = "0xF79913cB83Cc9CABD95D0ba9250103fbb939f984";
  const MATT_ADDRESS = "0xa5450417BDCa0BDfB058ffE41205400FfDA1174d";
  const VAULT_ADDRESS = "0x896862e8D9c8576fcb4418ba21b4F9033E7785f4";
  const GIFT_BOXES_ADDRESS = "0x0F4b0637D60Af8e3dfE8aF8d7C9448d34a969EcE";
  const RPC_URL = "/api/rpc";
  const QUOTE_SECONDS = 120;
  const RESULT_POLL_MS = 3_000;
  const RESULT_POLL_ATTEMPTS = 120;
  const MAX_MULTIPLIER_BPS = 75_000n;
  const BPS = 10_000n;
  const DEFAULT_MATT_PER_RON = "10000";
  const TX_GAS_BUFFER_BPS = 12_000n;

  const GIFT_BOXES_ABI = [
    "event BoxPurchased(uint256 indexed boxId,bytes32 indexed requestHash,address indexed buyer,address recipient,uint8 tier,uint256 priceRon,uint256 baseMatt,uint256 configVersion)",
    "function paused() view returns(bool)",
    "function activeConfigVersion() view returns(uint256)",
    "function getConfiguration(uint256) view returns(uint256[3] prices,uint32[] multipliersBps,uint16[] chancesBps,uint64 activatesAt,bool exists)",
    "function quoteRandomFee() view returns(uint256)",
    "function totalBoxesPurchased() view returns(uint256)",
    "function boxes(uint256) view returns(address buyer,address recipient,uint128 baseMatt,uint128 priceRon,uint64 purchasedAt,uint64 lastRequestAt,uint32 configVersion,uint32 multiplierBps,uint8 tier,uint8 status,uint8 retries,uint256 payout)",
    "function purchaseBox(address recipient,uint8 tier,uint256 baseMatt,uint256 nonce,uint64 deadline,bytes signature) payable returns(uint256,bytes32)",
    "function fundRandomnessReserve() payable",
    "function pause()",
    "function unpause()"
  ];
  const VAULT_ABI = [
    "function availableBankroll() view returns(uint256)",
    "function totalReserved() view returns(uint256)",
    "function totalClaimable() view returns(uint256)",
    "function claimable(address) view returns(uint256)",
    "function fund(uint256 amount)",
    "function claim()"
  ];
  const TOKEN_ABI = [
    "function balanceOf(address) view returns(uint256)",
    "function allowance(address,address) view returns(uint256)",
    "function approve(address,uint256) returns(bool)"
  ];

  const tiers = [
    { name: "BRONZE", price: 100, color: "bronze" },
    { name: "VIOLET", price: 250, color: "violet" },
    { name: "GOLD", price: 500, color: "gold" }
  ];
  let rewards = [
    { multiplierBps: 8_500, chanceBps: 4_000 },
    { multiplierBps: 9_000, chanceBps: 2_000 },
    { multiplierBps: 9_500, chanceBps: 1_500 },
    { multiplierBps: 10_000, chanceBps: 1_500 },
    { multiplierBps: 11_000, chanceBps: 500 },
    { multiplierBps: 12_500, chanceBps: 250 },
    { multiplierBps: 15_000, chanceBps: 150 },
    { multiplierBps: 20_000, chanceBps: 50 },
    { multiplierBps: 30_000, chanceBps: 20 },
    { multiplierBps: 75_000, chanceBps: 30 }
  ];

  const state = {
    tier: 0,
    recipientMode: "self",
    account: null,
    walletProvider: null,
    browserProvider: null,
    signer: null,
    giftBoxes: null,
    vault: null,
    token: null,
    readProvider: null,
    readGiftBoxes: null,
    readVault: null,
    readToken: null,
    activeConfigVersion: 1n,
    tierPricesWei: [100n, 250n, 500n].map(value => value * 10n ** 18n),
    quoteExpiresAt: Date.now() + QUOTE_SECONDS * 1_000,
    opening: false,
    paused: true,
    vaultAvailable: 0n,
    randomnessReserve: 0n,
    randomFee: 0n,
    claimable: 0n,
    pendingBoxId: null
  };

  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function compactNumber(value, precision = 2) {
    return Number(value).toLocaleString(undefined, {
      notation: Number(value) >= 1_000_000 ? "compact" : "standard",
      maximumFractionDigits: precision
    });
  }

  function formatToken(value, precision = 2) {
    return compactNumber(window.ethers.formatEther(value), precision);
  }

  function shortAddress(address) {
    return address ? `${address.slice(0, 6)}…${address.slice(-4)}` : "Not connected";
  }

  function isOwner() {
    return state.account?.toLowerCase() === OWNER.toLowerCase();
  }

  function setStatus(message, type = "") {
    const element = $("#purchase-status");
    element.textContent = message;
    element.className = `purchase-status ${type}`.trim();
  }

  function errorMessage(error) {
    const message = error?.shortMessage || error?.reason || error?.message || "Transaction failed.";
    if (/user rejected|user denied/i.test(message)) return "Transaction cancelled in Ronin Wallet.";
    if (/paused/i.test(message)) return "Gift boxes are paused.";
    if (/insufficientbankroll/i.test(message)) return "The MATT vault cannot cover the 7.5× maximum payout.";
    if (/insufficientrandomnessreserve/i.test(message)) return "The RON randomness reserve needs more funding.";
    if (/invalidquote/i.test(message)) return "The owner-signed quote was rejected.";
    if (/quoteexpired/i.test(message)) return "The two-minute quote expired. Please try again.";
    return message.replace(/^execution reverted:\s*/i, "");
  }

  function withGasBuffer(amount) {
    return (amount * TX_GAS_BUFFER_BPS + BPS - 1n) / BPS;
  }

  function mattPerRonWei() {
    const value = $("#matt-per-ron").value.trim();
    if (!/^\d+(\.\d{1,18})?$/.test(value) || Number(value) <= 0) {
      throw new Error("Enter a valid positive MATT-per-RON quote.");
    }
    return window.ethers.parseEther(value);
  }

  function selectedBaseMatt() {
    return mattPerRonWei() * state.tierPricesWei[state.tier] / 10n ** 18n;
  }

  function selectedMaximumPayout() {
    return selectedBaseMatt() * MAX_MULTIPLIER_BPS / BPS;
  }

  function recipientAddress() {
    if (state.recipientMode === "self") {
      if (!state.account) throw new Error("Connect Ronin Wallet first.");
      return state.account;
    }
    const recipient = $("#recipient-address").value.trim();
    if (!window.ethers.isAddress(recipient)) throw new Error("Enter a complete Ronin recipient address.");
    return window.ethers.getAddress(recipient);
  }

  function renderQuote() {
    const tier = tiers[state.tier];
    let baseline = BigInt(tier.price) * window.ethers.parseEther(DEFAULT_MATT_PER_RON);
    try { baseline = selectedBaseMatt(); } catch {}
    $("#stage-tier").textContent = `${tier.price} RON ${tier.name} BOX`;
    $("#quote-price").textContent = `${tier.price} RON`;
    $("#quote-baseline").textContent = `${formatToken(baseline)} MATT`;
    $("#quote-range").textContent =
      `${formatToken(baseline * 8_500n / BPS)}–${formatToken(baseline * MAX_MULTIPLIER_BPS / BPS)} MATT`;
    $("#reveal-box").className = `reveal-box ${tier.color}`;
  }

  function selectTier(index) {
    state.tier = index;
    state.quoteExpiresAt = Date.now() + QUOTE_SECONDS * 1_000;
    $$(".tier-card").forEach((card, cardIndex) => {
      card.setAttribute("aria-checked", String(cardIndex === index));
    });
    $("#result-multiplier").textContent = "SEALED";
    $("#result-value").textContent = "Preview or prepare an owner-signed on-chain test.";
    $("#result-label").textContent = "YOUR REWARD";
    renderQuote();
    updateControls();
  }

  function setRecipientMode(mode) {
    state.recipientMode = mode;
    $$("[data-recipient-mode]").forEach(button => {
      button.classList.toggle("active", button.dataset.recipientMode === mode);
    });
    $("#recipient-field").hidden = mode !== "gift";
    updateControls();
  }

  function selectPreviewReward() {
    const random = new Uint32Array(1);
    crypto.getRandomValues(random);
    const roll = random[0] % 10_000;
    let cumulative = 0;
    return rewards.find(reward => {
      cumulative += reward.chanceBps;
      return roll < cumulative;
    }) || rewards[rewards.length - 1];
  }

  async function animateOpening(multiplierBps, payout, label) {
    const button = $("#preview-button");
    const box = $("#reveal-box");
    state.opening = true;
    updateControls();
    button.textContent = label === "TEST RESULT" ? "OPENING PREVIEW…" : "REVEALING ON-CHAIN RESULT…";
    $("#result-label").textContent = "OPENING";
    $("#result-multiplier").textContent = "…";
    box.classList.remove("opened");
    void box.offsetWidth;
    box.classList.add("opening");
    await new Promise(resolve => setTimeout(resolve, reducedMotion ? 50 : 1_250));
    box.classList.remove("opening");
    box.classList.add("opened");
    const multiplier = Number(multiplierBps) / 10_000;
    $("#result-label").textContent = multiplier === 7.5 ? "JACKPOT" : label;
    $("#result-multiplier").textContent = `${multiplier.toFixed(multiplier % 1 ? 2 : 0)}×`;
    $("#result-value").textContent = `${formatToken(payout)} MATT`;
    state.opening = false;
    button.textContent = "PREVIEW AN OPENING";
    updateControls();
  }

  async function previewOpening() {
    if (state.opening) return;
    try {
      if (state.recipientMode === "gift") recipientAddress();
      const reward = selectPreviewReward();
      const base = selectedBaseMatt();
      setStatus("Local preview only. No wallet request or transaction was made.");
      await animateOpening(
        reward.multiplierBps,
        base * BigInt(reward.multiplierBps) / BPS,
        "TEST RESULT"
      );
    } catch (error) {
      setStatus(errorMessage(error), "bad");
    }
  }

  function walletProvider() {
    const candidates = [
      window.ronin?.provider,
      window.ronin,
      ...(Array.isArray(window.ethereum?.providers) ? window.ethereum.providers : []),
      window.ethereum
    ];
    return candidates.find(item => item?.request && (item.isRonin || item.isRoninWallet))
      || candidates.find(item => item?.request)
      || null;
  }

  async function ensureRonin(provider) {
    const current = String(await provider.request({ method: "eth_chainId" })).toLowerCase();
    if (current !== CHAIN_HEX) {
      await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN_HEX }] });
    }
  }

  async function connectWallet() {
    const injected = walletProvider();
    if (!injected) throw new Error("Ronin Wallet was not detected.");
    const accounts = await injected.request({ method: "eth_requestAccounts" });
    if (!accounts?.[0]) throw new Error("No wallet account was approved.");
    await ensureRonin(injected);

    state.walletProvider = injected;
    state.browserProvider = new window.ethers.BrowserProvider(injected);
    state.signer = await state.browserProvider.getSigner();
    state.account = await state.signer.getAddress();
    state.giftBoxes = new window.ethers.Contract(GIFT_BOXES_ADDRESS, GIFT_BOXES_ABI, state.signer);
    state.vault = new window.ethers.Contract(VAULT_ADDRESS, VAULT_ABI, state.signer);
    state.token = new window.ethers.Contract(MATT_ADDRESS, TOKEN_ABI, state.signer);

    $("#wallet-button").textContent = shortAddress(state.account);
    $("#wallet-role").textContent = isOwner() ? "Owner wallet connected" : "Player wallet connected";
    $("#owner-panel").hidden = !isOwner();
    setStatus(isOwner()
      ? "Owner wallet connected. Mainnet actions still require explicit wallet confirmation."
      : "Player wallet connected. Public quotes remain disabled during controlled testing.", "good");
    await refreshState();
    restorePendingBox();
  }

  async function initializeContracts() {
    state.readProvider = new window.ethers.JsonRpcProvider(RPC_URL, CHAIN_ID, {
      staticNetwork: true,
      batchMaxCount: 1
    });
    state.readGiftBoxes = new window.ethers.Contract(GIFT_BOXES_ADDRESS, GIFT_BOXES_ABI, state.readProvider);
    state.readVault = new window.ethers.Contract(VAULT_ADDRESS, VAULT_ABI, state.readProvider);
    state.readToken = new window.ethers.Contract(MATT_ADDRESS, TOKEN_ABI, state.readProvider);

    const [boxesCode, vaultCode] = await Promise.all([
      state.readProvider.getCode(GIFT_BOXES_ADDRESS),
      state.readProvider.getCode(VAULT_ADDRESS)
    ]);
    if (boxesCode === "0x" || vaultCode === "0x") throw new Error("A configured gift-box contract is missing.");
    await refreshState();
  }

  function renderConfiguration(config) {
    const [prices, multipliers, chances] = config;
    const priceElements = $$("[data-tier-price]");
    const rangeElements = $$("[data-tier-range]");
    prices.forEach((price, index) => {
      state.tierPricesWei[index] = BigInt(price);
      tiers[index].price = Number(window.ethers.formatEther(price));
      const multiplierMin = Number(multipliers[0]) / 10_000;
      const multiplierMax = Number(multipliers[multipliers.length - 1]) / 10_000;
      priceElements[index].textContent = `${compactNumber(tiers[index].price, 2)} RON`;
      rangeElements[index].textContent =
        `${compactNumber(tiers[index].price * multiplierMin)}–${compactNumber(tiers[index].price * multiplierMax)} RON equivalent in MATT`;
    });
    rewards = multipliers.map((multiplier, index) => ({
      multiplierBps: Number(multiplier),
      chanceBps: Number(chances[index])
    }));
    const minimum = Number(multipliers[0]) / 100;
    const maximum = Number(multipliers[multipliers.length - 1]) / 10_000;
    const weighted = rewards.reduce(
      (sum, reward) => sum + reward.multiplierBps * reward.chanceBps,
      0
    ) / 1_000_000;
    $("#minimum-return").textContent = `${minimum.toFixed(minimum % 1 ? 2 : 0)}%`;
    $("#jackpot-multiplier").textContent = `${maximum.toFixed(maximum % 1 ? 2 : 0)}×`;
    $("#average-return").textContent = `${weighted.toFixed(3)}%`;
    renderOddsTable(weighted);
    renderQuote();
  }

  function renderOddsTable(weighted) {
    const price = tiers[0].price;
    const rows = rewards.map(reward => {
      const multiplier = reward.multiplierBps / 10_000;
      const chance = reward.chanceBps / 100;
      const difference = (multiplier - 1) * 100;
      let result = "Break even";
      let css = "even";
      if (difference < 0) { result = `${Math.abs(difference).toFixed(0)}% below cost`; css = "soft-loss"; }
      if (difference > 0) { result = multiplier === 7.5 ? "Jackpot" : `${difference.toFixed(0)}% win`; css = "win"; }
      return `<tr class="${multiplier === 7.5 ? "jackpot-row" : ""}">
        <td>${multiplier.toFixed(multiplier % 1 ? 2 : 0)}×</td>
        <td>${chance.toFixed(chance % 1 ? 2 : 0)}%</td>
        <td>${compactNumber(price * multiplier)} RON value</td>
        <td class="${css}">${result}</td>
      </tr>`;
    });
    $("#odds-table-body").innerHTML = rows.join("");
    $("#odds-average").innerHTML =
      `<td>Weighted average</td><td>100%</td><td>${compactNumber(price * weighted / 100)} RON value</td><td>${weighted.toFixed(3)}% RTP</td>`;
  }

  async function refreshState() {
    if (!state.readGiftBoxes) return;
    const [paused, version, randomFee, reserve, vaultAvailable, totalReserved, totalClaimable, totalBoxes] =
      await Promise.all([
        state.readGiftBoxes.paused(),
        state.readGiftBoxes.activeConfigVersion(),
        state.readGiftBoxes.quoteRandomFee(),
        state.readProvider.getBalance(GIFT_BOXES_ADDRESS),
        state.readVault.availableBankroll(),
        state.readVault.totalReserved(),
        state.readVault.totalClaimable(),
        state.readGiftBoxes.totalBoxesPurchased()
      ]);
    const config = await state.readGiftBoxes.getConfiguration(version);
    state.paused = paused;
    state.activeConfigVersion = version;
    state.randomFee = randomFee;
    state.randomnessReserve = reserve;
    state.vaultAvailable = vaultAvailable;

    $("#chain-state").textContent = paused ? "PAUSED" : "LIVE";
    $("#chain-state").className = paused ? "state-bad" : "state-good";
    $("#config-version").textContent = `v${version}`;
    $("#vault-available").textContent = `${formatToken(vaultAvailable)} MATT`;
    $("#vault-reserved").textContent = `${formatToken(totalReserved)} MATT`;
    $("#vault-claimable").textContent = `${formatToken(totalClaimable)} MATT`;
    $("#random-reserve").textContent = `${formatToken(reserve, 6)} RON`;
    $("#random-fee").textContent = `${formatToken(randomFee, 6)} RON`;
    $("#boxes-opened").textContent = totalBoxes.toString();
    $("#contract-status").textContent = paused ? "MAINNET · PAUSED" : "MAINNET · LIVE";
    $("#contract-status").classList.toggle("live", !paused);
    renderConfiguration(config);

    if (state.account) {
      const [balance, claimable] = await Promise.all([
        state.readToken.balanceOf(state.account),
        state.readVault.claimable(state.account)
      ]);
      state.claimable = claimable;
      $("#wallet-matt").textContent = `${formatToken(balance)} MATT`;
      $("#wallet-claimable").textContent = `${formatToken(claimable)} MATT`;
    }
    updateControls();
  }

  function reservesCoverSelection() {
    try {
      return state.vaultAvailable >= selectedMaximumPayout()
        && state.randomnessReserve >= state.randomFee * 3n;
    } catch {
      return false;
    }
  }

  function updateControls() {
    const owner = isOwner();
    const canOwnerPurchase = owner && !state.paused && reservesCoverSelection() && !state.opening;
    $("#live-purchase-button").disabled = !canOwnerPurchase;
    $("#live-purchase-button").textContent = !state.account
      ? "CONNECT OWNER WALLET FOR LIVE TEST"
      : !owner
        ? "PUBLIC QUOTES DISABLED DURING TESTING"
        : state.paused
          ? "CONTRACT PAUSED"
          : !reservesCoverSelection()
            ? "FUND BOTH RESERVES FIRST"
            : "SIGN QUOTE & BUY ON MAINNET";
    $("#preview-button").disabled = state.opening;
    $("#claim-button").disabled = !state.account || state.claimable === 0n || state.opening;
    $("#fund-vault-button").disabled = !owner || state.opening;
    $("#fund-reserve-button").disabled = !owner || state.opening;
    const pauseButton = $("#pause-toggle-button");
    pauseButton.textContent = state.paused ? "UNPAUSE MAINNET" : "PAUSE MAINNET NOW";
    $("#unpause-confirm-row").hidden = !state.paused;
    pauseButton.disabled = !owner || state.opening;
    if (state.paused) {
      pauseButton.disabled = pauseButton.disabled
        || $("#unpause-confirm").value.trim().toUpperCase() !== "UNPAUSE"
        || !reservesCoverSelection();
    }
  }

  async function signOwnerQuote(recipient, baseMatt) {
    if (!isOwner() || !state.signer) throw new Error("The owner wallet must sign the test quote.");
    const nonce = BigInt(window.ethers.hexlify(crypto.getRandomValues(new Uint8Array(16))));
    const deadline = Math.floor(Date.now() / 1_000) + QUOTE_SECONDS;
    const domain = {
      name: "MATT Gift Boxes",
      version: "1",
      chainId: CHAIN_ID,
      verifyingContract: GIFT_BOXES_ADDRESS
    };
    const types = {
      PriceQuote: [
        { name: "buyer", type: "address" },
        { name: "recipient", type: "address" },
        { name: "tier", type: "uint8" },
        { name: "baseMatt", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint64" },
        { name: "configVersion", type: "uint256" }
      ]
    };
    const value = {
      buyer: state.account,
      recipient,
      tier: state.tier,
      baseMatt,
      nonce,
      deadline,
      configVersion: state.activeConfigVersion
    };
    const signature = await state.signer.signTypedData(domain, types, value);
    return { ...value, signature };
  }

  async function purchaseLiveBox() {
    if (!isOwner()) throw new Error("Only the owner wallet can run the controlled live test.");
    if (state.paused) throw new Error("Gift boxes are paused.");
    const recipient = recipientAddress();
    const baseMatt = selectedBaseMatt();
    if (!reservesCoverSelection()) throw new Error("Fund both reserves before testing.");
    state.opening = true;
    updateControls();
    try {
      setStatus("Confirm the two-minute owner price quote in Ronin Wallet.");
      const quote = await signOwnerQuote(recipient, baseMatt);
      state.quoteExpiresAt = quote.deadline * 1_000;
      const args = [quote.recipient, quote.tier, quote.baseMatt, quote.nonce, quote.deadline, quote.signature];
      const value = state.tierPricesWei[state.tier];
      const estimatedGas = await state.giftBoxes.purchaseBox.estimateGas(...args, { value });
      setStatus(`Confirm the ${tiers[state.tier].price} RON mainnet purchase in Ronin Wallet.`);
      const transaction = await state.giftBoxes.purchaseBox(...args, {
        value,
        gasLimit: withGasBuffer(estimatedGas)
      });
      setStatus(`Purchase submitted: ${shortAddress(transaction.hash)}. Waiting for confirmation…`);
      const receipt = await transaction.wait(1);
      const purchased = receipt.logs
        .map(log => {
          try { return state.giftBoxes.interface.parseLog(log); } catch { return null; }
        })
        .find(log => log?.name === "BoxPurchased");
      if (!purchased) throw new Error("The purchase confirmed but its event was not found.");
      state.pendingBoxId = BigInt(purchased.args.boxId);
      localStorage.setItem("mattGiftBoxPending", state.pendingBoxId.toString());
      setStatus(`Box #${state.pendingBoxId} confirmed. Waiting for Ronin VRF…`, "good");
      await waitForBox(state.pendingBoxId);
    } finally {
      state.opening = false;
      updateControls();
      await refreshState().catch(() => {});
    }
  }

  async function waitForBox(boxId) {
    for (let attempt = 0; attempt < RESULT_POLL_ATTEMPTS; attempt += 1) {
      const box = await state.readGiftBoxes.boxes(boxId);
      if (Number(box.status) === 2) {
        localStorage.removeItem("mattGiftBoxPending");
        state.pendingBoxId = null;
        await animateOpening(box.multiplierBps, box.payout, "ON-CHAIN RESULT");
        setStatus(`Box #${boxId} settled by Ronin VRF. ${formatToken(box.payout)} MATT is ready to claim.`, "good");
        await refreshState();
        return;
      }
      await new Promise(resolve => setTimeout(resolve, RESULT_POLL_MS));
    }
    setStatus(`Box #${boxId} is still waiting for VRF. This page will resume tracking after refresh.`);
  }

  function restorePendingBox() {
    const value = localStorage.getItem("mattGiftBoxPending");
    if (!value || !/^\d+$/.test(value)) return;
    state.pendingBoxId = BigInt(value);
    setStatus(`Resuming Box #${value} settlement tracking.`);
    waitForBox(state.pendingBoxId).catch(error => setStatus(errorMessage(error), "bad"));
  }

  async function fundVault() {
    if (!isOwner()) throw new Error("Connect the owner wallet.");
    const amount = window.ethers.parseEther($("#vault-fund-amount").value.trim());
    if (amount <= 0n) throw new Error("Enter a positive MATT amount.");
    const allowance = await state.token.allowance(state.account, VAULT_ADDRESS);
    if (allowance < amount) {
      setStatus(`Approve exactly ${formatToken(amount)} MATT for the vault.`);
      await (await state.token.approve(VAULT_ADDRESS, amount)).wait(1);
    }
    setStatus(`Confirm funding ${formatToken(amount)} MATT into the vault.`);
    await (await state.vault.fund(amount)).wait(1);
    setStatus("MATT vault funding confirmed.", "good");
    await refreshState();
  }

  async function fundRandomnessReserve() {
    if (!isOwner()) throw new Error("Connect the owner wallet.");
    const amount = window.ethers.parseEther($("#reserve-fund-amount").value.trim());
    if (amount <= 0n) throw new Error("Enter a positive RON amount.");
    setStatus(`Confirm funding ${formatToken(amount, 6)} RON into the randomness reserve.`);
    await (await state.giftBoxes.fundRandomnessReserve({ value: amount })).wait(1);
    setStatus("RON randomness reserve funding confirmed.", "good");
    await refreshState();
  }

  async function claimMatt() {
    if (!state.vault || state.claimable === 0n) throw new Error("No MATT reward is ready to claim.");
    setStatus(`Confirm claiming ${formatToken(state.claimable)} MATT.`);
    await (await state.vault.claim()).wait(1);
    setStatus("MATT reward claimed.", "good");
    await refreshState();
  }

  async function togglePaused() {
    if (!isOwner()) throw new Error("Connect the owner wallet.");
    if (state.paused) {
      if ($("#unpause-confirm").value.trim().toUpperCase() !== "UNPAUSE") {
        throw new Error("Type UNPAUSE to confirm.");
      }
      if (!reservesCoverSelection()) throw new Error("Both reserves must cover the selected test box.");
      setStatus("Confirm unpausing Gift Boxes on Ronin mainnet.");
      await (await state.giftBoxes.unpause()).wait(1);
      $("#unpause-confirm").value = "";
      setStatus("Gift Boxes are unpaused. Run only the controlled owner test.", "good");
    } else {
      setStatus("Confirm pausing Gift Boxes immediately.");
      await (await state.giftBoxes.pause()).wait(1);
      setStatus("Gift Boxes are paused.", "good");
    }
    await refreshState();
  }

  function updateQuoteTimer() {
    let remaining = Math.max(0, state.quoteExpiresAt - Date.now());
    if (remaining === 0) {
      state.quoteExpiresAt = Date.now() + QUOTE_SECONDS * 1_000;
      remaining = QUOTE_SECONDS * 1_000;
    }
    const seconds = Math.ceil(remaining / 1_000);
    $("#quote-timer").textContent =
      `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  }

  function runAction(action) {
    return async () => {
      try {
        await action();
      } catch (error) {
        setStatus(errorMessage(error), "bad");
      } finally {
        updateControls();
      }
    };
  }

  $$(".tier-card").forEach(card => {
    card.addEventListener("click", () => selectTier(Number(card.dataset.tier)));
  });
  $$("[data-recipient-mode]").forEach(button => {
    button.addEventListener("click", () => setRecipientMode(button.dataset.recipientMode));
  });
  $("#preview-button").addEventListener("click", previewOpening);
  $("#wallet-button").addEventListener("click", runAction(connectWallet));
  $("#live-purchase-button").addEventListener("click", runAction(purchaseLiveBox));
  $("#claim-button").addEventListener("click", runAction(claimMatt));
  $("#fund-vault-button").addEventListener("click", runAction(fundVault));
  $("#fund-reserve-button").addEventListener("click", runAction(fundRandomnessReserve));
  $("#pause-toggle-button").addEventListener("click", runAction(togglePaused));
  $("#refresh-contract-button").addEventListener("click", runAction(refreshState));
  $("#matt-per-ron").addEventListener("input", () => {
    state.quoteExpiresAt = Date.now() + QUOTE_SECONDS * 1_000;
    renderQuote();
    updateControls();
  });
  $("#recipient-address").addEventListener("input", updateControls);
  $("#unpause-confirm").addEventListener("input", updateControls);

  const injected = walletProvider();
  if (injected?.on) {
    injected.on("accountsChanged", () => window.location.reload());
    injected.on("chainChanged", () => window.location.reload());
  }

  selectTier(0);
  setRecipientMode("self");
  updateQuoteTimer();
  setInterval(updateQuoteTimer, 1_000);
  initializeContracts().catch(error => {
    $("#contract-status").textContent = "RPC UNAVAILABLE";
    setStatus(`On-chain status unavailable: ${errorMessage(error)}`, "bad");
  });
})();
