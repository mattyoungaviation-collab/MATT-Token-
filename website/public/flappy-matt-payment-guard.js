(() => {
  "use strict";

  const STORAGE_KEY = "flappyMattPendingEntryV1";
  const REUSE_WINDOW_MS = 20 * 60_000;
  let poolAddress = null;
  let inFlightEntry = null;

  fetch("/api/flappy/config", { cache: "no-store" })
    .then(response => response.ok ? response.json() : null)
    .then(config => { poolAddress = String(config?.contractAddress || "").toLowerCase() || null; })
    .catch(() => {});

  function readPending() {
    try {
      const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      if (!value?.hash || !value?.createdAt || Date.now() - value.createdAt > REUSE_WINDOW_MS) {
        localStorage.removeItem(STORAGE_KEY);
        return null;
      }
      return value;
    } catch {
      localStorage.removeItem(STORAGE_KEY);
      return null;
    }
  }

  function savePending(value) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  }

  function clearPending() {
    localStorage.removeItem(STORAGE_KEY);
    inFlightEntry = null;
  }

  function sameEntry(transaction, pending) {
    return Boolean(
      pending &&
      String(transaction?.to || "").toLowerCase() === String(pending.to || "").toLowerCase() &&
      String(transaction?.from || "").toLowerCase() === String(pending.from || "").toLowerCase()
    );
  }

  function wrapProvider(provider) {
    if (!provider || typeof provider.request !== "function" || provider.__flappyMattPaymentGuard) return;
    const originalRequest = provider.request.bind(provider);
    Object.defineProperty(provider, "__flappyMattPaymentGuard", { value: true });

    provider.request = async request => {
      const method = String(request?.method || "");
      const transaction = request?.params?.[0];
      const destination = String(transaction?.to || "").toLowerCase();
      const isPoolEntry = method === "eth_sendTransaction" && poolAddress && destination === poolAddress;
      if (!isPoolEntry) return originalRequest(request);

      const pending = readPending();
      if (sameEntry(transaction, pending)) {
        console.warn("Reusing the already-confirmed Flappy MATT entry instead of charging again.");
        return pending.hash;
      }
      if (inFlightEntry) return inFlightEntry;

      inFlightEntry = originalRequest(request)
        .then(hash => {
          savePending({
            hash: String(hash),
            to: destination,
            from: String(transaction?.from || "").toLowerCase(),
            createdAt: Date.now()
          });
          return hash;
        })
        .finally(() => { inFlightEntry = null; });
      return inFlightEntry;
    };
  }

  function findProvider() {
    return window.ronin?.provider || window.ronin || null;
  }

  const providerTimer = setInterval(() => {
    const provider = findProvider();
    if (provider) wrapProvider(provider);
  }, 250);
  setTimeout(() => clearInterval(providerTimer), 30_000);
  wrapProvider(findProvider());

  const observer = new MutationObserver(() => {
    const title = document.getElementById("overlay-title")?.textContent || "";
    if (/FLIGHT READY|SCORE /i.test(title)) clearPending();
  });
  document.addEventListener("DOMContentLoaded", () => {
    const title = document.getElementById("overlay-title");
    if (title) observer.observe(title, { childList: true, characterData: true, subtree: true });
  });
})();
