import { invoke } from "../api/transport";
import { create } from "zustand";
import { DownloadItem, HistoryItem, Metadata, MetadataResult, ProbeInfo, Toast, ToastType } from "../types";

// Generate a unique ID. crypto.randomUUID() only exists in secure contexts —
// served over LAN HTTP (e.g. http://192.168.x.x) it is undefined in Chromium
// and enqueueDownload would throw on every paste, so fall back gracefully.
function generateId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `dl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}-${Math.random().toString(36).slice(2, 10)}`;
}

export interface LogEntry {
  /** Monotonic id — used as a stable React key (was array index). */
  _seq: number;
  message: string;
  level: "info" | "warn" | "error";
  /** Epoch milliseconds when the entry was created — shown as a timestamp. */
  timestamp: number;
  /** Optional download/engine id extracted from the message for correlation. */
  refId?: string;
}

let activeProbeTimeout: ReturnType<typeof setTimeout> | undefined;
// The probe request that owns activeProbeTimeout. A result/error for any
// other id is stale and must not clear the current request's watchdog.
let activeProbeRequestId: string | null = null;

function clearProbeTimeout(requestId?: string): void {
  // With an id, only the owning request may clear the timer. Without one,
  // clear the active request (used when replacing a probe).
  if (requestId !== undefined && requestId !== activeProbeRequestId) return;
  if (activeProbeTimeout !== undefined) {
    clearTimeout(activeProbeTimeout);
    activeProbeTimeout = undefined;
  }
  activeProbeRequestId = null;
}

export type LogLevel = LogEntry["level"];

/** Extracts a download UUID from a log message if present (for correlation). */
function extractRefId(message: string): string | undefined {
  const match = message.match(
    /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i
  );
  return match?.[1];
}

export type EngineStatus = "starting" | "ready" | "error";

/**
 * Cookie-auth state from the last engine report — shape only
 * (configured/source), never cookie contents.
 */
export interface CookieState {
  configured: boolean;
  source: string;
}

/**
 * Bot-check circuit-breaker snapshot from /api/status. `observedAt` is
 * stamped client-side by setBotBreaker() so the header can tick the
 * countdown locally between polls.
 */
export interface BotBreakerState {
  open: boolean;
  consecutive_failures: number;
  cooldown_seconds: number;
  observedAt: number;
}

interface DownloadState {
  queue: DownloadItem[];
  history: HistoryItem[];
  probeInfo: ProbeInfo | null;
  probeError: string | null;
  /** True from probeUrl() until the WS probe_result/error arrives (F-11). */
  probeInFlight: boolean;
  /** Id of the probe request the UI is waiting for (N-09 correlation). */
  probeRequestId: string | null;
  engineStatus: EngineStatus;
  /**
   * Cookie-auth state from the engine (source only, never contents).
   * null = unknown (legacy engine or engine not yet ready).
   */
  cookieState: CookieState | null;
  /**
   * Bot-check circuit-breaker snapshot from /api/status.
   * null = unknown/closed. Powers the header cooldown indicator.
   */
  botBreaker: BotBreakerState | null;
  selectedMode: "audio" | "video";
  selectedFormat: string;
  selectedQuality: string;
  statusMessage: string;
  logs: LogEntry[];
  /** True while the WebSocket to the server is connected (header indicator). */
  wsConnected: boolean;
  metadataResult: MetadataResult | null;
  /** Active toast notifications. Newest first. */
  toasts: Toast[];
  /** Monotonic counter backing LogEntry._seq (stable React keys). */
  _logSeq: number;
  enqueueDownload: (url: string, format: string, quality: string, type: "audio" | "video", meta?: Metadata) => Promise<void>;
  startDownload: (id: string, meta?: Metadata) => Promise<void>;
  cancelDownload: (id: string) => Promise<void>;
  retryDownload: (id: string) => Promise<void>;
  restartEngine: () => Promise<void>;
  probeUrl: (url: string) => Promise<void>;
  setSelectedMode: (mode: "audio" | "video") => void;
  setSelectedFormat: (format: string) => void;
  setSelectedQuality: (quality: string) => void;
  setProbeInfo: (info: ProbeInfo | null) => void;
  setEngineStatus: (status: EngineStatus) => void;
  setCookieState: (cookieState: CookieState | null) => void;
  /** Accepts the raw /api/status shape; stamps observedAt for the countdown. */
  setBotBreaker: (
    botBreaker: Omit<BotBreakerState, "observedAt"> | null
  ) => void;
  setStatusMessage: (message: string) => void;
  setMetadataResult: (result: MetadataResult | null) => void;
  /** Clear the watchdog; pass the owning request id to reject stale events. */
  clearProbeTimeout: (requestId?: string) => void;
  addLog: (message: string, level?: "info" | "warn" | "error") => void;
  clearLogs: () => void;
  setWsConnected: (connected: boolean) => void;
  updateQueueItem: (id: string, patch: Partial<DownloadItem>) => void;
  addHistoryItem: (record: HistoryItem) => void;
  loadHistory: () => Promise<void>;
  clearHistory: () => Promise<void>;
  /** F-02: rebuild the queue from /api/status activeJobs after a refresh. */
  restoreActiveJobs: () => Promise<void>;
  /** Push a toast notification. Returns the toast id for programmatic dismissal. */
  addToast: (message: string, type?: ToastType, duration?: number) => string;
  /** Remove a toast by id. */
  removeToast: (id: string) => void;
  /** Clear all toasts. */
  clearToasts: () => void;
}

export const useDownloadStore = create<DownloadState>((set, get) => ({
  queue: [],
  history: [],
  probeInfo: null,
  probeError: null,
  probeInFlight: false,
  probeRequestId: null,
  engineStatus: "starting",
  cookieState: null,
  botBreaker: null,
  selectedMode: "audio",
  selectedFormat: "mp3",
  selectedQuality: "high",
  statusMessage: "",
  logs: [],
  wsConnected: false,
  metadataResult: null,
  toasts: [],
  // Monotonic counter backing LogEntry._seq (never reset, so keys stay unique
  // even after the log list is trimmed by the 50-entry cap).
  _logSeq: 0,

  enqueueDownload: async (url, format, quality, type, meta) => {
    set({ statusMessage: "Queuing download..." });
    try {
      const id = generateId();
      set((state) => ({
        queue: [
          ...state.queue,
          {
            id,
            url,
            title: meta?.title || url,
            format,
            quality,
            status: "queued",
            progress: 0,
            downloaded: 0,
            total: 0,
            speed: 0,
            type,
            thumbnail: meta?.thumbnail,
            metadata: meta,
          },
        ],
      }));
      get().addLog(`Download queued: ${url}`);
      await get().startDownload(id, meta);
    } catch (error) {
      set({ statusMessage: "Failed to queue download." });
      get().addLog(`enqueueDownload error: ${String(error)}`, "error");
    }
  },

  startDownload: async (id, meta) => {
    const item = get().queue.find((queueItem) => queueItem.id === id);
    if (!item) {
      get().addLog(`startDownload failed: item not found ${id}`, "error");
      return;
    }

    try {
      set({ statusMessage: "Starting download..." });
      await invoke("start_download", {
        url: item.url,
        format: item.format,
        quality: item.quality,
        mode: item.type,
        id: item.id,
        title: meta?.title || null,
        uploader: meta?.uploader || null,
        description: meta?.description || null,
        thumbnail: meta?.thumbnail || null,
        duration: meta?.duration ?? null,
        webpage_url: meta?.webpage_url || null,
      });
      // P1-13: after `await invoke(...)` resolves, the user may already have
      // hit Cancel (status flipped to "cancelled" while the request was in
      // flight) — unconditionally writing "downloading" would resurrect it.
      const cur = get().queue.find((queueItem) => queueItem.id === id);
      if (cur?.status === "cancelled") return;
      get().updateQueueItem(id, { status: "downloading", message: "Starting" });
      get().addLog(`Download started: ${item.url}`);
    } catch (error) {
      get().addLog(`start_download error: ${String(error)}`, "error");
      get().updateQueueItem(id, { status: "failed", message: "Failed to start" });
      set({ statusMessage: "Download failed to start." });
    }
  },

  cancelDownload: async (id) => {
    try {
      await invoke("cancel_download", { id });
      set((state) => ({
        queue: state.queue.map((item) =>
          item.id === id
            ? { ...item, status: "cancelled", message: "Cancel requested" }
            : item,
        ),
      }));
      get().addLog(`Cancel requested: ${id}`);
    } catch (error) {
      get().addLog(`cancel_download error: ${String(error)}`, "error");
      set({ statusMessage: "Failed to cancel download." });
      get().addToast("Cancel failed — try again in a moment", "error");
    }
  },

  retryDownload: async (id) => {
    const item = get().queue.find((queueItem) => queueItem.id === id);
    if (!item) return;
    // P2-20: reset ALL progress fields — leaving downloaded/total/speed from
    // the failed attempt made the ETA flash stale numbers mid-retry.
    get().updateQueueItem(id, {
      status: "queued",
      progress: 0,
      downloaded: 0,
      total: 0,
      speed: 0,
      message: "Retrying...",
    });
    // Use the metadata captured at enqueue time, not the global probeInfo,
    // which may now point at a different URL the user probed more recently.
    await get().startDownload(id, item.metadata);
  },

  restartEngine: async () => {
    set({ statusMessage: "Restarting engine...", engineStatus: "starting" });
    try {
      await invoke("restart_engine");
      get().addLog("Engine restart requested");
    } catch (error) {
      get().addLog(`restart_engine error: ${String(error)}`, "error");
      set({ statusMessage: "Engine restart failed." });
    }
  },

  probeUrl: async (url) => {
    clearProbeTimeout();
    // Register the id BEFORE the REST call: the engine can emit probe_result
    // before the HTTP ack returns, and the WS handler must already know it.
    const requestId = generateId();
    activeProbeRequestId = requestId;
    set({
      statusMessage: "Probing URL...",
      probeInfo: null,
      probeError: null,
      probeInFlight: true,
      probeRequestId: requestId,
    });
    let confirmedId = requestId;
    try {
      const ack = await invoke<{ id?: string }>("probe_url", { url, id: requestId });
      // Prefer the server's echo (it may have generated an id if the client
      // one was omitted by an older transport).
      if (typeof ack?.id === "string" && ack.id) confirmedId = ack.id;
      get().addLog(`Probe requested: ${url}`);
    } catch (error) {
      // An early WS result may have already finished this request, or a newer
      // probe may have replaced it. A stale REST failure must not overwrite
      // that state with a failure for a request nobody is waiting on.
      if (activeProbeRequestId !== requestId) {
        get().addLog(`Ignored stale probe_url error: ${String(error)}`, "warn");
        return;
      }
      clearProbeTimeout(requestId);
      set({
        statusMessage: "Probe failed.",
        probeError: String(error),
        probeInFlight: false,
        probeRequestId: null,
      });
      get().addLog(`probe_url error: ${String(error)}`, "error");
      return;
    }
    // A result may already have resolved (and cleared) this request while the
    // REST call was in flight — never arm a watchdog for a finished probe.
    if (activeProbeRequestId !== requestId) return;
    if (confirmedId !== requestId) {
      activeProbeRequestId = confirmedId;
      set({ probeRequestId: confirmedId });
    }
    // F-11/N-09: the REST ack returns immediately; the RESULT arrives over WS.
    // The watchdog is owned by this request id and fires 75 s after the ack,
    // leaving margin over the engine's 60 s budget. A lost event therefore
    // can't leave the spinner up forever, and a late result for this id can
    // never overwrite the visible timeout (it is rejected as stale).
    activeProbeTimeout = setTimeout(() => {
      if (activeProbeRequestId !== confirmedId) return;
      activeProbeTimeout = undefined;
      activeProbeRequestId = null;
      const state = useDownloadStore.getState();
      if (state.probeInFlight && state.probeRequestId === confirmedId) {
        useDownloadStore.setState({
          probeInFlight: false,
          probeRequestId: null,
          probeError: "Probe timed out (75s). Check the engine log and retry.",
          statusMessage: "Probe timed out.",
        });
      }
    }, 75_000);
  },

  setSelectedMode: (mode) => set({
    selectedMode: mode,
    selectedFormat: mode === "audio" ? "mp3" : "mp4",
    selectedQuality: mode === "audio" ? "high" : "best",
  }),
  setSelectedFormat: (format) => set({ selectedFormat: format }),
  setSelectedQuality: (quality) => set({ selectedQuality: quality }),
  setProbeInfo: (info) => set({ probeInfo: info, probeError: null }),
  setEngineStatus: (engineStatus) => set({ engineStatus }),
  setCookieState: (cookieState) => set({ cookieState }),
  setBotBreaker: (botBreaker) =>
    set({
      botBreaker: botBreaker ? { ...botBreaker, observedAt: Date.now() } : null,
    }),
  setStatusMessage: (statusMessage) => set({ statusMessage }),
  setMetadataResult: (result) => set({ metadataResult: result }),
  clearProbeTimeout: (requestId) => {
    clearProbeTimeout(requestId);
  },
  addLog: (message, level = "info") => set((state) => {
    // Drop exact duplicates of the most recent entry. React StrictMode mounts
    // effects twice in development, so every engine event used to be handled
    // (and logged) by two live subscriptions — doubling log lines.
    if (state.logs[0]?.message === message) return state;
    const seq = state._logSeq + 1;
    return {
      _logSeq: seq,
      logs: [
        { _seq: seq, message, level, timestamp: Date.now(), refId: extractRefId(message) },
        ...state.logs,
      ].slice(0, 50),
    };
  }),
  // Wipes the visible log. _logSeq stays monotonic so React keys never collide.
  clearLogs: () => set({ logs: [] }),
  setWsConnected: (wsConnected) => set({ wsConnected }),
  updateQueueItem: (id, patch) => set((state) => ({
    queue: state.queue.map((item) => (item.id === id ? { ...item, ...patch } : item)),
  })),
  addHistoryItem: (record) => {
    // P2-19: compute the result FIRST, then perform the invoke side effect
    // outside of `set` — a side effect inside the updater would double-POST
    // if the updater ever replays (StrictMode, future zustand semantics).
    let added = false;
    set((state) => {
      if (state.history.some((h) => h.id === record.id)) return state;
      added = true;
      return {
        history: [record, ...state.history].slice(0, 100),
        queue: state.queue.filter((item) => item.id !== record.id),
      };
    });
    if (added) {
      invoke("save_history", { record }).catch((err) => {
        get().addLog(`History save failed: ${String(err)}`, "warn");
      });
    }
  },
  loadHistory: async () => {
    try {
      const records = await invoke<HistoryItem[]>("load_history");
      // P2-21: apply the same 100-record cap addHistoryItem enforces, so a
      // server returning more (e.g. hand-edited history.json) can't grow the
      // in-memory store without bound.
      set({ history: Array.isArray(records) ? records.slice(0, 100) : [] });
    } catch (e) {
      // Surface history load failures instead of failing silently — the
      // drawer shows stale "No downloads yet" otherwise.
      console.error("Failed to load history:", e);
      get().addLog(`Failed to load history: ${String(e)}`, "warn");
      set({ statusMessage: "Failed to load history." });
    }
  },
  clearHistory: async () => {
    try {
      await invoke("clear_history");
      set({ history: [] });
    } catch (e) {
      console.error("Failed to clear history:", e);
      get().addLog(`Failed to clear history: ${String(e)}`, "warn");
      set({ statusMessage: "Failed to clear history." });
    }
  },

  // F-02: a page refresh empties the client queue while the engine keeps
  // working — /api/status's jobs snapshot is the only place the surviving
  // state exists. Restore one row per active job; progress resumes on the
  // next WS `progress` event (events target the id; updateQueueItem matches
  // by id). Restores are idempotent: existing ids are never duplicated.
  restoreActiveJobs: async () => {
    try {
      const jobs = await invoke<
        { id: string; status: string; url?: string; fmt?: string; quality?: string; mode?: string }[]
      >("get_active_jobs");
      const state = get();
      for (const j of jobs ?? []) {
        if (!j?.id) continue;
        if (state.queue.some((q) => q.id === j.id)) continue;
        const queued = j.status === "queued";
        set((s) => ({
          queue: [
            ...s.queue,
            {
              id: j.id,
              url: String(j.url ?? ""),
              // Titles aren't known until extraction completes server-side;
              // the URL is the same honest placeholder enqueueDownload uses
              // before probe metadata arrives.
              title: String(j.url ?? "Restored download"),
              format: String(j.fmt ?? "mp3"),
              quality: String(j.quality ?? "high"),
              status: queued ? ("queued" as const) : ("downloading" as const),
              progress: 0,
              downloaded: 0,
              total: 0,
              speed: 0,
              type: j.mode === "video" ? ("video" as const) : ("audio" as const),
              message: queued ? "Queued (restored)" : "Downloading (restored)",
            },
          ],
        }));
      }
    } catch {
      // Status endpoint unavailable at mount — the empty queue is honest;
      // the reconnect reconciler still handles later drift.
    }
  },

  // ── Toast notifications ─────────────────────────────────────────────────
  addToast: (message, type = "info", duration = 5000) => {
    const id = generateId();
    set((state) => ({
      toasts: [{ id, message, type, duration }, ...state.toasts].slice(0, 5),
    }));
    if (duration > 0) {
      setTimeout(() => {
        // Still the same toast? (not already dismissed by the user)
        if (useDownloadStore.getState().toasts.some((t) => t.id === id)) {
          useDownloadStore.getState().removeToast(id);
        }
      }, duration);
    }
    return id;
  },
  removeToast: (id) => {
    set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }));
  },
  clearToasts: () => {
    set({ toasts: [] });
  },
}));
