# MATT Slots V1 — Resource Rush

MATT Slots is a five-reel, three-row, twenty-payline game on Ronin. Players prepay one to twenty-five spin credits in MATT, then create exactly one Ronin VRF request every time they press **Spin**. The contract-generated 5×3 grid is the source of truth for the animation and payout.

## Locked V1 product rules

- Five reels, three visible rows, twenty fixed paylines.
- All paylines are active on every spin.
- Initial bet range: 500–50,000 MATT per spin.
- The owner can change future purchase limits; previously purchased credits keep their wager and math version.
- Each purchase contains 1–25 credits. Unused paid credits are refundable at original MATT value.
- One pending spin per wallet.
- Every paid or bonus spin gets a fresh Ronin VRF request.
- Normal wins match from the first reel, left to right. Wild substitutes for normal symbols, never the Vault Scatter.
- Three, four, or five Vaults pay 2×, 10×, or 25× and award 10, 15, or 25 free spins.
- A bonus spin turns one VRF-selected reel fully Wild.
- Bonus retriggers award 5, 8, or 12 spins, capped at fifty total spins.
- Root paid spin plus its connected bonus session is capped at 500× the paid wager.
- Working math target: 97% RTP. It remains explicitly tunable through a delayed, paused-only math configuration before mainnet activation.
- Paid-spin net loss is `max(wager - root payout, 0)`. Losing bonus spins create no MATT conversion amount.

## Contract architecture

### `MattSlotsV1`

Owns spin credits, math versions, Ronin VRF requests, reel grids, paylines, free-spin sessions, stale-request restoration, and public spin history. It starts paused.

The contract packs each 64-stop reel into one `uint256`, and packs all fifteen final symbols into a `uint64`. Every payout is reproducible with `getSpinGrid`, `getPayline`, `getMathConfiguration`, and `previewGrid`.

### `MattSlotsRewardVault`

Pulls one consumed paid-spin principal from the controller, reserves the full worst-case liability, tracks claimable MATT, and protects settled treasury loss until it is flushed to the converter.

The vault tracks the consumed wager principal independently and reserves the full **500× connected-session payout cap** before each paid VRF request. Internally, `totalReserved` includes both values so cancellation, player claims, treasury-loss accounting, and bonus-session liability remain independently protected. The incoming wager supplies its own principal lock; owner-funded bankroll must still cover the 500× payout cap.

### `MattSlotsTreasuryConverter`

Receives settled net-losing MATT, allows only an approved router, verifies exact MATT spent and WRON received, enforces a 30-minute MATT/WRON Katana TWAP minimum, unwraps WRON, and sends all resulting RON to the immutable treasury Safe.

The swap router address is deliberately supplied during deployment rather than guessed in source code. Conversion starts paused and requires a configured source vault, keeper, router, slippage limit, and minimum harmonic liquidity.

## Math V1

The version-one math is stored in `config/slots.math.v1.json` and mirrored in `website/lib/slots-math-v1.js`.

The deterministic simulation includes the base game, Wild substitution, Scatter pay, free-spin Wild reels, retriggers, and the 500× connected-session cap. Run:

```powershell
node scripts/simulate-slots-v1.js 1000000 0x4d415454
```

The working build targets approximately:

- 97% long-run RTP
- 39% paid-spin chance of any return
- 19% paid-spin chance of returning more than the wager
- one free-spin trigger per roughly 109 paid spins
- medium volatility with a rare 500× ceiling

These are simulation targets, not a promise for an individual session. Final mainnet activation should use a larger independent simulation and preserve the exact approved config hash.

## Test commands

```powershell
npx hardhat compile
npx hardhat test test/MattSlotsV1.test.js test/MattSlotsRewardVault.test.js test/MattSlotsTreasuryConverter.test.js
node --test website/lib/slots-math-v1.test.js website/lib/slots-page.test.js
node scripts/simulate-slots-v1.js 1000000 0x4d415454
```

## Deployment sequence

Contracts are deployed and linked in this order:

1. `MattSlotsTreasuryConverter`
2. `MattSlotsRewardVault`
3. `MattSlotsV1`
4. Converter source vault configured once
5. Reward vault controller configured
6. All contracts inspected while Slots and Converter remain paused
7. Reward vault funded
8. Source verified on Ronin Explorer/Sourcify
9. Low-value mainnet purchase, spin, claim, loss flush, conversion, and stale restoration rehearsed
10. Frontend addresses published
11. Explicit activation only after all checks pass

### Required mainnet environment

```text
DEPLOYER_PRIVATE_KEY=
RONIN_RPC_URL=
SLOTS_SWAP_ROUTER=
SLOTS_CONVERSION_KEEPER=
SLOTS_MIN_HARMONIC_LIQUIDITY=
SLOTS_MAX_SLIPPAGE_BPS=500
CONFIRM_SLOTS_MAINNET=YES
```

Canonical mainnet MATT, WRON, factory, pool, treasury, admin, and VRF addresses are guarded in `scripts/deploy-slots.js`. A wrong value stops deployment.

Deploy paused:

```powershell
npx hardhat run scripts/deploy-slots.js --network ronin
```

Fund the vault:

```powershell
$env:SLOTS_VAULT_FUND_MATT="50000000"
npx hardhat run scripts/fund-slots-vault.js --network ronin
```

Inspect:

```powershell
npx hardhat run scripts/inspect-slots.js --network ronin
```

Publish the verified addresses into the web config:

```powershell
node scripts/update-slots-frontend.js deployment-exports/slots-ronin.json
```

Activate only after the audit checklist and funding are complete:

```powershell
$env:CONFIRM_ACTIVATE_SLOTS="YES"
npx hardhat run scripts/activate-slots.js --network ronin
```

## Frontend safety states

`website/public/slots-config.js` ships with contract addresses set to `null`. This renders the full machine and explicit practice mode while keeping live MATT actions disabled. The deployment update script writes only a Ronin mainnet export into the config.

Live mode reads:

- connected wallet and MATT balance
- contract pause and bet limits
- purchased batches and bonus sessions
- one active spin per wallet
- exact settled grid and payout
- claimable MATT
- reward-vault and converter loss queues
- total RON forwarded to treasury

The Render server never signs, chooses, replaces, or settles a Slots result.
