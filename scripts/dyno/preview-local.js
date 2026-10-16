"use strict";
// Isolated, visibly mocked preview: no RPC, signer, keeper or production secrets.
const express = require("express"), path = require("path");
const { createDynoRouter } = require("../../services/dyno-api/router");
const { createMemoryStore } = require("../../services/dyno-api/store");
const manifest = require("../../config/project-dyno.local.json");
const port = Number(process.argv[2] || 3107);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Choose a local preview port between 1024 and 65535");
const app = express(), publicDir = path.join(__dirname, "../../website/public");
app.use("/api/dyno", createDynoRouter({ manifest, store: createMemoryStore(), env: {} }));
app.get("/dyno", (_req, res) => res.sendFile(path.join(publicDir, "dyno.html")));
app.use(express.static(publicDir));
app.listen(port, "127.0.0.1", () => console.log(`LOCAL MOCK ONLY: http://127.0.0.1:${port}/dyno#protection — purchases and admin execution disabled`));
