import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import { test } from "node:test";
import { WebSocket } from "ws";
import { startServer } from "../server.mjs";
import { EngineManager } from "../services/engineManager.mjs";
import { rateLimit } from "../middleware/security.mjs";

function request(address, hostHeader) {
  const url = new URL(address);
  return new Promise((resolve, reject) => {
    const req = http.get(
      {
        host: url.hostname,
        port: url.port,
        path: "/api/health",
        headers: hostHeader ? { Host: hostHeader } : undefined,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
      },
    );
    req.on("error", reject);
  });
}

function trackedRateLimiters() {
  const activeTimers = new Set();
  let createdTimers = 0;
  let clearedTimers = 0;
  const createRateLimiter = (options) =>
    rateLimit({
      ...options,
      setIntervalFn: (callback) => {
        const timer = { callback, unref() {} };
        activeTimers.add(timer);
        createdTimers += 1;
        return timer;
      },
      clearIntervalFn: (timer) => {
        if (activeTimers.delete(timer)) clearedTimers += 1;
      },
    });

  return {
    createRateLimiter,
    activeTimers,
    get createdTimers() {
      return createdTimers;
    },
    get clearedTimers() {
      return clearedTimers;
    },
  };
}

test("startServer exposes a bound localhost URL and closes owned resources", async () => {
  let engineStarted = 0;
  let engineStopped = 0;
  const app = await startServer({
    port: 0,
    history: {
      init: async () => {},
      saveRecord: async () => {},
      loadHistory: async () => [],
      clear: async () => {},
    },
    createEngine: () => ({
      start() {
        engineStarted += 1;
      },
      stop() {
        engineStopped += 1;
      },
      isReady: () => false,
      getTools: () => null,
      getCookieState: () => null,
      getPendingCount: () => 0,
      requestJobs: async () => [],
    }),
    logStartup: false,
  });

  try {
    assert.match(app.address, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.strictEqual(engineStarted, 1);
    const healthy = await request(app.address);
    assert.strictEqual(healthy.status, 200);
    assert.deepStrictEqual(healthy.body, { ok: true, engineReady: false });

    const rejected = await request(app.address, "attacker.example");
    assert.strictEqual(rejected.status, 421);
    assert.deepStrictEqual(rejected.body, { error: "Invalid Host header" });

    const serverSocketClosed = new Promise((resolve) => {
      app.wss.once("connection", (serverSocket) => serverSocket.once("close", resolve));
    });
    const socket = new WebSocket(`${app.address.replace(/^http/, "ws")}/ws`);
    await new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    assert.equal(app.wss.clients.size, 1);
    const socketClosed = new Promise((resolve) => socket.once("close", resolve));
    socket.close();
    await socketClosed;
    await serverSocketClosed;
    assert.equal(app.wss.clients.size, 0, "disconnected WebSocket clients must be removed");
  } finally {
    await app.close();
    await app.close();
  }

  assert.strictEqual(engineStopped, 1, "close should stop the engine once");
  assert.strictEqual(app.server.listening, false, "close should stop the HTTP listener");
  assert.equal(app.server.listenerCount("request"), 0, "close should release the Express request handler");
  assert.equal(app.server.listenerCount("upgrade"), 0, "close should release the WebSocket upgrade handler");
  assert.equal(app.wss.listenerCount("connection"), 0, "close should release the WebSocket connection handler");
});

test("startServer cleans up services when the requested port is unavailable", async () => {
  const occupied = http.createServer();
  await new Promise((resolve) => occupied.listen(0, "127.0.0.1", resolve));
  const { port } = occupied.address();
  let engineStopped = 0;
  const trackedLimiters = trackedRateLimiters();

  try {
    await assert.rejects(
      startServer({
        port,
        createRateLimiter: trackedLimiters.createRateLimiter,
        history: {
          init: async () => {},
          saveRecord: async () => {},
          loadHistory: async () => [],
          clear: async () => {},
        },
        createEngine: () => ({
          stop() {
            engineStopped += 1;
          },
        }),
        logStartup: false,
      }),
      { code: "EADDRINUSE" },
    );
    assert.strictEqual(engineStopped, 1, "failed startup should stop initialized services");
    assert.equal(trackedLimiters.createdTimers, 4);
    assert.equal(trackedLimiters.activeTimers.size, 0, "failed startup must clear limiter timers");
    assert.equal(trackedLimiters.clearedTimers, 4);
  } finally {
    await new Promise((resolve, reject) => {
      occupied.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("startServer releases earlier limiter timers if limiter initialization fails", async () => {
  const trackedLimiters = trackedRateLimiters();
  let created = 0;
  const createRateLimiter = (options) => {
    created += 1;
    if (created === 3) throw new Error("limiter initialization failed");
    return trackedLimiters.createRateLimiter(options);
  };

  await assert.rejects(
    startServer({
      port: 0,
      createRateLimiter,
      history: {
        init: async () => {},
        saveRecord: async () => {},
        loadHistory: async () => [],
        clear: async () => {},
      },
      createEngine: () => ({ stop() {} }),
      logStartup: false,
    }),
    /limiter initialization failed/,
  );
  assert.equal(trackedLimiters.createdTimers, 2);
  assert.equal(trackedLimiters.activeTimers.size, 0);
  assert.equal(trackedLimiters.clearedTimers, 2);
});

test("repeated server startup and shutdown releases each cycle's limiter timers", async () => {
  const trackedLimiters = trackedRateLimiters();
  const history = {
    init: async () => {},
    saveRecord: async () => {},
    loadHistory: async () => [],
    clear: async () => {},
  };

  for (let cycle = 0; cycle < 5; cycle += 1) {
    let app;
    try {
      app = await startServer({
        port: 0,
        history,
        createRateLimiter: trackedLimiters.createRateLimiter,
        createEngine: () => ({
          start() {},
          stop() {},
          isReady: () => false,
          getTools: () => null,
          getCookieState: () => null,
          getPendingCount: () => 0,
          requestJobs: async () => [],
        }),
        logStartup: false,
      });

      assert.equal(trackedLimiters.activeTimers.size, 4);
      await app.close();
      await app.close();
      assert.equal(trackedLimiters.activeTimers.size, 0, `cycle ${cycle} should release timers`);
    } finally {
      await app?.close();
    }
  }

  assert.equal(trackedLimiters.createdTimers, 20);
  assert.equal(trackedLimiters.clearedTimers, 20);
});

test("EngineManager.stop waits for a running Python child to exit", async () => {
  const manager = new EngineManager({});
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.stdin = {
    destroyed: false,
    end() {
      setTimeout(() => {
        child.exitCode = 0;
        child.emit("exit", 0, null);
      }, 10);
    },
  };
  child.kill = () => true;
  manager.child = child;
  manager.stdin = child.stdin;

  await manager.stop();
  assert.strictEqual(child.exitCode, 0);
  assert.strictEqual(manager.child, null);
});
