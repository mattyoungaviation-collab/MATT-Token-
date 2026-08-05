# Install MATT Slots V1 into the live repository

This archive is a **repo-root overlay**. It adds the complete Slots contracts, tests, scripts, website, assets, math config, CI workflow, and documentation. It does not contain private keys, RPC credentials, deployment addresses, or an enabled mainnet configuration.

## Windows PowerShell

1. Pull the latest repository first.
2. Extract this ZIP directly into the root of `MATT-Token-live` so the included `contracts`, `scripts`, `test`, and `website` folders merge with the existing folders.
3. From the repository root, run:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\INSTALL-SLOTS.ps1
```

The installer:

- verifies it is inside the MATT repository
- adds the Slots npm commands to `package.json`
- adds `/slots` to the MATT Hub navigation and official links
- creates one-time `.before-slots-v1` backups of the two edited existing files
- runs dependency installation, Hardhat contract tests, browser tests, and a one-million-session math simulation

To apply only the integration without installing dependencies or running tests:

```powershell
.\INSTALL-SLOTS.ps1 -SkipInstall -SkipTests
```

## Manual commands

```powershell
node scripts/apply-slots-integration.js
npm install
npm run test:slots
npm run simulate:slots -- 5000000 0x4d415454
npm start
```

Then open:

```text
http://localhost:3000/slots
```

The frontend ships in explicit practice mode because all three deployment addresses are `null`. Live MATT actions remain disabled until the contracts are compiled, tested, deployed paused, verified, funded, and deliberately written into `website/public/slots-config.js` by the deployment update script.

## Do not deploy yet unless all of these pass

- `npm run test:slots`
- five-million-session simulation reviewed
- exact approved Katana swap router verified
- 30-minute MATT/WRON harmonic-liquidity floor measured
- reward vault funding amount approved
- contracts deployed paused and source verified
- low-value purchase, spin, claim, stale restoration, loss flush, and MATT→RON conversion rehearsed

See `docs/SLOTS_V1.md` for architecture, deployment, and activation details.
