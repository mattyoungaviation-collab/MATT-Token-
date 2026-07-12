const OLD_RONIN_EXPLORER_PREFIX = 'https://app.roninchain.com/explorer/address/';
const CURRENT_RONIN_EXPLORER_PREFIX = 'https://explorer.roninchain.com/address/';

function updateRoninExplorerLink(link) {
  if (!(link instanceof HTMLAnchorElement)) return;
  const href = link.getAttribute('href');
  if (!href?.startsWith(OLD_RONIN_EXPLORER_PREFIX)) return;
  link.setAttribute('href', `${CURRENT_RONIN_EXPLORER_PREFIX}${href.slice(OLD_RONIN_EXPLORER_PREFIX.length)}`);
}

function updateRoninExplorerLinks(root = document) {
  if (root instanceof HTMLAnchorElement) updateRoninExplorerLink(root);
  if (root.querySelectorAll) {
    root.querySelectorAll('a[href]').forEach(updateRoninExplorerLink);
  }
}

updateRoninExplorerLinks();

const explorerLinkObserver = new MutationObserver(mutations => {
  for (const mutation of mutations) {
    if (mutation.type === 'attributes') {
      updateRoninExplorerLink(mutation.target);
      continue;
    }

    for (const node of mutation.addedNodes) {
      if (node instanceof Element) updateRoninExplorerLinks(node);
    }
  }
});

explorerLinkObserver.observe(document.documentElement, {
  subtree: true,
  childList: true,
  attributes: true,
  attributeFilter: ['href']
});

function loadMattCoinFlip() {
  if (!document.getElementById('coin-flip')) return;

  const stylesheet = document.createElement('link');
  stylesheet.rel = 'stylesheet';
  stylesheet.href = '/coin-game.css?v=1';
  document.head.append(stylesheet);

  const configScript = document.createElement('script');
  configScript.src = '/coin-game-config.js?v=1';
  configScript.addEventListener('load', () => {
    const gameScript = document.createElement('script');
    gameScript.src = '/coin-game.js?v=1';
    document.body.append(gameScript);
  });
  document.body.append(configScript);
}

loadMattCoinFlip();
