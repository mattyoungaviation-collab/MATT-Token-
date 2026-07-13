(() => {
  'use strict';

  const connectButton = document.getElementById('connect-wallet');
  const walletStatus = document.getElementById('wallet-status');
  const missionReset = document.getElementById('mission-reset');
  const missionConnectCard = document.querySelector('.mission-card[data-mission="connect"]');
  const missionNotice = document.querySelector('.mission-notice');
  const heroLead = document.querySelector('.hero .lead');
  const heroBadges = [...document.querySelectorAll('.hero-badges span')];
  const walletDescription = document.querySelector('#wallet .section-heading p:last-child');
  const metaDescription = document.querySelector('meta[name="description"]');

  function roninWording(text) {
    return String(text || '')
      .replace(/CONNECT WALLETCONNECT/g, 'CONNECT RONIN')
      .replace(/Reconnect WalletConnect/g, 'Reconnect Ronin')
      .replace(/Connect WalletConnect/g, 'Connect Ronin')
      .replace(/Opening WalletConnect/g, 'Opening Ronin Connect')
      .replace(/Preparing WalletConnect/g, 'Preparing Ronin Connect')
      .replace(/WalletConnect/g, 'Ronin Connect');
  }

  function updateDynamicLabels() {
    const dynamicElements = [
      document.getElementById('connect-wallet'),
      document.getElementById('wallet-status'),
      document.getElementById('mission-reset'),
      document.getElementById('flip-button'),
      document.getElementById('coin-game-progress')
    ].filter(Boolean);

    for (const element of dynamicElements) {
      const updated = roninWording(element.textContent);
      if (updated !== element.textContent) element.textContent = updated;
    }
  }

  if (connectButton && !connectButton.textContent.includes('Disconnect')) {
    connectButton.textContent = 'Connect Ronin';
  }
  if (walletStatus) walletStatus.textContent = 'Restoring your Ronin wallet session.';
  if (missionReset) missionReset.textContent = 'Connect a Ronin wallet to begin today’s missions.';
  if (heroLead) {
    heroLead.textContent = 'Sign in with Ronin Wallet, check your MATT status, complete daily missions, place on-chain coin flips, and meet the holders building MATT together.';
  }
  if (heroBadges[0]) heroBadges[0].textContent = 'Ronin Connect';
  if (heroBadges[1]) heroBadges[1].textContent = 'Session remembered';
  if (heroBadges[2]) heroBadges[2].textContent = 'On-chain betting';
  if (walletDescription) {
    walletDescription.textContent = 'Sign in once with Ronin Wallet. The Hub restores the approved session after refresh; approvals and bets still require wallet confirmation.';
  }
  if (missionConnectCard) {
    const text = missionConnectCard.querySelector('p');
    if (text) text.textContent = 'Sign in with a Ronin account and keep the session active on this browser.';
  }
  if (missionNotice) {
    missionNotice.textContent = 'Mission progress and the wallet sign-in session are saved on this browser. Token approvals, bets, reveals, and payouts remain on-chain.';
  }
  if (metaDescription) {
    metaDescription.content = 'Sign in with Ronin Wallet, view your MATT balance and rank, place on-chain coin flips, complete daily missions, and explore MATT holders.';
  }

  updateDynamicLabels();
  new MutationObserver(updateDynamicLabels).observe(document.body, {
    childList: true,
    characterData: true,
    subtree: true
  });
})();