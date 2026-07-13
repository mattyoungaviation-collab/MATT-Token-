(() => {
  'use strict';

  const config = window.MATT_COIN_FLIP_CONFIG || {};
  const ETHERS_URL = 'https://esm.sh/ethers@6.13.5?bundle';
  const POLL_MS = 1200;
  const TX_TIMEOUT_MS = 180000;
  const GAME_ABI = [
    'function activeBetOf(address) view returns (uint256)',
    'function bets(uint256) view returns (address player,uint128 amount,uint64 entropyBlock,uint64 revealDeadlineBlock,uint8 choice,uint8 state,bytes32 commitment)',
    'function availableBankroll() view returns (uint256)',
    'function maxAcceptableBet() view returns (uint256)',
    'function paused() view returns (bool)',
    'function placeBet(uint8 choice,uint256 amount,bytes32 commitment) returns (uint256)',
    'function revealAndSettle(uint256 betId,bytes32 secret) returns (bool won)',
    'function expireBet(uint256 betId)',
    'event BetPlaced(uint256 indexed betId,address indexed player,uint8 choice,uint256 amount,uint256 entropyBlock,uint256 revealDeadlineBlock,bytes32 commitment)',
    'event BetSettled(uint256 indexed betId,address indexed player,uint8 choice,uint8 outcome,uint256 amount,uint256 payout,bool won,bytes32 entropyBlockHash,uint256 randomWord)'
  ];
  const TOKEN_ABI = [
    'function balanceOf(address) view returns (uint256)',
    'function allowance(address,address) view returns (uint256)',
    'function approve(address,uint256) returns (bool)'
  ];

  const oldButton = document.getElementById('flip-button');
  const oldProgress = document.getElementById('coin-game-progress');
  if (!oldButton || !oldProgress) return;

  const actionButton = oldButton.cloneNode(true);
  oldButton.replaceWith(actionButton);
  const progress = oldProgress.cloneNode(true);
  oldProgress.replaceWith(progress);

  const oldExpire = document.getElementById('coin-expire-bet');
  const expireButton = oldExpire ? oldExpire.cloneNode(true) : null;
  if (oldExpire && expireButton) oldExpire.replaceWith(expireButton);

  const amountInput = document.getElementById('coin-bet-amount');
  const legalConfirm = document.getElementById('coin-legal-confirm');
  const balanceDisplay = document.getElementById('coin-wallet-balance');
  const bankrollDisplay = document.getElementById('coin-bankroll');
  const maxDisplay = document.getElementById('coin-current-max');
  const result = document.getElementById('flip-result');
  const coin = document.getElementById('coin');
  const flowSteps = new Map([...document.querySelectorAll('.coin-game-step')].map(el => [el.dataset.step, el]));

  let ethers;
  let game;
  let token;
  let busy = false;
  let syncing = false;
  let activeBetId = 0n;
  let activeBet = null;
  let activeSecret = null;
  let currentAccountSeen = null;
  let refreshTimer = null;

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

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
    if (/ActiveBetExists/i.test(message)) return 'This wallet already has a pending bet. Other wallets can still play normally.';
    if (/InsufficientBankroll/i.test(message)) return 'The game bankroll cannot cover that bet amount.';
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

  async function waitForChange({ label, requestPromise, probe }) {
    const started = Date.now();
    let responseReady = false;
    let responseValue;
    requestPromise.then(value => { responseReady = true; responseValue = { value }; })
      .catch(error => { responseReady = true; responseValue = { error }; });

    while (Date.now() - started < TX_TIMEOUT_MS) {
      if (responseReady && responseValue?.error) throw responseValue.error;
      const hash = responseReady ? txHash(responseValue?.value) : null;
      if (hash) {
        const receipt = await rpc('eth_getTransactionReceipt', [hash]);
        if (receipt) {
          if (BigInt(receipt.status || '0x0') !== 1n) throw new Error(`${label} transaction reverted.`);
          return { hash, receipt };
        }
        setStatus(`${label} submitted (${hash.slice(0, 10)}…). Waiting for Ronin confirmation…`);
      } else {
        setStatus(`${label} signed. Detecting it on Ronin…`);
      }
      if (await probe()) return { hash: hash || null, receipt: null };
      await sleep(POLL_MS);
    }
    throw new Error(`${label} was not detected on-chain. Refresh to resume from the wallet's actual state.`);
  }

  async function sendTransaction({ to, data, label, probe }) {
    const owner = account();
    const provider = wallet();
    if (!owner || !provider?.request) throw new Error('Connect Ronin Wallet first.');
    return waitForChange({
      label,
      requestPromise: provider.request({ method: 'eth_sendTransaction', params: [{ from: owner, to, data, value: '0x0' }] }),
      probe
    });
  }

  function selectedChoice() {
    return document.querySelector('.choice.active')?.dataset.choice === 'tails' ? 1 : 0;
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
      }

      if (!owner || !wallet()?.request) {
        actionButton.textContent = 'CONNECT RONIN';
        actionButton.disabled = false;
        if (!preserveMessage) setStatus('Connect Ronin Wallet to place your own on-chain bet.');
        setFlow('commit');
        return;
      }

      const [balanceRaw, bankrollRaw, maximumRaw, pausedRaw, betId] = await Promise.all([
        read(config.tokenAddress, token, 'balanceOf', [owner]),
        read(config.contractAddress, game, 'availableBankroll'),
        read(config.contractAddress, game, 'maxAcceptableBet'),
        read(config.contractAddress, game, 'paused'),
        active(owner)
      ]);
      const balance = BigInt(balanceRaw[0]);
      const bankroll = BigInt(bankrollRaw[0]);
      const maximum = BigInt(maximumRaw[0]);
      const paused = Boolean(pausedRaw[0]);
      balanceDisplay.textContent = formatMatt(balance);
      bankrollDisplay.textContent = formatMatt(bankroll);
      maxDisplay.textContent = formatMatt(maximum < balance ? maximum : balance);
      activeBetId = betId;

      if (activeBetId === 0n) {
        activeBet = null;
        activeSecret = null;
        actionButton.textContent = paused ? 'GAME PAUSED' : 'PLACE ON-CHAIN BET';
        actionButton.disabled = paused || busy;
        if (!preserveMessage && !busy) setStatus('Ready. Choose a side, enter an amount, and place your bet. Other wallets can play at the same time.');
        setFlow('commit');
        if (expireButton) expireButton.hidden = true;
        return;
      }

      const decoded = await read(config.contractAddress, game, 'bets', [activeBetId]);
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
      const block = await currentBlock();

      if (block <= activeBet.entropyBlock) {
        actionButton.textContent = `BET #${activeBetId} CONFIRMED`;
        actionButton.disabled = true;
        setStatus(`Your bet #${activeBetId} is live. Waiting for Ronin block ${activeBet.entropyBlock.toLocaleString()}…`, 'good');
        setFlow('block', ['commit']);
      } else if (block <= activeBet.deadline) {
        actionButton.textContent = 'REVEAL & SETTLE';
        actionButton.disabled = busy || !activeSecret;
        setStatus(activeSecret
          ? `Your bet #${activeBetId} is ready. Confirm Reveal & Settle.`
          : `Your bet #${activeBetId} is ready, but its secret is missing from this browser.`, activeSecret ? 'good' : 'error');
        setFlow('reveal', ['commit', 'block']);
      } else {
        actionButton.textContent = 'REVEAL WINDOW EXPIRED';
        actionButton.disabled = true;
        if (expireButton) { expireButton.hidden = false; expireButton.disabled = busy; }
        setStatus(`Your bet #${activeBetId} expired and can be sent to treasury.`, 'error');
        setFlow(null, ['commit', 'block']);
      }
    } catch (error) {
      if (!busy) setStatus(friendly(error), 'error');
    } finally {
      syncing = false;
    }
  }

  async function placeBet() {
    const owner = account();
    if (!legalConfirm?.checked) throw new Error('Confirm the age, jurisdiction, and loss acknowledgement first.');
    const amount = ethers.parseUnits(amountInput?.value || '0', 18);
    if (amount < ethers.parseUnits('1', 18) || amount > ethers.parseUnits('1000000', 18)) throw new Error('Enter a bet from 1 to 1,000,000 MATT.');
    if (await active(owner) !== 0n) throw new Error('This wallet already has a pending bet.');

    const secret = ethers.hexlify(crypto.getRandomValues(new Uint8Array(32)));
    const choice = selectedChoice();
    const commitment = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
      ['bytes32', 'address', 'uint8', 'uint256', 'address', 'uint256'],
      [secret, owner, choice, amount, config.contractAddress, BigInt(config.chainId)]
    ));
    localStorage.setItem(pendingKey(owner, commitment), secret);

    if (await allowance(owner) < amount) {
      setStatus('Step 1 of 2: confirm MATT approval in Ronin Wallet. No permit or nonce signature is used.');
      await sendTransaction({
        to: config.tokenAddress,
        data: token.encodeFunctionData('approve', [config.contractAddress, amount]),
        label: 'MATT approval',
        probe: async () => (await allowance(owner)) >= amount
      });
    }

    setStatus('Step 2 of 2: confirm Place Bet in Ronin Wallet.');
    const before = await active(owner);
    await sendTransaction({
      to: config.contractAddress,
      data: game.encodeFunctionData('placeBet', [choice, amount, commitment]),
      label: 'Place Bet',
      probe: async () => (await active(owner)) !== before
    });

    const betId = await active(owner);
    if (betId === 0n) throw new Error('The bet was not detected on-chain.');
    localStorage.setItem(secretKey(owner, betId.toString()), secret);
    localStorage.removeItem(pendingKey(owner, commitment));
    setStatus(`Your bet #${betId} is confirmed on Ronin.`, 'good');
    await syncState({ preserveMessage: true });
  }

  async function revealBet() {
    const owner = account();
    const betId = activeBetId;
    const secret = activeSecret;
    if (!betId || !secret) throw new Error('The reveal secret is unavailable in this browser.');
    setStatus(`Confirm Reveal & Settle for your bet #${betId}.`);
    await sendTransaction({
      to: config.contractAddress,
      data: game.encodeFunctionData('revealAndSettle', [betId, secret]),
      label: 'Reveal & Settle',
      probe: async () => (await active(owner)) === 0n
    });
    localStorage.removeItem(secretKey(owner, betId.toString()));
    setStatus(`Bet #${betId} settled on Ronin. Loading your result…`, 'good');
    window.dispatchEvent(new CustomEvent('matt:coin-settled', { detail: { account: owner, betId: betId.toString() } }));
    await syncState({ preserveMessage: true });
    if (typeof loadBalances === 'function') loadBalances(owner).catch(() => {});
  }

  async function expireBet() {
    const owner = account();
    const betId = activeBetId;
    await sendTransaction({
      to: config.contractAddress,
      data: game.encodeFunctionData('expireBet', [betId]),
      label: 'Expire Bet',
      probe: async () => (await active(owner)) === 0n
    });
    localStorage.removeItem(secretKey(owner, betId.toString()));
    setStatus(`Bet #${betId} expired to treasury.`, 'good');
  }

  actionButton.addEventListener('click', async () => {
    if (busy) return;
    if (!account() || !wallet()?.request) return window.MattRoninConnect?.connect();
    busy = true;
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
    try { await expireBet(); } catch (error) { setStatus(friendly(error), 'error'); }
    finally { busy = false; await syncState({ preserveMessage: true }); }
  });

  window.addEventListener('matt:wallet-connected', () => syncState());
  window.addEventListener('matt:wallet-disconnected', () => syncState());

  (async () => {
    try {
      ethers = await import(ETHERS_URL);
      game = new ethers.Interface(GAME_ABI);
      token = new ethers.Interface(TOKEN_ABI);
      await syncState();
      clearInterval(refreshTimer);
      refreshTimer = setInterval(() => syncState({ preserveMessage: busy }), POLL_MS);
    } catch (error) {
      setStatus(`Coin controller failed to load: ${friendly(error)}`, 'error');
      actionButton.disabled = true;
    }
  })();
})();