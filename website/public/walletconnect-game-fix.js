(() => {
  'use strict';

  const PERMISSIONS_VERSION = 2;
  const REQUIRED_TRANSACTION_METHOD = 'eth_sendTransaction';

  function approvedMethods(provider = walletConnectProvider) {
    const namespaces = provider?.session?.namespaces || {};
    return new Set(
      Object.values(namespaces).flatMap(namespace => Array.isArray(namespace?.methods) ? namespace.methods : [])
    );
  }

  function sessionCanSendTransactions(provider = walletConnectProvider) {
    return !provider?.session || approvedMethods(provider).has(REQUIRED_TRANSACTION_METHOD);
  }

  async function closeOldSession(provider) {
    if (!provider?.session) return;
    try {
      await provider.disconnect();
    } catch {
      // The local provider can still be replaced if the wallet already closed the session.
    }
  }

  async function initializeWalletConnectForBetting() {
    connectButton.disabled = true;
    connectButton.setAttribute('aria-busy', 'true');
    connectButton.textContent = 'Loading WalletConnect…';
    walletStatus.textContent = 'Preparing WalletConnect transaction permissions.';
    walletStatus.classList.remove('error');

    try {
      const walletConnectModule = await import(WALLETCONNECT_MODULE_URL);
      const EthereumProvider = walletConnectModule.EthereumProvider || walletConnectModule.default;
      if (!EthereumProvider?.init) throw new Error('WalletConnect provider did not load');

      walletConnectProvider = await EthereumProvider.init({
        projectId: WALLETCONNECT_PROJECT_ID,
        metadata: {
          name: 'MATT Hub',
          description: 'Connect to MATT Hub and place MATT coin-flip bets on Ronin Mainnet.',
          url: window.location.origin,
          icons: [`${window.location.origin}/assets/matt-logo-512.png`]
        },
        showQrModal: true,
        optionalChains: [RONIN_CHAIN_ID],
        rpcMap: { [RONIN_CHAIN_ID]: RONIN_RPC_URL },
        qrModalOptions: { themeMode: 'dark' }
      });

      walletConnectProvider.__mattPermissionsVersion = PERMISSIONS_VERSION;
      bindWalletConnectEvents();

      if (walletConnectProvider.session) {
        if (!sessionCanSendTransactions(walletConnectProvider)) {
          await closeOldSession(walletConnectProvider);
          resetWalletDisplay('WalletConnect permissions were upgraded. Connect again and approve the new transaction permissions.');
          connectButton.textContent = 'Reconnect WalletConnect';
          return;
        }

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
      walletStatus.classList.add('error');
    }
  }

  async function connectWalletForBetting() {
    const providerNeedsUpgrade =
      !walletConnectProvider ||
      walletConnectProvider.__mattPermissionsVersion !== PERMISSIONS_VERSION ||
      !sessionCanSendTransactions(walletConnectProvider);

    if (providerNeedsUpgrade) {
      await closeOldSession(walletConnectProvider);
      walletConnectProvider = null;
      currentAccount = null;
      await initializeWalletConnectForBetting();
      if (!walletConnectProvider) return;
    }

    if (walletConnectProvider.session) {
      const account = await findConnectedAccount();
      if (account) {
        await showConnectedAccount(account);
        return;
      }
    }

    connectButton.disabled = true;
    connectButton.setAttribute('aria-busy', 'true');
    connectButton.textContent = 'Opening WalletConnect…';
    walletStatus.textContent = 'Choose Ronin Wallet or scan the WalletConnect QR code, then approve transaction permissions.';
    walletStatus.classList.remove('error');

    try {
      await walletConnectProvider.connect();
      if (!sessionCanSendTransactions(walletConnectProvider)) {
        await closeOldSession(walletConnectProvider);
        throw new Error('The wallet connection did not approve transaction requests. Reconnect and approve the requested permissions.');
      }

      const account = await findConnectedAccount();
      if (!account) throw new Error('The wallet did not approve a Ronin Mainnet account');
      await showConnectedAccount(account);
    } catch (error) {
      resetWalletDisplay(error?.message || 'WalletConnect connection failed.');
    }
  }

  initializeWalletConnect = initializeWalletConnectForBetting;
  connectWallet = connectWalletForBetting;

  async function replaceLegacyProviderAfterStartup() {
    const startedAt = Date.now();
    while (connectButton.getAttribute('aria-busy') === 'true' && Date.now() - startedAt < 15_000) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    if (!walletConnectProvider || walletConnectProvider.__mattPermissionsVersion === PERMISSIONS_VERSION) return;

    const hadSession = Boolean(walletConnectProvider.session);
    await closeOldSession(walletConnectProvider);
    walletConnectProvider = null;
    currentAccount = null;
    resetWalletDisplay(
      hadSession
        ? 'WalletConnect permissions were upgraded. Reconnect your wallet to enable betting transactions.'
        : 'WalletConnect is ready. Connect your wallet to enable betting transactions.'
    );
    connectButton.textContent = hadSession ? 'Reconnect WalletConnect' : 'Connect WalletConnect';
  }

  replaceLegacyProviderAfterStartup();
})();
