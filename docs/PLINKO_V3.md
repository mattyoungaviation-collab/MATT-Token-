# MATT Plinko V3

## Game rules

- Sixteen peg rows and seventeen payout slots.
- One coin costs exactly 10,000 MATT.
- A player may buy 1–100 coins per VRF batch.
- One official Ronin VRF seed fixes every result in the batch.
- Multipliers include returned principal.

Payout board:

`50× | 25× | 10× | 5× | 2× | 1.5× | 0.8× | 0.7× | 0.2× | 0.7× | 0.8× | 1.5× | 2× | 5× | 10× | 25× | 50×`

The exact theoretical RTP is 92.6007080078125%. The exact house edge is
7.3992919921875%.

## Hard payout cap

A full 100-coin batch costs 1,000,000 MATT. Since no coin can pay more than
50×, no possible 100-coin batch can pay more than 50,000,000 MATT.

The contract reserves 49,000,000 MATT of additional bankroll before accepting
a full batch. Pending wagers, reserved liabilities, and claimable player funds
remain protected from treasury withdrawal.

## Release safety

V3 is a separate paused-by-default deployment. V2 remains unchanged until V3:

1. compiles and passes its complete contract suite;
2. is deployed and source verified;
3. is inspected while paused;
4. is funded with at least 49,000,000 MATT of unreserved bankroll;
5. is connected to a V3 frontend using the exact same multiplier table;
6. passes a controlled onchain result and animation comparison;
7. is explicitly unpaused.

Never point the website at V3 before its deployed address and payout table are
independently verified.
