import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const configuredPath = (name, fallback) =>
  path.resolve(process.env[name] || fallback);

// ── .env loading ─────────────────────────────────────────────────────────────
// The server must run on Node >=18 (web/package.json engines), which has no
// --env-file flag (Node >=20.6 only), and this project deliberately avoids
// third-party runtime deps — so a tiny zero-dependency loader reads web/.env
// and the repo-root .env at startup. Semantics: process.env always wins over
// .env (never overrides a real env var), a missing file is a silent no-op,
// and comments/blank lines are skipped.
function loadDotEnv() {
  for (const file of [path.join(__dirname, ".env"), path.join(projectRoot, ".env")]) {
    let raw;
    try {
      raw = readFileSync(file, "utf8");
    } catch {
      continue; // not present — nothing to load
    }
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
      // Strip matching surrounding quotes ("…" or '…'), like shell/dotenv.
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = value;
    }
  }
}
loadDotEnv();
// Read the web package version at startup (throws only if package.json is missing).
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

// ── Env parsing (PR-02) ──────────────────────────────────────────────────────
// Numeric env vars must never become NaN: Number("abc") would silently poison
// config.port / config.engineMaxPendingCommands and fail later with obscure
// errors (server.listen(NaN)). Parse strictly and fall back to the documented
// default, warning loudly so a misconfigured environment is visible at startup.
function envInt(name, fallback, { min, max } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || (min !== undefined && n < min) || (max !== undefined && n > max)) {
    console.warn(
      `[config] Ignoring invalid ${name}=${JSON.stringify(raw)} — using ${fallback}` +
        (min !== undefined || max !== undefined ? ` (valid range: ${min ?? "-inf"}..${max ?? "+inf"})` : "")
    );
    return fallback;
  }
  return n;
}

/**
 * Central configuration for the YTDL Web server.
 * Easy to extend — add new keys here and consume them in modules.
 */
export const config = {
  // Server
  port: envInt("PORT", 3000, { min: 1, max: 65535 }),
  host: process.env.HOST || "127.0.0.1",
  // Human-readable version exposed by /api/status (single source: web/package.json).
  version: pkg?.version || "0.0.0",

  // Paths
  projectRoot,
  distDir: configuredPath("YTDL_DIST_DIR", path.join(projectRoot, "dist")),
  engineEntry: configuredPath(
    "YTDL_ENGINE_ENTRY",
    path.join(projectRoot, "python-engine", "ipc_main.py")
  ),
  engineExecutable: process.env.YTDL_ENGINE_EXECUTABLE || process.env.PYTHON || "python",
  engineArgs: process.env.YTDL_ENGINE_EXECUTABLE
    ? []
    : [configuredPath("YTDL_ENGINE_ENTRY", path.join(projectRoot, "python-engine", "ipc_main.py"))],
  downloadsDir: configuredPath(
    "YTDL_DOWNLOADS_DIR",
    path.join(projectRoot, "downloads")
  ),
  logsDir: configuredPath(
    "YTDL_LOG_DIR",
    path.join(projectRoot, "logs")
  ),
  // Overridable so smoke tests (which DELETE history) can run against an
  // isolated scratch directory instead of the user's real web/data/history.json.
  dataDir: configuredPath(
    "YTDL_DATA_DIR",
    path.join(__dirname, "data")
  ),
  historyFile: configuredPath(
    "YTDL_HISTORY_FILE",
    path.join(
      configuredPath("YTDL_DATA_DIR", path.join(__dirname, "data")),
      "history.json"
    )
  ),

  // Engine
  engineCwd: configuredPath(
    "YTDL_ENGINE_CWD",
    path.join(projectRoot, "python-engine")
  ),
  engineMaxRestarts: 3,
  // Upper bound on queued engine commands when the engine is unavailable.
  engineMaxPendingCommands: envInt("ENGINE_MAX_PENDING", 100, { min: 1 }),
};

// ── Loopback allowlists (single source of truth) ─────────────────────────────
// server.mjs (Host-header rebinding guard) and middleware/security.mjs (Origin
// check) must never drift apart, so both build their sets from these helpers.
// If `host` is overridden to expose the server beyond loopback, these sets must
// be extended deliberately — see the comment in server.mjs.
export function allowedHostsFor(port = config.port) {
  return new Set([
    `127.0.0.1:${port}`,
    `localhost:${port}`,
    "127.0.0.1",
    "localhost",
    `[::1]:${port}`,
    "[::1]",
    "::1",
  ]);
}

export function allowedOriginsFor(port = config.port) {
  return new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
}
