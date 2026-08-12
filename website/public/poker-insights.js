(function (root) {
  "use strict";

  const RANKS = "23456789TJQKA";
  const SUITS = "cdhs";
  const LONG_RANK = {
    14: "Ace", 13: "King", 12: "Queen", 11: "Jack", 10: "Ten",
    9: "Nine", 8: "Eight", 7: "Seven", 6: "Six", 5: "Five",
    4: "Four", 3: "Three", 2: "Two"
  };
  const PLURAL_RANK = {
    14: "Aces", 13: "Kings", 12: "Queens", 11: "Jacks", 10: "Tens",
    9: "Nines", 8: "Eights", 7: "Sevens", 6: "Sixes", 5: "Fives",
    4: "Fours", 3: "Threes", 2: "Twos"
  };

  function decode(card) {
    const raw = String(card || "");
    const rank = RANKS.indexOf(raw[0]) + 2;
    if (rank < 2 || !SUITS.includes(raw[1]) || raw.length !== 2) {
      throw new Error("Invalid poker card.");
    }
    return { code: raw, rank, suit: raw[1] };
  }

  function straightHigh(ranks) {
    const unique = [...new Set(ranks)].sort((a, b) => b - a);
    if (unique.includes(14)) unique.push(1);
    for (let i = 0; i <= unique.length - 5; i += 1) {
      if (
        unique[i] - 1 === unique[i + 1] &&
        unique[i + 1] - 1 === unique[i + 2] &&
        unique[i + 2] - 1 === unique[i + 3] &&
        unique[i + 3] - 1 === unique[i + 4]
      ) return unique[i];
    }
    return 0;
  }

  function evaluateFive(cards) {
    const parsed = cards.map(decode);
    const ranks = parsed.map(card => card.rank).sort((a, b) => b - a);
    const counts = new Map();
    ranks.forEach(rank => counts.set(rank, (counts.get(rank) || 0) + 1));
    const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
    const flush = parsed.every(card => card.suit === parsed[0].suit);
    const straight = straightHigh(ranks);

    if (flush && straight) return { category: 8, values: [straight] };
    if (groups[0][1] === 4) {
      return { category: 7, values: [groups[0][0], groups.find(group => group[1] === 1)[0]] };
    }
    if (groups[0][1] === 3 && groups[1] && groups[1][1] === 2) {
      return { category: 6, values: [groups[0][0], groups[1][0]] };
    }
    if (flush) return { category: 5, values: ranks };
    if (straight) return { category: 4, values: [straight] };
    if (groups[0][1] === 3) {
      return {
        category: 3,
        values: [groups[0][0], ...groups.filter(group => group[1] === 1).map(group => group[0]).sort((a, b) => b - a)]
      };
    }
    const pairs = groups.filter(group => group[1] === 2).map(group => group[0]).sort((a, b) => b - a);
    if (pairs.length >= 2) {
      const kicker = groups.filter(group => group[1] === 1).map(group => group[0]).sort((a, b) => b - a)[0];
      return { category: 2, values: [pairs[0], pairs[1], kicker] };
    }
    if (pairs.length === 1) {
      return {
        category: 1,
        values: [pairs[0], ...groups.filter(group => group[1] === 1).map(group => group[0]).sort((a, b) => b - a)]
      };
    }
    return { category: 0, values: ranks };
  }

  function compare(left, right) {
    if (left.category !== right.category) return left.category > right.category ? 1 : -1;
    const length = Math.max(left.values.length, right.values.length);
    for (let i = 0; i < length; i += 1) {
      const a = left.values[i] || 0;
      const b = right.values[i] || 0;
      if (a !== b) return a > b ? 1 : -1;
    }
    return 0;
  }

  function bestHand(cards) {
    if (cards.length < 5 || cards.length > 7) throw new Error("Poker evaluation requires five to seven cards.");
    let best = null;
    const chosen = [];
    function choose(start) {
      if (chosen.length === 5) {
        const score = evaluateFive(chosen);
        if (!best || compare(score, best) > 0) best = score;
        return;
      }
      for (let i = start; i <= cards.length - (5 - chosen.length); i += 1) {
        chosen.push(cards[i]);
        choose(i + 1);
        chosen.pop();
      }
    }
    choose(0);
    return best;
  }

  function handLabel(score) {
    const value = score.values;
    if (score.category === 8) return value[0] === 14 ? "Royal Flush" : LONG_RANK[value[0]] + "-high Straight Flush";
    if (score.category === 7) return "Four " + PLURAL_RANK[value[0]];
    if (score.category === 6) return PLURAL_RANK[value[0]] + " full of " + PLURAL_RANK[value[1]];
    if (score.category === 5) return LONG_RANK[value[0]] + "-high Flush";
    if (score.category === 4) return LONG_RANK[value[0]] + "-high Straight";
    if (score.category === 3) return "Three " + PLURAL_RANK[value[0]];
    if (score.category === 2) return "Two Pair, " + PLURAL_RANK[value[0]] + " and " + PLURAL_RANK[value[1]];
    if (score.category === 1) return "Pair of " + PLURAL_RANK[value[0]];
    return LONG_RANK[value[0]] + " High";
  }

  function startingHandLabel(holeCards) {
    const cards = holeCards.map(decode).sort((a, b) => b.rank - a.rank);
    if (cards[0].rank === cards[1].rank) return "Pocket " + PLURAL_RANK[cards[0].rank];
    return LONG_RANK[cards[0].rank] + "-" + LONG_RANK[cards[1].rank] +
      (cards[0].suit === cards[1].suit ? " Suited" : " Offsuit");
  }

  function hash(text) {
    let value = 2166136261;
    for (let i = 0; i < text.length; i += 1) {
      value ^= text.charCodeAt(i);
      value = Math.imul(value, 16777619);
    }
    return value >>> 0;
  }

  function random(seed) {
    let state = seed >>> 0;
    return function next() {
      state += 0x6D2B79F5;
      let value = state;
      value = Math.imul(value ^ value >>> 15, value | 1);
      value ^= value + Math.imul(value ^ value >>> 7, value | 61);
      return ((value ^ value >>> 14) >>> 0) / 4294967296;
    };
  }

  function estimateEquity(holeCards, board, opponents, trials) {
    if (opponents <= 0) return { equityPercent: 100, winPercent: 100, tiePercent: 0 };
    const known = new Set([...holeCards, ...board]);
    const deck = [];
    for (const rank of RANKS) for (const suit of SUITS) {
      const card = rank + suit;
      if (!known.has(card)) deck.push(card);
    }
    const missingBoard = 5 - board.length;
    const needed = missingBoard + opponents * 2;
    const rng = random(hash([...known].sort().join("") + ":" + opponents));
    let equity = 0;
    let wins = 0;
    let ties = 0;

    for (let trial = 0; trial < trials; trial += 1) {
      const pool = deck.slice();
      for (let i = 0; i < needed; i += 1) {
        const swap = i + Math.floor(rng() * (pool.length - i));
        const value = pool[i];
        pool[i] = pool[swap];
        pool[swap] = value;
      }
      const runout = board.concat(pool.slice(0, missingBoard));
      const hero = bestHand(holeCards.concat(runout));
      let beaten = false;
      let tiedOpponents = 0;
      let cursor = missingBoard;
      for (let opponent = 0; opponent < opponents; opponent += 1) {
        const villain = bestHand([pool[cursor], pool[cursor + 1]].concat(runout));
        cursor += 2;
        const result = compare(villain, hero);
        if (result > 0) {
          beaten = true;
          break;
        }
        if (result === 0) tiedOpponents += 1;
      }
      if (!beaten) {
        if (tiedOpponents) {
          ties += 1;
          equity += 1 / (tiedOpponents + 1);
        } else {
          wins += 1;
          equity += 1;
        }
      }
    }
    return {
      equityPercent: equity * 100 / trials,
      winPercent: wins * 100 / trials,
      tiePercent: ties * 100 / trials
    };
  }

  function calculate(options) {
    const holeCards = (options.holeCards || []).map(card => decode(card).code);
    const board = (options.board || []).map(card => decode(card).code);
    const opponents = Math.max(0, Math.min(5, Number(options.opponents) || 0));
    if (holeCards.length !== 2 || board.length > 5) throw new Error("Incomplete private hand.");
    if (new Set([...holeCards, ...board]).size !== holeCards.length + board.length) {
      throw new Error("Duplicate poker card.");
    }
    const rating = board.length >= 3
      ? handLabel(bestHand(holeCards.concat(board)))
      : startingHandLabel(holeCards);
    const trials = board.length === 5 ? 3000 : 2200;
    return { rating, opponents, trials, ...estimateEquity(holeCards, board, opponents, trials) };
  }

  root.MattPokerInsights = Object.freeze({ calculate, bestHand, compare, handLabel });
})(window);
