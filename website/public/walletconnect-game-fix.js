(() => {
  'use strict';

  const CONNECTOR_KEY = 'mattHubConnector';
  const SESSION_KEY = 'mattHubRoninSession';
  const AUTO_CONNECT_KEY = 'mattHubAutoConnect';
  const SESSION_VERSION = 1;
  const RONIN_CHAIN_HEX = `0x${Number(RONIN_CHAIN_ID).toString(16)}`;
  const REQUIRED_TRANSACTION_METHOD = 'eth_sendTransaction';
  const WALLETCONNECT_METHODS = [
    'eth_accounts',
    'eth_requestAccounts',
    REQUIRED_TRANSACTION_METHOD,
    'wallet_switchEthereumChain'
  ];
  const WALLETCONNECT_EVENTS = ['accountsChanged', 'chainChanged', 'disconnect', 'connect'];

  let nativeRoninProvider = null;
  let walletConnectFallback = null;
  let activeConnector = null;
  let nativeEventsBound = false;
  let fallbackEventsBound = false;
  let bootstrapping = false;

  function validAddress(value) {
    return /^0x[a-fA-F0-9]{40}$/.test(String(value || ''));
  }

  function normalizeAccount(value) {
    const candidate = String(value || '').includes(':') ? String(value).split(':').pop() : String(value || '');
    return validAddress(candidate) ? candidate.toLowerCase() : null;
  }

  function readJson(key) {
    try {
      return JSON.parse(localStorage.getItem(key) || 'null');
    } catch {
      return null;
    }
  }

  function saveSession(connector, account) {
    activeConnector = connector;
    localStorage.setItem(CONNECTOR_KEY, connector);
    localStorage.setItem(AUTO_CONNECT_KEY, 'true');
    localStorage.setItem(SESSION_KEY, JSON.stringify({
      version: SESSION_VERSION,
      connector,
      account: account.toLowerCase(),
      chainId: Number(RONIN_CHAIN_ID),
      updatedAt: new Date().toISOString()
    }));
  }

  function clearSession({ disableAutoConnect = true } = {}) {
    activeConnector = null;
    localStorage.removeItem(CONNECTOR_KEY);
    localStorage.removeItem(SESSION_KEY);
    if (disableAutoConnect) localStorage.setItem(AUTO_CONNECT_KEY, 'false');
  }

  function wantsAutoConnect() {
    return localStorage.getItem(AUTO_CONNECT_KEY) !== 'false';
  }

  function rememberedConnector() {
    const session = readJson(SESSION_KEY);
    if (session?.version === SESSION_VERSION && ['ronin', 'walletconnect'].includes(session.connector)) {
      return session.connector;
    }
    const stored = localStorage.getItem(CONNECTOR_KEY);
    return ['ronin', 'walletconnect'].includes(stored) ? stored : null;
  }

  function providerLooksLikeRonin(provider, info = {}) {
    if (!provider?.request) return false;
    const text = `${info.name || ''} ${info.rdns || ''} ${info.uuid || ''}`.toLowerCase();
    return Boolean(
      provider.isRonin ||
      provider.isRoninWallet ||
      /(^|[.\s_-])ronin([.\s_-]|$)/i.test(text)
    );
  }

  async function detectNativeRoninProvider() {
    const announced = [];
    const onAnnounce = event => {
      const detail = event?.detail || {};
      if (providerLooksLikeRonin(detail.provider, detail.info)) announced.push(detail.provider);
    };

    window.addEventListener('eip6963:announceProvider', onAnnounce);
    window.dispatchEvent(new Event('eip6963:requestProvider'));
    await new Promise(resolve => setTimeout(resolve, 650));
    window.removeEventListener('eip6963:announceProvider', onAnnounce);

    const legacyCandidates = [
      window.ronin?.provider,
      window.ronin,
      ...(Array.isArray(window.ethereum?.providers) ? window.ethereum.providers : []),
      window.ethereum
    ];

    return [...announced, ...legacyCandidates].find(provider => providerLooksLikeRonin(provider)) || null;
  }

  async function ensureRoninChain(provider) {
    let chainId = null;
    try {
      chainId = normalizeChainId(await provider.request({ method: 'eth_chainId' }));
    } catch {
      // A provider may not expose the chain until account access is granted.
    }
    if (chainId === Number(RONIN_CHAIN_ID)) return;

    try {
      await provider.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: RONIN_CHAIN_HEX }]
      });
    } catch (error) {
      if (Number(error?.code) !== 4902) throw error;
      await provider.request({
        method: 'wallet_addEthereumChain',
        params: [{
          chainId: RONIN_CHAIN_HEX,
          chainName: 'Ronin Mainnet',
          nativeCurrency: { name: 'RON', symbol: 'RON', decimals: 18 },
          rpcUrls: [RONIN_RPC_URL],
          blockExplorerUrls: ['https://explorer.roninchain.com']
        }]
      });
    }
  }

  async function accountsFromProvider(provider, requestAccess = false) {
    if (!provider?.request) return [];
    const method = requestAccess ? 'eth_requestAccounts' : 'eth_accounts';
    const accounts = await provider.request({ method });
    return (accounts || []).map(normalizeAccount).filter(Boolean);
  }

  function setDisconnectedDisplay(message) {
    resetWalletDisplay(message);
    connectButton.textContent = nativeRoninProvider ? 'Connect Ronin Wallet' : 'Connect Ronin';
    missionReset.textContent = 'Connect a Ronin wallet to begin today’s missions.';
  }

  async function showSignedIn(account, connector) {
    saveSession(connector, account);
    await showConnectedAccount(account);
    const connectorName = connector === 'ronin' ? 'Ronin Wallet' : 'WalletConnect';
    walletStatus.textContent = `Signed in with ${connectorName} on Ronin Mainnet. This session restores automatically.`;
    connectButton.textContent = 'Disconnect';
    missionReset.textContent = `Progress for ${shortAddress(account)} · Wallet session is remembered on this browser.`;
    window.dispatchEvent(new CustomEvent('matt:wallet-connected', {
      detail: { account: account.toLowerCase(), connector }
    }));
  }

  function bindNativeEvents(provider) {
    if (!provider?.on || nativeEventsBound) return;
    nativeEventsBound = true;

    provider.on('accountsChanged', async accounts => {
      const account = (accounts || []).map(normalizeAccount).find(Boolean);
      if (account) await showSignedIn(account, 'ronin');
      else {
        clearSession();
        currentAccount = null;
        setDisconnectedDisplay('Ronin Wallet account access was removed.');
      }
    });

    provider.on('chainChanged', async chainId => {
      if (normalizeChainId(chainId) !== Number(RONIN_CHAIN_ID)) {
        walletStatus.textContent = 'Ronin Wallet is connected, but Ronin Mainnet is not active.';
        walletStatus.classList.add('error');
        return;
      }
      walletStatus.classList.remove('error');
      if (currentAccount) await loadBalances(currentAccount);
    });

    provider.on('disconnect', () => {
      clearSession();
      currentAccount = null;
      setDisconnectedDisplay('Ronin Wallet disconnected.');
    });
  }

  function approvedMethods(provider) {
    const namespaces = provider?.session?.namespaces || {};
    return new Set(Object.values(namespaces).flatMap(namespace => namespace?.methods || []));
  }

  function walletConnectCanBet(provider) {
    return !provider?.session || approvedMethods(provider).has(REQUIRED_TRANSACTION_METHOD);
  }

  function bindFallbackEvents(provider) {
    if (!provider?.on || fallbackEventsBound) return;
    fallbackEventsBound = true;

    provider.on('accountsChanged', async accounts => {
      const account = (accounts || []).map(normalizeAccount).find(Boolean) || await findConnectedAccount(accounts || []);
      if (account) await showSignedIn(account, 'walletconnect');
      else {
        clearSession();
        currentAccount = null;
        setDisconnectedDisplay('WalletConnect session has no Ronin account.');
      }
    });

    provider.on('chainChanged', async chainId => {
      if (normalizeChainId(chainId) !== Number(RONIN_CHAIN_ID)) {
        walletStatus.textContent = 'WalletConnect is connected, but Ronin Mainnet is not active.';
        walletStatus.classList.add('error');
        return;
      }
      walletStatus.classList.remove('error');
      if (currentAccount) await loadBalances(currentAccount);
    });

    provider.on('disconnect', () => {
      clearSession();
      currentAccount = null;
      setDisconnectedDisplay('WalletConnect disconnected.');
    });
  }

  async function getWalletConnectProvider() {
    if (walletConnectFallback) return walletConnectFallback;

    const module = await import(WALLETCONNECT_MODULE_URL);
    const EthereumProvider = module.EthereumProvider || module.default;
    if (!EthereumProvider?.init) throw new Error('WalletConnect provider did not load');

    walletConnectFallback = await EthereumProvider.init({
      projectId: WALLETCONNECT_PROJECT_ID,
      metadata: {
        name: 'MATT Hub',
        description: 'Sign in and place MATT coin-flip bets on Ronin Mainnet.',
        url: window.location.origin,
        icons: [`${window.location.origin}/assets/matt-logo-512.png`]
      },
      showQrModal: true,
      optionalChains: [Number(RONIN_CHAIN_ID)],
      optionalMethods: WALLETCONNECT_METHODS,
      optionalEvents: WALLETCONNECT_EVENTS,
      rpcMap: { [Number(RONIN_CHAIN_ID)]: RONIN_RPC_URL },
      qrModalOptions: { themeMode: 'dark' }
    });

    walletConnectFallback.__mattConnector = 'walletconnect';
    bindFallbackEvents(walletConnectFallback);
    return walletConnectFallback;
  }

  async function restoreNativeSession() {
    if (!nativeRoninProvider || !wantsAutoConnect()) return false;
    const accounts = await accountsFromProvider(nativeRoninProvider, false).catch(() => []);
    const account = accounts[0];
    if (!account) return false;
    await ensureRoninChain(nativeRoninProvider).catch(() => {});
    walletConnectProvider = nativeRoninProvider;
    await showSignedIn(account, 'ronin');
    return true;
  }

  async function restoreWalletConnectSession() {
    if (!wantsAutoConnect()) return false;
    const provider = await getWalletConnectProvider();
    if (!provider.session || !walletConnectCanBet(provider)) return false;
    walletConnectProvider = provider;
    const account = await findConnectedAccount();
    if (!account) return false;
    await showSignedIn(account, 'walletconnect');
    return true;
  }

  async function initializeRoninConnection() {
    if (bootstrapping) return;
    bootstrapping = true;
    connectButton.disabled = true;
    connectButton.setAttribute('aria-busy', 'true');
    connectButton.textContent = 'Restoring Ronin session…';
    walletStatus.textContent = 'Checking for a remembered Ronin wallet session.';
    walletStatus.classList.remove('error');

    try {
      nativeRoninProvider = await detectNativeRoninProvider();
      if (nativeRoninProvider) {
        nativeRoninProvider.__mattConnector = 'ronin';
        bindNativeEvents(nativeRoninProvider);
      }

      const preferred = rememberedConnector();
      let restored = false;
      if (preferred === 'walletconnect') restored = await restoreWalletConnectSession();
      if (!restored && nativeRoninProvider) restored = await restoreNativeSession();
      if (!restored && preferred !== 'ronin') restored = await restoreWalletConnectSession();

      if (!restored) {
        walletConnectProvider = nativeRoninProvider || walletConnectFallback || null;
        setDisconnectedDisplay(nativeRoninProvider
          ? 'Ronin Wallet is available. Connect once and the Hub will remember the session.'
          : 'Connect with Ronin Wallet through WalletConnect. The approved session will be remembered.');
      }
    } catch (error) {
      setDisconnectedDisplay(`Ronin connection could not initialize: ${error?.message || 'unknown error'}`);
      walletStatus.classList.add('error');
    } finally {
      bootstrapping = false;
      connectButton.disabled = false;
      connectButton.removeAttribute('aria-busy');
    }
  }

  async function connectRoninWallet() {
    connectButton.disabled = true;
    connectButton.setAttribute('aria-busy', 'true');
    walletStatus.classList.remove('error');

    try {
      nativeRoninProvider ||= await detectNativeRoninProvider();
      if (nativeRoninProvider) {
        nativeRoninProvider.__mattConnector = 'ronin';
        bindNativeEvents(nativeRoninProvider);
        walletConnectProvider = nativeRoninProvider;
        connectButton.textContent = 'Opening Ronin Wallet…';
        walletStatus.textContent = 'Approve account access in Ronin Wallet.';
        const accounts = await accountsFromProvider(nativeRoninProvider, true);
        const account = accounts[0];
        if (!account) throw new Error('Ronin Wallet did not provide an account');
        await ensureRoninChain(nativeRoninProvider);
        await showSignedIn(account, 'ronin');
        return;
      }

      const provider = await getWalletConnectProvider();
      walletConnectProvider = provider;
      connectButton.textContent = 'Opening Ronin Connect…';
      walletStatus.textContent = 'Choose Ronin Wallet or scan the QR code.';
      if (!provider.session) await provider.connect();
      if (!walletConnectCanBet(provider)) throw new Error('The wallet session did not approve transaction requests');
      const account = await findConnectedAccount();
      if (!account) throw new Error('The wallet did not approve a Ronin Mainnet account');
      await showSignedIn(account, 'walletconnect');
    } catch (error) {
      setDisconnectedDisplay(error?.message || 'Ronin connection failed.');
      walletStatus.classList.add('error');
    } finally {
      connectButton.disabled = false;
      connectButton.removeAttribute('aria-busy');
    }
  }

  async function disconnectRoninWallet() {
    connectButton.disabled = true;
    connectButton.textContent = 'Disconnecting…';
    const connector = activeConnector || walletConnectProvider?.__mattConnector || rememberedConnector();

    try {
      if (connector === 'walletconnect' && walletConnectProvider?.disconnect) {
        await walletConnectProvider.disconnect();
      }
    } catch {
      // Local sign-out should still complete if the remote wallet already ended the session.
    } finally {
      clearSession();
      currentAccount = null;
      walletConnectProvider = nativeRoninProvider || null;
      setDisconnectedDisplay('Signed out of MATT Hub. Automatic reconnect is off until you connect again.');
      window.dispatchEvent(new CustomEvent('matt:wallet-disconnected'));
    }
  }

  initializeWalletConnect = initializeRoninConnection;
  connectWallet = connectRoninWallet;
  disconnectWallet = disconnectRoninWallet;

  window.MattRoninConnect = {
    connect: connectRoninWallet,
    disconnect: disconnectRoninWallet,
    restore: initializeRoninConnection,
    get provider() { return walletConnectProvider; },
    get account() { return currentAccount; },
    get connector() { return activeConnector; }
  };

  async function replaceLegacyConnectionAfterStartup() {
    const started = Date.now();
    while (connectButton.getAttribute('aria-busy') === 'true' && Date.now() - started < 15_000) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    walletConnectFallback = walletConnectProvider?.session ? walletConnectProvider : null;
    if (walletConnectFallback) {
      walletConnectFallback.__mattConnector = 'walletconnect';
      bindFallbackEvents(walletConnectFallback);
    }
    await initializeRoninConnection();
  }

  replaceLegacyConnectionAfterStartup();
})();