# Security notes

## Contract properties
- Entire supply minted once at construction.
- No external or public mint method.
- No owner or role-based administrator.
- No proxy or upgrade mechanism.
- No tax, blacklist, pause, or transfer-limit logic.
- Zero-address treasury rejected.

## Operational security
- Use separate deployer and treasury wallets.
- Keep the deployer low-value after deployment.
- Use a hardware wallet or multisig for treasury custody when practical.
- Verify every address on a second device before signing.
- Never paste a recovery phrase into this project, a website, or a chat.
- Pin and review dependencies before mainnet deployment.

## Reporting
Open a GitHub security advisory rather than publicly disclosing an exploitable issue.
