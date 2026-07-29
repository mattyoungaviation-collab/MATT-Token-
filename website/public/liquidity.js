(() => {
  "use strict";

  if (!window.ethers || !window.MattLiquidityMath) {
    throw new Error("The pool-management libraries did not load.");
  }

  const CHAIN_ID = 2020;
  const CHAIN_HEX = "0x7e4";
  const MATT = "0xa5450417BDCa0BDfB058ffE41205400FfDA1174d";
  const WRON = "0xe514d9DEB7966c8BE0ca922de8a064264eA6bcd4";
  const POOL = "0xa517E05e96728E80284F2aE157dDF309449D7cE8";
  const POSITION_MANAGER = "0x7cF0fb64d72b733695d77d197c664e90D07cF45A";
  const FACTORY = "0x1f0B70d9A137e3cAEF0ceAcD312BC5f81Da0cC0c";
  const FEE = 10_000;
  const TICK_SPACING = 200;
  const DEADLINE_SECONDS = 20 * 60;
  const GAS_RESERVE = window.ethers.parseEther("0.25");
  const GAS_BUFFER_BPS = 12_000n;
  const BPS = 10_000n;
  const MAX_UINT128 = (2n ** 128n) - 1n;
  const ZERO_ADDRESS = window.ethers.ZeroAddress;
  const RPC_URL = new URL("/api/rpc", window.location.origin).href;
  const POSITION_LIMIT = 100;

  const TOKEN_ABI = [
    "function balanceOf(address) view returns(uint256)",
    "function allowance(address,address) view returns(uint256)",
    "function approve(address,uint256) returns(bool)"
  ];
  const POOL_ABI = [
    "function token0() view returns(address)",
    "function token1() view returns(address)",
    "function factory() view returns(address)",
    "function fee() view returns(uint24)",
    "function tickSpacing() view returns(int24)",
    "function liquidity() view returns(uint128)",
    "function slot0() view returns(uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocolNum,uint8 feeProtocolDen,bool unlocked)"
  ];
  const POSITION_MANAGER_ABI = [
    "event IncreaseLiquidity(uint256 indexed tokenId,uint128 liquidity,uint256 amount0,uint256 amount1)",
    "event DecreaseLiquidity(uint256 indexed tokenId,uint128 liquidity,uint256 amount0,uint256 amount1)",
    "event Collect(uint256 indexed tokenId,address recipient,uint256 amount0,uint256 amount1)",
    "function factory() view returns(address)",
    "function WETH9() view returns(address)",
    "function balanceOf(address) view returns(uint256)",
    "function tokenOfOwnerByIndex(address,uint256) view returns(uint256)",
    "function ownerOf(uint256) view returns(address)",
    "function positions(uint256) view returns(uint96 nonce,address operator,address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint128 liquidity,uint256 feeGrowthInside0LastX128,uint256 feeGrowthInside1LastX128,uint128 tokensOwed0,uint128 tokensOwed1)",
    "function collectedFees(uint256) view returns(uint256 token0,uint256 token1)",
    "function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline) params) payable returns(uint256 tokenId,uint128 liquidity,uint256 amount0,uint256 amount1)",
    "function increaseLiquidity((uint256 tokenId,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,uint256 deadline) params) payable returns(uint128 liquidity,uint256 amount0,uint256 amount1)",
    "function decreaseLiquidity((uint256 tokenId,uint128 liquidity,uint256 amount0Min,uint256 amount1Min,uint256 deadline) params) payable returns(uint256 amount0,uint256 amount1)",
    "function collect((uint256 tokenId,address recipient,uint128 amount0Max,uint128 amount1Max) params) payable returns(uint256 amount0,uint256 amount1)",
    "function multicall(bytes[] data) payable returns(bytes[] results)",
    "function refundETH() payable",
    "function unwrapWETH9(uint256 amountMinimum,address recipient) payable",
    "function sweepToken(address token,uint256 amountMinimum,address recipient) payable"
  ];

  const math = window.MattLiquidityMath;
  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];
  const fullTicks = math.fullRangeTicks(TICK_SPACING);
  const state = {
    readProvider: null,
    browserProvider: null,
    signer: null,
    account: null,
    readToken: null,
    token: null,
    readPool: null,
    readManager: null,
    manager: null,
    pool: null,
    market: null,
    createQuote: null,
    positions: [],
    rangeMode: "full",
    busy: false
  };

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

  function shortAddress(value) {
    return value ? `${value.slice(0, 6)}…${value.slice(-4)}` : "CONNECT RONIN";
  }

  function compact(value, precision = 2) {
    const number = Number(value);
    if (!Number.isFinite(number)) return "—";
    return number.toLocaleString(undefined, {
      maximumFractionDigits: precision,
      notation: Math.abs(number) >= 1_000_000 ? "compact" : "standard"
    });
  }

  function currency(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return "—";
    return number.toLocaleString(undefined, {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: number < 1 ? 2 : 0
    });
  }

  function formatToken(value, precision = 4) {
    const number = Number(window.ethers.formatEther(value));
    if (!Number.isFinite(number)) return "—";
    if (number > 0 && number < 0.0001) return "<0.0001";
    return number.toLocaleString(undefined, {
      maximumFractionDigits: precision,
      notation: number >= 10_000_000 ? "compact" : "standard"
    });
  }

  function formatPrice(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return "—";
    if (number >= 1_000_000) return compact(number, 3);
    if (number >= 1) return number.toLocaleString(undefined, { maximumFractionDigits: 4 });
    return number.toPrecision(4);
  }

  function parseAmount(value, token) {
    const normalized = String(value || "").trim().replace(/,/g, "");
    if (!/^\d+(\.\d{1,18})?$/.test(normalized)) throw new Error(`Enter a valid positive ${token} amount.`);
    const amount = window.ethers.parseEther(normalized);
    if (amount <= 0n) throw new Error(`Enter a positive ${token} amount.`);
    return amount;
  }

  function withGasBuffer(gas) {
    return (gas * GAS_BUFFER_BPS + BPS - 1n) / BPS;
  }

  function transactionLink(hash, label = "View transaction ↗") {
    return `<a href="https://app.roninchain.com/tx/${hash}" target="_blank" rel="noopener">${label}</a>`;
  }

  function errorMessage(error) {
    const message = error?.shortMessage || error?.reason || error?.message || "Transaction failed.";
    if (/user rejected|user denied|cancelled/i.test(message)) return "Transaction cancelled in Ronin Wallet.";
    if (/insufficient funds/i.test(message)) return "The wallet does not have enough RON for the amount and gas.";
    if (/transfer amount exceeds|insufficient balance|STF/i.test(message)) return "The wallet does not have enough MATT or the approval was not confirmed.";
    if (/price slippage|amount0min|amount1min/i.test(message)) return "The pool price moved beyond your limit. Refresh and try again.";
    if (/deadline/i.test(message)) return "The quote expired. Refresh and try again.";
    if (/not approved|not owner|ERC721/i.test(message)) return "This wallet no longer owns or controls that position.";
    return String(message).replace(/^execution reverted:\s*/i, "").slice(0, 260);
  }

  function setStatus(message, type = "", target = "#action-status") {
    const element = $(target);
    if (!element) return;
    element.textContent = message;
    element.className = `action-status ${type}`.trim();
  }

  function setStatusHtml(html, type = "", target = "#action-status") {
    const element = $(target);
    if (!element) return;
    element.innerHTML = html;
    element.className = `action-status ${type}`.trim();
  }

  function setQuoteState(label, type = "") {
    $("#quote-state").textContent = label;
    $("#quote-dot").className = type;
  }

  async function ensureRonin(provider) {
    const current = String(await provider.request({ method: "eth_chainId" })).toLowerCase();
    if (current !== CHAIN_HEX) {
      await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN_HEX }] });
    }
  }

  async function connectWallet(options = {}) {
    if (state.account) {
      await Promise.all([refreshCreateQuote(), loadPositions()]);
      return;
    }
    const injected = walletProvider();
    if (!injected) throw new Error("Ronin Wallet was not detected.");
    const method = options.silent ? "eth_accounts" : "eth_requestAccounts";
    const accounts = await injected.request({ method });
    if (!accounts?.[0]) {
      if (options.silent) return;
      throw new Error("No wallet account was approved.");
    }
    await ensureRonin(injected);
    state.browserProvider = new window.ethers.BrowserProvider(injected);
    state.signer = await state.browserProvider.getSigner();
    state.account = await state.signer.getAddress();
    state.token = new window.ethers.Contract(MATT, TOKEN_ABI, state.signer);
    state.manager = new window.ethers.Contract(POSITION_MANAGER, POSITION_MANAGER_ABI, state.signer);
    $("#wallet-button").textContent = shortAddress(state.account);
    $("#empty-connect").textContent = shortAddress(state.account);
    setStatus("Wallet connected. Quotes and positions are read directly from Ronin.", "good");
    await Promise.all([refreshCreateQuote(), loadPositions()]);
  }

  async function initializeReads() {
    state.readProvider = new window.ethers.JsonRpcProvider(RPC_URL, CHAIN_ID, {
      staticNetwork: true,
      batchMaxCount: 1
    });
    state.readToken = new window.ethers.Contract(MATT, TOKEN_ABI, state.readProvider);
    state.readPool = new window.ethers.Contract(POOL, POOL_ABI, state.readProvider);
    state.readManager = new window.ethers.Contract(POSITION_MANAGER, POSITION_MANAGER_ABI, state.readProvider);

    const [poolCode, managerCode, token0, token1, poolFactory, managerFactory, wrapped, fee, spacing] =
      await Promise.all([
        state.readProvider.getCode(POOL),
        state.readProvider.getCode(POSITION_MANAGER),
        state.readPool.token0(),
        state.readPool.token1(),
        state.readPool.factory(),
        state.readManager.factory(),
        state.readManager.WETH9(),
        state.readPool.fee(),
        state.readPool.tickSpacing()
      ]);

    if (poolCode === "0x" || managerCode === "0x") throw new Error("A configured Katana contract is missing.");
    if (token0.toLowerCase() !== MATT.toLowerCase() || token1.toLowerCase() !== WRON.toLowerCase()) {
      throw new Error("The configured pool is not the official MATT/WRON pool.");
    }
    if (poolFactory.toLowerCase() !== FACTORY.toLowerCase()
      || managerFactory.toLowerCase() !== FACTORY.toLowerCase()
      || wrapped.toLowerCase() !== WRON.toLowerCase()
      || Number(fee) !== FEE
      || Number(spacing) !== TICK_SPACING) {
      throw new Error("The Katana pool configuration changed. Transactions are locked.");
    }
    await refreshPoolState();
  }

  async function refreshPoolState() {
    const slot = await state.readPool.slot0();
    if (!slot.unlocked) throw new Error("The MATT pool is temporarily locked.");
    state.pool = {
      sqrtPriceX96: BigInt(slot.sqrtPriceX96),
      tick: Number(slot.tick),
      mattPerRon: math.tickToMattPerRon(Number(slot.tick))
    };
    return state.pool;
  }

  async function loadMarket() {
    try {
      const response = await fetch("/api/liquidity/market", { headers: { accept: "application/json" } });
      if (!response.ok) throw new Error("Pool analytics are unavailable.");
      state.market = await response.json();
      $("#market-price").textContent = `${formatPrice(state.market.mattPerRon)} MATT`;
      $("#market-tvl").textContent = currency(state.market.tvlUsd);
      $("#market-volume").textContent = currency(state.market.volume24hUsd);
      $("#market-trades").textContent = `${compact(state.market.transactions24h.buys + state.market.transactions24h.sells, 0)} trades`;
      $("#market-apr-24").textContent = `${compact(state.market.apr24h, 2)}%`;
      $("#market-apr-7").textContent = `${compact(state.market.apr7d, 2)}%`;
      if (state.market.stale) $("#market-note").textContent = "Pool analytics are temporarily stale. APR remains an estimate and excludes impermanent loss.";
    } catch {
      ["#market-price", "#market-tvl", "#market-volume", "#market-apr-24", "#market-apr-7"]
        .forEach(selector => { $(selector).textContent = "Unavailable"; });
    }
  }

  function currentRangeTicks() {
    if (state.rangeMode === "full") return fullTicks;
    return math.rangeFromPrices($("#range-min").value, $("#range-max").value, TICK_SPACING);
  }

  function rangeStatus(tickLower, tickUpper) {
    if (!state.pool) return { label: "READING POOL", className: "" };
    if (state.pool.tick < tickLower) return { label: "MATT ONLY · ABOVE RANGE", className: "inactive" };
    if (state.pool.tick >= tickUpper) return { label: "RON ONLY · BELOW RANGE", className: "inactive" };
    return { label: "ACTIVE · EARNING FEES", className: "active" };
  }

  function setRangeMode(mode) {
    state.rangeMode = String(mode);
    $$(".preset").forEach(button => button.classList.toggle("active", button.dataset.range === state.rangeMode));
    const custom = state.rangeMode !== "full";
    $("#range-min").disabled = !custom;
    $("#range-max").disabled = !custom;

    if (state.rangeMode === "full") {
      $("#range-min").value = "0";
      $("#range-max").value = "∞";
      $("#range-summary").textContent = "Full range · active at every possible pool price.";
    } else {
      const factor = state.rangeMode === "custom" ? 1.5 : 1 + Number(state.rangeMode) / 100;
      const current = state.pool?.mattPerRon || state.market?.mattPerRon;
      if (current) {
        $("#range-min").value = formatEditablePrice(current / factor);
        $("#range-max").value = formatEditablePrice(current * factor);
      }
      $("#range-summary").textContent = state.rangeMode === "custom"
        ? "Custom range · exact limits are rounded outward to valid Katana ticks."
        : `Focused range · approximately ${formatPrice(current / factor)} to ${formatPrice(current * factor)} MATT / RON.`;
    }
    invalidateCreateQuote("Range changed. Recalculate the position.");
  }

  function formatEditablePrice(value) {
    const number = Number(value);
    if (number >= 1) return number.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
    return number.toPrecision(8).replace(/0+$/, "").replace(/\.$/, "");
  }

  function invalidateCreateQuote(message) {
    state.createQuote = null;
    $("#create-position").disabled = true;
    setQuoteState("QUOTE CHANGED");
    if (message) setStatus(message);
  }

  async function refreshCreateQuote() {
    if (!state.readPool) return;
    await refreshPoolState();
    const primary = $("#primary-token").value;
    const amount = parseAmount($("#primary-amount").value, primary);
    const slippageBps = math.parsePercentToBps($("#slippage").value);
    const { tickLower, tickUpper } = currentRangeTicks();
    const paired = math.quotePairFromPrimary(primary, amount, state.pool.sqrtPriceX96, tickLower, tickUpper);
    const [ronBalance, mattBalance] = state.account
      ? await Promise.all([
        state.readProvider.getBalance(state.account),
        state.readToken.balanceOf(state.account)
      ])
      : [0n, 0n];
    const quote = {
      ...paired,
      tickLower,
      tickUpper,
      amount0Min: math.minimumAmount(paired.amount0Desired, slippageBps),
      amount1Min: math.minimumAmount(paired.amount1Desired, slippageBps),
      slippageBps,
      ronBalance,
      mattBalance
    };
    state.createQuote = quote;
    const status = rangeStatus(tickLower, tickUpper);
    const prices = math.pricesFromRange(tickLower, tickUpper);
    const isFull = tickLower === fullTicks.tickLower && tickUpper === fullTicks.tickUpper;

    $("#quote-matt").textContent = `${formatToken(quote.amount0Desired, 3)} MATT`;
    $("#quote-ron").textContent = `${formatToken(quote.amount1Desired, 5)} RON`;
    $("#quote-range").textContent = isFull
      ? "Full range"
      : `${formatPrice(prices.minMattPerRon)} – ${formatPrice(prices.maxMattPerRon)}`;
    $("#quote-range-status").textContent = status.label;
    $("#quote-minimums").textContent = `${formatToken(quote.amount0Min, 3)} MATT + ${formatToken(quote.amount1Min, 5)} RON`;
    $("#wallet-ron").textContent = state.account ? `${formatToken(ronBalance, 4)} RON` : "Connect wallet";
    $("#wallet-matt").textContent = state.account ? `${formatToken(mattBalance, 2)} MATT` : "Connect wallet";
    setQuoteState("LIVE QUOTE READY", "live");

    const button = $("#create-position");
    if (!state.account) {
      button.disabled = true;
      button.textContent = "CONNECT RONIN FIRST";
      setStatus("Connect Ronin Wallet to create or manage positions.");
    } else if (ronBalance < quote.amount1Desired + GAS_RESERVE) {
      button.disabled = true;
      button.textContent = "NOT ENOUGH RON";
      setStatus(`Keep at least 0.25 RON above the ${formatToken(quote.amount1Desired, 5)} RON supply for gas.`, "bad");
    } else if (mattBalance < quote.amount0Desired) {
      button.disabled = true;
      button.textContent = "NOT ENOUGH MATT";
      setStatus(`This range requires approximately ${formatToken(quote.amount0Desired, 2)} MATT.`, "bad");
    } else {
      button.disabled = false;
      button.textContent = "CREATE POSITION";
      setStatus("Ready. Ronin Wallet will show an exact MATT approval if needed, then the position mint.");
    }
  }

  async function ensureMattAllowance(amount, statusTarget = "#action-status") {
    if (amount <= 0n) return;
    const allowance = await state.token.allowance(state.account, POSITION_MANAGER);
    if (allowance >= amount) return;
    setStatus(`Confirm the exact ${formatToken(amount, 3)} MATT approval in Ronin Wallet.`, "", statusTarget);
    const gas = await state.token.approve.estimateGas(POSITION_MANAGER, amount);
    const transaction = await state.token.approve(POSITION_MANAGER, amount, { gasLimit: withGasBuffer(gas) });
    setStatusHtml(`Approval submitted. ${transactionLink(transaction.hash)}`, "", statusTarget);
    await transaction.wait(1);
  }

  async function createPosition() {
    requireWallet();
    if (state.busy) return;
    state.busy = true;
    $("#create-position").disabled = true;
    try {
      setStatus("Refreshing the pool before preparing the mint.");
      await refreshCreateQuote();
      const quote = state.createQuote;
      if (!quote) throw new Error("A live position quote is required.");
      if (quote.ronBalance < quote.amount1Desired + GAS_RESERVE) throw new Error("Insufficient RON balance.");
      if (quote.mattBalance < quote.amount0Desired) throw new Error("Insufficient MATT balance.");
      await ensureMattAllowance(quote.amount0Desired);

      const deadline = Math.floor(Date.now() / 1_000) + DEADLINE_SECONDS;
      const mintData = state.manager.interface.encodeFunctionData("mint", [{
        token0: MATT,
        token1: WRON,
        fee: FEE,
        tickLower: quote.tickLower,
        tickUpper: quote.tickUpper,
        amount0Desired: quote.amount0Desired,
        amount1Desired: quote.amount1Desired,
        amount0Min: quote.amount0Min,
        amount1Min: quote.amount1Min,
        recipient: state.account,
        deadline
      }]);
      const calls = [mintData, state.manager.interface.encodeFunctionData("refundETH")];
      setStatus(`Confirm the position mint with ${formatToken(quote.amount1Desired, 5)} native RON.`);
      const gas = await state.manager.multicall.estimateGas(calls, { value: quote.amount1Desired });
      const transaction = await state.manager.multicall(calls, {
        value: quote.amount1Desired,
        gasLimit: withGasBuffer(gas)
      });
      setStatusHtml(`Position submitted. ${transactionLink(transaction.hash)}`);
      const receipt = await transaction.wait(1);
      const increase = receipt.logs.map(log => {
        try { return state.manager.interface.parseLog(log); } catch { return null; }
      }).find(log => log?.name === "IncreaseLiquidity");
      const tokenId = increase?.args?.tokenId;
      setStatusHtml(`${tokenId ? `Position #${tokenId}` : "Position"} created successfully. ${transactionLink(transaction.hash)}`, "good");
      await Promise.all([refreshCreateQuote(), loadPositions()]);
    } finally {
      state.busy = false;
      if (state.createQuote) $("#create-position").disabled = false;
    }
  }

  function requireWallet() {
    if (!state.account || !state.signer || !state.manager || !state.token) {
      throw new Error("Connect Ronin Wallet first.");
    }
  }

  async function previewClaimable(tokenId, position) {
    const params = {
      tokenId,
      recipient: state.account,
      amount0Max: MAX_UINT128,
      amount1Max: MAX_UINT128
    };
    try {
      const result = await state.readManager.collect.staticCall(params, { from: state.account });
      return { amount0: BigInt(result.amount0 ?? result[0]), amount1: BigInt(result.amount1 ?? result[1]), exact: true };
    } catch {
      return {
        amount0: BigInt(position.tokensOwed0 ?? position[10]),
        amount1: BigInt(position.tokensOwed1 ?? position[11]),
        exact: false
      };
    }
  }

  async function loadPositions() {
    const empty = $("#positions-loading");
    const list = $("#positions-list");
    if (!state.account) {
      empty.hidden = false;
      empty.classList.remove("loading");
      list.hidden = true;
      return;
    }
    empty.hidden = false;
    empty.classList.add("loading");
    empty.querySelector("strong").textContent = "READING KATANA POSITION NFTs";
    empty.querySelector("p").textContent = "Claimable fees are simulated on-chain without submitting a transaction.";
    $("#empty-connect").hidden = true;
    list.hidden = true;

    try {
      await refreshPoolState();
      const count = Number(await state.readManager.balanceOf(state.account));
      const visibleCount = Math.min(count, POSITION_LIMIT);
      const tokenIds = await Promise.all(
        Array.from({ length: visibleCount }, (_, index) => state.readManager.tokenOfOwnerByIndex(state.account, index))
      );
      const rawPositions = await Promise.all(tokenIds.map(async tokenId => {
        const position = await state.readManager.positions(tokenId);
        if (
          String(position.token0).toLowerCase() !== MATT.toLowerCase()
          || String(position.token1).toLowerCase() !== WRON.toLowerCase()
          || Number(position.fee) !== FEE
        ) return null;
        const [claimable, collected] = await Promise.all([
          previewClaimable(tokenId, position),
          state.readManager.collectedFees(tokenId)
        ]);
        const liquidity = BigInt(position.liquidity);
        const principal = math.amountsForLiquidity(
          liquidity,
          state.pool.sqrtPriceX96,
          Number(position.tickLower),
          Number(position.tickUpper)
        );
        const collected0 = BigInt(collected.token0 ?? collected[0]);
        const collected1 = BigInt(collected.token1 ?? collected[1]);
        return {
          tokenId: BigInt(tokenId),
          tickLower: Number(position.tickLower),
          tickUpper: Number(position.tickUpper),
          liquidity,
          principal,
          claimable,
          collected0,
          collected1,
          valueRon: math.positionValueInRon(principal.amount0, principal.amount1, state.pool.sqrtPriceX96),
          claimableRon: math.positionValueInRon(claimable.amount0, claimable.amount1, state.pool.sqrtPriceX96),
          lifetimeFeesRon: math.positionValueInRon(
            collected0 + claimable.amount0,
            collected1 + claimable.amount1,
            state.pool.sqrtPriceX96
          )
        };
      }));
      state.positions = rawPositions.filter(Boolean).sort((a, b) => a.tokenId > b.tokenId ? -1 : 1);
      renderPositions(count > POSITION_LIMIT);
    } catch (error) {
      empty.classList.remove("loading");
      empty.querySelector("strong").textContent = "POSITIONS COULD NOT LOAD";
      empty.querySelector("p").textContent = errorMessage(error);
      $("#empty-connect").hidden = true;
    }
  }

  function renderPositions(truncated = false) {
    const empty = $("#positions-loading");
    const list = $("#positions-list");
    const positions = state.positions;
    $("#position-count").textContent = String(positions.length);
    $("#portfolio-count").textContent = String(positions.length);
    $("#portfolio-value").textContent = `${formatToken(sumField("valueRon"), 4)} RON`;
    $("#portfolio-fees").textContent = `${formatToken(sumField("claimableRon"), 5)} RON`;
    $("#portfolio-lifetime").textContent = `${formatToken(sumField("lifetimeFeesRon"), 5)} RON`;

    if (!positions.length) {
      empty.hidden = false;
      empty.classList.remove("loading");
      empty.querySelector("strong").textContent = "NO MATT POSITIONS FOUND";
      empty.querySelector("p").textContent = "Create your first position or switch to the wallet that owns the Katana NFT.";
      $("#empty-connect").hidden = true;
      list.hidden = true;
      return;
    }

    empty.hidden = true;
    list.innerHTML = positions.map(renderPositionCard).join("");
    if (truncated) {
      list.insertAdjacentHTML("beforeend", '<p class="action-status bad">Only the first 100 Katana NFTs were scanned. Move or consolidate unrelated positions to display the rest.</p>');
    }
    list.hidden = false;
  }

  function sumField(field) {
    return state.positions.reduce((total, position) => total + BigInt(position[field]), 0n);
  }

  function renderPositionCard(position) {
    const status = rangeStatus(position.tickLower, position.tickUpper);
    const prices = math.pricesFromRange(position.tickLower, position.tickUpper);
    const full = position.tickLower === fullTicks.tickLower && position.tickUpper === fullTicks.tickUpper;
    const marker = Math.max(2, Math.min(98,
      (state.pool.tick - position.tickLower) / (position.tickUpper - position.tickLower) * 100
    ));
    return `
      <article class="position-card" data-token-id="${position.tokenId}">
        <div class="position-top">
          <div class="position-id">
            <img src="/assets/matt-logo-512.png" alt="">
            <div><h3>MATT / RON #${position.tokenId}</h3><a href="https://app.roninchain.com/token/${POSITION_MANAGER.toLowerCase()}/${position.tokenId}" target="_blank" rel="noopener">VIEW NFT ↗</a></div>
          </div>
          <span class="status-badge ${status.className}">${status.label}</span>
        </div>
        <div class="position-metrics">
          <div><span>CURRENT POSITION</span><strong>${formatToken(position.principal.amount0, 2)} MATT</strong><small>+ ${formatToken(position.principal.amount1, 5)} RON</small></div>
          <div><span>VALUE</span><strong>${formatToken(position.valueRon, 4)} RON</strong><small>live pool price</small></div>
          <div><span>CLAIMABLE FEES</span><strong>${formatToken(position.claimable.amount0, 2)} MATT</strong><small>+ ${formatToken(position.claimable.amount1, 5)} RON${position.claimable.exact ? "" : " · cached"}</small></div>
          <div><span>LIFETIME FEES</span><strong>${formatToken(position.lifetimeFeesRon, 5)} RON</strong><small>collected + claimable</small></div>
        </div>
        <div class="position-range">
          <div><span>${full ? "FULL RANGE" : "PRICE RANGE · MATT / RON"}</span><strong>${full ? "0 → ∞" : `${formatPrice(prices.minMattPerRon)} → ${formatPrice(prices.maxMattPerRon)}`}</strong></div>
          <div class="mini-range" style="--marker:${marker}%"><i></i><b></b></div>
        </div>
        <div class="position-actions">
          <button class="secondary-button" type="button" data-position-action="add" data-token-id="${position.tokenId}">ADD LIQUIDITY</button>
          <button class="secondary-button" type="button" data-position-action="remove" data-token-id="${position.tokenId}">REMOVE</button>
          <button class="secondary-button collect-button" type="button" data-position-action="collect" data-token-id="${position.tokenId}" ${position.claimable.amount0 === 0n && position.claimable.amount1 === 0n ? "disabled" : ""}>COLLECT FEES</button>
        </div>
      </article>`;
  }

  function positionById(tokenId) {
    const id = BigInt(tokenId);
    const position = state.positions.find(item => item.tokenId === id);
    if (!position) throw new Error("That position is no longer loaded.");
    return position;
  }

  function openPositionDialog(action, tokenId) {
    requireWallet();
    const position = positionById(tokenId);
    const dialog = $("#position-dialog");
    $("#dialog-title").textContent = `POSITION #${position.tokenId}`;
    $("#dialog-kicker").textContent = action === "add" ? "ADD LIQUIDITY" : action === "remove" ? "REMOVE LIQUIDITY" : "COLLECT FEES";
    setStatus("", "", "#dialog-status");
    if (action === "add") renderAddDialog(position);
    else if (action === "remove") renderRemoveDialog(position);
    else renderCollectDialog(position);
    dialog.showModal();
  }

  function renderAddDialog(position) {
    $("#dialog-body").innerHTML = `
      <div class="dialog-grid">
        <p class="field-note">The NFT keeps its existing ${position.tickLower} → ${position.tickUpper} tick range. Start with either token and the matching side is calculated live.</p>
        <label><span>STARTING AMOUNT</span><span class="token-input"><input id="dialog-add-amount" type="text" inputmode="decimal" value="10"><select id="dialog-add-token"><option value="RON">RON</option><option value="MATT">MATT</option></select></span></label>
        <div class="dialog-preview">
          <div><span>MATT to add</span><strong id="dialog-add-matt">—</strong></div>
          <div><span>RON to add</span><strong id="dialog-add-ron">—</strong></div>
          <div><span>Range status</span><strong>${rangeStatus(position.tickLower, position.tickUpper).label}</strong></div>
        </div>
        <button id="dialog-add-submit" class="primary-button" type="button">ADD TO POSITION</button>
      </div>`;
    const update = () => {
      try {
        const token = $("#dialog-add-token").value;
        const amount = parseAmount($("#dialog-add-amount").value, token);
        const quote = math.quotePairFromPrimary(token, amount, state.pool.sqrtPriceX96, position.tickLower, position.tickUpper);
        position.addQuote = quote;
        $("#dialog-add-matt").textContent = `${formatToken(quote.amount0Desired, 3)} MATT`;
        $("#dialog-add-ron").textContent = `${formatToken(quote.amount1Desired, 5)} RON`;
        $("#dialog-add-submit").disabled = false;
        setStatus("", "", "#dialog-status");
      } catch (error) {
        position.addQuote = null;
        $("#dialog-add-submit").disabled = true;
        setStatus(errorMessage(error), "bad", "#dialog-status");
      }
    };
    $("#dialog-add-amount").addEventListener("input", update);
    $("#dialog-add-token").addEventListener("change", update);
    $("#dialog-add-submit").addEventListener("click", runAction(() => addLiquidity(position)));
    update();
  }

  async function addLiquidity(position) {
    if (!position.addQuote || state.busy) return;
    state.busy = true;
    $("#dialog-add-submit").disabled = true;
    try {
      await assertPositionOwner(position.tokenId);
      await refreshPoolState();
      const token = $("#dialog-add-token").value;
      const amount = parseAmount($("#dialog-add-amount").value, token);
      const quote = math.quotePairFromPrimary(token, amount, state.pool.sqrtPriceX96, position.tickLower, position.tickUpper);
      const slippage = math.parsePercentToBps($("#slippage").value);
      const [ronBalance, mattBalance] = await Promise.all([
        state.readProvider.getBalance(state.account),
        state.readToken.balanceOf(state.account)
      ]);
      if (ronBalance < quote.amount1Desired + GAS_RESERVE) throw new Error("Insufficient RON balance.");
      if (mattBalance < quote.amount0Desired) throw new Error("Insufficient MATT balance.");
      await ensureMattAllowance(quote.amount0Desired, "#dialog-status");
      const data = state.manager.interface.encodeFunctionData("increaseLiquidity", [{
        tokenId: position.tokenId,
        amount0Desired: quote.amount0Desired,
        amount1Desired: quote.amount1Desired,
        amount0Min: math.minimumAmount(quote.amount0Desired, slippage),
        amount1Min: math.minimumAmount(quote.amount1Desired, slippage),
        deadline: Math.floor(Date.now() / 1_000) + DEADLINE_SECONDS
      }]);
      const calls = [data, state.manager.interface.encodeFunctionData("refundETH")];
      setStatus("Confirm the liquidity addition in Ronin Wallet.", "", "#dialog-status");
      const gas = await state.manager.multicall.estimateGas(calls, { value: quote.amount1Desired });
      const transaction = await state.manager.multicall(calls, {
        value: quote.amount1Desired,
        gasLimit: withGasBuffer(gas)
      });
      setStatusHtml(`Addition submitted. ${transactionLink(transaction.hash)}`, "", "#dialog-status");
      await transaction.wait(1);
      setStatusHtml(`Liquidity added successfully. ${transactionLink(transaction.hash)}`, "good", "#dialog-status");
      await loadPositions();
    } finally {
      state.busy = false;
      if ($("#dialog-add-submit")) $("#dialog-add-submit").disabled = false;
    }
  }

  function renderRemoveDialog(position) {
    $("#dialog-body").innerHTML = `
      <div class="dialog-grid">
        <p class="field-note">Removing liquidity also collects all currently claimable fees. A 100% removal closes and burns the Katana position NFT after payout.</p>
        <div class="percent-grid" id="remove-percent-grid">
          <button class="active" type="button" data-percent="2500">25%</button>
          <button type="button" data-percent="5000">50%</button>
          <button type="button" data-percent="7500">75%</button>
          <button type="button" data-percent="10000">100%</button>
        </div>
        <div class="dialog-preview">
          <div><span>Estimated principal</span><strong id="dialog-remove-principal">—</strong></div>
          <div><span>Plus claimable fees</span><strong>${formatToken(position.claimable.amount0, 3)} MATT + ${formatToken(position.claimable.amount1, 5)} RON</strong></div>
          <div><span>NFT after action</span><strong id="dialog-remove-nft">Remains open</strong></div>
        </div>
        <label class="toggle-row"><input id="dialog-remove-native" type="checkbox" checked> Unwrap WRON and receive native RON</label>
        <p class="dialog-warning">Output minimums use the ${$("#slippage").value}% price-movement setting from the position builder.</p>
        <button id="dialog-remove-submit" class="primary-button" type="button">REMOVE 25%</button>
      </div>`;
    position.removeBps = 2500n;
    const update = () => {
      const liquidity = math.liquidityShare(position.liquidity, position.removeBps);
      const amounts = math.amountsForLiquidity(liquidity, state.pool.sqrtPriceX96, position.tickLower, position.tickUpper);
      position.removeQuote = { liquidity, ...amounts };
      $("#dialog-remove-principal").textContent = `${formatToken(amounts.amount0, 3)} MATT + ${formatToken(amounts.amount1, 5)} RON`;
      $("#dialog-remove-nft").textContent = position.removeBps === 10_000n ? "Closed after payout" : "Remains open";
      $("#dialog-remove-submit").textContent = `REMOVE ${Number(position.removeBps) / 100}%`;
    };
    $$("#remove-percent-grid button").forEach(button => button.addEventListener("click", () => {
      $$("#remove-percent-grid button").forEach(item => item.classList.toggle("active", item === button));
      position.removeBps = BigInt(button.dataset.percent);
      update();
    }));
    $("#dialog-remove-submit").addEventListener("click", runAction(() => removeLiquidity(position)));
    update();
  }

  async function removeLiquidity(position) {
    if (!position.removeQuote || state.busy) return;
    state.busy = true;
    $("#dialog-remove-submit").disabled = true;
    try {
      await assertPositionOwner(position.tokenId);
      await refreshPoolState();
      const liquidity = math.liquidityShare(position.liquidity, position.removeBps);
      const amounts = math.amountsForLiquidity(liquidity, state.pool.sqrtPriceX96, position.tickLower, position.tickUpper);
      const slippage = math.parsePercentToBps($("#slippage").value);
      const decreaseData = state.manager.interface.encodeFunctionData("decreaseLiquidity", [{
        tokenId: position.tokenId,
        liquidity,
        amount0Min: math.minimumAmount(amounts.amount0, slippage),
        amount1Min: math.minimumAmount(amounts.amount1, slippage),
        deadline: Math.floor(Date.now() / 1_000) + DEADLINE_SECONDS
      }]);
      const receiveNative = $("#dialog-remove-native").checked;
      const calls = [decreaseData, ...collectAndPayoutCalls(position.tokenId, receiveNative)];
      setStatus("Confirm the removal and fee payout in Ronin Wallet.", "", "#dialog-status");
      const gas = await state.manager.multicall.estimateGas(calls);
      const transaction = await state.manager.multicall(calls, { gasLimit: withGasBuffer(gas) });
      setStatusHtml(`Removal submitted. ${transactionLink(transaction.hash)}`, "", "#dialog-status");
      await transaction.wait(1);
      setStatusHtml(`Liquidity removed and proceeds paid successfully. ${transactionLink(transaction.hash)}`, "good", "#dialog-status");
      await loadPositions();
    } finally {
      state.busy = false;
      if ($("#dialog-remove-submit")) $("#dialog-remove-submit").disabled = false;
    }
  }

  function renderCollectDialog(position) {
    $("#dialog-body").innerHTML = `
      <div class="dialog-grid">
        <p class="field-note">Katana refreshes the NFT’s fee growth and pays all claimable fees. Your liquidity and selected price range stay unchanged.</p>
        <div class="dialog-preview">
          <div><span>Claimable MATT</span><strong>${formatToken(position.claimable.amount0, 5)} MATT</strong></div>
          <div><span>Claimable RON</span><strong>${formatToken(position.claimable.amount1, 7)} RON</strong></div>
          <div><span>Combined value</span><strong>${formatToken(position.claimableRon, 6)} RON</strong></div>
          <div><span>Lifetime after claim</span><strong>${formatToken(position.lifetimeFeesRon, 6)} RON</strong></div>
        </div>
        <label class="toggle-row"><input id="dialog-collect-native" type="checkbox" checked> Unwrap WRON and receive native RON</label>
        <button id="dialog-collect-submit" class="primary-button" type="button">COLLECT ALL FEES</button>
      </div>`;
    $("#dialog-collect-submit").addEventListener("click", runAction(() => collectFees(position)));
  }

  function collectAndPayoutCalls(tokenId, receiveNative) {
    const collectData = state.manager.interface.encodeFunctionData("collect", [{
      tokenId,
      recipient: receiveNative ? ZERO_ADDRESS : state.account,
      amount0Max: MAX_UINT128,
      amount1Max: MAX_UINT128
    }]);
    if (!receiveNative) return [collectData];
    return [
      collectData,
      state.manager.interface.encodeFunctionData("sweepToken", [MATT, 0n, state.account]),
      state.manager.interface.encodeFunctionData("unwrapWETH9", [0n, state.account])
    ];
  }

  async function collectFees(position) {
    if (state.busy) return;
    state.busy = true;
    $("#dialog-collect-submit").disabled = true;
    try {
      await assertPositionOwner(position.tokenId);
      const receiveNative = $("#dialog-collect-native").checked;
      const calls = collectAndPayoutCalls(position.tokenId, receiveNative);
      setStatus("Confirm the fee collection in Ronin Wallet.", "", "#dialog-status");
      const gas = await state.manager.multicall.estimateGas(calls);
      const transaction = await state.manager.multicall(calls, { gasLimit: withGasBuffer(gas) });
      setStatusHtml(`Collection submitted. ${transactionLink(transaction.hash)}`, "", "#dialog-status");
      await transaction.wait(1);
      setStatusHtml(`Fees collected successfully. ${transactionLink(transaction.hash)}`, "good", "#dialog-status");
      await loadPositions();
    } finally {
      state.busy = false;
      if ($("#dialog-collect-submit")) $("#dialog-collect-submit").disabled = false;
    }
  }

  async function assertPositionOwner(tokenId) {
    const owner = await state.readManager.ownerOf(tokenId);
    if (owner.toLowerCase() !== state.account.toLowerCase()) throw new Error("This wallet no longer owns that position.");
  }

  function activateTab(name) {
    const create = name === "create";
    $("#create-tab").classList.toggle("active", create);
    $("#create-tab").setAttribute("aria-selected", String(create));
    $("#positions-tab").classList.toggle("active", !create);
    $("#positions-tab").setAttribute("aria-selected", String(!create));
    $("#create").classList.toggle("active", create);
    $("#create").hidden = !create;
    $("#positions").classList.toggle("active", !create);
    $("#positions").hidden = create;
    if (!create && state.account) loadPositions().catch(() => {});
  }

  function runAction(action, statusTarget = "#action-status") {
    return async event => {
      event?.preventDefault();
      try {
        await action(event);
      } catch (error) {
        setStatus(errorMessage(error), "bad", statusTarget);
        if (statusTarget === "#action-status") setQuoteState("ACTION NEEDS ATTENTION", "bad");
      }
    };
  }

  $("#wallet-button").addEventListener("click", runAction(connectWallet));
  $("#empty-connect").addEventListener("click", runAction(connectWallet));
  $("#create-form").addEventListener("submit", runAction(refreshCreateQuote));
  $("#create-position").addEventListener("click", runAction(createPosition));
  $("#refresh-positions").addEventListener("click", runAction(loadPositions));
  $("#create-tab").addEventListener("click", () => activateTab("create"));
  $("#positions-tab").addEventListener("click", () => activateTab("positions"));
  $("#custom-range").addEventListener("click", () => setRangeMode("custom"));
  $$("#range-presets .preset").forEach(button => button.addEventListener("click", () => setRangeMode(button.dataset.range)));
  ["#primary-amount", "#primary-token", "#slippage", "#range-min", "#range-max"].forEach(selector => {
    $(selector).addEventListener(selector === "#primary-token" ? "change" : "input", () => invalidateCreateQuote("Inputs changed. Recalculate the position."));
  });
  $("#positions-list").addEventListener("click", runAction(event => {
    const button = event.target.closest("[data-position-action]");
    if (!button) return;
    openPositionDialog(button.dataset.positionAction, button.dataset.tokenId);
  }));

  const injected = walletProvider();
  if (injected?.on) {
    injected.on("accountsChanged", () => window.location.reload());
    injected.on("chainChanged", () => window.location.reload());
  }

  Promise.all([initializeReads(), loadMarket()])
    .then(async () => {
      setRangeMode("full");
      await refreshCreateQuote();
      await connectWallet({ silent: true });
    })
    .catch(error => {
      setQuoteState("TRANSACTIONS LOCKED", "bad");
      setStatus(errorMessage(error), "bad");
    });
})();
