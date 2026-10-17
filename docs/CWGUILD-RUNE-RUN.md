# CWGUILD Rune Run

Rune Run is a contractless, hold-to-play memory game on Ronin mainnet. Players do not wager, transfer, or approve CWGUILD. The server checks a public token balance, verifies wallet ownership with a plain-text signature, issues a six-rune sequence, and pays one successful run per wallet per UTC day from a dedicated operator wallet.

## Verified token

- Name: `CW GUILD TOKEN`
- Symbol: `CWGUILD`
- Ronin contract: `0x58DB02f56D53De7ee816904aA205D222b242F7b4`
- Decimals: `18`
- Chain ID: `2020`

## Trust model

There is no game contract. The web service decides whether a submitted sequence is valid and the project-controlled operator wallet sends the prize. Players must trust the service to apply its published rules. The page discloses this centralized model and links the token, reward wallet, and payout transaction on Ronin Explorer.

Rune Run never needs an ERC-20 allowance. A prompt asking a player to approve CWGUILD is not part of this game.

## Safe launch

Keep `CWGUILD_LIVE_ENABLED=false` until all of these are complete:

1. Create a dedicated reward-only Ronin wallet. Do not reuse an owner, treasury, deployer, or personal wallet.
2. Put only the pilot reward budget and enough RON for gas in that wallet.
3. Store its private key only in the host's encrypted secret manager as `CWGUILD_OPERATOR_PRIVATE_KEY`.
4. Choose explicit `CWGUILD_MIN_BALANCE` and `CWGUILD_PRIZE_AMOUNT` values.
5. Set `CWGUILD_STATE_FILE` to persistent private storage, such as `/var/data/cwguild-arcade-state.json` on Render.
6. Confirm the page displays the correct reward wallet and pool balance.
7. Turn on `CWGUILD_LIVE_ENABLED=true`, complete a low-value test run, and verify the transaction on Ronin Explorer.

The service refuses to start live mode without a persistent state file, payout signer, and explicit balance/prize amounts.

## Abuse limits

The server provides wallet signatures, short-lived challenges, short-lived game sessions, request throttling, one prize per wallet per UTC day, persistent claim records, serialized transaction nonces, and at-most-once payout tracking.

These controls do not make a browser memory game bot-proof and do not prevent someone from moving a qualifying token balance between wallets. Use a small, capped pilot reward wallet. For material rewards, add identity/allowlist controls or wait for a reviewed on-chain design before enabling live payouts.

## Environment

```text
CWGUILD_LIVE_ENABLED=false
CWGUILD_MIN_BALANCE=
CWGUILD_PRIZE_AMOUNT=
CWGUILD_OPERATOR_PRIVATE_KEY=
CWGUILD_STATE_FILE=
RONIN_RPC_URL=
```

The public page is `/cwguild`; the service API is `/api/cwguild`.
