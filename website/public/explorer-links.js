const LEGACY_RONIN_EXPLORER_PREFIXES = [
  "https://app.roninchain.com/explorer/address/",
  "https://app.roninchain.com/address/",
  "https://app.roninchain.com/tx/"
];
const OFFICIAL_RONIN_EXPLORER = "https://explorer.roninchain.com";

function officialRoninExplorerUrl(href) {
  if (href.startsWith(LEGACY_RONIN_EXPLORER_PREFIXES[0])) {
    return `${OFFICIAL_RONIN_EXPLORER}/address/${href.slice(LEGACY_RONIN_EXPLORER_PREFIXES[0].length)}`;
  }
  if (href.startsWith(LEGACY_RONIN_EXPLORER_PREFIXES[1])) {
    return `${OFFICIAL_RONIN_EXPLORER}/address/${href.slice(LEGACY_RONIN_EXPLORER_PREFIXES[1].length)}`;
  }
  if (href.startsWith(LEGACY_RONIN_EXPLORER_PREFIXES[2])) {
    return `${OFFICIAL_RONIN_EXPLORER}/tx/${href.slice(LEGACY_RONIN_EXPLORER_PREFIXES[2].length)}`;
  }
  return href;
}

function updateRoninExplorerLink(link) {
  if (!(link instanceof HTMLAnchorElement)) return;
  const href = link.getAttribute("href");
  if (!href) return;
  const officialHref = officialRoninExplorerUrl(href);
  if (officialHref !== href) link.setAttribute("href", officialHref);
}

function updateRoninExplorerLinks(root = document) {
  if (root instanceof HTMLAnchorElement) updateRoninExplorerLink(root);
  if (root.querySelectorAll) root.querySelectorAll("a[href]").forEach(updateRoninExplorerLink);
}

updateRoninExplorerLinks();
const explorerLinkObserver = new MutationObserver(mutations => {
  for (const mutation of mutations) {
    if (mutation.type === "attributes") updateRoninExplorerLink(mutation.target);
    else for (const node of mutation.addedNodes) if (node instanceof Element) updateRoninExplorerLinks(node);
  }
});
explorerLinkObserver.observe(document.documentElement, {
  subtree: true,
  childList: true,
  attributes: true,
  attributeFilter: ["href"]
});

function loadScript(source) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = source;
    script.addEventListener("load", resolve, { once: true });
    script.addEventListener("error", () => reject(new Error(`Could not load ${source}`)), { once: true });
    document.body.append(script);
  });
}

function loadStylesheet(source) {
  const stylesheet = document.createElement("link");
  stylesheet.rel = "stylesheet";
  stylesheet.href = source;
  document.head.append(stylesheet);
}

async function loadMattHubApps() {
  if (!document.getElementById("coin-flip")) return;
  loadStylesheet("/coin-game.css?v=29");
  loadStylesheet("/burnflip.css?v=29");
  try {
    await loadScript("/rpc-proxy.js?v=29");
    await loadScript("/ronin-connect-copy.js?v=29");
    await loadScript("/walletconnect-game-fix.js?v=29");
    await loadScript("/coin-game-config.js?v=29");
    await loadScript("/burnflip-shell.js?v=29");
    await loadScript("/burnflip-controller.js?v=29");
    await loadScript("/burnflip-stats.js?v=29");
  } catch (error) {
    console.error("MATT Hub apps failed to load:", error);
  }
}

loadMattHubApps();
