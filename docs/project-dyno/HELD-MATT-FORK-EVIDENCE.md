# Held-MATT fork evidence (2026-10-15)

The owner-approved no-sale ticket model was exercised against deployed MATT bytecode and state on a disposable Hardhat fork of Ronin mainnet, pinned to block **62,315,506**. The script deployed new local raffle/vault proxies and a local mock VRF coordinator, impersonated the declared depositor only inside the fork, and used the real MATT contract at `0xa5450417bdca0bdfb058ffe41205400ffda1174d`. No live transaction was sent and no mainnet balance changed.

Result: one 35 RON + 700,000 MATT ticket succeeded. The purchasing wallet lost exactly 700,000 MATT, the raffle received exactly 700,000 MATT, and the ticket recorded zero sale RON. After local disqualification, `claimRefund` returned exactly 700,000 MATT to the original wallet; the raffle's MATT balance returned to zero. The RON refund path executed in the same claim. The full local contract/service/UI suite separately passed 16 contract tests and 96 service/UI tests when loopback HTTP connections were permitted. A first sandboxed service run failed 13 HTTP tests because the sandbox denied local `127.0.0.1` connections (`EACCES`); the unrestricted local rerun passed all 96.

Reproduce without exposing the private RPC URL in command output:

```powershell
$env:DYNO_FORK_MANIFEST='config/project-dyno.ronin.example.json'
$env:DYNO_FORK_BLOCK='62315506'
# DYNO_FORK_RPC_URL must be present in the local .env, never committed.
npx hardhat run scripts/dyno/fork-held-matt.js --network hardhat
```

This verifies the tested block's exact inbound/outbound MATT behavior for one ticket and one disqualification refund. It does **not** establish future token behavior, full 1,000-ticket live gas/capacity, VRF provider delivery, manual NFT fulfillment, legal compliance, or an independent security audit. Production remains disabled. Re-run at a later pinned block before opening and compare token code/administration changes.
