(() => {
  'use strict';

  const publicRoninRpc = typeof RONIN_RPC_URL === 'string'
    ? RONIN_RPC_URL
    : 'https://api.roninchain.com/rpc';
  const originalFetch = window.fetch.bind(window);

  window.fetch = (input, init = {}) => {
    const url = typeof input === 'string' ? input : input?.url;
    const method = String(init?.method || (typeof input !== 'string' ? input?.method : '') || 'GET').toUpperCase();

    if (url === publicRoninRpc && method === 'POST') {
      return originalFetch('/api/rpc', {
        ...init,
        credentials: 'same-origin',
        headers: {
          'content-type': 'application/json',
          ...(init?.headers || {})
        }
      });
    }

    return originalFetch(input, init);
  };
})();
