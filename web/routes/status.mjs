import { Router } from "express";
import { config } from "../config.mjs";

/**
 * status.mjs — GET /api/status
 * Reports server + engine status for the UI header / health checks.
 */
export function statusRouter(engineManager) {
  const router = Router();

  router.get("/", async (_req, res) => {
    const tools = engineManager.getTools ? engineManager.getTools() : null;
    // Best-effort snapshot of active download jobs (id + status). Lets a
    // reconnecting browser resolve queue items whose terminal events were
    // missed while its WebSocket was down. Must never fail the endpoint when
    // the engine is down — requestJobs() resolves [] in that case; the catch
    // is defense-in-depth.
    //
    // activeJobsSnapshotAvailable tells consumers whether [] is authoritative.
    // It is true only when the engine was ready and the jobs query returned a
    // well-formed reply. Engine-down, timeout, shutdown, malformed replies, and
    // legacy managers that cannot signal success all report false so callers
    // never mistake "unknown" for "no active jobs".
    const engineReady = engineManager.isReady();
    let activeJobs = [];
    let activeJobsSnapshotAvailable = false;
    let botBreaker = null;
    if (engineReady && typeof engineManager.requestJobs === "function") {
      try {
        if (typeof engineManager.requestJobsFull === "function") {
          const full = await engineManager.requestJobsFull(500);
          if (full && Array.isArray(full.jobs)) {
            activeJobs = full.jobs;
            botBreaker = full.bot_breaker ?? null;
            activeJobsSnapshotAvailable = full.available === true;
          }
        } else {
          // Legacy array shape cannot distinguish a real empty reply from the
          // engine-down default, so leave availability false.
          const jobs = await engineManager.requestJobs(500);
          if (Array.isArray(jobs)) {
            activeJobs = jobs;
          }
        }
      } catch {
        activeJobs = [];
        activeJobsSnapshotAvailable = false;
        botBreaker = null;
      }
    }
    res.json({
      server: "ytdl-flow-web",
      version: config.version,
      // Seconds since the Node.js process started (monotonic-ish; resets on
      // server restart). Lets the UI/dashboards detect a silently restarted
      // server even when everything else looks identical.
      uptimeSeconds: Math.floor(process.uptime()),
      engineReady,
      downloadDir: config.downloadsDir,
      // Data dir holding history.json — lets test-smoke.mjs verify the
      // SERVER's isolation (not its own env) before a destructive DELETE.
      // Safe to expose: the Host/Origin allowlists keep this localhost-only.
      dataDir: config.dataDir,
      // Tool availability surfaced from the last engine_ready message
      // (null/absent until the engine first reports readiness).
      tools,
      // YouTube cookie-auth state (source only, never contents): lets the UI
      // warn "no auth configured" before the first bot-check lands. Null on
      // legacy engines that omit the field.
      cookies: typeof engineManager.getCookieState === "function"
        ? engineManager.getCookieState()
        : null,
      // Bot-check circuit-breaker snapshot from the jobs query (null when the
      // engine is down or predates the field). Lets the UI show the cooldown
      // countdown without polling a separate endpoint.
      bot_breaker: botBreaker,
      pendingCommands: engineManager.getPendingCount
        ? engineManager.getPendingCount()
        : 0,
      activeJobs,
      activeJobsSnapshotAvailable,
    });
  });

  return router;
}
