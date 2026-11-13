/**
 * transport.ts — web transport layer for the local-hosted website.
 *
 * Sends commands to the Node.js backend via REST (`fetch`) and receives live
 * engine events via a native `WebSocket` connection.
 *
 * To add a new backend command, add an endpoint in web/routes/* and a case in
 * the `invoke` switch below. No component changes needed.
 */

/** Unsubscribe function returned by listen(). */
export type UnlistenFn = () => void;

// ── WebSocket event bus state ────────────────────────────────────────────────
let ws: WebSocket | null = null;
let reconnectAttempts = 0;
// P2-28: the pending reconnect timer is tracked so resetTransport() can
// cancel it — otherwise a timer scheduled just before test teardown (or
// Vite HMR) fires later and opens a real socket against a torn-down env.
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
// Tracks whether the socket has ever opened, so `onopen` can distinguish the
// first connect from a reconnect (reconnects trigger state reconciliation).
let everConnected = false;
const eventHandlers = new Map<string, Set<(payload: any) => void>>();
const reconnectHandlers = new Set<() => void>();

// ── Connection state (WS status indicator) ───────────────────────────────────
export type ConnectionState = "connecting" | "connected" | "disconnected";
let connectionState: ConnectionState = "connecting";
const connectionHandlers = new Set<(state: ConnectionState) => void>();

function setConnectionState(state: ConnectionState) {
  if (connectionState === state) return;
  connectionState = state;
  for (const fn of [...connectionHandlers]) {
    try {
      fn(state);
    } catch (err) {
      console.error("[transport] connection handler error:", err);
    }
  }
}

/** Current WebSocket connection state (for UI status indicators). */
export function getConnectionState(): ConnectionState {
  return connectionState;
}

/** Subscribe to connection-state changes. Returns an unsubscribe function. */
export function onConnectionChange(handler: (state: ConnectionState) => void): UnlistenFn {
  connectionHandlers.add(handler);
  return () => {
    connectionHandlers.delete(handler);
  };
}

function ensureWebSocket() {
  if (ws) return;
  setConnectionState("connecting");
  const proto = location.protocol === "https:" ? "wss" : "ws";
  try {
    ws = new WebSocket(`${proto}://${location.host}/ws`);
  } catch (err) {
    // P2-28: a constructor throw (invalid URL, blocked origin) previously
    // left connectionState stuck on "connecting" forever — no onopen /
    // onclose ever fires when the object was never created.
    console.error("[transport] WebSocket construction failed:", err);
    ws = null;
    setConnectionState("disconnected");
    return;
  }
  ws.onopen = () => {
    reconnectAttempts = 0;
    setConnectionState("connected");
    if (everConnected) {
      // Reconnect (not first connect): a WS drop may have swallowed terminal
      // download events (result/error/cancelled). Subscribers use this hook
      // to reconcile queue state against the server.
      for (const fn of [...reconnectHandlers]) {
        try {
          fn();
        } catch (err) {
          console.error("[transport] reconnect handler error:", err);
        }
      }
    }
    everConnected = true;
  };
  ws.onmessage = (msg) => {
    let data: any;
    try {
      data = JSON.parse(msg.data);
    } catch {
      return;
    }
    const type = data?.type;
    if (!type) return;
    // "engine-event" is a wildcard — every engine event routes through it,
    // mirroring the Tauri `emit("engine-event", ...)` contract.
    for (const key of new Set([type, "engine-event"])) {
      const handlers = eventHandlers.get(key);
      if (!handlers) continue;
      for (const fn of handlers) {
        try {
          fn(data);
        } catch (err) {
          console.error(`[transport] handler error for ${key}:`, err);
        }
      }
    }
  };
  ws.onclose = () => {
    ws = null;
    setConnectionState("disconnected");
    // Reconnect with exponential backoff (1.5s → capped at 30s) so a dead
    // server doesn't trigger an infinite rapid-fire reconnect loop.
    const delay = Math.min(1500 * Math.pow(2, reconnectAttempts), 30000);
    reconnectAttempts++;
    reconnectTimer = setTimeout(ensureWebSocket, delay);
  };
}

/**
 * P2-28: tear down the reconnect loop — cancels any pending reconnect
 * timer, closes the live socket, and resets attempt state. Intended for
 * test teardown and Vite HMR, where a stray 1.5 s timer used to open a
 * real socket against a torn-down environment. Event handlers stay
 * registered: the next ensureWebSocket() (via listen/onReconnect) reuses
 * them on the fresh socket.
 */
export function resetTransport(): void {
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  reconnectAttempts = 0;
  if (ws) {
    const sock = ws;
    ws = null;
    sock.onopen = null;
    sock.onmessage = null;
    sock.onerror = null;
    sock.onclose = null;
    try {
      sock.close();
    } catch {
      /* already closed */
    }
  }
  everConnected = false;
  setConnectionState("disconnected");
}

async function webFetch(url: string, method: string, body?: unknown, timeoutMs = 15000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text();
      let message = text;
      try {
        const parsed = JSON.parse(text) as { error?: unknown };
        if (typeof parsed.error === "string" && parsed.error.trim()) {
          message = parsed.error;
        }
      } catch {
        // Non-JSON error bodies are already suitable fallback messages.
      }
      throw new Error(message || `Request failed: ${res.status}`);
    }
    const data = await res.json().catch((e) => {
      console.error("Fetch parse error:", e);
      return {};
    });
    if (data && data.error) throw new Error(data.error);
    return data;
  } catch (e: any) {
    if (e?.name === "AbortError")
      throw new Error(`Request timed out: ${method} ${url}`, { cause: e });
    throw e;
  } finally {
    clearTimeout(t);
  }
}

// ── Unified invoke (maps Tauri-style commands to REST endpoints) ────────────
export async function invoke<T = any>(command: string, args?: Record<string, any>): Promise<T> {
  const base = "";
  switch (command) {
    case "probe_url":
      // The client id is registered locally before this call, so the WS
      // probe_result can be correlated even if it arrives before the ack.
      return webFetch(`${base}/api/probe`, "POST", { url: args?.url, id: args?.id });
    case "start_download":
      return webFetch(`${base}/api/download`, "POST", {
        url: args?.url,
        format: args?.format,
        quality: args?.quality,
        mode: args?.mode,
        id: args?.id,
        title: args?.title,
        uploader: args?.uploader,
        description: args?.description,
        thumbnail: args?.thumbnail,
        duration: args?.duration,
        webpage_url: args?.webpage_url,
      });
    case "cancel_download":
      return webFetch(`${base}/api/download/cancel`, "POST", { id: args?.id });
    case "restart_engine":
      // P2-28: engine teardown + respawn can outlast the blanket 15 s.
      return webFetch(`${base}/api/engine/restart`, "POST", {}, 45000);
    case "get_download_dir":
      return webFetch(`${base}/api/status`, "GET").then((s) => s.downloadDir);
    case "get_active_jobs":
      // Snapshot of active download jobs [{ id, status }] — used on WS
      // reconnect to reconcile queue items that missed terminal events.
      return webFetch(`${base}/api/status`, "GET").then((s) => s.activeJobs ?? []);
    case "get_status":
      // Full status snapshot — the UI polls this for stability fields
      // (cookies: cookie-auth state, bot_breaker: circuit-breaker cooldown).
      return webFetch(`${base}/api/status`, "GET");
    case "save_history":
      return webFetch(`${base}/api/history`, "POST", args?.record);
    case "load_history":
      return webFetch(`${base}/api/history`, "GET");
    case "clear_history":
      return webFetch(`${base}/api/history`, "DELETE");
    default:
      throw new Error(`Unknown command in web mode: ${command}`);
  }
}

// ── Unified listen (WebSocket events) ───────────────────────────────────────
export async function listen(event: string, handler: (payload: any) => void): Promise<UnlistenFn> {
  ensureWebSocket();
  if (!eventHandlers.has(event)) {
    eventHandlers.set(event, new Set());
  }
  eventHandlers.get(event)!.add(handler);
  return () => {
    eventHandlers.get(event)?.delete(handler);
  };
}

// Fires after a WebSocket RE-connect (not the initial connect), so consumers
// can reconcile state that may have drifted while the connection was down.
export function onReconnect(handler: () => void): UnlistenFn {
  ensureWebSocket();
  reconnectHandlers.add(handler);
  return () => {
    reconnectHandlers.delete(handler);
  };
}

// ── File helpers (browser equivalents) ──────────────────────────────────────
export async function openPath(path: string): Promise<void> {
  // Open the download URL in a new tab.
  const downloadUrl = `/downloads/${encodeURIComponent(path.split(/[\\/]/).pop() || "")}`;
  window.open(downloadUrl, "_blank");
  return undefined as any;
}
