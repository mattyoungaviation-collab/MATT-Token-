// Contract-backed Flappy MATT defaults.
// Players send 50,000 MATT to the prize-pool contract. At settlement the contract
// sends 1,000 MATT per entry to treasury and splits the remaining 49,000 MATT.
if (!process.env.FLAPPY_MATT_ENTRY_MATT) process.env.FLAPPY_MATT_ENTRY_MATT = "50000";

module.exports = require("./flappy-matt-routes");
