(() => {
  'use strict';

  const config = window.MATT_COIN_FLIP_CONFIG || {};
  const progress = document.getElementById('coin-game-progress');
  const coin = document.getElementById('coin');
  const result = document.getElementById('flip-result');
  if (!progress || !coin || !result || !config.contractAddress) return;

  const ETHERS_URL = 'https://esm.sh/ethers@6.13.5?bundle';
  const GAME_ABI = [
    'function bets(uint256) view returns (address player,uint128 amount,uint64 entropyBlock,uint64 revealDeadlineBlock,uint8 choice,uint8 state,bytes32 commitment)'
  ];

  let ethers;
  let game;
  let rpcId = 0;
  let animatingBetId = null;
  let lastAnimatedBetId = null;

  async function rpc(method, params = []) {
    const response = await fetch('/api/rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params })
    });
    const payload = await response.json();
    if (!response.ok || payload.error) {
      throw new Error(payload.error?.message || `Ronin RPC returned HTTP ${response.status}`);
    }
    return payload.result;
  }

  async function readBet(betId) {
    const data = game.encodeFunctionData('bets', [betId]);
    const raw = await rpc('eth_call', [{ to: config.contractAddress, data }, 'latest']);
    return game.decodeFunctionResult('bets', raw);
  }

  function formatMatt(raw) {
    const text = ethers.formatUnits(raw, 18);
    const [whole, fraction = ''] = text.split('.');
    const shortFraction = fraction.slice(0, 4).replace(/0+$/, '');
    return `${BigInt(whole).toLocaleString()}${shortFraction ? `.${shortFraction}` : ''} MATT`;
  }

  function triggerCoinAnimation(outcome) {
    coin.classList.remove('flipping');
    void coin.offsetWidth;
    coin.classList.add('flipping');

    window.setTimeout(() => {
      const face = coin.querySelector('.coin-face');
      if (face) face.textContent = outcome === 0 ? 'M' : 'T';
    }, 420);
  }

  async function animateSettledBet(betId) {
    const normalizedId = String(betId);
    if (animatingBetId === normalizedId || lastAnimatedBetId === normalizedId) return;
    animatingBetId = normalizedId;

    try {
      if (!ethers) {
        ethers = await import(ETHERS_URL);
        game = new ethers.Interface(GAME_ABI);
      }

      const decoded = await readBet(BigInt(normalizedId));
      const amount = BigInt(decoded.amount ?? decoded[1]);
      const choice = Number(decoded.choice ?? decoded[4]);
      const state = Number(decoded.state ?? decoded[5]);
      if (state !== 2 && state !== 3) return;

      const won = state === 2;
      const outcome = won ? choice : (choice === 0 ? 1 : 0);
      triggerCoinAnimation(outcome);

      result.className = won ? 'result win' : 'result';
      result.textContent = won
        ? `${outcome === 0 ? 'HEADS' : 'TAILS'} — YOU WON ${formatMatt(amount * 2n)}.`
        : `${outcome === 0 ? 'HEADS' : 'TAILS'} — ${formatMatt(amount)} SENT TO TREASURY.`;

      lastAnimatedBetId = normalizedId;
    } catch (error) {
      console.error('Could not animate settled MATT coin flip:', error);
    } finally {
      animatingBetId = null;
    }
  }

  function inspectSettlementStatus() {
    const match = progress.textContent.match(/Bet\s+#(\d+)\s+settled\s+on\s+Ronin/i);
    if (match) animateSettledBet(match[1]);
  }

  new MutationObserver(inspectSettlementStatus).observe(progress, {
    childList: true,
    characterData: true,
    subtree: true
  });

  inspectSettlementStatus();
})();
