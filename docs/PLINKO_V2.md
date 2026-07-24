# MATT Plinko V2

## Final game rules

- Sixteen peg rows and seventeen payout slots.
- One Plinko coin costs exactly 10,000 MATT.
- A player buys 1–100 coins in one batch.
- A batch uses one official Ronin VRF request.
- The player may drop loaded coins individually or rapid fire.
- Clicking changes only animation timing. It never changes an outcome.
- Every visual path is generated for the exact slot stored by the contract.

Payout board:

`200× | 162× | 38× | 9× | 3× | 1.5× | 0.5× | 0.25× | 0.1× | 0.25× | 0.5× | 1.5× | 3× | 9× | 38× | 162× | 200×`

The exact theoretical return is 97.38616943359375%, which is displayed as
97.39%. The house edge is 2.61383056640625%.

## Result integrity

`MattPlinkoV2` derives every coin outcome during the Ronin VRF callback. Each
slot uses sixteen independent left/right decisions, producing the physical
binomial distribution of a sixteen-row board. Outcomes are packed into two
storage words at five bits per coin.

The contract never stores a server-selected seed. Blockchain state is public
after settlement, so the website cannot make the seed cryptographically secret
until the final animation. Instead, the interface reveals each already-fixed
slot only when its ball lands. Players cannot change an outcome by clicking,
waiting, rapid firing, refreshing, or choosing a starting position.

The browser result engine validates that every visual path:

1. contains exactly sixteen peg decisions;
2. contains exactly the number of right turns required by its onchain slot;
3. ends at the center of that same multiplier slot.

If animation is interrupted, only visibly completed balls are persisted.
Interrupted balls replay their same result after refresh.

## Bankroll protection

A 100-coin batch wagers 1,000,000 MATT and can theoretically pay 200,000,000
MATT. The contract therefore reserves 199,000,000 MATT of additional bankroll
before accepting that batch.

Pending wagers, maximum pending liabilities, and credited player withdrawals
are protected from treasury withdrawal. Stale VRF requests can be refunded
after two hours, and a late callback cannot replace or duplicate that refund.

The guarded funding script defaults to 250,000,000 MATT. The contract must
remain paused until deployment verification, funding, a controlled test batch,
and frontend address configuration are complete.

## Safe release order

1. Review and test the V2 source.
2. Deploy V2 in the paused state.
3. Verify the address, owner, MATT token, treasury, VRF coordinator, coin price,
   batch limit, payout table, and source.
4. Fund at least 199,000,000 MATT; 250,000,000 MATT is the recommended starting
   bankroll.
5. Put the verified V2 address in `website/public/plinko-v2.js`.
6. Publish `/plinko-v2` without replacing the live V1 link.
7. Run one controlled small batch while V2 remains isolated from V1.
8. Unpause V2 only after the complete onchain and visual result match is
   independently confirmed.
9. Replace the public `/plinko` link only after that test passes.

V1 must not be redeployed or modified as part of the V2 release.
