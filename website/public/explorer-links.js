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

function loadScript(source) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = source;
    script.addEventListener('load', resolve, { once: true });
    script.addEventListener('error', () => reject(new Error(`Could not load ${source}`)), { once: true });
    document.body.append(script);
  });
}

async function loadMattCoinFlip() {
  if (!document.getElementById('coin-flip')) return;

  const stylesheet = document.createElement('link');
  stylesheet.rel = 'stylesheet';
  stylesheet.href = '/coin-game.css?v=4';
  document.head.append(stylesheet);

  try {
    await loadScript('/walletconnect-game-fix.js?v=4');
    await loadScript('/coin-game-config.js?v=4');
    await loadScript('/coin-game.js?v=4');
  } catch (error) {
    console.error('MATT coin flip failed to load:', error);
  }
}

loadMattCoinFlip();