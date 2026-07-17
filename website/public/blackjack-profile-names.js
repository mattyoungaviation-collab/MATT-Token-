(() => {
  'use strict';
  let busy = false;

  async function decorate() {
    if (busy || !window.MattProfiles) return;
    busy = true;
    try {
      const response = await fetch('/api/blackjack/state', { cache: 'no-store' });
      if (!response.ok) return;
      const table = await response.json();
      const players = (table.seats || []).filter(Boolean);
      await window.MattProfiles.lookup(players.map(player => player.wallet));
      const seats = [...document.querySelectorAll('#seat-grid .seat')];
      (table.seats || []).forEach((player, index) => {
        if (!player || !seats[index]) return;
        const heading = seats[index].querySelector('strong');
        if (!heading) return;
        const mine = window.MattProfiles.currentWallet()?.toLowerCase() === String(player.wallet).toLowerCase();
        const name = window.MattProfiles.username(player.wallet);
        heading.textContent = mine ? (name ? `YOU · ${name}` : 'YOU') : (name || window.MattProfiles.short(player.wallet));
        heading.title = player.wallet;
        seats[index].dataset.wallet = player.wallet;
      });
      const wallet = window.MattProfiles.currentWallet();
      const walletDisplay = document.getElementById('wallet-address');
      if (wallet && walletDisplay) {
        const name = window.MattProfiles.username(wallet);
        walletDisplay.textContent = name ? `${name} · ${window.MattProfiles.short(wallet)}` : window.MattProfiles.short(wallet);
        walletDisplay.title = wallet;
      }
    } catch {} finally { busy = false; }
  }

  document.addEventListener('matt:profiles-updated', decorate);
  const observer = new MutationObserver(() => setTimeout(decorate, 0));
  const seatGrid = document.getElementById('seat-grid');
  if (seatGrid) observer.observe(seatGrid, { childList: true, subtree: true });
  setInterval(decorate, 1500);
  decorate();
})();
