const OUTCOMES = Object.freeze({
  BLACKJACK: "BLACKJACK",
  WIN: "WIN",
  PUSH: "PUSH",
  LOSS: "LOSS",
  SURRENDER: "SURRENDER"
});

function settlementFor(outcome, wager) {
  wager = Number(wager);
  if (!Number.isSafeInteger(wager) || wager <= 0) throw new Error("A positive integer wager is required.");

  switch (outcome) {
    case OUTCOMES.BLACKJACK:
      return { returnToPlayer: wager, treasuryPayout: Math.floor(wager * 1.5), burnAmount: 0 };
    case OUTCOMES.WIN:
      return { returnToPlayer: wager, treasuryPayout: wager, burnAmount: 0 };
    case OUTCOMES.PUSH:
      return { returnToPlayer: wager, treasuryPayout: 0, burnAmount: 0 };
    case OUTCOMES.SURRENDER:
      return { returnToPlayer: Math.floor(wager / 2), treasuryPayout: 0, burnAmount: wager - Math.floor(wager / 2) };
    case OUTCOMES.LOSS:
      return { returnToPlayer: 0, treasuryPayout: 0, burnAmount: wager };
    default:
      throw new Error(`Unsupported blackjack outcome: ${outcome}`);
  }
}

module.exports = { OUTCOMES, settlementFor };
