(() => {
  "use strict";
  const parent = document.getElementById("tab-admin");
  if (!parent) return;

  const section = document.createElement("section");
  section.setAttribute("aria-label", "Private identity observations");
  const title = document.createElement("h3");
  title.textContent = "Private account mapping";
  const description = document.createElement("p");
  description.textContent = "Current encrypted-store observations only. An observed wallet is not an approved on-chain relink. Connect and sign in with a Safe-owner or active emergency-admin wallet to view.";
  const refresh = document.createElement("button");
  refresh.type = "button";
  refresh.className = "secondary";
  refresh.textContent = "CHECK ACCESS & LOAD";
  const download = document.createElement("a");
  download.className = "download";
  download.textContent = "DOWNLOAD FIRST 250 (PRIVATE CSV)";
  download.href = "/api/dyno/admin/identities.csv?limit=250";
  download.hidden = true;
  const status = document.createElement("p");
  status.className = "status";
  status.setAttribute("role", "status");
  status.textContent = "Private records are not loaded.";
  const scroller = document.createElement("div");
  scroller.className = "table-scroll";
  const table = document.createElement("table");
  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const label of ["Discord ID", "Display name", "Observed wallet", "Version", "Observed UTC", "Actions"]) {
    const cell = document.createElement("th"); cell.textContent = label; headRow.append(cell);
  }
  head.append(headRow);
  const body = document.createElement("tbody");
  table.append(head, body); scroller.append(table);
  const previous = document.createElement("button");
  previous.type = "button"; previous.className = "secondary"; previous.textContent = "PREVIOUS"; previous.disabled = true;
  const next = document.createElement("button");
  next.type = "button"; next.className = "secondary"; next.textContent = "NEXT"; next.disabled = true;
  const history = document.createElement("div");
  history.setAttribute("aria-label", "Private identity observation history");
  section.append(title, description, refresh, download, status, scroller, previous, next, history);
  parent.append(section);

  const relink = document.createElement("section"), relinkTitle = document.createElement("h3");
  relinkTitle.textContent = "Prepare identity relink";
  const relinkNote = document.createElement("p");
  relinkNote.textContent = "A new wallet must sign the EIP-712 request. The old ticket claims remain with the original purchasing wallet. This only prepares a transaction for Safe approval or the disclosed emergency administrator; it does not execute a relink.";
  const commitment = document.createElement("input"), newWallet = document.createElement("input"), version = document.createElement("input"), proof = document.createElement("textarea");
  commitment.placeholder = "0x… account commitment"; newWallet.placeholder = "0x… new wallet"; version.placeholder = "Current identity version";
  proof.placeholder = "New wallet's EIP-712 signature (0x…)"; proof.setAttribute("aria-label", "New-wallet relink signature");
  const copyRequest = document.createElement("button"), prepare = document.createElement("button"), copyDraft = document.createElement("button"), relinkStatus = document.createElement("p"), draftText = document.createElement("pre");
  copyRequest.type = "button"; copyRequest.className = "secondary"; copyRequest.textContent = "COPY NEW-WALLET SIGNING REQUEST";
  prepare.type = "button"; prepare.className = "secondary"; prepare.textContent = "PREPARE MULTISIG DRAFT";
  copyDraft.type = "button"; copyDraft.className = "secondary"; copyDraft.textContent = "COPY DRAFT"; copyDraft.hidden = true;
  relinkStatus.className = "status"; relinkStatus.setAttribute("role", "status"); relinkStatus.textContent = "No relink prepared.";
  relink.append(relinkTitle, relinkNote, commitment, newWallet, version, proof, copyRequest, prepare, relinkStatus, draftText, copyDraft);
  parent.append(relink);
  let proofRequest = null, preparedDraft = null;
  function validateRelinkFields() {
    const account = commitment.value.trim(), wallet = newWallet.value.trim(), currentVersion = version.value.trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(account) || /^0x0{64}$/i.test(account)) throw new Error("Enter the current nonzero 32-byte account commitment.");
    if (!/^0x[0-9a-fA-F]{40}$/.test(wallet) || /^0x0{40}$/i.test(wallet)) throw new Error("Enter a nonzero new wallet address.");
    if (!/^[1-9][0-9]{0,8}$/.test(currentVersion) || BigInt(currentVersion) >= 2n ** 32n) throw new Error("Enter the current positive identity version.");
    return { account, wallet: window.ethers.getAddress(wallet), currentVersion: Number(currentVersion) };
  }
  function clearDraft() { preparedDraft = null; draftText.textContent = ""; copyDraft.hidden = true; }
  for (const input of [commitment, newWallet, version]) input.addEventListener("input", () => { proofRequest = null; clearDraft(); });
  proof.addEventListener("input", clearDraft);
  copyRequest.addEventListener("click", async () => {
    clearDraft();
    try {
      const fields = validateRelinkFields();
      const response = await fetch("/api/dyno/config", { cache: "no-store", credentials: "same-origin" });
      if (!response.ok) throw new Error("Live contract configuration unavailable.");
      const config = await response.json();
      if (config.mock || !config.raffleProxy || !Number.isInteger(config.chainId)) throw new Error("Live contract configuration unavailable.");
      const expiry = Math.floor(Date.now() / 1000) + 86_400;
      proofRequest = { domain: { name: "Project DYNO", version: "1", chainId: config.chainId, verifyingContract: config.raffleProxy },
        types: { EIP712Domain: [{ name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }], RelinkAuthorization: [{ name: "accountCommitment", type: "bytes32" }, { name: "newWallet", type: "address" }, { name: "expectedVersion", type: "uint32" }, { name: "expiry", type: "uint64" }] },
        primaryType: "RelinkAuthorization", message: { accountCommitment: fields.account, newWallet: fields.wallet, expectedVersion: fields.currentVersion, expiry } };
      await navigator.clipboard.writeText(JSON.stringify(proofRequest, null, 2));
      relinkStatus.textContent = `Signing request copied. The new wallet must sign it before ${new Date(expiry * 1000).toISOString()}; this is not a relink approval.`;
    } catch (error) { proofRequest = null; relinkStatus.textContent = error?.message || "Could not prepare the signing request."; }
  });
  prepare.addEventListener("click", async () => {
    clearDraft(); prepare.disabled = true;
    try {
      const fields = validateRelinkFields(), signature = proof.value.trim();
      if (!proofRequest || proofRequest.message.accountCommitment !== fields.account || proofRequest.message.newWallet !== fields.wallet || proofRequest.message.expectedVersion !== fields.currentVersion || proofRequest.message.expiry <= Math.floor(Date.now() / 1000)) throw new Error("Copy a fresh signing request for these exact fields first.");
      if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(signature) || signature.length > 8194) throw new Error("Paste the new wallet's hex signature.");
      const response = await fetch("/api/dyno/admin/prepare", { method: "POST", credentials: "same-origin", cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify({ contract: "manager", method: "relinkIdentity", args: [fields.account, fields.wallet, fields.currentVersion, proofRequest.message.expiry, signature], value: "0" }) });
      if (!response.ok) throw new Error(response.status === 401 ? "Admin wallet login required." : response.status === 403 ? "Active Safe owner or emergency admin required." : response.status === 409 ? "Relink rejected by current contract state or signature." : "Relink preparation unavailable.");
      const draft = await response.json();
      if (draft.submitted !== false || draft.simulated !== true || !/^0x[0-9a-fA-F]{40}$/.test(draft.target) || !/^0x[0-9a-fA-F]+$/.test(draft.data) || draft.value !== "0") throw new Error("Invalid unsigned draft response.");
      preparedDraft = { target: draft.target, value: "0", data: draft.data, executionMode: draft.executionMode, authorityBlock: draft.authorityBlock, authorityBlockHash: draft.authorityBlockHash };
      draftText.textContent = JSON.stringify(preparedDraft, null, 2); copyDraft.hidden = false;
      relinkStatus.textContent = `Unsigned relink draft simulated at block ${draft.authorityBlock}. It has not been submitted or approved. Recheck expiry and chain state before Safe execution.`;
    } catch (error) { relinkStatus.textContent = error?.message || "Relink preparation failed."; }
    finally { prepare.disabled = false; }
  });
  copyDraft.addEventListener("click", async () => {
    if (!preparedDraft) return;
    try { await navigator.clipboard.writeText(JSON.stringify(preparedDraft, null, 2)); relinkStatus.textContent = "Unsigned relink draft copied; no transaction was submitted."; }
    catch { relinkStatus.textContent = "Clipboard unavailable; select the draft text to copy."; }
  });

  const pageSize = 25;
  let offset = 0;
  function clearRows() { body.replaceChildren(); history.replaceChildren(); download.hidden = true; previous.disabled = true; next.disabled = true; }
  async function loadHistory(commitment) {
    history.replaceChildren();
    const heading = document.createElement("h4"), statusLine = document.createElement("p");
    heading.textContent = `Observation history for ${commitment}`;
    statusLine.textContent = "Checking current administrator access…";
    history.append(heading, statusLine);
    try {
      const response = await fetch(`/api/dyno/admin/identity-history?commitment=${encodeURIComponent(commitment)}&limit=50`, { credentials: "same-origin", cache: "no-store" });
      if (!response.ok) throw new Error("Private history unavailable.");
      const result = await response.json();
      if (!result.private || result.commitment !== commitment || !Array.isArray(result.rows)) throw new Error("Private history unavailable.");
      statusLine.textContent = `${result.rows.length} encrypted-store observations; authority checked at chain block ${result.authorityBlock}. These are not on-chain relink approvals.`;
      for (const row of result.rows) {
        const line = document.createElement("p");
        line.textContent = `#${row.auditId} · ${row.observedAtUtc} · ${row.wallet} · version ${row.identityVersion} · ${row.bindingConfirmed ? "chain binding observed" : "binding pending"}`;
        history.append(line);
      }
    } catch { history.replaceChildren(); status.textContent = "Private history unavailable; no historical records shown."; }
  }
  async function load(requestedOffset) {
    refresh.disabled = true;
    clearRows();
    status.textContent = "Checking current on-chain admin authority…";
    try {
      const response = await fetch(`/api/dyno/admin/identities?limit=${pageSize}&offset=${requestedOffset}`, { credentials: "same-origin", cache: "no-store" });
      if (!response.ok) {
        status.textContent = response.status === 401 ? "Wallet login required." : response.status === 403 ? "This wallet is not an active DYNO administrator." : "Private export unavailable; no records shown.";
        return;
      }
      const result = await response.json();
      if (!result.private || !Array.isArray(result.rows)) throw new Error("INVALID_PRIVATE_RESPONSE");
      offset = requestedOffset;
      for (const row of result.rows) {
        const tr = document.createElement("tr");
        for (const value of [row.discordUserId, row.displayName, row.wallet, row.identityVersion, row.observedAtUtc]) {
          const td = document.createElement("td"); td.textContent = String(value ?? ""); tr.append(td);
        }
        const td = document.createElement("td"), copy = document.createElement("button");
        copy.type = "button"; copy.className = "secondary"; copy.textContent = "COPY";
        copy.addEventListener("click", async () => {
          try { await navigator.clipboard.writeText(`${row.discordUserId}\t${row.wallet}\t${row.commitment}`); status.textContent = "Private record copied to clipboard."; }
          catch { status.textContent = "Clipboard unavailable; select the table text to copy."; }
        });
        const viewHistory = document.createElement("button");
        viewHistory.type = "button"; viewHistory.className = "secondary"; viewHistory.textContent = "HISTORY";
        viewHistory.addEventListener("click", () => loadHistory(row.commitment));
        td.append(copy, viewHistory); tr.append(td); body.append(tr);
      }
      previous.disabled = offset === 0;
      next.disabled = result.rows.length < pageSize;
      download.hidden = false;
      status.textContent = `${result.rows.length} private current observations shown; authority checked at chain block ${result.authorityBlock}. This is not a ticket ledger or approved relink history.`;
    } catch { clearRows(); status.textContent = "Private export unavailable; no records shown."; }
    finally { refresh.disabled = false; }
  }
  refresh.addEventListener("click", () => load(0));
  previous.addEventListener("click", () => load(Math.max(0, offset - pageSize)));
  next.addEventListener("click", () => load(offset + pageSize));
})();
