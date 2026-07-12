(() => {
  'use strict';

  const config = window.MATT_COIN_FLIP_CONFIG || {};
  const ETHERS_URL = 'https://esm.sh/ethers@6.13.5?bundle';
  const POLL_MS = 2000;
  const TIMEOUT_MS = 180000;
  const GAME_ABI = [
    'function activeBetOf(address) view returns (uint256)',
    'function bets(uint256) view returns (address player,uint128 amount,uint64 entropyBlock,uint64 revealDeadlineBlock,uint8 choice,uint8 state,bytes32 commitment)',
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

  const originalButton = document.getElementById('flip-button');
  const originalProgress = document.getElementById('coin-game-progress');
  if (!originalButton || !originalProgress) return;

  const actionButton = originalButton.cloneNode(true);
  originalButton.replaceWith(actionButton);
  const progress = originalProgress.cloneNode(true);
  originalProgress.replaceWith(progress);

  const originalExpire = document.getElementById('coin-expire-bet');
  const expireButton = originalExpire ? originalExpire.cloneNode(true) : null;
  if (originalExpire && expireButton) originalExpire.replaceWith(expireButton);

  const amountInput = document.getElementById('coin-bet-amount');
  const result = document.getElementById('flip-result');
  const coin = document.getElementById('coin');
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  let ethers;
  let game;
  let token;
  let rpcId = 0;
  let busy = false;
  let activeBetId = 0n;
  let activeBet = null;
  let activeSecret = null;

  function account() {
    try {
      return typeof currentAccount === 'string' && currentAccount ? currentAccount.toLowerCase() : null;
    } catch {
      return null;
    }
  }

  function wallet() {
    try {
      return walletConnectProvider || null;
    } catch {
      return null;
    }
  }

  function setStatus(message, type = '') {
    progress.textContent = message;
    progress.className = `coin-game-progress${type ? ` ${type}` : ''}`;
  }

  function friendly(error) {
    const message = error?.shortMessage || error?.reason || error?.message || String(error);
    if (/user rejected|user denied|4001/i.test(message)) return 'Wallet request cancelled.';
    if (/insufficient funds|gas/i.test(message)) return 'The connected wallet needs more RON for gas.';
    return message.replace(/execution reverted:?/i, '').trim().slice(0, 240);
  }

  async function rpc(method, params = []) {
    const response = await fetch(RONIN_RPC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params })
    });
    if (!response.ok) throw new Error(`Ronin RPC returned HTTP ${response.status}`);
    const payload = await response.json();
    if (payload.error) throw new Error(payload.error.message || `Ronin RPC failed during ${method}`);
    return payload.result;
  }

  async function read(address, iface, name, args = []) {
    const data = iface.encodeFunctionData(name, args);
    const raw = await rpc('eth_call', [{ to: address, data }, 'latest']);
    return iface.decodeFunctionResult(name, raw);
  }

  async function allowance(owner) {
    return BigInt((await read(config.tokenAddress, token, 'allowance', [owner, config.contractAddress]))[0]);
  }

  async function active(owner) {
    return BigInt((await read(config.contractAddress, game, 'activeBetOf', [owner]))[0]);
  }

  async function blockNumber() {
    return Number(BigInt(await rpc('eth_blockNumber')));
  }

  function txHash(value) {
    const hash = typeof value === 'string' ? value : value?.hash || value?.transactionHash;
    return /^0x[a-fA-F0-9]{64}$/.test(String(hash || '')) ? hash : null;
  }

  async function waitReceipt(hash, label) {
    const started = Date.now();
    while (Date.now() - started < TIMEOUT_MS) {
      const receipt = await rpc('eth_getTransactionReceipt', [hash]);
      if (receipt) {
        if (BigInt(receipt.status || '0x0') !== 1n) throw new Error(`${label} transaction reverted.`);
        return receipt;
      }
      setStatus(`${label} submitted (${hash.slice(0, 10)}…). Waiting for Ronin confirmation…`);
      await sleep(POLL_MS);
    }
    throw new Error(`${label} confirmation is taking longer than expected. Refresh to continue.`);
  }

  async function sendWithProbe({ to, data, label, probe }) {
    const owner = account();
    if (!owner || !wallet()) throw new Error('Reconnect WalletConnect first.');

    const request = wallet().request({
      method: 'eth_sendTransaction',
      params: [{ from: owner, to, data, value: '0x0' }]
    }).then(value => ({ hash: txHash(value) })).catch(error => ({ error }));

    const started = Date.now();
    while (Date.now() - started < TIMEOUT_MS) {
      const response = await Promise.race([request, sleep(POLL_MS).then(() => null)]);
      if (response?.error) throw response.error;
      if (response?.hash) return waitReceipt(response.hash, label);
      if (probe && await probe()) return null;
      setStatus(`${label} signed. Waiting for the transaction hash or on-chain confirmation…`);
    }
    throw new Error(`${label} was signed, but no on-chain transaction was detected.`);
  }

  function selectedChoice() {
    return document.querySelector('.choice.active')?.dataset.choice === 'tails' ? 1 : 0;
  }

  function secretKey(owner, betId) {
    return `mattCoinFlipSecret:${config.contractAddress.toLowerCase()}:${owner}:${betId}`;
  }

  function pendingKey(owner, commitment) {
    return `mattCoinFlipPendingSecret:${config.contractAddress.toLowerCase()}:${owner}:${commitment}`;
  }

  function parseEvent(receipt, eventName) {
    for (const log of receipt?.logs || []) {
      try {
        const parsed = game.parseLog(log);
        if (parsed?.name === eventName) return parsed;
      } catch {
        // Ignore unrelated logs.
      }
    }
    return null;
  }

  async function refreshState() {
    if (busy || !ethers) return;
    const owner = account();
    if (!owner || !wallet()) {
      actionButton.textContent = 'CONNECT WALLETCONNECT';
      actionButton.disabled = false;
      setStatus('Connect through WalletConnect to place an on-chain MATT bet.');
      return;
    }

    activeBetId = await active(owner);
    if (activeBetId === 0n) {
      activeBet = null;
      activeSecret = null;
      actionButton.textContent = 'PLACE ON-CHAIN BET';
      actionButton.disabled = false;
      if (!/submitted|signed|confirmed/i.test(progress.textContent)) {
        setStatus('Choose heads or tails, enter an amount, and place your bet.');
      }
      if (expireButton) expireButton.hidden = true;
      return;
    }

    const decoded = await read(config.contractAddress, game, 'bets', [activeBetId]);
    activeBet = {
      entropyBlock: Number(decoded.entropyBlock ?? decoded[2]),
      deadline: Number(decoded.revealDeadlineBlock ?? decoded[3]),
      state: Number(decoded.state ?? decoded[5]),
      commitment: decoded.commitment ?? decoded[6]
    };
    activeSecret = localStorage.getItem(secretKey(owner, activeBetId.toString())) ||
      localStorage.getItem(pendingKey(owner, activeBet.commitment));
    const block = await blockNumber();

    if (block <= activeBet.entropyBlock) {
      actionButton.textContent = 'WAITING FOR RONIN BLOCK';
      actionButton.disabled = true;
      setStatus(`Bet #${activeBetId} confirmed. Waiting for Ronin block ${activeBet.entropyBlock.toLocaleString()}.`);
    } else if (block <= activeBet.deadline) {
      actionButton.textContent = 'REVEAL & FLIP ON-CHAIN';
      actionButton.disabled = !activeSecret;
      setStatus(activeSecret
        ? `Ronin entropy is ready. Confirm Reveal & Settle for bet #${activeBetId}.`
        : `Bet #${activeBetId} is ready, but this browser does not have its reveal secret.`, activeSecret ? 'good' : 'error');
    } else {
      actionButton.textContent = 'REVEAL WINDOW EXPIRED';
      actionButton.disabled = true;
      if (expireButton) {
        expireButton.hidden = false;
        expireButton.disabled = false;
      }
      setStatus(`Bet #${activeBetId} expired and can be sent to treasury.`, 'error');
    }
  }

  async function placeBet() {
    const owner = account();
    const amount = ethers.parseUnits(amountInput?.value || '0', 18);
    if (amount < ethers.parseUnits('1', 18) || amount > ethers.parseUnits('1000000', 18)) {
      throw new Error('Enter a bet from 1 to 1,000,000 MATT.');
    }

    const secret = ethers.hexlify(crypto.getRandomValues(new Uint8Array(32)));
    const choice = selectedChoice();
    const commitment = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
      ['bytes32', 'address', 'uint8', 'uint256', 'address', 'uint256'],
      [secret, owner, choice, amount, config.contractAddress, BigInt(config.chainId)]
    ));
    localStorage.setItem(pendingKey(owner, commitment), secret);

    if (await allowance(owner) < amount) {
      setStatus('Confirm the MATT approval transaction in Ronin Wallet.');
      await sendWithProbe({
        to: config.tokenAddress,
        data: token.encodeFunctionData('approve', [config.contractAddress, amount]),
        label: 'MATT approval',
        probe: async () => (await allowance(owner)) >= amount
      });
      if (await allowance(owner) < amount) throw new Error('The MATT approval was not detected on-chain.');
    }

    setStatus('Approval confirmed. Confirm the Place Bet transaction in Ronin Wallet.');
    const before = await active(owner);
    const receipt = await sendWithProbe({
      to: config.contractAddress,
      data: game.encodeFunctionData('placeBet', [choice, amount, commitment]),
      label: 'Place Bet',
      probe: async () => (await active(owner)) !== before
    });

    let betId = receipt ? parseEvent(receipt, 'BetPlaced')?.args?.betId : null;
    if (betId == null) betId = await active(owner);
    if (!betId) throw new Error('The bet was not detected on-chain.');
    localStorage.setItem(secretKey(owner, betId.toString()), secret);
    localStorage.removeItem(pendingKey(owner, commitment));
    setStatus(`Bet #${betId} confirmed on Ronin.`, 'good');
  }

  async function revealBet() {
    const owner = account();
    const betId = activeBetId;
    const secret = activeSecret;
    setStatus('Confirm Reveal & Settle in Ronin Wallet.');
    const receipt = await sendWithProbe({
      to: config.contractAddress,
      data: game.encodeFunctionData('revealAndSettle', [betId, secret]),
      label: 'Reveal & Settle',
      probe: async () => (await active(owner)) === 0n
    });

    const settled = receipt ? parseEvent(receipt, 'BetSettled') : null;
    localStorage.removeItem(secretKey(owner, betId.toString()));
    if (settled) {
      const outcome = Number(settled.args.outcome);
      const won = Boolean(settled.args.won);
      coin?.classList.remove('flipping');
      void coin?.offsetWidth;
      coin?.classList.add('flipping');
      setTimeout(() => {
        const face = coin?.querySelector('.coin-face');
        if (face) face.textContent = outcome === 0 ? 'M' : 'T';
      }, 700);
      result.className = won ? 'result win' : 'result';
      result.textContent = won
        ? `${outcome === 0 ? 'HEADS' : 'TAILS'} — YOU WON.`
        : `${outcome === 0 ? 'HEADS' : 'TAILS'} — STAKE SENT TO TREASURY.`;
    }
    setStatus(`Bet #${betId} settled on Ronin.`, 'good');
    try {
      if (typeof markDailyMission === 'function') markDailyMission('flip');
      if (typeof loadBalances === 'function') await loadBalances(owner);
    } catch {
      // Optional UI refresh.
    }
  }

  async function expireBet() {
    const owner = account();
    const betId = activeBetId;
    setStatus('Confirm Expire Bet in Ronin Wallet.');
    await sendWithProbe({
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
    busy = true;
    actionButton.disabled = true;
    try {
      if (!account() || !wallet()) {
        if (typeof connectWallet === 'function') await connectWallet();
      } else if (activeBetId === 0n) {
        await placeBet();
      } else {
        await revealBet();
      }
    } catch (error) {
      setStatus(friendly(error), 'error');
    } finally {
      busy = false;
      await refreshState();
    }
  });

  expireButton?.addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    try {
      await expireBet();
    } catch (error) {
      setStatus(friendly(error), 'error');
    } finally {
      busy = false;
      await refreshState();
    }
  });

  (async () => {
    try {
      ethers = await import(ETHERS_URL);
      game = new ethers.Interface(GAME_ABI);
      token = new ethers.Interface(TOKEN_ABI);
      await refreshState();
      setInterval(refreshState, 5000);
    } catch (error) {
      setStatus(`Direct transaction layer failed to load: ${friendly(error)}`, 'error');
      actionButton.disabled = true;
    }
  })();
})();
