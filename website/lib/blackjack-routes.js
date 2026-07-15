const express = require("express");
const { createBlackjackService } = require("./blackjack-service");

function createBlackjackRouter() {
  const router = express.Router();
  const service = createBlackjackService();

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

  router.post("/join", actionRoute(service, "join"));
  router.post("/leave", actionRoute(service, "leave"));
  router.post("/bet", actionRoute(service, "bet"));
  router.post("/action", actionRoute(service, "action"));
  return router;
}

function actionRoute(service, method) {
  return (req, res) => {
    try {
      if (method === "join") service.join(req.body.wallet, Number(req.body.seat));
      else if (method === "bet") service.bet(req.body.wallet, Number(req.body.amount));
      else if (method === "action") service.action(req.body.wallet, String(req.body.action));
      else service.leave(req.body.wallet);
      res.json({ ok: true });
    } catch (error) {
      res.status(400).json({
        error: "BLACKJACK_ACTION_REJECTED",
        message: String(error.message || error).slice(0, 240)
      });
    }
  };
}

module.exports = { createBlackjackRouter };
