(() => {
  'use strict';

  const section = document.getElementById('daily-missions');
  if (!section) return;

  const config = window.MATT_DAILY_REWARDS_CONFIG || {};
  const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
  const ETHERS_URL = 'https://esm.sh/ethers@6.13.5?bundle';
  const POLL_MS = 2000;
  const TX_TIMEOUT_MS = 180000;
  const REWARDS_ABI = [
    'function REWARD_AMOUNT() view returns (uint256)',
    'function CLAIM_COOLDOWN() view returns (uint256)',
    'function lastClaimAt(address) view returns (uint64)',
    'function lastUsedBetId(address) view returns (uint256)',
    'function availableClaims() view returns (uint256)',
    'function paused() view returns (bool)',
    'function totalClaims() view returns (uint256)',
    'function claim(uint256 betId,bool followedMatt)',
    'event RewardClaimed(address indexed wallet,uint256 indexed betId,uint256 rewardAmount,uint256 claimedAt,uint256 nextEligibleAt)'
  ];

  section.innerHTML = `
    <div class="section-heading mission-reward-heading">
      <p class="eyebrow">MATT DAILY REWARD</p>
      <h2>Complete 3. Earn 2,000,000 MATT.</h2>
      <p>Finish all three tasks. When they are complete, the Hub automatically opens one on-chain claim confirmation. Each wallet can receive the reward once every 24 hours.</p>
    </div>

    <div class="mission-reward-summary">
      <div><span>DAILY REWARD</span><strong id="daily-reward-amount">2,000,000 MATT</strong></div>
      <div><span>PROGRESS</span><strong id="daily-reward-progress">0 / 3 COMPLETE</strong></div>
      <div><span>NEXT ELIGIBLE</span><strong id="daily-reward-next">Connect Ronin</strong></div>
      <div><span>REWARD POOL</span><strong id="daily-reward-pool">Deployment pending</strong></div>
    </div>
    <div class="mission-meter" aria-hidden="true"><span id="daily-reward-meter"></span></div>

    <div class="mission-list server-mission-list">
      <article class="mission-card locked" data-daily-task="connect">
        <span class="mission-number">01</span>
        <div>
          <h3>Connect Ronin Wallet</h3>
          <p>Sign in once. Your approved Ronin session stays connected after refresh.</p>
        </div>
        <strong class="mission-status">LOCKED</strong>
        <button class="mission-action" id="daily-task-connect" type="button">CONNECT RONIN</button>
      </article>

      <article class="mission-card locked" data-daily-task="flip">
        <span class="mission-number">02</span>
        <div>
          <h3>Settle a MATT Coin Flip</h3>
          <p>Complete a new on-chain flip. The reward contract verifies the settled bet belongs to your wallet.</p>
        </div>
        <strong class="mission-status">LOCKED</strong>
        <button class="mission-action" id="daily-task-flip" type="button">GO TO COIN</button>
      </article>

      <article class="mission-card locked" data-daily-task="twitter">
        <span class="mission-number">03</span>
        <div>
          <h3 id="daily-x-title">Follow MATT on X</h3>
          <p id="daily-x-copy">Open Matt's X profile, follow the account, then confirm you completed the task.</p>
        </div>
        <strong class="mission-status">LOCKED</strong>
        <div class="mission-x-actions">
          <a class="mission-action" id="daily-x-open" href="#" target="_blank" rel="noopener">OPEN X</a>
          <button class="mission-action secondary" id="daily-x-confirm" type="button">I FOLLOWED</button>
        </div>
      </article>
    </div>

    <div class="daily-claim-panel" id="daily-claim-panel" hidden>
      <div>
        <span>ALL TASKS COMPLETE</span>
        <strong>2,000,000 MATT is ready.</strong>
        <p>The contract will verify your settled bet and 24-hour eligibility before paying.</p>
      </div>
      <button class="flip-button" id="daily-claim-button" type="button">CLAIM 2,000,000 MATT</button>
    </div>

    <p class="mission-notice" id="daily-reward-status" role="status" aria-live="polite">Connect Ronin Wallet to begin.</p>

    <div class="mission-completion-feed">
      <div class="mission-feed-heading">
        <div><p class="eyebrow">RECENT COMPLETIONS</p><h3>MATTs who completed all three tasks</h3></div>
        <button class="secondary-button" id="daily-feed-refresh" type="button">Refresh</button>
      </div>
      <div class="mission-completion-list" id="daily-completion-list">
        <p class="mission-feed-empty">The completion list will appear after the reward contract is deployed and claimed.</p>
      </div>
    </div>
  `;

  const cards = new Map([...section.querySelectorAll('[data-daily-task]')].map(card => [card.dataset.dailyTask, card]));
  const connectButton = document.getElementById('daily-task-connect');
  const flipButton = document.getElementById('daily-task-flip');
  const xOpen = document.getElementById('daily-x-open');
  const xConfirm = document.getElementById('daily-x-confirm');
  const claimPanel = document.getElementById('daily-claim-panel');
  const claimButton = document.getElementById('daily-claim-button');
  const statusDisplay = document.getElementById('daily-reward-status');
  const progressDisplay = document.getElementById('daily-reward-progress');
  const nextDisplay = document.getElementById('daily-reward-next');
  const poolDisplay = document.getElementById('daily-reward-pool');
  const amountDisplay = document.getElementById('daily-reward-amount');
  const meter = document.getElementById('daily-reward-meter');
  const completionList = document.getElementById('daily-completion-list');
  const feedRefresh = document.getElementById('daily-feed-refresh');
  const xTitle = document.getElementById('daily-x-title');
  const xCopy = document.getElementById('daily-x-copy');
  const coinProgress = document.getElementById('coin-game-progress');

  let ethers;
  let rewardsInterface;
  let rpcId = 0;
  let busy = false;
  let autoClaiming = false;
  let chainState = null;
  let countdownTimer = null;
  let refreshTimer = null;

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  function account() {
    const value = window.MattRoninConnect?.account || (typeof currentAccount === 'string' ? currentAccount : null);
    return /^0x[a-fA-F0-9]{40}$/.test(String(value || '')) ? String(value).toLowerCase() : null;
  }

  function wallet() {
    return window.MattRoninConnect?.provider || (typeof walletConnectProvider !== 'undefined' ? walletConnectProvider : null);
  }

  function configured() {
    return Boolean(ethers && ethers.isAddress(config.contractAddress) && config.contractAddress.toLowerCase() !== ZERO_ADDRESS);
  }

  function storageKey(owner = account()) {
    return `mattDailyRewards:${String(config.contractAddress || ZERO_ADDRESS).toLowerCase()}:${owner || 'none'}`;
  }

  function blankLocalState() {
    return { cycleClaimAt: '0', flipBetId: null, twitterConfirmed: false, xOpened: false, claimed: false, autoPrompted: false };
  }

  function loadLocal(owner = account()) {
    if (!owner) return blankLocalState();
    try {
      return { ...blankLocalState(), ...JSON.parse(localStorage.getItem(storageKey(owner)) || '{}') };
    } catch {
      return blankLocalState();
    }
  }

  function saveLocal(state, owner = account()) {
    if (owner) localStorage.setItem(storageKey(owner), JSON.stringify(state));
  }

  function normalizeLocal(state, lastClaimAt, lastUsedBetId) {
    const now = Math.floor(Date.now() / 1000);
    const cooldown = Number(chainState?.cooldown || config.cooldownSeconds || 86400);
    const coolingDown = lastClaimAt > 0n && now < Number(lastClaimAt) + cooldown;

    if (coolingDown) {
      state.cycleClaimAt = lastClaimAt.toString();
      state.claimed = true;
      return state;
    }

    if (state.claimed || BigInt(state.cycleClaimAt || '0') !== lastClaimAt) {
      state.cycleClaimAt = lastClaimAt.toString();
      state.flipBetId = null;
      state.twitterConfirmed = false;
      state.xOpened = false;
      state.claimed = false;
      state.autoPrompted = false;
    }

    if (state.flipBetId && BigInt(state.flipBetId) <= lastUsedBetId) state.flipBetId = null;
    return state;
  }

  async function rpc(method, params = []) {
    const response = await fetch('/api/rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.error) throw new Error(payload.error?.message || `Ronin RPC returned HTTP ${response.status}`);
    return payload.result;
  }

  async function read(name, args = []) {
    const data = rewardsInterface.encodeFunctionData(name, args);
    const raw = await rpc('eth_call', [{ to: config.contractAddress, data }, 'latest']);
    return rewardsInterface.decodeFunctionResult(name, raw);
  }

  async function loadChainState() {
    const owner = account();
    if (!owner || !configured()) return null;
    const [reward, cooldown, lastClaim, lastBet, available, isPaused, total] = await Promise.all([
      read('REWARD_AMOUNT'),
      read('CLAIM_COOLDOWN'),
      read('lastClaimAt', [owner]),
      read('lastUsedBetId', [owner]),
      read('availableClaims'),
      read('paused'),
      read('totalClaims')
    ]);
    chainState = {
      rewardAmount: BigInt(reward[0]),
      cooldown: BigInt(cooldown[0]),
      lastClaimAt: BigInt(lastClaim[0]),
      lastUsedBetId: BigInt(lastBet[0]),
      availableClaims: BigInt(available[0]),
      paused: Boolean(isPaused[0]),
      totalClaims: BigInt(total[0])
    };
    return chainState;
  }

  function setMessage(message, type = '') {
    statusDisplay.textContent = message;
    statusDisplay.className = `mission-notice${type ? ` ${type}` : ''}`;
  }

  function setCard(name, complete, available) {
    const card = cards.get(name);
    if (!card) return;
    card.classList.toggle('completed', complete);
    card.classList.toggle('locked', !complete && !available);
    card.querySelector('.mission-status').textContent = complete ? 'COMPLETE' : available ? 'OPEN' : 'LOCKED';
  }

  function render() {
    const owner = account();
    if (!owner) {
      clearInterval(countdownTimer);
      progressDisplay.textContent = '0 / 3 COMPLETE';
      meter.style.width = '0%';
      nextDisplay.textContent = 'Connect Ronin';
      poolDisplay.textContent = configured() ? 'Connect to load' : 'Deployment pending';
      setCard('connect', false, true);
      setCard('flip', false, false);
      setCard('twitter', false, false);
      connectButton.textContent = 'CONNECT RONIN';
      connectButton.disabled = false;
      flipButton.disabled = true;
      xOpen.classList.add('disabled');
      xConfirm.disabled = true;
      claimPanel.hidden = true;
      setMessage('Connect Ronin Wallet to begin.');
      return;
    }

    const state = normalizeLocal(loadLocal(owner), chainState?.lastClaimAt || 0n, chainState?.lastUsedBetId || 0n);
    saveLocal(state, owner);
    const now = Math.floor(Date.now() / 1000);
    const cooldown = Number(chainState?.cooldown || config.cooldownSeconds || 86400);
    const nextEligible = Number(chainState?.lastClaimAt || 0n) + cooldown;
    const coolingDown = Boolean(chainState?.lastClaimAt && chainState.lastClaimAt > 0n && now < nextEligible);
    const connectDone = true;
    const flipDone = coolingDown || Boolean(state.flipBetId && BigInt(state.flipBetId) > (chainState?.lastUsedBetId || 0n));
    const twitterDone = coolingDown || state.twitterConfirmed;
    const completeCount = [connectDone, flipDone, twitterDone].filter(Boolean).length;
    const allComplete = completeCount === 3;

    amountDisplay.textContent = chainState ? `${Number(ethers.formatUnits(chainState.rewardAmount, 18)).toLocaleString()} MATT` : '2,000,000 MATT';
    progressDisplay.textContent = `${completeCount} / 3 COMPLETE`;
    meter.style.width = `${(completeCount / 3) * 100}%`;
    poolDisplay.textContent = chainState ? `${chainState.availableClaims.toLocaleString()} rewards available` : configured() ? 'Loading…' : 'Deployment pending';

    setCard('connect', true, true);
    setCard('flip', flipDone, !coolingDown);
    setCard('twitter', twitterDone, !coolingDown);
    connectButton.textContent = 'CONNECTED';
    connectButton.disabled = true;
    flipButton.textContent = flipDone ? 'FLIP VERIFIED' : 'GO TO COIN';
    flipButton.disabled = flipDone || coolingDown;
    xOpen.classList.toggle('disabled', coolingDown || twitterDone);
    xConfirm.textContent = twitterDone ? 'FOLLOW CONFIRMED' : 'I FOLLOWED';
    xConfirm.disabled = twitterDone || coolingDown || !state.xOpened;

    clearInterval(countdownTimer);
    if (coolingDown) {
      updateCountdown(nextEligible);
      countdownTimer = setInterval(() => updateCountdown(nextEligible), 1000);
      claimPanel.hidden = true;
      setMessage('Reward paid. This wallet can begin a new three-task cycle after the 24-hour cooldown.', 'good');
      return;
    }

    nextDisplay.textContent = allComplete ? 'Ready to claim' : `${3 - completeCount} task${3 - completeCount === 1 ? '' : 's'} remaining`;
    claimPanel.hidden = !allComplete;
    claimButton.disabled = busy || !configured() || !chainState || chainState.paused || chainState.availableClaims === 0n;

    if (!configured()) setMessage('The three-task interface is ready. Deploy and fund MattDailyRewards to activate the 2,000,000 MATT payout.', 'error');
    else if (chainState?.paused) setMessage('Daily rewards are temporarily paused by the contract owner.', 'error');
    else if (chainState?.availableClaims === 0n) setMessage('The daily reward contract needs more MATT before claims can be paid.', 'error');
    else if (allComplete) setMessage('All three tasks are complete. Confirm the on-chain claim to receive 2,000,000 MATT.', 'good');
    else setMessage('Mission progress is saved to this wallet session on this browser.');
  }

  function updateCountdown(nextEligible) {
    const remaining = Math.max(0, nextEligible - Math.floor(Date.now() / 1000));
    if (remaining <= 0) {
      nextDisplay.textContent = 'Ready now';
      clearInterval(countdownTimer);
      refresh();
      return;
    }
    const hours = Math.floor(remaining / 3600);
    const minutes = Math.floor((remaining % 3600) / 60);
    const seconds = remaining % 60;
    nextDisplay.textContent = `${hours}h ${String(minutes).padStart(2, '0')}m ${String(seconds).padStart(2, '0')}s`;
  }

  async function waitForReceipt(hash) {
    const started = Date.now();
    while (Date.now() - started < TX_TIMEOUT_MS) {
      const receipt = await rpc('eth_getTransactionReceipt', [hash]);
      if (receipt) {
        if (BigInt(receipt.status || '0x0') !== 1n) throw new Error('Daily reward claim reverted.');
        return receipt;
      }
      setMessage(`Reward claim submitted (${hash.slice(0, 10)}…). Waiting for Ronin confirmation…`);
      await sleep(POLL_MS);
    }
    throw new Error('The reward transaction is taking longer than expected. Refresh to continue tracking it.');
  }

  function transactionHash(value) {
    const hash = typeof value === 'string' ? value : value?.hash || value?.transactionHash;
    return /^0x[a-fA-F0-9]{64}$/.test(String(hash || '')) ? hash : null;
  }

  async function claimReward({ automatic = false } = {}) {
    if (busy || !configured()) return;
    const owner = account();
    const provider = wallet();
    const state = loadLocal(owner);
    if (!owner || !provider?.request || !state.flipBetId || !state.twitterConfirmed) return;

    busy = true;
    autoClaiming = automatic;
    claimButton.disabled = true;
    try {
      const before = chainState?.lastClaimAt || 0n;
      const data = rewardsInterface.encodeFunctionData('claim', [BigInt(state.flipBetId), true]);
      setMessage(automatic
        ? 'All tasks complete. Confirm the automatic 2,000,000 MATT claim in Ronin Wallet.'
        : 'Confirm the 2,000,000 MATT reward claim in Ronin Wallet.');

      const request = provider.request({
        method: 'eth_sendTransaction',
        params: [{ from: owner, to: config.contractAddress, data, value: '0x0' }]
      }).then(value => ({ hash: transactionHash(value) })).catch(error => ({ error }));

      const started = Date.now();
      let receipt = null;
      while (Date.now() - started < TX_TIMEOUT_MS) {
        const response = await Promise.race([request, sleep(POLL_MS).then(() => null)]);
        if (response?.error) throw response.error;
        if (response?.hash) {
          receipt = await waitForReceipt(response.hash);
          break;
        }
        const latest = BigInt((await read('lastClaimAt', [owner]))[0]);
        if (latest > before) break;
        setMessage('Reward claim signed. Waiting for the transaction hash or on-chain confirmation…');
      }

      const latest = BigInt((await read('lastClaimAt', [owner]))[0]);
      if (latest <= before) throw new Error('The reward claim was not detected on-chain.');
      state.cycleClaimAt = latest.toString();
      state.claimed = true;
      state.autoPrompted = true;
      saveLocal(state, owner);
      setMessage('2,000,000 MATT reward confirmed on Ronin.', 'good');
      await Promise.all([refresh(), loadCompletionFeed()]);
      return receipt;
    } catch (error) {
      setMessage(friendlyError(error), 'error');
      state.autoPrompted = false;
      saveLocal(state, owner);
    } finally {
      busy = false;
      autoClaiming = false;
      render();
    }
  }

  function friendlyError(error) {
    const message = String(error?.shortMessage || error?.reason || error?.message || error || 'Unknown error');
    if (/user rejected|user denied|4001/i.test(message)) return 'Reward claim cancelled. Use the claim button when you are ready.';
    if (/CooldownActive/i.test(message)) return 'This wallet is still inside the 24-hour reward cooldown.';
    if (/BetAlreadyUsed/i.test(message)) return 'That coin flip was already used. Complete a new on-chain flip.';
    if (/BetNotOwnedByCaller|BetNotSettled/i.test(message)) return 'The selected coin flip is not a newly settled bet for this wallet.';
    if (/InsufficientRewardPool/i.test(message)) return 'The reward contract does not currently hold enough MATT.';
    if (/insufficient funds|gas/i.test(message)) return 'The connected wallet needs a small amount of RON for claim gas.';
    return message.replace(/execution reverted:?/i, '').trim().slice(0, 240);
  }

  async function maybeAutoClaim() {
    if (busy || autoClaiming || !configured() || !chainState) return;
    const owner = account();
    const state = loadLocal(owner);
    const now = Math.floor(Date.now() / 1000);
    const nextEligible = Number(chainState.lastClaimAt) + Number(chainState.cooldown);
    const eligible = chainState.lastClaimAt === 0n || now >= nextEligible;
    const flipDone = Boolean(state.flipBetId && BigInt(state.flipBetId) > chainState.lastUsedBetId);
    if (!eligible || !flipDone || !state.twitterConfirmed || state.autoPrompted || chainState.paused || chainState.availableClaims === 0n) return;
    state.autoPrompted = true;
    saveLocal(state, owner);
    await sleep(700);
    claimReward({ automatic: true });
  }

  function inspectSettledFlip() {
    const match = coinProgress?.textContent.match(/Bet\s+#(\d+)\s+settled\s+on\s+Ronin/i);
    const owner = account();
    if (!match || !owner) return;
    const state = loadLocal(owner);
    if (state.flipBetId === match[1]) return;
    state.flipBetId = match[1];
    state.autoPrompted = false;
    saveLocal(state, owner);
    render();
    maybeAutoClaim();
  }

  async function loadCompletionFeed() {
    if (!configured() || !Number(config.deploymentBlock || 0)) {
      completionList.innerHTML = '<p class="mission-feed-empty">The public completion list will activate after the reward contract address and deployment block are added.</p>';
      return;
    }
    try {
      const event = rewardsInterface.getEvent('RewardClaimed');
      const logs = await rpc('eth_getLogs', [{
        address: config.contractAddress,
        fromBlock: `0x${Number(config.deploymentBlock).toString(16)}`,
        toBlock: 'latest',
        topics: [event.topicHash]
      }]);
      const parsed = logs.map(log => {
        try { return { log, event: rewardsInterface.parseLog(log) }; } catch { return null; }
      }).filter(Boolean).slice(-50).reverse();

      completionList.replaceChildren();
      if (!parsed.length) {
        const empty = document.createElement('p');
        empty.className = 'mission-feed-empty';
        empty.textContent = 'No wallets have completed the daily reward yet.';
        completionList.append(empty);
        return;
      }

      for (const item of parsed) {
        const row = document.createElement('a');
        row.className = 'mission-completion-row';
        row.href = `${config.explorerTransactionBase}${item.log.transactionHash}`;
        row.target = '_blank';
        row.rel = 'noopener';
        const walletLabel = document.createElement('strong');
        const walletAddress = String(item.event.args.wallet);
        walletLabel.textContent = `${walletAddress.slice(0, 6)}…${walletAddress.slice(-4)}`;
        const detail = document.createElement('span');
        detail.textContent = `${Number(ethers.formatUnits(item.event.args.rewardAmount, 18)).toLocaleString()} MATT · ${new Date(Number(item.event.args.claimedAt) * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`;
        const linkLabel = document.createElement('b');
        linkLabel.textContent = 'VIEW TX ↗';
        row.append(walletLabel, detail, linkLabel);
        completionList.append(row);
      }
    } catch (error) {
      completionList.innerHTML = `<p class="mission-feed-empty">Completion feed unavailable: ${friendlyError(error)}</p>`;
    }
  }

  async function refresh() {
    clearTimeout(refreshTimer);
    if (account() && configured()) {
      try { await loadChainState(); } catch (error) { setMessage(`Daily reward contract could not load: ${friendlyError(error)}`, 'error'); }
    } else {
      chainState = null;
    }
    render();
    maybeAutoClaim();
    refreshTimer = setTimeout(refresh, 15000);
  }

  connectButton.addEventListener('click', () => window.MattRoninConnect?.connect());
  flipButton.addEventListener('click', () => document.getElementById('coin-flip')?.scrollIntoView({ behavior: 'smooth' }));
  xOpen.href = config.xUrl || `https://x.com/${config.xHandle || 'crafting_skill'}`;
  xTitle.textContent = `Follow @${config.xHandle || 'crafting_skill'} on X`;
  xCopy.textContent = `Open @${config.xHandle || 'crafting_skill'}, follow the account, then confirm. This task is self-attested; X OAuth is not connected.`;
  xOpen.addEventListener('click', event => {
    if (!account()) {
      event.preventDefault();
      return;
    }
    const state = loadLocal();
    state.xOpened = true;
    saveLocal(state);
    xConfirm.disabled = false;
    setMessage(`After following @${config.xHandle || 'crafting_skill'}, return and press I FOLLOWED.`);
  });
  xConfirm.addEventListener('click', () => {
    const owner = account();
    if (!owner) return;
    const state = loadLocal(owner);
    if (!state.xOpened) return;
    state.twitterConfirmed = true;
    state.autoPrompted = false;
    saveLocal(state, owner);
    render();
    maybeAutoClaim();
  });
  claimButton.addEventListener('click', () => claimReward({ automatic: false }));
  feedRefresh.addEventListener('click', loadCompletionFeed);
  window.addEventListener('matt:wallet-connected', () => refresh());
  window.addEventListener('matt:wallet-disconnected', () => { chainState = null; render(); });
  if (coinProgress) new MutationObserver(inspectSettledFlip).observe(coinProgress, { childList: true, characterData: true, subtree: true });

  (async () => {
    try {
      ethers = await import(ETHERS_URL);
      rewardsInterface = new ethers.Interface(REWARDS_ABI);
      await Promise.all([refresh(), loadCompletionFeed()]);
      inspectSettledFlip();
    } catch (error) {
      setMessage(`Daily rewards failed to load: ${friendlyError(error)}`, 'error');
    }
  })();
})();
