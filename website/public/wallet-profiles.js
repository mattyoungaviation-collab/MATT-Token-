(() => {
  'use strict';

  const cache = new Map();
  const listeners = new Set();
  let activeWallet = null;
  let open = false;

  function normalize(value) {
    const wallet = String(value || '').trim().toLowerCase();
    return /^0x[0-9a-f]{40}$/.test(wallet) ? wallet : null;
  }
  function short(wallet) { return wallet ? `${wallet.slice(0, 6)}…${wallet.slice(-4)}` : 'Not connected'; }
  function currentWallet() {
    return normalize(window.MattRoninConnect?.account) ||
      normalize(typeof window.currentAccount === 'string' ? window.currentAccount : null) ||
      normalize(localStorage.getItem('mattBlackjackWallet')) || activeWallet;
  }
  function provider() {
    return window.MattRoninConnect?.provider || window.ronin?.provider || window.ronin || window.walletConnectProvider || null;
  }
  async function signMessage(wallet, message) {
    const source = provider();
    if (!source?.request) throw new Error('Connect Ronin Wallet first.');
    try { return await source.request({ method: 'personal_sign', params: [message, wallet] }); }
    catch (error) {
      if (error?.code === 4001) throw error;
      return source.request({ method: 'personal_sign', params: [wallet, message] });
    }
  }
  async function request(path, options = {}) {
    const response = await fetch(path, { cache: 'no-store', ...options });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.message || payload.error || `HTTP ${response.status}`);
    return payload;
  }
  async function load(walletValue, force = false) {
    const wallet = normalize(walletValue);
    if (!wallet) return null;
    if (!force && cache.has(wallet)) return cache.get(wallet);
    const profile = await request(`/api/profiles/${wallet}`);
    cache.set(wallet, profile);
    notify();
    return profile;
  }
  async function lookup(walletValues) {
    const wallets = [...new Set((walletValues || []).map(normalize).filter(Boolean))];
    const missing = wallets.filter(wallet => !cache.has(wallet));
    if (missing.length) {
      const payload = await request('/api/profiles/lookup', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ wallets: missing })
      });
      for (const wallet of missing) cache.set(wallet, payload.profiles?.[wallet] || { wallet, username: null });
      notify();
    }
    return Object.fromEntries(wallets.map(wallet => [wallet, cache.get(wallet)]));
  }
  function username(walletValue) { return cache.get(normalize(walletValue))?.username || null; }
  function displayName(walletValue) { const wallet = normalize(walletValue); return username(wallet) || short(wallet); }
  function notify() {
    document.dispatchEvent(new CustomEvent('matt:profiles-updated'));
    for (const listener of listeners) { try { listener(); } catch {} }
    updateButton();
  }

  const style = document.createElement('style');
  style.textContent = `
+    .matt-profile-footer{display:flex;justify-content:center;align-items:center;gap:10px;padding:18px 16px 26px;color:#aeb7c6;font:700 13px/1.3 system-ui,sans-serif}.matt-profile-footer button{border:1px solid #f5bd36;background:#15120a;color:#f5bd36;border-radius:10px;padding:10px 14px;font:900 12px system-ui;letter-spacing:.06em;cursor:pointer}.matt-profile-modal[hidden]{display:none}.matt-profile-modal{position:fixed;inset:0;z-index:100000;display:grid;place-items:center;padding:20px;background:#02050bd9;backdrop-filter:blur(8px)}.matt-profile-card{width:min(440px,100%);padding:26px;background:#0c111c;border:1px solid #f5bd36;border-radius:20px;box-shadow:0 28px 90px #000;color:#f7f9ff;font-family:system-ui,sans-serif}.matt-profile-card h2{margin:4px 0 8px;font-size:28px}.matt-profile-card p{color:#b8c0cf;line-height:1.5}.matt-profile-card label{display:block;margin-top:18px;color:#f5bd36;font-weight:900;font-size:12px;letter-spacing:.08em}.matt-profile-card input{box-sizing:border-box;width:100%;margin-top:8px;padding:14px;border:1px solid #394257;border-radius:10px;background:#080c14;color:white;font-size:17px}.matt-profile-actions{display:flex;gap:10px;margin-top:18px}.matt-profile-actions button{flex:1;padding:12px;border-radius:10px;border:1px solid #3b455b;background:#151b28;color:white;font-weight:900;cursor:pointer}.matt-profile-actions .primary{background:#f5bd36;border-color:#f5bd36;color:#171005}.matt-profile-status{min-height:20px;margin:12px 0 0!important;color:#f5bd36!important;font-size:13px}.matt-profile-wallet{font-family:ui-monospace,monospace;color:#dce5f5!important;word-break:break-all}
+  `.replace(/^\+/gm, '');
  document.head.appendChild(style);

  const footer = document.createElement('div');
  footer.className = 'matt-profile-footer';
  footer.innerHTML = `<span id="matt-profile-label">Community username: not connected</span><button id="matt-profile-change" type="button">SET USERNAME</button>`;
  document.body.appendChild(footer);

  const modal = document.createElement('div');
  modal.className = 'matt-profile-modal';
  modal.hidden = true;
  modal.innerHTML = `<div class="matt-profile-card" role="dialog" aria-modal="true" aria-labelledby="matt-profile-title">
    <small>MATT COMMUNITY PROFILE</small><h2 id="matt-profile-title">Choose your username</h2>
    <p>Your username will be public beside your wallet on MATT leaderboards and live games.</p>
    <p class="matt-profile-wallet" id="matt-profile-wallet"></p>
    <label for="matt-profile-input">USERNAME</label><input id="matt-profile-input" maxlength="20" autocomplete="off" placeholder="MattPlayer_1">
    <p>3–20 letters, numbers, or underscores. A wallet signature is required, but no tokens can be moved.</p>
    <p class="matt-profile-status" id="matt-profile-status"></p>
    <div class="matt-profile-actions"><button id="matt-profile-cancel" type="button">CANCEL</button><button class="primary" id="matt-profile-save" type="button">SIGN & SAVE</button></div>
  </div>`;
  document.body.appendChild(modal);

  const label = footer.querySelector('#matt-profile-label');
  const change = footer.querySelector('#matt-profile-change');
  const input = modal.querySelector('#matt-profile-input');
  const status = modal.querySelector('#matt-profile-status');

  function updateButton() {
    const wallet = currentWallet();
    const name = wallet ? username(wallet) : null;
    label.textContent = wallet ? `Community username: ${name || short(wallet)}` : 'Community username: connect a wallet';
    change.textContent = name ? 'CHANGE USERNAME' : 'SET USERNAME';
  }
  async function show(force = false) {
    const wallet = currentWallet();
    if (!wallet) { alert('Connect your Ronin wallet first.'); return; }
    activeWallet = wallet;
    const profile = await load(wallet).catch(() => ({ wallet, username: null }));
    if (!force && profile?.username) return;
    modal.querySelector('#matt-profile-wallet').textContent = wallet;
    input.value = profile?.username || '';
    status.textContent = '';
    modal.hidden = false;
    open = true;
    input.focus();
  }
  function hide() { modal.hidden = true; open = false; }
  async function save() {
    const wallet = currentWallet();
    const chosen = input.value.trim();
    if (!wallet) throw new Error('Connect your Ronin wallet first.');
    if (!/^[A-Za-z0-9_]{3,20}$/.test(chosen)) throw new Error('Use 3–20 letters, numbers, or underscores.');
    status.textContent = 'Preparing wallet signature…';
    const challenge = await request('/api/profiles/challenge', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ wallet, username: chosen })
    });
    status.textContent = 'Approve the signature in Ronin Wallet…';
    const signature = await signMessage(wallet, challenge.message);
    status.textContent = 'Saving username…';
    const profile = await request('/api/profiles/verify', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ wallet, signature })
    });
    cache.set(wallet, profile);
    localStorage.setItem(`mattProfilePrompted:${wallet}`, '1');
    notify();
    hide();
  }

  change.addEventListener('click', () => show(true).catch(error => alert(error.message)));
  modal.querySelector('#matt-profile-cancel').addEventListener('click', hide);
  modal.querySelector('#matt-profile-save').addEventListener('click', () => save().catch(error => { status.textContent = error.message; }));
  modal.addEventListener('click', event => { if (event.target === modal) hide(); });

  async function detect() {
    let wallet = currentWallet();
    if (!wallet) {
      const source = provider();
      if (source?.request) {
        try { wallet = normalize((await source.request({ method: 'eth_accounts' }))?.[0]); } catch {}
      }
    }
    if (wallet && wallet !== activeWallet) {
      activeWallet = wallet;
      const profile = await load(wallet).catch(() => null);
      updateButton();
      if (!profile?.username && !localStorage.getItem(`mattProfilePrompted:${wallet}`) && !open) {
        localStorage.setItem(`mattProfilePrompted:${wallet}`, '1');
        show(true).catch(() => {});
      }
    } else updateButton();
  }

  window.MattProfiles = { load, lookup, username, displayName, short, currentWallet, onUpdate(listener) { listeners.add(listener); return () => listeners.delete(listener); }, show: () => show(true) };
  setInterval(detect, 1200);
  detect();
})();
