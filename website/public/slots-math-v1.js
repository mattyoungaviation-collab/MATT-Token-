(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.MattSlotsMath = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const BPS = 10_000;
  const MAX_MULTIPLIER_BPS = 5_000_000;
  const MAX_BONUS_SPINS = 50;
  const WILD = 8;
  const SCATTER = 9;
  const SYMBOL_NAMES = Object.freeze([
    "Sand", "Sprout", "Water", "Metal", "Fire",
    "Gift Box", "DynoCoin", "Top-Hat Dyno", "Golden MATT Wild", "Treasury Vault"
  ]);
  const SYMBOL_SLUGS = Object.freeze([
    "sand", "sprout", "water", "metal", "fire",
    "gift", "dynocoin", "dyno", "wild", "scatter"
  ]);
  const LINES = Object.freeze([
    [1, 1, 1, 1, 1], [0, 0, 0, 0, 0], [2, 2, 2, 2, 2],
    [0, 1, 2, 1, 0], [2, 1, 0, 1, 2], [0, 0, 1, 2, 2],
    [2, 2, 1, 0, 0], [1, 0, 0, 0, 1], [1, 2, 2, 2, 1],
    [0, 1, 1, 1, 0], [2, 1, 1, 1, 2], [1, 0, 1, 2, 1],
    [1, 2, 1, 0, 1], [0, 1, 0, 1, 0], [2, 1, 2, 1, 2],
    [1, 1, 0, 1, 1], [1, 1, 2, 1, 1], [0, 2, 0, 2, 0],
    [2, 0, 2, 0, 2], [0, 2, 2, 2, 0]
  ].map(line => Object.freeze(line)));
  const REELS = Object.freeze([
    [1,2,6,9,2,3,9,2,3,0,8,0,5,0,1,7,7,0,4,0,8,0,5,0,3,2,1,4,6,0,2,3,3,4,3,1,1,0,4,0,5,7,1,4,5,0,1,2,6,0,2,4,6,1,4,0,3,2,1,5,3,1,1,2],
    [9,1,5,3,7,2,5,9,4,0,3,3,0,6,0,3,0,5,3,0,4,4,1,5,6,3,0,5,4,0,0,2,2,1,1,2,6,1,8,4,0,0,0,1,0,2,1,6,4,2,1,1,3,1,2,4,0,2,1,7,3,8,7,2],
    [0,0,2,3,5,4,0,2,1,2,1,1,2,6,1,1,5,0,2,8,4,4,6,0,1,5,1,0,0,6,3,3,7,4,1,1,3,3,2,1,3,0,1,2,5,9,4,0,0,0,8,0,6,4,9,7,4,3,7,2,2,0,5,3],
    [5,1,6,0,3,1,0,6,7,1,4,1,0,0,6,0,3,1,1,2,2,5,3,3,2,1,5,3,5,2,8,2,2,0,1,3,6,0,4,0,0,3,1,0,0,2,9,4,1,2,2,4,0,9,3,0,8,1,5,4,4,4,7,7],
    [1,2,5,8,7,0,6,6,4,2,4,1,1,2,4,4,0,7,5,3,2,4,6,0,0,1,9,5,2,0,0,3,3,2,0,4,7,8,6,3,3,9,0,3,5,1,5,1,3,0,4,2,1,1,0,1,9,1,0,1,2,3,2,0]
  ].map(reel => Object.freeze(reel)));
  const LINE_PAYS_BPS = Object.freeze([
    3500,8750,26250, 4375,12250,35000, 5250,15750,52500,
    7000,21000,78750, 8750,31500,122500, 13125,52500,210000,
    21000,105000,437500, 35000,175000,875000, 350000,1750000,8750000,
    0,0,0
  ]);
  const SCATTER_PAYS_BPS = Object.freeze([20_000, 100_000, 250_000]);
  const BONUS_AWARDS = Object.freeze([10, 15, 25]);
  const RETRIGGER_AWARDS = Object.freeze([5, 8, 12]);

  function gridFromStops(stops, wildReel = -1) {
    if (!Array.isArray(stops) || stops.length !== 5) throw new TypeError("Five reel stops are required.");
    const grid = Array.from({ length: 5 }, () => Array(3));
    for (let reel = 0; reel < 5; reel += 1) {
      const stop = Number(stops[reel]) & 63;
      for (let row = 0; row < 3; row += 1) {
        grid[reel][row] = reel === wildReel ? WILD : REELS[reel][(stop + row) & 63];
      }
    }
    return grid;
  }

  function packGrid(grid) {
    let packed = 0n;
    for (let reel = 0; reel < 5; reel += 1) {
      for (let row = 0; row < 3; row += 1) {
        const symbol = Number(grid[reel][row]);
        if (!Number.isInteger(symbol) || symbol < 0 || symbol > 9) throw new TypeError("Invalid symbol grid.");
        packed |= BigInt(symbol) << BigInt((reel * 3 + row) * 4);
      }
    }
    return packed;
  }

  function unpackGrid(packed) {
    const value = BigInt(packed);
    return Array.from({ length: 5 }, (_, reel) =>
      Array.from({ length: 3 }, (_, row) => Number((value >> BigInt((reel * 3 + row) * 4)) & 15n))
    );
  }

  function lineWinBps(symbols) {
    if (symbols[0] === SCATTER) return 0;
    let target = WILD;
    for (const symbol of symbols) {
      if (symbol === SCATTER) break;
      if (symbol !== WILD) { target = symbol; break; }
    }
    let count = 0;
    for (const symbol of symbols) {
      if (symbol === SCATTER) break;
      if (symbol === target || symbol === WILD) count += 1;
      else break;
    }
    if (count < 3 || target >= SCATTER) return 0;
    return LINE_PAYS_BPS[target * 3 + count - 3];
  }

  function evaluateGrid(grid) {
    let multiplierBps = 0;
    let winningLinesMask = 0;
    const lineWins = [];
    LINES.forEach((line, lineIndex) => {
      const symbols = line.map((row, reel) => grid[reel][row]);
      const bps = lineWinBps(symbols);
      if (bps > 0) {
        multiplierBps += bps;
        winningLinesMask |= (1 << lineIndex);
        lineWins.push({ line: lineIndex, bps, symbols });
      }
    });
    let scatterCount = 0;
    for (const reel of grid) for (const symbol of reel) if (symbol === SCATTER) scatterCount += 1;
    let freeSpins = 0;
    let scatterPayBps = 0;
    if (scatterCount >= 3) {
      const index = Math.min(scatterCount, 5) - 3;
      scatterPayBps = SCATTER_PAYS_BPS[index];
      freeSpins = BONUS_AWARDS[index];
      multiplierBps += scatterPayBps;
    }
    multiplierBps = Math.min(multiplierBps, MAX_MULTIPLIER_BPS);
    return { multiplierBps, winningLinesMask, lineWins, scatterCount, scatterPayBps, freeSpins };
  }

  function mulberry32(seed) {
    let state = Number(seed) >>> 0;
    return function random() {
      state |= 0;
      state = state + 0x6D2B79F5 | 0;
      let value = Math.imul(state ^ state >>> 15, 1 | state);
      value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value;
      return ((value ^ value >>> 14) >>> 0) / 4294967296;
    };
  }

  function simulate(iterations = 1_000_000, seed = 0x4d415454) {
    const count = Math.max(1, Number(iterations) | 0);
    const normalizedSeed = Number(seed) >>> 0;
    const random = mulberry32(normalizedSeed);
    let totalBps = 0;
    let paidLineBps = 0;
    let paidScatterBps = 0;
    let bonusBps = 0;
    let anyReturn = 0;
    let netWin = 0;
    let bonusTriggers = 0;
    let bonusSpins = 0;
    let maxBonusSpinsObserved = 0;
    let maxSessionBpsObserved = 0;
    let maxWins = 0;
    const buckets = { zero: 0, partial: 0, oneToFive: 0, fiveToTwenty: 0, twentyToHundred: 0, hundredToFiveHundred: 0, max: 0 };

    for (let paid = 0; paid < count; paid += 1) {
      const stops = [0, 0, 0, 0, 0].map(() => Math.floor(random() * 64));
      const root = evaluateGrid(gridFromStops(stops));
      let sessionBps = root.multiplierBps;
      paidScatterBps += root.scatterPayBps;
      paidLineBps += root.multiplierBps - root.scatterPayBps;
      if (root.multiplierBps > 0) anyReturn += 1;
      if (root.multiplierBps > BPS) netWin += 1;

      if (root.freeSpins > 0 && sessionBps < MAX_MULTIPLIER_BPS) {
        bonusTriggers += 1;
        let remaining = root.freeSpins;
        let awarded = root.freeSpins;
        while (remaining > 0 && sessionBps < MAX_MULTIPLIER_BPS) {
          remaining -= 1;
          bonusSpins += 1;
          const bonusStops = [0, 0, 0, 0, 0].map(() => Math.floor(random() * 64));
          const wildReel = Math.floor(random() * 5);
          const result = evaluateGrid(gridFromStops(bonusStops, wildReel));
          const payoutBps = Math.min(result.multiplierBps, MAX_MULTIPLIER_BPS - sessionBps);
          sessionBps += payoutBps;
          bonusBps += payoutBps;
          if (result.scatterCount >= 3 && awarded < MAX_BONUS_SPINS && sessionBps < MAX_MULTIPLIER_BPS) {
            const index = Math.min(result.scatterCount, 5) - 3;
            const retrigger = Math.min(RETRIGGER_AWARDS[index], MAX_BONUS_SPINS - awarded);
            remaining += retrigger;
            awarded += retrigger;
          }
        }
        maxBonusSpinsObserved = Math.max(maxBonusSpinsObserved, awarded);
      }

      maxSessionBpsObserved = Math.max(maxSessionBpsObserved, sessionBps);
      totalBps += sessionBps;
      if (sessionBps === 0) buckets.zero += 1;
      else if (sessionBps < BPS) buckets.partial += 1;
      else if (sessionBps < 50_000) buckets.oneToFive += 1;
      else if (sessionBps < 200_000) buckets.fiveToTwenty += 1;
      else if (sessionBps < 1_000_000) buckets.twentyToHundred += 1;
      else if (sessionBps < MAX_MULTIPLIER_BPS) buckets.hundredToFiveHundred += 1;
      else { buckets.max += 1; maxWins += 1; }
    }

    const ratio = value => value / count;
    const paidLineRtp = paidLineBps / count / BPS;
    const paidScatterRtp = paidScatterBps / count / BPS;
    return {
      model: "MATT Slots V1 Resource Rush",
      seed: `0x${normalizedSeed.toString(16).padStart(8, "0")}`,
      iterations: count,
      rtp: totalBps / count / BPS,
      baseRtp: paidLineRtp + paidScatterRtp,
      paidLineRtp,
      paidScatterRtp,
      bonusRtp: bonusBps / count / BPS,
      anyReturnRate: ratio(anyReturn),
      paidSpinNetWinRate: ratio(netWin),
      bonusTriggerRate: ratio(bonusTriggers),
      bonusFrequency: bonusTriggers ? count / bonusTriggers : null,
      totalBonusSpins: bonusSpins,
      averageBonusSpins: bonusTriggers ? bonusSpins / bonusTriggers : 0,
      maxBonusSpinsObserved,
      maxSessionMultiplier: maxSessionBpsObserved / BPS,
      maxWinCount: maxWins,
      maxWinFrequency: maxWins ? count / maxWins : null,
      buckets: Object.fromEntries(Object.entries(buckets).map(([key, value]) => [key, ratio(value)]))
    };
  }

  return Object.freeze({
    BPS, MAX_MULTIPLIER_BPS, MAX_BONUS_SPINS, WILD, SCATTER,
    SYMBOL_NAMES, SYMBOL_SLUGS, LINES, REELS, LINE_PAYS_BPS,
    SCATTER_PAYS_BPS, BONUS_AWARDS, RETRIGGER_AWARDS,
    gridFromStops, packGrid, unpackGrid, lineWinBps, evaluateGrid, simulate
  });
});
