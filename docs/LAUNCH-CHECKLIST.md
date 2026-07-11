# MATT launch checklist

## 1. Preflight
- [ ] Confirm legal and tax considerations for the jurisdiction and intended distribution.
- [ ] Confirm rights to the mascot image and all branding.
- [ ] Create a dedicated deployer wallet and a separate treasury wallet.
- [ ] Back up wallets offline. Never commit keys or recovery phrases.
- [ ] Fund the Saigon deployer with test RON.
- [ ] Replace all `DEPLOYED_CONTRACT_ADDRESS` placeholders only after deployment.

## 2. Local validation
- [ ] `npm ci`
- [ ] `npm test`
- [ ] `npm run compile`
- [ ] Review compiler output and dependency lockfile.

## 3. Saigon testnet
- [ ] Copy `.env.example` to `.env` and enter the deployer key and public treasury address.
- [ ] `npm run deploy:saigon`
- [ ] Record the address and transaction hash.
- [ ] `npm run verify:saigon`
- [ ] Confirm name, symbol, decimals, supply, treasury balance, transfer, burn, and permit behavior.
- [ ] Test pool creation and swaps with test assets where supported.

## 4. Mainnet deployment
- [ ] Reconfirm treasury address character by character.
- [ ] Reconfirm supply and bytecode match the reviewed Saigon build.
- [ ] Fund deployer with enough RON for deployment and verification operations.
- [ ] `npm run deploy:ronin`
- [ ] Record the contract address and transaction hash in multiple secure places.
- [ ] `npm run verify:ronin`
- [ ] Confirm verified source on Ronin Explorer.

## 5. Public metadata
- [ ] Replace contract placeholders in `metadata/token.json` and `website/public/token.json`.
- [ ] Update the website's contract button and explorer links.
- [ ] Deploy the site to Render.
- [ ] Publish contract address only from the official X account and website.
- [ ] Register the project and verified contracts through the current Ronin builder process.

## 6. Liquidity
- [ ] Reconsider whether 1 RON is sufficient after test swaps.
- [ ] Create the Katana pool using the verified contract address.
- [ ] Add exactly the intended MATT and RON amounts.
- [ ] Record the pool address and LP position details.
- [ ] Verify the chosen lock provider supports the exact V2 LP token or V3 NFT position.
- [ ] Do not claim liquidity is locked until the lock transaction is independently visible.
- [ ] Publish the unlock date and evidence.

## 7. Final verification
- [ ] Perform a small buy and sell from a separate wallet.
- [ ] Verify no unexpected tax and review price impact.
- [ ] Verify the token is importable by contract address.
- [ ] Announce that new tokens may initially appear as Katana “seed” tokens.
- [ ] Never promise automatic name search or listing approval by third-party interfaces.
