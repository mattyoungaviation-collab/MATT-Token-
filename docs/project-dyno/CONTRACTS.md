# Contract interfaces and invariants

Manager write surface: `createRound(config,nftChainId)`, `fundOperations`, `openRound`, `buyTickets`, `flagTicket`, `resolveFlag`, `disqualifyTicket`, `finalizeEligibility`, `requestDraw`, `rawFulfillRandomSeed`, `finalizeWinners`, `settleRound`, multisig-only `attemptPrizePayout` (RON indexes 0..4), `reportManualNftDelivery` (evidence report only), `claimPrizeTo` (RON), `claimRefund`, `claimRefundTo`, `cancelRound`, `processCancellationRefunds`, `claimTreasuryLiability`, `relinkIdentity(accountCommitment,newWallet,expectedVersion,expiry,newWalletSignature)`, `setAccountSuspended`, `rotateIdentitySigner`, `setReviewer`, `setSubsystemPaused`, `setLiveSaleSlippage`, and UUPS `upgradeToAndCall`. `getNftPrize`, `getWinnerTicketId` and `reportedNftDelivery` expose manual-delivery reads.

Vault write surface: `startBuyback` (manager only), `executeCurrentSlot`, isolated `executeSwap` (self only), `markExpiredSlots`, `closeBuyback`, `claimReturn`, `setSlippageBps`, `setExecutionPaused`, and `upgradeToAndCall`. Reads include round/ticket status, individual frozen indexes, flags, prize/refund status, schedule and slot status. Generated ABIs are in `packages/abis`.

`getRoundTerms(roundId)` exposes the active round's ticket amounts, five prize amounts, reserve, NFT token ID, terms hash and configuration hash directly from chain. The API pins that read and `getNftPrize` to the same block, and discovers the manager's active round ID from chain rather than assuming round 1. The production `/config` route no longer publishes the original manifest's `round` object as if it were live authority. A DRAFT can be revised by cancelling and creating a new DRAFT; it gets a new round ID and hash. If operations RON was funded, cancellation credits it to the configured treasury's claim instead of stranding it. Once OPEN, prices and prizes cannot be revised by routine setters.

Key invariants:

- Eligible count never exceeds 1,000; freeze requires exactly 1,000.
- Account/day and wallet/day successful counts never exceed three.
- Each ticket’s measured sale RON belongs to active sale receipts or refund liability, never both.
- At a valid freeze, direct active receipts are exactly 35,000 RON. The NFT remains owner-held on its delivery chain; the Ronin manager does not enforce its custody.
- Fixed prizes plus reserve cannot exceed direct receipts.
- Winner/seed/callback/settlement/refund/prize/slot transitions are one-way and replay-safe.
- Vault budget equals successful spend plus returned/owed return plus current backed balance.
- Draws use the frozen dense index with replacement; a payout failure cannot change an assignment.
- No ordinary method edits eligibility after freeze or cancels after the VRF request.

The manager runtime is compiled with optimizer runs `1` and solc 0.8.28. Manual delivery removes the on-chain NFT transfer paths. The current compiled runtime is 24,509 bytes against EIP-170's 24,576-byte limit; this 67-byte margin must be rechecked for every change. The code-size limit is why draft revisions use cancel-and-recreate rather than an in-place full-config setter. Typehashes remain defined in source but have no redundant public getters.
# Current no-sale revision

`buyTickets` now takes `(PurchaseVoucher, signature)` without swap minimums, and it never calls an adapter. Refund claims pay the original RON and MATT; `claimTreasuryMatt(roundId)` releases only eligible MATT after settlement. Legacy vault write methods below are not invoked by the current manager. See [NO-SALE-REVISION.md](NO-SALE-REVISION.md).

