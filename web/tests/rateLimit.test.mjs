import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { rateLimit } from "../middleware/security.mjs";

function appWith(limit) {
  const app = express();
  app.use("/r", rateLimit(limit), (_req, res) => res.json({ ok: true }));
  return app;
}

test("budgets: probe 10/10s, download 5/10s, restart 5/10s, cancel 21/10s", async () => {
  const cases = [
    [{ maxRequests: 10, windowMs: 10_000 }, 10],
    [{ maxRequests: 5, windowMs: 10_000 }, 5],
    [{ maxRequests: 21, windowMs: 10_000 }, 21],
  ];
  for (const [limit, budget] of cases) {
    const app = appWith(limit);
    const srv = app.listen(0);
    await new Promise((r) => srv.on("listening", r));
    const port = srv.address().port;
    let limitedAt = -1;
    let retryAfter = null;
    for (let i = 0; i < budget + 1; i++) {
      const res = await fetch(`http://127.0.0.1:${port}/r`, { method: "POST" });
      if (res.status === 429) { limitedAt = i; retryAfter = res.headers.get("retry-after"); break; }
    }
    await new Promise((r) => srv.close(r));
    assert.strictEqual(limitedAt, budget, `budget ${budget} must trip exactly after ${budget} passes`);
    assert.ok(retryAfter && Number(retryAfter) > 0, "first 429 must carry numeric Retry-After");
  }
});

test("rateLimit exposes a shutdown hook so pruning timers do not outlive the server lifecycle", () => {
  const limiter = rateLimit({ maxRequests: 2, windowMs: 30000 });
  assert.equal(typeof limiter.destroy, "function");
  assert.doesNotThrow(() => limiter.destroy());
});

test("repeated limiter initialization and destruction releases every pruning timer", () => {
  const activeTimers = new Set();
  let createdTimers = 0;
  let clearedTimers = 0;
  const setIntervalFn = (callback) => {
    const timer = { callback, unref() {} };
    activeTimers.add(timer);
    createdTimers += 1;
    return timer;
  };
  const clearIntervalFn = (timer) => {
    if (activeTimers.delete(timer)) clearedTimers += 1;
  };

  for (let cycle = 0; cycle < 20; cycle += 1) {
    const limiter = rateLimit({
      maxRequests: 2,
      windowMs: 30_000,
      setIntervalFn,
      clearIntervalFn,
    });
    assert.equal(activeTimers.size, 1, `cycle ${cycle} should own one timer`);
    limiter.destroy();
    limiter.destroy();
    assert.equal(activeTimers.size, 0, `cycle ${cycle} should release its timer`);
  }

  assert.equal(createdTimers, 20);
  assert.equal(clearedTimers, 20);
});

test("a destroyed rate limiter rejects further requests", () => {
  const limiter = rateLimit({
    maxRequests: 2,
    windowMs: 30_000,
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn() {},
  });
  limiter.destroy();

  let receivedError;
  limiter({}, {}, (error) => {
    receivedError = error;
  });

  assert.match(receivedError?.message ?? "", /destroyed/);
});
