(() => {
  'use strict';

  const config = window.MATT_COIN_FLIP_CONFIG || {};
  const progress = document.getElementById('coin-game-progress');
  const coin = document.getElementById('coin');
  const result = document.getElementById('flip-result');
  if (!progress || !coin || !result || !config.contractAddress) return;

  const ETHERS_URL = 'https://esm.sh/ethers@6.13.5?bundle';
  const GAME_ABI = [
    'function bets(uint256) view returns (address player,uint256 amount,uint64 entropyBlock,uint64 revealDeadlineBlock,uint8 choice,uint8 state,bytes32 commitment)'
  ];
  const SPIN_DURATION_MS = 3200;
  const REDUCED_MOTION_DURATION_MS = 1400;
  const LAND_DURATION_MS = 520;

  let ethers;
  let game;
  let rpcId = 0;
  let animatingBetId = null;
  let lastAnimatedBetId = null;

  const sleep = milliseconds => new Promise(resolve => window.setTimeout(resolve, milliseconds));

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

  async function triggerCoinAnimation(outcome, betId) {
    const face = coin.querySelector('.coin-face');
    const duration = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      ? REDUCED_MOTION_DURATION_MS
      : SPIN_DURATION_MS;

    coin.getAnimations().forEach(animation => animation.cancel());
    coin.classList.remove('flipping');
    coin.style.transform = 'translateY(0) rotateX(0deg) rotateY(0deg) scale(1)';
    coin.setAttribute('aria-label', 'MATT coin spinning');
    if (face) face.textContent = '?';

    result.className = 'result';
    result.textContent = 'RONIN RESULT LOCKED — THE MATT COIN IS SPINNING…';
    progress.textContent = `Bet #${betId} settled on Ronin. The result is locked — watch the coin land.`;

    const spin = coin.animate([
      { transform: 'translateY(0) rotateX(0deg) rotateY(0deg) scale(1)', filter: 'brightness(1)', offset: 0 },
      { transform: 'translateY(-28px) rotateX(120deg) rotateY(540deg) scale(1.05)', filter: 'brightness(1.15)', offset: 0.16 },
      { transform: 'translateY(-92px) rotateX(420deg) rotateY(1620deg) scale(1.14)', filter: 'brightness(1.35)', offset: 0.44 },
      { transform: 'translateY(-58px) rotateX(650deg) rotateY(2520deg) scale(1.1)', filter: 'brightness(1.2)', offset: 0.68 },
      { transform: 'translateY(-12px) rotateX(710deg) rotateY(3240deg) scale(1.03)', filter: 'brightness(1.08)', offset: 0.88 },
      { transform: 'translateY(0) rotateX(720deg) rotateY(3600deg) scale(1)', filter: 'brightness(1)', offset: 1 }
    ], {
      duration,
      easing: 'cubic-bezier(.12,.72,.18,1)',
      fill: 'forwards'
    });

    await spin.finished;
    if (face) face.textContent = outcome === 0 ? 'M' : 'T';
    coin.setAttribute('aria-label', outcome === 0 ? 'MATT coin landed on heads' : 'MATT coin landed on tails');
    spin.cancel();
    coin.style.transform = 'translateY(0) rotateX(0deg) rotateY(0deg) scale(1)';

    const landing = coin.animate([
      { transform: 'translateY(-8px) scale(1.04)', offset: 0 },
      { transform: 'translateY(6px) scale(.96)', offset: 0.42 },
      { transform: 'translateY(-3px) scale(1.015)', offset: 0.7 },
      { transform: 'translateY(0) scale(1)', offset: 1 }
    ], {
      duration: LAND_DURATION_MS,
      easing: 'cubic-bezier(.2,.9,.3,1.25)'
    });

    await landing.finished;
    await sleep(180);
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
      await triggerCoinAnimation(outcome, normalizedId);

      result.className = won ? 'result win' : 'result burn-result';
      result.textContent = won
        ? `${outcome === 0 ? 'HEADS' : 'TAILS'} — YOU WON ${formatMatt(amount * 2n)}.`
        : `${outcome === 0 ? 'HEADS' : 'TAILS'} — ${formatMatt(amount)} PERMANENTLY BURNED.`;
      progress.textContent = won
        ? `Bet #${normalizedId} settled on Ronin and paid automatically.`
        : `Bet #${normalizedId} settled on Ronin. 100% of the losing stake was permanently burned.`;

      if (!won) window.dispatchEvent(new CustomEvent('matt:burnflip-updated'));
      lastAnimatedBetId = normalizedId;
    } catch (error) {
      console.error('Could not animate settled MATT BurnFlip:', error);
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
