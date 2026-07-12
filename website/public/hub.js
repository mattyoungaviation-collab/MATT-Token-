const MATT_ADDRESS = '0xa5450417BDCa0BDfB058ffE41205400FfDA1174d';
const RONIN_CHAIN_ID = '0x7e4';

const connectButton = document.getElementById('connect-wallet');
const walletStatus = document.getElementById('wallet-status');
const walletAddress = document.getElementById('wallet-address');
const mattBalance = document.getElementById('matt-balance');
const ronBalance = document.getElementById('ron-balance');
const holderLevel = document.getElementById('holder-level');

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
  const tokens = BigInt(balanceHex) / 10n ** 18n;
  if (tokens >= 100000000n) return 'Legendary Matt';
  if (tokens >= 10000000n) return 'Gold Matt';
  if (tokens >= 1000000n) return 'Certified Matt';
  if (tokens >= 100000n) return 'Big Matt';
  if (tokens > 0n) return 'MATT Holder';
  return 'Future Matt';
}

async function loadBalances(account) {
  const [ronHex, mattHex] = await Promise.all([
    window.ethereum.request({ method: 'eth_getBalance', params: [account, 'latest'] }),
    window.ethereum.request({
      method: 'eth_call',
      params: [{ to: MATT_ADDRESS, data: balanceCallData(account) }, 'latest']
    })
  ]);
  ronBalance.textContent = `${formatUnits(ronHex)} RON`;
  mattBalance.textContent = `${formatUnits(mattHex, 18, 2)} MATT`;
  holderLevel.textContent = getLevel(mattHex);
}

async function connectWallet() {
  if (!window.ethereum) {
    walletStatus.textContent = 'Ronin Wallet was not detected. Open this page in a browser with Ronin Wallet installed.';
    return;
  }
  try {
    const chainId = await window.ethereum.request({ method: 'eth_chainId' });
    if (chainId.toLowerCase() !== RONIN_CHAIN_ID) {
      await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: RONIN_CHAIN_ID }] });
    }
    const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
    const account = accounts[0];
    if (!account) throw new Error('No account returned');
    walletAddress.textContent = shortAddress(account);
    walletAddress.title = account;
    walletStatus.textContent = 'Ronin Wallet connected.';
    connectButton.textContent = shortAddress(account);
    await loadBalances(account);
  } catch (error) {
    walletStatus.textContent = error?.message || 'Wallet connection failed.';
  }
}

connectButton.addEventListener('click', connectWallet);

if (window.ethereum?.on) {
  window.ethereum.on('accountsChanged', accounts => {
    if (!accounts.length) location.reload();
    else {
      const account = accounts[0];
      walletAddress.textContent = shortAddress(account);
      walletAddress.title = account;
      connectButton.textContent = shortAddress(account);
      loadBalances(account).catch(() => {});
    }
  });
  window.ethereum.on('chainChanged', () => location.reload());
}

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
