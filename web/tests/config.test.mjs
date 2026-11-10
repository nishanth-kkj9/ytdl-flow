import assert from "node:assert";
import path from "node:path";
import { test } from "node:test";

// config.mjs reads env at module load. Each case imports a fresh module
// instance via a unique query string (Node ESM treats ?query as a distinct
// module record for file URLs).

async function loadConfig(env) {
  const saved = {};
  for (const key of Object.keys(env)) {
    saved[key] = process.env[key];
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  try {
    const mod = await import(`../config.mjs?case=${encodeURIComponent(JSON.stringify(env))}-${Math.random()}`);
    return mod.config;
  } finally {
    for (const key of Object.keys(env)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

test("config defaults: port 3000, max pending 100", async () => {
  const config = await loadConfig({ PORT: undefined, ENGINE_MAX_PENDING: undefined });
  assert.strictEqual(config.port, 3000);
  assert.strictEqual(config.engineMaxPendingCommands, 100);
});

test("config accepts valid PORT and ENGINE_MAX_PENDING", async () => {
  const config = await loadConfig({ PORT: "8080", ENGINE_MAX_PENDING: "25" });
  assert.strictEqual(config.port, 8080);
  assert.strictEqual(config.engineMaxPendingCommands, 25);
});

test("config supports separate packaged-resource and user-data paths", async () => {
  const config = await loadConfig({
    YTDL_DIST_DIR: "C:\\app\\resources\\dist",
    YTDL_ENGINE_ENTRY: "C:\\app\\resources\\engine\\ipc_main.py",
    YTDL_ENGINE_EXECUTABLE: "C:\\app\\resources\\python\\python.exe",
    YTDL_ENGINE_CWD: "C:\\app\\resources\\engine",
    YTDL_DOWNLOADS_DIR: "C:\\Users\\test\\Videos\\YTDL Flow",
    YTDL_LOG_DIR: "C:\\Users\\test\\AppData\\Local\\YTDL Flow\\logs",
    YTDL_DATA_DIR: "C:\\Users\\test\\AppData\\Local\\YTDL Flow\\data",
    YTDL_HISTORY_FILE: "C:\\Users\\test\\AppData\\Local\\YTDL Flow\\data\\history.json",
  });
  assert.strictEqual(config.distDir, path.resolve("C:\\app\\resources\\dist"));
  assert.strictEqual(config.engineEntry, path.resolve("C:\\app\\resources\\engine\\ipc_main.py"));
  assert.strictEqual(config.engineExecutable, path.resolve("C:\\app\\resources\\python\\python.exe"));
  assert.deepStrictEqual(config.engineArgs, []);
  assert.strictEqual(config.engineCwd, path.resolve("C:\\app\\resources\\engine"));
  assert.strictEqual(config.downloadsDir, path.resolve("C:\\Users\\test\\Videos\\YTDL Flow"));
  assert.strictEqual(config.logsDir, path.resolve("C:\\Users\\test\\AppData\\Local\\YTDL Flow\\logs"));
  assert.strictEqual(config.dataDir, path.resolve("C:\\Users\\test\\AppData\\Local\\YTDL Flow\\data"));
  assert.strictEqual(config.historyFile, path.resolve("C:\\Users\\test\\AppData\\Local\\YTDL Flow\\data\\history.json"));
});

test("config preserves the existing Python script invocation by default", async () => {
  const config = await loadConfig({
    YTDL_ENGINE_ENTRY: undefined,
    YTDL_ENGINE_EXECUTABLE: undefined,
    PYTHON: undefined,
  });
  assert.strictEqual(config.engineExecutable, "python");
  assert.deepStrictEqual(config.engineArgs, [config.engineEntry]);
});

test("config falls back to defaults on garbage PORT (never NaN)", async () => {
  const config = await loadConfig({ PORT: "not-a-port", ENGINE_MAX_PENDING: undefined });
  assert.strictEqual(config.port, 3000, "PORT=garbage must fall back to 3000");
  assert.ok(Number.isInteger(config.port), "port must never be NaN");
});

test("config falls back to defaults on out-of-range PORT (never NaN)", async () => {
  const config = await loadConfig({ PORT: "99999", ENGINE_MAX_PENDING: "junk" });
  assert.strictEqual(config.port, 3000, "PORT out of 1..65535 must fall back");
  assert.strictEqual(config.engineMaxPendingCommands, 100, "garbage ENGINE_MAX_PENDING must fall back");
  assert.ok(Number.isInteger(config.engineMaxPendingCommands), "max pending must never be NaN");
});
