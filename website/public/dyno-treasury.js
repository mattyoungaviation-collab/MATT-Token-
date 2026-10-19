(() => {
  "use strict";
  const parent = document.getElementById("tab-admin");
  if (!parent) return;
  const E = window.ethers;
  const section = document.createElement("section");
  section.className = "treasury-withdrawals";
  section.setAttribute("aria-label", "Treasury withdrawals");
  const el = (tag, text) => { const node = document.createElement(tag); if (text) node.textContent = text; return node; };
  const title = el("h3", "Withdraw allocated RON and MATT");
  const note = el("p", "Check what this round has released to the treasury. Ticket payments, operating funds, prizes and refunds are kept separate. These controls prepare existing contract claims for Safe approval.");
  const roundLabel = el("label", "Round ID"), round = el("input");
  round.value = "1"; round.setAttribute("inputmode", "numeric"); round.setAttribute("aria-label", "Treasury round ID"); roundLabel.append(round);
  const refresh = el("button", "CHECK AVAILABLE FUNDS"); refresh.type = "button"; refresh.className = "secondary";
  const summary = el("p", "Sign in with an authorized administrator wallet, then check the round.");
  summary.className = "status"; summary.setAttribute("role", "status");
  const cards = el("div"); cards.className = "treasury-cards";
  const controls = {};
  for (const asset of ["RON", "MATT"]) {
    const card = el("article"), heading = el("h4", `${asset} available to treasury`), amount = el("strong", "—");
    const prepare = el("button", `PREPARE ${asset} WITHDRAWAL`);
    prepare.type = "button"; prepare.className = "secondary"; prepare.disabled = true;
    card.append(heading, amount, prepare); cards.append(card); controls[asset] = { amount, prepare };
  }
  const backing = el("p", "No funding check has been performed."), recipient = el("p");
  backing.className = "status"; recipient.className = "treasury-recipient";
  const draftStatus = el("p"), draftText = el("pre"), download = el("a", "DOWNLOAD SAFE TRANSACTION");
  draftStatus.className = "status"; draftStatus.setAttribute("role", "status");
  download.className = "download"; download.hidden = true;
  const explanation = el("p", "Claims release the full recorded allocation to the configured treasury. RON is normally sent there automatically at settlement; this RON control claims an unpaid allocation. Eligible-ticket MATT becomes claimable after settlement. A draft does not move funds.");
  section.append(title, note, roundLabel, refresh, summary, cards, backing, recipient, explanation, draftStatus, draftText, download);
  parent.append(section);
  if (!E?.Interface) {
    refresh.disabled = true;
    summary.textContent = "The transaction library did not load. Reload before checking or preparing a withdrawal.";
    return;
  }
  let state = null, busy = false, revision = 0, downloadUrl = null, expiryTimer = null;
  const claims = new E.Interface(["function claimTreasuryLiability(uint256 roundId)", "function claimTreasuryMatt(uint256 roundId)"]);
  const uint = value => typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value) && value.length <= 78 && BigInt(value) <= E.MaxUint256;
  const validRound = () => /^[1-9][0-9]{0,77}$/.test(round.value.trim()) && BigInt(round.value.trim()) <= E.MaxUint256;
  const amount = asset => state ? state[asset === "RON" ? "claimableRon" : "claimableMatt"] : "0";
  function clearDraft() {
    clearTimeout(expiryTimer); draftText.textContent = ""; download.hidden = true; download.removeAttribute("href");
    if (downloadUrl) URL.revokeObjectURL(downloadUrl); downloadUrl = null;
  }
  function sync() {
    refresh.disabled = busy;
    for (const asset of ["RON", "MATT"]) controls[asset].prepare.disabled = busy || !state || !state.fullyBacked || BigInt(amount(asset)) === 0n;
  }
  function reset() {
    revision++; state = null; clearDraft(); draftStatus.textContent = "";
    for (const asset of ["RON", "MATT"]) controls[asset].amount.textContent = "—";
    backing.textContent = "Refresh to check current funds."; recipient.textContent = ""; sync();
  }
  function checked(data, requestedRound) {
    const fields = ["claimableRon", "claimableMatt", "ronBalance", "mattBalance", "ronReserved", "mattReserved", "safeThreshold", "roundsChecked", "chainBlock"];
    if (data.chainId !== 2020 || data.roundId !== requestedRound || data.authority !== "chain" || !/^0x[0-9a-fA-F]{64}$/.test(data.chainBlockHash || "") ||
        !fields.every(key => uint(data[key])) || typeof data.fullyBacked !== "boolean" || ![data.target, data.executor, data.token].every(E.isAddress)) throw new Error("Invalid chain funding response.");
    if (BigInt(data.safeThreshold) < 1n || BigInt(data.roundsChecked) < BigInt(requestedRound)) throw new Error("Incomplete treasury funding check.");
    if (!Number.isInteger(data.chainTimestamp) || Math.floor(Date.now() / 1000) - data.chainTimestamp > 120 || data.chainTimestamp > Math.floor(Date.now() / 1000) + 30) throw new Error("Funding information is stale. Check again.");
    const backed = BigInt(data.ronBalance) >= BigInt(data.ronReserved) && BigInt(data.mattBalance) >= BigInt(data.mattReserved);
    if (data.fullyBacked !== backed || (!backed && (data.claimableRon !== "0" || data.claimableMatt !== "0")) ||
        (data.claimableRon !== "0" && !["SETTLED", "CANCELLED"].includes(data.phase)) || (data.claimableMatt !== "0" && data.phase !== "SETTLED")) throw new Error("Inconsistent treasury allocation.");
    return data;
  }
  const errorMessage = (status, code) => status === 401 ? "Sign in with your administrator wallet first." : status === 403 ? "An active Safe owner or emergency administrator is required." :
    code === "TREASURY_CHANGED" ? "The allocation changed. Check the funds again before preparing a new draft." : code === "TREASURY_NOT_CLAIMABLE" ? "There is no released allocation available for that asset." :
    code === "TREASURY_SIMULATION_FAILED" ? "The existing claim did not pass simulation from the Safe. No draft was created." : "Fresh treasury funding information is unavailable. No withdrawal was prepared.";
  async function request(url, options) {
    const response = await fetch(url, { cache: "no-store", credentials: "same-origin", ...options });
    const body = await response.json(); if (!response.ok) throw new Error(errorMessage(response.status, body.error)); return body;
  }
  round.addEventListener("input", () => { reset(); summary.textContent = "Round changed. Check available funds again."; });
  refresh.addEventListener("click", async () => {
    if (busy) return;
    reset(); const generation = revision, requestedRound = round.value.trim(); busy = true; sync();
    try {
      if (!validRound()) throw new Error("Enter a valid positive round ID.");
      const data = checked(await request(`/api/dyno/admin/treasury?roundId=${encodeURIComponent(requestedRound)}`), requestedRound);
      if (generation !== revision) return;
      state = data;
      for (const asset of ["RON", "MATT"]) controls[asset].amount.textContent = `${E.formatUnits(BigInt(amount(asset)), 18)} ${asset}`;
      summary.textContent = `Round ${data.roundId} · ${data.phase} · checked at block ${data.chainBlock}.`;
      backing.textContent = `${data.fullyBacked ? "Funding check passed" : "Funding shortfall: withdrawals unavailable"} across ${data.roundsChecked} ${data.roundsChecked === "1" ? "round" : "rounds"}. Contract: ${E.formatEther(data.ronBalance)} RON; accounted for: ${E.formatEther(data.ronReserved)} RON. Held MATT: ${E.formatUnits(data.mattBalance, 18)}; accounted for: ${E.formatUnits(data.mattReserved, 18)}.`;
      recipient.textContent = `Safe execution account: ${data.executor} · ${data.safeThreshold} approvals required. The contract verifies the round's treasury when the claim is simulated.`;
      if (data.claimableRon === "0" && data.claimableMatt === "0") draftStatus.textContent = "No treasury allocation is available yet. Incoming ticket payments are not withdrawable revenue here.";
    } catch (error) { if (generation === revision) { state = null; summary.textContent = error.message; } }
    finally { busy = false; sync(); }
  });
  for (const asset of ["RON", "MATT"]) controls[asset].prepare.addEventListener("click", async () => {
    if (busy || !state || BigInt(amount(asset)) === 0n) return;
    const reviewed = state, generation = revision, allocation = amount(asset);
    busy = true; clearDraft(); sync();
    try {
      const body = { roundId: reviewed.roundId, asset, expectedAllocation: allocation, expectedTarget: reviewed.target, expectedExecutor: reviewed.executor };
      const draft = checked(await request("/api/dyno/admin/treasury/prepare", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), reviewed.roundId);
      if (generation !== revision) return;
      const method = asset === "RON" ? "claimTreasuryLiability" : "claimTreasuryMatt";
      const expectedData = claims.encodeFunctionData(method, [reviewed.roundId]);
      if (!draft.fullyBacked || draft.submitted !== false || draft.simulated !== true || draft.asset !== asset || draft.observedAllocation !== allocation || draft.value !== "0" ||
          draft.target !== reviewed.target || draft.executor !== reviewed.executor || draft.token !== reviewed.token || draft.executionFrom !== reviewed.executor || draft.executionMode !== "multisig" ||
          draft.method !== method || draft.data !== expectedData || !Number.isInteger(draft.reviewBy) || draft.reviewBy <= Math.floor(Date.now() / 1000)) throw new Error("The unsigned draft does not match the reviewed claim.");
      const transaction = { to: draft.target, value: "0", data: draft.data, contractMethod: null, contractInputsValues: null };
      const batch = { version: "1.0", chainId: "2020", createdAt: Date.now(), meta: { name: `DYNO round ${draft.roundId} ${asset} treasury claim`, description: `Full observed allocation: ${E.formatUnits(allocation, 18)} ${asset}. Recheck on chain before Safe execution.`, txBuilderVersion: "1.18.0", createdFromSafeAddress: draft.executor, createdFromOwnerAddress: "" }, transactions: [transaction] };
      downloadUrl = URL.createObjectURL(new Blob([JSON.stringify(batch, null, 2)], { type: "application/json" }));
      download.href = downloadUrl; download.download = `dyno-round-${draft.roundId}-${asset.toLowerCase()}-treasury.json`; download.hidden = false;
      draftText.textContent = JSON.stringify({ asset, roundId: draft.roundId, fullObservedAllocation: `${E.formatUnits(allocation, 18)} ${asset}`, Safe: draft.executor, approvalsRequired: draft.safeThreshold, transaction, simulationBlock: draft.chainBlock, submitted: false }, null, 2);
      draftStatus.textContent = "Unsigned Safe transaction prepared. Review it in Safe Transaction Builder and collect the required approvals. No transaction has been sent. Refresh the allocation before execution.";
      expiryTimer = setTimeout(() => { clearDraft(); state = null; sync(); draftStatus.textContent = "The draft review window expired. Check current funds and prepare a fresh draft."; }, Math.min(120000, (draft.reviewBy - Math.floor(Date.now() / 1000)) * 1000));
    } catch (error) { if (generation === revision) { clearDraft(); state = null; draftStatus.textContent = error.message; } }
    finally { busy = false; sync(); }
  });
})();
