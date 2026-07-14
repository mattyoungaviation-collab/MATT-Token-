(() => {
  'use strict';

  const config = window.MATT_COIN_FLIP_CONFIG || {};
  const section = document.getElementById('coin-flip');
  if (!section || !config.burnEdition || !config.contractAddress) return;

  let refreshBusy = false;
  let retryTimer = null;

  for (const link of document.querySelectorAll('a[href="#coin-flip"]')) {
    if (link.closest('.desktop-nav')) link.textContent = 'BurnFlip';
  }

  const heading = section.querySelector('.section-heading');
  if (heading) {
    heading.innerHTML = `
      <p class="eyebrow">MATT UTILITY #1 · LIVE ON RONIN</p>
      <h2>MATT BurnFlip</h2>
      <p>Call heads or tails and wager any amount the live bankroll can safely cover. Winners receive 2× their bet directly from the contract.</p>
    `;
  }

  if (!section.querySelector('.burnflip-promise')) {
    const promise = document.createElement('article');
    promise.className = 'burnflip-promise';
    promise.innerHTML = `
      <div class="burnflip-flame" aria-hidden="true">🔥</div>
      <div>
        <p class="eyebrow">DEFLATIONARY COIN FLIP</p>
        <h3>100% OF LOSING BETS ARE PERMANENTLY BURNED</h3>
        <p>Every losing MATT wager is destroyed forever. <strong>No treasury. No redistribution.</strong> Every loss permanently reduces the total MATT supply.</p>
      </div>
    `;

    const live = document.createElement('div');
    live.className = 'burnflip-live-stats';
    live.setAttribute('aria-label', 'Live MATT BurnFlip statistics');
    live.innerHTML = `
      <article class="burnflip-stat burn-stat"><span>🔥 Total MATT Burned</span><strong id="burnflip-total-burned">Loading…</strong></article>
      <article class="burnflip-stat"><span>🎲 Total BurnFlips</span><strong id="burnflip-total-flips">Loading…</strong></article>
      <article class="burnflip-stat"><span>🏆 Total MATT Won</span><strong id="burnflip-total-won">Loading…</strong></article>
      <article class="burnflip-stat"><span>💰 Current Bankroll</span><strong id="burnflip-bankroll">Loading…</strong></article>
    `;

    const reasons = document.createElement('div');
    reasons.className = 'burnflip-reasons';
    reasons.innerHTML = `
      <strong>WHY PLAY BURNFLIP?</strong>
      <span>✓ Fair commit/reveal result</span>
      <span>✓ Bet up to the live bankroll limit</span>
      <span>✓ Automatic 2× payouts</span>
      <span>✓ Every losing bet reduces supply</span>
    `;

    section.querySelector('.game-card')?.before(promise, live, reasons);
  }

  const amountInput = document.getElementById('coin-bet-amount');
  if (amountInput) {
    amountInput.removeAttribute('max');
    amountInput.setAttribute('placeholder', 'Enter any supported amount');
  }

  const quickValues = [
    ['1000', '1K'],
    ['100000', '100K'],
    ['1000000', '1M'],
    ['10000000', '10M']
  ];
  [...document.querySelectorAll('.coin-quick-button')].forEach((button, index) => {
    if (!quickValues[index]) return;
    button.dataset.bet = quickValues[index][0];
    button.textContent = quickValues[index][1];
  });

  const warning = section.querySelector('.coin-game-warning');
  if (warning) {
    warning.innerHTML = '<strong>Keep this browser open or preserve its storage while a bet is pending.</strong> The secret never leaves your device before reveal. If the reveal window expires, 100% of the unrevealed stake is permanently burned.';
  }

  const legalText = section.querySelector('.coin-legal-check span');
  if (legalText) {
    legalText.textContent = 'I confirm I am at least 18, permitted to use token wagering where I live, and understand that 100% of a losing bet is permanently burned.';
  }

  const contractStripLabel = section.querySelector('.coin-contract-strip span');
  if (contractStripLabel) contractStripLabel.textContent = 'BURNFLIP CONTRACT';

  const statLabels = [...section.querySelectorAll('.game-stats span')];
  if (statLabels.length >= 3) {
    statLabels[0].textContent = 'Your bets';
    statLabels[1].textContent = 'Your wins';
    statLabels[2].textContent = 'Your pending';
  }

  const result = document.getElementById('flip-result');
  if (result) {
    const replaceTreasuryText = () => {
      if (/sent to treasury/i.test(result.textContent)) {
        result.textContent = result.textContent.replace(/sent to treasury/gi, 'PERMANENTLY BURNED');
      }
    };
    new MutationObserver(replaceTreasuryText).observe(result, { childList: true, characterData: true, subtree: true });
    replaceTreasuryText();
  }

  function formatMatt(rawValue, precision = 2) {
    const raw = BigInt(rawValue || '0');
    const divisor = 10n ** 18n;
    const whole = raw / divisor;
    const decimal = (raw % divisor).toString().padStart(18, '0');
    const fraction = decimal.slice(0, precision).replace(/0+$/, '');
    return `${whole.toLocaleString()}${fraction ? `.${fraction}` : ''} MATT`;
  }

  function setUnavailable(message = 'Temporarily unavailable') {
    document.querySelectorAll('.burnflip-live-stats strong').forEach(element => {
      if (element.textContent === 'Loading…') element.textContent = message;
    });
  }

  async function refreshLiveStats({ fresh = false } = {}) {
    if (refreshBusy) return;
    refreshBusy = true;
    clearTimeout(retryTimer);
    try {
      const response = await fetch(`/api/burnflip-stats${fresh ? '?fresh=1' : ''}`, {
        credentials: 'same-origin',
        cache: fresh ? 'no-store' : 'default'
      });
      const payload = await response.json().catch(() => ({}));
      if (response.status === 202) {
        retryTimer = setTimeout(() => refreshLiveStats(), 2_000);
        return;
      }
      if (!response.ok) throw new Error(payload.message || `Stats returned HTTP ${response.status}`);

      document.getElementById('burnflip-total-burned').textContent = formatMatt(payload.totalBurnedRaw);
      document.getElementById('burnflip-total-flips').textContent = BigInt(payload.totalFlips || '0').toLocaleString();
      document.getElementById('burnflip-total-won').textContent = formatMatt(payload.totalWonRaw);
      document.getElementById('burnflip-bankroll').textContent = formatMatt(payload.availableBankrollRaw);
    } catch (error) {
      console.error('Could not load shared BurnFlip statistics:', error);
      setUnavailable();
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
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshLiveStats();
  });
})();
