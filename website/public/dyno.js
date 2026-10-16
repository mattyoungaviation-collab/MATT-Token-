(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const state = { quantity: 1, config: null, roundId: null, round: null, wallet: null, quota: null, busy: false };
  const prizeLabels = ["≈ $5 DEFAULT", "≈ $10 DEFAULT", "≈ $100", "≈ $250", "≈ $500"];
  const defaultPrizes = ["70224700000000000000", "140449400000000000000", "1404494400000000000000", "3511236000000000000000", "7022471900000000000000"];
  // Token values remain integers: display truncation never becomes a money calculation.
  const formatUnits = (raw, decimals = 18, maximum = 4) => {
    const value = BigInt(raw), scale = 10n ** BigInt(decimals), whole = value / scale;
    const fraction = (value % scale).toString().padStart(decimals, "0").slice(0, maximum).replace(/0+$/, "");
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(whole) + (fraction ? `.${fraction}` : "");
  };
  async function json(url, options) { const response = await fetch(url, { cache: "no-store", ...options }); const body = await response.json().catch(() => ({})); if (!response.ok) throw new Error(body.message || body.error || `HTTP ${response.status}`); return body; }
  function short(value) { return value ? `${value.slice(0, 6)}…${value.slice(-4)}` : "—"; }
  function renderPrizes(prizes, tokenId, firstNft) {
    const draftLabelsApply = prizes.every((amount, index) => amount === defaultPrizes[index]);
    const cards = prizes.map((amount, index) => `<article class="prize"><span>DRAW ${index + 1} · ${draftLabelsApply ? prizeLabels[index] : "FIXED RON"}</span><strong>${formatUnits(amount)} RON</strong><small>Fixed native token amount</small></article>`);
    cards.push(`<article class="prize grand"><span>DRAW 6 · GRAND PRIZE</span><strong>${firstNft ? "Water Dyno" : "Dyno NFT"} #${BigInt(tokenId)}</strong><small>${firstNft ? "Owner-described estimate near $700; not a verified appraisal." : "NFT details must be verified for this round."}</small></article>`);
    $("prize-grid").innerHTML = cards.join("");
  }
  function renderConfig(config) {
    if (!config.mock && config.paymentModel !== "RON_AND_HELD_MATT") throw new Error("Unsupported DYNO payment model; purchases disabled.");
    state.config = config; $("environment-badge").textContent = config.mock ? "LOCAL MOCK · NO PURCHASES" : config.environment.toUpperCase();
    $("raffle-address").textContent = config.raffleProxy || "Not deployed"; $("vault-address").textContent = config.buybackProxy || "Not deployed"; $("matt-address").textContent = config.matt || "Not configured";
    if (config.mock && config.round) renderPrizes(config.round.ronPrizes, config.nftTokenId || "1358", true);
    updateQuantity();
    if (!config.mock) $("purchase").textContent = "VERIFY & PREPARE PURCHASE";
  }
  function renderRound(round) {
    if (!state.config.mock) {
      if (!round.config || round.config.matt.toLowerCase() !== state.config.matt.toLowerCase() || round.config.ronPrizes?.length !== 5) throw new Error("Live round configuration unavailable or mismatched; purchases disabled.");
      const firstNft = round.config.nftTokenId === "1358" && round.config.nftCollection?.toLowerCase() === state.config.nftCollection?.toLowerCase();
      renderPrizes(round.config.ronPrizes, round.config.nftTokenId, firstNft);
      document.querySelector(".nft-stage")?.classList.toggle("hidden", !firstNft);
    }
    state.round = round; $("phase-badge").textContent = round.phase; $("freshness").textContent = round.chainBlock ? `Chain block ${round.chainBlock} · not finalized` : (round.indexedBlock ? `Indexed through block ${round.indexedBlock}` : round.freshness);
    $("eligible-count").textContent = Number(round.eligibleCount).toLocaleString(); $("progress-bar").style.width = `${Math.min(100, Number(round.eligibleCount) / 10)}%`; document.querySelector(".progress").setAttribute("aria-valuenow", round.eligibleCount);
    const ron = value => value === undefined || value === null ? "Unavailable" : `${formatUnits(value)} RON`;
    const matt = value => value === undefined || value === null ? "Unavailable" : `${formatUnits(value)} MATT`;
    const metrics = [["Active direct RON (not lifetime receipts)",ron(round.directActive)],["Held eligible MATT",matt(round.mattActive)],["MATT owed for refunds",matt(round.mattRefundLiability)],["MATT allocated to multisig",matt(round.treasuryMattLiability)],["Unpaid prize liability",ron(round.prizeLiability)],["Next-Dyno transfer (event reconciliation)",ron(round.reserveTransferred)],["Unpaid treasury liability",ron(round.treasuryLiability)],["Unpaid RON refund liability",ron(round.refundLiability)],["Separate operations balance",ron(round.operationsBalance)],["Treasury transfer (event reconciliation)",ron(round.treasuryTransferred)]];
    $("financial-grid").innerHTML = metrics.map(([label,value]) => `<article class="metric"><span>${label}</span><strong>${value}</strong></article>`).join("");
    updateQuantity();
  }
  async function renderHistoricalFinance() {
    const host = $("financial-history");
    if (state.config?.mock || !state.roundId) { host.textContent = "Local mock: no historical chain accounting."; return; }
    const projection = await json(`/api/dyno/financials?roundId=${encodeURIComponent(state.roundId)}`);
    if (projection.roundId !== state.roundId || !projection.indexedBlockHash || !projection.totals) throw new Error("INDEX_UNAVAILABLE");
    const details = document.createElement("details"), summary = document.createElement("summary"), grid = document.createElement("div");
    summary.textContent = `Indexed historical totals through block ${projection.indexedBlock} (${projection.finalityPolicy}); these are not live balances.`;
    grid.className = "metric-grid";
    const t = projection.totals;
    for (const [label, raw, unit] of [
      ["Lifetime direct ticket receipts", t.ticketDirectRon, "RON"],
      ["Refunds credited", t.refundCreditedRon, "RON"], ["Refunds paid", t.refundPaidRon, "RON"],
      ["MATT refund credits", t.mattRefundCredited, "MATT"], ["MATT refunds paid", t.mattRefundPaid, "MATT"],
      ["RON prizes paid", t.prizePaidRon, "RON"], ["Next-Dyno reserve allocated", t.reserveAllocatedRon, "RON"],
      ["Reserve sent at settlement", t.reserveSentAtSettlementRon, "RON"], ["Later treasury liability claims paid", t.laterTreasuryClaimsRon, "RON"],
      ["MATT allocated to multisig", t.treasuryMattAllocated, "MATT"], ["MATT claimed by multisig", t.treasuryMattClaimed, "MATT"],
      ["Separate operations funded", t.operationsFundedRon, "RON"],
    ]) {
      const article = document.createElement("article"), name = document.createElement("span"), value = document.createElement("strong");
      article.className = "metric"; name.textContent = label; value.textContent = `${formatUnits(raw)} ${unit}`;
      article.append(name, value); grid.append(article);
    }
    details.append(summary, grid); host.replaceChildren(details);
  }
  async function renderLedger() { const result=await json("/api/dyno/ledger?limit=50"); const body=$("ledger-body"); if(!result.rows.length){body.innerHTML='<tr><td colspan="4">No indexed Project DYNO events yet.</td></tr>';return;} body.replaceChildren(...result.rows.map(row=>{const tr=document.createElement("tr"); for(const value of [row.block_number,row.event_name,short(`0x${row.tx_hash}`),JSON.stringify(row.payload)]){const td=document.createElement("td");td.textContent=value;tr.append(td);}return tr;})); }
  async function renderNftDelivery() {
    if (!state.roundId) return;
    const delivery = await json(`/api/dyno/prize-delivery?roundId=${encodeURIComponent(state.roundId)}`);
    const el = $("nft-delivery-status");
    if (delivery.verified === true && delivery.status === "CONFIRMED_DELIVERY" && delivery.chainId === 1 && /^0x[a-fA-F0-9]{64}$/.test(delivery.transactionHash)) {
      const link = document.createElement("a"); link.href = `https://etherscan.io/tx/${delivery.transactionHash}`; link.textContent = "Verified Ethereum transfer"; link.rel = "noopener noreferrer"; link.target = "_blank";
      el.replaceChildren(document.createTextNode(`NFT delivered to ${short(delivery.receiver)} · `), link);
    } else {
      const labels = { LOCAL_MOCK_NO_DELIVERY: "local demo; no prize delivery", AWAITING_OWNER_DELIVERY: "awaiting the owner's transfer", NOT_SETTLED: "awaiting winner assignment and settlement", PENDING_RECEIPT: "reported; awaiting receipt", PENDING_CONFIRMATIONS: "reported; awaiting confirmations", INVALID: "reported transfer did not pass verification" };
      el.textContent = `NFT delivery: ${labels[delivery.status] || "verification unavailable"}.`;
    }
  }
  function updateQuantity(){if(!state.config)return; const q=state.quantity, terms=state.config.mock?state.config.round:state.round?.config; $("ron-total").textContent=terms?`${formatUnits(BigInt(terms.ticketRon)*BigInt(q))} RON`:"Unavailable"; $("matt-total").textContent=terms?`${formatUnits(BigInt(terms.ticketMatt)*BigInt(q))} MATT`:"Unavailable"; document.querySelectorAll("[data-quantity]").forEach(button=>{button.classList.toggle("active",Number(button.dataset.quantity)===q);button.disabled=state.busy;}); $("connect-wallet").disabled=state.busy; $("verify-discord").disabled=state.busy; $("purchase").disabled=state.busy||state.config.mock||state.round?.phase!=="OPEN"||!state.round?.config||!state.quota||!!state.quota.blockedReason||q>state.quota.remaining||q>state.quota.capacityRemaining;}
  async function refreshQuota() {
    state.quota = null; updateQuantity();
    if (state.config?.mock) { $("quota").textContent = "Local demo · no purchases"; return; }
    if (!state.roundId) { $("quota").textContent = "No active round"; return; }
    try {
      const quota = await json(`/api/dyno/quota?roundId=${encodeURIComponent(state.roundId)}`); state.quota = quota;
      $("quota").textContent = `${quota.remaining} of 3 · resets ${new Date(quota.resetAt * 1000).toISOString().slice(11,19)} UTC`;
      if (quota.blockedReason) $("transaction-status").textContent = `Checkout unavailable: ${quota.blockedReason.replaceAll("_", " ").toLowerCase()}.`;
    } catch { $("quota").textContent = "Verification or fresh chain data required"; }
    updateQuantity();
  }
  async function connect(){const provider=window.ronin?.provider||window.ethereum;if(!provider)throw new Error("Install or open a Ronin-compatible wallet.");const accounts=await provider.request({method:"eth_requestAccounts"});state.wallet=window.ethers.getAddress(accounts[0]);const challenge=await json("/api/dyno/auth/nonce",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({wallet:state.wallet})});const browser=new window.ethers.BrowserProvider(provider);const signature=await (await browser.getSigner()).signMessage(challenge.message);await json("/api/dyno/auth/verify",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({wallet:state.wallet,signature})});$("connect-wallet").textContent=short(state.wallet);$("transaction-status").textContent="Wallet authenticated. Discord verification is still required.";await refreshQuota();}
  function discord(){if(!state.wallet)throw new Error("Connect and authenticate your wallet first.");location.href=`/api/discord/start?wallet=${encodeURIComponent(state.wallet)}`;}
  async function purchase(){
    if(state.config?.mock)throw new Error("Purchasing is disabled in the clearly labeled local mock.");
    if(!state.wallet)throw new Error("Connect and authenticate your wallet first.");
    if(state.busy)return;
    state.busy=true; const quantity=state.quantity; updateQuantity();
    try {
    const provider=window.ronin?.provider||window.ethereum; const browser=new window.ethers.BrowserProvider(provider); const network=await browser.getNetwork();
    if(Number(network.chainId)!==state.config.chainId)throw new Error(`Switch your wallet to chain ${state.config.chainId}.`);
    await refreshQuota();
    if(!state.quota||state.quota.blockedReason||quantity>state.quota.remaining||quantity>state.quota.capacityRemaining)throw new Error("Current verification, daily quota, or capacity does not allow this checkout.");
    const signer=await browser.getSigner(); if(window.ethers.getAddress(await signer.getAddress())!==state.wallet)throw new Error("Wallet changed. Authenticate the selected wallet again.");
    if(state.round?.phase!=="OPEN"||!state.round.config)throw new Error("Live round configuration is unavailable or not open.");
    const token=new window.ethers.Contract(state.round.config.matt,["function allowance(address,address) view returns(uint256)","function approve(address,uint256) returns(bool)"],signer); const required=BigInt(state.round.config.ticketMatt)*BigInt(quantity);
    if(await token.allowance(state.wallet,state.config.raffleProxy)<required){$("transaction-status").textContent="Approve the exact MATT amount in your wallet…";const approval=await token.approve(state.config.raffleProxy,required);await approval.wait();}
    if(Number((await browser.getNetwork()).chainId)!==state.config.chainId||window.ethers.getAddress(await (await browser.getSigner()).getAddress())!==state.wallet)throw new Error("Wallet or chain changed during approval. Reconnect before purchasing.");
    // Approval can take longer than a voucher's five-minute validity. Refresh after it.
    const quote=await json(`/api/dyno/quote?roundId=${encodeURIComponent(state.roundId)}&quantity=${quantity}`); const signed=await json("/api/dyno/voucher",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({roundId:state.roundId,quantity})});
    if(String(quote.roundId)!==state.roundId||String(signed.voucher.roundId)!==state.roundId)throw new Error("Round changed during checkout. Refresh before purchasing.");
    if(quote.paymentModel!=="RON_AND_HELD_MATT"||BigInt(quote.totalRon)!==BigInt(state.round.config.ticketRon)*BigInt(quantity)||BigInt(quote.totalMatt)!==required)throw new Error("Fixed-price quote changed. Refresh before purchasing.");
    const abi=["function buyTickets((uint256 roundId,bytes32 accountCommitment,address wallet,uint8 quantity,uint32 identityVersion,bytes32 nonce,uint64 dayIndex,uint64 expiry) voucher,bytes signature) payable"];
    const manager=new window.ethers.Contract(state.config.raffleProxy,abi,signer);$("transaction-status").textContent="Submit the purchase in your wallet. Waiting for confirmation…";
    const tx=await manager.buyTickets(signed.voucher,signed.signature,{value:BigInt(quote.totalRon)});$("transaction-status").textContent=`Submitted ${short(tx.hash)}. Not confirmed yet…`;const receipt=await tx.wait();
    if(receipt.status!==1)throw new Error("Purchase reverted. No ticket was created.");$("transaction-status").textContent=`Confirmed in block ${receipt.blockNumber}. Refreshing ledger…`;await renderLedger();
    } finally { state.busy=false; await refreshQuota(); }
  }
  document.querySelectorAll("[data-quantity]").forEach(button=>button.addEventListener("click",()=>{state.quantity=Number(button.dataset.quantity);updateQuantity();}));
  document.querySelectorAll("[data-tab]").forEach(button=>button.addEventListener("click",()=>{document.querySelectorAll("[data-tab]").forEach(item=>item.setAttribute("aria-selected",String(item===button)));document.querySelectorAll(".tab-panel").forEach(panel=>panel.classList.add("hidden"));$(`tab-${button.dataset.tab}`).classList.remove("hidden");}));
  $("connect-wallet").addEventListener("click",()=>connect().catch(error=>{$("transaction-status").textContent=error.message;})); $("verify-discord").addEventListener("click",()=>{try{discord();}catch(error){$("transaction-status").textContent=error.message;}}); $("purchase").addEventListener("click",()=>purchase().catch(error=>{$("transaction-status").textContent=error.message;}));
  Promise.all([json("/api/dyno/config"),json("/api/dyno/active-round")]).then(async ([config,active])=>{renderConfig(config);state.roundId=active.roundId;if(!state.roundId)throw new Error("No active raffle round; purchases remain disabled.");const round=await json(`/api/dyno/round?roundId=${encodeURIComponent(state.roundId)}`);renderRound(round);renderHistoricalFinance().catch(()=>{$("financial-history").textContent="Indexed historical totals unavailable; live contract balances above remain authoritative.";});const link=await json("/api/dyno/link-status");if(link.wallet){state.wallet=window.ethers.getAddress(link.wallet);$("connect-wallet").textContent=short(state.wallet);}await refreshQuota();await renderNftDelivery().catch(()=>{$("nft-delivery-status").textContent="NFT delivery: verification unavailable; no confirmed delivery shown.";});}).catch(error=>{$("transaction-status").textContent=error.message;updateQuantity();}); renderLedger().catch(()=>{$("ledger-body").innerHTML='<tr><td colspan="4">Ledger temporarily unavailable.</td></tr>';});
})();
