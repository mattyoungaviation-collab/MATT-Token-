const crypto = require("crypto");

const MIN_BET = 10_000;
const MAX_BET = 5_000_000;
const TABLE_ID = "genesis";

function createBlackjackService() {
  const clients = new Set();
  const table = newTable();

  function newTable() {
    return {
      id: TABLE_ID,
      name: "MATT Genesis",
      roundId: null,
      phase: "BETTING",
      message: "Take a seat and place a bet.",
      seats: Array(5).fill(null),
      dealer: { cards: [], total: null },
      shoe: [],
      commitment: null,
      deckHash: null,
      settlement: "Off-chain settlement adapter",
      activity: []
    };
  }

  function log(text) {
    table.activity.push({ at: new Date().toISOString(), text });
    if (table.activity.length > 100) table.activity.shift();
  }

  function emit() {
    const payload = `event: table\ndata: ${JSON.stringify(publicTable())}\n\n`;
    for (const res of clients) {
      try {
        res.write(payload);
      } catch {
        clients.delete(res);
      }
    }
  }

  function publicTable() {
    return {
      ...table,
      seats: table.seats.map(player => player ? {
        wallet: player.wallet,
        bet: player.bet,
        cards: player.cards,
        total: handValue(player.cards),
        status: player.status,
        allowedActions: allowedActions(player)
      } : null),
      dealer: {
        cards: table.dealer.cards.map((card, index) => table.phase === "PLAYER_TURNS" && index === 1 ? { hidden: true } : card),
        total: table.phase === "PLAYER_TURNS"
          ? handValue(table.dealer.cards.slice(0, 1))
          : handValue(table.dealer.cards)
      }
    };
  }

  function player(wallet) {
    return table.seats.find(candidate => candidate && candidate.wallet === normalize(wallet));
  }

  function normalize(wallet) {
    const value = String(wallet || "").toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(value)) throw new Error("A valid wallet address is required.");
    return value;
  }

  function join(wallet, seat) {
    wallet = normalize(wallet);
    if (!Number.isInteger(seat) || seat < 0 || seat > 4) throw new Error("Invalid seat.");
    if (table.seats.some(player => player?.wallet === wallet)) throw new Error("This wallet is already seated.");
    if (table.seats[seat]) throw new Error("That seat is occupied.");
    table.seats[seat] = { wallet, bet: 0, cards: [], status: "Betting", stood: false, busted: false };
    log(`${short(wallet)} joined seat ${seat + 1}.`);
    emit();
  }

  function leave(wallet) {
    wallet = normalize(wallet);
    const index = table.seats.findIndex(candidate => candidate?.wallet === wallet);
    if (index < 0) throw new Error("Wallet is not seated.");
    if (table.phase !== "BETTING") throw new Error("You cannot leave during an active hand.");
    table.seats[index] = null;
    log(`${short(wallet)} left the table.`);
    emit();
  }

  function bet(wallet, amount) {
    const seatedPlayer = player(wallet);
    if (!seatedPlayer) throw new Error("Take a seat first.");
    if (table.phase !== "BETTING") throw new Error("Betting is closed.");
    amount = Number(amount);
    if (!Number.isSafeInteger(amount) || amount < MIN_BET || amount > MAX_BET) {
      throw new Error(`Bet must be between ${MIN_BET.toLocaleString()} and ${MAX_BET.toLocaleString()} MATT.`);
    }
    seatedPlayer.bet = amount;
    seatedPlayer.status = "Ready";
    log(`${short(seatedPlayer.wallet)} bet ${amount.toLocaleString()} MATT.`);
    emit();
    const seated = table.seats.filter(Boolean);
    if (seated.some(candidate => candidate.bet > 0) && seated.every(candidate => candidate.bet > 0)) startRound();
  }

  function startRound() {
    table.roundId = `MATT-${Date.now().toString(36).toUpperCase()}`;
    table.shoe = shuffle(createShoe(6));
    table.commitment = crypto.createHash("sha256").update(JSON.stringify(table.shoe)).digest("hex");
    table.deckHash = null;
    table.dealer.cards = [];
    for (const seatedPlayer of table.seats.filter(Boolean)) {
      seatedPlayer.cards = [];
      seatedPlayer.stood = false;
      seatedPlayer.busted = false;
      seatedPlayer.status = "Playing";
    }
    for (let index = 0; index < 2; index += 1) {
      for (const seatedPlayer of table.seats.filter(Boolean)) seatedPlayer.cards.push(draw());
      table.dealer.cards.push(draw());
    }
    table.phase = "PLAYER_TURNS";
    table.message = "Players are acting.";
    log(`Round ${table.roundId} was dealt.`);
    advance();
    emit();
  }

  function action(wallet, actionName) {
    const seatedPlayer = player(wallet);
    if (!seatedPlayer) throw new Error("Player not seated.");
    if (table.phase !== "PLAYER_TURNS") throw new Error("No player action is available.");
    if (!allowedActions(seatedPlayer).includes(actionName)) throw new Error("That action is not allowed.");

    if (actionName === "hit") {
      seatedPlayer.cards.push(draw());
      if (handValue(seatedPlayer.cards) > 21) {
        seatedPlayer.busted = true;
        seatedPlayer.status = "Bust";
      }
    } else if (actionName === "stand") {
      seatedPlayer.stood = true;
      seatedPlayer.status = "Stand";
    } else if (actionName === "double") {
      seatedPlayer.bet *= 2;
      seatedPlayer.cards.push(draw());
      seatedPlayer.stood = true;
      seatedPlayer.busted = handValue(seatedPlayer.cards) > 21;
      seatedPlayer.status = seatedPlayer.busted ? "Bust" : "Doubled";
    } else if (actionName === "surrender") {
      seatedPlayer.stood = true;
      seatedPlayer.status = "Surrender";
    } else if (actionName === "split") {
      throw new Error("Split hand tracking is reserved for phase two.");
    }

    log(`${short(seatedPlayer.wallet)} chose ${actionName}.`);
    advance();
    emit();
  }

  function advance() {
    const active = table.seats.filter(candidate => candidate && candidate.bet > 0 && !candidate.stood && !candidate.busted && handValue(candidate.cards) < 21);
    if (active.length) return;
    dealerPlay();
    settle();
  }

  function dealerPlay() {
    table.phase = "DEALER_TURN";
    while (handValue(table.dealer.cards) < 17) table.dealer.cards.push(draw());
  }

  function settle() {
    const dealerTotal = handValue(table.dealer.cards);
    for (const seatedPlayer of table.seats.filter(Boolean)) {
      const total = handValue(seatedPlayer.cards);
      if (!seatedPlayer.bet) continue;
      if (seatedPlayer.status === "Surrender") seatedPlayer.status = "Lost 1/2";
      else if (total > 21) seatedPlayer.status = "Lost";
      else if (dealerTotal > 21 || total > dealerTotal) seatedPlayer.status = total === 21 && seatedPlayer.cards.length === 2 ? "Blackjack" : "Won";
      else if (total === dealerTotal) seatedPlayer.status = "Push";
      else seatedPlayer.status = "Lost";
    }
    table.phase = "SETTLED";
    table.message = `Dealer has ${dealerTotal}. Round complete.`;
    table.deckHash = crypto.createHash("sha256").update(JSON.stringify(table.shoe)).digest("hex");
    table.settlement = "Settlement adapter pending contract integration";
    log(`Round ${table.roundId} settled.`);
    emit();
    setTimeout(reset, 8_000).unref?.();
  }

  function reset() {
    for (const seatedPlayer of table.seats.filter(Boolean)) {
      seatedPlayer.bet = 0;
      seatedPlayer.cards = [];
      seatedPlayer.status = "Betting";
      seatedPlayer.stood = false;
      seatedPlayer.busted = false;
    }
    table.phase = "BETTING";
    table.roundId = null;
    table.dealer.cards = [];
    table.message = "Place bets for the next round.";
    table.commitment = null;
    table.deckHash = null;
    emit();
  }

  function allowedActions(seatedPlayer) {
    if (table.phase !== "PLAYER_TURNS" || seatedPlayer.stood || seatedPlayer.busted || !seatedPlayer.bet) return [];
    const actions = ["hit", "stand", "surrender"];
    if (seatedPlayer.cards.length === 2 && seatedPlayer.bet * 2 <= MAX_BET) actions.push("double");
    if (seatedPlayer.cards.length === 2 && seatedPlayer.cards[0].rank === seatedPlayer.cards[1].rank) actions.push("split");
    return actions;
  }

  function draw() {
    const card = table.shoe.pop();
    if (!card) throw new Error("Shoe exhausted.");
    return card;
  }

  function subscribe(res) {
    clients.add(res);
    res.write(`event: table\ndata: ${JSON.stringify(publicTable())}\n\n`);
    const keepalive = setInterval(() => res.write(": keepalive\n\n"), 20_000);
    res.on("close", () => {
      clearInterval(keepalive);
      clients.delete(res);
    });
  }

  return { subscribe, join, leave, bet, action, snapshot: publicTable };
}

function createShoe(decks) {
  const suits = ["♠", "♥", "♦", "♣"];
  const ranks = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
  const cards = [];
  for (let deck = 0; deck < decks; deck += 1) {
    for (const suit of suits) {
      for (const rank of ranks) cards.push({ rank, suit });
    }
  }
  return cards;
}

function shuffle(cards) {
  for (let index = cards.length - 1; index > 0; index -= 1) {
    const randomIndex = crypto.randomInt(index + 1);
    [cards[index], cards[randomIndex]] = [cards[randomIndex], cards[index]];
  }
  return cards;
}

function handValue(cards) {
  let total = 0;
  let aces = 0;
  for (const card of cards) {
    if (card.rank === "A") {
      aces += 1;
      total += 11;
    } else if (["K", "Q", "J"].includes(card.rank)) total += 10;
    else total += Number(card.rank);
  }
  while (total > 21 && aces) {
    total -= 10;
    aces -= 1;
  }
  return total;
}

function short(wallet) {
  return `${wallet.slice(0, 6)}…${wallet.slice(-4)}`;
}

module.exports = { createBlackjackService };
