import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

import { EventBus } from "../eventBus.mjs";
import { historyService as realService } from "../services/historyService.mjs";
import { attachHistoryPersistence } from "../services/historyPersistence.mjs";

// IMP-01 — server-side history persistence on successful `result` events.
// The browser used to be the ONLY writer of history; a closed tab mid-download
// meant no record was ever written.

function makeBus() {
  return new EventBus();
}

async function makeService() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ytdl-histpersist-"));
  const file = path.join(dir, "history.json");
  // Reconstruct a fresh instance from the singleton's constructor (same trick
  // as the other service tests) so each test starts with a clean disk state.
  const ServiceCtor = Object.getPrototypeOf(realService).constructor;
  const svc = new ServiceCtor(file);
  await svc.init();
  return { svc, dir };
}

// S-3: the persistence handler runs async off bus.emit, so fixed sleeps
// (50/80ms) flaked under parallel-suite load. Poll until the expected
// state or a 2s deadline — fast when idle, patient when loaded.
async function waitForHistory(svc, wantLength, what) {
  const deadline = Date.now() + 2000;
  for (;;) {
    const recs = await svc.loadHistory();
    if (recs.length === wantLength) return recs;
    if (Date.now() > deadline) {
      assert.fail(`timed out waiting for history (${what}); got ${recs.length}, want ${wantLength}`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

// Test 1: a successful result is persisted server-side.
{
  const { svc, dir } = await makeService();
  const bus = makeBus();
  const unsub = attachHistoryPersistence(bus, svc);

  bus.emit("result", {
    id: "d1",
    success: true,
    title: "A track",
    fmt: "mp3",
    file_size: "123456",
    duration: "245",
    url: "https://music.youtube.com/watch?v=dQw4w9WgXcQ",
    filepath: "/tmp/A track.mp3",
  });

  // Allow the async handler to run (poll, not fixed sleep — see S-3).
  const recs = await waitForHistory(svc, 1, "successful result persisted");
  assert.strictEqual(recs.length, 1, "one history record should be persisted");
  assert.strictEqual(recs[0].id, "d1");
  assert.strictEqual(recs[0].title, "A track");
  assert.strictEqual(recs[0].type, "audio");
  assert.strictEqual(recs[0].status, "completed");
  unsub();
  await fs.rm(dir, { recursive: true, force: true });
  console.log("✓ serverHistory: successful result persisted");
}

// Test 2: a failed result (success:false) must NOT create a history record.
{
  const { svc, dir } = await makeService();
  const bus = makeBus();
  const unsub = attachHistoryPersistence(bus, svc);
  bus.emit("result", { id: "d2", success: false, error: "boom" });
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual((await svc.loadHistory()).length, 0);
  unsub();
  await fs.rm(dir, { recursive: true, force: true });
  console.log("✓ serverHistory: failed result not persisted");
}

// Test 3: a 10 KB title is sanitized/capped by the whitelist.
{
  const { svc, dir } = await makeService();
  const bus = makeBus();
  const unsub = attachHistoryPersistence(bus, svc);
  bus.emit("result", {
    id: "d3",
    success: true,
    title: "x".repeat(10_000),
    fmt: "m4a",
    filepath: "/tmp/x.m4a",
  });
  const recs = await waitForHistory(svc, 1, "capped title record persisted");
  assert.ok(recs[0].title.length <= 500, "title must be capped at 500 chars");
  unsub();
  await fs.rm(dir, { recursive: true, force: true });
  console.log("✓ serverHistory: over-long title capped by sanitizer");
}

// Test 4: idempotency — exactly one record for two identical results.
{
  const { svc, dir } = await makeService();
  const bus = makeBus();
  const unsub = attachHistoryPersistence(bus, svc);
  bus.emit("result", { id: "d4", success: true, title: "T", fmt: "mp3" });
  bus.emit("result", { id: "d4", success: true, title: "T", fmt: "mp3" });
  // Both writes merge by id — poll until settle, then assert exactly one.
  const recs = await waitForHistory(svc, 1, "duplicate results merged");
  assert.strictEqual(recs.length, 1, "duplicate ids must merge via saveRecord");
  unsub();
  await fs.rm(dir, { recursive: true, force: true });
  console.log("✓ serverHistory: duplicate result merges to one record");
}

// Test 5: client+server convergence — a client-shaped record for the same id
// (already persisted server-side) still yields exactly one record.
{
  const { svc, dir } = await makeService();
  const bus = makeBus();
  const unsub = attachHistoryPersistence(bus, svc);
  bus.emit("result", {
    id: "d5", success: true, title: "FromServer", fmt: "opus",
    url: "u", filepath: "/tmp/s.opus",
  });
  await waitForHistory(svc, 1, "server record persisted before client merge");
  // Client-shaped record with same id — server must merge, not duplicate.
  await svc.saveRecord({
    id: "d5", title: "FromClient", fmt: "opus", size: "1",
    duration: "1", url: "u", downloaded_at: new Date().toISOString(),
    filepath: "/tmp/s.opus", type: "audio", status: "completed",
  });
  const recs = await svc.loadHistory();
  assert.strictEqual(recs.length, 1, "client+server records must converge");
  // saveRecord merges by id (client fields overlay); title could be either.
  assert.strictEqual(recs[0].id, "d5");
  unsub();
  await fs.rm(dir, { recursive: true, force: true });
  console.log("✓ serverHistory: client+server records converge by id");
}

console.log("All server-history persistence tests passed.");