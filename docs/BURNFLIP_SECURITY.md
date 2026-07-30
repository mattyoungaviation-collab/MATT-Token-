# BurnFlip Security Notes

## Security properties

- **No wager custody:** ERC-20 wagers go from the player directly to the immutable treasury; native RON is forwarded in the same atomic transaction.
- **Exact-transfer enforcement:** an ERC-20 wager is accepted only if the Safe balance increases by the exact amount. Fee-on-transfer, rebasing during transfer, and other incompatible behavior are rejected.
- **MATT-only settlement:** the Reward Vault contains only MATT and does not receive wager assets.
- **Restricted vault:** only the configured game may pay or burn. MATT cannot be rescued through the accidental-token function.
- **Solvency reservation:** every pending bet reserves its full possible payout against the current vault MATT balance.
- **Historical terms:** the quote, payout, burn, tick, asset, and amount are stored at placement, so later admin configuration does not rewrite a pending bet.
- **Canonical pools:** asset setup validates code, factory, token pair, and active liquidity.
- **Manipulation resistance:** pricing uses a fixed 30-minute TWAP plus a per-pool harmonic-liquidity floor. There is no spot or manual fallback.
- **MATT identity pricing:** a MATT wager is exactly the settlement token, so it is valued 1:1 with no pool, rate input, or oracle manipulation surface.
- **Replay resistance:** commitments bind player, asset, choice, amount, game, and chain; one pending bet is allowed per wallet.
- **Operational brakes:** game and vault start paused. Asset, pool, payout, burn, and vault controls are owner-only; economic and oracle configuration changes require the game to be paused.
- **Reentrancy protection:** every value-moving public path uses `ReentrancyGuard`; ERC-20 operations use `SafeERC20`.

## Trust assumptions

- The configured admin can pause, change supported pools, change future-bet payout/burn settings, change the reward vault while the game is paused with no reservations, and rescue accidental game tokens to the immutable treasury.
- The treasury Safe controls all wager assets after acceptance.
- Katana V3 factory and pool code behave according to the deployed protocol.
- The live MATT token continues to implement the existing OpenZeppelin-style `burn(uint256)` behavior.
- Ronin block producers do not profitably bias the one-bit outcome. The player secret prevents advance knowledge, but future-block hashes are not equivalent to a verifiable-randomness oracle.

## Residual risks

### Randomness

Commit/reveal with a future block hash is preserved for UX compatibility. A block producer may have limited influence over block construction, and a player can refuse to reveal a known loss. Expiry therefore burns the same configured loss amount, removing the player’s economic benefit from withholding. For materially larger wager limits, migrate randomness to a reviewed Ronin-compatible VRF.

### Oracle preparation

Calling `increaseObservationCardinalityNext()` increases capacity but does not instantly create history. Pools need swaps/observation writes and a full 30-minute lookback before launch. Cardinality and observation age must be monitored after long inactivity.

MATT itself is not subject to this oracle requirement. Its supported-asset
configuration must use the zero pool and zero liquidity floor; any attempt to
attach a pool or nonzero floor is rejected.

### Economic risk

A 30-minute TWAP increases manipulation cost but cannot make a shallow market safe. The derived minimum harmonic-liquidity floor is an operational control, not a proof of economic security. Set conservative wager limits externally or add per-asset on-chain caps before opening large bets.

### Vault depletion

Reservations prevent accepting a bet whose maximum payout is not covered at placement. Burns and payouts reduce the vault, so refill and alerting procedures are still required. Direct external MATT transfers to the vault are safe but should be reconciled.

### ERC-20 behavior

Exact Safe balance-delta verification rejects common transfer taxes. Tokens with deny lists, pausing, callbacks, or nonstandard balance behavior may still become unavailable and should be removed promptly.

### Frontend secret custody

Reveal secrets are stored in browser local storage. Clearing storage or switching devices can make manual reveal impossible. Expiry remains settleable by anyone and is a loss. The confirmation UI warns the player, but support procedures should also explain this.

## Deployment recommendations

- Complete Saigon testing with the exact bytecode and operational accounts.
- Use a hardware-backed admin and treasury Safe policies.
- Independently verify all mainnet constructor arguments and pools.
- Establish alerts for pauses, pool changes, liquidity-floor failures, vault coverage, expirations, and unusually large quotes.
- Apply a conservative application-level amount policy until an on-chain per-asset cap is reviewed and deployed.
- Commission an independent Solidity audit and a jurisdiction-specific wagering review before production use.

## Explicit non-claims

The included tests demonstrate intended behavior under modeled conditions. They are not a security audit, an economic guarantee, or legal approval.
