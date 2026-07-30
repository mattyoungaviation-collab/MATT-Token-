(() => {
  'use strict';

  const config = window.MATT_COIN_FLIP_CONFIG || {};
  const section = document.getElementById('coin-flip');
  const card = section?.querySelector('.game-card');
  const actionButton = document.getElementById('flip-button');
  const result = document.getElementById('flip-result');
  if (!section || !card || !actionButton || !result || !config.burnEdition) return;

  card.classList.add('onchain-game-card', 'universal-burnflip-card');
  actionButton.textContent = 'CONNECT RONIN';
  actionButton.disabled = false;
  result.textContent = 'Choose an asset, enter an amount, and call the MATT coin.';

  const outcomeCoin = document.getElementById('coin');
  if (outcomeCoin) {
    outcomeCoin.classList.add('burnflip-outcome-coin');
    outcomeCoin.dataset.face = 'heads';
    outcomeCoin.setAttribute('aria-label', 'MATT coin showing heads');
    outcomeCoin.innerHTML = `
      <div class="coin-face burnflip-coin-side burnflip-coin-heads">
        <img src="/assets/matt-logo.gif" alt="" aria-hidden="true">
        <span class="burnflip-face-label">HEADS</span>
      </div>
      <div class="coin-face burnflip-coin-side burnflip-coin-tails" aria-hidden="true">
        <span class="burnflip-tail-mark">T</span>
        <span class="burnflip-face-label">TAILS</span>
      </div>
    `;
  }

  const heading = section.querySelector('.section-heading');
  if (heading) {
    heading.innerHTML = `
      <p class="eyebrow">MATT UTILITY #1 · LIVE ON RONIN</p>
      <h2>MATT BurnFlip</h2>
      <p>Wager a supported ecosystem asset. Every wager goes directly to the treasury, while every win and burn settles only in MATT.</p>
    `;
  }

  const oldPanel = document.querySelector('.onchain-bet-panel');
  oldPanel?.remove();
  const panel = document.createElement('div');
  panel.className = 'onchain-bet-panel burnflip-wager-panel';
  const options = (config.assets || []).map(asset => `
    <option value="${asset.address}" ${asset.enabled ? '' : 'disabled'}>
      ${asset.symbol}${asset.enabled ? '' : ' — unavailable'}
    </option>
  `).join('');
  panel.innerHTML = `
    <div class="coin-contract-strip">
      <span>UNIVERSAL BURNFLIP</span>
      ${config.contractAddress
        ? `<a id="coin-game-contract" href="${config.explorerAddressBase}${config.contractAddress}" target="_blank" rel="noopener">${config.contractAddress.slice(0, 8)}…${config.contractAddress.slice(-6)}</a>`
        : '<strong id="coin-game-contract">DEPLOYMENT PENDING</strong>'}
    </div>
    <div class="burnflip-input-grid">
      <label class="coin-amount-field burnflip-asset-field">
        <span>Wager asset</span>
        <select id="burnflip-asset" aria-label="BurnFlip wager asset">${options}</select>
      </label>
      <label class="coin-amount-field">
        <span>Wager amount</span>
        <span class="coin-amount-input-wrap">
          <input id="coin-bet-amount" type="number" inputmode="decimal" min="0" step="any" value="1" placeholder="Enter amount" aria-label="BurnFlip wager amount">
          <span id="burnflip-amount-symbol">RON</span>
        </span>
      </label>
      <button class="coin-max-button" id="coin-bet-max" type="button">MAX</button>
    </div>
    <div class="coin-game-info-grid burnflip-quote-grid">
      <div><span>Selected asset</span><strong id="burnflip-selected-asset">RON</strong></div>
      <div><span>Wallet balance</span><strong id="coin-wallet-balance">Connect wallet</strong></div>
      <div><span>Current MATT value</span><strong id="burnflip-matt-value">—</strong></div>
      <div><span>Potential payout</span><strong id="burnflip-payout">—</strong></div>
      <div><span>Potential burn</span><strong id="burnflip-burn">—</strong></div>
      <div><span>Reward vault available</span><strong id="coin-bankroll">Loading…</strong></div>
    </div>
    <div class="coin-game-flow" aria-label="On-chain BurnFlip flow">
      <div class="coin-game-step" data-step="commit"><b>01 CONFIRM</b><span>Review the MATT value quote and approve the wager.</span></div>
      <div class="coin-game-step" data-step="block"><b>02 RONIN BLOCK</b><span>Your asset is already in the treasury while entropy matures.</span></div>
      <div class="coin-game-step" data-step="reveal"><b>03 REVEAL</b><span>Reveal to settle the MATT payout or burn.</span></div>
    </div>
    <div class="coin-game-warning">
      <strong>Keep this browser storage until settlement.</strong>
      The reveal secret stays on this device. An expired reveal is treated as a loss and burns the configured MATT amount from the Reward Vault.
    </div>
    <label class="coin-legal-check">
      <input id="coin-legal-confirm" type="checkbox">
      <span>I confirm I am at least 18, permitted to use token wagering where I live, and understand the wager always remains in the treasury.</span>
    </label>
    <p class="coin-game-progress" id="coin-game-progress" role="status" aria-live="polite">Preparing universal BurnFlip…</p>
  `;
  actionButton.before(panel);

  let expireButton = document.getElementById('coin-expire-bet');
  if (!expireButton) {
    expireButton = document.createElement('button');
    expireButton.className = 'coin-secondary-action';
    expireButton.id = 'coin-expire-bet';
    expireButton.type = 'button';
    expireButton.textContent = 'SETTLE EXPIRED BET';
    expireButton.hidden = true;
    actionButton.after(expireButton);
  }

  if (!document.getElementById('burnflip-confirm-dialog')) {
    const dialog = document.createElement('dialog');
    dialog.id = 'burnflip-confirm-dialog';
    dialog.className = 'burnflip-confirm-dialog';
    dialog.innerHTML = `
      <form method="dialog">
        <p class="eyebrow">CONFIRM ON-CHAIN WAGER</p>
        <h3>Review your BurnFlip</h3>
        <dl id="burnflip-confirm-summary"></dl>
        <p>Your wager transfers directly to the treasury Safe. A win pays only MATT; a loss burns MATT from the Reward Vault.</p>
        <div class="burnflip-dialog-actions">
          <button value="cancel" class="secondary-button">CANCEL</button>
          <button value="confirm" id="burnflip-confirm-submit" class="flip-button">CONFIRM WAGER</button>
        </div>
      </form>
    `;
    document.body.append(dialog);
  }

  if (!document.getElementById('burnflip-result-card')) {
    const resultCard = document.createElement('article');
    resultCard.id = 'burnflip-result-card';
    resultCard.className = 'burnflip-result-card';
    resultCard.hidden = true;
    resultCard.innerHTML = '<h3 id="burnflip-result-title">RESULT</h3><dl id="burnflip-result-summary"></dl>';
    card.append(resultCard);
  }

  const rewards = document.getElementById('daily-missions');
  if (rewards) {
    rewards.classList.add('burnflip-reward-migration');
    rewards.innerHTML = `
      <div class="section-heading">
        <p class="eyebrow">DEDICATED REWARD VAULT</p>
        <h2>MATT-Only Settlement</h2>
        <p>The Reward Vault can only pay winners or burn MATT. It cannot move wagers and exposes no arbitrary MATT transfer.</p>
      </div>
    `;
  }
})();
