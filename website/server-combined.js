const express = require("express");
const http = require("http");
const path = require("path");
const { fork } = require("child_process");
const { installXFollowVerifier } = require("./x-follow-verifier");

const app = express();
const publicPort = Number.parseInt(process.env.PORT || "3000", 10);
const proxyPort = Number.parseInt(process.env.INTERNAL_PROXY_PORT || String(publicPort + 1), 10);

app.disable("x-powered-by");
app.set("trust proxy", 1);
installXFollowVerifier(app);

app.use((req, res) => {
  const headers = { ...req.headers, host: `127.0.0.1:${proxyPort}` };
  delete headers["content-length"];
  const upstream = http.request({
    hostname: "127.0.0.1",
    port: proxyPort,
    path: req.originalUrl,
    method: req.method,
    headers,
  }, upstreamResponse => {
    res.status(upstreamResponse.statusCode || 502);
    for (const [name, value] of Object.entries(upstreamResponse.headers)) {
      if (value !== undefined && name.toLowerCase() !== "transfer-encoding") res.setHeader(name, value);
    }
    upstreamResponse.pipe(res);
  });
  upstream.on("error", error => {
    if (res.headersSent) return res.end();
    res.status(502).json({ error: "SITE_STARTING", message: String(error.message || error).slice(0, 200) });
  });
  req.pipe(upstream);
});

const child = fork(path.join(__dirname, "server-proxy.js"), [], {
  env: {
    ...process.env,
    PORT: String(proxyPort),
    INTERNAL_SITE_PORT: String(proxyPort + 1),
  },
  stdio: "inherit",
});

const server = app.listen(publicPort, () => {
  console.log(`MATT combined server listening on ${publicPort}; RPC/site proxy on ${proxyPort}.`);
});

function shutdown(signal) {
  child.kill(signal);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

child.on("exit", (code, signal) => {
  console.error(`MATT proxy exited (${signal || code || "unknown"}).`);
  server.close(() => process.exit(code || 1));
});
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
