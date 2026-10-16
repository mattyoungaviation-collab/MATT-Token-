(() => {
  "use strict";
  const input = document.getElementById("claim-ticket");
  const check = document.getElementById("claim-button");
  if (!input || !check) return;
  const status = document.createElement("p");
  status.className = "status";
  status.setAttribute("role", "status");
  status.textContent = "Enter a historical ticket ID to read its current on-chain status.";
  const claim = document.createElement("button");
  claim.type = "button"; claim.className = "secondary"; claim.textContent = "CLAIM REFUND"; claim.hidden = true;
  const receiverLabel = document.createElement("label");
  receiverLabel.textContent = "Alternate RON and MATT receiver "; receiverLabel.hidden = true;
  const receiverInput = document.createElement("input");
  receiverInput.placeholder = "0x…"; receiverInput.setAttribute("autocomplete", "off"); receiverLabel.append(receiverInput);
  const claimTo = document.createElement("button");
  claimTo.type = "button"; claimTo.className = "secondary"; claimTo.textContent = "SIGN & CLAIM TO RECEIVER"; claimTo.hidden = true;
  const prizeList = document.createElement("div");
  prizeList.setAttribute("aria-label", "RON prize entitlements for this ticket");
  check.after(status, claim, receiverLabel, claimTo, prizeList);
  let config = null, ticket = null, busy = false;
  function validId(value) { return /^[1-9][0-9]{0,77}$/.test(value) && BigInt(value) < 2n ** 256n; }
  function readableRon(raw) { return `${window.ethers.formatEther(BigInt(raw))} RON`; }
  function readableMatt(raw) { return `${window.ethers.formatUnits(BigInt(raw), config?.mattDecimals ?? 18)} MATT`; }
  async function readTicket(ticketId) {
    const response = await fetch(`/api/dyno/ticket?ticketId=${encodeURIComponent(ticketId)}`, { cache: "no-store", credentials: "same-origin" });
    if (!response.ok) throw new Error(response.status === 404 ? "Ticket not found." : "Fresh chain ticket data is unavailable.");
    const result = await response.json();
    if (result.mock || result.ticketId !== ticketId || !result.chainBlockHash || !result.originalWallet) throw new Error("Verified ticket data is unavailable.");
    return result;
  }
  async function readWinners(roundId) {
    const response = await fetch(`/api/dyno/winners?roundId=${encodeURIComponent(roundId)}`, { cache: "no-store", credentials: "same-origin" });
    if (!response.ok) throw new Error("Fresh chain winner data is unavailable.");
    const result = await response.json();
    if (result.roundId !== roundId || !result.chainBlockHash || !Array.isArray(result.winners)) throw new Error("Verified winner data is unavailable.");
    return result;
  }
  async function showTicket(result) {
    ticket = result; claim.hidden = true; receiverLabel.hidden = true; claimTo.hidden = true;
    prizeList.replaceChildren();
    const credit = ["REFUND_CREDITED", "CANCELLED_CREDITED"].includes(result.status) && !result.refundPaid;
    status.textContent = `Ticket #${result.ticketId}, round ${result.roundId}: ${result.status.replaceAll("_", " ").toLowerCase()}. Original wallet ${result.originalWallet}. ${credit ? `Refund credit ${readableRon(result.refundAmount)} + ${readableMatt(result.refundMatt)}; network gas is separate.` : ""} Checked at chain block ${result.chainBlock}.`;
    if (credit && BigInt(result.refundAmount) > 0n) { claim.hidden = false; receiverLabel.hidden = false; claimTo.hidden = false; }
    const prizeIndexes = (result.winningIndexes || []).filter(index => Number.isInteger(index) && index >= 0 && index < 5);
    if (!prizeIndexes.length) return;
    try {
      const winners = await readWinners(result.roundId);
      for (const index of prizeIndexes) {
        const winner = winners.winners.find(row => row.prizeIndex === index);
        if (!winners.assigned || !winner || winner.ticketId !== result.ticketId || winner.kind !== "RON" || window.ethers.getAddress(winner.beneficiary) !== window.ethers.getAddress(result.originalWallet)) throw new Error("Winner records do not match this ticket.");
        const row = document.createElement("p"), action = document.createElement("button");
        row.textContent = `Draw ${index + 1}: ${winner.amount === null ? "amount pending settlement" : readableRon(winner.amount)} · ${winner.paid ? "paid" : winner.entitlementFunded ? "claimable" : "not yet funded"}. `;
        if (winner.entitlementFunded && !winner.paid && winner.amount !== null) {
          receiverLabel.hidden = false;
          action.type = "button"; action.className = "secondary"; action.textContent = `CLAIM DRAW ${index + 1} RON`;
          action.addEventListener("click", () => claimRonPrize(result, index, action));
          row.append(action);
        }
        prizeList.append(row);
      }
    } catch { const warning = document.createElement("p"); warning.textContent = "Prize entitlement lookup unavailable; no prize claim was prepared."; prizeList.append(warning); }
  }
  async function claimRonPrize(selectedTicket, prizeIndex, action) {
    if (busy || !config) return;
    const walletProvider = window.ronin?.provider || window.ethereum;
    if (!walletProvider) { status.textContent = "Connect the winning ticket's original wallet to authorize a prize claim."; return; }
    busy = true; action.disabled = true; check.disabled = true;
    try {
      const fresh = await readTicket(selectedTicket.ticketId);
      const current = await readWinners(fresh.roundId);
      const winner = current.winners.find(row => row.prizeIndex === prizeIndex);
      if (fresh.roundId !== selectedTicket.roundId || !fresh.winningIndexes?.includes(prizeIndex) || !winner || winner.ticketId !== fresh.ticketId || winner.kind !== "RON" || !winner.entitlementFunded || winner.paid || winner.amount === null || window.ethers.getAddress(winner.beneficiary) !== window.ethers.getAddress(fresh.originalWallet)) throw new Error("This prize is no longer claimable; refresh the ticket.");
      let receiver = fresh.originalWallet;
      if (receiverInput.value.trim()) {
        receiver = window.ethers.getAddress(receiverInput.value.trim());
        if (receiver === window.ethers.ZeroAddress) throw new Error("Receiver cannot be zero.");
        if (receiver !== window.ethers.getAddress(fresh.originalWallet) && !window.confirm(`Send draw ${prizeIndex + 1}'s ${readableRon(winner.amount)} to ${receiver}? This cannot be reversed.`)) return;
      }
      const browser = new window.ethers.BrowserProvider(walletProvider);
      if (Number((await browser.getNetwork()).chainId) !== config.chainId) throw new Error(`Switch your wallet to chain ${config.chainId}.`);
      const signer = await browser.getSigner();
      if (window.ethers.getAddress(await signer.getAddress()) !== window.ethers.getAddress(fresh.originalWallet)) throw new Error("Only the winning ticket's original wallet can authorize a prize receiver.");
      const manager = new window.ethers.Contract(config.raffleProxy, ["function claimNonce(address) view returns(uint256)", "function claimPrizeTo(uint256 roundId,uint8 prizeIndex,address receiver,uint64 expiry,bytes signature)"], signer);
      const nonce = await manager.claimNonce(fresh.originalWallet), expiry = Math.floor(Date.now() / 1000) + 300;
      const itemId = BigInt(window.ethers.keccak256(window.ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "uint8"], [BigInt(fresh.roundId), prizeIndex])));
      const domain = { name: "Project DYNO", version: "1", chainId: config.chainId, verifyingContract: config.raffleProxy };
      const types = { ClaimAuthorization: [{ name: "kind", type: "bytes32" }, { name: "itemId", type: "uint256" }, { name: "receiver", type: "address" }, { name: "nonce", type: "uint256" }, { name: "expiry", type: "uint64" }] };
      status.textContent = `Sign the five-minute draw ${prizeIndex + 1} receiver authorization; no RON has moved yet.`;
      const signature = await signer.signTypedData(domain, types, { kind: window.ethers.id("PRIZE"), itemId, receiver, nonce, expiry });
      status.textContent = "Submit the RON prize claim in your wallet…";
      const tx = await manager.claimPrizeTo(BigInt(fresh.roundId), prizeIndex, receiver, expiry, signature);
      status.textContent = `Submitted ${tx.hash}. Waiting for confirmation…`;
      const receipt = await tx.wait();
      if (receipt.status !== 1) throw new Error("Prize claim reverted; the entitlement remains on chain.");
      status.textContent = `Claim confirmed in block ${receipt.blockNumber}. Refreshing prize status…`;
      await showTicket(await readTicket(fresh.ticketId));
    } catch (error) {
      status.textContent = error?.code === "ACTION_REJECTED" ? "Wallet request rejected; no prize claim was completed." :
        error?.message === "Only the winning ticket's original wallet can authorize a prize receiver." || error?.message === "This prize is no longer claimable; refresh the ticket." ? error.message :
        "Prize claim was not completed. Check the receiver, signature and on-chain winner status before retrying.";
    } finally { busy = false; action.disabled = false; check.disabled = false; }
  }
  check.addEventListener("click", async () => {
    if (busy) return;
    const ticketId = input.value.trim(); ticket = null; claim.hidden = true; receiverLabel.hidden = true; claimTo.hidden = true;
    if (!validId(ticketId)) { status.textContent = "Enter a valid positive ticket ID."; return; }
    busy = true; check.disabled = true; status.textContent = "Reading ticket from chain…";
    try { await showTicket(await readTicket(ticketId)); }
    catch (error) { status.textContent = error.message; }
    finally { busy = false; check.disabled = false; }
  });
  claim.addEventListener("click", async () => {
    if (busy || !ticket || !config || !["REFUND_CREDITED", "CANCELLED_CREDITED"].includes(ticket.status) || ticket.refundPaid) return;
    const walletProvider = window.ronin?.provider || window.ethereum;
    if (!walletProvider) { status.textContent = "Connect the original purchasing wallet to claim."; return; }
    busy = true; claim.disabled = true; check.disabled = true;
    try {
      const browser = new window.ethers.BrowserProvider(walletProvider);
      if (Number((await browser.getNetwork()).chainId) !== config.chainId) throw new Error(`Switch your wallet to chain ${config.chainId}.`);
      const signer = await browser.getSigner();
      if (window.ethers.getAddress(await signer.getAddress()) !== window.ethers.getAddress(ticket.originalWallet)) throw new Error("Only the original purchasing wallet can use this direct refund claim.");
      const manager = new window.ethers.Contract(config.raffleProxy, ["function claimRefund(uint256 ticketId)"], signer);
      status.textContent = "Approve the refund claim in your wallet. No transaction has been sent yet.";
      const tx = await manager.claimRefund(BigInt(ticket.ticketId));
      status.textContent = `Submitted ${tx.hash}. Waiting for confirmation…`;
      const receipt = await tx.wait();
      if (receipt.status !== 1) throw new Error("Refund claim reverted; the credit remains on chain.");
      status.textContent = `Claim confirmed in block ${receipt.blockNumber}. Refreshing ticket…`;
      await showTicket(await readTicket(ticket.ticketId));
    } catch (error) {
      const known = ["Only the original purchasing wallet can use this direct refund claim.", "Refund claim reverted; the credit remains on chain."];
      status.textContent = error?.code === "ACTION_REJECTED" ? "Wallet request rejected; no refund claim was submitted." :
        (known.includes(error?.message) || /^Switch your wallet to chain [0-9]+\.$/.test(error?.message || "")) ? error.message :
        "Refund claim was not completed. Check your wallet and the on-chain ticket status before retrying.";
    }
    finally { busy = false; claim.disabled = false; check.disabled = false; }
  });
  claimTo.addEventListener("click", async () => {
    if (busy || !ticket || !config || !["REFUND_CREDITED", "CANCELLED_CREDITED"].includes(ticket.status) || ticket.refundPaid) return;
    let receiver;
    try { receiver = window.ethers.getAddress(receiverInput.value.trim()); }
    catch { status.textContent = "Enter a valid alternate RON and MATT receiver address."; return; }
    if (receiver === window.ethers.ZeroAddress || receiver === window.ethers.getAddress(ticket.originalWallet)) { status.textContent = "Choose a nonzero receiver different from the original wallet."; return; }
    if (!window.confirm(`Send this ticket's ${readableRon(ticket.refundAmount)} and ${readableMatt(ticket.refundMatt)} refund to ${receiver}? This cannot be reversed.`)) return;
    const walletProvider = window.ronin?.provider || window.ethereum;
    if (!walletProvider) { status.textContent = "Connect the original purchasing wallet to authorize this receiver."; return; }
    busy = true; claimTo.disabled = true; claim.disabled = true; check.disabled = true;
    try {
      const browser = new window.ethers.BrowserProvider(walletProvider);
      if (Number((await browser.getNetwork()).chainId) !== config.chainId) throw new Error(`Switch your wallet to chain ${config.chainId}.`);
      const signer = await browser.getSigner();
      if (window.ethers.getAddress(await signer.getAddress()) !== window.ethers.getAddress(ticket.originalWallet)) throw new Error("Only the original purchasing wallet can authorize an alternate receiver.");
      const manager = new window.ethers.Contract(config.raffleProxy, ["function claimNonce(address) view returns(uint256)", "function claimRefundTo(uint256 ticketId,address receiver,uint64 expiry,bytes signature)"], signer);
      const nonce = await manager.claimNonce(ticket.originalWallet);
      const expiry = Math.floor(Date.now() / 1000) + 300;
      const domain = { name: "Project DYNO", version: "1", chainId: config.chainId, verifyingContract: config.raffleProxy };
      const types = { ClaimAuthorization: [{ name: "kind", type: "bytes32" }, { name: "itemId", type: "uint256" }, { name: "receiver", type: "address" }, { name: "nonce", type: "uint256" }, { name: "expiry", type: "uint64" }] };
      const authorization = { kind: window.ethers.id("REFUND"), itemId: BigInt(ticket.ticketId), receiver, nonce, expiry };
      status.textContent = "Sign the five-minute receiver authorization; neither RON nor MATT has moved yet.";
      const signature = await signer.signTypedData(domain, types, authorization);
      status.textContent = "Submit the alternate-receiver claim in your wallet…";
      const tx = await manager.claimRefundTo(BigInt(ticket.ticketId), receiver, expiry, signature);
      status.textContent = `Submitted ${tx.hash}. Waiting for confirmation…`;
      const receipt = await tx.wait();
      if (receipt.status !== 1) throw new Error("Alternate claim reverted; the credit remains on chain.");
      status.textContent = `Claim confirmed in block ${receipt.blockNumber}. Refreshing ticket…`;
      await showTicket(await readTicket(ticket.ticketId));
    } catch (error) {
      status.textContent = error?.code === "ACTION_REJECTED" ? "Wallet request rejected; no alternate claim was completed." :
        error?.message === "Only the original purchasing wallet can authorize an alternate receiver." ? error.message :
        "Alternate claim was not completed. Check receiver, signature expiry and on-chain ticket status before retrying.";
    } finally { busy = false; claimTo.disabled = false; claim.disabled = false; check.disabled = false; }
  });
  fetch("/api/dyno/config", { cache: "no-store" }).then(response => response.ok ? response.json() : null).then(value => {
    if (value && !value.mock && value.raffleProxy) { config = value; check.disabled = false; }
    else status.textContent = "Claims are unavailable in the local mock or before live contracts are configured.";
  }).catch(() => { status.textContent = "Claim configuration unavailable."; });
})();
