const MATT_ADDRESS = '0xa5450417BDCa0BDfB058ffE41205400FfDA1174d';
const RONIN_CHAIN_ID = 2020;
const RONIN_RPC_URL = 'https://api.roninchain.com/rpc';
const WALLETCONNECT_PROJECT_ID = '10907bb3eaa077bbb82e0559005400d7';
const WALLETCONNECT_MODULE_URL = 'https://esm.sh/@walletconnect/ethereum-provider@2?bundle';

const connectButton = document.getElementById('connect-wallet');
const walletStatus = document.getElementById('wallet-status');
const walletAddress = document.getElementById('wallet-address');
const mattBalance = document.getElementById('matt-balance');
const ronBalance = document.getElementById('ron-balance');
const holderLevel = document.getElementById('holder-level');

let walletConnectProvider = null;
let currentAccount = null;
let rpcRequestId = 0;

function formatUnits(hexValue, decimals = 18, precision = 4) {
  const value = BigInt(hexValue);
  const divisor = 10n ** BigInt(decimals);
  const whole = value / divisor;
  const fraction = (value % divisor).toString().padStart(decimals, '0').slice(0, precision).replace(/0+$/, '');
  return fraction ? `${whole.toLocaleString()}.${fraction}` : whole.toLocaleString();
}

function shortAddress(address) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function balanceCallData(address) {
  return `0x70a08231${address.toLowerCase().replace('0x', '').padStart(64, '0')}`;
}

function getLevel(balanceHex) {
  const rawBalance = BigInt(balanceHex);
  const tokens = rawBalance / 10n ** 18n;
  if (tokens >= 100000000n) return 'Legendary Matt';
  if (tokens >= 10000000n) return 'Gold Matt';
  if (tokens >= 1000000n) return 'Certified Matt';
  if (tokens >= 100000n) return 'Big Matt';
  if (rawBalance > 0n) return 'MATT Holder';
  return 'Future Matt';
}

async function roninRpc(method, params) {
  const response = await fetch(RONIN_RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: ++rpcRequestId,
      method,
      params
    })
  });

  if (!response.ok) throw new Error(`Ronin RPC returned ${response.status}`);
  const payload = await response.json();
  if (payload.error) throw new Error(payload.error.message || 'Ronin RPC request failed');
  return payload.result;
}

async function loadBalances(account) {
  try {
    const [ronHex, mattHex] = await Promise.all([
      roninRpc('eth_getBalance', [account, 'latest']),
      roninRpc('eth_call', [{ to: MATT_ADDRESS, data: balanceCallData(account) }, 'latest'])
    ]);
    ronBalance.textContent = `${formatUnits(ronHex)} RON`;
    mattBalance.textContent = `${formatUnits(mattHex, 18, 2)} MATT`;
    holderLevel.textContent = getLevel(mattHex);
  } catch (error) {
    ronBalance.textContent = 'Unavailable';
    mattBalance.textContent = 'Unavailable';
    holderLevel.textContent = 'Balance unavailable';
    walletStatus.textContent = `WalletConnect is connected, but balances could not load: ${error?.message || 'unknown error'}`;
  }
}

function resetWalletDisplay(message = 'Wallet not connected.') {
  currentAccount = null;
  walletAddress.textContent = 'Not connected';
  walletAddress.removeAttribute('title');
  mattBalance.textContent = '—';
  ronBalance.textContent = '—';
  holderLevel.textContent = 'Connect wallet';
  walletStatus.textContent = message;
  connectButton.textContent = 'Connect with WalletConnect';
  connectButton.disabled = false;
}

async function showConnectedAccount(account) {
  currentAccount = account;
  walletAddress.textContent = shortAddress(account);
  walletAddress.title = account;
  walletStatus.textContent = 'WalletConnect connected to Ronin Mainnet.';
  connectButton.textContent = 'Disconnect WalletConnect';
  connectButton.disabled = false;
  await loadBalances(account);
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

  const suppliedAccount = accounts.find(account => /^0x[a-fA-F0-9]{40}$/.test(account));
  if (suppliedAccount) return suppliedAccount;

  const providerAccount = walletConnectProvider?.accounts?.find(account => /^0x[a-fA-F0-9]{40}$/.test(account));
  if (providerAccount) return providerAccount;

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
    const parsedChainId = typeof chainId === 'string' ? Number.parseInt(chainId, 16) : Number(chainId);
    if (parsedChainId !== RONIN_CHAIN_ID) {
      walletStatus.textContent = 'WalletConnect is connected, but Ronin Mainnet is not active in the wallet.';
      return;
    }
    if (currentAccount) await loadBalances(currentAccount);
  });

  walletConnectProvider.on('disconnect', () => {
    resetWalletDisplay('WalletConnect disconnected.');
  });
}

async function initializeWalletConnect() {
  connectButton.disabled = true;
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
      rpcMap: {
        [RONIN_CHAIN_ID]: RONIN_RPC_URL
      },
      qrModalOptions: {
        themeMode: 'dark'
      }
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
    connectButton.textContent = 'Retry WalletConnect';
  }
}

async function connectWallet() {
  if (!walletConnectProvider) {
    await initializeWalletConnect();
    if (!walletConnectProvider) return;
  }

  connectButton.disabled = true;
  connectButton.textContent = 'Opening WalletConnect…';
  walletStatus.textContent = 'Choose a wallet or scan the WalletConnect QR code.';

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
  connectButton.textContent = 'Disconnecting…';
  try {
    await walletConnectProvider?.disconnect();
    resetWalletDisplay('WalletConnect disconnected.');
  } catch (error) {
    connectButton.disabled = false;
    connectButton.textContent = 'Disconnect WalletConnect';
    walletStatus.textContent = error?.message || 'WalletConnect could not disconnect.';
  }
}

connectButton.addEventListener('click', () => {
  if (currentAccount) disconnectWallet();
  else connectWallet();
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
    document.querySelectorAll('.choice').forEach(item => item.classList.remove('active'));
    button.classList.add('active');
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
    flipButton.disabled = false;
  }, 850);
});

updateStats();
initializeWalletConnect();
