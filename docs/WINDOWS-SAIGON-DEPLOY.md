# Deploy MATT to Saigon from Windows PowerShell

This guide deploys the test version only. Do not run the Ronin mainnet command until the Saigon deployment has been reviewed.

## 1. Extract and open the folder

```powershell
cd C:\path\to\matt-token
```

## 2. Install dependencies

Install Node.js 20 LTS or newer, then run:

```powershell
npm ci
npm test
npm run compile
```

## 3. Create the private environment file

```powershell
Copy-Item .env.example .env
notepad .env
```

Replace only `0xYOUR_PRIVATE_KEY` with the private key of the funded deployment wallet. Never paste a recovery phrase. Never upload, commit, screenshot, or send the `.env` file.

The treasury is already set to:

```text
0xF79913cB83Cc9CABD95D0ba9250103fbb939f984
```

## 4. Deploy on Saigon

```powershell
npm run deploy:saigon
```

Copy the contract address shown by Hardhat.

## 5. Inspect the deployed contract

```powershell
npm run inspect:saigon
```

The script must report:

- Name `Matt`
- Symbol `MATT`
- Decimals `18`
- Total supply `10000000000.0`
- Treasury balance `10000000000.0`
- `Deployment inspection passed.`

## 6. Verify source code

```powershell
npm run verify:saigon
```

Then search the deployed contract address on the Saigon explorer and confirm the source is verified.

## Stop point

Do not deploy on mainnet yet. Record the Saigon contract address and test transfer, burn, and permit behavior first.
