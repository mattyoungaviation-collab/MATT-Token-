# MATT Coin Flip launch guide

The coin flip is a separate contract. It does not modify or upgrade the live MATT token.

## Player flow

1. Connect through WalletConnect.
2. Select Heads or Tails and enter `1` to `1,000,000 MATT`.
3. Sign an ERC-2612 permit when supported, then confirm the bet transaction. Wallets without permit support use an approval transaction followed by the bet transaction.
4. The contract locks the stake and commits the player's browser-generated secret before the entropy block exists.
5. After the future Ronin block is mined, the player signs `revealAndSettle`.
6. The contract calculates Heads or Tails and settles in that same transaction:
   - correct choice: player receives `2 × stake`
   - wrong choice: the stake is transferred to the immutable treasury
7. If the secret is not revealed within 200 blocks, anyone may expire the bet and send the stake to treasury.

The reveal secret is stored only in the player's browser until settlement. Clearing browser storage during a pending bet can make the bet unrevealable.

## Security model

The contract uses commit/reveal instead of same-transaction block variables. The player commits to a 32-byte secret before the future entropy block exists. The result combines that secret with the future block hash, bet ID, contract address, and chain ID.

Important limitations:

- This is not an external VRF.
- Validators can influence block production, although they do not know the committed secret.
- A player can refuse to reveal a losing result, but doing so does not save the stake: the timeout sends it to treasury.
- The owner may pause new bets and withdraw only bankroll not reserved for pending maximum payouts.
- The contract must be funded before accepting bets.
- This code should be independently audited before handling material value.

## Contract constants

- Minimum bet: `1 MATT`
- Maximum bet: `1,000,000 MATT`
- Win payout: `2 × stake`, including return of the original stake
- Entropy delay: `1 block`
- Reveal window: `200 blocks`
- One pending bet per wallet
- MATT token: `0xa5450417BDCa0BDfB058ffE41205400FfDA1174d`
- Treasury: `0xF79913cB83Cc9CABD95D0ba9250103fbb939f984`

## Saigon test deployment

Create or deploy a MATT-compatible ERC-20 permit token on Saigon, then set:

```text
MATT_TOKEN_ADDRESS=0x...
TREASURY_ADDRESS=0x...
COIN_FLIP_OWNER=0x...
SAIGON_RPC_URL=https://...
DEPLOYER_PRIVATE_KEY=0x...
```

Run:

```bash
npm ci
npm test
npm run compile
npm run deploy:coinflip:saigon
npm run inspect:coinflip:saigon
npm run verify:saigon
```

Test at minimum:

- permit placement
- approval fallback
- Heads win
- Tails win
- Heads loss
- Tails loss
- reveal after the entropy block
- unrevealed expiry
- maximum bet rejection
- insufficient bankroll rejection
- pause and unpause
- bankroll withdrawal reserve protection
- wallet reconnect with a pending secret

## Ronin deployment

Use a dedicated deployer and a deliberate owner address. The owner can pause new bets and withdraw unreserved bankroll, so a hardware wallet or multisig is strongly preferred.

Render/local environment:

```text
MATT_TOKEN_ADDRESS=0xa5450417BDCa0BDfB058ffE41205400FfDA1174d
TREASURY_ADDRESS=0xF79913cB83Cc9CABD95D0ba9250103fbb939f984
COIN_FLIP_OWNER=0x...
RONIN_RPC_URL=https://...
DEPLOYER_PRIVATE_KEY=0x...
```

Deploy and verify:

```bash
npm run deploy:coinflip:ronin
npm run inspect:coinflip:ronin
npm run verify:ronin
```

Record the deployed `MattCoinFlip` address and verify its constructor values on the current Ronin Explorer.

## Fund the bankroll

The contract receives the player's stake before checking coverage. To accept a bet of `X MATT`, it needs at least `X MATT` of unreserved bankroll before that bet.

Examples:

- support a single `100,000 MATT` bet: at least `100,000 MATT` bankroll
- support a single `1,000,000 MATT` bet: at least `1,000,000 MATT` bankroll
- support several simultaneous wallets: fund enough for the sum of all potential extra winnings

Fund using either:

1. approve MATT to the game and call `fundBankroll(amount)`, or
2. transfer MATT directly to the game contract

The website reads `maxAcceptableBet()` and prevents bets larger than current bankroll coverage.

## Enable the website

Edit `website/public/coin-game-config.js`:

```js
contractAddress: "0xDEPLOYED_MATT_COIN_FLIP_ADDRESS"
```

Commit and deploy that one configuration change. The Hub will then:

- verify WalletConnect is on Ronin Mainnet
- display wallet MATT, bankroll, and current maximum bet
- attempt ERC-2612 permit first
- fall back to approval when needed
- save the reveal secret locally
- recover an active pending bet after refresh
- wait for the entropy block
- request the reveal transaction
- display the on-chain result and payout

## Production warning

Token wagering can be regulated as gambling or gaming depending on jurisdiction. Before enabling mainnet wagers, obtain legal advice about licensing, age restrictions, sanctions, geofencing, consumer disclosures, accounting, taxes, and whether the service may be offered from your location or to users in theirs.
