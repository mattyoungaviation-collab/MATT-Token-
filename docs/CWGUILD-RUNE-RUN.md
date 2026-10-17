# CWGUILD Rune Run

Rune Run is a contractless, paid-entry memory game on Ronin mainnet. One attempt requires a direct, non-refundable transfer of exactly **500,000 CWGUILD** to the configured reward wallet. The server verifies the transfer on Ronin, consumes it once, verifies wallet ownership with a plain-text signature, then runs a five-round press-your-luck ladder. After each win, the player must either Cash Out or explicitly accept the next round. Rewards remain provisional and unpaid until Cash Out; a wrong answer or timeout forfeits the entire provisional reward. Each wallet gets one ladder attempt per UTC day.

## Verified token

- Name: `CW GUILD TOKEN`
- Symbol: `CWGUILD`
- Ronin contract: `0x58DB02f56D53De7ee816904aA205D222b242F7b4`
- Decimals: `18`
- Chain ID: `2020`

## Trust model

There is no game contract or escrow. The entry fee is transferred directly to the project-controlled reward wallet and is not returned. The web service decides whether a submitted sequence is valid and the same wallet sends cash-out rewards. Players must trust the service to apply its published rules. The page discloses the fee, the 3,000 CWGUILD maximum reward, the centralized model, and links the token, reward wallet, entry transaction, and payout transaction on Ronin Explorer.

Rune Run never needs an ERC-20 allowance. The entry action is a one-time direct `transfer` of 500,000 CWGUILD. A prompt asking a player to approve an allowance is not part of this game.

## Safe launch

Keep `CWGUILD_LIVE_ENABLED=false` until all of these are complete:

1. Create a dedicated reward-only Ronin wallet. Do not reuse an owner, treasury, deployer, or personal wallet.
2. Put only the pilot reward budget and enough RON for gas in that wallet.
3. Store its private key only in the host's encrypted secret manager as `CWGUILD_OPERATOR_PRIVATE_KEY`.
4. Choose explicit `CWGUILD_MIN_BALANCE` and base-round `CWGUILD_PRIZE_AMOUNT` values.
5. Set `CWGUILD_STATE_FILE` to persistent private storage, such as `/var/data/cwguild-arcade-state.json` on Render.
6. Confirm the page displays the correct reward wallet and pool balance.
7. Turn on `CWGUILD_LIVE_ENABLED=true`, complete a low-value test run, and verify the transaction on Ronin Explorer.

The service refuses to start live mode without a persistent state file, payout signer, and explicit balance/prize amounts.

## Payout and abuse limits

Rune Run has a hard lifetime payout ceiling of **2,000,000 CWGUILD**. Confirmed, submitted, and in-flight claims all count against the ceiling, so concurrent winners cannot push the game over the limit.

The reward ladder uses the configured base-round prize at these fixed multipliers:

| Round | Signal length | Timer | Total provisional reward |
| --- | ---: | ---: | ---: |
| 1 | 6 | 8 seconds | 1× base |
| 2 | 7 | 7 seconds | 3× base |
| 3 | 8 | 6 seconds | 7× base |
| 4 | 9 | 5 seconds | 15× base |
| 5 | 10 | 4 seconds | 30× base |

With a 100 CWGUILD base prize, the cash-out choices are 100, 300, 700, 1,500, and 3,000 CWGUILD. The maximum reward is 0.6% of the 500,000 CWGUILD entry fee. Choosing the next round is an explicit risk action and does not make another token transfer.

The server requires two Ronin confirmations, verifies the exact token/from/to/amount transfer log, accepts only recent entry transactions, and permanently prevents transaction-hash reuse. It also provides wallet signatures, short-lived challenges, server-timed rounds, request throttling, one ladder attempt per wallet per UTC day, persistent entry/run/claim records, serialized transaction nonces, and at-most-once payout tracking. Every post-pattern recall round randomizes both the starting position and direction. The sequence grows while the server-enforced timer shrinks, making a simple screen recording insufficient on its own.

These controls do not make a browser memory game bot-proof, cannot prevent all recording or automation, and do not prevent someone from moving a qualifying token balance between wallets. Use a small, capped pilot reward wallet. For material rewards, add identity/allowlist controls or wait for a reviewed on-chain design before enabling live payouts.

## Environment

```text
CWGUILD_LIVE_ENABLED=false
CWGUILD_MIN_BALANCE=
CWGUILD_PRIZE_AMOUNT=
CWGUILD_ENTRY_AMOUNT=500000
CWGUILD_OPERATOR_PRIVATE_KEY=
CWGUILD_STATE_FILE=
RONIN_RPC_URL=
```

The public page is `/cwguild`; the service API is `/api/cwguild`.
