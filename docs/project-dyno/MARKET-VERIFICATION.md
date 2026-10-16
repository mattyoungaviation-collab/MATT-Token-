# Read-only market evidence — not production clearance

Observed 2026-10-12T10:24:18.857Z using the official public Ronin RPC. Chain 2020, block 62165934, hash `0x8db669a3d4fc30ef5efc1c5d67b03178dbbbf6744bdb75853f04bbdc523a2ccd`. All calls/code reads were pinned to that block and its hash rechecked. No approval, swap, signing or asset movement occurred.

| Input | Evidence |
|---|---|
| MATT candidate | `0xa5450417bdca0bdfb058ffe41205400ffda1174d`; deployed code, name Matt, symbol MATT, decimals 18 |
| Pool candidate | `0xa517e05e96728e80284f2ae157ddf309449d7ce8`; readable V3-style slot0/fee/liquidity; V2 reserve/cumulative probes unavailable |
| token0 | MATT candidate |
| token1 | `0xe514d9DEB7966c8BE0ca922de8a064264eA6bcd4`; reads Wrapped Ronin/WRON/18 decimals |
| Factory | `0x1f0B70d9A137e3cAEF0ceAcD312BC5f81Da0cC0c`; getPool(token0,token1,10000) matches candidate |
| Fee | 10000; official Katana source defines millionths of input, thus 1% |
| Active liquidity | 17629161653198013256421921 (raw liquidity units, not a RON reserve or sufficient-depth claim) |
| Observations | slot0 reports index 31/cardinality 32; observe([3600,0]) failed |

WRON totalSupply returned zero. Do not infer transfer/deposit/withdraw compatibility from its name. The failed observation call is classified conservatively as unsupported/read-unavailable; it does not prove the precise cause. Observation cardinality alone is not proof of one hour of initialized history. The inspection now probes shorter windows for diagnostics, never as an authorized spot fallback.

Run `node scripts/dyno/inspect-market.js` for a fresh read-only report (optional private `DYNO_RPC_URL` supplied through environment, never logged). The public endpoint is for development evidence, not production reliability. Reports deliberately keep `productionReady=false`.

Official references: [Ronin networks](https://docs.roninchain.com/developers/network), [Katana pool fee interface](https://github.com/ronin-chain/katana-v3-contracts/blob/mainnet/src/core/interfaces/pool/IKatanaV3PoolImmutables.sol), [fee math](https://github.com/ronin-chain/katana-v3-contracts/blob/mainnet/src/core/libraries/SwapMath.sol), [legacy exact-input interface](https://github.com/ronin-chain/katana-v3-contracts/blob/mainnet/src/periphery/interfaces/ISwapRouter.sol), [aggregate-router source](https://github.com/ronin-chain/katana-operation-contracts). Source ABI compatibility does not identify a deployed router or establish bytecode equivalence. The operation-contract deployment directory did not provide router address artifacts during this inspection. Do not substitute addresses from another chain also named Katana.

## Local guard changes

Follow-up inspection at 2026-10-12T10:34:01.243Z: block 62166226, hash `0xb08321e5af6b88f0b8987336769a1f8e0337ac367d7a4a54806849680eea98d2`. Current/5/15/30-minute observation probes succeeded; 60-minute probe failed again. This narrows the problem but does not prove its cause or authorize shortening the reference window. No transactions were sent.

The DYNO-only guard extension now checks factory canonical pool identity, correct pair, pool code, fee below 1,000,000, active and harmonic liquidity, usable observations, unlocked pool and spot/reference deviation. Reference output deducts the pool fee before pricing, with explicit integer floors. Zero slippage remains a nonzero minimum. Deviation rounding is upward, so fractional basis points cannot bypass a zero-tolerance setting. Parameter events include old/new values and actor.

Ten local controlled-oracle tests pass, including both orientations, fee/slippage/rounding, malformed/missing observations, insufficient liquidity, transient manipulation and a deliberately sustained manipulation that passes when spot and TWAP agree. This last case documents risk, not protection. No other game interfaces or business logic were changed.

## Required before enabling swaps

Follow-up at 2026-10-12T17:08:05.779Z, Ronin block 62178048, hash `0x57d1b3870e783f4cde340411a4cdb5739925cf71b99554d42037ff44b57a661a`: all current/5/15/30/60-minute probes succeeded. Earlier failures are historical, not the current observation result. The default remains 60 minutes; no spot fallback or automatic protection reduction was added. Further public RPC calls encountered rate limits. Continuous history availability remains a production prerequisite.

The new aggregate adapter implements official V3 command encoding as a separate integration with no arbitrary commands or router approvals. Three local command-mock checks passed. Live AggregateRouter address/code equivalence and real fork trades remain unverified; the legacy adapter does not establish current router compatibility. See [launch preparation](LAUNCH-PREPARATION.md).

Verify deployed router/factory/WRON bytecode and exact route/ABI. Verify tax/rebase/permit behavior; reproduce actual 700,000-MATT sales and hourly buy sizes on a pinned fork, including tick crossings, output measurement and wrap/unwrap. Establish initialized 60-minute history and availability policy. Measure legitimate impact and manipulation cases to select a mandatory production liquidity floor. Check rate limits/finality on the selected provider. A TWAP and these interface reads do not establish market safety.

## Finality policy

Current official Ronin network documentation identifies OP Stack and approximately 12-minute L1 finality. Twelve L2 blocks are not equivalent to that finality. Local indexer production mode now requires the provider's `finalized` block tag, verifies its canonical hash before/after a batch, and fails closed for missing/malformed/lagging anchors. A confirmation-count policy remains local/test only. The official public endpoint returned a finalized block during read-only inspection; this is not a reliability test of the selected private Alchemy endpoint. Provider finality semantics and monitoring still need acceptance verification.
