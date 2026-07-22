(() => {
  "use strict";
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const response = await originalFetch(...args);
    const url = typeof args[0] === "string" ? args[0] : String(args[0]?.url || "");
    if (!url.includes("/api/crash/state") || !response.ok) return response;
    try {
      const body = await response.clone().json();
      if (body.round) return response;
      const now = Number(body.serverTime || Date.now());
      body.round = {
        number: 0,
        roundId: null,
        phase: "betting",
        multiplier: 1,
        crashPoint: null,
        commitment: "Waiting for live keeper",
        seed: null,
        startAt: now,
        phaseEndsAt: now + 60_000
      };
      return new Response(JSON.stringify(body), {
        status: response.status,
        statusText: response.statusText,
        headers: { "content-type": "application/json", "cache-control": "no-store" }
      });
    } catch {
      return response;
    }
  };
})();
