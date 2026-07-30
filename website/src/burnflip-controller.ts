type Address = `0x${string}`;

interface BurnFlipAsset {
  symbol: string;
  address: Address;
  decimals: number;
  native: boolean;
  enabled: boolean;
  disabledReason?: string;
}

interface BurnFlipConfig {
  chainId: number;
  version: string;
  tokenAddress: Address;
  contractAddress: Address | null;
  deploymentBlock: number | null;
  treasuryAddress: Address;
  explorerAddressBase: string;
  burnEdition: boolean;
  assets: readonly BurnFlipAsset[];
}

interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

interface RoninConnection {
  account?: string | null;
  provider?: Eip1193Provider | null;
  connect?: () => Promise<unknown>;
}

interface AppWindow extends Window {
  MATT_COIN_FLIP_CONFIG?: BurnFlipConfig;
  MattRoninConnect?: RoninConnection;
  currentAccount?: string | null;
  walletConnectProvider?: Eip1193Provider | null;
}

interface AbiInterface {
  encodeFunctionData(name: string, values?: readonly unknown[]): string;
  decodeFunctionResult(name: string, data: string): Record<string, unknown> & ArrayLike<unknown>;
}

interface EthersApi {
  Interface: new (abi: readonly string[]) => AbiInterface;
  AbiCoder: { defaultAbiCoder(): { encode(types: readonly string[], values: readonly unknown[]): string } };
  ZeroAddress: Address;
  formatUnits(value: bigint, decimals?: number): string;
  parseUnits(value: string, decimals?: number): bigint;
  keccak256(value: string): string;
  hexlify(value: Uint8Array): string;
}

interface RpcReceipt {
  status?: string;
  transactionHash?: string;
}

interface ActiveBet {
  player: Address;
  asset: Address;
  wagerAmount: bigint;
  mattEquivalent: bigint;
  payoutAmount: bigint;
  burnAmount: bigint;
  entropyBlock: number;
  deadline: number;
  meanTick: number;
  choice: number;
  state: number;
  commitment: string;
}

interface Quote {
  mattEquivalent: bigint;
  tick: number;
  liquidity: bigint;
  pool: Address;
  payout: bigint;
  burn: bigint;
}

(() => {
  "use strict";

  const appWindow = window as AppWindow;
  const config = appWindow.MATT_COIN_FLIP_CONFIG as BurnFlipConfig;
  if (!config?.burnEdition) return;

  const GAME_ABI = [
    "function activeBetOf(address) view returns (uint256)",
    "function bets(uint256) view returns (address player,address asset,uint256 wagerAmount,uint256 mattEquivalent,uint256 payoutAmount,uint256 burnAmount,uint64 entropyBlock,uint64 revealDeadlineBlock,int24 meanTick,uint8 choice,uint8 state,bytes32 commitment)",
    "function assetConfigs(address) view returns (address pool,uint128 minHarmonicLiquidity,bool supported)",
    "function availableRewardBalance() view returns (uint256)",
    "function burnBps() view returns (uint16)",
    "function payoutMultiplierBps() view returns (uint32)",
    "function paused() view returns (bool)",
    "function quoteMatt(address asset,uint256 amount) view returns (uint256 mattEquivalent,int24 arithmeticMeanTick,uint128 harmonicMeanLiquidity,address pool)",
    "function placeBet(address asset,uint8 choice,uint256 amount,bytes32 commitment) returns (uint256)",
    "function placeRonBet(uint8 choice,bytes32 commitment) payable returns (uint256)",
    "function revealAndSettle(uint256 betId,bytes32 secret) returns (bool)",
    "function expireBet(uint256 betId)"
  ] as const;
  const TOKEN_ABI = [
    "function balanceOf(address) view returns (uint256)",
    "function allowance(address,address) view returns (uint256)",
    "function approve(address,uint256) returns (bool)"
  ] as const;
  const ETHERS_URL = "https://esm.sh/ethers@6.13.5?bundle";
  const TX_POLL_MS = 900;
  const ACTIVE_POLL_MS = 2_500;
  const IDLE_POLL_MS = 15_000;
  const TX_TIMEOUT_MS = 180_000;
  const ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;

  function byId<T extends HTMLElement>(id: string): T {
    const element = document.getElementById(id);
    if (!element) throw new Error(`Missing BurnFlip element #${id}`);
    return element as T;
  }

  const actionButton = byId<HTMLButtonElement>("flip-button");
  const expireButton = byId<HTMLButtonElement>("coin-expire-bet");
  const progress = byId<HTMLElement>("coin-game-progress");
  const amountInput = byId<HTMLInputElement>("coin-bet-amount");
  const assetSelect = byId<HTMLSelectElement>("burnflip-asset");
  const legalConfirm = byId<HTMLInputElement>("coin-legal-confirm");
  const balanceDisplay = byId<HTMLElement>("coin-wallet-balance");
  const vaultDisplay = byId<HTMLElement>("coin-bankroll");
  const selectedDisplay = byId<HTMLElement>("burnflip-selected-asset");
  const amountSymbol = byId<HTMLElement>("burnflip-amount-symbol");
  const mattValueDisplay = byId<HTMLElement>("burnflip-matt-value");
  const payoutDisplay = byId<HTMLElement>("burnflip-payout");
  const burnDisplay = byId<HTMLElement>("burnflip-burn");
  const confirmDialog = byId<HTMLDialogElement>("burnflip-confirm-dialog");
  const confirmSummary = byId<HTMLElement>("burnflip-confirm-summary");
  const resultCard = byId<HTMLElement>("burnflip-result-card");
  const resultTitle = byId<HTMLElement>("burnflip-result-title");
  const resultSummary = byId<HTMLElement>("burnflip-result-summary");
  const coin = byId<HTMLElement>("coin");
  const resultText = byId<HTMLElement>("flip-result");
  const flowSteps = new Map(
    [...document.querySelectorAll<HTMLElement>(".coin-game-step")]
      .map((element) => [element.dataset.step || "", element]),
  );

  let ethersApi: EthersApi;
  let game: AbiInterface;
  let token: AbiInterface;
  let busy = false;
  let syncing = false;
  let refreshTimer: number | null = null;
  let quoteTimer: number | null = null;
  let activeBetId = 0n;
  let activeBet: ActiveBet | null = null;
  let activeSecret: string | null = null;
  let walletBalance = 0n;
  let currentQuote: Quote | null = null;
  let burnBps = 7_500n;
  let payoutBps = 20_000n;

  const sleep = (milliseconds: number) =>
    new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));

  function account(): Address | null {
    const value = appWindow.MattRoninConnect?.account || appWindow.currentAccount;
    return ADDRESS_PATTERN.test(String(value || ""))
      ? String(value).toLowerCase() as Address
      : null;
  }

  function provider(): Eip1193Provider | null {
    return appWindow.MattRoninConnect?.provider
      || appWindow.walletConnectProvider
      || null;
  }

  function selectedAsset(): BurnFlipAsset {
    const asset = config.assets.find(
      (candidate) => candidate.address.toLowerCase() === assetSelect.value.toLowerCase(),
    );
    if (!asset) throw new Error("Select a supported wager asset.");
    return asset;
  }

  function selectedChoice(): number {
    return document.querySelector<HTMLElement>(".choice.active")?.dataset.choice === "tails"
      ? 1
      : 0;
  }

  function setStatus(message: string, type = ""): void {
    progress.textContent = message;
    progress.className = `coin-game-progress${type ? ` ${type}` : ""}`;
  }

  function setFlow(active: string | null, complete: string[] = []): void {
    for (const [name, element] of flowSteps) {
      element.classList.toggle("active", name === active);
      element.classList.toggle("complete", complete.includes(name));
    }
  }

  function friendly(error: unknown): string {
    const candidate = error as { shortMessage?: string; reason?: string; message?: string };
    const message = String(
      candidate?.shortMessage || candidate?.reason || candidate?.message || error || "Unknown error",
    );
    if (/user rejected|user denied|4001|action_rejected/i.test(message)) return "Wallet request cancelled.";
    if (/insufficient funds|gas/i.test(message)) return "This wallet needs enough RON for the wager and gas.";
    if (/UnsupportedAsset/i.test(message)) return "That asset is not currently enabled for BurnFlip.";
    if (/InsufficientRewardVault/i.test(message)) return "The Reward Vault cannot cover that potential payout.";
    if (/OracleLiquidityTooLow/i.test(message)) return "This asset is temporarily unavailable because TWAP liquidity is below its safety floor.";
    if (/OLD|I|observe|oracle/i.test(message) && /revert|call/i.test(message)) return "This asset is waiting for enough Katana V3 TWAP history.";
    if (/ActiveBetExists/i.test(message)) return "This wallet already has a pending BurnFlip.";
    if (/RevealWindowClosed/i.test(message)) return "The reveal window closed. Settle the expired bet as a loss.";
    return message.replace(/execution reverted:?/i, "").trim().slice(0, 240);
  }

  async function rpc(method: string, params: unknown[] = []): Promise<unknown> {
    const response = await fetch("/api/rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: crypto.randomUUID(),
        method,
        params,
      }),
    });
    const payload = await response.json() as {
      result?: unknown;
      error?: { message?: string };
    };
    if (!response.ok || payload.error) {
      throw new Error(payload.error?.message || `Ronin RPC returned HTTP ${response.status}`);
    }
    return payload.result;
  }

  async function read(
    address: Address,
    iface: AbiInterface,
    name: string,
    args: readonly unknown[] = [],
  ): Promise<Record<string, unknown> & ArrayLike<unknown>> {
    const data = iface.encodeFunctionData(name, args);
    const raw = await rpc("eth_call", [{ to: address, data }, "latest"]);
    return iface.decodeFunctionResult(name, String(raw));
  }

  function decoded<T>(value: Record<string, unknown> & ArrayLike<unknown>, name: string, index: number): T {
    return (value[name] ?? value[index]) as T;
  }

  async function currentBlock(): Promise<number> {
    return Number(BigInt(String(await rpc("eth_blockNumber"))));
  }

  async function getActive(owner: Address): Promise<bigint> {
    if (!config.contractAddress) return 0n;
    return BigInt(decoded(await read(
      config.contractAddress,
      game,
      "activeBetOf",
      [owner],
    ), "0", 0));
  }

  async function readBet(betId: bigint): Promise<ActiveBet> {
    if (!config.contractAddress) throw new Error("BurnFlip is not deployed.");
    const value = await read(config.contractAddress, game, "bets", [betId]);
    return {
      player: decoded<string>(value, "player", 0) as Address,
      asset: decoded<string>(value, "asset", 1) as Address,
      wagerAmount: BigInt(decoded(value, "wagerAmount", 2)),
      mattEquivalent: BigInt(decoded(value, "mattEquivalent", 3)),
      payoutAmount: BigInt(decoded(value, "payoutAmount", 4)),
      burnAmount: BigInt(decoded(value, "burnAmount", 5)),
      entropyBlock: Number(decoded(value, "entropyBlock", 6)),
      deadline: Number(decoded(value, "revealDeadlineBlock", 7)),
      meanTick: Number(decoded(value, "meanTick", 8)),
      choice: Number(decoded(value, "choice", 9)),
      state: Number(decoded(value, "state", 10)),
      commitment: String(decoded(value, "commitment", 11)),
    };
  }

  function formatAmount(value: bigint, asset: BurnFlipAsset, precision = 6): string {
    const [whole, decimals = ""] = ethersApi.formatUnits(value, asset.decimals).split(".");
    const fraction = decimals.slice(0, precision).replace(/0+$/, "");
    return `${BigInt(whole || "0").toLocaleString()}${fraction ? `.${fraction}` : ""} ${asset.symbol}`;
  }

  function formatMatt(value: bigint, precision = 2): string {
    const [whole, decimals = ""] = ethersApi.formatUnits(value, 18).split(".");
    const fraction = decimals.slice(0, precision).replace(/0+$/, "");
    return `${BigInt(whole || "0").toLocaleString()}${fraction ? `.${fraction}` : ""} MATT`;
  }

  function assetFor(address: Address): BurnFlipAsset {
    return config.assets.find(
      (asset) => asset.address.toLowerCase() === address.toLowerCase(),
    ) || {
      symbol: "ASSET",
      address,
      decimals: 18,
      native: false,
      enabled: true,
    };
  }

  function secretKey(owner: Address, betId: bigint): string {
    return `mattBurnFlipV2:${config.contractAddress}:${owner}:${betId}`;
  }

  function pendingKey(owner: Address, commitment: string): string {
    return `mattBurnFlipV2Pending:${config.contractAddress}:${owner}:${commitment}`;
  }

  async function tokenBalance(owner: Address, asset: BurnFlipAsset): Promise<bigint> {
    if (asset.native) {
      return BigInt(String(await rpc("eth_getBalance", [owner, "latest"])));
    }
    return BigInt(decoded(await read(
      asset.address,
      token,
      "balanceOf",
      [owner],
    ), "0", 0));
  }

  async function allowance(owner: Address, asset: BurnFlipAsset): Promise<bigint> {
    if (asset.native || !config.contractAddress) return 0n;
    return BigInt(decoded(await read(
      asset.address,
      token,
      "allowance",
      [owner, config.contractAddress],
    ), "0", 0));
  }

  function scheduleSync(delay: number): void {
    if (refreshTimer != null) window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(
      () => void syncState({ preserveMessage: busy }),
      document.hidden ? Math.max(delay, 30_000) : delay,
    );
  }

  async function waitForTransaction(
    response: unknown,
    label: string,
    probe: () => Promise<boolean>,
  ): Promise<RpcReceipt | null> {
    const value = response as { hash?: string; transactionHash?: string } | string;
    const hash = typeof value === "string"
      ? value
      : value?.hash || value?.transactionHash || null;
    const started = Date.now();
    while (Date.now() - started < TX_TIMEOUT_MS) {
      if (hash && /^0x[a-fA-F0-9]{64}$/.test(hash)) {
        const receipt = await rpc("eth_getTransactionReceipt", [hash]) as RpcReceipt | null;
        if (receipt) {
          if (BigInt(receipt.status || "0x0") !== 1n) {
            throw new Error(`${label} transaction reverted.`);
          }
          return receipt;
        }
      } else if (await probe()) {
        return null;
      }
      await sleep(TX_POLL_MS);
    }
    throw new Error(`${label} was not confirmed in time. Refresh to resume from on-chain state.`);
  }

  async function sendTransaction(args: {
    to: Address;
    data: string;
    value?: bigint;
    label: string;
    probe: () => Promise<boolean>;
  }): Promise<RpcReceipt | null> {
    const owner = account();
    const wallet = provider();
    if (!owner || !wallet) throw new Error("Connect Ronin Wallet first.");
    setStatus(`Open Ronin Wallet and confirm ${args.label}.`);
    const response = await wallet.request({
      method: "eth_sendTransaction",
      params: [{
        from: owner,
        to: args.to,
        data: args.data,
        value: `0x${(args.value || 0n).toString(16)}`,
      }],
    });
    return waitForTransaction(response, args.label, args.probe);
  }

  async function refreshQuote(): Promise<void> {
    const owner = account();
    const asset = selectedAsset();
    selectedDisplay.textContent = asset.symbol;
    amountSymbol.textContent = asset.symbol;
    if (!asset.enabled) {
      currentQuote = null;
      setStatus(asset.disabledReason || `${asset.symbol} is unavailable.`, "error");
      actionButton.disabled = true;
      return;
    }
    if (!owner || !config.contractAddress) return;

    walletBalance = await tokenBalance(owner, asset);
    balanceDisplay.textContent = formatAmount(walletBalance, asset);
    let amount: bigint;
    try {
      amount = ethersApi.parseUnits(amountInput.value || "0", asset.decimals);
    } catch {
      currentQuote = null;
      mattValueDisplay.textContent = "Enter a valid amount";
      return;
    }
    if (amount <= 0n) {
      currentQuote = null;
      mattValueDisplay.textContent = "—";
      payoutDisplay.textContent = "—";
      burnDisplay.textContent = "—";
      return;
    }

    const raw = await read(config.contractAddress, game, "quoteMatt", [
      asset.address,
      amount,
    ]);
    const mattEquivalent = BigInt(decoded(raw, "mattEquivalent", 0));
    currentQuote = {
      mattEquivalent,
      tick: Number(decoded(raw, "arithmeticMeanTick", 1)),
      liquidity: BigInt(decoded(raw, "harmonicMeanLiquidity", 2)),
      pool: decoded<string>(raw, "pool", 3) as Address,
      payout: mattEquivalent * payoutBps / 10_000n,
      burn: mattEquivalent * burnBps / 10_000n,
    };
    mattValueDisplay.textContent = formatMatt(currentQuote.mattEquivalent);
    payoutDisplay.textContent = formatMatt(currentQuote.payout);
    burnDisplay.textContent = formatMatt(currentQuote.burn);
  }

  async function refreshSummary(owner: Address): Promise<boolean> {
    if (!config.contractAddress) return true;
    const [available, pausedRaw, burnRaw, payoutRaw] = await Promise.all([
      read(config.contractAddress, game, "availableRewardBalance"),
      read(config.contractAddress, game, "paused"),
      read(config.contractAddress, game, "burnBps"),
      read(config.contractAddress, game, "payoutMultiplierBps"),
    ]);
    burnBps = BigInt(decoded(burnRaw, "0", 0));
    payoutBps = BigInt(decoded(payoutRaw, "0", 0));
    vaultDisplay.textContent = formatMatt(BigInt(decoded(available, "0", 0)));
    await refreshQuote();
    return Boolean(decoded(pausedRaw, "0", 0));
  }

  async function syncState({ preserveMessage = false } = {}): Promise<void> {
    if (syncing || !ethersApi) return;
    syncing = true;
    try {
      const owner = account();
      if (!config.contractAddress) {
        actionButton.textContent = "DEPLOYMENT PENDING";
        actionButton.disabled = true;
        setStatus("Universal BurnFlip is staged but not yet deployed. The existing live contract is unchanged.", "error");
        return;
      }
      if (!owner || !provider()) {
        actionButton.textContent = "CONNECT RONIN";
        actionButton.disabled = false;
        balanceDisplay.textContent = "Connect wallet";
        if (!preserveMessage) setStatus("Connect Ronin Wallet to enter BurnFlip.");
        setFlow("commit");
        return;
      }

      activeBetId = await getActive(owner);
      if (activeBetId === 0n) {
        activeBet = null;
        activeSecret = null;
        expireButton.hidden = true;
        const paused = await refreshSummary(owner);
        actionButton.textContent = paused ? "BURNFLIP PAUSED" : "REVIEW BURNFLIP";
        actionButton.disabled = paused || busy || !selectedAsset().enabled;
        if (!preserveMessage && !busy) {
          setStatus(paused
            ? "BurnFlip is paused by the administrator."
            : "Live Katana V3 TWAP loaded. Review your wager when ready.");
        }
        setFlow("commit");
        return;
      }

      activeBet = await readBet(activeBetId);
      const block = await currentBlock();
      activeSecret = localStorage.getItem(secretKey(owner, activeBetId))
        || localStorage.getItem(pendingKey(owner, activeBet.commitment));
      const asset = assetFor(activeBet.asset);
      selectedDisplay.textContent = asset.symbol;
      mattValueDisplay.textContent = formatMatt(activeBet.mattEquivalent);
      payoutDisplay.textContent = formatMatt(activeBet.payoutAmount);
      burnDisplay.textContent = formatMatt(activeBet.burnAmount);

      if (block <= activeBet.entropyBlock) {
        actionButton.textContent = `BET #${activeBetId} CONFIRMED`;
        actionButton.disabled = true;
        setStatus(
          `The treasury received ${formatAmount(activeBet.wagerAmount, asset)}. Waiting for Ronin block ${activeBet.entropyBlock.toLocaleString()}…`,
          "good",
        );
        setFlow("block", ["commit"]);
      } else if (block <= activeBet.deadline) {
        actionButton.textContent = "REVEAL & SETTLE";
        actionButton.disabled = busy || !activeSecret;
        setStatus(activeSecret
          ? `Bet #${activeBetId} is ready to reveal.`
          : `Bet #${activeBetId} is ready, but its local secret is missing.`,
        activeSecret ? "good" : "error");
        setFlow("reveal", ["commit", "block"]);
      } else {
        actionButton.textContent = "REVEAL WINDOW EXPIRED";
        actionButton.disabled = true;
        expireButton.hidden = false;
        expireButton.disabled = busy;
        setStatus(
          `Bet #${activeBetId} expired. Settlement burns ${formatMatt(activeBet.burnAmount)}.`,
          "error",
        );
        setFlow(null, ["commit", "block"]);
      }
    } catch (error) {
      if (!busy) setStatus(friendly(error), "error");
    } finally {
      syncing = false;
      scheduleSync(activeBetId === 0n ? IDLE_POLL_MS : ACTIVE_POLL_MS);
    }
  }

  function confirmationMarkup(asset: BurnFlipAsset, amount: bigint, quote: Quote): string {
    return `
      <div><dt>Asset</dt><dd>${formatAmount(amount, asset)}</dd></div>
      <div><dt>Current MATT value</dt><dd>${formatMatt(quote.mattEquivalent)}</dd></div>
      <div><dt>Potential payout</dt><dd>${formatMatt(quote.payout)}</dd></div>
      <div><dt>Potential burn</dt><dd>${formatMatt(quote.burn)}</dd></div>
      <div><dt>Treasury</dt><dd>${config.treasuryAddress.slice(0, 8)}…${config.treasuryAddress.slice(-6)}</dd></div>
    `;
  }

  async function confirmWager(asset: BurnFlipAsset, amount: bigint, quote: Quote): Promise<boolean> {
    confirmSummary.innerHTML = confirmationMarkup(asset, amount, quote);
    confirmDialog.showModal();
    return new Promise<boolean>((resolve) => {
      confirmDialog.addEventListener("close", () => {
        resolve(confirmDialog.returnValue === "confirm");
      }, { once: true });
    });
  }

  async function placeBet(): Promise<void> {
    const owner = account();
    if (!owner || !config.contractAddress) throw new Error("Connect Ronin Wallet first.");
    if (!legalConfirm.checked) {
      throw new Error("Confirm the age, jurisdiction, and treasury acknowledgement first.");
    }
    const asset = selectedAsset();
    const amount = ethersApi.parseUnits(amountInput.value || "0", asset.decimals);
    if (amount <= 0n) throw new Error("Enter a wager amount.");
    if (amount > walletBalance) throw new Error(`Your wallet does not hold that much ${asset.symbol}.`);
    await refreshQuote();
    const quote = currentQuote;
    if (!quote) throw new Error("A safe Katana V3 TWAP quote is not available.");
    if (!(await confirmWager(asset, amount, quote))) throw new Error("Wager confirmation cancelled.");

    const secret = ethersApi.hexlify(crypto.getRandomValues(new Uint8Array(32)));
    const choice = selectedChoice();
    const commitment = ethersApi.keccak256(
      ethersApi.AbiCoder.defaultAbiCoder().encode(
        ["bytes32", "address", "address", "uint8", "uint256", "address", "uint256"],
        [secret, owner, asset.address, choice, amount, config.contractAddress, BigInt(config.chainId)],
      ),
    );
    localStorage.setItem(pendingKey(owner, commitment), secret);

    if (!asset.native && await allowance(owner, asset) < amount) {
      await sendTransaction({
        to: asset.address,
        data: token.encodeFunctionData("approve", [config.contractAddress, amount]),
        label: `${asset.symbol} approval`,
        probe: async () => await allowance(owner, asset) >= amount,
      });
    }

    const before = activeBetId;
    await sendTransaction({
      to: config.contractAddress,
      data: asset.native
        ? game.encodeFunctionData("placeRonBet", [choice, commitment])
        : game.encodeFunctionData("placeBet", [asset.address, choice, amount, commitment]),
      value: asset.native ? amount : 0n,
      label: `${asset.symbol} BurnFlip wager`,
      probe: async () => await getActive(owner) !== before,
    });

    const betId = await getActive(owner);
    if (betId === 0n) throw new Error("The BurnFlip bet was not detected on-chain.");
    localStorage.setItem(secretKey(owner, betId), secret);
    localStorage.removeItem(pendingKey(owner, commitment));
    activeBetId = betId;
    setStatus(`Bet #${betId} confirmed. ${formatAmount(amount, asset)} reached the treasury.`, "good");
  }

  function showResult(betId: bigint, bet: ActiveBet): void {
    const asset = assetFor(bet.asset);
    const won = bet.state === 2;
    resultCard.hidden = false;
    resultCard.classList.toggle("win", won);
    resultCard.classList.toggle("loss", !won);
    resultTitle.textContent = won ? "WIN" : "LOSS";
    resultSummary.innerHTML = `
      <div><dt>Asset</dt><dd>${formatAmount(bet.wagerAmount, asset)}</dd></div>
      <div><dt>Value</dt><dd>${formatMatt(bet.mattEquivalent)}</dd></div>
      <div><dt>Result</dt><dd>${won ? "WIN" : "LOSS"}</dd></div>
      <div><dt>${won ? "Paid" : "Burned"}</dt><dd>${formatMatt(won ? bet.payoutAmount : bet.burnAmount)}</dd></div>
      <div><dt>Treasury received</dt><dd>${formatAmount(bet.wagerAmount, asset)}</dd></div>
    `;
    resultText.className = won ? "result win" : "result burn-result";
    resultText.textContent = won
      ? `BET #${betId} — ${formatMatt(bet.payoutAmount)} PAID`
      : `BET #${betId} — ${formatMatt(bet.burnAmount)} BURNED`;
    coin.classList.remove("flipping");
    void coin.offsetWidth;
    coin.classList.add("flipping");
  }

  async function revealBet(): Promise<void> {
    const owner = account();
    if (!owner || !config.contractAddress || !activeBet || !activeSecret) {
      throw new Error("The pending bet or reveal secret is unavailable.");
    }
    const betId = activeBetId;
    const before = activeBet;
    await sendTransaction({
      to: config.contractAddress,
      data: game.encodeFunctionData("revealAndSettle", [betId, activeSecret]),
      label: `reveal for bet #${betId}`,
      probe: async () => await getActive(owner) === 0n,
    });
    localStorage.removeItem(secretKey(owner, betId));
    const settled = await readBet(betId);
    showResult(betId, settled);
    activeBetId = 0n;
    activeBet = null;
    activeSecret = null;
    setStatus(
      settled.state === 2
        ? `Bet #${betId} settled. MATT was paid from the Reward Vault.`
        : `Bet #${betId} settled. MATT was permanently burned from the Reward Vault.`,
      "good",
    );
    appWindow.dispatchEvent(new CustomEvent("matt:burnflip-updated", {
      detail: { account: owner, betId: betId.toString(), previous: before },
    }));
  }

  async function expireBet(): Promise<void> {
    const owner = account();
    if (!owner || !config.contractAddress || !activeBet) {
      throw new Error("No expired BurnFlip is available.");
    }
    const betId = activeBetId;
    await sendTransaction({
      to: config.contractAddress,
      data: game.encodeFunctionData("expireBet", [betId]),
      label: `expired settlement for bet #${betId}`,
      probe: async () => await getActive(owner) === 0n,
    });
    localStorage.removeItem(secretKey(owner, betId));
    const settled = await readBet(betId);
    showResult(betId, settled);
    activeBetId = 0n;
    activeBet = null;
    activeSecret = null;
    appWindow.dispatchEvent(new CustomEvent("matt:burnflip-updated"));
  }

  actionButton.addEventListener("click", () => {
    if (busy) return;
    if (!account() || !provider()) {
      void appWindow.MattRoninConnect?.connect?.();
      return;
    }
    busy = true;
    actionButton.disabled = true;
    void (activeBetId === 0n ? placeBet() : revealBet())
      .catch((error: unknown) => setStatus(friendly(error), "error"))
      .finally(async () => {
        busy = false;
        await syncState({ preserveMessage: true });
      });
  });

  expireButton.addEventListener("click", () => {
    if (busy) return;
    busy = true;
    void expireBet()
      .catch((error: unknown) => setStatus(friendly(error), "error"))
      .finally(async () => {
        busy = false;
        await syncState({ preserveMessage: true });
      });
  });

  function queueQuote(): void {
    if (quoteTimer != null) window.clearTimeout(quoteTimer);
    quoteTimer = window.setTimeout(() => {
      void refreshQuote().catch((error: unknown) => {
        currentQuote = null;
        mattValueDisplay.textContent = "Unavailable";
        payoutDisplay.textContent = "—";
        burnDisplay.textContent = "—";
        setStatus(friendly(error), "error");
      });
    }, 300);
  }

  assetSelect.addEventListener("change", () => {
    const asset = selectedAsset();
    amountInput.value = asset.symbol === "USDC" ? "10" : "1";
    queueQuote();
  });
  amountInput.addEventListener("input", queueQuote);
  byId<HTMLButtonElement>("coin-bet-max").addEventListener("click", () => {
    const asset = selectedAsset();
    const maximum = asset.native ? walletBalance * 95n / 100n : walletBalance;
    amountInput.value = ethersApi.formatUnits(maximum, asset.decimals);
    queueQuote();
  });
  for (const button of document.querySelectorAll<HTMLButtonElement>(".choice[data-choice]")) {
    button.addEventListener("click", () => {
      for (const choice of document.querySelectorAll<HTMLButtonElement>(".choice[data-choice]")) {
        const active = choice === button;
        choice.classList.toggle("active", active);
        choice.setAttribute("aria-pressed", String(active));
      }
    });
  }

  appWindow.addEventListener("matt:wallet-connected", () => void syncState());
  appWindow.addEventListener("matt:wallet-disconnected", () => void syncState());
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void syncState({ preserveMessage: true });
  });

  void (async () => {
    try {
      const importer = new Function("url", "return import(url)") as
        (url: string) => Promise<EthersApi>;
      ethersApi = await importer(ETHERS_URL);
      game = new ethersApi.Interface(GAME_ABI);
      token = new ethersApi.Interface(TOKEN_ABI);
      await syncState();
    } catch (error) {
      setStatus(`BurnFlip controller failed to load: ${friendly(error)}`, "error");
      actionButton.disabled = true;
    }
  })();
})();
