# MATT Plinko V4

## Game rules

- Sixteen peg rows and seventeen payout slots.
- One coin costs exactly 10,000 MATT.
- A player may buy 1–100 coins per VRF batch.
- One official Ronin VRF seed fixes every result in the batch.
- Multipliers include returned principal.

Payout board:

`50× | 25× | 10.0174× | 5× | 2× | 1.5× | 0.8× | 0.7× | 0.4848× | 0.7× | 0.8× | 1.5× | 2× | 5× | 10.0174× | 25× | 50×`

The exact theoretical RTP is 98.2%. The exact house edge is 1.8%.

## Hard payout cap

A full 100-coin batch costs 1,000,000 MATT. Since no coin can pay more than
50×, no possible 100-coin batch can pay more than 50,000,000 MATT.

The contract reserves 49,000,000 MATT of additional bankroll before accepting
a full batch. Pending wagers, reserved liabilities, and claimable player funds
remain protected from treasury withdrawal.

## Release safety

V4 is a separate paused-by-default deployment. V3 remains live and unchanged until V4:

1. compiles and passes its complete contract suite;
2. is deployed and source verified;
3. is inspected while paused;
4. is funded with at least 49,000,000 MATT of unreserved bankroll;
5. is connected to a V4 frontend using the exact same multiplier table;
6. passes a controlled onchain result and animation comparison;
7. is explicitly unpaused.

Never point the website at V4 before its deployed address and payout table are
independently verified.

## V3 migration rule

V3 remains live while V4 is built, tested, deployed, verified, inspected, and funded. The
website must not be pointed at V4 until its deployed payout table returns the exact values
above and the contract is solvent. Any V3 pending batches and claimable balances remain
accessible through V3 after the public game moves to V4.

