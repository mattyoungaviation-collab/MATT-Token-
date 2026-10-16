(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const units = raw => {
    const value = BigInt(raw), whole = value / 10n ** 18n;
    const fraction = (value % 10n ** 18n).toString().padStart(18, "0").slice(0, 4).replace(/0+$/, "");
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(whole) + (fraction ? `.${fraction}` : "");
  };
  const read = async path => {
    const response = await fetch(path, { cache: "no-store" });
    if (!response.ok) throw Error("CHAIN_READ_UNAVAILABLE");
    return response.json();
  };
  Promise.all([read("/api/dyno/config"), read("/api/dyno/active-round")]).then(async ([config, active]) => {
    if (config.mock || config.readOnly !== true || config.purchasesEnabled !== false ||
        config.chainId !== 2020 || !active.roundId) throw Error("READ_ONLY_CONFIG_UNAVAILABLE");
    const round = await read(`/api/dyno/round?roundId=${encodeURIComponent(active.roundId)}`);
    if (!round.config || !Array.isArray(round.config.ronPrizes) || round.config.ronPrizes.length !== 5 ||
        round.config.matt.toLowerCase() !== config.matt.toLowerCase() || round.capacity !== 1000) throw Error("ROUND_CONFIG_MISMATCH");
    $("phase").textContent = round.phase;
    $("progress").textContent = `${Number(round.eligibleCount).toLocaleString()} / 1,000`;
    $("freshness").textContent = round.chainBlock ? `Ronin block ${round.chainBlock} · unfinalized` : "Chain state unavailable";
    $("ticket-price").textContent = `${units(round.config.ticketRon)} RON + ${units(round.config.ticketMatt)} MATT`;
    $("raffle-link").href = `https://app.roninchain.com/address/${encodeURIComponent(config.raffleProxy)}`;
    $("prizes").replaceChildren(...round.config.ronPrizes.map((amount, index) => {
      const article = document.createElement("article"), label = document.createElement("small"), value = document.createElement("strong");
      label.textContent = `DRAW ${index + 1}`; value.textContent = `${units(amount)} RON`;
      article.append(label, value); return article;
    }));
    const article = document.createElement("article"), label = document.createElement("small"), value = document.createElement("strong");
    label.textContent = "DRAW 6 · GRAND PRIZE"; value.textContent = `Water Dyno #${round.config.nftTokenId}`;
    article.append(label, value); $("prizes").append(article);
  }).catch(() => {
    $("phase").textContent = "Chain read unavailable";
    $("freshness").textContent = "Try again later";
    $("prizes").textContent = "Prize quantities could not be verified right now. Purchases remain disabled.";
  });
})();
