(() => {
  'use strict';

  const config = window.MATT_COIN_FLIP_CONFIG || {};
  const section = document.getElementById('coin-flip');
  const card = section?.querySelector('.game-card');
  const actionButton = document.getElementById('flip-button');
  const result = document.getElementById('flip-result');
  if (!section || !card || !actionButton || !result || !config.burnEdition) return;

  card.classList.add('onchain-game-card');
  actionButton.textContent = 'CONNECT RONIN';
  actionButton.disabled = false;
  result.textContent = 'Choose heads or tails, enter a MATT amount, and connect Ronin.';

  if (!document.getElementById('coin-game-progress')) {
    const panel = document.createElement('div');
    panel.className = 'onchain-bet-panel';
    panel.innerHTML = `
      <div class="coin-contract-strip">
        <span>BURNFLIP CONTRACT</span>
        <a id="coin-game-contract" href="${config.explorerAddressBase}${config.contractAddress}" target="_blank" rel="noopener">${config.contractAddress.slice(0, 8)}…${config.contractAddress.slice(-6)}</a>
      </div>
      <div class="coin-amount-row">
        <label class="coin-amount-field">
          <span>Bet amount</span>
          <span class="coin-amount-input-wrap">
            <input id="coin-bet-amount" type="number" inputmode="decimal" min="1" step="1" value="1000" placeholder="Enter any supported amount" aria-label="MATT BurnFlip bet amount">
            <span>MATT</span>
          </span>
        </label>
        <button class="coin-max-button" id="coin-bet-max" type="button">MAX</button>
      </div>
      <div class="coin-quick-row" aria-label="Quick bet amounts">
        <button class="coin-quick-button" type="button" data-bet="1000">1K</button>
        <button class="coin-quick-button" type="button" data-bet="100000">100K</button>
        <button class="coin-quick-button" type="button" data-bet="1000000">1M</button>
        <button class="coin-quick-button" type="button" data-bet="10000000">10M</button>
      </div>
      <div class="coin-game-info-grid">
        <div><span>Your MATT</span><strong id="coin-wallet-balance">Connect wallet</strong></div>
        <div><span>Available bankroll</span><strong id="coin-bankroll">Loading…</strong></div>
        <div><span>Your current maximum</span><strong id="coin-current-max">Connect wallet</strong></div>
      </div>
      <div class="coin-game-flow" aria-label="On-chain BurnFlip flow">
        <div class="coin-game-step" data-step="commit"><b>01 COMMIT</b><span>Approve once if needed, then place the bet.</span></div>
        <div class="coin-game-step" data-step="block"><b>02 RONIN BLOCK</b><span>Wait briefly for future block entropy.</span></div>
        <div class="coin-game-step" data-step="reveal"><b>03 REVEAL</b><span>Confirm reveal to flip and settle.</span></div>
      </div>
      <div class="coin-game-warning">
        <strong>Keep this browser open or preserve its storage while a bet is pending.</strong>
        The reveal secret stays on this device. If the reveal window expires, 100% of the unrevealed stake is permanently burned.
      </div>
      <label class="coin-legal-check">
        <input id="coin-legal-confirm" type="checkbox">
        <span>I confirm I am at least 18, permitted to use token wagering where I live, and understand that 100% of a losing bet is permanently burned.</span>
      </label>
      <p class="coin-game-progress" id="coin-game-progress" role="status" aria-live="polite">Preparing MATT BurnFlip…</p>
    `;
    actionButton.before(panel);

    const expireButton = document.createElement('button');
    expireButton.className = 'coin-secondary-action';
    expireButton.id = 'coin-expire-bet';
    expireButton.type = 'button';
    expireButton.textContent = 'BURN EXPIRED BET';
    expireButton.hidden = true;
    actionButton.after(expireButton);
  }

  for (const button of section.querySelectorAll('.choice[data-choice]')) {
    button.addEventListener('click', () => {
      for (const choice of section.querySelectorAll('.choice[data-choice]')) {
        const selected = choice === button;
        choice.classList.toggle('active', selected);
        choice.setAttribute('aria-pressed', String(selected));
      }
    });
  }

  const amountInput = document.getElementById('coin-bet-amount');
  for (const button of section.querySelectorAll('.coin-quick-button')) {
    button.addEventListener('click', () => {
      if (amountInput) amountInput.value = button.dataset.bet || '1';
    });
  }

  const labels = [...section.querySelectorAll('.game-stats span')];
  if (labels.length >= 3) {
    labels[0].textContent = 'Your bets';
    labels[1].textContent = 'Your wins';
    labels[2].textContent = 'Your pending';
  }

  const rewards = document.getElementById('daily-missions');
  if (rewards) {
    rewards.classList.add('burnflip-reward-migration');
    rewards.innerHTML = `
      <div class="section-heading">
        <p class="eyebrow">BURNFLIP REWARD UPGRADE</p>
        <h2>Daily Reward Migration in Progress</h2>
        <p>BurnFlip is live. The 1,000,000 MATT daily reward will reopen after its replacement contract is linked to this BurnFlip contract.</p>
      </div>
      <p class="mission-notice">No claim is available during migration. Existing reward funds remain protected on-chain.</p>
    `;
  }
})();
