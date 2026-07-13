(() => {
  'use strict';
  const button = document.getElementById('v2-claim');
  const status = document.getElementById('v2-status');
  const config = window.MATT_DAILY_REWARDS_V2_CONFIG || {};
  if (!button || !status) return;

  let busy = false;
  button.addEventListener('click', async event => {
    event.preventDefault();
    event.stopImmediatePropagation();
    if (busy) return;

    const account = window.MattRoninConnect?.account;
    const provider = window.MattRoninConnect?.provider;
    if (!account || !provider?.request) {
      status.textContent = 'Connect Ronin Wallet first.';
      return;
    }

    let local = {};
    try {
      local = JSON.parse(localStorage.getItem(`mattRewardsV2:${config.contractAddress}:${account}`) || '{}');
    } catch {}
    if (!local.betId) {
      status.textContent = 'Complete and settle a new MATT coin flip first.';
      return;
    }

    busy = true;
    button.disabled = true;
    try {
      status.textContent = 'Checking the verified X follow relationship…';
      const response = await fetch('/api/x/proof', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ wallet: account, betId: local.betId })
      });
      const proof = await response.json();
      if (!response.ok) throw new Error(proof.error || 'X follow verification failed');

      const ethers = await import('https://esm.sh/ethers@6.13.5?bundle');
      const iface = new ethers.Interface(['function claim(uint256,bytes32,uint256,bytes)']);
      const data = iface.encodeFunctionData('claim', [
        BigInt(local.betId), proof.xUserHash, BigInt(proof.deadline), proof.proof
      ]);
      status.textContent = `@${proof.username} follows @${config.xHandle}. Confirm the 1,000,000 MATT claim in Ronin Wallet.`;
      await provider.request({
        method: 'eth_sendTransaction',
        params: [{ from: account, to: config.contractAddress, data, value: '0x0' }]
      });
      status.textContent = 'Verified reward claim submitted to Ronin.';
      setTimeout(() => window.location.reload(), 6000);
    } catch (error) {
      status.textContent = String(error?.message || error).slice(0, 220);
    } finally {
      busy = false;
      button.disabled = false;
    }
  }, true);
})();