# MATT Plinko Launch Checklist

## Fixed production rules

- Ronin mainnet chain ID: `2020`
- MATT: `0xa5450417BDCa0BDfB058ffE41205400FfDA1174d`
- Treasury: `0xF79913cB83Cc9CABD95D0ba9250103fbb939f984`
- Ronin VRF coordinator: `0x16a62a921e7fec5bf867ff5c805b662db757b778`
- Bets: 10,000 / 25,000 / 50,000 / 75,000 / 100,000 MATT
- Slots: 20x / 8x / 3x / 1.5x / .25x / .25x / .25x / 1.5x / 3x / 8x / 20x
- Maximum payout: 2,000,000 MATT
- Ten unbiased left/right decisions produce the physical Plinko distribution.
- The mathematical RTP for this fixed board is 97.4609375% (2.5390625% house edge).

## Safe deployment order

1. Run `npm test` and `npm run test:plinko`.
2. Deploy to Saigon and complete test drops first.
3. In the same local folder and `.env` used for Saigon, set the mainnet confirmation and deploy:

   ```powershell
   $env:CONFIRM_RONIN_MAINNET="YES"
   npm run deploy:plinko:ronin
   ```

   Never paste the deployer private key into chat. The script refuses unsupported chains, verifies
   the official mainnet MATT and VRF contracts, locks the production treasury address, estimates the
   deployment cost, and confirms the deployed contract is paused and owned by the treasury.
4. Verify the source through Ronin Sourcify.
5. Set `PLINKO_ADDRESS` in `website/public/plinko.js`.
6. From the treasury wallet, approve the Plinko contract and call `fundBankroll`.
7. Run `PLINKO_ADDRESS=0x... npm run inspect:plinko:ronin`.
8. Confirm `solvent: true` and the intended unreserved bankroll.
9. Open `/plinko`, connect a non-treasury test wallet, and verify the quoted VRF fee.
10. Unpause from the treasury wallet only after the UI address and verified contract match.
11. Add the Plinko link/banner to the live Hub in a separate small commit.

## Bankroll requirements

Each pending wager reserves 19x its amount in additional bankroll because the wager itself covers the remaining 1x of a 20x payout. A 100,000 MATT drop therefore reserves 1,900,000 MATT until Ronin VRF settles it.

The contract refuses new drops when the unreserved bankroll cannot cover the full 20x edge outcome. Treasury withdrawals cannot touch pending wagers, credited player balances, or reserved jackpot liability.

## Settlement behavior

- Multipliers of 1x or greater credit the complete multiplier payout to the player.
- A .25x result transfers the full wager to the treasury and credits .25x from bankroll to the player.
- Players withdraw credited payouts in a separate transaction.
- If Ronin VRF never fulfills, the player can recover the original wager after two hours.
- The browser animates the already-settled onchain slot; it never chooses the result.
