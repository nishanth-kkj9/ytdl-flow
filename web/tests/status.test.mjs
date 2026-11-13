import assert from "node:assert";
import http from "node:http";
import express from "express";
import { statusRouter } from "../routes/status.mjs";

// status.mjs route tests: operational visibility fields exposed by /api/status.

function makeEngine(overrides = {}) {
  return {
    isReady: () => true,
    getTools: () => ({ ffmpeg: true, ffprobe: true, deno: false }),
    getPendingCount: () => 3,
    requestJobs: async () => [{ id: "job-1", status: "running" }],
    ...overrides,
  };
}

function request(app, path) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      http
        .get({ host: "127.0.0.1", port, path }, (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => {
            server.close();
            try {
              resolve({ status: res.statusCode, body: JSON.parse(data) });
            } catch {
              resolve({ status: res.statusCode, body: null });
            }
          });
        })
        .on("error", (err) => {
          server.close();
          reject(err);
        });
    });
  });
}

// Test 1: /api/status reports operational visibility fields.
{
  const app = express();
  app.use("/api/status", statusRouter(makeEngine()));
  const res = await request(app, "/api/status");
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.server, "ytdl-flow-web");
  assert.strictEqual(typeof res.body.version, "string", "version should be a string");
  assert.ok(Number.isInteger(res.body.uptimeSeconds), "uptimeSeconds should be an integer");
  assert.ok(res.body.uptimeSeconds >= 0, "uptimeSeconds should not be negative");
  assert.strictEqual(res.body.engineReady, true);
  assert.deepStrictEqual(res.body.tools, { ffmpeg: true, ffprobe: true, deno: false });
  assert.strictEqual(res.body.pendingCommands, 3, "pending queue depth should be exposed");
  assert.deepStrictEqual(res.body.activeJobs, [{ id: "job-1", status: "running" }]);
  assert.strictEqual(
    res.body.activeJobsSnapshotAvailable,
    false,
    "legacy array-only managers cannot confirm a snapshot"
  );
  assert.strictEqual(typeof res.body.downloadDir, "string");
  console.log("✓ status: version, uptime, engine, tools, pending, jobs all present");
}

// Test 2: endpoint stays healthy for a mock engine that lacks the new accessors
// (backward-compatible with any caller of getTools()/requestJobs()).
{
  const app = express();
  app.use(
    "/api/status",
    statusRouter(
      makeEngine({
        getPendingCount: undefined,
        getTools: undefined,
        requestJobs: undefined,
      })
    )
  );
  const res = await request(app, "/api/status");
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.pendingCommands, 0, "pendingCommands should default to 0");
  assert.deepStrictEqual(res.body.tools, null, "tools should default to null");
  assert.deepStrictEqual(res.body.activeJobs, [], "activeJobs should default to []");
  assert.strictEqual(res.body.activeJobsSnapshotAvailable, false);
  console.log("✓ status: missing engine accessors degrade safely");
}

// Test 3: requestJobs rejection must not fail the endpoint.
{
  const app = express();
  app.use(
    "/api/status",
    statusRouter(
      makeEngine({
        requestJobs: async () => {
          throw new Error("engine not responding");
        },
      })
    )
  );
  const res = await request(app, "/api/status");
  assert.strictEqual(res.status, 200, "A failing job snapshot must not 500 the endpoint");
  assert.deepStrictEqual(res.body.activeJobs, []);
  assert.strictEqual(
    res.body.activeJobsSnapshotAvailable,
    false,
    "a failed snapshot must not look like a confirmed empty queue"
  );
  console.log("✓ status: active-jobs snapshot failure degrades to [] (no 500)");
}

// Test 4: stability fields — cookies (source-only) and bot_breaker ride
// /api/status so the UI can warn before the first bot-check lands.
{
  const app = express();
  app.use(
    "/api/status",
    statusRouter(
      makeEngine({
        getCookieState: () => ({ configured: false, source: "none" }),
        requestJobsFull: async () => ({
          jobs: [],
          bot_breaker: { open: true, consecutive_failures: 3, cooldown_seconds: 240 },
          available: true,
        }),
        // requestJobs must NOT be called when the full variant exists.
        requestJobs: async () => {
          throw new Error("requestJobs should not be called when requestJobsFull exists");
        },
      })
    )
  );
  const res = await request(app, "/api/status");
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body.cookies, { configured: false, source: "none" });
  assert.deepStrictEqual(res.body.bot_breaker, {
    open: true,
    consecutive_failures: 3,
    cooldown_seconds: 240,
  });
  assert.strictEqual(
    res.body.activeJobsSnapshotAvailable,
    true,
    "a well-formed empty jobs reply is a confirmed snapshot"
  );
  console.log("✓ status: cookies + bot_breaker exposed via requestJobsFull");
}

// Test 5: legacy engineManager without the new accessors degrades to nulls.
{
  const app = express();
  app.use(
    "/api/status",
    statusRouter(
      makeEngine({
        requestJobs: async () => [],
      })
    )
  );
  const res = await request(app, "/api/status");
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.cookies, null, "cookies should default to null");
  assert.strictEqual(res.body.bot_breaker, null, "bot_breaker should default to null");
  assert.strictEqual(res.body.activeJobsSnapshotAvailable, false);
  console.log("✓ status: legacy engine degrades to cookies=null, bot_breaker=null");
}

// Test 6: malformed or unavailable job replies are never treated as a
// confirmed empty snapshot, and engine-down short-circuits the query.
{
  for (const full of [
    { jobs: "not-an-array", available: true },
    { jobs: [], available: false },
    { jobs: [], available: true },
  ]) {
    const app = express();
    app.use(
      "/api/status",
      statusRouter(
        makeEngine({
          requestJobsFull: async () => full,
        })
      )
    );
    const res = await request(app, "/api/status");
    assert.strictEqual(res.status, 200);
    const expected =
      full.available === true && Array.isArray(full.jobs) && full.jobs.length === 0;
    assert.strictEqual(
      res.body.activeJobsSnapshotAvailable,
      expected,
      `snapshot availability must match the engine reply (${JSON.stringify(full)})`
    );
  }

  const app = express();
  app.use(
    "/api/status",
    statusRouter(
      makeEngine({
        isReady: () => false,
        requestJobsFull: async () => {
          throw new Error("must not query a down engine");
        },
      })
    )
  );
  const res = await request(app, "/api/status");
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.activeJobsSnapshotAvailable, false);
  console.log("✓ status: malformed/unavailable snapshots are not authoritative");
}

console.log("All status tests passed.");