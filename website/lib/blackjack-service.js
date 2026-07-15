const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const MIN_BET = 10_000;
const MAX_BET = 5_000_000;
const TABLE_ID = "genesis";
const TURN_MS = positiveInteger(process.env.BLACKJACK_TURN_MS, 50_000);
const BETTING_MS = positiveInteger(process.env.BLACKJACK_BETTING_MS, 50_000);
const INACTIVITY_MS = positiveInteger(process.env.BLACKJACK_INACTIVITY_MS, 5 * 60_000);
const configuredDiskPath = String(process.env.RENDER_DISK_PATH || process.env.PERSISTENT_DISK_PATH || "").trim();
const persistentDiskPath = configuredDiskPath || (fs.existsSync("/var/data") ? "/var/data" : "");
const STATE_FILE = process.env.BLACKJACK_STATE_FILE || (persistentDiskPath ? path.join(persistentDiskPath, "matt-blackjack-table.json") : path.join(__dirname, "..", ".blackjack-state.json"));

function createBlackjackService() {
  const clients = new Set();
  let table = loadTable() || newTable();
  let turnTimer = null;
  let bettingTimer = null;
  normalizeLoadedState();
  recoverState();
  const inactivityTimer = setInterval(ejectInactivePlayers, 10_000);
  inactivityTimer.unref?.();

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
      activity: [],
      activeSeat: null,
      turnDeadline: null,
      bettingDeadline: null,
      updatedAt: new Date().toISOString()
    };
  }

  function loadTable() {
    try {
      if (!fs.existsSync(STATE_FILE)) return null;
      const parsed = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
      if (!parsed || parsed.id !== TABLE_ID || !Array.isArray(parsed.seats) || parsed.seats.length !== 5) return null;
      return parsed;
    } catch (error) {
      console.error("Could not load blackjack state:", String(error.message || error));
      return null;
    }
  }

  function normalizeLoadedState() {
    table.bettingDeadline = Number(table.bettingDeadline || 0) || null;
    table.turnDeadline = Number(table.turnDeadline || 0) || null;
    const fallback = Date.parse(table.updatedAt || "") || Date.now();
    table.seats = table.seats.map(seatedPlayer => seatedPlayer ? {
      ...seatedPlayer,
      lastActivityAt: Number(seatedPlayer.lastActivityAt || fallback)
    } : null);
  }

  function save() {
    table.updatedAt = new Date().toISOString();
    try {
      fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
      const temporary = `${STATE_FILE}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(table));
      fs.renameSync(temporary, STATE_FILE);
    } catch (error) {
      console.error("Could not save blackjack state:", String(error.message || error));
    }
  }

  function recoverState() {
    if (table.phase === "PLAYER_TURNS") {
      const active = nextActiveSeat(table.activeSeat == null ? -1 : table.activeSeat - 1);
      if (active == null) {
        dealerPlay();
        settle();
      } else {
        table.activeSeat = active;
        const remaining = Number(table.turnDeadline || 0) - Date.now();
        beginTurn(remaining > 0 ? remaining : 1_000, true);
      }
    } else if (table.phase === "BETTING" && table.bettingDeadline) {
      const remaining = Number(table.bettingDeadline) - Date.now();
      if (remaining > 0) beginBettingWindow(remaining, true);
      else setTimeout(closeBettingWindow, 250).unref?.();
    } else if (table.phase === "SETTLED") {
      setTimeout(reset, 8_000).unref?.();
    }
  }

  function log(text) {
    table.activity.push({ at: new Date().toISOString(), text });
    if (table.activity.length > 100) table.activity.shift();
  }

  function emit() {
    save();
    const payload = `event: table\ndata: ${JSON.stringify(publicTable())}\n\n`;
    for (const res of clients) {
      try { res.write(payload); } catch { clients.delete(res); }
    }
  }

  function publicTable() {
    return {
      ...table,
      shoe: undefined,
      seats: table.seats.map((seatedPlayer, index) => seatedPlayer ? {
        wallet: seatedPlayer.wallet,
        bet: seatedPlayer.bet,
        cards: seatedPlayer.cards,
        total: handValue(seatedPlayer.cards),
        status: index === table.activeSeat && table.phase === "PLAYER_TURNS" ? "Your turn" : seatedPlayer.status,
        isActive: index === table.activeSeat && table.phase === "PLAYER_TURNS",
        allowedActions: index === table.activeSeat ? allowedActions(seatedPlayer) : []
      } : null),
      dealer: {
        cards: table.dealer.cards.map((card, index) => table.phase === "PLAYER_TURNS" && index === 1 ? { hidden: true } : card),
        total: table.phase === "PLAYER_TURNS" ? handValue(table.dealer.cards.slice(0, 1)) : handValue(table.dealer.cards)
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

  function touch(seatedPlayer) {
    seatedPlayer.lastActivityAt = Date.now();
  }

  function join(wallet, seat) {
    wallet = normalize(wallet);
    if (!Number.isInteger(seat) || seat < 0 || seat > 4) throw new Error("Invalid seat.");
    if (table.phase !== "BETTING") throw new Error("Wait for the current hand to finish.");
    if (table.seats.some(seatedPlayer => seatedPlayer?.wallet === wallet)) throw new Error("This wallet is already seated.");
    if (table.seats[seat]) throw new Error("That seat is occupied.");
    table.seats[seat] = { wallet, bet: 0, cards: [], status: "Betting", stood: false, busted: false, lastActivityAt: Date.now() };
    log(`${short(wallet)} joined seat ${seat + 1}.`);
    emit();
  }

  function leave(wallet) {
    wallet = normalize(wallet);
    const index = table.seats.findIndex(candidate => candidate?.wallet === wallet);
    if (index < 0) throw new Error("Wallet is not seated.");
    if (table.phase !== "BETTING") throw new Error("You cannot leave during an active hand.");
    if (table.seats[index].bet > 0) throw new Error("You cannot leave after confirming an on-chain wager.");
    table.seats[index] = null;
    log(`${short(wallet)} left the table.`);
    emit();
  }

  function bet(wallet, amount) {
    const seatedPlayer = player(wallet);
    if (!seatedPlayer) throw new Error("Take a seat first.");
    if (table.phase !== "BETTING") throw new Error("Betting is closed.");
    amount = Number(amount);
    if (!Number.isSafeInteger(amount) || amount < MIN_BET || amount > MAX_BET) throw new Error(`Bet must be between ${MIN_BET.toLocaleString()} and ${MAX_BET.toLocaleString()} MATT.`);
    seatedPlayer.bet = amount;
    seatedPlayer.status = "Ready";
    touch(seatedPlayer);
    log(`${short(seatedPlayer.wallet)} bet ${amount.toLocaleString()} MATT.`);
    if (!table.bettingDeadline) beginBettingWindow(BETTING_MS);
    else emit();
  }

  function beginBettingWindow(milliseconds = BETTING_MS, recovering = false) {
    clearBettingTimer();
    table.bettingDeadline = Date.now() + Math.max(250, milliseconds);
    table.message = "Place your wager before betting closes.";
    if (!recovering) log(`Betting is open for ${Math.ceil(milliseconds / 1000)} seconds.`);
    emit();
    bettingTimer = setTimeout(closeBettingWindow, Math.max(250, milliseconds));
    bettingTimer.unref?.();
  }

  function closeBettingWindow() {
    if (table.phase !== "BETTING") return;
    clearBettingTimer();
    table.bettingDeadline = null;
    for (let index = 0; index < table.seats.length; index += 1) {
      const seatedPlayer = table.seats[index];
      if (seatedPlayer && seatedPlayer.bet <= 0) {
        log(`${short(seatedPlayer.wallet)} was removed for not placing a bet in time.`);
        table.seats[index] = null;
      }
    }
    if (table.seats.some(seatedPlayer => seatedPlayer?.bet > 0)) startRound();
    else {
      table.message = "Take a seat and place a bet.";
      emit();
    }
  }

  function clearBettingTimer() {
    if (bettingTimer) clearTimeout(bettingTimer);
    bettingTimer = null;
  }

  function ejectInactivePlayers() {
    if (table.phase !== "BETTING") return;
    const now = Date.now();
    let changed = false;
    for (let index = 0; index < table.seats.length; index += 1) {
      const seatedPlayer = table.seats[index];
      if (!seatedPlayer || seatedPlayer.bet > 0) continue;
      if (now - Number(seatedPlayer.lastActivityAt || 0) < INACTIVITY_MS) continue;
      log(`${short(seatedPlayer.wallet)} was auto-ejected after 5 minutes of inactivity.`);
      table.seats[index] = null;
      changed = true;
    }
    if (changed) emit();
  }

  function startRound() {
    clearBettingTimer();
    table.bettingDeadline = null;
    clearTurnTimer();
    table.roundId = `MATT-${Date.now().toString(36).toUpperCase()}`;
    table.shoe = shuffle(createShoe(6));
    table.commitment = crypto.createHash("sha256").update(JSON.stringify(table.shoe)).digest("hex");
    table.deckHash = null;
    table.dealer.cards = [];
    table.activeSeat = null;
    table.turnDeadline = null;
    for (const seatedPlayer of table.seats.filter(Boolean)) {
      seatedPlayer.cards = [];
      seatedPlayer.stood = false;
      seatedPlayer.busted = false;
      seatedPlayer.status = "Playing";
      touch(seatedPlayer);
    }
    for (let index = 0; index < 2; index += 1) {
      for (const seatedPlayer of table.seats.filter(Boolean)) seatedPlayer.cards.push(draw());
      table.dealer.cards.push(draw());
    }
    table.phase = "PLAYER_TURNS";
    table.message = "Players are acting.";
    log(`Round ${table.roundId} was dealt.`);
    advance();
  }

  function action(wallet, actionName) {
    const seatedPlayer = player(wallet);
    if (!seatedPlayer) throw new Error("Player not seated.");
    const seat = table.seats.indexOf(seatedPlayer);
    if (table.phase !== "PLAYER_TURNS") throw new Error("No player action is available.");
    if (seat !== table.activeSeat) throw new Error("Wait for your turn.");
    if (!allowedActions(seatedPlayer).includes(actionName)) throw new Error("That action is not allowed.");
    clearTurnTimer();
    touch(seatedPlayer);

    if (actionName === "hit") {
      seatedPlayer.cards.push(draw());
      if (handValue(seatedPlayer.cards) > 21) { seatedPlayer.busted = true; seatedPlayer.status = "Bust"; }
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
      throw new Error("Split hand tracking is the next engine upgrade.");
    }

    log(`${short(seatedPlayer.wallet)} chose ${actionName}.`);
    advance();
  }

  function advance() {
    const next = nextActiveSeat(table.activeSeat == null ? -1 : table.activeSeat);
    if (next != null) {
      table.activeSeat = next;
      beginTurn(TURN_MS);
      return;
    }
    clearTurnTimer();
    table.activeSeat = null;
    table.turnDeadline = null;
    dealerPlay();
    settle();
  }

  function nextActiveSeat(after) {
    for (let offset = 1; offset <= table.seats.length; offset += 1) {
      const index = (after + offset) % table.seats.length;
      const candidate = table.seats[index];
      if (candidate && candidate.bet > 0 && !candidate.stood && !candidate.busted && handValue(candidate.cards) < 21) return index;
    }
    return null;
  }

  function beginTurn(milliseconds, recovering = false) {
    clearTurnTimer();
    table.turnDeadline = Date.now() + Math.max(250, milliseconds);
    const active = table.seats[table.activeSeat];
    if (!recovering) log(`${short(active.wallet)} has ${Math.ceil(milliseconds / 1000)} seconds to act.`);
    emit();
    turnTimer = setTimeout(() => {
      const timedOut = table.seats[table.activeSeat];
      if (!timedOut || table.phase !== "PLAYER_TURNS") return;
      timedOut.stood = true;
      timedOut.status = "Auto stand";
      log(`${short(timedOut.wallet)} timed out and automatically stood.`);
      advance();
    }, Math.max(250, milliseconds));
    turnTimer.unref?.();
  }

  function clearTurnTimer() {
    if (turnTimer) clearTimeout(turnTimer);
    turnTimer = null;
  }

  function dealerPlay() {
    table.phase = "DEALER_TURN";
    while (handValue(table.dealer.cards) < 17) table.dealer.cards.push(draw());
  }

  function settle() {
    const dealerTotal = handValue(table.dealer.cards);
    const burned = [];
    for (const seatedPlayer of table.seats.filter(Boolean)) {
      const total = handValue(seatedPlayer.cards);
      if (!seatedPlayer.bet) continue;
      if (seatedPlayer.status === "Surrender") { seatedPlayer.status = "Lost 1/2 • Burn"; burned.push(Math.floor(seatedPlayer.bet / 2)); }
      else if (total > 21) { seatedPlayer.status = "Lost • Burn"; burned.push(seatedPlayer.bet); }
      else if (dealerTotal > 21 || total > dealerTotal) seatedPlayer.status = total === 21 && seatedPlayer.cards.length === 2 ? "Blackjack" : "Won";
      else if (total === dealerTotal) seatedPlayer.status = "Push";
      else { seatedPlayer.status = "Lost • Burn"; burned.push(seatedPlayer.bet); }
      touch(seatedPlayer);
    }
    table.phase = "SETTLED";
    table.message = `Dealer has ${dealerTotal}. Round complete.`;
    table.deckHash = crypto.createHash("sha256").update(JSON.stringify(table.shoe)).digest("hex");
    const burnTotal = burned.reduce((sum, amount) => sum + amount, 0);
    table.settlement = burnTotal ? `${burnTotal.toLocaleString()} MATT marked for burn` : "No MATT burned this round";
    log(`Round ${table.roundId} settled${burnTotal ? ` with ${burnTotal.toLocaleString()} MATT marked for burn` : ""}.`);
    emit();
    setTimeout(reset, 8_000).unref?.();
  }

  function reset() {
    clearTurnTimer();
    clearBettingTimer();
    for (const seatedPlayer of table.seats.filter(Boolean)) {
      seatedPlayer.bet = 0;
      seatedPlayer.cards = [];
      seatedPlayer.status = "Betting";
      seatedPlayer.stood = false;
      seatedPlayer.busted = false;
      touch(seatedPlayer);
    }
    table.phase = "BETTING";
    table.roundId = null;
    table.dealer.cards = [];
    table.message = "Place bets for the next round.";
    table.commitment = null;
    table.deckHash = null;
    table.activeSeat = null;
    table.turnDeadline = null;
    table.bettingDeadline = null;
    table.settlement = "Waiting for wagers";
    emit();
  }

  function allowedActions(seatedPlayer) {
    if (table.phase !== "PLAYER_TURNS" || seatedPlayer.stood || seatedPlayer.busted || !seatedPlayer.bet) return [];
    return ["hit", "stand", "surrender"];
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
    res.on("close", () => { clearInterval(keepalive); clients.delete(res); });
  }

  return { subscribe, join, leave, bet, action, snapshot: publicTable };
}

function createShoe(decks) {
  const suits = ["♠", "♥", "♦", "♣"];
  const ranks = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
  const cards = [];
  for (let deck = 0; deck < decks; deck += 1) for (const suit of suits) for (const rank of ranks) cards.push({ rank, suit });
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
    if (card.rank === "A") { aces += 1; total += 11; }
    else if (["K", "Q", "J"].includes(card.rank)) total += 10;
    else total += Number(card.rank);
  }
  while (total > 21 && aces) { total -= 10; aces -= 1; }
  return total;
}

function short(wallet) { return `${wallet.slice(0, 6)}…${wallet.slice(-4)}`; }
function positiveInteger(value, fallback) { const parsed = Number.parseInt(value, 10); return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback; }

module.exports = { createBlackjackService };
