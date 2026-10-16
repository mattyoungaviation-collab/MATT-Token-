(() => {
  "use strict";

  const OPENS_AT = Date.parse("2026-10-17T07:00:00Z");
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
    const message = reached
      ? "Project DYNO has reached its scheduled opening time — one MATT raffle with six prize draws on Ronin."
      : `Project DYNO opens in ${countdown} — one MATT raffle, six prize draws, 1,000 eligible tickets. 35 RON + 700,000 MATT per ticket.`;
    const pageUrl = location.hostname === "localhost" || location.hostname === "127.0.0.1"
      ? "https://matttoken.com/project-dyno"
      : new URL("/project-dyno", location.origin).href;
    const params = new URLSearchParams({ text: `${message}\n\n#MATT #Ronin`, url: pageUrl });
    return { href: `https://twitter.com/intent/tweet?${params}`, preview: reached ? "THE SCHEDULED OPENING TIME HAS ARRIVED." : `OPENS IN ${countdown.toUpperCase()}` };
  }

  function renderCountdown() {
    let remaining = Math.max(0, OPENS_AT - Date.now());
    const values = {};

    for (const [name, duration] of Object.entries(units)) {
      values[name] = Math.floor(remaining / duration);
      remaining %= duration;
      setUnit(name, values[name]);
    }

    const reached = OPENS_AT <= Date.now();
    document.documentElement.dataset.raffleOpeningReached = String(reached);
    document.querySelectorAll("[data-countdown-status]").forEach(element => {
      element.textContent = reached
        ? "Scheduled opening reached — check the live raffle status."
        : "One raffle. Six prize draws. 1,000 eligible tickets.";
    });
    document.querySelectorAll("[data-raffle-cta]").forEach(element => {
      element.textContent = reached ? "CHECK ENTRY STATUS" : "VIEW ENTRY DETAILS";
    });
    const share = shareUrl(values, reached);
    document.querySelectorAll("[data-x-share]").forEach(element => {
      element.href = share.href;
      element.setAttribute("aria-label", reached ? "Share Project Dyno on X" : `Share the Project Dyno countdown on X: ${share.preview}`);
    });
    document.querySelectorAll("[data-share-preview]").forEach(element => {
      element.textContent = share.preview;
    });
  }

  renderCountdown();
  const timer = window.setInterval(renderCountdown, 1_000);
  window.addEventListener("pagehide", () => window.clearInterval(timer), { once: true });
})();
