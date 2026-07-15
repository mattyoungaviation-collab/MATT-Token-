const crypto = require("crypto");
const express = require("express");
const { createBlackjackService } = require("./blackjack-service");
const { createBlackjackAuth } = require("./blackjack-auth");
const { createBlackjackChain } = require("./blackjack-chain");

function createBlackjackRouter() {
  const router = express.Router();
  const service = createBlackjackService();
  const auth = createBlackjackAuth();
  const chain = createBlackjackChain();
  const wagers = new Map();
  const settlementState = new Map();
  let contractRoundId = newContractRoundId();
  let lastPhase = service.snapshot().phase;

  router.use(express.json({ limit: "16kb", strict: true }));
  router.get("/state", (_req, res) => res.json(service.snapshot()));
  router.get("/config", async (_req, res) => {
    const health = await chain.health();
    res.json({
      ...health,
      contractRoundId,
      explorerBaseUrl: "https://app.roninchain.com/tx/",
      realWagers: true,
      supportedActions: ["hit", "stand", "surrender"]
    });
  });
  router.get("/events", (_req, res) => {
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });
    res.flushHeaders?.();
    service.subscribe(res);
  });

  router.post("/auth/challenge", (req, res) => {
    try { res.json(auth.issueChallenge(req.body.wallet)); }
    catch (error) { authError(res, error); }
  });

  router.post("/auth/verify", (req, res) => {
    try { res.json(auth.verify(req.body.wallet, req.body.signature)); }
    catch (error) { authError(res, error); }
  });

  router.post("/auth/logout", (req, res) => {
    auth.revoke(req);
    res.json({ ok: true });
  });

  router.get("/account", async (req, res) => {
    try {
      const { wallet } = auth.authenticate(req);
      const status = await chain.playerStatus(wallet);
      res.json({ wallet, ...status, wager: wagers.get(wallet) || null });
    } catch (error) {
      actionError(res, error);
    }
  });

  router.get("/settlements", (req, res) => {
    try {
      const { wallet } = auth.authenticate(req);
      res.json({ wallet, settlement: settlementState.get(wallet) || null });
    } catch (error) {
      actionError(res, error);
    }
  });

  router.post("/join", actionRoute(service, auth, "join"));
  router.post("/leave", actionRoute(service, auth, "leave"));
  router.post("/action", actionRoute(service, auth, "action"));

  router.post("/bet", async (req, res) => {
    try {
      const { wallet } = auth.authenticate(req);
      const amount = Number(req.body.amount);
      const txHash = String(req.body.txHash || "");
      const roundId = String(req.body.roundId || "");
      if (roundId.toLowerCase() !== contractRoundId.toLowerCase()) throw new Error("This table round expired. Refresh and open a new wager.");

      const health = await chain.health();
      if (!health.configured || !health.connected) throw new Error("The blackjack settlement service is not connected to Ronin.");
      if (health.paused) throw new Error("The blackjack vault is paused. No live wagers can be accepted yet.");
      if (!health.operatorMatches) throw new Error("The configured server signer is not the vault settlement operator.");

      const proof = await chain.verifyOpenWager({ txHash, player: wallet, roundId, amountMatt: amount });
      wagers.set(wallet, { ...proof, roundId, amount, acceptedAt: new Date().toISOString() });
      service.bet(wallet, amount);
      res.json({ ok: true, wagerId: proof.wagerId, txHash: proof.txHash });
    } catch (error) {
      actionError(res, error);
    }
  });

  const settlementWorker = setInterval(async () => {
    const table = service.snapshot();
    if (table.phase === "BETTING" && lastPhase !== "BETTING") {
      contractRoundId = newContractRoundId();
      wagers.clear();
    }
    lastPhase = table.phase;
    if (table.phase !== "SETTLED") return;

    for (const player of table.seats.filter(Boolean)) {
      const wager = wagers.get(player.wallet);
      if (!wager) continue;
      const existing = settlementState.get(player.wallet);
      if (existing?.wagerId === wager.wagerId && ["pending", "confirmed"].includes(existing.status)) continue;

      const outcome = outcomeForStatus(player.status);
      settlementState.set(player.wallet, { wagerId: wager.wagerId, status: "pending", outcome, startedAt: new Date().toISOString() });
      try {
        const result = await chain.settleWager(wager.wagerId, outcome);
        settlementState.set(player.wallet, {
          wagerId: wager.wagerId,
          status: "confirmed",
          outcome,
          txHash: result.txHash,
          alreadySettled: result.alreadySettled,
          confirmedAt: new Date().toISOString()
        });
      } catch (error) {
        settlementState.set(player.wallet, {
          wagerId: wager.wagerId,
          status: "failed",
          outcome,
          message: String(error?.shortMessage || error?.message || error).slice(0, 240),
          failedAt: new Date().toISOString()
        });
      }
    }
  }, 1_500);
  settlementWorker.unref?.();

  return router;
}

function actionRoute(service, auth, method) {
  return (req, res) => {
    try {
      const { wallet } = auth.authenticate(req);
      if (method === "join") service.join(wallet, Number(req.body.seat));
      else if (method === "action") {
        const action = String(req.body.action);
        if (action === "double" || action === "split") throw new Error("Double and split require the next vault version and are disabled for live wagers.");
        service.action(wallet, action);
      } else service.leave(wallet);
      res.json({ ok: true });
    } catch (error) {
      actionError(res, error);
    }
  };
}

function outcomeForStatus(status) {
  if (status === "Blackjack") return 4;
  if (status === "Won") return 3;
  if (status === "Push") return 2;
  if (/1\/2|Surrender/i.test(status)) return 1;
  return 0;
}

function newContractRoundId() {
  return `0x${crypto.randomBytes(32).toString("hex")}`;
}

function actionError(res, error) {
  const message = String(error?.shortMessage || error?.reason || error?.message || error).slice(0, 240);
  const unauthorized = /session|sign in|expired/i.test(message);
  res.status(unauthorized ? 401 : 400).json({
    error: unauthorized ? "BLACKJACK_AUTH_REQUIRED" : "BLACKJACK_ACTION_REJECTED",
    message
  });
}

function authError(res, error) {
  res.status(401).json({
    error: "BLACKJACK_AUTH_FAILED",
    message: String(error.message || error).slice(0, 240)
  });
}

module.exports = { createBlackjackRouter };