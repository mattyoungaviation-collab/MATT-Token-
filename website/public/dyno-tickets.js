(function () {
  "use strict";
  const event = "event TicketPurchased(uint256 indexed roundId,uint256 indexed ticketId,address indexed wallet,bytes32 accountCommitment,uint64 dayIndex,uint256 directRon,uint256 saleRon)";
  function purchasedTickets(ethers, receipt, expected) {
    if (receipt?.status !== 1) throw new Error("Purchase is not confirmed.");
    const iface = new ethers.Interface([event]);
    const rows = [];
    for (const log of receipt.logs || []) {
      if (log.address?.toLowerCase() !== expected.manager.toLowerCase()) continue;
      let parsed;
      try { parsed = iface.parseLog(log); } catch { continue; }
      if (!parsed || parsed.name !== "TicketPurchased") continue;
      const p = parsed.args;
      if (p.wallet.toLowerCase() !== expected.wallet.toLowerCase() || p.roundId.toString() !== expected.roundId) continue;
      rows.push({ ticketId: p.ticketId.toString(), roundId: p.roundId.toString(), wallet: p.wallet,
        directRon: p.directRon.toString(), txHash: receipt.hash, blockNumber: receipt.blockNumber });
    }
    if (rows.length !== expected.quantity || new Set(rows.map(row => row.ticketId)).size !== rows.length)
      throw new Error("Transaction mined, but ticket confirmation needs checking. Check the transaction before purchasing again.");
    return rows;
  }
  if (typeof module !== "undefined" && module.exports) { module.exports = { purchasedTickets }; return; }
  const $ = id => document.getElementById(id);
  let wallet = null, generation = 0, nextOffset = null, loading = false;
  let indexed = [], recent = [];
  const dialog = $("purchase-confirmation");
  function link(hash) {
    const a = document.createElement("a");
    a.textContent = "View transaction ↗"; a.target = "_blank"; a.rel = "noopener noreferrer";
    if (/^0x[a-fA-F0-9]{64}$/.test(hash)) a.href = `https://explorer.roninchain.com/tx/${hash}`;
    return a;
  }
  function render() {
    const host = $("my-ticket-list");
    const seen = new Set();
    const rows = [...indexed, ...recent].filter(row => {
      if (row.wallet.toLowerCase() !== wallet?.toLowerCase() || seen.has(row.ticketId)) return false;
      seen.add(row.ticketId); return true;
    }).sort((a, b) => BigInt(a.ticketId) > BigInt(b.ticketId) ? -1 : 1);
    host.replaceChildren();
    for (const row of rows) {
      const card = document.createElement("article"), title = document.createElement("h3");
      const status = document.createElement("p"), actions = document.createElement("div"), claim = document.createElement("button");
      card.className = "my-ticket"; title.textContent = `Ticket #${row.ticketId}`;
      status.textContent = `Round ${row.roundId} · ${row.indexed ? "Indexed purchase" : "Confirmed · awaiting index"}`;
      claim.className = "secondary"; claim.type = "button"; claim.textContent = "STATUS & CLAIMS";
      claim.addEventListener("click", () => {
        document.querySelector('[data-tab="claims"]').click();
        $("claim-ticket").value = row.ticketId;
        $("tab-claims").scrollIntoView({ behavior: "smooth", block: "center" });
        $("claim-ticket").focus(); $("claim-button").click();
      });
      actions.append(link(row.txHash), claim); card.append(title, status, actions); host.append(card);
    }
    $("my-ticket-count").textContent = wallet ? `${rows.length} ticket${rows.length === 1 ? "" : "s"} loaded` : "";
    $("my-tickets-more").hidden = nextOffset === null;
    $("my-tickets-more").disabled = loading;
    $("my-tickets-refresh").disabled = !wallet || loading;
  }
  async function refresh(more = false) {
    if (!wallet || loading) return;
    const selected = wallet, run = generation;
    loading = true; render();
    $("my-tickets-status").textContent = "Loading your ticket history…";
    try {
      const response = await fetch(`/api/dyno/wallet-tickets?wallet=${encodeURIComponent(selected)}&offset=${more ? nextOffset : 0}`, { cache: "no-store" });
      if (!response.ok) throw new Error("Ticket history is temporarily unavailable. Refresh to try again.");
      const result = await response.json();
      if (run !== generation) return;
      if (result.wallet?.toLowerCase() !== selected.toLowerCase() || !result.indexedBlockHash || !Array.isArray(result.rows))
        throw new Error("Ticket history could not be verified.");
      const rows = result.rows.map(row => {
        const p = row.payload;
        if (row.event_name !== "TicketPurchased" || p?.wallet?.toLowerCase() !== selected.toLowerCase() ||
            !/^[1-9][0-9]*$/.test(p.ticketId) || !/^[1-9][0-9]*$/.test(p.roundId)) throw new Error("Ticket history could not be verified.");
        return { ...p, txHash: "0x" + row.tx_hash.replace(/^0x/, ""), indexed: true };
      });
      indexed = more ? [...indexed, ...rows] : rows;
      nextOffset = Number.isSafeInteger(result.nextOffset) ? result.nextOffset : null;
      $("my-tickets-status").textContent = `${indexed.length || recent.length ? "Purchase history" : "No indexed tickets for this wallet yet"} · indexed through block ${result.indexedBlock}. New purchases may take time to appear. Use Status & Claims for current eligibility.`;
    } catch (error) {
      if (run === generation) $("my-tickets-status").textContent = error.message;
    } finally {
      if (run === generation) { loading = false; render(); }
    }
  }
  function setWallet(value) {
    if (value?.toLowerCase() === wallet?.toLowerCase()) return;
    wallet = value; generation++; loading = false; indexed = []; recent = []; nextOffset = null;
    if (dialog.open) dialog.close();
    $("my-tickets-wallet").textContent = wallet || "Connect your wallet to see your tickets.";
    $("my-tickets-status").textContent = "";
    render(); if (wallet) refresh();
  }
  function confirmed(receipt, expected) {
    const rows = purchasedTickets(window.ethers, receipt, expected);
    if (wallet?.toLowerCase() !== expected.wallet.toLowerCase()) return;
    recent.push(...rows); render();
    $("confirmation-message").textContent = `${rows.length} ticket${rows.length === 1 ? "" : "s"} purchased for round ${expected.roundId}.`;
    $("confirmation-tickets").textContent = rows.map(row => `#${row.ticketId}`).join(" · ");
    $("confirmation-transaction").replaceChildren(link(receipt.hash));
    if (!dialog.open) dialog.showModal();
    refresh();
  }
  $("confirmation-close").addEventListener("click", () => dialog.close());
  $("confirmation-view").addEventListener("click", () => {
    dialog.close(); $("my-tickets").scrollIntoView({ behavior: "smooth" }); $("my-tickets-title").focus();
  });
  $("my-tickets-refresh").addEventListener("click", () => refresh());
  $("my-tickets-more").addEventListener("click", () => refresh(true));
  window.DynoTickets = { setWallet, confirmed };
})();
