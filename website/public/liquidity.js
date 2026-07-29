(() => {
  "use strict";

  if (!window.ethers || !window.MattLiquidityMath) {
    throw new Error("The liquidity libraries did not load.");
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
  const TICK_LOWER = -887_200;
  const TICK_UPPER = 887_200;
  const RPC_URL = new URL("/api/rpc", window.location.origin).href;
  const GAS_RESERVE = window.ethers.parseEther("0.25");
  const DEADLINE_SECONDS = 20 * 60;
  const GAS_BUFFER_BPS = 12_000n;
  const BPS = 10_000n;

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
    "function slot0() view returns(uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocol,bool unlocked)"
  ];
  const POSITION_MANAGER_ABI = [
    "event IncreaseLiquidity(uint256 indexed tokenId,uint128 liquidity,uint256 amount0,uint256 amount1)",
    "function factory() view returns(address)",
    "function WETH9() view returns(address)",
    "function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline) params) payable returns(uint256 tokenId,uint128 liquidity,uint256 amount0,uint256 amount1)",
    "function multicall(bytes[] data) payable returns(bytes[] results)",
    "function refundETH() payable"
  ];

  const state = {
    readProvider: null,
    browserProvider: null,
    signer: null,
    account: null,
    token: null,
    manager: null,
    readToken: null,
    readPool: null,
    readManager: null,
    quote: null,
    busy: false
  };

  const $ = selector => document.querySelector(selector);
  const math = window.MattLiquidityMath;

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

  function shortAddress(address) {
    return address ? `${address.slice(0, 6)}…${address.slice(-4)}` : "CONNECT RONIN";
  }

  function compact(value, precision = 2) {
    return Number(value).toLocaleString(undefined, {
      maximumFractionDigits: precision,
      notation: Number(value) >= 1_000_000 ? "compact" : "standard"
    });
  }

  function formatAmount(value, precision = 4) {
    return Number(window.ethers.formatEther(value)).toLocaleString(undefined, {
      maximumFractionDigits: precision
    });
  }

  function setStatus(message, type = "") {
    const element = $("#action-status");
    element.textContent = message;
    element.className = `action-status ${type}`.trim();
  }

  function setQuoteState(label, type = "") {
    $("#quote-state").textContent = label;
    $("#quote-dot").className = type;
  }

  function errorMessage(error) {
    const message = error?.shortMessage || error?.reason || error?.message || "Transaction failed.";
    if (/user rejected|user denied|cancelled/i.test(message)) return "Transaction cancelled in Ronin Wallet.";
    if (/insufficient funds/i.test(message)) return "The wallet does not have enough RON for this position and gas.";
    if (/transfer amount exceeds|insufficient balance|STF/i.test(message)) return "The wallet does not have enough MATT or the MATT approval was not confirmed.";
    if (/price slippage|amount0min|amount1min/i.test(message)) return "The pool price moved beyond your limit. Refresh the quote and try again.";
    if (/deadline/i.test(message)) return "The mint quote expired. Refresh and try again.";
    return message.replace(/^execution reverted:\s*/i, "");
  }

  function parseRonAmount() {
    const value = $("#ron-amount").value.trim();
    if (!/^\d+(\.\d{1,18})?$/.test(value)) throw new Error("Enter a valid positive RON amount.");
    const amount = window.ethers.parseEther(value);
    if (amount <= 0n) throw new Error("Enter a positive RON amount.");
    return amount;
  }

  function withGasBuffer(gas) {
    return (gas * GAS_BUFFER_BPS + BPS - 1n) / BPS;
  }

  async function ensureRonin(provider) {
    const current = String(await provider.request({ method: "eth_chainId" })).toLowerCase();
    if (current !== CHAIN_HEX) {
      await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN_HEX }] });
    }
  }

  async function connectWallet() {
    if (state.account) {
      await refreshQuote();
      return;
    }
    const injected = walletProvider();
    if (!injected) throw new Error("Ronin Wallet was not detected.");
    const accounts = await injected.request({ method: "eth_requestAccounts" });
    if (!accounts?.[0]) throw new Error("No wallet account was approved.");
    await ensureRonin(injected);

    state.browserProvider = new window.ethers.BrowserProvider(injected);
    state.signer = await state.browserProvider.getSigner();
    state.account = await state.signer.getAddress();
    state.token = new window.ethers.Contract(MATT, TOKEN_ABI, state.signer);
    state.manager = new window.ethers.Contract(POSITION_MANAGER, POSITION_MANAGER_ABI, state.signer);

    $("#wallet-button").textContent = shortAddress(state.account);
    setStatus("Ronin Wallet connected. Reading the live pool quote.", "good");
    await refreshQuote();
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
      throw new Error("The configured pool tokens do not match MATT/WRON.");
    }
    if (poolFactory.toLowerCase() !== FACTORY.toLowerCase()
      || managerFactory.toLowerCase() !== FACTORY.toLowerCase()) {
      throw new Error("The pool and position manager do not share the expected Katana factory.");
    }
    if (wrapped.toLowerCase() !== WRON.toLowerCase()
      || Number(fee) !== FEE
      || Number(spacing) !== TICK_SPACING) {
      throw new Error("The Katana pool configuration changed. Minting is locked.");
    }
  }

  async function refreshQuote() {
    if (!state.readPool) return;
    const ronAmount = parseRonAmount();
    const slippageBps = math.parsePercentToBps($("#slippage").value);
    setQuoteState("REFRESHING LIVE POOL");
    $("#quote-ron").textContent = `${formatAmount(ronAmount, 6)} RON`;

    const [slot0, ronBalance, mattBalance] = await Promise.all([
      state.readPool.slot0(),
      state.account ? state.readProvider.getBalance(state.account) : 0n,
      state.account ? state.readToken.balanceOf(state.account) : 0n
    ]);
    if (!slot0.unlocked) throw new Error("The pool is temporarily locked.");

    const mattDesired = math.quoteMattForWron(ronAmount, slot0.sqrtPriceX96);
    const quote = {
      ronAmount,
      mattDesired,
      amount0Min: math.minimumAmount(mattDesired, slippageBps),
      amount1Min: math.minimumAmount(ronAmount, slippageBps),
      slippageBps,
      sqrtPriceX96: BigInt(slot0.sqrtPriceX96),
      tick: Number(slot0.tick),
      ronBalance,
      mattBalance,
      quotedAt: Date.now()
    };
    state.quote = quote;

    const mattPerRon = Number(window.ethers.formatEther(mattDesired))
      / Number(window.ethers.formatEther(ronAmount));
    $("#quote-matt").textContent = `${formatAmount(mattDesired, 2)} MATT`;
    $("#quote-price").textContent = `${compact(mattPerRon, 2)} MATT / RON`;
    $("#wallet-ron").textContent = state.account ? `${formatAmount(ronBalance, 4)} RON` : "Connect wallet";
    $("#wallet-matt").textContent = state.account ? `${formatAmount(mattBalance, 2)} MATT` : "Connect wallet";

    const hasRon = state.account && ronBalance >= ronAmount + GAS_RESERVE;
    const hasMatt = state.account && mattBalance >= mattDesired;
    setQuoteState("LIVE QUOTE READY", "live");

    const button = $("#create-position");
    if (!state.account) {
      button.disabled = true;
      button.textContent = "CONNECT RONIN FIRST";
      setStatus("Connect your Ronin Wallet to begin.");
    } else if (!hasRon) {
      button.disabled = true;
      button.textContent = "NOT ENOUGH RON";
      setStatus(`Keep at least 0.25 RON above the ${formatAmount(ronAmount, 6)} RON position amount for gas.`, "bad");
    } else if (!hasMatt) {
      button.disabled = true;
      button.textContent = "NOT ENOUGH MATT";
      setStatus(`This quote requires approximately ${formatAmount(mattDesired, 2)} MATT.`, "bad");
    } else {
      button.disabled = false;
      button.textContent = "CREATE FULL-RANGE POSITION";
      setStatus("Ready. You will confirm an exact MATT approval if needed, then the Katana mint.");
    }
  }

  async function createPosition() {
    if (!state.account || !state.signer || !state.manager || !state.token) {
      throw new Error("Connect Ronin Wallet first.");
    }
    if (state.busy) return;
    state.busy = true;
    $("#create-position").disabled = true;

    try {
      setStatus("Refreshing the pool price before preparing transactions.");
      await refreshQuote();
      const quote = state.quote;
      if (!quote) throw new Error("A live quote is required.");
      if (quote.ronBalance < quote.ronAmount + GAS_RESERVE) throw new Error("Insufficient RON balance.");
      if (quote.mattBalance < quote.mattDesired) throw new Error("Insufficient MATT balance.");

      const allowance = await state.token.allowance(state.account, POSITION_MANAGER);
      if (allowance < quote.mattDesired) {
        setStatus(`Confirm the exact ${formatAmount(quote.mattDesired, 2)} MATT approval in Ronin Wallet.`);
        const approvalGas = await state.token.approve.estimateGas(POSITION_MANAGER, quote.mattDesired);
        const approval = await state.token.approve(POSITION_MANAGER, quote.mattDesired, {
          gasLimit: withGasBuffer(approvalGas)
        });
        setStatus(`MATT approval submitted: ${shortAddress(approval.hash)}. Waiting for confirmation.`);
        await approval.wait(1);
      }

      const deadline = Math.floor(Date.now() / 1_000) + DEADLINE_SECONDS;
      const params = {
        token0: MATT,
        token1: WRON,
        fee: FEE,
        tickLower: TICK_LOWER,
        tickUpper: TICK_UPPER,
        amount0Desired: quote.mattDesired,
        amount1Desired: quote.ronAmount,
        amount0Min: quote.amount0Min,
        amount1Min: quote.amount1Min,
        recipient: state.account,
        deadline
      };
      const mintData = state.manager.interface.encodeFunctionData("mint", [params]);
      const refundData = state.manager.interface.encodeFunctionData("refundETH");
      const calls = [mintData, refundData];

      setStatus(`Confirm the ${formatAmount(quote.ronAmount, 6)} RON full-range mint in Ronin Wallet.`);
      const mintGas = await state.manager.multicall.estimateGas(calls, { value: quote.ronAmount });
      const transaction = await state.manager.multicall(calls, {
        value: quote.ronAmount,
        gasLimit: withGasBuffer(mintGas)
      });
      setStatus(`Position submitted: ${shortAddress(transaction.hash)}. Waiting for confirmation.`);
      const receipt = await transaction.wait(1);
      const increase = receipt.logs
        .map(log => {
          try { return state.manager.interface.parseLog(log); } catch { return null; }
        })
        .find(log => log?.name === "IncreaseLiquidity");
      const tokenId = increase?.args?.tokenId;
      const transactionUrl = `https://app.roninchain.com/tx/${transaction.hash}`;
      const success = tokenId
        ? `Full-range position #${tokenId} minted successfully.`
        : "Full-range position minted successfully.";
      $("#action-status").innerHTML = `${success} <a href="${transactionUrl}" target="_blank" rel="noopener">View transaction ↗</a>`;
      $("#action-status").className = "action-status good";
    } finally {
      state.busy = false;
      await refreshQuote().catch(() => {
        $("#create-position").disabled = true;
      });
    }
  }

  function runAction(action) {
    return async event => {
      event?.preventDefault();
      try {
        await action();
      } catch (error) {
        setQuoteState("ACTION NEEDS ATTENTION", "bad");
        setStatus(errorMessage(error), "bad");
      }
    };
  }

  $("#wallet-button").addEventListener("click", runAction(connectWallet));
  $("#liquidity-form").addEventListener("submit", runAction(refreshQuote));
  $("#create-position").addEventListener("click", runAction(createPosition));
  $("#ron-amount").addEventListener("input", () => {
    state.quote = null;
    $("#create-position").disabled = true;
    setQuoteState("QUOTE CHANGED");
    setStatus("Refresh the live quote after changing the amount.");
  });
  $("#slippage").addEventListener("input", () => {
    state.quote = null;
    $("#create-position").disabled = true;
    setQuoteState("QUOTE CHANGED");
    setStatus("Refresh the live quote after changing the price limit.");
  });

  const injected = walletProvider();
  if (injected?.on) {
    injected.on("accountsChanged", () => window.location.reload());
    injected.on("chainChanged", () => window.location.reload());
  }

  initializeReads()
    .then(refreshQuote)
    .catch(error => {
      setQuoteState("MINTING LOCKED", "bad");
      setStatus(errorMessage(error), "bad");
    });
})();
