(() => {
  'use strict';

  const ETHERS_MODULE_URL = 'https://esm.sh/ethers@6.13.5?bundle';
  const config = window.MATT_COIN_FLIP_CONFIG || {};
  const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
  const GAME_ABI = [
    'function MIN_BET() view returns (uint256)',
    'function MAX_BET() view returns (uint256)',
    'function REVEAL_WINDOW_BLOCKS() view returns (uint64)',
    'function availableBankroll() view returns (uint256)',
    'function maxAcceptableBet() view returns (uint256)',
    'function paused() view returns (bool)',
    'function activeBetOf(address) view returns (uint256)',
    'function bets(uint256) view returns (address player,uint128 amount,uint64 entropyBlock,uint64 revealDeadlineBlock,uint8 choice,uint8 state,bytes32 commitment)',
    'function placeBet(uint8 choice,uint256 amount,bytes32 commitment) returns (uint256)',
    'function placeBetWithPermit(uint8 choice,uint256 amount,bytes32 commitment,uint256 permitDeadline,uint8 v,bytes32 r,bytes32 s) returns (uint256)',
    'function revealAndSettle(uint256 betId,bytes32 secret) returns (bool won)',
    'function expireBet(uint256 betId)',
    'event BetPlaced(uint256 indexed betId,address indexed player,uint8 choice,uint256 amount,uint256 entropyBlock,uint256 revealDeadlineBlock,bytes32 commitment)',
    'event BetSettled(uint256 indexed betId,address indexed player,uint8 choice,uint8 outcome,uint256 amount,uint256 payout,bool won,bytes32 entropyBlockHash,uint256 randomWord)',
    'event BetExpired(uint256 indexed betId,address indexed player,uint256 amount)'
  ];
  const TOKEN_ABI = [
    'function balanceOf(address) view returns (uint256)',
    'function allowance(address,address) view returns (uint256)',
    'function approve(address,uint256) returns (bool)',
    'function nonces(address) view returns (uint256)'
  ];

  const section = document.getElementById('coin-flip');
  const card = section?.querySelector('.game-card');
  const coin = document.getElementById('coin');
  const result = document.getElementById('flip-result');
  const oldActionButton = document.getElementById('flip-button');
  const choiceButtons = [...document.querySelectorAll('.choice[data-choice]')];
  const statLabels = [...section?.querySelectorAll('.game-stats span') || []];
  const statValues = [...section?.querySelectorAll('.game-stats strong') || []];

  if (!section || !card || !coin || !result || !oldActionButton) return;

  const actionButton = oldActionButton.cloneNode(true);
  oldActionButton.replaceWith(actionButton);
  actionButton.textContent = 'CONNECT TO BET';
  actionButton.disabled = true;
  card.classList.add('onchain-game-card');

  const heading = section.querySelector('.section-heading');
  if (heading) {
    heading.querySelector('.eyebrow').textContent = 'MATT UTILITY #1 · ON-CHAIN';
    heading.querySelector('h2').textContent = 'Flip the MATT Coin';
    heading.querySelector('p:last-child').textContent =
      'Bet 1 to 1,000,000 MATT. A committed secret and a future Ronin block determine the result. Winning pays 2×; losing sends the stake to treasury.';
  }

  const panel = document.createElement('div');
  panel.className = 'onchain-bet-panel';
  panel.innerHTML = `
    <div class="coin-contract-strip">
      <span>GAME CONTRACT</span>
      <a id="coin-game-contract" href="#" target="_blank" rel="noopener">Deployment pending</a>
    </div>
    <div class="coin-amount-row">
      <label class="coin-amount-field">
        <span>Bet amount</span>
        <span class="coin-amount-input-wrap">
          <input id="coin-bet-amount" type="number" inputmode="decimal" min="1" max="1000000" step="1" value="1000" aria-label="MATT bet amount">
          <span>MATT</span>
        </span>
      </label>
      <button class="coin-max-button" id="coin-bet-max" type="button">MAX</button>
    </div>
    <div class="coin-quick-row" aria-label="Quick bet amounts">
      <button class="coin-quick-button" type="button" data-bet="1000">1K</button>
      <button class="coin-quick-button" type="button" data-bet="10000">10K</button>
      <button class="coin-quick-button" type="button" data-bet="100000">100K</button>
      <button class="coin-quick-button" type="button" data-bet="1000000">1M</button>
    </div>
    <div class="coin-game-info-grid">
      <div><span>Your MATT</span><strong id="coin-wallet-balance">Connect wallet</strong></div>
      <div><span>Available bankroll</span><strong id="coin-bankroll">—</strong></div>
      <div><span>Current maximum</span><strong id="coin-current-max">—</strong></div>
    </div>
    <div class="coin-game-flow" aria-label="On-chain bet flow">
      <div class="coin-game-step" data-step="commit"><b>01 COMMIT</b><span>Sign the bet and lock MATT.</span></div>
      <div class="coin-game-step" data-step="block"><b>02 RONIN BLOCK</b><span>Wait for future block entropy.</span></div>
      <div class="coin-game-step" data-step="reveal"><b>03 REVEAL</b><span>Sign again to flip and settle.</span></div>
    </div>
    <div class="coin-game-warning">
      <strong>Keep this browser open or preserve its storage while a bet is pending.</strong>
      The secret never leaves your device before reveal. If it is lost or not revealed within 200 blocks, the stake can be sent to treasury.
    </div>
    <label class="coin-legal-check">
      <input id="coin-legal-confirm" type="checkbox">
      <span>I confirm I am at least 18, permitted to use token wagering where I live, and understand I can lose my full bet.</span>
    </label>
    <p class="coin-game-progress" id="coin-game-progress" role="status" aria-live="polite">Loading the on-chain game…</p>
  `;
  actionButton.before(panel);

  const expireButton = document.createElement('button');
  expireButton.className = 'coin-secondary-action';
  expireButton.id = 'coin-expire-bet';
  expireButton.type = 'button';
  expireButton.textContent = 'EXPIRE UNREVEALED BET';
  expireButton.hidden = true;
  actionButton.after(expireButton);

  if (statLabels.length >= 3) {
    statLabels[0].textContent = 'On-chain bets';
    statLabels[1].textContent = 'Wins';
    statLabels[2].textContent = 'Pending';
  }

  const contractLink = document.getElementById('coin-game-contract');
  const amountInput = document.getElementById('coin-bet-amount');
  const maxButton = document.getElementById('coin-bet-max');
  const walletBalanceDisplay = document.getElementById('coin-wallet-balance');
  const bankrollDisplay = document.getElementById('coin-bankroll');
  const currentMaxDisplay = document.getElementById('coin-current-max');
  const legalConfirm = document.getElementById('coin-legal-confirm');
  const progress = document.getElementById('coin-game-progress');
  const flowSteps = new Map(
    [...document.querySelectorAll('.coin-game-step')].map(element => [element.dataset.step, element])
  );

  let ethersLib = null;
  let provider = null;
  let signer = null;
  let game = null;
  let token = null;
  let account = null;
  let selectedChoice = 0;
  let activeBetId = 0n;
  let activeBet = null;
  let activeSecret = null;
  let walletBalance = 0n;
  let currentMaximum = 0n;
  let paused = false;
  let actionMode = 'connect';
  let lastSeenHubAccount = null;
  let syncTimer = null;
  let busy = false;

  function hubAccount() {
    try {
      return typeof currentAccount === 'string' && currentAccount ? currentAccount.toLowerCase() : null;
    } catch {
      return null;
    }
  }

  function hubProvider() {
    try {
      return walletConnectProvider || null;
    } catch {
      return null;
    }
  }

  async function requestHubConnection() {
    try {
      if (typeof connectWallet === 'function') await connectWallet();
    } catch (error) {
      throw new Error(readableError(error));
    }
  }

  function isConfigured() {
    return Boolean(
      ethersLib &&
      typeof config.contractAddress === 'string' &&
      ethersLib.isAddress(config.contractAddress) &&
      config.contractAddress.toLowerCase() !== ZERO_ADDRESS
    );
  }

  function formatMatt(raw, precision = 2) {
    if (!ethersLib) return '—';
    const text = ethersLib.formatUnits(raw, 18);
    const [whole, fraction = ''] = text.split('.');
    const trimmed = fraction.slice(0, precision).replace(/0+$/, '');
    return `${BigInt(whole).toLocaleString()}${trimmed ? `.${trimmed}` : ''} MATT`;
  }

  function statsKey(targetAccount = account) {
    return `mattCoinFlipStats:${String(config.contractAddress || 'pending').toLowerCase()}:${targetAccount || 'none'}`;
  }

  function loadStats() {
    if (!account) return { bets: 0, wins: 0 };
    try {
      const parsed = JSON.parse(localStorage.getItem(statsKey()) || '{}');
      return {
        bets: Number(parsed.bets || 0),
        wins: Number(parsed.wins || 0)
      };
    } catch {
      return { bets: 0, wins: 0 };
    }
  }

  function saveStats(stats) {
    if (account) localStorage.setItem(statsKey(), JSON.stringify(stats));
  }

  function renderStats() {
    const stats = loadStats();
    if (statValues[0]) statValues[0].textContent = stats.bets.toLocaleString();
    if (statValues[1]) statValues[1].textContent = stats.wins.toLocaleString();
    if (statValues[2]) statValues[2].textContent = activeBetId ? '1' : '0';
  }

  function pendingSecretKey(commitment) {
    return `mattCoinFlipPendingSecret:${String(config.contractAddress).toLowerCase()}:${account}:${commitment}`;
  }

  function betSecretKey(betId) {
    return `mattCoinFlipSecret:${String(config.contractAddress).toLowerCase()}:${account}:${betId}`;
  }

  function storePendingSecret(commitment, secret) {
    localStorage.setItem(pendingSecretKey(commitment), secret);
  }

  function storeBetSecret(betId, commitment, secret) {
    localStorage.setItem(betSecretKey(betId), secret);
    localStorage.removeItem(pendingSecretKey(commitment));
  }

  function recoverBetSecret(betId, commitment) {
    return localStorage.getItem(betSecretKey(betId)) || localStorage.getItem(pendingSecretKey(commitment));
  }

  function clearBetSecret(betId, commitment) {
    localStorage.removeItem(betSecretKey(betId));
    if (commitment) localStorage.removeItem(pendingSecretKey(commitment));
  }

  function setProgress(message, type = '') {
    progress.textContent = message;
    progress.className = `coin-game-progress${type ? ` ${type}` : ''}`;
  }

  function readableError(error) {
    const message = error?.shortMessage || error?.reason || error?.info?.error?.message || error?.message || String(error);
    if (/user rejected|user denied|action_rejected|4001/i.test(message)) return 'Wallet request cancelled.';
    if (/ActiveBetExists/i.test(message)) return 'This wallet already has a pending bet.';
    if (/InsufficientBankroll/i.test(message)) return 'The contract bankroll cannot cover that bet yet.';
    if (/BetAboveMaximum/i.test(message)) return 'The maximum bet is 1,000,000 MATT.';
    if (/BetBelowMinimum/i.test(message)) return 'The minimum bet is 1 MATT.';
    if (/RevealWindowClosed/i.test(message)) return 'The reveal window closed. Expire the bet to treasury.';
    if (/InvalidSecret/i.test(message)) return 'The saved reveal secret does not match this bet.';
    return message.replace(/execution reverted:?/i, '').trim().slice(0, 240);
  }

  function isUserRejected(error) {
    return /user rejected|user denied|action_rejected|4001/i.test(
      error?.shortMessage || error?.message || ''
    );
  }

  function setFlow(activeStep, completeSteps = []) {
    for (const [name, element] of flowSteps) {
      element.classList.toggle('active', name === activeStep);
      element.classList.toggle('complete', completeSteps.includes(name));
    }
  }

  function setAction(mode) {
    actionMode = mode;
    expireButton.hidden = true;

    if (mode === 'disabled') {
      actionButton.textContent = 'CONTRACT DEPLOYMENT PENDING';
      actionButton.disabled = true;
      setFlow(null, []);
    } else if (mode === 'connect') {
      actionButton.textContent = 'CONNECT WALLETCONNECT';
      actionButton.disabled = false;
      setFlow('commit', []);
    } else if (mode === 'place') {
      actionButton.textContent = 'PLACE ON-CHAIN BET';
      actionButton.disabled = paused || busy;
      setFlow('commit', []);
    } else if (mode === 'waiting') {
      actionButton.textContent = 'WAITING FOR RONIN BLOCK';
      actionButton.disabled = true;
      setFlow('block', ['commit']);
    } else if (mode === 'reveal') {
      actionButton.textContent = 'REVEAL & FLIP ON-CHAIN';
      actionButton.disabled = busy || !activeSecret;
      setFlow('reveal', ['commit', 'block']);
    } else if (mode === 'expire') {
      actionButton.textContent = activeSecret ? 'REVEAL WINDOW EXPIRED' : 'SECRET UNAVAILABLE';
      actionButton.disabled = true;
      expireButton.hidden = false;
      expireButton.disabled = busy;
      setFlow(null, ['commit', 'block']);
    }
  }

  function minimumBigInt(...values) {
    return values.reduce((smallest, value) => (value < smallest ? value : smallest));
  }

  function parseBetAmount() {
    const raw = amountInput.value.trim();
    if (!raw) throw new Error('Enter a MATT bet amount.');
    const amount = ethersLib.parseUnits(raw, 18);
    if (amount < ethersLib.parseUnits(String(config.minimumBetMatt || '1'), 18)) {
      throw new Error('The minimum bet is 1 MATT.');
    }
    if (amount > ethersLib.parseUnits(String(config.maximumBetMatt || '1000000'), 18)) {
      throw new Error('The maximum bet is 1,000,000 MATT.');
    }
    if (amount > walletBalance) throw new Error('Your wallet does not hold enough MATT.');
    if (amount > currentMaximum) throw new Error('The contract bankroll cannot cover that amount.');
    return amount;
  }

  function makeSecret() {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return ethersLib.hexlify(bytes);
  }

  function makeCommitment(secret, amount) {
    const encoded = ethersLib.AbiCoder.defaultAbiCoder().encode(
      ['bytes32', 'address', 'uint8', 'uint256', 'address', 'uint256'],
      [secret, account, selectedChoice, amount, config.contractAddress, BigInt(config.chainId)]
    );
    return ethersLib.keccak256(encoded);
  }

  function parseEvent(receipt, name) {
    for (const log of receipt.logs || []) {
      try {
        const parsed = game.interface.parseLog(log);
        if (parsed?.name === name) return parsed;
      } catch {
        // Ignore unrelated token and wallet logs.
      }
    }
    return null;
  }

  async function initializeContracts() {
    const eip1193 = hubProvider();
    account = hubAccount();
    if (!eip1193 || !account || !isConfigured()) return false;

    provider = new ethersLib.BrowserProvider(eip1193, 'any');
    const network = await provider.getNetwork();
    if (Number(network.chainId) !== Number(config.chainId)) {
      throw new Error('Switch WalletConnect to Ronin Mainnet.');
    }

    signer = await provider.getSigner(account);
    game = new ethersLib.Contract(config.contractAddress, GAME_ABI, signer);
    token = new ethersLib.Contract(config.tokenAddress, TOKEN_ABI, signer);
    return true;
  }

  async function refreshGameState() {
    if (busy || !ethersLib) return;

    const currentHubAccount = hubAccount();
    if (currentHubAccount !== account) {
      account = currentHubAccount;
      provider = null;
      signer = null;
      game = null;
      token = null;
      activeBetId = 0n;
      activeBet = null;
      activeSecret = null;
    }

    if (!isConfigured()) {
      contractLink.textContent = 'Deployment pending';
      contractLink.removeAttribute('href');
      walletBalanceDisplay.textContent = account ? 'Contract pending' : 'Connect wallet';
      bankrollDisplay.textContent = 'Deployment pending';
      currentMaxDisplay.textContent = '—';
      setProgress('The contract and website integration are ready. Deploy MattCoinFlip, then add its address to coin-game-config.js.');
      setAction('disabled');
      renderStats();
      return;
    }

    contractLink.href = `${config.explorerAddressBase}${config.contractAddress}`;
    contractLink.textContent = `${config.contractAddress.slice(0, 8)}…${config.contractAddress.slice(-6)}`;

    if (!currentHubAccount || !hubProvider()) {
      walletBalanceDisplay.textContent = 'Connect wallet';
      bankrollDisplay.textContent = 'Connect to load';
      currentMaxDisplay.textContent = '—';
      setProgress('Connect through WalletConnect to place an on-chain MATT bet.');
      setAction('connect');
      renderStats();
      return;
    }

    try {
      if (!(await initializeContracts())) return;
      const [balance, bankroll, maxBet, isPaused, active] = await Promise.all([
        token.balanceOf(account),
        game.availableBankroll(),
        game.maxAcceptableBet(),
        game.paused(),
        game.activeBetOf(account)
      ]);

      walletBalance = balance;
      currentMaximum = minimumBigInt(
        maxBet,
        balance,
        ethersLib.parseUnits(String(config.maximumBetMatt || '1000000'), 18)
      );
      paused = isPaused;
      activeBetId = active;

      walletBalanceDisplay.textContent = formatMatt(balance);
      bankrollDisplay.textContent = formatMatt(bankroll);
      currentMaxDisplay.textContent = formatMatt(currentMaximum);

      if (activeBetId === 0n) {
        activeBet = null;
        activeSecret = null;
        setProgress(paused ? 'The game contract is currently paused.' : 'Choose heads or tails, enter an amount, and place your bet.');
        setAction(paused ? 'disabled' : 'place');
        renderStats();
        return;
      }

      activeBet = await game.bets(activeBetId);
      activeSecret = recoverBetSecret(activeBetId.toString(), activeBet.commitment);
      const currentBlock = await provider.getBlockNumber();
      const entropyBlock = Number(activeBet.entropyBlock);
      const deadlineBlock = Number(activeBet.revealDeadlineBlock);

      if (Number(activeBet.state) !== 1) {
        clearBetSecret(activeBetId.toString(), activeBet.commitment);
        activeBetId = 0n;
        await refreshGameState();
        return;
      }

      if (currentBlock <= entropyBlock) {
        setProgress(`Bet #${activeBetId} confirmed. Waiting for Ronin block ${entropyBlock.toLocaleString()} before reveal.`);
        setAction('waiting');
      } else if (currentBlock <= deadlineBlock) {
        setProgress(
          activeSecret
            ? `Ronin entropy is ready. Sign the reveal transaction to flip and settle bet #${activeBetId}.`
            : `Bet #${activeBetId} is ready, but this browser does not have its reveal secret.` ,
          activeSecret ? 'good' : 'error'
        );
        setAction('reveal');
      } else {
        setProgress(`Bet #${activeBetId} was not revealed before block ${deadlineBlock.toLocaleString()}. It can now be expired to treasury.`, 'error');
        setAction('expire');
      }
      renderStats();
    } catch (error) {
      setProgress(readableError(error), 'error');
      setAction('connect');
    }
  }

  async function placeBet() {
    if (!legalConfirm.checked) throw new Error('Confirm the age, jurisdiction, and loss acknowledgement first.');
    if (!(await initializeContracts())) throw new Error('Connect WalletConnect first.');
    const amount = parseBetAmount();
    const secret = makeSecret();
    const commitment = makeCommitment(secret, amount);
    storePendingSecret(commitment, secret);

    let transaction;
    const allowance = await token.allowance(account, config.contractAddress);

    if (allowance < amount) {
      setProgress('Requesting a gasless ERC-2612 permit signature…');
      try {
        const nonce = await token.nonces(account);
        const permitDeadline = BigInt(Math.floor(Date.now() / 1000) + 20 * 60);
        const signatureHex = await signer.signTypedData(
          {
            name: 'Matt',
            version: '1',
            chainId: BigInt(config.chainId),
            verifyingContract: config.tokenAddress
          },
          {
            Permit: [
              { name: 'owner', type: 'address' },
              { name: 'spender', type: 'address' },
              { name: 'value', type: 'uint256' },
              { name: 'nonce', type: 'uint256' },
              { name: 'deadline', type: 'uint256' }
            ]
          },
          {
            owner: account,
            spender: config.contractAddress,
            value: amount,
            nonce,
            deadline: permitDeadline
          }
        );
        const signature = ethersLib.Signature.from(signatureHex);
        setProgress('Permit signed. Confirm the on-chain bet transaction in your wallet.');
        transaction = await game.placeBetWithPermit(
          selectedChoice,
          amount,
          commitment,
          permitDeadline,
          signature.v,
          signature.r,
          signature.s
        );
      } catch (permitError) {
        if (isUserRejected(permitError)) throw permitError;
        setProgress('Permit is unavailable in this wallet. Confirm a one-time MATT approval transaction.');
        const approval = await token.approve(config.contractAddress, amount);
        await approval.wait();
        setProgress('Approval confirmed. Now confirm the on-chain bet transaction.');
        transaction = await game.placeBet(selectedChoice, amount, commitment);
      }
    } else {
      setProgress('Confirm the on-chain bet transaction in your wallet.');
      transaction = await game.placeBet(selectedChoice, amount, commitment);
    }

    setProgress('Bet submitted. Waiting for Ronin confirmation…');
    const receipt = await transaction.wait();
    const placed = parseEvent(receipt, 'BetPlaced');

    let betId = placed?.args?.betId;
    if (betId == null) betId = await game.activeBetOf(account);
    if (!betId) throw new Error('The bet confirmed, but its bet ID could not be recovered.');

    storeBetSecret(betId.toString(), commitment, secret);
    activeBetId = BigInt(betId);
    const stats = loadStats();
    stats.bets += 1;
    saveStats(stats);

    setProgress(`Bet #${activeBetId} confirmed. Waiting for the future Ronin entropy block.`);
    await refreshExternalBalances();
    await refreshGameState();
  }

  async function revealBet() {
    if (!activeBetId || !activeSecret) throw new Error('The reveal secret is unavailable in this browser.');
    if (!(await initializeContracts())) throw new Error('Reconnect WalletConnect first.');

    setProgress('Confirm the reveal transaction. The contract will flip and settle in this transaction.');
    const transaction = await game.revealAndSettle(activeBetId, activeSecret);
    setProgress('Reveal submitted. Waiting for settlement confirmation…');
    const receipt = await transaction.wait();
    const settled = parseEvent(receipt, 'BetSettled');

    if (!settled) throw new Error('Settlement confirmed, but the result event could not be read. Refresh the page.');

    const outcome = Number(settled.args.outcome);
    const won = Boolean(settled.args.won);
    const payout = settled.args.payout;
    const finishedBetId = activeBetId;
    const finishedCommitment = activeBet?.commitment;

    coin.classList.remove('flipping');
    void coin.offsetWidth;
    coin.classList.add('flipping');
    setTimeout(() => {
      const face = coin.querySelector('.coin-face');
      if (face) face.textContent = outcome === 0 ? 'M' : 'T';
    }, 700);

    clearBetSecret(finishedBetId.toString(), finishedCommitment);
    const stats = loadStats();
    if (won) stats.wins += 1;
    saveStats(stats);

    result.className = won ? 'result win' : 'result';
    result.textContent = won
      ? `${outcome === 0 ? 'HEADS' : 'TAILS'} — YOU WON ${formatMatt(payout)}.`
      : `${outcome === 0 ? 'HEADS' : 'TAILS'} — ${formatMatt(settled.args.amount)} SENT TO TREASURY.`;
    setProgress(
      won
        ? `Bet #${finishedBetId} settled and paid automatically by the contract.`
        : `Bet #${finishedBetId} settled. The losing stake was transferred to treasury.`,
      won ? 'good' : ''
    );

    try {
      if (typeof markDailyMission === 'function') markDailyMission('flip');
    } catch {
      // Mission tracking is optional and device-based.
    }

    activeBetId = 0n;
    activeBet = null;
    activeSecret = null;
    await refreshExternalBalances();
    await refreshGameState();
  }

  async function expireBet() {
    if (!activeBetId) return;
    if (!(await initializeContracts())) throw new Error('Reconnect WalletConnect first.');
    setProgress('Confirm the expiry transaction. The unrevealed stake will be sent to treasury.');
    const transaction = await game.expireBet(activeBetId);
    await transaction.wait();
    clearBetSecret(activeBetId.toString(), activeBet?.commitment);
    result.className = 'result';
    result.textContent = `Bet #${activeBetId} expired to treasury.`;
    activeBetId = 0n;
    activeBet = null;
    activeSecret = null;
    await refreshExternalBalances();
    await refreshGameState();
  }

  async function refreshExternalBalances() {
    try {
      if (typeof loadBalances === 'function' && account) await loadBalances(account);
    } catch {
      // The game remains usable if the dashboard refresh fails.
    }
  }

  async function runAction() {
    if (busy) return;
    busy = true;
    actionButton.disabled = true;
    expireButton.disabled = true;
    try {
      if (actionMode === 'connect') {
        await requestHubConnection();
      } else if (actionMode === 'place') {
        await placeBet();
      } else if (actionMode === 'reveal') {
        await revealBet();
      }
    } catch (error) {
      setProgress(readableError(error), 'error');
    } finally {
      busy = false;
      expireButton.disabled = false;
      await refreshGameState();
    }
  }

  actionButton.addEventListener('click', runAction);
  expireButton.addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    expireButton.disabled = true;
    try {
      await expireBet();
    } catch (error) {
      setProgress(readableError(error), 'error');
    } finally {
      busy = false;
      expireButton.disabled = false;
      await refreshGameState();
    }
  });

  for (const button of choiceButtons) {
    button.addEventListener('click', () => {
      selectedChoice = button.dataset.choice === 'tails' ? 1 : 0;
    });
  }

  for (const button of document.querySelectorAll('.coin-quick-button')) {
    button.addEventListener('click', () => {
      amountInput.value = button.dataset.bet;
    });
  }

  maxButton.addEventListener('click', () => {
    if (!ethersLib || currentMaximum <= 0n) return;
    amountInput.value = ethersLib.formatUnits(currentMaximum, 18).replace(/\.0+$/, '');
  });

  async function start() {
    try {
      ethersLib = await import(ETHERS_MODULE_URL);
      lastSeenHubAccount = hubAccount();
      await refreshGameState();
      syncTimer = setInterval(async () => {
        const nextAccount = hubAccount();
        if (nextAccount !== lastSeenHubAccount) {
          lastSeenHubAccount = nextAccount;
          account = null;
        }
        await refreshGameState();
      }, 5_000);
    } catch (error) {
      setProgress(`The on-chain game library could not load: ${readableError(error)}`, 'error');
      setAction('disabled');
    }
  }

  window.addEventListener('beforeunload', () => {
    if (syncTimer) clearInterval(syncTimer);
  });

  start();
})();
