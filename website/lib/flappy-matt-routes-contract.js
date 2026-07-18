// Contract-backed Flappy MATT defaults.
// Each entry calls enter(): 50,000 MATT is collected, 1,000 MATT is sent immediately
// to treasury, and 49,000 MATT is assigned to the current UTC prize round.
if (!process.env.FLAPPY_MATT_ENTRY_MATT) process.env.FLAPPY_MATT_ENTRY_MATT = "50000";

module.exports = require("./flappy-matt-routes");
