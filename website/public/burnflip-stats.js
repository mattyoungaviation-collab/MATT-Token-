(() => {
  'use strict';

  const config = window.MATT_COIN_FLIP_CONFIG || {};
  const section = document.getElementById('coin-flip');
  if (!section || !config.burnEdition || !config.contractAddress) return;

  const ETHERS_URL = 'https://esm.sh/ethers@6.13.5?bundle';
  const ABI = [
    'function totalBurnedByGame() view returns (uint256)',
    'function availableBankroll() view returns (uint256)',
    'function nextBetId() view returns (uint256)',
    'event BetSettled(uint256 indexed betId,address indexed player,uint8 choice,uint8 outcome,uint256 amount,uint256 payout,bool won,bytes32 entropyBlockHash,uint256 randomWord)'
  ];

  let ethers;
  let iface;
  let refreshBusy = false;
  let refreshTimer = null;
  const deploymentBlock = Number(config.deploymentBlock || 0);
  const statsCacheKey = `mattBurnFlipStats:${String(config.contractAddress).toLowerCase()}`;

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
    localStorage.setItem(statsCacheKey, JSON.stringify({
      through: cache.through,
      totalWon: cache.totalWon.toString()
    }));
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
          // Ignore malformed logs.
        }
      }
      cache.through = to;
      saveWonCache(cache);
    }
    return cache.totalWon;
  }

  function scheduleRefresh(delay = 60000) {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refreshLiveStats, document.hidden ? Math.max(delay, 120000) : delay);
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
      const totalWon = await scanTotalWon(Number(BigInt(latestHex)));

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
      scheduleRefresh();
    }
  }

  import(ETHERS_URL).then(module => {
    ethers = module;
    iface = new ethers.Interface(ABI);
    refreshLiveStats();
    window.addEventListener('matt:burnflip-updated', () => {
      clearTimeout(refreshTimer);
      window.setTimeout(refreshLiveStats, 1200);
    });
    document.addEventListener('visibilitychange', () => {
      clearTimeout(refreshTimer);
      if (!document.hidden) refreshLiveStats();
      else scheduleRefresh(120000);
    });
  }).catch(error => console.error('BurnFlip statistics failed to load:', error));
})();
