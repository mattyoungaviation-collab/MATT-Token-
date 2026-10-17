(() => {
  "use strict";

  let checkoutEnabled = false;

  function updateShare() {
    const message = checkoutEnabled
      ? "Project DYNO's entry page reports ticket purchases enabled. Verify its contract and terms before paying. 35 RON + 700,000 MATT per ticket."
      : "Check Project DYNO's live entry status, contract and terms before paying. 35 RON + 700,000 MATT per ticket.";
    const pageUrl = location.hostname === "localhost" || location.hostname === "127.0.0.1"
      ? "https://matttoken.com/project-dyno"
      : new URL("/project-dyno", location.origin).href;
    const params = new URLSearchParams({ text: `${message}\n\n#MATT #Ronin`, url: pageUrl });
    document.querySelectorAll("[data-x-share]").forEach(element => {
      element.href = `https://twitter.com/intent/tweet?${params}`;
      element.setAttribute("aria-label", "Share Project DYNO on X with a link to its live status");
    });
    document.querySelectorAll("[data-share-preview]").forEach(element => {
      element.textContent = checkoutEnabled ? "ENTRY STATUS: ENABLED · VERIFY BEFORE PAYING" : "CHECK THE LIVE ENTRY STATUS BEFORE PAYING";
    });
  }

  async function refreshLiveStatus() {
    const status = document.querySelector("[data-live-status]");
    if (!status) return;
    try {
      const response = await fetch("/api/dyno/health", { cache: "no-store", credentials: "omit" });
      if (!response.ok) throw new Error("health unavailable");
      const health = await response.json();
      const enabled = health.ok === true && health.enabled === true && health.purchasesEnabled === true && health.mock === false;
      checkoutEnabled = enabled;
      status.textContent = enabled
        ? "Entry page reports purchases enabled. Verify the published contract and terms before paying."
        : "Ticket purchases are currently disabled. Do not send assets to any raffle address.";
      status.dataset.live = String(enabled);
    } catch {
      checkoutEnabled = false;
      status.textContent = "Live status unavailable. Do not send assets; check again later.";
      status.dataset.live = "false";
    }
    updateShare();
  }

  updateShare();
  void refreshLiveStatus();
  const statusTimer = window.setInterval(refreshLiveStatus, 60_000);
  window.addEventListener("pagehide", () => window.clearInterval(statusTimer), { once: true });
})();
