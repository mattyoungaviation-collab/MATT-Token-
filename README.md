# MATT Token and Ecosystem Games

**Built by Matt. Backed by Matt.**

This repository contains the live MATT token source, ecosystem contracts, and website. The existing MATT token is not modified by the BurnFlip refactor.

## Live MATT token

- Ronin mainnet: `0xa5450417BDCa0BDfB058ffE41205400FfDA1174d`
- Name / symbol: `Matt` / `MATT`
- Decimals: `18`
- Fixed initial supply: `10,000,000,000 MATT`
- Extensions: OpenZeppelin `ERC20Burnable` and `ERC20Permit`
- Taxes, blacklist, pausing, external minting, and upgrades: none

The token has no owner. BurnFlip uses its existing `burn(uint256)` function and does not modify, proxy, or upgrade the live token.

## Universal BurnFlip replacement

`MattCoinFlipBurn` retains the existing heads/tails commit-and-reveal experience while changing the economic flow:

1. The player selects a supported ecosystem asset and an amount.
2. MATT wagers use exact `1 MATT = 1 MATT` identity pricing; every other asset derives its MATT value from a 30-minute Katana V3 TWAP.
3. The wager is transferred directly to the immutable treasury Safe.
4. A win pays the stored MATT value multiplied by the configured payout multiplier from `MattRewardVault`.
5. A loss burns the configured percentage of the stored MATT value from the vault.

Defaults are a `2x` MATT payout and a `75%` MATT-equivalent burn. Wager assets are never paid back to players and are never retained by BurnFlip.

Mainnet constants:

- Treasury Safe: `0xBacE355D23d378a6E1adD986E53a18Dd12E6EeAc`
- Admin: `0xF79913cB83Cc9CABD95D0ba9250103fbb939f984`
- Katana V3 factory: `0x1f0B70d9A137e3cAEF0ceAcD312BC5f81Da0cC0c`
- Chain ID: `2020`

The replacement is intentionally staged with no frontend contract address and both new contracts start paused. This prevents the website from sending the new ABI to the old live game before deployment and configuration are complete.

## Reward Vault

`MattRewardVault` stores only MATT. BurnFlip is the only address that may call `payWinner()` and `burnMatt()`. The vault exposes deposits/refills, pause controls, and rescue of accidental non-MATT tokens; it has no arbitrary MATT transfer or MATT rescue method.

## Supported-asset configuration

Canonical asset metadata and discovered pool addresses are in [`config/burnflip.ronin.json`](config/burnflip.ronin.json). Run discovery again before deployment:

```bash
npm run discover:coinflip-burn:pools
```

MATT is enabled without an oracle pool because its settlement value is exactly 1:1. USDC is disabled until its selected pool reliably retains the full 30-minute observation, and NOTUS is disabled because its canonical MATT V3 pool currently has zero active liquidity.

## Build and test

Use Node 20–22, matching `package.json`.

```bash
npm ci
npm run compile
npm run build:burnflip
npm run test:coinflip-burn
```

The focused suite includes unit coverage for the game and vault, plus an end-to-end integration test that proves wager assets reach the treasury while MATT settlement comes from the vault.

If a previously deployed universal BurnFlip omitted MATT, deploy the paused
`MattCoinFlipBurnMatt` replacement, configure it, pause the funded vault, and
switch the vault authorization only after the previous game has zero reserved
payouts. The funded vault is reused; do not deploy a second vault.

## Deployment overview

Deployment is deliberately multi-phase:

```bash
# 1. Deploy paused contracts
npm run deploy:coinflip-burn:ronin

# 2. Prepare Katana V3 observation capacity
BURNFLIP_PREPARE_ONLY=true npm run configure:coinflip-burn:ronin

# 3. Wait for at least one complete 30-minute observation window, then configure
npm run configure:coinflip-burn:ronin

# 4. Fund and unpause the vault, verify every quote, then unpause the game
# 5. Set the deployed address/block in the website and hosting environment
```

Read [`docs/BURNFLIP_MIGRATION.md`](docs/BURNFLIP_MIGRATION.md) before any mainnet transaction.

## Documentation

- [`docs/BURNFLIP_ARCHITECTURE.md`](docs/BURNFLIP_ARCHITECTURE.md) — contract, oracle, frontend, and backend architecture
- [`docs/BURNFLIP_MIGRATION.md`](docs/BURNFLIP_MIGRATION.md) — deployment and cutover runbook
- [`docs/BURNFLIP_SECURITY.md`](docs/BURNFLIP_SECURITY.md) — trust model, controls, and residual risks
- [`docs/COIN-FLIP-LAUNCH.md`](docs/COIN-FLIP-LAUNCH.md) — legacy game reference

## Website

```bash
npm run site
```

The existing `/burnflip` route and visual language are preserved. The refactored interface adds the asset selector, on-chain MATT quote, payout/burn preview, wallet balance, confirmation modal, and MATT-only result breakdown.

## Safety boundary

No private key belongs in this repository. Use an encrypted deployment environment, test the exact release on Saigon, obtain an independent smart-contract audit, and obtain jurisdiction-specific advice before enabling real-value wagering.
