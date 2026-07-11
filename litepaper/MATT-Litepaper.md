# MATT Litepaper

**Version 1.0 — July 2026**  
**Built by Matt. Backed by Matt.**

## Summary

MATT is a community token on Ronin that celebrates the awesomeness of simply being a Matt. It is intentionally simple: a fixed supply, no transfer taxes, no blacklist, no wallet limits, no pause switch, and no administrator capable of minting additional tokens.

## Contract design

MATT uses OpenZeppelin's ERC-20, ERC20Burnable, and ERC20Permit implementations. The complete supply is minted once in the constructor to the designated treasury. The contract has no ownership module and therefore nothing needs to be renounced after deployment.

| Property | Value |
|---|---|
| Name | Matt |
| Symbol | MATT |
| Network | Ronin |
| Standard | ERC-20 + ERC-2612 Permit |
| Decimals | 18 |
| Initial supply | 10,000,000,000 MATT |
| Future minting | Impossible |
| Taxes | None |
| Holder burn | Enabled |

## Initial allocation

- **50% — 8,000,000,000 MATT:** planned for initial liquidity.
- **50% — 8,000,000,000 MATT:** retained in the public project treasury for community programs and future decisions.

The planned initial pairing is 8,000,000,000 MATT with 1 RON. This creates extremely shallow liquidity. Small transactions may cause severe price changes, price impact, and slippage. The amount may be revised before the irreversible mainnet launch if testing shows unacceptable trading behavior.

## Security principles

The contract deliberately excludes privileged controls. There is no owner, external mint function, tax logic, blacklist, whitelist, transfer lock, maximum-wallet rule, upgrade proxy, or emergency pause. Source code and tests are public under the MIT License. Public review is not equivalent to a professional security audit.

## Roadmap

### Phase 1 — Foundation
Test on Saigon, verify the source, deploy on Ronin, publish official project materials, and establish a Katana pool.

### Phase 2 — Community
Run community activities, publish treasury updates, host contests and giveaways, and gather feedback.

### Phase 3 — Growth
Explore integrations and partnerships within the Ronin ecosystem while avoiding promises of profit or guaranteed listings.

## Risks and disclaimer

MATT is experimental. Digital assets can lose all value. Thin liquidity creates substantial volatility and may prevent holders from selling at an expected price. Smart contracts, wallets, websites, exchanges, and third-party infrastructure can fail or be exploited. Nothing in this document is financial, investment, legal, or tax advice. Participation is voluntary and at each participant's own risk.
