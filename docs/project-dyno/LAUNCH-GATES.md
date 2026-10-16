# Project DYNO launch gates — 2026-10-13 UTC

This is an execution checklist, not deployment authorization. No mainnet raffle contract has been deployed, no liquidity or prize asset has been moved by this work, and the live DYNO routes remain disabled.

## Current read-only status

| Gate | Evidence | State |
|---|---|---|
| Live website | `https://matttoken.com/api/dyno/health` reported `ok=true`, encrypted SQLite, `enabled=false`, `purchasesEnabled=false`; `/api/dyno/config` returned null raffle/vault proxies | Storage-only; not launched |
| Treasury and NFT | Ronin block 62,190,655 returned a 2-of-3 Safe at the configured address; Ethereum block 26,179,882 returned the configured depositor as ERC-721 owner of #1358 | Current ownership checked; future manual delivery is owner-trusted |
| Market | Owner expects 5× launch liquidity in the existing 1% MATT/WRON Katana pool. At the older pinned block 62,188,916, the current pool's protected sequential sales stopped at ticket 53 | Retest only after added liquidity is actually on-chain; no ticket-price change approved |
| Randomness | Ronin mainnet read-only preflight at block 62,190,657 quoted 0.196797974673107693 RON for 250,000 callback gas; 25 RON operations budget covers that one quote. Saigon fee estimate currently reverts with a selector and arguments matching `PriceTooOld` (observation 2026-10-08, 24-hour maximum age) | No Saigon request/callback verification; mainnet quote is not fulfillment proof |
| Production configuration | `config/project-dyno.ronin.example.json` fails structural validation: no proxy/implementation/adapter/guard addresses, WRON/router/pool, MATT decimals, production liquidity floor, measured VRF callback policy or final terms hash | No executable production manifest or launch bundle |
| Code and operations | Local mock round and focused safeguards run. The checked-out DYNO work remains uncommitted/unreleased; admin, private identity, indexer, keeper recovery, real-wallet UI and adversarial integration coverage are not complete | Do not enable ticket sales |

## Shortest safe sequence

1. Complete and review the remaining local application/admin/keeper flows. Run the necessary contract, service, wallet and accounting checks; record exactly what did not run. Obtain independent contract/security review appropriate for 35,000 RON of direct receipts plus MATT sale proceeds and manual prize custody. Preserve the separate game bankroll and donations.
2. Once the promised liquidity is added to the existing 1% pool, record its transaction and post-addition block. Re-run the real-token/router/guard local fork for 1,000 individual ticket sales, expected hourly buy sizes, price impact, oracle history, manipulation cases and a nontrivial production liquidity floor. A nominal 5× label is not a substitute for active in-range depth.
3. Recheck the Saigon coordinator fee after its price feed refreshes, then—only with separate testnet transaction authorization and funded testnet gas—verify one request, accepted callback, refund receiver and callback gas. Do not use a mock result or an admin seed as production randomness.
4. Fill and independently validate a production manifest: exact chain, Safe, MATT/WRON/router/factory/pool/fee/code hashes, guard settings, Ethereum NFT read-only RPC, coordinator, signer, both keeper gas wallets, reviewed terms hash and operations budget. Keep private credentials in the hosting secret store. `validate-manifest.js --onchain` and storage/upgrade/source checks must pass.
5. Prepare the seven unsigned CREATE transactions (adapter, guard, two implementations, two proxies and VRF refund receiver) from a fresh deployer nonce. Review predicted addresses, atomic initializers, source verification and multisig drafts. Only after explicit mainnet deployment authorization should a signer submit them. A separate approval is needed for any real liquidity addition, operations funding or other asset movement.
6. Bind the refund receiver, grant the backup keeper, create the draft round, publish fixed ticket/prize quantities and manual NFT/RON delivery terms, verify the owner still holds #1358, fund the operations bucket, and recheck all balances/guard observations. Deploy and verify the reviewed web/API/indexer/keeper release with purchases disabled. Open sales and enable purchase UI only after an explicit final launch decision and confirmed chain reads.

The current draft's five fixed RON prizes total 12,148.8764 RON; the next-Dyno reserve is 10,000 RON; at 1,000 eligible tickets its direct-RON treasury remainder is 12,851.1236 RON. The five prize quantities may be revised before round creation/opening, but must be positive, strictly ascending and funded by direct ticket RON; publish and recheck the final manifest totals. Buyback funding must come only from actual eligible MATT-sale proceeds. The NFT remains on Ethereum for owner manual delivery, not in Ronin escrow. The Safe and unilateral emergency administrator can upgrade active logic; publish that trust model prominently.

## Release decision

Current result: **NO-GO for sales or mainnet deployment.** The site is deliberately off, no production proxies exist, the post-liquidity market path is unmeasured, Saigon VRF integration is externally blocked, and the application/security review is incomplete. Continue independent local work. Do not turn on `DYNO_LIVE_ENABLED`, start production indexing/keeper signing, or submit live transactions to bypass a red gate.
# Superseding no-sale launch gate (2026-10-15)

The current local implementation no longer sells ticket MATT and does not start a buyback. Earlier swap-liquidity and hourly-DCA requirements below describe the superseded design. They are not current checkout prerequisites. The live site remains disabled; this is not launch approval. Required before a real opening: review the new dual-asset terms and exact transfer/refund behavior on the deployed MATT token, regenerate/review ABI and production manifest, verify live VRF callback and manual prize delivery, complete operational/security review, and obtain explicit authorization for any deployment or asset movement. See [NO-SALE-REVISION.md](NO-SALE-REVISION.md).

