(() => {
  "use strict";

  const TARGET_AT = Date.parse("2026-10-17T07:00:00Z");
  let checkoutEnabled = false;
  const units = {
    days: 86_400_000,
    hours: 3_600_000,
    minutes: 60_000,
    seconds: 1_000
  };

  function setUnit(name, value) {
    document.querySelectorAll(`[data-countdown-unit="${name}"]`).forEach(element => {
      element.textContent = String(value).padStart(2, "0");
    });
  }

  function shareUrl(values, reached) {
    const countdown = `${values.days}d ${values.hours}h ${values.minutes}m ${values.seconds}s`;
    const message = checkoutEnabled
      ? "Project DYNO's entry page reports ticket purchases enabled. Verify its contract and terms before paying."
      : reached
        ? "Project DYNO's target opening time has arrived. Ticket sales start only after final verification and the entry page confirms they are enabled."
        : `Project DYNO targets October 17 (${countdown} away), subject to final verification. Ticket sales are not yet enabled. 35 RON + 700,000 MATT per ticket.`;
    const pageUrl = location.hostname === "localhost" || location.hostname === "127.0.0.1"
      ? "https://matttoken.com/project-dyno"
      : new URL("/project-dyno", location.origin).href;
    const params = new URLSearchParams({ text: `${message}\n\n#MATT #Ronin`, url: pageUrl });
    return { href: `https://twitter.com/intent/tweet?${params}`, preview: checkoutEnabled ? "ENTRY STATUS: ENABLED · VERIFY BEFORE PAYING" : reached ? "TARGET TIME REACHED · CHECK LIVE STATUS" : `TARGET IN ${countdown.toUpperCase()} · CONDITIONAL` };
  }

  function renderCountdown() {
    let remaining = Math.max(0, TARGET_AT - Date.now());
    const values = {};

    for (const [name, duration] of Object.entries(units)) {
      values[name] = Math.floor(remaining / duration);
      remaining %= duration;
      setUnit(name, values[name]);
    }

    const reached = TARGET_AT <= Date.now();
    document.documentElement.dataset.raffleTargetReached = String(reached);
    document.querySelectorAll("[data-countdown-status]").forEach(element => {
      element.textContent = reached
        ? "Target time reached. This countdown does not activate ticket sales; check the entry page."
        : "Target only. Opening depends on final contract, VRF, operations and security checks.";
    });
    document.querySelectorAll("[data-raffle-cta]").forEach(element => {
      element.textContent = "CHECK ENTRY STATUS";
    });
    const share = shareUrl(values, reached);
    document.querySelectorAll("[data-x-share]").forEach(element => {
      element.href = share.href;
      element.setAttribute("aria-label", `Share the conditional Project Dyno target on X: ${share.preview}`);
    });
    document.querySelectorAll("[data-share-preview]").forEach(element => {
      element.textContent = share.preview;
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
        : "NOT LIVE — ticket purchases are disabled. Do not send assets to any raffle address.";
      status.dataset.live = String(enabled);
    } catch {
      checkoutEnabled = false;
      status.textContent = "Live status unavailable. Do not send assets; check again later.";
      status.dataset.live = "false";
    }
    renderCountdown();
  }

  renderCountdown();
  void refreshLiveStatus();
  const timer = window.setInterval(renderCountdown, 1_000);
  const statusTimer = window.setInterval(refreshLiveStatus, 60_000);
  window.addEventListener("pagehide", () => { window.clearInterval(timer); window.clearInterval(statusTimer); }, { once: true });
})();
