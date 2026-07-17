(() => {
  'use strict';

  const coinSection = document.getElementById('coin-flip');
  if (!coinSection) return;

  const section = document.createElement('section');
  section.className = 'burnflip-history-section';
  section.id = 'burnflip-history';
  section.innerHTML = `
    <div class="section-heading">
      <p class="eyebrow">BURNFLIP RECORDS</p>
      <h2>Your History & Leaderboard</h2>
      <p>Every result below is reconstructed from confirmed BurnFlip settlement events on Ronin.</p>
    </div>

    <div class="burnflip-player-panel" id="burnflip-player-panel">
      <div class="burnflip-panel-heading">
        <div><span>SIGNED-IN WALLET</span><strong id="bf-player-wallet">Connect Ronin Wallet</strong></div>
        <button id="bf-refresh-player" class="secondary-button" type="button">Refresh</button>
      </div>
      <div class="burnflip-stat-grid">
        <article><span>Total flips</span><strong id="bf-player-flips">—</strong></article>
        <article><span>Wins</span><strong id="bf-player-wins">—</strong></article>
        <article><span>Losses</span><strong id="bf-player-losses">—</strong></article>
        <article><span>Total bet</span><strong id="bf-player-volume">—</strong></article>
        <article><span>Net result</span><strong id="bf-player-net">—</strong></article>
      </div>
      <div class="burnflip-history-wrap">
        <table class="burnflip-table">
          <thead><tr><th>Bet</th><th>Choice</th><th>Result</th><th class="numeric">Amount</th><th class="numeric">Payout</th><th class="numeric">Net</th><th>Ronin</th></tr></thead>
          <tbody id="bf-history-body"><tr><td colspan="7">Connect Ronin Wallet to load your history.</td></tr></tbody>
        </table>
      </div>
    </div>

    <div class="burnflip-leaderboard-panel">
      <div class="burnflip-panel-heading">
        <div><span>ALL PLAYERS</span><strong>BurnFlip Leaderboard</strong></div>
        <span id="bf-index-status">Loading index…</span>
      </div>
      <div class="burnflip-filter-row">
        <label><span>Rank by</span><select id="bf-sort">
          <option value="net-desc">Biggest winners</option>
          <option value="net-asc">Biggest losers</option>
          <option value="volume-desc">Total accumulated bets</option>
          <option value="biggest-win">Biggest single win</option>
          <option value="biggest-loss">Biggest single loss</option>
          <option value="wins-desc">Most wins</option>
          <option value="losses-desc">Most losses</option>
          <option value="winrate-desc">Best win rate</option>
        </select></label>
        <label><span>Minimum flips</span><select id="bf-min-flips"><option value="0">Any</option><option value="5">5+</option><option value="10">10+</option><option value="25">25+</option><option value="50">50+</option><option value="100">100+</option></select></label>
        <label class="burnflip-search"><span>Wallet search</span><input id="bf-search" type="search" placeholder="0x wallet address"></label>
        <button id="bf-refresh-board" class="secondary-button" type="button">Refresh</button>
      </div>
      <div class="burnflip-history-wrap">
        <table class="burnflip-table">
          <thead><tr><th>#</th><th>Wallet</th><th class="numeric">Flips</th><th class="numeric">W</th><th class="numeric">L</th><th class="numeric">Total bet</th><th class="numeric">Net</th><th class="numeric">Win rate</th></tr></thead>
          <tbody id="bf-leaderboard-body"><tr><td colspan="8">Loading BurnFlip players…</td></tr></tbody>
        </table>
      </div>
      <div class="burnflip-pagination"><span id="bf-page-summary">—</span><button id="bf-load-more" class="secondary-button" type="button" hidden>Load more</button></div>
    </div>
  `;
  coinSection.insertAdjacentElement('afterend', section);

  const $ = selector => section.querySelector(selector);
  const state = { offset: 0, limit: 25, loading: false, lastWallet: null };

  function wallet() {
    const value = window.MattRoninConnect?.account || (typeof currentAccount === 'string' ? currentAccount : null);
    return /^0x[a-fA-F0-9]{40}$/.test(String(value || '')) ? String(value).toLowerCase() : null;
  }
  function short(value) { return value ? `${value.slice(0, 6)}…${value.slice(-4)}` : '—'; }
  function matt(raw, precision = 2) {
    const value = BigInt(raw || '0');
    const negative = value < 0n;
    const absolute = negative ? -value : value;
    const whole = absolute / 10n ** 18n;
    const fractionRaw = (absolute % 10n ** 18n).toString().padStart(18, '0').slice(0, precision).replace(/0+$/, '');
    return `${negative ? '-' : ''}${whole.toLocaleString()}${fractionRaw ? `.${fractionRaw}` : ''} MATT`;
  }
  function netClass(raw) { const value = BigInt(raw || '0'); return value > 0n ? 'positive' : value < 0n ? 'negative' : ''; }
  function escapeHtml(value) { const div = document.createElement('div'); div.textContent = String(value); return div.innerHTML; }

  async function json(url) {
    const response = await fetch(url, { cache: 'no-store' });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.message || payload.error || `HTTP ${response.status}`);
    return payload;
  }

  async function loadPlayer(force = false) {
    const owner = wallet();
    state.lastWallet = owner;
    if (!owner) {
      $('#bf-player-wallet').textContent = 'Connect Ronin Wallet';
      for (const id of ['#bf-player-flips','#bf-player-wins','#bf-player-losses','#bf-player-volume','#bf-player-net']) $(id).textContent = '—';
      $('#bf-history-body').innerHTML = '<tr><td colspan="7">Connect Ronin Wallet to load your history.</td></tr>';
      return;
    }
    $('#bf-player-wallet').textContent = short(owner);
    const payload = await json(`/api/burnflip/history/${owner}?limit=100${force ? '&fresh=1' : ''}`);
    const player = payload.player;
    $('#bf-player-flips').textContent = Number(player.flips).toLocaleString();
    $('#bf-player-wins').textContent = Number(player.wins).toLocaleString();
    $('#bf-player-losses').textContent = Number(player.losses).toLocaleString();
    $('#bf-player-volume').textContent = matt(player.totalBetRaw);
    $('#bf-player-net').textContent = matt(player.netRaw);
    $('#bf-player-net').className = netClass(player.netRaw);
    $('#bf-history-body').innerHTML = player.history.length ? player.history.map(record => `
      <tr>
        <td>#${escapeHtml(record.betId)}</td>
        <td>${record.choice === 0 ? 'Heads' : 'Tails'}</td>
        <td><span class="result-pill ${record.won ? 'win' : 'loss'}">${record.won ? 'WIN' : 'LOSS'} · ${record.outcome === 0 ? 'Heads' : 'Tails'}</span></td>
        <td class="numeric">${matt(record.amountRaw)}</td>
        <td class="numeric">${matt(record.payoutRaw)}</td>
        <td class="numeric ${netClass(record.netRaw)}">${matt(record.netRaw)}</td>
        <td><a href="https://app.roninchain.com/tx/${record.transactionHash}" target="_blank" rel="noopener">${short(record.transactionHash)}</a></td>
      </tr>`).join('') : '<tr><td colspan="7">No settled BurnFlip bets found for this wallet.</td></tr>';
  }

  async function loadBoard({ append = false, force = false } = {}) {
    if (state.loading) return;
    state.loading = true;
    try {
      if (!append) state.offset = 0;
      const params = new URLSearchParams({ sort: $('#bf-sort').value, minFlips: $('#bf-min-flips').value, search: $('#bf-search').value.trim(), offset: String(state.offset), limit: String(state.limit) });
      if (force) params.set('fresh', '1');
      const payload = await json(`/api/burnflip/leaderboard?${params}`);
      const rows = payload.players.map(player => `
        <tr>
          <td>${player.rank}</td>
          <td><a href="https://app.roninchain.com/address/${player.wallet}" target="_blank" rel="noopener">${short(player.wallet)}</a></td>
          <td class="numeric">${Number(player.flips).toLocaleString()}</td>
          <td class="numeric positive">${Number(player.wins).toLocaleString()}</td>
          <td class="numeric negative">${Number(player.losses).toLocaleString()}</td>
          <td class="numeric">${matt(player.totalBetRaw)}</td>
          <td class="numeric ${netClass(player.netRaw)}">${matt(player.netRaw)}</td>
          <td class="numeric">${(Number(player.winRate) * 100).toFixed(1)}%</td>
        </tr>`).join('');
      const body = $('#bf-leaderboard-body');
      body.innerHTML = append ? body.innerHTML + rows : (rows || '<tr><td colspan="8">No players match these filters.</td></tr>');
      state.offset += payload.players.length;
      $('#bf-index-status').textContent = `${Number(payload.totalPlayers).toLocaleString()} players · ${Number(payload.totalSettlements).toLocaleString()} settled flips`;
      $('#bf-page-summary').textContent = payload.totalPlayers ? `Showing 1–${state.offset} of ${payload.totalPlayers}` : 'No matching players';
      $('#bf-load-more').hidden = !payload.hasMore;
    } finally { state.loading = false; }
  }

  $('#bf-refresh-player').addEventListener('click', () => loadPlayer(true).catch(error => alert(error.message)));
  $('#bf-refresh-board').addEventListener('click', () => loadBoard({ force: true }).catch(error => alert(error.message)));
  $('#bf-load-more').addEventListener('click', () => loadBoard({ append: true }).catch(error => alert(error.message)));
  $('#bf-sort').addEventListener('change', () => loadBoard().catch(() => {}));
  $('#bf-min-flips').addEventListener('change', () => loadBoard().catch(() => {}));
  let searchTimer;
  $('#bf-search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => loadBoard().catch(() => {}), 300); });

  setInterval(() => {
    const current = wallet();
    if (current !== state.lastWallet) loadPlayer().catch(() => {});
  }, 1500);
  setInterval(() => loadBoard().catch(() => {}), 30000);
  loadPlayer().catch(() => {});
  loadBoard().catch(error => { $('#bf-leaderboard-body').innerHTML = `<tr><td colspan="8">${escapeHtml(error.message)}</td></tr>`; });
})();