(() => {
  'use strict';
  const section = document.getElementById('burnflip-history');
  if (!section) return;
  let running = false;

  async function decorate() {
    if (running || !window.MattProfiles) return;
    running = true;
    try {
      const anchors = [...section.querySelectorAll('a[href*="/address/0x"]')];
      const wallets = anchors.map(anchor => anchor.href.match(/\/address\/(0x[0-9a-fA-F]{40})/)?.[1]).filter(Boolean);
      await window.MattProfiles.lookup(wallets);
      for (const anchor of anchors) {
        const wallet = anchor.href.match(/\/address\/(0x[0-9a-fA-F]{40})/)?.[1]?.toLowerCase();
        if (!wallet) continue;
        const name = window.MattProfiles.username(wallet);
        const key = `${wallet}:${name || ''}`;
        if (anchor.dataset.profileKey === key) continue;
        anchor.dataset.profileKey = key;
        anchor.innerHTML = name
          ? `<strong>${escapeHtml(name)}</strong><small style="display:block;opacity:.65">${window.MattProfiles.short(wallet)}</small>`
          : window.MattProfiles.short(wallet);
        anchor.title = wallet;
      }
      const own = document.getElementById('bf-player-wallet');
      const wallet = window.MattProfiles.currentWallet();
      if (own && wallet) {
        const name = window.MattProfiles.username(wallet);
        const next = name ? `${name} · ${window.MattProfiles.short(wallet)}` : window.MattProfiles.short(wallet);
        if (own.textContent !== next) own.textContent = next;
        own.title = wallet;
      }
    } finally { running = false; }
  }
  function escapeHtml(value) { const div = document.createElement('div'); div.textContent = String(value); return div.innerHTML; }
  const observer = new MutationObserver(() => setTimeout(decorate, 0));
  observer.observe(section, { childList: true, subtree: true });
  document.addEventListener('matt:profiles-updated', decorate);
  setInterval(decorate, 3000);
  decorate();
})();
