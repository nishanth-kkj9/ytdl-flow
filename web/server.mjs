import express from "express";
import http from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { config, allowedHostsFor } from "./config.mjs";
import { EventBus } from "./eventBus.mjs";
import { EngineManager } from "./services/engineManager.mjs";
import { historyService } from "./services/historyService.mjs";
import { attachHistoryPersistence } from "./services/historyPersistence.mjs";
import { probeRouter } from "./routes/probe.mjs";
import { cancelRouter, downloadRouter } from "./routes/download.mjs";
import { historyRouter } from "./routes/history.mjs";
import { statusRouter } from "./routes/status.mjs";
import { restartRouter } from "./routes/restart.mjs";
import { staticMiddleware } from "./middleware/static.mjs";
import { rateLimit, originCheck, wsVerifyClient } from "./middleware/security.mjs";
import { requestLogger } from "./middleware/requestLog.mjs";

async function main() {
  // ── Core services ───────────────────────────────────────────────────────
  await historyService.init();
  const bus = new EventBus();
  const engine = new EngineManager(bus);
  // F-01: history must survive the browser tab — persist successful results
  // server-side (client saves dedupe against this by id).
  const unsubscribeHistory = attachHistoryPersistence(bus, historyService);

  // ── Express app ─────────────────────────────────────────────────────────
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.disable("x-powered-by");
  // Compact per-request observability line for /api/* (static stays quiet).
  app.use(requestLogger());
  // Production security headers (no external dep needed for local app)
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    // P2-42: Content-Security-Policy for the served production build. The
    // built index.html loads exactly one external module script and no inline
    // scripts/handlers (verified), so script-src can stay strict. Style needs
    // 'unsafe-inline' because React renders style="" attributes (CSP blocks
    // inline style attributes without it); thumbnails come from i.ytimg.com
    // (https: + data:); the app speaks WebSocket to its own origin, which
    // 'self' does not cover cross-scheme — but only the loopback origins this
    // server is reachable on are allowed (F-16: a bare ws: let the SPA open
    // sockets to ANY WebSocket server; the app only ever talks to itself).
    res.setHeader(
      "Content-Security-Policy",
      [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' https: data:",
        "font-src 'self' data:",
        // F-16/R4: must cover every origin the server itself accepts —
        // allowedHostsFor() includes [::1], and the ws-origin check (tested)
        // admits IPv6 loopback, so the CSP has to admit it too or the browser
        // silently blocks a socket the backend considers legitimate.
        // N-14: bracketed IPv6 literals are NOT accepted in CSP host-sources.
        // Chrome reports "contains an invalid source: 'ws://[::1]:*'. It will
        // be ignored." and DROPS the entry on every page load — so the source
        // added for N-05 never did anything, and the port-less spelling
        // (`ws://[::1]`) is rejected just the same (verified live 2026-09-16).
        // Verified live in the same session: the app served from
        // http://[::1]:3212 still reaches "Engine ready" over its WebSocket
        // with only `'self'` covering it — same-origin ws/wss is matched by
        // 'self', so the IPv6 loopback case needs no source of its own.
        "connect-src 'self' ws://127.0.0.1:* ws://localhost:* wss://localhost:*",
        "media-src 'self'",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
      ].join("; ")
    );
    next();
  });

  // Reject requests with unexpected Host headers (DNS rebinding protection).
  // A local server must only be reachable via 127.0.0.1/localhost — an
  // attacker-controlled domain resolving to 127.0.0.1 must not pass.
  // NOTE: This allowlist is intentionally localhost-only. If `HOST` is
  // overridden to expose the server on a LAN, LAN clients' Host headers will
  // be rejected with 421 — the server is designed to be local-hosted.
  const allowedHosts = allowedHostsFor(config.port);
  app.use((req, res, next) => {
    const host = String(req.headers.host || "").toLowerCase();
    if (!allowedHosts.has(host)) {
      return res.status(421).json({ error: "Invalid Host header" });
    }
    next();
  });

  // API routes (modular — add feature routes here).
  // Mutating endpoints are rate-limited and origin-checked to prevent a local
  // process or compromised browser tab from flooding the engine, and to block
  // cross-site requests (defense-in-depth on top of the JSON-only body parsing).
  app.use("/api/probe", originCheck(), rateLimit({ maxRequests: 10, windowMs: 10_000 }), probeRouter(engine));
  app.use("/api/download/cancel", originCheck(), rateLimit({ maxRequests: 21, windowMs: 10_000 }), cancelRouter(engine));
  app.use("/api/download", originCheck(), rateLimit({ maxRequests: 5, windowMs: 10_000 }), downloadRouter(engine));
  app.use("/api/history", originCheck(), historyRouter(historyService));
  app.use("/api/status", statusRouter(engine));
  app.use("/api/engine/restart", originCheck(), rateLimit({ maxRequests: 5, windowMs: 10_000 }), restartRouter(engine));

  // Health check. Liveness ping for the Node process AND a peek at engine
  // readiness in one call — lets a monitor distinguish "server up but engine
  // crashed" from "everything healthy". `ok` reflects only the server itself
  // so a dead engine never looks like a dead server.
  app.get("/api/health", (_req, res) =>
    res.json({ ok: true, engineReady: engine.isReady() })
  );

  // Unknown /api routes must return JSON 404s, not fall through to the SPA
  // handler (which would answer 200 HTML for GET /api/typo and confuse
  // programmatic clients).
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  // Static frontend + downloads.
  app.use(staticMiddleware(config));

  // ── HTTP + WebSocket server ─────────────────────────────────────────────
  const server = http.createServer(app);
  // Same loopback-origin policy as the REST originCheck() middleware: no-
  // Origin clients and loopback origins connect; foreign origins are
  // rejected at upgrade time (403) so other pages open in the browser
  // cannot eavesdrop on server broadcasts (paths, titles, engine logs).
  const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 1024 * 1024, verifyClient: wsVerifyClient });

  function broadcast(message) {
    const data = JSON.stringify(message);
    for (const client of wss.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      // Backpressure guard: a throttled/backgrounded tab drains its socket
      // slowly, while 5 downloads stream progress events. Skip (don't buffer)
      // when the client's send buffer exceeds 1 MB — the client catches up via
      // the reconnect reconciliation instead of the server buffering forever.
      if (client.bufferedAmount > 1_000_000) {
        continue;
      }
      client.send(data);
    }
  }

  // Relay all engine events to connected browsers.
  const eventTypes = [
    "engine_ready",
    "engine_log",
    "engine_crashed",
    "engine_error",
    "fatal_error",
    "probe_result",
    "download_started",
    "progress",
    "result",
    "cancelled",
    "error",
    "download_retry",
  ];
  const unsubs = eventTypes.map((type) =>
    bus.subscribe(type, (payload) => broadcast({ type, payload }))
  );

  wss.on("connection", (socket) => {
    // P0-1: the ws library emits 'error' on individual sockets for
    // receiver-level failures (oversized frame > maxPayload, invalid UTF-8,
    // protocol violations). With no 'error' listener Node raises an uncaught
    // exception → the global handler exits the whole server, killing every
    // active download. Any local process can open this socket (no-Origin
    // clients are allowed for curl support), so this MUST be tolerant.
    socket.on("error", () => socket.terminate());
    // Send current engine status on connect. The payload includes
    // `type: "engine_ready"` so the frontend's event router recognizes it
    // (the bus-relayed engine_ready carries the type inside its payload;
    // this synthetic message historically did not, which left the UI's
    // engine badge stuck on "starting" whenever the client connected after
    // the engine had already become ready).
    socket.send(
      JSON.stringify({
        type: "engine_ready",
        payload: {
          type: "engine_ready",
          ready: engine.isReady(),
          ...(engine.getTools() ?? {}),
        },
      })
    );
    // Track liveness so stale/half-open connections are cleaned up.
    socket.isAlive = true;
    socket.on("pong", () => {
      socket.isAlive = true;
    });
    // Note: The WebSocket is strictly for server → client event broadcasting.
    // Incoming commands are NOT accepted here — all mutating operations
    // (probe, download, cancel) go through the validated REST API routes.
    // This prevents Cross-Site WebSocket Hijacking (CSWSH) attacks where a
    // malicious website could otherwise drive arbitrary downloads or
    // arbitrary file writes via the Python engine.
  });

  // ── WebSocket heartbeat ─────────────────────────────────────────────────────
  // Terminate clients that miss two consecutive heartbeats so half-open
  // connections don't accumulate. The timer is unref'd so it never blocks
  // process exit.
  const HEARTBEAT_INTERVAL_MS = 30_000;
  const heartbeat = setInterval(() => {
    for (const client of wss.clients) {
      if (!client.isAlive) {
        client.terminate();
        continue;
      }
      client.isAlive = false;
      try {
        client.ping();
      } catch {
        client.terminate();
      }
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();

  // ── Start engine ────────────────────────────────────────────────────────
  engine.start();

  // ── Graceful shutdown ───────────────────────────────────────────────────
  const shutdown = () => {
    console.log("\nShutting down...");
    clearInterval(heartbeat);
    unsubs.forEach((u) => u());
    unsubscribeHistory();
    engine.stop();
    // PR-04: wss.close() only stops accepting NEW upgrades; connected clients
    // would keep server.close()'s callback from firing until the 2s force
    // exit. Terminate them so shutdown is prompt and deterministic.
    for (const client of wss.clients) {
      client.terminate();
    }
    wss.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // ── Error handling middleware ───────────────────────────────────────────
  // Preserve the status code that upstream layers attached to the error
  // (e.g. 404 from a missing /downloads file, 400 from malformed JSON)
  // instead of blanket-500ing every failure. Only include the message in
  // the response when the error is explicitly marked safe to expose.
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    const status = Number(err?.statusCode || err?.status) || 500;
    if (status >= 500) console.error("[server] Unhandled error:", err);
    res.status(status).json({
      error: status >= 500 || !err?.expose ? "Internal server error" : err.message,
    });
  });

  // ── Listen ──────────────────────────────────────────────────────────────
  server.listen(config.port, config.host, () => {
    console.log(`\n🎬 YTDL Flow Web`);
    console.log(`   ➜  http://${config.host}:${config.port}`);
    console.log(`   ➜  API health: http://${config.host}:${config.port}/api/health`);
    console.log(`   ➜  WebSocket: ws://${config.host}:${config.port}/ws\n`);
  });
}

process.on("unhandledRejection", (reason) => {
  console.error("[server] Unhandled rejection:", reason);
  process.exit(1);
});
process.on("uncaughtException", (err) => {
  console.error("[server] Uncaught exception:", err);
  process.exit(1);
});

main().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
