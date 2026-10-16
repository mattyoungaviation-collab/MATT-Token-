# Live DYNO protection controls

The multisig can change DYNO swap safeguards during an active round or buyback. No timelock applies: each change takes effect when the multisig transaction executes. The controls do not modify MATT, Katana pools, other wallets or other MATT games.

## Adjustable settings

- Ticket-sale slippage and buyback slippage are independent, each 0–1,000 basis points (0–10%). Defaults remain 200 basis points (2%). Zero means no slippage tolerance, not a zero minimum output.
- The shared guard supports a reference window of zero (explicit spot-only mode) or a positive number of seconds, a 0–10,000 basis-point spot/reference deviation tolerance (0–100%) when history is enabled, and a positive uint128 liquidity floor. The contract and unresolved production example retain 3,600 seconds and 1,000 basis points (10%) initially. Spot-only mode remains available through an explicit authorized transaction, but it removes historical-price and deviation checks and is vulnerable to spot manipulation/MEV. The production liquidity floor still requires actual market measurements.
- The wider deviation adjustment range is an owner-requested live-control implementation decision. It is not a claim that 100% deviation is safe. Higher tolerances, shorter history and lower liquidity floors increase exposure to manipulated pricing and MEV. There is no guard-off, missing-history fallback or zero-minimum-output mode.

The guard is shared by ticket sales and buybacks using its address. Changes apply to subsequent attempts, not completed or terminal slots. Ticket prices, prize quantities, frozen membership, winners, DCA budget/slice/beneficiary and seven-day end time stay unchanged. Failed and missed slots cannot be revived. Existing subsystem pauses remain separate and do not stop time.

## Preparing and executing a change

Open the local DYNO page and the Adjust swap protection section. Authenticate an actual multisig-owner wallet using the wallet login above, then refresh admin access. Public settings are read directly from one canonical hashed chain block; mock or unavailable deployments leave controls disabled.

Choose a sale, buyback or guard change. The API rereads current settings and checks Safe ownership, manager/vault/guard authority, live phase and expected old values. It constructs only the permitted fixed-target setter with zero native value, and simulates it from the multisig address. The preview contains exact target/value/calldata, old/new values, chain/block and risks. No backend signing key is used and no transaction is submitted.

Copy the unsigned draft into the multisig and review it there. Obtain the required signatures and execute. Refresh afterward to see chain state; a prepared or copied draft is never shown as an executed change. Settings can change between preparation and signing; the existing setters do not enforce an execution-time compare-and-set. Review current values before execution.

Sale slippage changes are available in OPEN/REVIEW. Buyback slippage changes target the active schedule for the selected round. Guard changes target the current round's actual guard. Live checkout quotes read the round's on-chain guard and slippage instead of the initial manifest.

Contract events publish actor and old/new protection values. Implementation ABI includes the read-only getSwapProtection getter; it adds no storage fields. All code changes are local, not deployed or enabled in production. A real production manifest, verified integration addresses and separate deployment approval remain required.

## Local preview and verification

Run `npm run preview:dyno:local`, then open `http://127.0.0.1:3107/dyno#protection`. This isolated preview binds localhost and uses only the labeled mock manifest and memory storage. It does not load production secrets, connect to RPCs or start keepers. Purchases and admin execution are disabled.

Focused checks passed on 2026-10-12: `npx hardhat test test/ProjectDyno.test.js test/ProjectDynoPriceGuard.test.js --grep 'live sale settings|higher/lower tolerance|logs old/new|dust-preserving'` ran four selected contract tests. `node --test services/dyno-api/protection.test.js website/lib/dyno-protection.test.js website/lib/dyno-checkout.test.js website/lib/dyno-page.test.js` ran 12 API/UI checks, none skipped. Syntax checks and ABI generation passed. The browser rendered the local disabled-controls panel. This is not a full-suite rerun, real multisig execution or mainnet verification.
