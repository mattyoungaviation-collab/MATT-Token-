(() => {
  'use strict';

  const config = window.MATT_COIN_FLIP_CONFIG || {};
  const ETHERS_URL = 'https://esm.sh/ethers@6.13.5?bundle';
  const TX_POLL_MS = 900;
  const ACTIVE_POLL_MS = 2500;
  const IDLE_POLL_MS = 15000;
  const HIDDEN_POLL_MS = 30000;
  const TX_TIMEOUT_MS = 180000;
  const GAME_ABI = [
    'function activeBetOf(address) view returns (uint256)',
    'function bets(uint256) view returns (address player,uint256 amount,uint64 entropyBlock,uint64 revealDeadlineBlock,uint8 choice,uint8 state,bytes32 commitment)',
    'function availableBankroll() view returns (uint256)',
    'function maxAcceptableBet() view returns (uint256)',
    'function paused() view returns (bool)',
    'function placeBet(uint8 choice,uint256 amount,bytes32 commitment) returns (uint256)',
    'function revealAndSettle(uint256 betId,bytes32 secret) returns (bool won)',
    'function expireBet(uint256 betId)'
  ];
  const TOKEN_ABI = [
    'function balanceOf(address) view returns (uint256)',
    'function allowance(address,address) view returns (uint256)',
    'function approve(address,uint256) returns (bool)'
  ];

  const previousButton = document.getElementById('flip-button');
  const previousProgress = document.getElementById('coin-game-progress');
  if (!previousButton || !previousProgress || !config.burnEdition) return;

  const actionButton = previousButton.cloneNode(true);
  previousButton.replaceWith(actionButton);
  const progress = previousProgress.cloneNode(true);
  previousProgress.replaceWith(progress);

  const previousExpire = document.getElementById('coin-expire-bet');
  const expireButton = previousExpire ? previousExpire.cloneNode(true) : null;
  if (previousExpire && expireButton) previousExpire.replaceWith(expireButton);

  const amountInput = document.getElementById('coin-bet-amount');
  const legalConfirm = document.getElementById('coin-legal-confirm');
  const balanceDisplay = document.getElementById('coin-wallet-balance');
  const bankrollDisplay = document.getElementById('coin-bankroll');
  const maxDisplay = document.getElementById('coin-current-max');
  const flowSteps = new Map([...document.querySelectorAll('.coin-game-step')].map(element => [element.dataset.step, element]));

  let ethers;
  let game;
  let token;
  let busy = false;
  let syncing = false;
  let activeBetId = 0n;
  let activeBet = null;
  let activeSecret = null;
  let currentAccountSeen = null;
  let currentMaximum = 0n;
  let walletBalance = 0n;
  let summaryLoaded = false;
  let refreshTimer = null;

  const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

  function account() {
    const value = window.MattRoninConnect?.account || (typeof currentAccount === 'string' ? currentAccount : null);
    return /^0x[a-fA-F0-9]{40}$/.test(String(value || '')) ? String(value).toLowerCase() : null;
  }

  function wallet() {
    return window.MattRoninConnect?.provider || (typeof walletConnectProvider !== 'undefined' ? walletConnectProvider : null);
  }

  function setStatus(message, type = '') {
    progress.textContent = message;
    progress.className = `coin-game-progress${type ? ` ${type}` : ''}`;
  }

  function setFlow(active, complete = []) {
    for (const [name, element] of flowSteps) {
      element.classList.toggle('active', name === active);
      element.classList.toggle('complete', complete.includes(name));
    }
  }

  function friendly(error) {
    const message = String(error?.shortMessage || error?.reason || error?.message || error || 'Unknown error');
    if (/user rejected|user denied|4001|action_rejected/i.test(message)) return 'Wallet request cancelled.';
    if (/insufficient funds|gas/i.test(message)) return 'This wallet needs a small amount of RON for gas.';
    if (/ActiveBetExists/i.test(message)) return 'This wallet already has a pending BurnFlip bet.';
    if (/InsufficientBankroll/i.test(message)) return 'That bet is larger than the game’s currently available bankroll.';
    if (/BetBelowMinimum/i.test(message)) return 'The minimum BurnFlip bet is 1 MATT.';
    if (/RevealWindowClosed/i.test(message)) return 'The reveal window closed. The bet can now be expired and burned.';
    return message.replace(/execution reverted:?/i, '').trim().slice(0, 240);
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

  async function read(address, iface, name, args = []) {
    const data = iface.encodeFunctionData(name, args);
    const raw = await rpc('eth_call', [{ to: address, data }, 'latest']);
    return iface.decodeFunctionResult(name, raw);
  }

  async function active(owner) {
    return BigInt((await read(config.contractAddress, game, 'activeBetOf', [owner]))[0]);
  }

  async function allowance(owner) {
    return BigInt((await read(config.tokenAddress, token, 'allowance', [owner, config.contractAddress]))[0]);
  }

  async function currentBlock() {
    return Number(BigInt(await rpc('eth_blockNumber')));
  }

  function formatMatt(value, precision = 2) {
    const [whole, decimal = ''] = ethers.formatUnits(value, 18).split('.');
    const fraction = decimal.slice(0, precision).replace(/0+$/, '');
    return `${BigInt(whole).toLocaleString()}${fraction ? `.${fraction}` : ''} MATT`;
  }

  function txHash(value) {
    const hash = typeof value === 'string' ? value : value?.hash || value?.transactionHash;
    return /^0x[a-fA-F0-9]{64}$/.test(String(hash || '')) ? String(hash) : null;
  }

  function secretKey(owner, betId) {
    return `mattCoinFlipSecret:${config.contractAddress.toLowerCase()}:${owner}:${betId}`;
  }

  function pendingKey(owner, commitment) {
    return `mattCoinFlipPendingSecret:${config.contractAddress.toLowerCase()}:${owner}:${commitment}`;
  }

  function scheduleSync(delay) {
    clearTimeout(refreshTimer);
    const nextDelay = document.hidden ? Math.max(delay, HIDDEN_POLL_MS) : delay;
    refreshTimer = setTimeout(() => syncState({ preserveMessage: busy }), nextDelay);
  }

  async function waitForSubmittedTransaction(response, label, probe) {
    const hash = txHash(response);
    const started = Date.now();

    if (hash) {
      setStatus(`${label} submitted (${hash.slice(0, 10)}…). Waiting for Ronin confirmation…`);
      while (Date.now() - started < TX_TIMEOUT_MS) {
        const receipt = await rpc('eth_getTransactionReceipt', [hash]);
        if (receipt) {
          if (BigInt(receipt.status || '0x0') !== 1n) throw new Error(`${label} transaction reverted.`);
          return { hash, receipt };
        }
        await sleep(TX_POLL_MS);
      }
    } else {
      setStatus(`${label} submitted. Waiting for Ronin confirmation…`);
      while (Date.now() - started < TX_TIMEOUT_MS) {
        if (await probe()) return { hash: null, receipt: null };
        await sleep(TX_POLL_MS);
      }
    }

    throw new Error(`${label} was not confirmed in time. Refresh to resume from the wallet’s actual state.`);
  }

  async function sendTransaction({ to, data, label, probe }) {
    const owner = account();
    const provider = wallet();
    if (!owner || !provider?.request) throw new Error('Connect Ronin Wallet first.');

    setStatus(`Open Ronin Wallet and confirm ${label}.`);
    const response = await provider.request({
      method: 'eth_sendTransaction',
      params: [{ from: owner, to, data, value: '0x0' }]
    });

    // No blockchain polling occurs while the wallet approval prompt is open.
    return waitForSubmittedTransaction(response, label, probe);
  }

  function selectedChoice() {
    return document.querySelector('.choice.active')?.dataset.choice === 'tails' ? 1 : 0;
  }

  async function refreshSummary(owner) {
    const [balanceRaw, bankrollRaw, maximumRaw, pausedRaw] = await Promise.all([
      read(config.tokenAddress, token, 'balanceOf', [owner]),
      read(config.contractAddress, game, 'availableBankroll'),
      read(config.contractAddress, game, 'maxAcceptableBet'),
      read(config.contractAddress, game, 'paused')
    ]);
    walletBalance = BigInt(balanceRaw[0]);
    const bankroll = BigInt(bankrollRaw[0]);
    const maximum = BigInt(maximumRaw[0]);
    currentMaximum = maximum < walletBalance ? maximum : walletBalance;
    balanceDisplay.textContent = formatMatt(walletBalance);
    bankrollDisplay.textContent = formatMatt(bankroll);
    maxDisplay.textContent = formatMatt(currentMaximum);
    if (amountInput) amountInput.max = ethers.formatUnits(currentMaximum, 18);
    summaryLoaded = true;
    return Boolean(pausedRaw[0]);
  }

  async function syncState({ preserveMessage = false } = {}) {
    if (syncing || !ethers) return;
    syncing = true;
    try {
      const owner = account();
      if (owner !== currentAccountSeen) {
        currentAccountSeen = owner;
        activeBetId = 0n;
        activeBet = null;
        activeSecret = null;
        summaryLoaded = false;
      }

      if (!owner || !wallet()?.request) {
        actionButton.textContent = 'CONNECT RONIN';
        actionButton.disabled = false;
        balanceDisplay.textContent = 'Connect wallet';
        maxDisplay.textContent = 'Connect wallet';
        if (!preserveMessage) setStatus('Connect Ronin Wallet to enter MATT BurnFlip.');
        setFlow('commit');
        activeBetId = 0n;
        return;
      }

      const betId = await active(owner);
      activeBetId = betId;

      if (activeBetId === 0n) {
        const paused = await refreshSummary(owner);
        activeBet = null;
        activeSecret = null;
        actionButton.textContent = paused ? 'BURNFLIP PAUSED' : 'PLACE BURNFLIP BET';
        actionButton.disabled = paused || busy || currentMaximum < ethers.parseUnits('1', 18);
        if (!preserveMessage && !busy) {
          setStatus(currentMaximum >= ethers.parseUnits('1', 18)
            ? 'Ready. Choose a side and bet any amount up to the live bankroll limit.'
            : 'The BurnFlip bankroll cannot currently cover a 1 MATT bet.');
        }
        setFlow('commit');
        if (expireButton) expireButton.hidden = true;
        return;
      }

      if (!summaryLoaded) await refreshSummary(owner);
      const [decoded, block] = await Promise.all([
        read(config.contractAddress, game, 'bets', [activeBetId]),
        currentBlock()
      ]);
      activeBet = {
        amount: BigInt(decoded.amount ?? decoded[1]),
        entropyBlock: Number(decoded.entropyBlock ?? decoded[2]),
        deadline: Number(decoded.revealDeadlineBlock ?? decoded[3]),
        choice: Number(decoded.choice ?? decoded[4]),
        state: Number(decoded.state ?? decoded[5]),
        commitment: String(decoded.commitment ?? decoded[6])
      };
      activeSecret = localStorage.getItem(secretKey(owner, activeBetId.toString())) ||
        localStorage.getItem(pendingKey(owner, activeBet.commitment));

      if (block <= activeBet.entropyBlock) {
        actionButton.textContent = `BET #${activeBetId} CONFIRMED`;
        actionButton.disabled = true;
        setStatus(`Your BurnFlip bet #${activeBetId} is live. Waiting for Ronin block ${activeBet.entropyBlock.toLocaleString()}…`, 'good');
        setFlow('block', ['commit']);
      } else if (block <= activeBet.deadline) {
        actionButton.textContent = 'REVEAL & SETTLE BURNFLIP';
        actionButton.disabled = busy || !activeSecret;
        setStatus(activeSecret
          ? `Your BurnFlip bet #${activeBetId} is ready. Confirm Reveal & Settle.`
          : `Bet #${activeBetId} is ready, but its secret is missing from this browser.`, activeSecret ? 'good' : 'error');
        setFlow('reveal', ['commit', 'block']);
      } else {
        actionButton.textContent = 'REVEAL WINDOW EXPIRED';
        actionButton.disabled = true;
        if (expireButton) { expireButton.hidden = false; expireButton.disabled = busy; }
        setStatus(`Bet #${activeBetId} expired. Expiring it will permanently burn 100% of the stake.`, 'error');
        setFlow(null, ['commit', 'block']);
      }
    } catch (error) {
      if (!busy) setStatus(friendly(error), 'error');
    } finally {
      syncing = false;
      scheduleSync(activeBetId !== 0n ? ACTIVE_POLL_MS : IDLE_POLL_MS);
    }
  }

  async function placeBet() {
    const owner = account();
    if (!legalConfirm?.checked) throw new Error('Confirm the age, jurisdiction, and full-loss acknowledgement first.');
    const amount = ethers.parseUnits(amountInput?.value || '0', 18);
    if (amount < ethers.parseUnits('1', 18)) throw new Error('The minimum BurnFlip bet is 1 MATT.');
    if (amount > walletBalance) throw new Error('Your wallet does not hold that much MATT.');
    if (amount > currentMaximum) throw new Error(`The current maximum is ${formatMatt(currentMaximum)}.`);
    if (activeBetId !== 0n) throw new Error('This wallet already has a pending BurnFlip bet.');

    const secret = ethers.hexlify(crypto.getRandomValues(new Uint8Array(32)));
    const choice = selectedChoice();
    const commitment = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
      ['bytes32', 'address', 'uint8', 'uint256', 'address', 'uint256'],
      [secret, owner, choice, amount, config.contractAddress, BigInt(config.chainId)]
    ));
    localStorage.setItem(pendingKey(owner, commitment), secret);

    if (await allowance(owner) < amount) {
      await sendTransaction({
        to: config.tokenAddress,
        data: token.encodeFunctionData('approve', [config.contractAddress, amount]),
        label: 'MATT approval',
        probe: async () => (await allowance(owner)) >= amount
      });
    }

    const before = activeBetId;
    await sendTransaction({
      to: config.contractAddress,
      data: game.encodeFunctionData('placeBet', [choice, amount, commitment]),
      label: 'the BurnFlip bet',
      probe: async () => (await active(owner)) !== before
    });

    const betId = await active(owner);
    if (betId === 0n) throw new Error('The BurnFlip bet was not detected on-chain.');
    localStorage.setItem(secretKey(owner, betId.toString()), secret);
    localStorage.removeItem(pendingKey(owner, commitment));
    activeBetId = betId;
    setStatus(`BurnFlip bet #${betId} is confirmed on Ronin. Preparing reveal…`, 'good');
    await syncState({ preserveMessage: true });
  }

  async function revealBet() {
    const owner = account();
    const betId = activeBetId;
    const secret = activeSecret;
    if (!betId || !secret) throw new Error('The reveal secret is unavailable in this browser.');
    await sendTransaction({
      to: config.contractAddress,
      data: game.encodeFunctionData('revealAndSettle', [betId, secret]),
      label: `Reveal & Settle for bet #${betId}`,
      probe: async () => (await active(owner)) === 0n
    });
    localStorage.removeItem(secretKey(owner, betId.toString()));
    activeBetId = 0n;
    summaryLoaded = false;
    setStatus(`Bet #${betId} settled on Ronin. Loading your result…`, 'good');
    window.dispatchEvent(new CustomEvent('matt:coin-settled', { detail: { account: owner, betId: betId.toString() } }));
    window.dispatchEvent(new CustomEvent('matt:burnflip-updated'));
    if (typeof loadBalances === 'function') loadBalances(owner).catch(() => {});
  }

  async function expireBet() {
    const owner = account();
    const betId = activeBetId;
    await sendTransaction({
      to: config.contractAddress,
      data: game.encodeFunctionData('expireBet', [betId]),
      label: `Burn expired bet #${betId}`,
      probe: async () => (await active(owner)) === 0n
    });
    localStorage.removeItem(secretKey(owner, betId.toString()));
    activeBetId = 0n;
    summaryLoaded = false;
    setStatus(`Bet #${betId} expired. 100% of the stake was permanently burned.`, 'good');
    window.dispatchEvent(new CustomEvent('matt:burnflip-updated'));
  }

  actionButton.addEventListener('click', async () => {
    if (busy) return;
    if (!account() || !wallet()?.request) return window.MattRoninConnect?.connect();
    busy = true;
    clearTimeout(refreshTimer);
    actionButton.disabled = true;
    try {
      if (activeBetId === 0n) await placeBet();
      else await revealBet();
    } catch (error) {
      setStatus(friendly(error), 'error');
    } finally {
      busy = false;
      await syncState({ preserveMessage: true });
    }
  });

  expireButton?.addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    clearTimeout(refreshTimer);
    try { await expireBet(); } catch (error) { setStatus(friendly(error), 'error'); }
    finally { busy = false; await syncState({ preserveMessage: true }); }
  });

  document.getElementById('coin-bet-max')?.addEventListener('click', () => {
    if (!ethers || currentMaximum <= 0n || !amountInput) return;
    amountInput.value = ethers.formatUnits(currentMaximum, 18).replace(/\.0+$/, '');
  }, true);

  window.addEventListener('matt:wallet-connected', () => { summaryLoaded = false; syncState(); });
  window.addEventListener('matt:wallet-disconnected', () => syncState());
  document.addEventListener('visibilitychange', () => {
    clearTimeout(refreshTimer);
    if (!document.hidden) syncState({ preserveMessage: true });
    else scheduleSync(HIDDEN_POLL_MS);
  });

  (async () => {
    try {
      ethers = await import(ETHERS_URL);
      game = new ethers.Interface(GAME_ABI);
      token = new ethers.Interface(TOKEN_ABI);
      await syncState();
    } catch (error) {
      setStatus(`BurnFlip controller failed to load: ${friendly(error)}`, 'error');
      actionButton.disabled = true;
    }
  })();
})();
