(() => {
  'use strict';

  const config = window.MATT_COIN_FLIP_CONFIG || {};
  const section = document.getElementById('coin-flip');
  if (!section || !config.burnEdition) return;

  let refreshBusy = false;

  for (const link of document.querySelectorAll('a[href="#coin-flip"]')) {
    if (link.closest('.desktop-nav')) link.textContent = 'BurnFlip';
  }

  if (!section.querySelector('.burnflip-promise')) {
    const promise = document.createElement('article');
    promise.className = 'burnflip-promise';
    promise.innerHTML = `
      <div class="burnflip-flame" aria-hidden="true">🔥</div>
      <div>
        <p class="eyebrow">UNIVERSAL ECOSYSTEM WAGERING</p>
        <h3>WAGER ECOSYSTEM ASSETS. SETTLE ONLY IN MATT.</h3>
        <p>Every wager moves directly to the treasury Safe. Winners receive MATT from the dedicated Reward Vault; losses burn the configured MATT amount from that vault.</p>
      </div>
    `;

    const live = document.createElement('div');
    live.className = 'burnflip-live-stats';
    live.setAttribute('aria-label', 'Live MATT BurnFlip statistics');
    live.innerHTML = `
      <article class="burnflip-stat burn-stat"><span>🔥 Total MATT Burned</span><strong id="burnflip-total-burned">Loading…</strong></article>
      <article class="burnflip-stat"><span>🎲 Total BurnFlips</span><strong id="burnflip-total-flips">Loading…</strong></article>
      <article class="burnflip-stat"><span>🏆 Total MATT Paid</span><strong id="burnflip-total-paid">Loading…</strong></article>
      <article class="burnflip-stat"><span>💰 Reward Vault Available</span><strong id="burnflip-vault-available">Loading…</strong></article>
    `;

    const reasons = document.createElement('div');
    reasons.className = 'burnflip-reasons';
    reasons.innerHTML = `
      <strong>HOW BURNFLIP WORKS</strong>
      <span>✓ Katana V3 TWAP pricing</span>
      <span>✓ Immediate treasury transfer</span>
      <span>✓ MATT-only 2× payout</span>
      <span>✓ 75% MATT-equivalent burn on loss</span>
    `;

    section.querySelector('.game-card')?.before(promise, live, reasons);
  }

  function formatMatt(rawValue, precision = 2) {
    const raw = BigInt(rawValue || '0');
    const divisor = 10n ** 18n;
    const whole = raw / divisor;
    const decimal = (raw % divisor).toString().padStart(18, '0');
    const fraction = decimal.slice(0, precision).replace(/0+$/, '');
    return `${whole.toLocaleString()}${fraction ? `.${fraction}` : ''} MATT`;
  }

  function setUnavailable(message = 'Unavailable') {
    section.querySelectorAll('.burnflip-live-stats strong').forEach(element => {
      if (element.textContent === 'Loading…') element.textContent = message;
    });
  }

  async function refreshLiveStats({ fresh = false } = {}) {
    if (refreshBusy) return;
    refreshBusy = true;
    try {
      const response = await fetch(`/api/burnflip-stats${fresh ? '?fresh=1' : ''}`, {
        credentials: 'same-origin',
        cache: fresh ? 'no-store' : 'default'
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.message || `Stats returned HTTP ${response.status}`);
      if (
        payload.status !== 'READY'
        || payload.totalBurnedRaw == null
        || payload.totalGames == null
        || payload.totalPaidRaw == null
        || payload.availableRewardRaw == null
      ) {
        throw new Error('BurnFlip statistics are not configured.');
      }

      document.getElementById('burnflip-total-burned').textContent = formatMatt(payload.totalBurnedRaw);
      document.getElementById('burnflip-total-flips').textContent = BigInt(payload.totalGames || '0').toLocaleString();
      document.getElementById('burnflip-total-paid').textContent = formatMatt(payload.totalPaidRaw);
      document.getElementById('burnflip-vault-available').textContent = formatMatt(payload.availableRewardRaw);
    } catch (error) {
      console.error('Could not load BurnFlip statistics:', error);
      setUnavailable(config.contractAddress ? 'Temporarily unavailable' : 'Deployment pending');
    } finally {
      refreshBusy = false;
    }
  }

  refreshLiveStats();
  window.setInterval(() => {
    if (!document.hidden) refreshLiveStats();
  }, 60_000);
  window.addEventListener('matt:burnflip-updated', () => {
    window.setTimeout(() => refreshLiveStats({ fresh: true }), 1_200);
  });
})();
