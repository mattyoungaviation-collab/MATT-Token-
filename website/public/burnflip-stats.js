(() => {
  'use strict';

  const config = window.MATT_COIN_FLIP_CONFIG || {};
  const section = document.getElementById('coin-flip');
  if (!section || !config.burnEdition || !config.contractAddress) return;

  const ETHERS_URL = 'https://esm.sh/ethers@6.13.5?bundle';
  const ABI = [
    'function totalBurnedByGame() view returns (uint256)',
    'function availableBankroll() view returns (uint256)',
    'function maxAcceptableBet() view returns (uint256)',
    'function nextBetId() view returns (uint256)',
    'event BetSettled(uint256 indexed betId,address indexed player,uint8 choice,uint8 outcome,uint256 amount,uint256 payout,bool won,bytes32 entropyBlockHash,uint256 randomWord)'
  ];

  let ethers;
  let iface;
  let refreshBusy = false;
  const deploymentBlock = Number(config.deploymentBlock || 0);
  const statsCacheKey = `mattBurnFlipStats:${String(config.contractAddress).toLowerCase()}`;

  const navLink = [...document.querySelectorAll('a[href="#coin-flip"]')];
  navLink.forEach(link => { link.textContent = link.closest('.desktop-nav') ? 'BurnFlip' : link.textContent; });

  const heading = section.querySelector('.section-heading');
  if (heading) {
    heading.innerHTML = `
      <p class="eyebrow">MATT UTILITY #1 · LIVE ON RONIN</p>
      <h2>MATT BurnFlip</h2>
      <p>Call heads or tails and wager any amount the live bankroll can safely cover. Winners receive 2× their bet directly from the contract.</p>
    `;
  }

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

  const gameCard = section.querySelector('.game-card');
  if (gameCard) {
    gameCard.before(promise, live, reasons);
  }

  const amountInput = document.getElementById('coin-bet-amount');
  if (amountInput) {
    amountInput.removeAttribute('max');
    amountInput.setAttribute('placeholder', 'Enter any supported amount');
  }

  const quickButtons = [...document.querySelectorAll('.coin-quick-button')];
  const quickValues = [
    ['1000', '1K'],
    ['100000', '100K'],
    ['1000000', '1M'],
    ['10000000', '10M']
  ];
  quickButtons.forEach((button, index) => {
    if (!quickValues[index]) return;
    button.dataset.bet = quickValues[index][0];
    button.textContent = quickValues[index][1];
  });

  const warning = section.querySelector('.coin-game-warning');
  if (warning) {
    warning.innerHTML = `<strong>Keep this browser open or preserve its storage while a bet is pending.</strong> The secret never leaves your device before reveal. If the reveal window expires, 100% of the unrevealed stake is permanently burned.`;
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

  function enforceRewardMigration() {
    const rewards = document.getElementById('daily-missions');
    if (!rewards) return;
    rewards.classList.add('burnflip-reward-migration');
    const rewardsHeading = rewards.querySelector('.section-heading');
    if (rewardsHeading) {
      rewardsHeading.innerHTML = `
        <p class="eyebrow">BURNFLIP REWARD UPGRADE</p>
        <h2>Daily Reward Migration in Progress</h2>
        <p>The previous reward contract validates the retired coin-flip contract. Claims are temporarily disabled while the verified reward is linked to BurnFlip.</p>
      `;
    }
    rewards.querySelectorAll('.mission-reward-summary, .server-mission-list, .daily-claim-panel, .mission-completion-feed').forEach(element => {
      element.hidden = true;
    });
    const claim = document.getElementById('v2-claim');
    if (claim) claim.disabled = true;
    const status = document.getElementById('v2-status');
    if (status) status.textContent = 'BurnFlip is live. The 1,000,000 MATT daily reward will reopen after the replacement reward contract is deployed and funded.';
  }

  enforceRewardMigration();
  window.setInterval(enforceRewardMigration, 2500);

  async function rpc(method, params = []) {
    const response = await fetch('/api/rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method, params })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.error) throw new Error(payload.error?.message || `Ronin RPC returned HTTP ${response.status}`);
    return payload.result;
  }

  async function read(name, args = []) {
    const data = iface.encodeFunctionData(name, args);
    const raw = await rpc('eth_call', [{ to: config.contractAddress, data }, 'latest']);
    return iface.decodeFunctionResult(name, raw);
  }

  function formatMatt(value, precision = 2) {
    const [whole, decimal = ''] = ethers.formatUnits(value, 18).split('.');
    const fraction = decimal.slice(0, precision).replace(/0+$/, '');
    return `${BigInt(whole).toLocaleString()}${fraction ? `.${fraction}` : ''} MATT`;
  }

  function blockHex(value) {
    return `0x${BigInt(value).toString(16)}`;
  }

  function loadWonCache() {
    try {
      const parsed = JSON.parse(localStorage.getItem(statsCacheKey) || '{}');
      return {
        through: Number(parsed.through || deploymentBlock - 1),
        totalWon: BigInt(parsed.totalWon || '0')
      };
    } catch {
      return { through: deploymentBlock - 1, totalWon: 0n };
    }
  }

  function saveWonCache(cache) {
    localStorage.setItem(statsCacheKey, JSON.stringify({ through: cache.through, totalWon: cache.totalWon.toString() }));
  }

  async function scanTotalWon(latestBlock) {
    const cache = loadWonCache();
    if (cache.through < deploymentBlock - 1 || cache.through > latestBlock) {
      cache.through = deploymentBlock - 1;
      cache.totalWon = 0n;
    }
    const topic = iface.getEvent('BetSettled').topicHash;
    const chunkSize = 20000;
    for (let from = cache.through + 1; from <= latestBlock; from += chunkSize) {
      const to = Math.min(latestBlock, from + chunkSize - 1);
      const logs = await rpc('eth_getLogs', [{
        address: config.contractAddress,
        fromBlock: blockHex(from),
        toBlock: blockHex(to),
        topics: [topic]
      }]);
      for (const log of logs || []) {
        try {
          const parsed = iface.parseLog(log);
          if (parsed?.name === 'BetSettled' && Boolean(parsed.args.won)) {
            cache.totalWon += BigInt(parsed.args.payout);
          }
        } catch {
          // Ignore malformed or unrelated logs.
        }
      }
      cache.through = to;
      saveWonCache(cache);
    }
    return cache.totalWon;
  }

  async function refreshLiveStats() {
    if (refreshBusy || !iface) return;
    refreshBusy = true;
    try {
      const [burnedRaw, bankrollRaw, nextBetRaw, latestHex] = await Promise.all([
        read('totalBurnedByGame'),
        read('availableBankroll'),
        read('nextBetId'),
        rpc('eth_blockNumber')
      ]);
      const burned = BigInt(burnedRaw[0]);
      const bankroll = BigInt(bankrollRaw[0]);
      const totalFlips = BigInt(nextBetRaw[0]) - 1n;
      const latestBlock = Number(BigInt(latestHex));
      const totalWon = await scanTotalWon(latestBlock);

      document.getElementById('burnflip-total-burned').textContent = formatMatt(burned);
      document.getElementById('burnflip-total-flips').textContent = totalFlips.toLocaleString();
      document.getElementById('burnflip-total-won').textContent = formatMatt(totalWon);
      document.getElementById('burnflip-bankroll').textContent = formatMatt(bankroll);
    } catch (error) {
      console.error('Could not refresh BurnFlip statistics:', error);
      document.querySelectorAll('.burnflip-live-stats strong').forEach(element => {
        if (element.textContent === 'Loading…') element.textContent = 'Temporarily unavailable';
      });
    } finally {
      refreshBusy = false;
    }
  }

  import(ETHERS_URL).then(module => {
    ethers = module;
    iface = new ethers.Interface(ABI);
    refreshLiveStats();
    window.setInterval(refreshLiveStats, 15000);
    window.addEventListener('matt:burnflip-updated', () => window.setTimeout(refreshLiveStats, 2500));
  }).catch(error => console.error('BurnFlip statistics failed to load:', error));
})();
