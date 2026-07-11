# MATT Token

**Built by Matt. Backed by Matt.**

MATT is a fixed-supply community ERC-20 for Ronin. The contract is deliberately minimal and has no administrator or owner controls.

## Final specification

- Name: `Matt`
- Symbol: `MATT`
- Decimals: `18`
- Initial and maximum supply: `10,000,000,000 MATT`
- Initial recipient: `0xF79913cB83Cc9CABD95D0ba9250103fbb939f984`
- Extensions: OpenZeppelin `ERC20Burnable` and `ERC20Permit`
- Taxes, blacklist, pause, wallet limit, external minting, upgrades: **none**
- License: MIT

There is no ownership to renounce because the contract never inherits `Ownable` and exposes no privileged administrative function.

## Safety boundary

The repository contains no real private key. Keep the deployment key only in a local `.env` file. Never send a private key or recovery phrase to anyone.

## Local validation

```bash
npm ci
cp .env.example .env
npm test
npm run compile
```

Windows users should follow [`docs/WINDOWS-SAIGON-DEPLOY.md`](docs/WINDOWS-SAIGON-DEPLOY.md).

## Saigon deployment first

```bash
npm run deploy:saigon
npm run inspect:saigon
npm run verify:saigon
```

Only after the test deployment is verified and fully tested:

```bash
npm run deploy:ronin
npm run inspect:ronin
npm run verify:ronin
```

## Website

```bash
npm run site
```

The included `render.yaml` creates a Render service named `matt-token`. After mainnet deployment, replace every `DEPLOYED_CONTRACT_ADDRESS` placeholder before publishing.

## Liquidity warning

The current plan is 5,000,000,000 MATT paired with 1 RON. This is an extremely shallow pool. Small trades may create severe price movement, slippage, and misleading percentage gains. Test the exact setup before mainnet.

## Visibility

Contract verification, public metadata, a project website, project registration, and active liquidity support legitimate discoverability. They do not guarantee that every Ronin interface will index MATT for name-only search. Until indexed, users may need the verified contract address.

See [`docs/LAUNCH-CHECKLIST.md`](docs/LAUNCH-CHECKLIST.md) for the full sequence.

## Live Ronin deployment

- Contract: `0xa5450417BDCa0BDfB058ffE41205400FfDA1174d`
- Network: Ronin Mainnet (chain ID 2020)
- Source verification: Exact Match
- Compiler: Solidity 0.8.28, Cancun, optimizer enabled with 200 runs
- Initial liquidity allocation: 8,000,000,000 MATT
- Official X: https://x.com/Crafting_skill
- Planned website: https://matt-token.onrender.com
