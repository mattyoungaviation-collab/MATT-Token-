# MATT concentrated liquidity position plan

This plan records candidate Katana V3 positions using the 1% fee tier. Quotes depend on the displayed pool price and must be rechecked immediately before approval.

## FIRE position

- Reference price: 3,088.62 MATT per FIRE
- Range: 2,163.7888 to 4,022.2029 MATT per FIRE
- Deposit: 25,000 FIRE and approximately 101,743,251 MATT
- Coverage from the reference price: -29.94% to +30.23%

## WATER high risk version

- Reference price: 787.6748 MATT per WATER
- Range: 706.0401 to 879.7705 MATT per WATER
- Deposit: approximately 132,534.8515 WATER and 103,326,582.67 MATT
- Coverage from the reference price: -10.36% to +11.69%
- The remaining 42,465.1485 WATER stays outside this position.

## WATER low risk version

- Reference price: 787.6748 MATT per WATER
- Range: full range
- Deposit: approximately 131,179.2476 WATER and 103,326,582.67 MATT
- The remaining 43,820.7524 WATER stays outside this position.
- This minimizes out-of-range risk but has the lowest capital efficiency.

## WATER all token compromise

- Reference price: 787.6748 MATT per WATER
- Range: 638.8547 to 1,053.2670 MATT per WATER
- Deposit: 175,000 WATER and approximately 101,335,353 MATT
- Coverage from the reference price: -18.89% to +33.72%
- This uses all WATER while remaining below the observed 103,326,582.67 MATT balance.

## USDC position using 300 million MATT

- Reference price: 890,904.4369 MATT per USDC
- Range: 522,792.0322 to 991,433.3687 MATT per USDC
- Deposit for exactly 300,000,000 MATT: approximately 74.9187924 USDC
- Deposit when using all 75 USDC: approximately 300,325,183 MATT
- Under the strict 500 million MATT portfolio budget, the FIRE position plus the WATER all-token compromise leave 296,921,396 MATT. At this range, pair that exact remainder with approximately 74.1499747 USDC, leaving approximately 0.8500253 USDC outside the position.
- Coverage from the reference price: -41.32% to +11.28%
- This range is asymmetric because 300 million MATT substantially exceeds the current value of 75 USDC. The position reaches its upper boundary after an approximately 11.28% increase in MATT per USDC.

## Boundary behavior

For these pairs, the paired asset is token 0 and MATT is token 1. At or below the minimum MATT-per-paired-token price, the position becomes entirely the paired asset. At or above the maximum, it becomes entirely MATT. Positions earn fees only while the pool price is inside their range.
