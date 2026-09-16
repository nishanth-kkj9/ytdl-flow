import assert from "node:assert";
import http from "node:http";
import express from "express";
import { probeRouter } from "../routes/probe.mjs";
import { cancelRouter, downloadRouter } from "../routes/download.mjs";

// Minimal mock engine manager that records sent commands.
function makeEngine() {
  const sent = [];
  return {
    sent,
    sendCommand(cmd) {
      sent.push(cmd);
    },
  };
}

// Helper: build an app with the given router and issue a request.
function makeApp(router) {
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}

function request(app, method, path, body) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      const opts = {
        host: "127.0.0.1",
        port,
        path,
        method,
        headers: { "Content-Type": "application/json" },
      };
      const req = http.request(opts, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          server.close();
          let json = null;
          try {
            json = data ? JSON.parse(data) : null;
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode, body: json });
        });
      });
      req.on("error", (err) => {
        server.close();
        reject(err);
      });
      if (body !== undefined) req.write(JSON.stringify(body));
      req.end();
    });
  });
}

// ── Probe route ──────────────────────────────────────────────────────────────

// Test 1: missing url -> 400
{
  const engine = makeEngine();
  const app = makeApp(probeRouter(engine));
  const res = await request(app, "POST", "/", {});
  assert.strictEqual(res.status, 400, "Missing url should be 400");
  assert.strictEqual(engine.sent.length, 0, "No command should be sent");
  console.log("✓ probe: missing url -> 400");
}

// Test 2: invalid (non-YouTube) url -> 400
{
  const engine = makeEngine();
  const app = makeApp(probeRouter(engine));
  const res = await request(app, "POST", "/", { url: "not-a-url" });
  assert.strictEqual(res.status, 400, "Invalid url should be 400");
  assert.strictEqual(engine.sent.length, 0, "No command should be sent");
  console.log("✓ probe: invalid url -> 400");
}

// Test 3: valid YouTube url -> 200 + id, command sent
{
  const engine = makeEngine();
  const app = makeApp(probeRouter(engine));
  const res = await request(app, "POST", "/", { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" });
  assert.strictEqual(res.status, 200, "Valid url should be 200");
  assert.ok(res.body.id, "Should return an id");
  assert.strictEqual(engine.sent.length, 1, "One command should be sent");
  assert.strictEqual(engine.sent[0].cmd, "probe");
  console.log("✓ probe: valid url -> 200 + command");
}

// ── Download route ───────────────────────────────────────────────────────────

// Test 4: missing url -> 400
{
  const engine = makeEngine();
  const app = makeApp(downloadRouter(engine));
  const res = await request(app, "POST", "/", {});
  assert.strictEqual(res.status, 400, "Missing url should be 400");
  console.log("✓ download: missing url -> 400");
}

// Test 5: invalid mode -> 400
{
  const engine = makeEngine();
  const app = makeApp(downloadRouter(engine));
  const res = await request(app, "POST", "/", {
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    mode: "bogus",
  });
  assert.strictEqual(res.status, 400, "Invalid mode should be 400");
  console.log("✓ download: invalid mode -> 400");
}

// Test 6: invalid format for mode -> 400
{
  const engine = makeEngine();
  const app = makeApp(downloadRouter(engine));
  const res = await request(app, "POST", "/", {
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    mode: "audio",
    format: "mp4", // mp4 is not a valid audio format
  });
  assert.strictEqual(res.status, 400, "Invalid audio format should be 400");
  console.log("✓ download: invalid audio format -> 400");
}

// Test 7: invalid quality -> 400
{
  const engine = makeEngine();
  const app = makeApp(downloadRouter(engine));
  const res = await request(app, "POST", "/", {
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    mode: "audio",
    format: "mp3",
    quality: "ultra",
  });
  assert.strictEqual(res.status, 400, "Invalid quality should be 400");
  console.log("✓ download: invalid quality -> 400");
}

// Test 8: valid download -> 200 + command with output_dir
{
  const engine = makeEngine();
  const app = makeApp(downloadRouter(engine));
  const res = await request(app, "POST", "/", {
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    mode: "audio",
    format: "mp3",
    quality: "high",
  });
  assert.strictEqual(res.status, 200, "Valid download should be 200");
  assert.ok(res.body.id, "Should return an id");
  assert.strictEqual(engine.sent.length, 1, "One command should be sent");
  assert.strictEqual(engine.sent[0].cmd, "download");
  assert.ok(engine.sent[0].output_dir, "Should include output_dir");
  console.log("✓ download: valid -> 200 + command");
}

// Test 8b (PR-06): non-finite duration must be dropped, not forwarded as
// NaN → null over the NDJSON wire.
{
  const engine = makeEngine();
  const app = makeApp(downloadRouter(engine));
  const res = await request(app, "POST", "/", {
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    mode: "audio",
    format: "mp3",
    quality: "high",
    duration: "not-a-number",
  });
  assert.strictEqual(res.status, 200, "Download with bad duration should still be accepted");
  assert.strictEqual(engine.sent.length, 1, "One command should be sent");
  assert.strictEqual(
    engine.sent[0].duration,
    undefined,
    "Non-finite duration must be omitted from the engine command"
  );
  console.log("✓ download: non-finite duration dropped");
}

// Test 8c (PR-06): a finite duration still reaches the engine command.
{
  const engine = makeEngine();
  const app = makeApp(downloadRouter(engine));
  const res = await request(app, "POST", "/", {
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    mode: "audio",
    format: "mp3",
    quality: "high",
    duration: 213,
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(engine.sent[0].duration, 213, "Finite duration must be forwarded");
  console.log("✓ download: finite duration forwarded");
}

// Test 8d (N-08): a half-open trim window must be rejected. The engine only
// applies a trim when BOTH bounds are present
// (engine.py: `if self.trim_start is not None and self.trim_end is not None`),
// so accepting a lone bound returned a full-length file with no error at any
// layer — the request claimed a trim that never happened.
{
  const engine = makeEngine();
  const app = makeApp(downloadRouter(engine));
  const res = await request(app, "POST", "/", {
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    mode: "audio",
    format: "mp3",
    quality: "high",
    trim_start: 10,
  });
  assert.strictEqual(res.status, 400, "trim_start without trim_end should be 400");
  assert.strictEqual(engine.sent.length, 0, "No command should be sent for a partial trim window");
  console.log("✓ download: trim_start without trim_end -> 400");
}

// Test 8e (N-08): a complete trim window is still accepted and forwarded.
{
  const engine = makeEngine();
  const app = makeApp(downloadRouter(engine));
  const res = await request(app, "POST", "/", {
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    mode: "audio",
    format: "mp3",
    quality: "high",
    trim_start: 10,
    trim_end: 20,
  });
  assert.strictEqual(res.status, 200, "Complete trim window should be accepted");
  assert.strictEqual(engine.sent.length, 1, "One command should be sent");
  assert.strictEqual(engine.sent[0].trim_start, 10, "trim_start must be forwarded");
  assert.strictEqual(engine.sent[0].trim_end, 20, "trim_end must be forwarded");
  console.log("✓ download: complete trim window forwarded");
}

// Test 9: cancel with missing id -> 400
{
  const engine = makeEngine();
  const app = makeApp(cancelRouter(engine));
  const res = await request(app, "POST", "/", {});
  assert.strictEqual(res.status, 400, "Missing id should be 400");
  console.log("✓ cancel: missing id -> 400");
}

// Test 10: cancel with id -> 200 + command
{
  const engine = makeEngine();
  const app = makeApp(cancelRouter(engine));
  const res = await request(app, "POST", "/", { id: "abc" });
  assert.strictEqual(res.status, 200, "Valid cancel should be 200");
  assert.strictEqual(engine.sent.length, 1, "One command should be sent");
  assert.strictEqual(engine.sent[0].cmd, "cancel");
  console.log("✓ cancel: valid -> 200 + command");
}

console.log("All routes tests passed.");
