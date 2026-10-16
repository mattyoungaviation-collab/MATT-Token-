# Manual prize delivery — owner revision

The owner selected manual delivery on 2026-10-12. This supersedes the original NFT escrow and keeper prize-payment requirements. Ticket economics, six VRF winner assignments, review/refunds, reserves and the 168-slot buyback remain unchanged.

## Custody and payment

The NFT stays in `0x1DAb596D0121C250a24B00137E84170FA6874be6` on Ethereum until its winner is assigned. The Ronin manager neither receives nor transfers it and rejects safe NFT deposits. Never send NFTs to it using unsafe direct transfers. The public page discloses owner custody and dependence on manual delivery. The owner can move the NFT outside the raffle contract; that trust is unavoidable in this selected model.

The five RON awards remain reserved in the raffle manager as prize liabilities. The existing 2-of-3 multisig manually calls `attemptPrizePayout(roundId, prizeIndex)` with **zero transaction value**, indexes 0 through 4 in order. The contract sends the assigned amount to the assigned ticket's original wallet. It cannot redirect the beneficiary or release the prize funds to an arbitrary wallet through this method. Failed sends leave the balance owed; winners can still authorize an alternate receiver through `claimPrizeTo`. Claims do not expire. This means manually initiated contract payments, rather than separately paying the same award from a personal wallet and leaving its contract liability unpaid.

No keeper sends a prize. The keeper still requests accepted randomness, finalizes assignments, settles, and runs/closes the buyback. Older unpaid prizes do not stop the DCA clock or close.

## Manual workflow

1. Read the six frozen/assigned winner ticket IDs and original wallets from the Ronin manager after settlement. Never substitute an admin-chosen recipient.
2. Prepare the five RON calls with `node scripts/dyno/prepare-prize-payouts.js <completed-manifest> <roundId>`. It only reads chain state and encodes draft transactions; it does not sign or broadcast. Compare exact quantities/recipients in the multisig and execute one at a time, smallest to largest. Recheck `prizePaid` before retrying to prevent double payment.
3. Check Ethereum ownership of #1358 and manually send it from the recorded depositor to the NFT winner, using the separately prepared Ethereum transaction. Do not send RON on Ethereum or send the NFT on Ronin. Check the receipt before retrying.
4. The Ronin multisig reports the real Ethereum transaction hash via `reportManualNftDelivery`. Reports emit `NFTDeliveryReported`, carry the previous report hash for corrections, and do not emit `PrizePaid` or set `prizePaid(roundId,5)`.
5. `/api/dyno/prize-delivery?roundId=<id>` independently checks Ethereum RPC chain, receipt success, canonical block hash, exact collection/token/depositor/winner, final recipient within the receipt and at least the configured confirmations. The production default is 12 confirmations. A report alone, wrong transfer, missing RPC, or pending receipt cannot display verified delivery.

Ethereum confirmation depth is a selected monitoring policy, not an absolute reorg guarantee. Verification is live and rechecks canonical receipts. The Ronin contract cannot itself prove an Ethereum transfer. A later transfer by the winner does not undo the historical fact of their receipt.

If an NFT winner wants a different receiving address, obtain their proof and implement an explicit authorization path before sending; the current manual verifier requires the original winning wallet. Never use an admin-selected alternate.

## Configuration and changed interface

`prizeDelivery=manual`, `nftChainId=1`, `nftRpcUrlEnv=DYNO_ETHEREUM_RPC_URL`, `nftFinalityBlocks=12`.
`createRound(config,nftChainId)` binds delivery chain and the manual model into the configuration hash. NFT addresses need code on the delivery chain, not on Ronin. The local fixture uses a local mock NFT and chain 31337; local delivery remains visibly mocked.

The previous `depositPrizeNFT` and `returnCancelledNFT` implementation methods are removed. Historical struct fields remain reserved to avoid shifting stored round/ticket data; two mappings consume two slots from the storage gap. Existing deployments must be inspected individually before any upgrade, especially if they contain escrowed NFTs. No live DYNO proxy has been deployed by this task.

Cancellation still credits all active ticket receipts in bounded batches. There is no NFT to return from manager custody. Refund liabilities never become prize or treasury funds. A missing NFT delivery remains an owner obligation and never causes a reroll.

## Local verification — 2026-10-12

- `npm run test:dyno`: 8 contract tests and 21 service/UI checks passed, none skipped. Includes a 1,000-ticket round with replacement, six assignments, manually initiated RON payments, local owner NFT transfer/report, duplicate-payment rejection and DCA close. Preparation produces five zero-value RON transactions and excludes already-paid awards.
- `npm run validate:dyno:upgrade` with the two V2 mock candidates: UUPS implementation/storage validation passed. This validates the current local base against those candidates, not a migration from an existing escrow deployment.
- `npm run deploy:dyno:local`: mock/proxy deployment and round opening succeeded in ephemeral Hardhat chain 31337, without NFT deposit.
- `npm run export:dyno:abis` and `npm run validate:dyno:config`: succeeded. Compiled manager runtime is 23,268 bytes; vault is 9,095 bytes.
- Production example validation intentionally rejects 14 incomplete values/errors. No live NFT transfer, production OAuth, real DEX trade, testnet VRF or mainnet deployment was performed. Remaining release blockers are in `OUTSTANDING.md`.
# Current no-sale revision

Manual NFT and RON prize delivery remains selected. The earlier statement below that a 168-slot buyback remains unchanged is superseded: current settlement funds **no** buyback and allocates eligible MATT to the multisig. See [NO-SALE-REVISION.md](NO-SALE-REVISION.md).

