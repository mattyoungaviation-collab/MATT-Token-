const MATT_ADDRESS = '0xa5450417BDCa0BDfB058ffE41205400FfDA1174d';
const RONIN_CHAIN_ID = 2020;
const RONIN_RPC_URL = 'https://api.roninchain.com/rpc';
const RONIN_EXPLORER_ADDRESS_URL = 'https://app.roninchain.com/explorer/address/';
const WALLETCONNECT_PROJECT_ID = '10907bb3eaa077bbb82e0559005400d7';
const WALLETCONNECT_MODULE_URL = 'https://esm.sh/@walletconnect/ethereum-provider@2?bundle';
const DAILY_MISSIONS = ['connect', 'flip', 'verify'];
const HOLDER_PAGE_SIZE = 50;

const connectButton = document.getElementById('connect-wallet');
const walletStatus = document.getElementById('wallet-status');
const walletAddress = document.getElementById('wallet-address');
const mattBalance = document.getElementById('matt-balance');
const ronBalance = document.getElementById('ron-balance');
const holderLevel = document.getElementById('holder-level');
const holderRank = document.getElementById('holder-rank');
const walletUpdated = document.getElementById('wallet-updated');
const refreshWalletButton = document.getElementById('refresh-wallet');

const missionProgress = document.getElementById('mission-progress');
const missionMeterFill = document.getElementById('mission-meter-fill');
const missionReset = document.getElementById('mission-reset');
const missionCards = [...document.querySelectorAll('.mission-card')];
const missionConnectButton = document.getElementById('mission-connect-button');
const missionFlipButton = document.getElementById('mission-flip-button');
const missionVerifyLink = document.getElementById('mission-verify-link');

const holderCount = document.getElementById('holder-count');
const holderTransferCount = document.getElementById('holder-transfer-count');
const holderIndexedBlock = document.getElementById('holder-indexed-block');
const connectedHolderCard = document.getElementById('connected-holder-card');
const connectedHolderTitle = document.getElementById('connected-holder-title');
const connectedHolderDetail = document.getElementById('connected-holder-detail');
const connectedHolderExplorer = document.getElementById('connected-holder-explorer');
const holderSearchInput = document.getElementById('holder-search-input');
const holderClearSearch = document.getElementById('holder-clear-search');
const refreshHoldersButton = document.getElementById('refresh-holders');
const holderStatus = document.getElementById('holder-status');
const holderTableBody = document.getElementById('holder-table-body');
const holderEmpty = document.getElementById('holder-empty');
const holderPageSummary = document.getElementById('holder-page-summary');
const loadMoreHoldersButton = document.getElementById('load-more-holders');

let walletConnectProvider = null;
let currentAccount = null;
let rpcRequestId = 0;
let lastMissionDate = localDateKey();
let holderOffset = 0;
let holderQuery = '';
let holderHasMore = false;
let holderReturned = 0;
let holderMatchingCount = 0;
let holderAbortController = null;
let holderSearchTimer = null;

function formatUnits(rawValue, decimals = 18, precision = 4) {
  const value = BigInt(rawValue);
  const divisor = 10n ** BigInt(decimals);
  const whole = value / divisor;
  const fraction = (value % divisor)
    .toString()
    .padStart(decimals, '0')
    .slice(0, precision)
    .replace(/0+$/, '');
  return fraction ? `${whole.toLocaleString()}.${fraction}` : whole.toLocaleString();
}

function shortAddress(address) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function balanceCallData(address) {
  return `0x70a08231${address.toLowerCase().replace('0x', '').padStart(64, '0')}`;
}

function getLevel(balanceRaw) {
  const rawBalance = BigInt(balanceRaw);
  const tokens = rawBalance / 10n ** 18n;
  if (tokens >= 100000000n) return 'Legendary Matt';
  if (tokens >= 10000000n) return 'Gold Matt';
  if (tokens >= 1000000n) return 'Certified Matt';
  if (tokens >= 100000n) return 'Big Matt';
  if (rawBalance > 0n) return 'MATT Holder';
  return 'Future Matt';
}

function normalizeChainId(chainId) {
  if (typeof chainId === 'number') return chainId;
  const value = String(chainId || '');
  if (value.startsWith('eip155:')) return Number(value.split(':')[1]);
  if (value.startsWith('0x')) return Number.parseInt(value, 16);
  return Number(value);
}

function localDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function emptyMissionState() {
  return { connect: false, flip: false, verify: false };
}

function missionStorageKey(account = currentAccount) {
  if (!account) return null;
  return `mattHubMissions:${localDateKey()}:${account.toLowerCase()}`;
}

function loadMissionState() {
  const key = missionStorageKey();
  if (!key) return emptyMissionState();

  try {
    const stored = JSON.parse(localStorage.getItem(key) || '{}');
    return {
      connect: stored.connect === true,
      flip: stored.flip === true,
      verify: stored.verify === true
    };
  } catch {
    return emptyMissionState();
  }
}

function saveMissionState(state) {
  const key = missionStorageKey();
  if (key) localStorage.setItem(key, JSON.stringify(state));
}

function renderMissions() {
  const connected = Boolean(currentAccount);
  const state = connected ? loadMissionState() : emptyMissionState();

  if (connected && !state.connect) {
    state.connect = true;
    saveMissionState(state);
  }

  const completedCount = DAILY_MISSIONS.filter(mission => state[mission]).length;
  missionProgress.textContent = `${completedCount} / ${DAILY_MISSIONS.length} COMPLETE`;
  missionMeterFill.style.width = `${(completedCount / DAILY_MISSIONS.length) * 100}%`;
  missionReset.textContent = connected
    ? `Progress for ${shortAddress(currentAccount)} · Resets at midnight on this device.`
    : 'Connect with WalletConnect to begin today’s missions.';

  for (const card of missionCards) {
    const mission = card.dataset.mission;
    const complete = Boolean(state[mission]);
    const status = card.querySelector('.mission-status');
    card.classList.toggle('completed', complete);
    card.classList.toggle('locked', !connected);
    status.textContent = complete ? 'COMPLETE' : connected ? 'OPEN' : 'LOCKED';
  }

  missionConnectButton.textContent = connected ? 'CONNECTED' : 'CONNECT';
  missionConnectButton.disabled = connected;
  missionFlipButton.textContent = state.flip ? 'FLIP AGAIN' : 'GO TO COIN';
  missionVerifyLink.textContent = state.verify ? 'VERIFIED' : 'VERIFY CONTRACT';
}

function markDailyMission(mission) {
  if (!currentAccount || !DAILY_MISSIONS.includes(mission)) return false;
  const state = loadMissionState();
  if (!state[mission]) {
    state[mission] = true;
    saveMissionState(state);
  }
  renderMissions();
  return true;
}

async function roninRpc(method, params) {
  const response = await fetch(RONIN_RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcRequestId, method, params })
  });
  if (!response.ok) throw new Error(`Ronin RPC returned ${response.status}`);
  const payload = await response.json();
  if (payload.error) throw new Error(payload.error.message || 'Ronin RPC request failed');
  return payload.result;
}

async function loadBalances(account) {
  refreshWalletButton.disabled = true;
  walletUpdated.textContent = 'Refreshing public wallet balances…';

  try {
    const [ronHex, mattHex] = await Promise.all([
      roninRpc('eth_getBalance', [account, 'latest']),
      roninRpc('eth_call', [{ to: MATT_ADDRESS, data: balanceCallData(account) }, 'latest'])
    ]);
    ronBalance.textContent = `${formatUnits(ronHex)} RON`;
    mattBalance.textContent = `${formatUnits(mattHex, 18, 2)} MATT`;
    holderLevel.textContent = getLevel(mattHex);
    walletUpdated.textContent = `Wallet balances updated ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`;
    walletStatus.classList.remove('error');
  } catch (error) {
    ronBalance.textContent = 'Unavailable';
    mattBalance.textContent = 'Unavailable';
    holderLevel.textContent = 'Balance unavailable';
    walletStatus.textContent = `WalletConnect is connected, but balances could not load: ${error?.message || 'unknown error'}`;
    walletStatus.classList.add('error');
    walletUpdated.textContent = 'Balance refresh failed. Try again shortly.';
  } finally {
    refreshWalletButton.disabled = !currentAccount;
  }
}

function resetConnectedHolder() {
  holderRank.textContent = currentAccount ? 'Loading…' : 'Connect wallet';
  connectedHolderCard.hidden = true;
  connectedHolderTitle.textContent = 'Your holder position';
  connectedHolderDetail.textContent = 'Loading your public rank.';
  connectedHolderExplorer.href = '#';
}

function resetWalletDisplay(message = 'Wallet not connected.') {
  currentAccount = null;
  walletAddress.textContent = 'Not connected';
  walletAddress.removeAttribute('title');
  mattBalance.textContent = '—';
  ronBalance.textContent = '—';
  holderLevel.textContent = 'Connect wallet';
  walletStatus.textContent = message;
  walletStatus.classList.remove('error');
  walletUpdated.textContent = 'Connect to load wallet data.';
  connectButton.textContent = 'Connect WalletConnect';
  connectButton.disabled = false;
  connectButton.removeAttribute('aria-busy');
  refreshWalletButton.disabled = true;
  resetConnectedHolder();
  renderMissions();
  highlightConnectedHolderRows();
}

async function showConnectedAccount(account) {
  currentAccount = account.toLowerCase();
  walletAddress.textContent = shortAddress(currentAccount);
  walletAddress.title = currentAccount;
  walletStatus.textContent = 'WalletConnect connected to Ronin Mainnet.';
  walletStatus.classList.remove('error');
  connectButton.textContent = 'Disconnect';
  connectButton.disabled = false;
  connectButton.removeAttribute('aria-busy');
  refreshWalletButton.disabled = false;
  markDailyMission('connect');
  resetConnectedHolder();
  highlightConnectedHolderRows();
  await Promise.all([loadBalances(currentAccount), loadConnectedHolderRank(currentAccount)]);
}

function accountFromSession() {
  const namespaces = walletConnectProvider?.session?.namespaces || {};
  const sessionAccounts = Object.values(namespaces).flatMap(namespace => namespace?.accounts || []);
  const roninAccount = sessionAccounts.find(account => account.toLowerCase().startsWith(`eip155:${RONIN_CHAIN_ID}:`));
  return roninAccount ? roninAccount.split(':').pop() : null;
}

async function findConnectedAccount(accounts = []) {
  const sessionAccount = accountFromSession();
  if (sessionAccount) return sessionAccount;

  for (const supplied of accounts) {
    const candidate = String(supplied).includes(':') ? String(supplied).split(':').pop() : String(supplied);
    if (/^0x[a-fA-F0-9]{40}$/.test(candidate)) return candidate;
  }

  for (const supplied of walletConnectProvider?.accounts || []) {
    const candidate = String(supplied).includes(':') ? String(supplied).split(':').pop() : String(supplied);
    if (/^0x[a-fA-F0-9]{40}$/.test(candidate)) return candidate;
  }

  try {
    const providerAccounts = await walletConnectProvider.request({ method: 'eth_accounts' });
    return providerAccounts?.find(account => /^0x[a-fA-F0-9]{40}$/.test(account)) || null;
  } catch {
    return null;
  }
}

function bindWalletConnectEvents() {
  walletConnectProvider.on('accountsChanged', async accounts => {
    const account = await findConnectedAccount(accounts || []);
    if (account) await showConnectedAccount(account);
    else resetWalletDisplay('WalletConnect session has no Ronin account.');
  });

  walletConnectProvider.on('chainChanged', async chainId => {
    if (normalizeChainId(chainId) !== RONIN_CHAIN_ID) {
      walletStatus.textContent = 'WalletConnect is connected, but Ronin Mainnet is not active in the wallet.';
      walletStatus.classList.add('error');
      return;
    }
    walletStatus.classList.remove('error');
    if (currentAccount) await loadBalances(currentAccount);
  });

  walletConnectProvider.on('disconnect', () => resetWalletDisplay('WalletConnect disconnected.'));
}

async function initializeWalletConnect() {
  connectButton.disabled = true;
  connectButton.setAttribute('aria-busy', 'true');
  connectButton.textContent = 'Loading WalletConnect…';
  walletStatus.textContent = 'Preparing WalletConnect.';

  try {
    const walletConnectModule = await import(WALLETCONNECT_MODULE_URL);
    const EthereumProvider = walletConnectModule.EthereumProvider || walletConnectModule.default;
    if (!EthereumProvider?.init) throw new Error('WalletConnect provider did not load');

    walletConnectProvider = await EthereumProvider.init({
      projectId: WALLETCONNECT_PROJECT_ID,
      metadata: {
        name: 'MATT Hub',
        description: 'Connect to MATT Hub on Ronin Mainnet.',
        url: window.location.origin,
        icons: [`${window.location.origin}/assets/matt-logo-512.png`]
      },
      showQrModal: true,
      optionalChains: [RONIN_CHAIN_ID],
      optionalMethods: ['eth_accounts', 'eth_requestAccounts', 'wallet_switchEthereumChain'],
      optionalEvents: ['accountsChanged', 'chainChanged', 'disconnect', 'connect'],
      rpcMap: { [RONIN_CHAIN_ID]: RONIN_RPC_URL },
      qrModalOptions: { themeMode: 'dark' }
    });

    bindWalletConnectEvents();

    if (walletConnectProvider.session) {
      const account = await findConnectedAccount();
      if (account) {
        await showConnectedAccount(account);
        return;
      }
    }

    resetWalletDisplay();
  } catch (error) {
    walletConnectProvider = null;
    resetWalletDisplay(`WalletConnect failed to load: ${error?.message || 'unknown error'}`);
    walletStatus.classList.add('error');
    connectButton.textContent = 'Retry WalletConnect';
  }
}

async function connectWallet() {
  if (!walletConnectProvider) {
    await initializeWalletConnect();
    if (!walletConnectProvider) return;
  }

  connectButton.disabled = true;
  connectButton.setAttribute('aria-busy', 'true');
  connectButton.textContent = 'Opening WalletConnect…';
  walletStatus.textContent = 'Choose a wallet or scan the WalletConnect QR code.';
  walletStatus.classList.remove('error');

  try {
    await walletConnectProvider.connect();
    const account = await findConnectedAccount();
    if (!account) throw new Error('The wallet did not approve a Ronin Mainnet account');
    await showConnectedAccount(account);
  } catch (error) {
    resetWalletDisplay(error?.message || 'WalletConnect connection failed.');
  }
}

async function disconnectWallet() {
  connectButton.disabled = true;
  connectButton.setAttribute('aria-busy', 'true');
  connectButton.textContent = 'Disconnecting…';
  try {
    await walletConnectProvider?.disconnect();
    resetWalletDisplay('WalletConnect disconnected.');
  } catch (error) {
    connectButton.disabled = false;
    connectButton.removeAttribute('aria-busy');
    connectButton.textContent = 'Disconnect';
    walletStatus.textContent = error?.message || 'WalletConnect could not disconnect.';
    walletStatus.classList.add('error');
  }
}

function holderAvatarText(address) {
  return address.slice(2, 4).toUpperCase();
}

function makeCell(className = '') {
  const cell = document.createElement('td');
  if (className) cell.className = className;
  return cell;
}

function renderHolderRow(holder) {
  const row = document.createElement('tr');
  row.dataset.address = holder.address.toLowerCase();
  if (currentAccount && row.dataset.address === currentAccount.toLowerCase()) row.classList.add('is-you');

  const rankCell = makeCell('holder-rank-cell');
  rankCell.textContent = `#${Number(holder.rank).toLocaleString()}`;

  const holderCell = makeCell();
  const addressLink = document.createElement('a');
  addressLink.className = 'holder-address-link';
  addressLink.href = `${RONIN_EXPLORER_ADDRESS_URL}${holder.address}`;
  addressLink.target = '_blank';
  addressLink.rel = 'noopener';
  addressLink.title = holder.address;

  const avatar = document.createElement('span');
  avatar.className = 'holder-dot';
  avatar.textContent = holderAvatarText(holder.address);

  const identity = document.createElement('span');
  const addressText = document.createElement('span');
  addressText.textContent = shortAddress(holder.address);
  identity.append(addressText);

  const label = document.createElement('span');
  label.className = 'holder-label';
  label.textContent = holder.label || (currentAccount && holder.address.toLowerCase() === currentAccount.toLowerCase() ? 'Your connected wallet' : 'Public Ronin address');
  identity.append(label);

  addressLink.append(avatar, identity);
  holderCell.append(addressLink);

  const levelCell = makeCell();
  const level = document.createElement('span');
  level.className = 'holder-level-pill';
  level.textContent = holder.level;
  levelCell.append(level);

  const balanceCell = makeCell('numeric');
  balanceCell.textContent = `${formatUnits(holder.balanceRaw, 18, 2)} MATT`;

  const shareCell = makeCell('numeric');
  shareCell.textContent = `${holder.sharePercent}%`;

  row.append(rankCell, holderCell, levelCell, balanceCell, shareCell);
  return row;
}

function updateHolderSummary(payload) {
  holderCount.textContent = Number(payload.summary.holderCount).toLocaleString();
  holderTransferCount.textContent = Number(payload.summary.transferCount).toLocaleString();
  holderIndexedBlock.textContent = Number(payload.summary.indexedBlock).toLocaleString();
  holderMatchingCount = Number(payload.summary.matchingCount);
}

function updateHolderPagination() {
  const shown = holderReturned;
  holderPageSummary.textContent = holderQuery
    ? `Showing ${shown.toLocaleString()} of ${holderMatchingCount.toLocaleString()} matches.`
    : `Showing ${shown.toLocaleString()} of ${holderMatchingCount.toLocaleString()} positive balances.`;
  loadMoreHoldersButton.hidden = !holderHasMore;
  loadMoreHoldersButton.disabled = false;
}

async function loadHolders({ reset = true } = {}) {
  if (holderAbortController) holderAbortController.abort();
  holderAbortController = new AbortController();

  if (reset) {
    holderOffset = 0;
    holderReturned = 0;
    holderTableBody.replaceChildren();
  }

  refreshHoldersButton.disabled = true;
  loadMoreHoldersButton.disabled = true;
  holderEmpty.hidden = true;
  holderStatus.classList.remove('error');
  holderStatus.textContent = reset
    ? 'Loading the public holder directory. The first index after a deployment may take a moment.'
    : 'Loading more holders…';

  try {
    const params = new URLSearchParams({
      limit: String(HOLDER_PAGE_SIZE),
      offset: String(holderOffset)
    });
    if (holderQuery) params.set('q', holderQuery);

    const response = await fetch(`/api/holders?${params}`, {
      cache: 'no-store',
      signal: holderAbortController.signal
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.message || `Holder API returned ${response.status}`);

    updateHolderSummary(payload);
    for (const holder of payload.holders) holderTableBody.append(renderHolderRow(holder));

    holderReturned += payload.holders.length;
    holderOffset += payload.holders.length;
    holderHasMore = Boolean(payload.pagination.hasMore);
    holderEmpty.hidden = holderReturned !== 0;
    holderStatus.textContent = `Directory updated ${new Date(payload.summary.updatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} through Ronin block ${Number(payload.summary.indexedBlock).toLocaleString()}.`;
    updateHolderPagination();
  } catch (error) {
    if (error?.name === 'AbortError') return;
    holderStatus.textContent = `${error?.message || 'The holder directory could not load.'} Try again shortly.`;
    holderStatus.classList.add('error');
    if (holderReturned === 0) holderEmpty.hidden = false;
    holderPageSummary.textContent = 'Directory unavailable.';
  } finally {
    refreshHoldersButton.disabled = false;
    loadMoreHoldersButton.disabled = false;
  }
}

async function loadConnectedHolderRank(account) {
  const expectedAccount = account.toLowerCase();
  connectedHolderCard.hidden = false;
  connectedHolderExplorer.href = `${RONIN_EXPLORER_ADDRESS_URL}${expectedAccount}`;
  connectedHolderTitle.textContent = `${shortAddress(expectedAccount)} in the MATT directory`;
  connectedHolderDetail.textContent = 'Loading your public balance and rank…';
  holderRank.textContent = 'Loading…';

  try {
    const params = new URLSearchParams({ limit: '10', offset: '0', q: expectedAccount });
    const response = await fetch(`/api/holders?${params}`, { cache: 'no-store' });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.message || 'Rank lookup failed');
    if (currentAccount?.toLowerCase() !== expectedAccount) return;

    const exact = payload.holders.find(holder => holder.address.toLowerCase() === expectedAccount);
    if (!exact) {
      holderRank.textContent = 'Unranked';
      connectedHolderTitle.textContent = 'No positive MATT balance indexed';
      connectedHolderDetail.textContent = 'This connected address does not currently appear among positive MATT balances.';
      return;
    }

    holderRank.textContent = `#${Number(exact.rank).toLocaleString()}`;
    connectedHolderTitle.textContent = `You are MATT holder #${Number(exact.rank).toLocaleString()}`;
    connectedHolderDetail.textContent = `${formatUnits(exact.balanceRaw, 18, 2)} MATT · ${exact.level} · ${exact.sharePercent}% of fixed supply.`;
  } catch (error) {
    if (currentAccount?.toLowerCase() !== expectedAccount) return;
    holderRank.textContent = 'Unavailable';
    connectedHolderTitle.textContent = 'Your rank is temporarily unavailable';
    connectedHolderDetail.textContent = error?.message || 'The directory could not complete the rank lookup.';
  }
}

function highlightConnectedHolderRows() {
  for (const row of holderTableBody.querySelectorAll('tr[data-address]')) {
    row.classList.toggle('is-you', Boolean(currentAccount) && row.dataset.address === currentAccount.toLowerCase());
  }
}

connectButton.addEventListener('click', () => {
  if (currentAccount) disconnectWallet();
  else connectWallet();
});

refreshWalletButton.addEventListener('click', () => {
  if (currentAccount) Promise.all([loadBalances(currentAccount), loadConnectedHolderRank(currentAccount)]);
});

missionConnectButton.addEventListener('click', () => {
  if (!currentAccount) connectWallet();
});

missionFlipButton.addEventListener('click', () => {
  document.getElementById('coin-flip').scrollIntoView({ behavior: 'smooth' });
});

missionVerifyLink.addEventListener('click', () => {
  if (!markDailyMission('verify')) missionReset.textContent = 'Connect with WalletConnect before completing daily missions.';
});

refreshHoldersButton.addEventListener('click', () => loadHolders({ reset: true }));
loadMoreHoldersButton.addEventListener('click', () => loadHolders({ reset: false }));

holderSearchInput.addEventListener('input', () => {
  holderQuery = holderSearchInput.value.trim();
  holderClearSearch.hidden = !holderQuery;
  clearTimeout(holderSearchTimer);
  holderSearchTimer = setTimeout(() => loadHolders({ reset: true }), 350);
});

holderClearSearch.addEventListener('click', () => {
  holderSearchInput.value = '';
  holderQuery = '';
  holderClearSearch.hidden = true;
  holderSearchInput.focus();
  loadHolders({ reset: true });
});

let choice = 'heads';
let flips = Number(localStorage.getItem('mattHubFlips') || 0);
let wins = Number(localStorage.getItem('mattHubWins') || 0);
let streak = Number(localStorage.getItem('mattHubStreak') || 0);
let bestStreak = Number(localStorage.getItem('mattHubBestStreak') || 0);

const coin = document.getElementById('coin');
const flipButton = document.getElementById('flip-button');
const flipResult = document.getElementById('flip-result');
const flipCount = document.getElementById('flip-count');
const winCount = document.getElementById('win-count');
const bestStreakDisplay = document.getElementById('best-streak');

function updateStats() {
  flipCount.textContent = flips;
  winCount.textContent = wins;
  bestStreakDisplay.textContent = bestStreak;
  localStorage.setItem('mattHubFlips', flips);
  localStorage.setItem('mattHubWins', wins);
  localStorage.setItem('mattHubStreak', streak);
  localStorage.setItem('mattHubBestStreak', bestStreak);
}

for (const button of document.querySelectorAll('.choice')) {
  button.addEventListener('click', () => {
    document.querySelectorAll('.choice').forEach(item => {
      const active = item === button;
      item.classList.toggle('active', active);
      item.setAttribute('aria-pressed', String(active));
    });
    choice = button.dataset.choice;
  });
}

flipButton.addEventListener('click', () => {
  if (flipButton.disabled) return;
  flipButton.disabled = true;
  flipResult.className = 'result';
  flipResult.textContent = 'Flipping…';
  coin.classList.remove('flipping');
  void coin.offsetWidth;
  coin.classList.add('flipping');

  const outcome = crypto.getRandomValues(new Uint32Array(1))[0] % 2 === 0 ? 'heads' : 'tails';
  setTimeout(() => {
    flips += 1;
    const won = choice === outcome;
    if (won) {
      wins += 1;
      streak += 1;
      bestStreak = Math.max(bestStreak, streak);
      flipResult.className = 'result win';
      flipResult.textContent = `${outcome.toUpperCase()} — YOU CALLED IT, MATT.`;
    } else {
      streak = 0;
      flipResult.textContent = `${outcome.toUpperCase()} — the coin has spoken.`;
    }
    coin.querySelector('.coin-face').textContent = outcome === 'heads' ? 'M' : 'T';
    updateStats();
    markDailyMission('flip');
    flipButton.disabled = false;
  }, 850);
});

setInterval(() => {
  const today = localDateKey();
  if (today !== lastMissionDate) {
    lastMissionDate = today;
    renderMissions();
  }
}, 60_000);

updateStats();
renderMissions();
loadHolders({ reset: true });
initializeWalletConnect();
