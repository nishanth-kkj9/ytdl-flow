import { Router } from "express";
import { randomUUID } from "node:crypto";
import { isYouTubeUrl } from "../validate.mjs";

/**
 * probe.mjs — POST /api/probe
 * Sends a probe command to the engine and returns the probe job id.
 * The actual probe_result is delivered over WebSocket.
 */
export function probeRouter(engineManager) {
  const router = Router();

  router.post("/", (req, res) => {
    const url = String(req.body?.url || "").trim();
    if (!url) {
      return res.status(400).json({ error: "url is required" });
    }
    if (!isYouTubeUrl(url)) {
      return res.status(400).json({ error: "Only YouTube URLs are supported" });
    }
    // The browser generates the probe id and registers it BEFORE the REST
    // call, so a fast probe_result can never arrive before the request is
    // known locally. Echo the same id back and forward it to the engine.
    // Only an ABSENT id gets a server-generated one (WinUI/legacy clients).
    // An explicit `null`, empty string, or any non-string value is malformed:
    // never coerce it, never invent an id for it.
    const rawId = req.body?.id;
    if (rawId !== undefined && typeof rawId !== "string") {
      return res.status(400).json({ error: "Invalid id: must be 1-128 chars of [A-Za-z0-9_-:]" });
    }
    const id = rawId === undefined ? randomUUID() : rawId;
    if (!/^[\w\-:]{1,128}$/.test(id)) {
      return res.status(400).json({ error: "Invalid id: must be 1-128 chars of [A-Za-z0-9_-:]" });
    }
    try {
      engineManager.sendCommand({ cmd: "probe", id, url });
      return res.json({ id });
    } catch (err) {
      return res.status(503).json({ error: err.message });
    }
  });

  return router;
}
