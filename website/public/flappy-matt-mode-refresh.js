(() => {
  "use strict";

  const entryNode = document.querySelector("#entry-value");
  const playButton = document.querySelector("#play-button");
  const noticeNode = document.querySelector("#mode-notice");
  const alertNode = document.querySelector("#paid-mode-alert");
  let lastMode = null;

  function formatMatt(value) {
    const raw = BigInt(value || "0");
    const whole = raw / 10n ** 18n;
    return Number(whole).toLocaleString();
  }

  async function refresh() {
    try {
      const response = await fetch(`/api/flappy/config?fresh=${Date.now()}`, {
        cache: "no-store",
        headers: { "cache-control": "no-cache" }
      });
      if (!response.ok) return;
      const config = await response.json();
      const paid = config.mode === "PAID";

      if (entryNode) entryNode.textContent = paid ? `${formatMatt(config.entryRaw)} MATT` : "PAID TEMPORARILY UNAVAILABLE";
      if (noticeNode) noticeNode.textContent = paid
        ? config.notice
        : `${config.notice} Free practice remains available below while paid mode reconnects.`;

      if (playButton && !playButton.disabled && playButton.textContent !== "START GAME" && !/IN PROGRESS/i.test(playButton.textContent)) {
        const hasWallet = Boolean(localStorage.getItem("flappyMattWallet") && localStorage.getItem("flappyMattToken"));
        playButton.textContent = hasWallet
          ? paid ? `FLY FOR ${formatMatt(config.entryRaw)} MATT` : "PAID MODE RECONNECTING"
          : "CONNECT TO PLAY";
        playButton.disabled = hasWallet && !paid;
      }

      if (alertNode) {
        alertNode.hidden = !paid || lastMode !== "PRACTICE";
        if (!alertNode.hidden) alertNode.textContent = "Paid Flappy MATT is connected and ready. Refresh is no longer required.";
      }
      lastMode = config.mode;
    } catch {
      // Keep the current screen usable and try again on the next interval.
    }
  }

  refresh();
  setInterval(refresh, 5_000);
  window.addEventListener("pageshow", refresh);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
})();
