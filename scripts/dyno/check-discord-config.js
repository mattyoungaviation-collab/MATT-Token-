"use strict";

const { config } = require("../../website/discord-auth");
const manifest = require("../../config/project-dyno.ronin.example.json");
function check(env, { local = false } = {}) {
  const cfg = config(env); const errors = [];
  if (cfg.clientId !== manifest.discordApplicationId) errors.push("DISCORD_CLIENT_ID must match the owner-selected application");
  if (cfg.guildId !== manifest.discordGuildId) errors.push("DISCORD_GUILD_ID must match the owner-selected server");
  if (!cfg.clientSecret) errors.push("DISCORD_CLIENT_SECRET is missing; configure it privately in hosting secrets");
  const expected = local ? "http://localhost:3000/api/discord/callback" : manifest.publicOAuthRedirectUri;
  if (cfg.redirectUri !== expected) errors.push(`DISCORD_REDIRECT_URI must be ${expected}`);
  if (!local && env.NODE_ENV !== "production") errors.push("NODE_ENV must be production for Secure cookies");
  if (!cfg.enabled && !errors.length) errors.push("Discord OAuth configuration is invalid");
  return errors;
}
if (require.main === module) {
  const errors = check(process.env, { local: process.argv.includes("--local") });
  if (errors.length) { errors.forEach(error => console.error(error)); process.exitCode = 1; }
  else console.log("Discord environment settings match the selected application, guild and callback. Secret values are not printed. Live portal/login verification is still required.");
}
module.exports = { check };
