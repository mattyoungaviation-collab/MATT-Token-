# BurnFlip Mainnet Migration

This is a replacement runbook, not a token deployment. Do not deploy or modify `MattToken`.

## 1. Preflight

1. Pin Node 20–22 and run `npm ci`.
2. Run `npm run compile`, `npm run build:burnflip`, and `npm run test:coinflip-burn`.
3. Re-run `npm run discover:coinflip-burn:pools` against a reliable Ronin RPC.
4. Compare token symbols, decimals, factory, pool pair, fee, active liquidity, and TWAP readiness with `config/burnflip.ronin.json`.
5. Obtain an independent audit and complete jurisdiction/security review.

Never enable a pool solely because an address exists. It must be canonical, active, and able to answer the full 1,800-second observation.

## 2. Deploy paused contracts

Set the deployer key only in the encrypted deployment environment. The Ronin deployment uses the fixed live MATT, WRON, factory, treasury, and admin constants.

```bash
npm run deploy:coinflip-burn:ronin
```

Record:

- `MattRewardVault` address and deployment transaction/block.
- `MattCoinFlipBurn` address and deployment transaction/block.
- Constructor arguments and exact source commit.

Both contracts start paused. If the deployer is not the configured admin, the admin must call `MattRewardVault.configureBurnFlip(game)` while the vault remains paused.

## 3. Prepare V3 observations

Most discovered pools currently report observation cardinality `1`. Increase capacity before relying on a rolling 30-minute oracle:

```bash
BURNFLIP_PREPARE_ONLY=true npm run configure:coinflip-burn:ronin
```

Wait for swaps/observations to populate and for at least a complete 30-minute interval. Then run:

```bash
npm run configure:coinflip-burn:ronin
```

The script rejects wrong factories, wrong pairs, zero active liquidity, unavailable TWAP history, and a zero derived floor. It configures only entries whose `enabled` field is not false.

MATT is configured separately at exact 1:1 with the zero pool and zero
liquidity floor. USDC remains disabled while its 30-minute observation is
unreliable. NOTUS must remain disabled while its pool has zero active
liquidity.

### Replacing a universal game that omitted MATT

Reuse the funded `MattRewardVault`; its MATT cannot be rescued into a newly
deployed vault.

1. Pause the current game to block new wagers.
2. Leave the vault unpaused until all existing reservations settle or expire.
3. Confirm the current game is paused and `reservedPayouts() == 0`.
4. Pause the vault.
5. Deploy the paused replacement with
   `npm run deploy:coinflip-burn-matt:ronin`.
6. Configure it with `npm run configure:coinflip-burn-matt:ronin`.
7. Confirm MATT quotes exactly 1:1 and all other enabled assets quote safely.
8. Run `npm run switch:coinflip-burn-matt:ronin` to authorize the replacement.
9. Unpause the vault, then the replacement game.
10. Update the website and backend to the replacement address and block.

## 4. Fund and activate

1. Approve and call `MattRewardVault.ownerRefill(amount)` from the admin.
2. Confirm the MATT vault balance on Ronin Explorer.
3. Call `MattRewardVault.unpause()`.
4. Read and independently verify `quoteMatt()` for a conservative test amount in every enabled asset.
5. Confirm `availableRewardBalance()` covers intended maximum exposure.
6. Call `MattCoinFlipBurn.unpause()`.
7. Place and settle a small canary wager for RON and one ERC-20.
8. Confirm the game contract balance remains zero for each wager asset.
9. Confirm `TreasuryDeposit`, `PoolPriceUsed`, `GamePlayed`, and the matching payout/burn event.

## 5. Website/API cutover

Update `website/public/coin-game-config.js`:

- `contractAddress`
- `deploymentBlock`

Set the same values in the hosting environment:

```text
BURNFLIP_CONTRACT_ADDRESS=<new game>
BURNFLIP_DEPLOYMENT_BLOCK=<deployment block>
```

Deploy the website only after the canary passes. Verify wallet connection, balance, quote, approval, confirmation modal, treasury receipt, reveal, result card, stats, and history.

Do not point the new frontend ABI at the old Burn Flip address.

## 6. Legacy handling

- Pause the old Burn Flip using its existing administration path.
- Do not reuse its address in the new frontend.
- Settle or recover legacy pending bets according to the legacy contract rules before withdrawing any old bankroll.
- Preserve the old contract, events, and documentation for historical records.

## 7. Rollback

If any canary or monitoring check fails:

1. Pause the new game.
2. Pause the Reward Vault if settlement itself is suspect.
3. Remove the new frontend address or roll back the web release.
4. Keep wager assets in the treasury Safe; they cannot and should not be withdrawn from BurnFlip.
5. Diagnose using emitted quotes, stored bet values, and transaction traces.

Pending bets reserve payout amounts. Do not change the game’s vault while reservations exist.

## Administrative verification

Before launch, verify on-chain that:

- Game owner is `0xF79913cB83Cc9CABD95D0ba9250103fbb939f984`.
- Vault owner is the same admin.
- Treasury is `0xBacE355D23d378a6E1adD986E53a18Dd12E6EeAc`.
- MATT is `0xa5450417BDCa0BDfB058ffE41205400FfDA1174d`.
- Factory is `0x1f0B70d9A137e3cAEF0ceAcD312BC5f81Da0cC0c`.
- Vault `burnFlip()` equals the new game.
- Default burn is `7500` bps and payout multiplier is `20000` bps.
- Both contracts are verified with exact source and constructor arguments.
