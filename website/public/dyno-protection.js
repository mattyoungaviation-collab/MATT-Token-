(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  let current = null, busy = false;
  async function json(url, options) {
    const response = await fetch(url, { cache: "no-store", ...options });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "Safeguards unavailable");
    return body;
  }
  const percent = raw => window.ethers.formatUnits(BigInt(raw), 2);
  const bps = value => window.ethers.parseUnits(String(value), 2).toString();
  function clearDraft() { $("protection-output").value = ""; $("protection-copy").disabled = true; }
  function controls() {
    $("protection-fields").disabled = busy || !current?.canPropose;
    $("protection-refresh").disabled = busy;
    for (const kind of ["sale", "buyback", "guard"]) $("protection-" + kind + "-submit").disabled = busy || !current?.[kind + "Editable"];
  }
  function render(result) {
    current = result.available === false ? null : result; clearDraft(); controls();
    $("protection-current").replaceChildren();
    if (!current) { $("protection-status").textContent = "Local mock / not deployed. Live controls are disabled; no invented contract targets."; return; }
    const rows = [["Ticket-sale slippage", percent(current.current.saleSlippageBps) + "%"], ["Buyback slippage", percent(current.current.buybackSlippageBps) + "%"], ["Reference mode", current.current.referenceWindowSeconds === "0" ? "SPOT ONLY — high manipulation risk" : current.current.referenceWindowSeconds + " seconds"], ["Spot/reference deviation", current.current.referenceWindowSeconds === "0" ? "Not applied in spot-only mode" : percent(current.current.maximumDeviationBps) + "%"], ["Minimum liquidity (raw units)", current.current.minimumLiquidity], ["Guard address", current.guardAddress], ["Checkout / buybacks", (current.checkoutPaused ? "Paused" : "Not paused") + " / " + (current.buybackPaused ? "Paused" : "Not paused")]];
    for (const [label, value] of rows) { const row = document.createElement("div"), dt = document.createElement("dt"), dd = document.createElement("dd"); dt.textContent = label; dd.textContent = value; row.append(dt, dd); $("protection-current").append(row); }
    $("protection-sale-value").value = percent(current.current.saleSlippageBps); $("protection-buyback-value").value = percent(current.current.buybackSlippageBps);
    $("protection-window").value = current.current.referenceWindowSeconds; $("protection-deviation").value = percent(current.current.maximumDeviationBps); $("protection-liquidity").value = current.current.minimumLiquidity;
    $("protection-status").textContent = `Chain block ${current.chainBlock} (unfinalized read). ${current.canPropose ? (current.executionMode === "emergency-wallet" ? "Emergency admin authenticated. This wallet can execute alone; no multisig signatures required." : "Multisig owner authenticated. Prepare changes below; signing happens in your multisig.") : "Public view. Authenticate a multisig owner or the active emergency admin, then refresh."}`;
  }
  async function refresh(admin = false) {
    busy = true; controls(); clearDraft();
    try { render(await json(`/api/dyno/${admin ? "admin/" : ""}protection?roundId=${encodeURIComponent($("protection-round").value)}`)); }
    catch (error) { current = null; $("protection-current").replaceChildren(); $("protection-status").textContent = `Controls unavailable: ${error.message}. Connect/authenticate an owner wallet and refresh. No change was submitted.`; }
    finally { busy = false; controls(); }
  }
  async function prepare(kind) {
    if (busy || !current?.canPropose) return;
    busy = true; controls(); clearDraft();
    try {
      const request = { kind, roundId: current.roundId, expected: current.current };
      if (kind === "guard") Object.assign(request, { referenceWindowSeconds: $("protection-window").value, maximumDeviationBps: bps($("protection-deviation").value), minimumLiquidity: $("protection-liquidity").value });
      else request.value = bps($("protection-" + kind + "-value").value);
      const draft = await json("/api/dyno/admin/protection/prepare", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request) });
      $("protection-output").value = JSON.stringify(draft, null, 2); $("protection-copy").disabled = false;
      $("protection-status").textContent = draft.executionMode === "emergency-wallet" ? "Simulation passed. Unsigned emergency-wallet draft: this wallet can execute alone. Inspect target, calldata and risks. No setting has changed yet." : "Simulation passed. Unsigned draft only: inspect old/new values and risks, copy into your multisig, and collect the required signatures. No setting has changed yet.";
    } catch (error) { current = null; $("protection-status").textContent = `No change submitted: ${error.message}. Refresh current settings before preparing again.`; }
    finally { busy = false; controls(); }
  }
  $("protection-refresh").addEventListener("click", () => refresh(true));
  $("protection-round").addEventListener("input", () => { current = null; clearDraft(); controls(); });
  for (const kind of ["sale", "buyback", "guard"]) $("protection-" + kind).addEventListener("submit", event => { event.preventDefault(); prepare(kind); });
  $("protection-copy").addEventListener("click", async () => { try { await navigator.clipboard.writeText($("protection-output").value); $("protection-status").textContent = "Draft copied. This is not an on-chain approval or execution."; } catch { $("protection-status").textContent = "Select and copy the preview manually. No transaction was submitted."; } });
  refresh();
})();
