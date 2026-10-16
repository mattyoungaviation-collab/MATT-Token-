# Project DYNO Discord setup

Owner-selected application: `1559100671309905922`. Required server: `1493734022281429257`.
Production origin: `https://matttoken.com`.

## Configure the existing application

1. Open https://discord.com/developers/applications/1559100671309905922/oauth2 while signed in as its owner or an authorized application team member.
2. Add the exact redirect URI `https://matttoken.com/api/discord/callback` in OAuth2 redirect settings and save. For local testing also register `http://localhost:3000/api/discord/callback`.
3. Obtain the OAuth2 **Client Secret** in the developer portal and store it as `DISCORD_CLIENT_SECRET` in the website host's secret environment. This differs from a bot token. Do not paste it into chat, source, tickets, or logs.
4. Configure the public values and secrets below. Redeploy/restart the existing website service when its release is approved. The incomplete DYNO production manifest remains blocked until the chain and service requirements are resolved; registering a redirect alone does not launch sales.
5. Once a test deployment is available, authenticate a wallet on `/dyno` and use Verify Discord Membership. The app creates a fresh state-bound authorization URL; do not use a saved static OAuth link for real logins.

The application requests only `identify guilds.members.read` using authorization code flow. Membership is checked at `/users/@me/guilds/1493734022281429257/member`. A bot invitation, bot token, Administrator permission, Message Content intent, and email access are not required for this verification flow.

## Website host environment

Public configuration:

```dotenv
DISCORD_CLIENT_ID=1559100671309905922
DISCORD_GUILD_ID=1493734022281429257
DISCORD_REDIRECT_URI=https://matttoken.com/api/discord/callback
NODE_ENV=production
```

Set these privately in hosting secrets:

- `DISCORD_CLIENT_SECRET`: OAuth client secret from this application.
- `DYNO_IDENTITY_SECRET`: persistent cryptographically random secret with at least 32 bytes; back it up alongside the private identity mapping. Do not regenerate on each deployment.
- `DYNO_IDENTITY_SIGNER_PRIVATE_KEY`: dedicated voucher signer, separate from treasury and keepers. Its public address must match the future approved on-chain signer.
- `DYNO_STORAGE_KEY`: dedicated base64-encoded 32-byte encryption key for the private SQLite records. Back it up separately and never regenerate at redeploy.
- `RONIN_RPC_URL`: Alchemy Ronin HTTPS endpoint. The manifest reads this variable.
- `DYNO_RPC_URL`: same Ronin endpoint for the indexer and keeper.

The owner-selected storage is the existing `/var/data` disk. Prepare `DYNO_STORAGE=sqlite`, `RENDER_DISK_PATH=/var/data`, and `DYNO_DATABASE_FILE=/var/data/project-dyno/dyno.sqlite`. No PostgreSQL connection string is required in this mode. Follow the disk setup/backup requirements in `DEPLOYMENT.md`; changing live settings or publishing DYNO still requires approval.

For local setup, use an ignored `.env` and load it explicitly, for example `node --env-file=.env website/server-combined.js`. `npm start` depends on the process environment and does not automatically load `.env`. Keep `DYNO_MANIFEST=config/project-dyno.local.json` while evaluating the demo. Use the local callback URI registered in the portal.

Check hosting environment settings with `node scripts/dyno/check-discord-config.js`. For local `.env` use `node --env-file=.env scripts/dyno/check-discord-config.js --local`. The checker names missing variables but never prints secret values. Do not pass a client secret or RPC credential on the command line.

Reviewer/keeper addresses are pending owner approval. This setup does not grant privileges or fund wallets. The selected operations funding is 25 RON, separately accounted from the buyback pool; its adequacy still needs fee/gas measurement.

## Acceptance checks

- `/api/discord/config` reports enabled only when complete guild/application/secret/redirect settings are present.
- Authorization has `identify guilds.members.read`, an unpredictable state, and the exact registered redirect.
- Callback from another browser, wrong state, expired flow, cancellation, and replay are rejected.
- A server member receives a verified session; a non-member does not.
- Session and state cookies are HttpOnly and Secure on production HTTPS.
- OAuth/API failures do not expose tokens or application secrets.
- SQLite-backed wallet challenges, OAuth state, encrypted sessions, identity observations/audit history and backup/reopen tests are implemented locally. Verify the actual Render mount, original keys, live OAuth login and an operator-led restore before release. Memory fallback is local/demo only; it is not accepted for a production DYNO manifest.

Official reference: https://docs.discord.com/developers/topics/oauth2 and https://docs.discord.com/developers/resources/user#get-current-user-guild-member.
