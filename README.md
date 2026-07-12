# MATT Token

**Built by Matt. Backed by Matt.**

MATT is a fixed-supply community ERC-20 for Ronin. The token contract is deliberately minimal and has no administrator or owner controls.

## Final specification

- Name: `Matt`
- Symbol: `MATT`
- Decimals: `18`
- Initial and maximum supply: `10,000,000,000 MATT`
- Initial recipient: `0xF79913cB83Cc9CABD95D0ba9250103fbb939f984`
- Extensions: OpenZeppelin `ERC20Burnable` and `ERC20Permit`
- Taxes, blacklist, pause, wallet limit, external minting, upgrades: **none**
- License: MIT

There is no ownership to renounce because the token contract never inherits `Ownable` and exposes no privileged administrative function.

## MATT Coin Flip

`MattCoinFlip` is a separate optional wagering contract. It does not modify or upgrade MATT.

- Bet range: `1` to `1,000,000 MATT`
- Correct call: contract pays `2 × stake`
- Wrong call: stake is transferred to the immutable treasury
- Randomness design: browser secret commitment plus a future Ronin block hash
- Settlement: second signed reveal transaction
- Unrevealed timeout: stake expires to treasury after 200 blocks
- Solvency: all pending maximum payouts are reserved from owner withdrawals

See [`docs/COIN-FLIP-LAUNCH.md`](docs/COIN-FLIP-LAUNCH.md) before deploying or funding the game.

## Safety boundary

The repository contains no real private key. Keep deployment keys only in local environment variables. Never send a private key or recovery phrase to anyone.

The coin flip is unaudited wagering software. Test on Saigon, obtain an independent security review, and obtain jurisdiction-specific legal advice before enabling mainnet bets.

## Local validation

```bash
npm ci
cp .env.example .env
npm test
npm run compile
```

Windows users should follow [`docs/WINDOWS-SAIGON-DEPLOY.md`](docs/WINDOWS-SAIGON-DEPLOY.md).

## Saigon deployment first

Token:

```bash
npm run deploy:saigon
npm run inspect:saigon
npm run verify:saigon
```

Coin flip:

```bash
npm run deploy:coinflip:saigon
npm run inspect:coinflip:saigon
npm run verify:saigon
```

Only after the test deployments are verified and fully tested should the corresponding Ronin commands be used.

## Website

```bash
npm run site
```

The included `render.yaml` creates a Render service named `matt-token`. The on-chain game remains disabled until its deployed address is entered in `website/public/coin-game-config.js`.

## Liquidity warning

MATT launched with shallow RON-side liquidity. Small trades may create severe price movement, slippage, and misleading percentage gains. Review every swap carefully.

## Visibility

Contract verification, public metadata, a project website, project registration, and active liquidity support legitimate discoverability. They do not guarantee that every Ronin interface will index MATT for name-only search. Until indexed, users may need the verified contract address.

See [`docs/LAUNCH-CHECKLIST.md`](docs/LAUNCH-CHECKLIST.md) for the original token launch sequence.

## Live Ronin deployment

- Contract: `0xa5450417BDCa0BDfB058ffE41205400FfDA1174d`
- Network: Ronin Mainnet (chain ID 2020)
- Source verification: Exact Match
- Compiler: Solidity 0.8.28, Cancun, optimizer enabled with 200 runs
- Initial liquidity allocation: 8,000,000,000 MATT
- Official X: https://x.com/Crafting_skill
- Website: https://matt-token.onrender.com
