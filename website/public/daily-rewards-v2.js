(() => {
  'use strict';

  const section = document.getElementById('daily-missions');
  if (!section) return;
  const config = window.MATT_DAILY_REWARDS_V2_CONFIG || {};
  const ZERO = '0x0000000000000000000000000000000000000000';
  const ETHERS_URL = 'https://esm.sh/ethers@6.13.5?bundle';
  const ABI = [
    'function REWARD_AMOUNT() view returns (uint256)',
    'function CLAIM_COOLDOWN() view returns (uint256)',
    'function lastClaimAt(address) view returns (uint64)',
    'function lastUsedBetId(address) view returns (uint256)',
    'function availableClaims() view returns (uint256)',
    'function paused() view returns (bool)',
    'function claim(uint256,bytes32,uint256,bytes)',
    'event RewardClaimed(address indexed wallet,uint256 indexed betId,bytes32 indexed xUserHash,uint256 rewardAmount,uint256 claimedAt,uint256 nextEligibleAt)'
  ];

  section.innerHTML = `
    <div class="section-heading mission-reward-heading">
      <p class="eyebrow">VERIFIED MATT DAILY REWARD</p>
      <h2>Complete 3. Earn 1,000,000 MATT.</h2>
      <p>Connect Ronin, settle a coin flip, and verify that your X account follows @${config.xHandle || 'crafting_skill'}.</p>
    </div>
    <div class="mission-reward-summary">
      <div><span>DAILY REWARD</span><strong>1,000,000 MATT</strong></div>
      <div><span>PROGRESS</span><strong id="v2-progress">0 / 3 COMPLETE</strong></div>
      <div><span>NEXT ELIGIBLE</span><strong id="v2-next">Connect Ronin</strong></div>
      <div><span>REWARD POOL</span><strong id="v2-pool">Migration pending</strong></div>
    </div>
    <div class="mission-list server-mission-list">
      <article class="mission-card locked" data-v2="connect"><span class="mission-number">01</span><div><h3>Connect Ronin Wallet</h3><p>Your wallet session remains connected after refresh.</p></div><strong class="mission-status">LOCKED</strong><button class="mission-action" id="v2-connect">CONNECT</button></article>
      <article class="mission-card locked" data-v2="flip"><span class="mission-number">02</span><div><h3>Settle a MATT Coin Flip</h3><p>A newly settled bet owned by this wallet is required.</p></div><strong class="mission-status">LOCKED</strong><button class="mission-action" id="v2-flip">GO TO COIN</button></article>
      <article class="mission-card locked" data-v2="x"><span class="mission-number">03</span><div><h3>Verify Follow on X</h3><p>Sign in through X OAuth. The server checks the real follow relationship.</p></div><strong class="mission-status">LOCKED</strong><button class="mission-action" id="v2-x">VERIFY X</button></article>
    </div>
    <div class="daily-claim-panel" id="v2-claim-panel" hidden><div><span>ALL TASKS VERIFIED</span><strong>1,000,000 MATT is ready.</strong><p>Confirm the on-chain claim in Ronin Wallet.</p></div><button class="flip-button" id="v2-claim">CLAIM 1,000,000 MATT</button></div>
    <p class="mission-notice" id="v2-status" role="status">Verified rewards V2 is preparing.</p>
    <div class="mission-completion-feed"><div class="mission-feed-heading"><div><p class="eyebrow">RECENT COMPLETIONS</p><h3>Verified daily reward claims</h3></div><button class="secondary-button" id="v2-refresh">Refresh</button></div><div class="mission-completion-list" id="v2-feed"><p class="mission-feed-empty">No verified claims yet.</p></div></div>`;

  const cards = Object.fromEntries([...section.querySelectorAll('[data-v2]')].map(card => [card.dataset.v2, card]));
  const progress = document.getElementById('v2-progress');
  const next = document.getElementById('v2-next');
  const pool = document.getElementById('v2-pool');
  const status = document.getElementById('v2-status');
  const claimPanel = document.getElementById('v2-claim-panel');
  const claimButton = document.getElementById('v2-claim');
  const coinProgress = document.getElementById('coin-game-progress');
  let ethers;
  let iface;
  let chain = null;
  let xStatus = null;
  let busy = false;

  const account = () => window.MattRoninConnect?.account || null;
  const wallet = () => window.MattRoninConnect?.provider || null;
  const configured = () => ethers?.isAddress(config.contractAddress) && config.contractAddress.toLowerCase() !== ZERO;
  const key = owner => `mattRewardsV2:${config.contractAddress}:${owner}`;
  const load = owner => { try { return JSON.parse(localStorage.getItem(key(owner)) || '{}'); } catch { return {}; } };
  const save = (owner, data) => localStorage.setItem(key(owner), JSON.stringify(data));

  function setCard(name, done, open) {
    const card = cards[name];
    card.classList.toggle('completed', done);
    card.classList.toggle('locked', !done && !open);
    card.querySelector('.mission-status').textContent = done ? 'COMPLETE' : open ? 'OPEN' : 'LOCKED';
  }

  async function rpc(method, params = []) {
    const response = await fetch('/api/rpc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }) });
    const payload = await response.json();
    if (!response.ok || payload.error) throw new Error(payload.error?.message || 'RPC failed');
    return payload.result;
  }

  async function read(name, args = []) {
    const data = iface.encodeFunctionData(name, args);
    const raw = await rpc('eth_call', [{ to: config.contractAddress, data }, 'latest']);
    return iface.decodeFunctionResult(name, raw);
  }

  async function refresh() {
    const owner = account();
    try { xStatus = await fetch('/api/x/status', { credentials: 'same-origin' }).then(r => r.json()); } catch { xStatus = null; }
    if (owner && configured()) {
      const [lastClaimAt, lastBet, claims, paused] = await Promise.all([
        read('lastClaimAt', [owner]), read('lastUsedBetId', [owner]), read('availableClaims'), read('paused')
      ]);
      chain = { lastClaimAt: BigInt(lastClaimAt[0]), lastBet: BigInt(lastBet[0]), claims: BigInt(claims[0]), paused: Boolean(paused[0]) };
    } else chain = null;
    render();
  }

  function inspectFlip() {
    const owner = account();
    const match = coinProgress?.textContent.match(/Bet\s+#(\d+)\s+settled\s+on\s+Ronin/i);
    if (owner && match) {
      const state = load(owner);
      state.betId = match[1];
      save(owner, state);
    }
  }

  function render() {
    inspectFlip();
    const owner = account();
    const state = owner ? load(owner) : {};
    const now = Math.floor(Date.now() / 1000);
    const nextAt = chain?.lastClaimAt ? Number(chain.lastClaimAt) + 86400 : 0;
    const cooling = nextAt > now;
    const flipDone = Boolean(state.betId && (!chain || BigInt(state.betId) > chain.lastBet));
    const xDone = Boolean(xStatus?.connected && xStatus.wallet?.toLowerCase() === owner?.toLowerCase());
    const count = [Boolean(owner), flipDone, xDone].filter(Boolean).length;
    progress.textContent = `${count} / 3 COMPLETE`;
    pool.textContent = chain ? `${chain.claims} rewards available` : configured() ? 'Loading…' : 'V2 deployment pending';
    next.textContent = cooling ? new Date(nextAt * 1000).toLocaleString() : count === 3 ? 'Ready to claim' : `${3 - count} tasks remaining`;
    setCard('connect', Boolean(owner), true);
    setCard('flip', flipDone, Boolean(owner) && !cooling);
    setCard('x', xDone, Boolean(owner) && flipDone && !cooling);
    claimPanel.hidden = !(count === 3 && !cooling);
    claimButton.disabled = busy || !configured() || !chain || chain.paused || chain.claims === 0n;
    if (!configured()) status.textContent = 'Verified rewards V2 is built but not active until the new contract is deployed and configured.';
    else if (!xStatus?.enabled) status.textContent = 'X OAuth is not configured on Render yet.';
    else if (cooling) status.textContent = 'Reward already claimed. This wallet is inside the 24-hour cooldown.';
    else status.textContent = count === 3 ? 'All three tasks are verified. Claim is ready.' : 'Complete all three verified tasks.';
  }

  async function verifyX() {
    const owner = account();
    if (!owner) return window.MattRoninConnect?.connect();
    window.location.href = `/api/x/start?wallet=${encodeURIComponent(owner)}&return=${encodeURIComponent('/hub.html#daily-missions')}`;
  }

  async function claim() {
    const owner = account();
    const provider = wallet();
    const state = load(owner);
    if (!owner || !provider?.request || !state.betId || busy) return;
    busy = true; render();
    try {
      const latest = await fetch('/api/x/status', { credentials: 'same-origin' }).then(r => r.json());
      if (!latest.connected || latest.wallet?.toLowerCase() !== owner.toLowerCase()) throw new Error('Reconnect X verification for this wallet.');
      const message = `MATT X follow verification\nWallet: ${owner.toLowerCase()}\nBet: ${state.betId}\nNonce: ${latest.nonce}`;
      const signature = await provider.request({ method: 'personal_sign', params: [ethers.hexlify(ethers.toUtf8Bytes(message)), owner] });
      const proofResponse = await fetch('/api/x/proof', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ wallet: owner, betId: state.betId, signature }) });
      const proof = await proofResponse.json();
      if (!proofResponse.ok) throw new Error(proof.error || 'X follow verification failed');
      const data = iface.encodeFunctionData('claim', [BigInt(state.betId), proof.xUserHash, BigInt(proof.deadline), proof.proof]);
      status.textContent = 'X follow verified. Confirm the 1,000,000 MATT claim in Ronin Wallet.';
      await provider.request({ method: 'eth_sendTransaction', params: [{ from: owner, to: config.contractAddress, data, value: '0x0' }] });
      status.textContent = 'Claim submitted. Waiting for Ronin confirmation…';
      setTimeout(refresh, 5000);
    } catch (error) {
      status.textContent = String(error?.message || error).slice(0, 220);
    } finally { busy = false; render(); }
  }

  document.getElementById('v2-connect').addEventListener('click', () => window.MattRoninConnect?.connect());
  document.getElementById('v2-flip').addEventListener('click', () => document.getElementById('coin-flip')?.scrollIntoView({ behavior: 'smooth' }));
  document.getElementById('v2-x').addEventListener('click', verifyX);
  claimButton.addEventListener('click', claim);
  document.getElementById('v2-refresh').addEventListener('click', refresh);
  window.addEventListener('matt:wallet-connected', refresh);
  window.addEventListener('matt:wallet-disconnected', refresh);
  if (coinProgress) new MutationObserver(() => { inspectFlip(); render(); }).observe(coinProgress, { childList: true, subtree: true, characterData: true });

  import(ETHERS_URL).then(module => {
    ethers = module;
    iface = new ethers.Interface(ABI);
    refresh();
    setInterval(refresh, 15000);
  }).catch(error => { status.textContent = `Verified rewards failed to load: ${error.message}`; });
})();