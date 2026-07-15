const express = require("express");
const { createBlackjackService } = require("./blackjack-service");
const { createBlackjackAuth } = require("./blackjack-auth");

function createBlackjackRouter() {
  const router = express.Router();
  const service = createBlackjackService();
  const auth = createBlackjackAuth();

  router.use(express.json({ limit: "16kb", strict: true }));
  router.get("/state", (_req, res) => res.json(service.snapshot()));
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
    try {
      res.json(auth.issueChallenge(req.body.wallet));
    } catch (error) {
      authError(res, error);
    }
  });

  router.post("/auth/verify", (req, res) => {
    try {
      res.json(auth.verify(req.body.wallet, req.body.signature));
    } catch (error) {
      authError(res, error);
    }
  });

  router.post("/auth/logout", (req, res) => {
    auth.revoke(req);
    res.json({ ok: true });
  });

  router.post("/join", actionRoute(service, auth, "join"));
  router.post("/leave", actionRoute(service, auth, "leave"));
  router.post("/bet", actionRoute(service, auth, "bet"));
  router.post("/action", actionRoute(service, auth, "action"));
  return router;
}

function actionRoute(service, auth, method) {
  return (req, res) => {
    try {
      const { wallet } = auth.authenticate(req);
      if (method === "join") service.join(wallet, Number(req.body.seat));
      else if (method === "bet") service.bet(wallet, Number(req.body.amount));
      else if (method === "action") service.action(wallet, String(req.body.action));
      else service.leave(wallet);
      res.json({ ok: true });
    } catch (error) {
      const message = String(error.message || error).slice(0, 240);
      const unauthorized = /session|sign in|expired/i.test(message);
      res.status(unauthorized ? 401 : 400).json({
        error: unauthorized ? "BLACKJACK_AUTH_REQUIRED" : "BLACKJACK_ACTION_REJECTED",
        message
      });
    }
  };
}

function authError(res, error) {
  res.status(401).json({
    error: "BLACKJACK_AUTH_FAILED",
    message: String(error.message || error).slice(0, 240)
  });
}

module.exports = { createBlackjackRouter };
