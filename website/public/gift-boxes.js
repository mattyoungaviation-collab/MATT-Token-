(() => {
  "use strict";

  const MATT_PER_RON_TEST = 10_000;
  const tiers = [
    { name: "BRONZE", price: 100, color: "bronze" },
    { name: "VIOLET", price: 250, color: "violet" },
    { name: "GOLD", price: 500, color: "gold" }
  ];
  const rewards = [
    { multiplier: 0.85, chance: 4000 },
    { multiplier: 0.90, chance: 2000 },
    { multiplier: 0.95, chance: 1500 },
    { multiplier: 1.00, chance: 1500 },
    { multiplier: 1.10, chance: 500 },
    { multiplier: 1.25, chance: 250 },
    { multiplier: 1.50, chance: 150 },
    { multiplier: 2.00, chance: 50 },
    { multiplier: 3.00, chance: 20 },
    { multiplier: 7.50, chance: 30 }
  ];

  const state = {
    tier: 0,
    recipientMode: "self",
    account: null,
    quoteExpiresAt: Date.now() + 120_000,
    opening: false
  };

  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function compact(value) {
    return Number(value).toLocaleString(undefined, {
      notation: value >= 1_000_000 ? "compact" : "standard",
      maximumFractionDigits: 2
    });
  }

  function shortAddress(address) {
    return `${address.slice(0, 6)}…${address.slice(-4)}`;
  }

  function selectTier(index) {
    state.tier = index;
    state.quoteExpiresAt = Date.now() + 120_000;
    $$(".tier-card").forEach((card, cardIndex) => {
      card.setAttribute("aria-checked", String(cardIndex === index));
    });
    const tier = tiers[index];
    const baseline = tier.price * MATT_PER_RON_TEST;
    $("#stage-tier").textContent = `${tier.price} RON ${tier.name} BOX`;
    $("#quote-price").textContent = `${tier.price} RON`;
    $("#quote-baseline").textContent = `${baseline.toLocaleString()} MATT`;
    $("#quote-range").textContent = `${compact(baseline * 0.85)}–${compact(baseline * 7.5)} MATT`;
    const box = $("#reveal-box");
    box.className = `reveal-box ${tier.color}`;
    $("#result-multiplier").textContent = "SEALED";
    $("#result-value").textContent = "Preview the on-chain reveal experience.";
    $("#result-label").textContent = "YOUR REWARD";
  }

  function setRecipientMode(mode) {
    state.recipientMode = mode;
    $$("[data-recipient-mode]").forEach(button => {
      button.classList.toggle("active", button.dataset.recipientMode === mode);
    });
    $("#recipient-field").hidden = mode !== "gift";
  }

  function selectReward() {
    const random = new Uint32Array(1);
    crypto.getRandomValues(random);
    const roll = random[0] % 10_000;
    let cumulative = 0;
    return rewards.find(reward => {
      cumulative += reward.chance;
      return roll < cumulative;
    }) || rewards[rewards.length - 1];
  }

  async function previewOpening() {
    if (state.opening) return;
    if (state.recipientMode === "gift") {
      const recipient = $("#recipient-address").value.trim();
      if (!/^0x[0-9a-fA-F]{40}$/.test(recipient)) {
        $("#purchase-status").textContent = "Enter a complete 42-character Ronin recipient address.";
        $("#recipient-address").focus();
        return;
      }
    }

    state.opening = true;
    const button = $("#preview-button");
    const box = $("#reveal-box");
    button.disabled = true;
    button.textContent = "REQUESTING TEST RANDOMNESS…";
    $("#result-label").textContent = "OPENING";
    $("#result-multiplier").textContent = "…";
    $("#result-value").textContent = "The live version will wait for the verified on-chain result.";
    $("#purchase-status").textContent = "Local simulation only. No wallet request was made.";
    box.classList.remove("opened");
    void box.offsetWidth;
    box.classList.add("opening");

    await new Promise(resolve => setTimeout(resolve, reducedMotion ? 50 : 1_250));
    const reward = selectReward();
    const tier = tiers[state.tier];
    const baseline = tier.price * MATT_PER_RON_TEST;
    const payout = baseline * reward.multiplier;

    box.classList.remove("opening");
    box.classList.add("opened");
    $("#result-label").textContent = reward.multiplier === 7.5 ? "JACKPOT PREVIEW" : "TEST RESULT";
    $("#result-multiplier").textContent = `${reward.multiplier.toFixed(reward.multiplier % 1 ? 2 : 0)}×`;
    $("#result-value").textContent = `${compact(payout)} MATT · ${tier.price * reward.multiplier} RON quote value`;
    button.textContent = "PREVIEW ANOTHER OPENING";
    button.disabled = false;
    state.opening = false;
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

  async function connectWallet() {
    const provider = walletProvider();
    if (!provider) {
      $("#purchase-status").textContent = "Ronin Wallet was not detected. Preview mode still works without a wallet.";
      return;
    }
    try {
      const accounts = await provider.request({ method: "eth_requestAccounts" });
      if (!accounts?.[0]) throw new Error("No wallet account was approved.");
      state.account = accounts[0];
      $("#wallet-button").textContent = shortAddress(state.account);
      $("#purchase-status").textContent = "Wallet connected for interface testing. Live purchasing remains disabled.";
    } catch (error) {
      $("#purchase-status").textContent = /rejected|denied/i.test(String(error?.message))
        ? "Wallet connection cancelled."
        : "Wallet connection was not completed.";
    }
  }

  function updateQuoteTimer() {
    let remaining = Math.max(0, state.quoteExpiresAt - Date.now());
    if (remaining === 0) {
      state.quoteExpiresAt = Date.now() + 120_000;
      remaining = 120_000;
    }
    const seconds = Math.ceil(remaining / 1000);
    $("#quote-timer").textContent = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  }

  $$(".tier-card").forEach(card => {
    card.addEventListener("click", () => selectTier(Number(card.dataset.tier)));
  });
  $$("[data-recipient-mode]").forEach(button => {
    button.addEventListener("click", () => setRecipientMode(button.dataset.recipientMode));
  });
  $("#preview-button").addEventListener("click", previewOpening);
  $("#wallet-button").addEventListener("click", connectWallet);

  selectTier(0);
  setRecipientMode("self");
  updateQuoteTimer();
  setInterval(updateQuoteTimer, 1_000);
})();
