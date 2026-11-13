import { spawn } from "node:child_process";
import readline from "node:readline";
import path from "node:path";
import { config } from "../config.mjs";

// P2-2: cap the length of a single engine line before it is parsed or
// broadcast. A corrupted engine dumping one huge line used to be fully
// buffered by readline and then fan-out to every connected browser.
const MAX_ENGINE_LINE = 1_000_000; // 1 MB
function clampEngineLine(line) {
  return line.length > MAX_ENGINE_LINE
    ? `${line.slice(0, MAX_ENGINE_LINE)}… [truncated ${line.length - MAX_ENGINE_LINE} chars]`
    : line;
}

/**
 * engineManager.mjs — manages the Python engine child process.
 *
 * Responsibilities:
 *   - Spawn the Python sidecar (python-engine/ipc_main.py)
 *   - Bridge NDJSON stdin/stdout to an EventBus
 *   - Route command messages to the engine
 *   - Auto-restart on crash (bounded)
 *
 * The engine is decoupled from the WebSocket layer via the EventBus, so any
 * new consumer (logs, metrics, multiple sessions) can subscribe without
 * modifying this module.
 */
export class EngineManager {
  constructor(eventBus, { runtimeConfig = config, processSpawn = spawn } = {}) {
    this.bus = eventBus;
    this.config = runtimeConfig;
    this.processSpawn = processSpawn;
    this.child = null;
    this.stdin = null;
    this.restartAttempts = 0;
    this.ready = false;
    this.fatalError = false;
    this.pendingCommands = [];
    // Cap the pending queue so a burst of commands (or a long engine outage)
    // cannot grow memory unboundedly (mirrors the history 100-record cap).
    this.maxPendingCommands = this.config.engineMaxPendingCommands;
    // In-flight `jobs` queries awaiting a jobs_result reply, keyed by
    // request_id. Each entry carries its timeout so a dead engine can't
    // leave callers hanging.
    this.pendingJobRequests = new Map();
    this._jobRequestSeq = 0;
    // Last engine_ready payload — surfaces ffmpeg/ffprobe/deno availability.
    this.readyTools = null;
    // Cookie-auth state from the last engine_ready (source only, never
    // contents) — null until the first ready message.
    this.readyCookies = null;
    // Set to true while we are deliberately stopping/replacing the child so
    // _onChildExit doesn't misread a clean SIGTERM (code === null) as a crash
    // and schedule a ghost respawn during shutdown or recover().
    this.stopping = false;
    // Handle for the delayed respawn in maybeRestart() — stored so spawn(),
    // stop() and recover() can cancel a pending restart instead of racing it.
    this.restartTimer = null;
    // Download ids sent to the engine that have not yet reached a terminal
    // event (result/cancelled/error). When the engine crashes, each of these
    // gets a terminal `error` event so browsers never keep items stuck in
    // "downloading" forever (the new engine's jobs snapshot is empty).
    this.activeDownloadIds = new Set();
    // Children killed deliberately by recover() whose exit events must be
    // ignored (they are expected — not crashes).
    this.retiredChildren = new Set();
  }

  start() {
    this.spawn();
  }

  // Reset a fatal-error state and respawn the engine. Used to recover from
  // a terminal crash without restarting the whole server.
  recover() {
    // P0-4: kill any LIVE child first. spawn() overwrites this.child
    // unconditionally — recovering with a live child used to orphan the old
    // process, leaving duplicate engines all broadcasting onto the bus.
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.child) {
      const oldChild = this.child;
      // Retire the old child so its (asynchronous) exit event can't be
      // misread as a fresh crash by _onChildExit — stopping is false again
      // by the time the exit event fires, so a flag alone would race.
      this.retiredChildren.add(oldChild);
      try {
        oldChild.kill();
      } catch {
        // already gone
      }
      if (this.child === oldChild) {
        this.child = null;
        this.stdin = null;
      }
    }
    this.fatalError = false;
    this.restartAttempts = 0;
    this.ready = false;
    // F-06: parity with maybeRestart()'s fatal path — every discarded pending
    // command gets a terminal error so its browser row resolves instead of
    // hanging on an id the new engine will never see again.
    const pending = this.pendingCommands;
    this.pendingCommands = [];
    const pendingDownloadIds = new Set(
      pending.filter((cmd) => cmd.cmd === "download" && cmd.id).map((cmd) => String(cmd.id)),
    );
    for (const cmd of pending) {
      this.bus.emit("error", {
        type: "error",
        id: cmd.id || "",
        error_type: "EngineRestarted",
        error: "Engine was restarted before this command ran — please retry.",
      });
    }
    const activeDownloadIds = [...this.activeDownloadIds];
    this.activeDownloadIds.clear();
    for (const id of activeDownloadIds) {
      if (pendingDownloadIds.has(id)) continue;
      this.bus.emit("error", {
        type: "error",
        id,
        error_type: "EngineRestarted",
        error: "Engine was restarted during this download — please retry.",
      });
    }
    this._failPendingJobRequests();
    this.spawn();
    return true;
  }

  spawn() {
    if (this.stopping) return;
    // Cancel any pending delayed respawn — a fresh spawn supersedes it.
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.fatalError = false;
    const pythonExe = this.config.engineExecutable || process.env.PYTHON || "python";
    const args = this.config.engineArgs ?? [this.config.engineEntry];
    const child = this.processSpawn(pythonExe, args, {
      cwd: this.config.engineCwd,
      stdio: ["pipe", "pipe", "pipe"],
      // PR-05: never let the sidecar pop a console window on Windows when the
      // server itself is launched from a GUI context (detached/launcher).
      windowsHide: true,
    });
    this.child = child;
    this.stdin = child.stdin;

    const stdout = readline.createInterface({ input: child.stdout });
    stdout.on("line", (rawLine) => {
      const line = clampEngineLine(rawLine);
      const trimmed = line.trim();
      if (!trimmed) return;
      let msg;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        this.bus.emit("engine_log", { type: "engine_log", message: trimmed });
        return;
      }
      this.handleEngineMessage(msg);
    });

    const stderr = readline.createInterface({ input: child.stderr });
    stderr.on("line", (rawLine) => {
      const trimmed = clampEngineLine(rawLine).trim();
      if (trimmed) {
        this.bus.emit("engine_log", { type: "engine_log", message: trimmed });
      }
    });

    child.on("error", (err) => {
      this.ready = false;
      this.child = null;
      this.stdin = null;
      this.readyTools = null; // PR-03: no stale tools for a spawn failure
      this.readyCookies = null;
      this.bus.emit("engine_error", { error: `Engine spawn failed: ${err.message}` });
      // Treat a spawn failure like a crash so the bounded-restart logic can
      // recover (e.g. when Python is temporarily unavailable) instead of
      // leaving the engine stuck in a permanent "starting" state.
      if (!this.stopping) this.maybeRestart();
    });

    child.on("exit", (code, signal) => {
      this._onChildExit(child, code, signal);
    });
  }

  // Single funnel for "the child process went away" (non-zero/clean exit).
  // PR-03: also clears the cached readyTools so /api/status.tools never
  // reports stale tool flags for an engine that is down or restarting.
  _onChildExit(child, code, signal) {
    // A child killed deliberately by recover() — its exit is expected, not a
    // crash. Swallow it (and drop the retirement marker) silently.
    if (this.retiredChildren.has(child)) {
      this.retiredChildren.delete(child);
      return;
    }
    this.ready = false;
    this.child = null;
    this.stdin = null;
    this.readyTools = null;
    this.readyCookies = null;
    // A deliberate stop (shutdown, recover) kills the child with SIGTERM:
    // code is null and null !== 0 — that must not broadcast engine_crashed
    // or schedule a respawn.
    if (this.stopping) {
      return;
    }
    if (code !== 0) {
      // Terminal events for downloads the engine never finished — without
      // these, browsers that reconnect after the crash see an empty jobs
      // snapshot and their queue items stay "downloading" forever.
      if (this.activeDownloadIds.size > 0) {
        for (const id of this.activeDownloadIds) {
          this.bus.emit("error", {
            type: "error",
            id,
            error_type: "EngineCrashed",
            error: "Engine crashed during download — please retry.",
          });
        }
        this.activeDownloadIds.clear();
      }
      this.bus.emit("engine_crashed", { exit_code: code, signal });
      this.maybeRestart();
    }
  }

  handleEngineMessage(msg) {
    switch (msg.type) {
      case "engine_ready":
        this.ready = true;
        this.restartAttempts = 0;
        // IPC protocol versioning: warn loudly on a mismatch so a stale
        // Python engine behind a newer server is diagnosable instead of
        // producing subtle wire-shape failures. Legacy engines that omit
        // the field pass through untouched (additive compatibility).
        const ENGINE_PROTOCOL_VERSION = 1;
        if (
          typeof msg.protocol_version === "number" &&
          msg.protocol_version !== ENGINE_PROTOCOL_VERSION
        ) {
          const vmsg =
            `Engine protocol version ${msg.protocol_version} does not match ` +
            `server version ${ENGINE_PROTOCOL_VERSION} — update python-engine/ ` +
            `or the web server; some commands or events may misbehave.`;
          console.warn(`[engineManager] ${vmsg}`);
          this.bus.emit("engine_log", { type: "engine_log", message: vmsg, level: "warn" });
        }
        this.readyTools = {
          ffmpeg: Boolean(msg.ffmpeg),
          ffprobe: Boolean(msg.ffprobe),
          deno: Boolean(msg.deno),
          yt_dlp: Boolean(msg.yt_dlp),
          mutagen: Boolean(msg.mutagen),
        };
        // Cookie-auth observability: additive field, validated shape-only
        // (never contents). Legacy engines omit it → stays null, never crash.
        if (msg.cookies && typeof msg.cookies === "object") {
          this.readyCookies = {
            configured: Boolean(msg.cookies.configured),
            source: typeof msg.cookies.source === "string" ? msg.cookies.source : "none",
          };
        }
        this.bus.emit("engine_ready", msg);
        // Flush any commands that were queued while the engine was starting.
        this.flushPending();
        break;
      case "jobs_result": {
        // Resolve the matching requestJobs() promise (never forwarded to the
        // bus — this is a point-to-point reply, not a broadcast event).
        const pending = this.pendingJobRequests.get(msg.request_id);
        if (pending) {
          this.pendingJobRequests.delete(msg.request_id);
          clearTimeout(pending.timer);
          const jobs = Array.isArray(msg.jobs) ? msg.jobs : [];
          const available = Array.isArray(msg.jobs);
          if (pending.full) {
            pending.resolve({ jobs, bot_breaker: msg.bot_breaker ?? null, available });
          } else {
            pending.resolve(jobs);
          }
        }
        break;
      }
      default:
        // Track download lifecycle so a crash can emit terminal events for
        // in-flight jobs (see _onChildExit). result/cancelled/error carry the
        // download id; download_started confirms the engine accepted it.
        if (
          msg.type === "result" ||
          msg.type === "cancelled" ||
          msg.type === "error"
        ) {
          if (msg.id) this.activeDownloadIds.delete(String(msg.id));
        }
        // Forward all engine events onto the bus. The WebSocket broadcaster
        // listens for these and relays them to browsers.
        this.bus.emit(msg.type, msg);
        break;
    }
  }

  maybeRestart() {
    if (this.stopping) return;
    if (this.restartAttempts >= this.config.engineMaxRestarts) {
      this.fatalError = true;
      // Emit a terminal error for each pending command before discarding
      const pending = this.pendingCommands;
      this.pendingCommands = [];
      for (const cmd of pending) {
        const id = cmd.id || "";
        this.bus.emit("error", {
          type: "error",
          id,
          error_type: "EngineFatalError",
          error: "Engine crashed and could not be restarted.",
        });
      }
      // Any in-flight jobs queries can never be answered — release them.
      this._failPendingJobRequests();
      this.bus.emit("fatal_error", {
        error: "Engine crashed and could not be restarted.",
      });
      return;
    }
    this.restartAttempts += 1;
    console.warn(`Engine exited unexpectedly — restarting (${this.restartAttempts}/${this.config.engineMaxRestarts})`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.spawn();
    }, 500);
  }

  sendCommand(command) {
    if (this.fatalError) {
      throw new Error("Engine is in fatal error state");
    }
    // Cancel of a download that is still queued locally (engine down or
    // starting, command not yet written to the child). The engine has never
    // seen it, so a cancel command sent after it would (a) start the download
    // on flush, then (b) immediately cancel it — wasted work and a visible
    // flicker. Instead, drop the pending download entirely and emit the
    // terminal `cancelled` event so the UI reconciles immediately. Downloads
    // already written to the engine are cancelled by the engine's own path.
    if (command.cmd === "cancel") {
      const idx = this.pendingCommands.findIndex(
        (c) => c.cmd === "download" && c.id === command.id
      );
      if (idx >= 0) {
        this.pendingCommands.splice(idx, 1);
        this.bus.emit("cancelled", { type: "cancelled", id: command.id });
        return;
      }
    }
    // Track downloads handed to the engine (see activeDownloadIds docs).
    if (command.cmd === "download" && command.id) {
      this.activeDownloadIds.add(String(command.id));
    }
    // Bound the pending queue — reject new commands if the engine is down and
    // the backlog is already large, so a burst cannot grow memory unboundedly.
    if (!this.stdin || this.stdin.destroyed) {
      if (this.pendingCommands.length >= this.maxPendingCommands) {
        throw new Error("Engine backlog full, try again shortly");
      }
      // Queue the command — the engine may still be starting up.
      this.pendingCommands.push(command);
      return;
    }
    this._writeCommand(command);
  }

  // Backpressure-aware write: if the pipe's buffer is full (write returns
  // false), queue the command and resume on the 'drain' event instead of
  // accumulating an unbounded kernel buffer.
  _writeCommand(command) {
    if (!this.stdin || this.stdin.destroyed) {
      this.pendingCommands.push(command);
      return;
    }
    let ok;
    try {
      ok = this.stdin.write(JSON.stringify(command) + "\n");
    } catch {
      this.pendingCommands.push(command);
      return;
    }
    if (!ok) {
      // Resume writing queued commands once the outgoing buffer drains.
      this.stdin.once("drain", () => this.flushPending());
    }
  }

  flushPending() {
    if (!this.stdin || this.stdin.destroyed) return;
    const pending = this.pendingCommands;
    this.pendingCommands = [];
    for (let i = 0; i < pending.length; i++) {
      const before = this.pendingCommands.length;
      try {
        this._writeCommand(pending[i]);
      } catch {
        // Pipe died mid-flush: requeue the failed command AND the
        // unprocessed tail, in order, and stop until respawn.
        this.pendingCommands.push(...pending.slice(i));
        break;
      }
      // _writeCommand requeues internally when the pipe is gone; stop the
      // loop and preserve the tail instead of churning the dead pipe.
      if (this.pendingCommands.length > before) {
        this.pendingCommands.push(...pending.slice(i + 1));
        break;
      }
    }
  }

  // ── Active-jobs snapshot ────────────────────────────────────────────────────
  // Queries the Python engine for its active download jobs. Used by the status
  // route to let a reconnecting browser reconcile queue items that may have
  // missed terminal events while its WebSocket was down. Resolves to [] when
  // the engine is unavailable (never rejects — callers must not have to guard).
  // `available` distinguishes a confirmed snapshot from that safe empty default:
  // false on engine-down, timeout, malformed reply, or shutdown.
  // NOTE: jobs_result now also carries bot_breaker — requestJobsFull() keeps
  // the raw payload for /api/status observability; requestJobs() stays
  // array-shaped for existing callers (status route, reconcile paths).
  requestJobs(timeoutMs = 500) {
    return this.requestJobsFull(timeoutMs).then((r) => r.jobs);
  }

  requestJobsFull(timeoutMs = 500) {
    return new Promise((resolve) => {
      if (
        this.fatalError ||
        !this.child ||
        !this.stdin ||
        this.stdin.destroyed
      ) {
        resolve({ jobs: [], bot_breaker: null, available: false });
        return;
      }
      const requestId = `jobs-${++this._jobRequestSeq}`;
      const timer = setTimeout(() => {
        this.pendingJobRequests.delete(requestId);
        resolve({ jobs: [], bot_breaker: null, available: false });
      }, timeoutMs);
      this.pendingJobRequests.set(requestId, { resolve, timer, full: true });
      this._writeCommand({ cmd: "jobs", request_id: requestId });
    });
  }

  // Resolve all in-flight jobs queries with [] (engine down / restarting).
  _failPendingJobRequests() {
    for (const [requestId, pending] of this.pendingJobRequests) {
      clearTimeout(pending.timer);
      // Test 10 pins the legacy array shape for requestJobs(); the full-shape
      // caller (requestJobsFull) gets the object shape. Resolve per-caller.
      if (pending.full) {
        pending.resolve({ jobs: [], bot_breaker: null, available: false });
      } else {
        pending.resolve([]);
      }
      this.pendingJobRequests.delete(requestId);
    }
  }

  isReady() {
    return !!this.child && this.ready;
  }

  // Expose cached tool availability (ffmpeg/ffprobe/deno) from the last
  // engine_ready message, or null if the engine hasn't reported readiness.
  getTools() {
    return this.readyTools;
  }

  // Cookie-auth state from the last engine_ready (source only, never
  // contents). Lets /api/status warn "no YouTube auth configured" before the
  // first bot-check lands.
  getCookieState() {
    return this.readyCookies;
  }

  // Number of commands queued while the engine is down or starting up.
  // Exposed via /api/status so the UI can show engine backlog pressure.
  getPendingCount() {
    return this.pendingCommands.length;
  }

  async stop() {
    // Deliberate shutdown: suppress the crash path in _onChildExit (a killed
    // child reports code === null) and cancel any pending respawn.
    this.stopping = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const child = this.child;
    this.child = null;
    this.stdin = null;
    this.pendingCommands = [];
    this.activeDownloadIds.clear();
    this._failPendingJobRequests();
    if (child) {
      if (typeof child.once !== "function") {
        child.kill();
        return;
      }
      const waitForExit = (timeoutMs) =>
        new Promise((resolve) => {
          if (child.exitCode != null || child.signalCode != null) {
            resolve(true);
            return;
          }
          const onExit = () => {
            clearTimeout(timer);
            resolve(true);
          };
          const timer = setTimeout(() => {
            child.removeListener("exit", onExit);
            resolve(false);
          }, timeoutMs);
          child.once("exit", onExit);
        });

      if (child.stdin && !child.stdin.destroyed) {
        child.stdin.end();
      }
      if (!(await waitForExit(500))) {
        child.kill();
        if (!(await waitForExit(1_000))) {
          child.kill("SIGKILL");
          if (!(await waitForExit(1_000))) {
            throw new Error("Python engine did not exit after forced termination");
          }
        }
      }
    }
  }
}
