"use strict";

const CONFIG = Object.freeze({
  chainId: 2020,
  chainHex: "0x7e4",
  rpc: "https://api.roninchain.com/rpc",
  explorer: "https://explorer.roninchain.com",
  contract: "0x048e792E32fc9E04bB47E9C5D8baCd41F4b0E425",
  deploymentTx: "0x0bee65ecab3282d0e3bb00a69d89de9a4b9942c41d3f3095c6b7ac0d26c86744",
  quoter: "0x84Ab2f9Fdc4Bf66312b0819D879437b8749EfDf2",
  matt: "0xa5450417BDCa0BDfB058ffE41205400FfDA1174d",
  coin: "0x7dc167e270d5EF683ceaf4aFCDf2efbDd667a9A7",
  wron: "0xe514d9DEB7966c8BE0ca922de8a064264eA6bcd4",
  ronke: "0xf988f63bf26C3Ed3fBf39922149E3E7b1e5c27cB",
});

const SELECTORS = Object.freeze({
  quoteExactInput: "cdca1753",
  balanceOf: "70a08231",
  allowance: "dd62ed3e",
  approve: "095ea7b3",
  executeRoundTrip: "82385584",
});
const ROUND_TRIP_COMPLETED_TOPIC = "0x748e91d008d4daff4d08a8cb007f96ae5a8559736ab5d1d29523a50312b7ce2d";

const HOPS = Object.freeze([
  [CONFIG.matt, 3000, CONFIG.coin],
  [CONFIG.coin, 3000, CONFIG.matt],
  [CONFIG.matt, 10000, CONFIG.wron],
  [CONFIG.wron, 10000, CONFIG.matt],
  [CONFIG.matt, 10000, CONFIG.wron],
  [CONFIG.wron, 10000, CONFIG.ronke],
  [CONFIG.ronke, 10000, CONFIG.wron],
  [CONFIG.wron, 10000, CONFIG.matt],
]);
const STAGES = Object.freeze([
  { hops: 1, symbol: "COIN", decimals: 18 },
  { hops: 2, symbol: "MATT", decimals: 18 },
  { hops: 3, symbol: "RON", decimals: 18 },
  { hops: 4, symbol: "MATT", decimals: 18 },
  { hops: 6, symbol: "RONKE", decimals: 18 },
  { hops: 8, symbol: "MATT", decimals: 18 },
]);

const DEPENDENCIES = [
  ["Token", "MATT", CONFIG.matt],
  ["Token", "COIN", CONFIG.coin],
  ["Wrapped native", "WRON", CONFIG.wron],
  ["Token", "RONKE", CONFIG.ronke],
  ["Katana", "AggregateRouter", "0x5f0acdd3ec767514ff1bf7e79949640bf94576bd"],
  ["Katana", "QuoterV2", CONFIG.quoter],
  ["V3 pool · 0.3%", "MATT / COIN", "0xeF38E70998e167d2e898AbFf84d4766CaE7C3A94"],
  ["V3 pool · 1%", "MATT / WRON", "0xa517E05e96728E80284F2aE157dDF309449D7cE8"],
  ["V3 pool · 1%", "WRON / RONKE", "0xCa5621172f2E176031D699E0A0f701C029D7BaC1"],
];

const $ = (id) => document.getElementById(id);
const state = { account: null, provider: null, quote: null, mattBalance: 0n, allowance: 0n, busy: false };
let toastTimer;

function strip0x(value) { return String(value).replace(/^0x/, ""); }
function word(value) { return BigInt(value).toString(16).padStart(64, "0"); }
function addressWord(value) { return strip0x(value).toLowerCase().padStart(64, "0"); }
function feeHex(value) { return Number(value).toString(16).padStart(6, "0"); }
function shortAddress(value) { return `${value.slice(0, 6)}…${value.slice(-4)}`; }

function parseUnits(value, decimals = 18) {
  const clean = String(value).trim();
  if (!/^\d+(\.\d*)?$/.test(clean)) throw new Error("Enter a valid positive amount.");
  const [whole, fraction = ""] = clean.split(".");
  if (fraction.length > decimals) throw new Error(`Use no more than ${decimals} decimal places.`);
  const result = BigInt(whole) * 10n ** BigInt(decimals)
    + BigInt((fraction + "0".repeat(decimals)).slice(0, decimals));
  if (result <= 0n) throw new Error("Amount must be greater than zero.");
  return result;
}

function formatUnits(value, decimals = 18, precision = 6) {
  const amount = BigInt(value);
  const base = 10n ** BigInt(decimals);
  const whole = amount / base;
  const fraction = (amount % base).toString().padStart(decimals, "0").slice(0, precision).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function formatNumber(value, maximumFractionDigits = 6) {
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value);
  return number.toLocaleString(undefined, { maximumFractionDigits });
}

function buildPath(hops) {
  let path = strip0x(hops[0][0]);
  for (const [from, fee, to] of hops) {
    if (strip0x(from).toLowerCase() !== path.slice(-40).toLowerCase()) throw new Error("Route configuration mismatch.");
    path += feeHex(fee) + strip0x(to);
  }
  return path.toLowerCase();
}

function encodeQuote(pathHex, amountIn) {
  const length = pathHex.length / 2;
  const paddedLength = Math.ceil(length / 32) * 64;
  return `0x${SELECTORS.quoteExactInput}${word(64)}${word(amountIn)}${word(length)}${pathHex.padEnd(paddedLength, "0")}`;
}

function encodeBalanceOf(owner) { return `0x${SELECTORS.balanceOf}${addressWord(owner)}`; }
function encodeAllowance(owner, spender) { return `0x${SELECTORS.allowance}${addressWord(owner)}${addressWord(spender)}`; }
function encodeApprove(spender, amount) { return `0x${SELECTORS.approve}${addressWord(spender)}${word(amount)}`; }
function encodeExecution(amount, minimums, deadline, recipient) {
  return `0x${SELECTORS.executeRoundTrip}${word(amount)}${minimums.map(word).join("")}${word(deadline)}${addressWord(recipient)}`;
}

async function publicRpc(method, params) {
  const response = await fetch(CONFIG.rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
  });
  if (!response.ok) throw new Error(`Ronin RPC returned ${response.status}.`);
  const payload = await response.json();
  if (payload.error) throw new Error(payload.error.message || "Ronin RPC request failed.");
  return payload.result;
}

async function rpc(method, params) {
  if (state.provider) return state.provider.request({ method, params });
  return publicRpc(method, params);
}

function injectedProvider() {
  return window.ronin?.provider || window.ronin || window.ethereum || null;
}

function toast(message, error = false) {
  const element = $("toast");
  element.textContent = message;
  element.classList.toggle("error", error);
  element.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove("show"), 5200);
}

function setBusy(busy, label) {
  state.busy = busy;
  $("quoteButton").disabled = busy;
  $("connectButton").disabled = busy;
  $("approveButton").disabled = busy;
  $("executeButton").disabled = busy || !state.quote || state.allowance < (state.quote?.amountIn || 0n);
  if (label) $("quoteStatus").textContent = label;
}

async function waitForReceipt(hash) {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const receipt = await rpc("eth_getTransactionReceipt", [hash]);
    if (receipt) {
      if (BigInt(receipt.status || "0x0") !== 1n) throw new Error("Transaction reverted on Ronin.");
      return receipt;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error("Transaction is still pending. Check it in Ronin Explorer.");
}

async function ensureRonin() {
  if (!state.provider) throw new Error("Connect your wallet first.");
  const current = await state.provider.request({ method: "eth_chainId" });
  if (BigInt(current) === BigInt(CONFIG.chainId)) return;
  try {
    await state.provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CONFIG.chainHex }] });
  } catch (error) {
    if (error?.code !== 4902) throw error;
    await state.provider.request({
      method: "wallet_addEthereumChain",
      params: [{
        chainId: CONFIG.chainHex,
        chainName: "Ronin Mainnet",
        nativeCurrency: { name: "RON", symbol: "RON", decimals: 18 },
        rpcUrls: [CONFIG.rpc],
        blockExplorerUrls: [CONFIG.explorer],
      }],
    });
  }
}

async function refreshWallet() {
  if (!state.account) return;
  const [balanceHex, allowanceHex] = await Promise.all([
    rpc("eth_call", [{ to: CONFIG.matt, data: encodeBalanceOf(state.account) }, "latest"]),
    rpc("eth_call", [{ to: CONFIG.matt, data: encodeAllowance(state.account, CONFIG.contract) }, "latest"]),
  ]);
  state.mattBalance = BigInt(balanceHex);
  state.allowance = BigInt(allowanceHex);
  $("walletMattBalance").textContent = `Wallet balance · ${formatNumber(formatUnits(state.mattBalance, 18, 4), 4)} MATT`;
  $("approveButton").textContent = state.quote && state.allowance >= state.quote.amountIn ? "Exact amount approved ✓" : "Approve exact amount";
  $("approveButton").disabled = state.busy || Boolean(state.quote && state.allowance >= state.quote.amountIn);
  $("executeButton").disabled = state.busy || !state.quote || state.allowance < state.quote.amountIn;
}

async function connectWallet() {
  const provider = injectedProvider();
  if (!provider?.request) throw new Error("Ronin Wallet was not detected. Open this site in Ronin Wallet or install the browser extension.");
  state.provider = provider;
  await ensureRonin();
  const accounts = await provider.request({ method: "eth_requestAccounts" });
  if (!accounts?.[0]) throw new Error("No wallet account was returned.");
  state.account = accounts[0];
  $("connectButton").textContent = shortAddress(state.account);
  $("walletActions").classList.remove("is-hidden");
  await refreshWallet();
  provider.on?.("accountsChanged", () => window.location.reload());
  provider.on?.("chainChanged", () => window.location.reload());
  toast("Ronin wallet connected.");
}

async function quotePath(hops, amountIn) {
  const result = await rpc("eth_call", [{ to: CONFIG.quoter, data: encodeQuote(buildPath(hops), amountIn) }, "latest"]);
  if (!result || result === "0x" || result.length < 66) throw new Error("Katana returned an empty quote.");
  return BigInt(`0x${strip0x(result).slice(0, 64)}`);
}

function estimateAtomicReturn(amount, fees) {
  return fees.reduce((value, fee) => {
    const multiplier = 1_000_000n - BigInt(fee);
    return value * multiplier * multiplier / 1_000_000_000_000n;
  }, amount);
}

async function preview() {
  const amountIn = parseUnits($("amountInput").value);
  const slippage = Number($("slippageInput").value);
  if (!Number.isFinite(slippage) || slippage < .1 || slippage > 10) throw new Error("Protection must be between 0.1% and 10%.");
  const slippageBps = BigInt(Math.round(slippage * 100));
  setBusy(true, "Quoting…");
  try {
    // QuoterV2 evaluates repeated-pool hops against unchanged pool state,
    // understating an atomic out-and-back route. Quote each outward path live,
    // then model the paired reverse using the fee retained by each pool twice.
    // Fork testing showed this closely tracks the actual atomic route, while
    // the minimums below retain the user-selected protection margin.
    const coinAmount = await quotePath([HOPS[0]], amountIn);
    const mattAfterCoin = estimateAtomicReturn(amountIn, [3000]);
    const wrappedRonAmount = await quotePath([HOPS[2]], mattAfterCoin);
    const mattAfterRon = estimateAtomicReturn(mattAfterCoin, [10000]);
    const ronkeAmount = await quotePath([HOPS[4], HOPS[5]], mattAfterRon);
    const finalMatt = estimateAtomicReturn(mattAfterRon, [10000, 10000]);
    const outputs = [coinAmount, mattAfterCoin, wrappedRonAmount, mattAfterRon, ronkeAmount, finalMatt];
    const blockHex = await rpc("eth_blockNumber", []);
    const minimums = outputs.map((value) => value * (10_000n - slippageBps) / 10_000n);
    const finalAmount = finalMatt;
    const loss = amountIn > finalAmount ? amountIn - finalAmount : 0n;
    state.quote = { amountIn, outputs, minimums, block: Number(BigInt(blockHex)), at: Date.now(), slippage };

    $("expectedOutput").textContent = formatNumber(formatUnits(finalAmount, 18, 6), 6);
    $("minimumOutput").textContent = `${formatNumber(formatUnits(minimums[5], 18, 6), 6)} MATT`;
    $("lossOutput").textContent = `${formatNumber(formatUnits(loss, 18, 6), 6)} MATT`;
    $("quoteBlock").textContent = state.quote.block.toLocaleString();
    document.querySelectorAll(".route-step").forEach((element, index) => {
      const stage = STAGES[index];
      element.classList.add("quoted");
      element.querySelector("strong").textContent = `${formatNumber(formatUnits(outputs[index], stage.decimals, 6), 6)} ${stage.symbol}`;
    });
    $("quoteStatus").textContent = "Live quote";
    if (state.account) await refreshWallet();
    toast("Live Katana quote loaded.");
  } finally {
    setBusy(false);
  }
}

async function approveExactAmount() {
  if (!state.quote) throw new Error("Preview the route first.");
  await ensureRonin();
  setBusy(true, "Approving…");
  try {
    const hash = await state.provider.request({
      method: "eth_sendTransaction",
      params: [{ from: state.account, to: CONFIG.matt, data: encodeApprove(CONFIG.contract, state.quote.amountIn) }],
    });
    toast(`Approval submitted: ${shortAddress(hash)}`);
    await waitForReceipt(hash);
    await refreshWallet();
    $("quoteStatus").textContent = "Approved";
    toast("Exact MATT amount approved.");
  } finally {
    setBusy(false);
  }
}

function openReview() {
  if (!state.quote) throw new Error("Preview the route first.");
  if (Date.now() - state.quote.at > 90_000) throw new Error("This quote is over 90 seconds old. Preview again before executing.");
  if (state.allowance < state.quote.amountIn) throw new Error("Approve the exact MATT amount first.");
  $("reviewInput").textContent = `${formatNumber(formatUnits(state.quote.amountIn, 18, 6), 6)} MATT`;
  $("reviewExpected").textContent = `${formatNumber(formatUnits(state.quote.outputs[5], 18, 6), 6)} MATT`;
  $("reviewMinimum").textContent = `${formatNumber(formatUnits(state.quote.minimums[5], 18, 6), 6)} MATT`;
  $("reviewRecipient").textContent = shortAddress(state.account);
  $("riskCheckbox").checked = false;
  $("confirmExecuteButton").disabled = true;
  $("reviewDialog").showModal();
}

async function executeRoundTrip() {
  if (!state.quote || !state.account) throw new Error("Connect and preview first.");
  if (Date.now() - state.quote.at > 90_000) throw new Error("Quote expired. Close this review and preview again.");
  await ensureRonin();
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
  const data = encodeExecution(state.quote.amountIn, state.quote.minimums, deadline, state.account);
  setBusy(true, "Simulating…");
  try {
    await state.provider.request({ method: "eth_call", params: [{ from: state.account, to: CONFIG.contract, data }, "latest"] });
    const estimateHex = await state.provider.request({ method: "eth_estimateGas", params: [{ from: state.account, to: CONFIG.contract, data }] });
    const gas = BigInt(estimateHex) * 120n / 100n;
    $("reviewDialog").close();
    $("quoteStatus").textContent = "Confirm in wallet";
    const hash = await state.provider.request({
      method: "eth_sendTransaction",
      params: [{ from: state.account, to: CONFIG.contract, data, gas: `0x${gas.toString(16)}` }],
    });
    toast(`Round trip submitted: ${shortAddress(hash)}`);
    $("quoteStatus").textContent = "Pending…";
    const receipt = await waitForReceipt(hash);
    const completedLog = (receipt.logs || []).find((log) =>
      String(log.address).toLowerCase() === CONFIG.contract.toLowerCase()
      && String(log.topics?.[0]).toLowerCase() === ROUND_TRIP_COMPLETED_TOPIC
    );
    if (!completedLog || strip0x(completedLog.data).length < 128) throw new Error("Transaction confirmed, but its completion event could not be read. Check Ronin Explorer.");
    const logData = strip0x(completedLog.data);
    const actualInput = BigInt(`0x${logData.slice(0, 64)}`);
    const actualOutput = BigInt(`0x${logData.slice(64, 128)}`);
    const actualLoss = actualInput > actualOutput ? actualInput - actualOutput : 0n;
    $("confirmedOutput").textContent = formatNumber(formatUnits(actualOutput, 18, 6), 6);
    $("confirmedLoss").textContent = `Net route cost: ${formatNumber(formatUnits(actualLoss, 18, 6), 6)} MATT`;
    $("confirmedTransaction").href = `${CONFIG.explorer}/tx/${hash}`;
    $("executionResult").classList.remove("is-hidden");
    state.quote = null;
    await refreshWallet();
    $("quoteStatus").textContent = "Completed";
    toast(`Confirmed: ${formatNumber(formatUnits(actualOutput, 18, 6), 6)} MATT returned.`);
    window.open(`${CONFIG.explorer}/tx/${hash}`, "_blank", "noopener,noreferrer");
  } finally {
    setBusy(false);
  }
}

function renderDependencies() {
  $("dependencyGrid").innerHTML = DEPENDENCIES.map(([type, name, address]) => `
    <article class="dependency-card">
      <span>${type}</span>
      <h3>${name}</h3>
      <a href="${CONFIG.explorer}/address/${address}" target="_blank" rel="noopener noreferrer"><code>${address}</code><b>↗</b></a>
    </article>`).join("");
}

function handle(action) {
  return async () => {
    try { await action(); }
    catch (error) {
      console.error(error);
      $("quoteStatus").textContent = "Needs attention";
      toast(error?.message || "Something went wrong.", true);
      setBusy(false);
    }
  };
}

$("connectButton").addEventListener("click", handle(connectWallet));
$("quoteButton").addEventListener("click", handle(preview));
$("approveButton").addEventListener("click", handle(approveExactAmount));
$("executeButton").addEventListener("click", handle(openReview));
$("confirmExecuteButton").addEventListener("click", handle(executeRoundTrip));
$("riskCheckbox").addEventListener("change", (event) => { $("confirmExecuteButton").disabled = !event.target.checked; });
$("maxButton").addEventListener("click", () => {
  if (!state.account) return toast("Connect your wallet to use max.", true);
  $("amountInput").value = formatUnits(state.mattBalance, 18, 18);
});
$("amountInput").addEventListener("input", () => { state.quote = null; $("quoteStatus").textContent = "Quote required"; });
$("slippageInput").addEventListener("input", () => { state.quote = null; $("quoteStatus").textContent = "Quote required"; });

renderDependencies();




