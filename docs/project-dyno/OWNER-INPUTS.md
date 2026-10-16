# Owner configuration recorded 2026-10-12

These are deployment draft inputs, not permission to deploy or move assets.

| Field | Selected value | Status |
|---|---|---|
| Treasury multisig | `0xBacE355D23d378a6E1adD986E53a18Dd12E6EeAc` | Ronin code and 2-of-3 confirmed by read-only RPC |
| NFT collection | `0xd1b248DEE3a4a0E9215e349dCe237D4B6d6bB8A3` | Ethereum ERC721; no code at this address on Ronin |
| NFT token | `1358` | Ethereum owner matches supplied depositor |
| Depositor | `0x1DAb596D0121C250a24B00137E84170FA6874be6` | NFT owner and one Ronin multisig owner |
| Discord server | `1493734022281429257` | Owner-supplied; live OAuth membership test pending |
| Discord application | `1559100671309905922` | Owner-supplied; portal configuration/secret pending |
| Website | `https://matttoken.com` | Owner-selected |
| OAuth callback | `https://matttoken.com/api/discord/callback` | Selected to match implemented callback route |
| RPC provider | Alchemy | Private local Ronin fork endpoint saved; production and Ethereum endpoint readiness still requires separate validation |
| Operations budget | `25000000000000000000` base units (25 RON) | Owner-selected; funding and measured adequacy pending |
| Launch liquidity | Owner expects 5× current liquidity in existing 1% MATT/WRON Katana pool | Future plan only; token amounts, position range and transaction not yet supplied or verified |
| Identity signer / primary / backup keeper | `0x6969696934a4120C44DDF6b6B3084FdA0B4E1c51` / `0x111111114469E9938d362bC0565E3b3530e30813` / `0x696969694cA7977C2BdD661bf5359068E5e43d6C` | Owner-approved; no on-chain grant/deployment |
| Emergency admin | `0x1DAb596D0121C250a24B00137E84170FA6874be6` | Owner-approved full unilateral contract authority; no on-chain grant/deployment |
| Legal review | Owner reports reviewed | No document or independent legal conclusion recorded |

Public RPC evidence at UTC `2026-10-12T07:17:16.459Z`: Ronin chain 2020 block 62,160,324 and Ethereum chain 1 block 26,174,839. These observations are snapshots; rerun before transactions.

Fresh read-only snapshot at UTC `2026-10-12T23:49:01.202Z`: Ronin block 62,190,076 again returned a 2-of-3 Safe and the three owners below. Ethereum block 26,179,786 returned 7,694 collection code bytes, ERC721 support and `ownerOf(1358) = 0x1DAb596D0121C250a24B00137E84170FA6874be6`. The nominated collection still has no code on Ronin. This verifies current ownership at those blocks only, not future custody or manual prize delivery.

Ronin multisig owners returned by `getOwners()`:

- `0x1DAb596D0121C250a24B00137E84170FA6874be6`
- `0xF79913cB83Cc9CABD95D0ba9250103fbb939f984`
- `0x57Dc8DB3a263506a0344eC15B4C623EBb8E589F4`

The collection has 7,694 bytes of deployed code on Ethereum and reports ERC721 support. `ownerOf(1358)` returned the depositor. On Ronin the collection has zero code. The owner subsequently selected manual NFT delivery from Ethereum and manual RON payout initiation. See `MANUAL-PRIZES.md`. No bridge or asset transfer has been executed.

Reproduce read-only evidence: `node scripts/dyno/inspect-owner-inputs.js`. Optional private environment endpoints: `RONIN_RPC_URL`, `DYNO_ETHEREUM_RPC_URL`. The inspector never signs or sends transactions and does not log endpoint credentials.
