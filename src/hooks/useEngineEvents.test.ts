import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

// Captured "engine-event" handler — set once the hook's async subscription
// resolves. Wrapped in vi.hoisted so the vi.mock factory can reference it.
const captured = vi.hoisted(() => ({
  handler: null as null | ((message: { type: string; payload: Record<string, unknown> }) => void),
  reconnectHandler: null as null | (() => void),
  connectionHandler: null as null | ((state: string) => void),
  // Value returned by the mocked get_active_jobs invoke (reconnect tests).
  // Shape mirrors the engine jobs snapshot (url/fmt/quality/mode optional).
  activeJobs: [] as { id: string; status: string; url?: string; fmt?: string; quality?: string; mode?: string }[],
  // When true, the mocked get_active_jobs invoke throws (endpoint down).
  invokeError: false,
  // Value returned by the mocked get_status invoke (stability polling).
  status: {} as Record<string, unknown>,
}));

vi.mock("../api/transport", () => ({
  listen: vi.fn(async (_event: string, handler: (message: { type: string; payload: Record<string, unknown> }) => void) => {
    captured.handler = handler;
    return () => {};
  }),
  onReconnect: vi.fn((handler: () => void) => {
    captured.reconnectHandler = handler;
    return () => {};
  }),
  onConnectionChange: vi.fn((handler: (state: string) => void) => {
    captured.connectionHandler = handler;
    return () => {};
  }),
  invoke: vi.fn(async (command: string) => {
    if (command === "get_download_dir") return "D:/proj/downloads";
    if (command === "get_active_jobs") {
      if (captured.invokeError) throw new Error("status endpoint down");
      return captured.activeJobs;
    }
    if (command === "get_status") {
      if (captured.invokeError) throw new Error("status endpoint down");
      return captured.status;
    }
    return {};
  }),
}));

import { useDownloadStore } from "../stores/downloadStore";
import { useEngineEvents } from "./useEngineEvents";

// Simulate a WS message exactly as the server broadcasts it: the transport
// hands the full { type, payload } envelope to the wildcard handler.
function emit(type: string, payload: Record<string, unknown>) {
  captured.handler?.({ type, payload });
}

async function setup() {
  renderHook(() => useEngineEvents());
  await waitFor(() => expect(captured.handler).not.toBeNull());
}

describe("useEngineEvents — engine status flow", () => {
  beforeEach(() => {
    captured.handler = null;
    captured.status = {};
    captured.invokeError = false;
    useDownloadStore.setState({
      queue: [],
      history: [],
      probeInfo: null,
      probeError: null,
      probeInFlight: false,
      probeRequestId: null,
      engineStatus: "starting",
      cookieState: null,
      botBreaker: null,
      statusMessage: "",
      logs: [],
      metadataResult: null,
      _logSeq: 0,
    });
    useDownloadStore.getState().clearProbeTimeout();
  });

  it("marks the engine ready from the on-connect snapshot", async () => {
    // Server's synthetic on-connect message: payload now carries `type`
    // (the historical bug — without it the badge stayed on "starting").
    await setup();
    emit("engine_ready", { type: "engine_ready", ready: true });
    expect(useDownloadStore.getState().engineStatus).toBe("ready");
  });

  it("returns to ready after an engine restart (no once-only gate)", async () => {
    await setup();
    emit("engine_ready", { type: "engine_ready", ready: true });
    expect(useDownloadStore.getState().engineStatus).toBe("ready");

    // Simulate restartEngine(): status flips back to "starting"…
    useDownloadStore.getState().setEngineStatus("starting");
    // …and the follow-up engine_ready must be honored (previously ignored
    // by hasSeenReadyRef, leaving the badge stuck on "starting" forever).
    emit("engine_ready", { type: "engine_ready", ready: true });
    expect(useDownloadStore.getState().engineStatus).toBe("ready");
  });

  it("fails only in-flight downloads when the engine crashes", async () => {
    await setup();
    useDownloadStore.setState({
      queue: [
        {
          id: "interrupted", url: "https://youtu.be/x", title: "Interrupted",
          format: "mp3", quality: "high", status: "downloading", progress: 0,
          downloaded: 0, total: 0, speed: 0, type: "audio",
        },
        {
          id: "complete", url: "https://youtu.be/y", title: "Complete",
          format: "mp3", quality: "high", status: "completed", progress: 1,
          downloaded: 1, total: 1, speed: 0, type: "audio",
        },
      ],
    });
    emit("engine_ready", { type: "engine_ready", ready: true });
    expect(useDownloadStore.getState().engineStatus).toBe("ready");
    emit("engine_crashed", { type: "engine_crashed" });
    expect(useDownloadStore.getState().engineStatus).toBe("starting");
    const queue = useDownloadStore.getState().queue;
    expect(queue.find((item) => item.id === "interrupted")).toMatchObject({
      status: "failed", message: "Engine crashed — download interrupted",
    });
    expect(queue.find((item) => item.id === "complete")?.status).toBe("completed");
    // REL-01 also requires a warn-level log entry for the crash.
    const crashLog = useDownloadStore.getState().logs.find((l) => l.level === "warn");
    expect(crashLog?.message).toContain("Engine crashed");
  });
});

describe("useEngineEvents — status message flow", () => {
  beforeEach(() => {
    captured.handler = null;
    captured.connectionHandler = null;
    useDownloadStore.setState({
      queue: [],
      history: [],
      probeInfo: null,
      probeError: null,
      engineStatus: "starting",
      statusMessage: "Starting download...",
      logs: [],
      metadataResult: null,
      _logSeq: 0,
    });
  });

  it("clears the stuck 'Starting download...' message on success", async () => {
    await setup();
    emit("result", {
      type: "result",
      id: "d1",
      success: true,
      title: "T",
      fmt: "mp3",
      filepath: "D:/proj/downloads/x.mp3",
      file_size: 10,
      duration: 5,
      url: "u",
    });
    expect(useDownloadStore.getState().statusMessage).toBe("Download completed.");
  });

  it("sets a failure message on error result", async () => {
    await setup();
    emit("result", { type: "result", id: "d1", success: false, error: "boom" });
    expect(useDownloadStore.getState().statusMessage).toBe("Download failed.");
  });

  it("sets a message on cancelled and engine error events", async () => {
    await setup();
    // Seed a download item so the error event takes the download path (a
    // non-queued id is treated as a probe failure — covered separately).
    useDownloadStore.setState({
      queue: [
        {
          id: "d1",
          url: "https://youtu.be/x",
          title: "T",
          format: "mp3",
          quality: "high",
          status: "downloading",
          progress: 0,
          downloaded: 0,
          total: 0,
          speed: 0,
          type: "audio",
        },
      ],
    });
    emit("cancelled", { type: "cancelled", id: "d1" });
    expect(useDownloadStore.getState().statusMessage).toBe("Download cancelled.");
    emit("error", { type: "error", id: "d1", error: "x" });
    expect(useDownloadStore.getState().statusMessage).toBe("Download failed.");
  });

  it("re-runs queue restore on the first engine_ready after mount (N-04)", async () => {
    await setup();
    // Mount-time requestJobs lost its 500ms race: engine has a job the
    // empty queue doesn't know about. First engine_ready must restore it.
    captured.activeJobs = [
      { id: "late-job", status: "downloading", url: "https://youtu.be/x", fmt: "mp3", quality: "high", mode: "audio" },
    ];
    emit("engine_ready", { type: "engine_ready", ffmpeg: true, ffprobe: true, yt_dlp: true, mutagen: true });
    await waitFor(() =>
      expect(useDownloadStore.getState().queue.some((q) => q.id === "late-job")).toBe(true)
    );
    captured.activeJobs = [];
  });

  it("surfaces download_retry without flipping the item status", async () => {
    await setup();
    useDownloadStore.setState({
      queue: [
        {
          id: "d1",
          url: "https://youtu.be/x",
          title: "T",
          format: "mp3",
          quality: "high",
          status: "downloading",
          progress: 10,
          downloaded: 1,
          total: 10,
          speed: 1,
          type: "audio",
        },
      ],
    });
    emit("download_retry", {
      type: "download_retry",
      id: "d1",
      attempt: 1,
      delay_seconds: 2,
      error: "temporary network blip",
    });
    const item = useDownloadStore.getState().queue[0];
    expect(item?.status).toBe("downloading");
    expect(item?.message).toContain("Retrying");
    expect(
      useDownloadStore
        .getState()
        .logs.some((l) => l.level === "warn" && l.message.includes("temporary network blip"))
    ).toBe(true);
  });

  it("labels a probe failure as Probe failed (no queue item)", async () => {
    await setup();
    useDownloadStore.setState({ probeRequestId: "probe-1", probeInFlight: true });
    emit("error", {
      type: "error",
      id: "probe-1",
      error_type: "ProbeError",
      error: "unavailable",
    });
    // No queue item → not "Download failed."
    expect(useDownloadStore.getState().statusMessage).toBe("Probe failed.");
    expect(useDownloadStore.getState().probeError).toBe("unavailable");
    expect(useDownloadStore.getState().probeInFlight).toBe(false);
    expect(useDownloadStore.getState().probeRequestId).toBeNull();
    expect(useDownloadStore.getState().queue.length).toBe(0);
  });

  it("labels a download failure as Download failed when the id is queued", async () => {
    await setup();
    useDownloadStore.setState({
      queue: [
        {
          id: "d1",
          url: "https://youtu.be/x",
          title: "T",
          format: "mp3",
          quality: "high",
          status: "downloading",
          progress: 10,
          downloaded: 1,
          total: 10,
          speed: 1,
          type: "audio",
        },
      ],
    });
    emit("error", {
      type: "error",
      id: "d1",
      error_type: "DownloadError",
      error: "mux failed",
    });
    const s = useDownloadStore.getState();
    expect(s.statusMessage).toBe("Download failed.");
    expect(s.queue[0]?.status).toBe("failed");
    expect(s.queue[0]?.message).toBe("mux failed");
  });

  it("updates the message when a probe result arrives", async () => {
    await setup();
    useDownloadStore.setState({ probeRequestId: "p1", probeInFlight: true });
    emit("probe_result", {
      type: "probe_result",
      id: "p1",
      success: true,
      info: { title: "T", uploader: "U", duration: 10, thumbnail: "", webpage_url: "w", formats: [] },
    });
    expect(useDownloadStore.getState().statusMessage).toBe("Probe complete.");
    expect(useDownloadStore.getState().probeInfo?.title).toBe("T");
    expect(useDownloadStore.getState().probeInFlight).toBe(false);
    expect(useDownloadStore.getState().probeRequestId).toBeNull();
  });

  it("accepts a probe result that arrives before the REST ack (N-09)", async () => {
    await setup();
    // probeUrl registers the id before sending, so the request is already
    // known even though no ack has arrived yet.
    useDownloadStore.setState({ probeRequestId: "early", probeInFlight: true });
    emit("probe_result", {
      type: "probe_result",
      id: "early",
      success: true,
      info: { title: "Early", uploader: "U", duration: 1, thumbnail: "", webpage_url: "w", formats: [] },
    });
    expect(useDownloadStore.getState().probeInfo?.title).toBe("Early");
    expect(useDownloadStore.getState().probeInFlight).toBe(false);
  });

  it("ignores a stale probe result for a replaced request (N-09)", async () => {
    await setup();
    useDownloadStore.setState({ probeRequestId: "current", probeInFlight: true });
    emit("probe_result", {
      type: "probe_result",
      id: "old",
      success: true,
      info: { title: "Old", uploader: "U", duration: 1, thumbnail: "", webpage_url: "w", formats: [] },
    });
    const s = useDownloadStore.getState();
    expect(s.probeInfo).toBeNull();
    expect(s.probeInFlight).toBe(true);
    expect(s.probeRequestId).toBe("current");
    expect(s.logs.some((l) => l.level === "warn" && l.message.includes("stale probe result"))).toBe(true);
  });

  it("ignores a stale probe error for a replaced request (N-09)", async () => {
    await setup();
    useDownloadStore.setState({ probeRequestId: "current", probeInFlight: true });
    emit("error", {
      type: "error",
      id: "old",
      error_type: "ProbeError",
      error: "late failure",
    });
    const s = useDownloadStore.getState();
    expect(s.probeError).toBeNull();
    expect(s.probeInFlight).toBe(true);
    expect(s.probeRequestId).toBe("current");
    expect(s.statusMessage).not.toBe("Probe failed.");
    expect(s.logs.some((l) => l.level === "warn" && l.message.includes("stale engine error"))).toBe(true);
  });
});

describe("useEngineEvents — WS reconnect reconciliation", () => {
  const makeItem = (id: string) => ({
    id,
    url: "https://youtu.be/dQw4w9WgXcQ",
    title: "T",
    format: "mp3",
    quality: "high",
    status: "downloading" as const,
    progress: 0,
    downloaded: 0,
    total: 0,
    speed: 0,
    type: "audio" as const,
  });

  beforeEach(() => {
    captured.handler = null;
    captured.reconnectHandler = null;
    captured.activeJobs = [];
    captured.invokeError = false;
    useDownloadStore.setState({
      queue: [],
      history: [],
      probeInfo: null,
      probeError: null,
      engineStatus: "ready",
      statusMessage: "",
      logs: [],
      metadataResult: null,
      _logSeq: 0,
    });
  });

  it("marks orphaned downloading items failed on reconnect, keeps active ones", async () => {
    await setup();
    useDownloadStore.setState({
      queue: [makeItem("gone"), makeItem("alive")],
    });
    // Server reports only "alive" as still running — "gone" missed its
    // terminal event while the WS was down.
    captured.activeJobs = [{ id: "alive", status: "running" }];

    captured.reconnectHandler?.();

    await waitFor(() => {
      const gone = useDownloadStore.getState().queue.find((i) => i.id === "gone");
      expect(gone?.status).toBe("failed");
    });
    const queue = useDownloadStore.getState().queue;
    expect(queue.find((i) => i.id === "alive")?.status).toBe("downloading");
    expect(queue.find((i) => i.id === "gone")?.message).toBe(
      "Connection lost — download status unknown"
    );
  });

  it("leaves downloading items untouched when the status endpoint is unreachable (P2-23)", async () => {
    await setup();
    useDownloadStore.setState({ queue: [makeItem("x")] });
    captured.invokeError = true;

    captured.reconnectHandler?.();

    // Give the (async) handler a tick to run.
    await new Promise((r) => setTimeout(r, 10));

    // P2-23: a transient get_active_jobs failure must NOT false-fail every
    // in-flight download — the old code fell through with an empty active
    // list and marked everything "status unknown". The item stays exactly
    // as it was; the next progress event or reconnect will resolve it.
    expect(useDownloadStore.getState().queue[0]?.status).toBe("downloading");
    expect(
      useDownloadStore
        .getState()
        .logs.some((l) => l.message.includes("status unknown"))
    ).toBe(false);
  });

  it("does nothing on reconnect when nothing is downloading", async () => {
    await setup();
    useDownloadStore.setState({ queue: [makeItem("idle-done")] });
    // Flip to a terminal state — reconciliation must not touch it.
    useDownloadStore.setState({
      queue: [{ ...makeItem("idle-done"), status: "completed" }],
    });

    captured.reconnectHandler?.();
    // Give the (async) handler a tick to run — it should early-return.
    await new Promise((r) => setTimeout(r, 10));

    expect(useDownloadStore.getState().queue[0]?.status).toBe("completed");
  });

  it("a late successful result does not resurrect a cancelled item (F-03)", async () => {
    await setup();
    // Seed a row the user already cancelled during post-processing.
    useDownloadStore.setState({
      queue: [{ ...makeItem("cancel-me"), status: "cancelled" }],
    });

    emit("result", {
      type: "result",
      id: "cancel-me",
      success: true,
      title: "LateFinisher",
      filepath: "C:/dl/late.mp3",
      fmt: "mp3",
    });

    const s = useDownloadStore.getState();
    expect(s.queue[0]?.status).toBe("cancelled");
    expect(s.queue[0]?.filepath).toBe("C:/dl/late.mp3");
    expect(
      s.logs.some((l) => l.level === "warn" && l.message.includes("after cancel"))
    ).toBe(true);

    // A NON-cancelled item still completes normally — which in this app means
    // moving to history (addHistoryItem removes the row from the queue).
    useDownloadStore.setState({ queue: [{ ...makeItem("normal"), status: "downloading" }] });
    emit("result", { type: "result", id: "normal", success: true, title: "Normal", filepath: "C:/dl/n.mp3", fmt: "mp3" });
    expect(useDownloadStore.getState().queue.some((q) => q.id === "normal")).toBe(false);
    expect(useDownloadStore.getState().history.some((h) => h.id === "normal")).toBe(true);
  });

  it("a late result never flips a terminal row (S-1: completed<->failed)", async () => {
    await setup();
    // A completed row must ignore a late failure.
    useDownloadStore.setState({
      queue: [{ ...makeItem("done"), status: "completed" }],
    });
    emit("result", { type: "result", id: "done", success: false, error: "LateBoom", fmt: "mp3" });
    expect(useDownloadStore.getState().queue[0]?.status).toBe("completed");
    expect(
      useDownloadStore.getState().logs.some((l) => l.level === "warn" && l.message.includes("done"))
    ).toBe(true);

    // A failed row must ignore a late success (and gain no history entry).
    useDownloadStore.setState({
      queue: [{ ...makeItem("broke"), status: "failed" }],
      history: [],
    });
    emit("result", { type: "result", id: "broke", success: true, title: "Late", filepath: "C:/dl/l.mp3", fmt: "mp3" });
    const s = useDownloadStore.getState();
    expect(s.queue[0]?.status).toBe("failed");
    expect(s.history.some((h) => h.id === "broke")).toBe(false);
  });
});

describe("useEngineEvents — stability polling (cookies + bot breaker)", () => {
  beforeEach(() => {
    captured.handler = null;
    captured.status = {};
    captured.invokeError = false;
    useDownloadStore.setState({
      queue: [],
      engineStatus: "starting",
      cookieState: null,
      botBreaker: null,
      logs: [],
      _logSeq: 0,
    });
  });

  it("captures cookie-auth state from engine_ready (source only)", async () => {
    await setup();
    emit("engine_ready", {
      type: "engine_ready",
      ready: true,
      cookies: { configured: false, source: "none" },
    });
    expect(useDownloadStore.getState().cookieState).toEqual({
      configured: false,
      source: "none",
    });

    // Legacy engine without the field — previous state must survive.
    emit("engine_ready", { type: "engine_ready", ready: true });
    expect(useDownloadStore.getState().cookieState).toEqual({
      configured: false,
      source: "none",
    });
  });

  it("applies cookies + bot_breaker from the initial status poll", async () => {
    captured.status = {
      cookies: { configured: true, source: "browser" },
      bot_breaker: { open: true, consecutive_failures: 3, cooldown_seconds: 287 },
    };
    await setup();

    await waitFor(() => {
      expect(useDownloadStore.getState().cookieState).toEqual({
        configured: true,
        source: "browser",
      });
    });
    const bb = useDownloadStore.getState().botBreaker;
    expect(bb?.open).toBe(true);
    expect(bb?.consecutive_failures).toBe(3);
    expect(bb?.cooldown_seconds).toBe(287);
    expect(bb?.observedAt).toBeGreaterThan(0);
  });

  it("null breaker (engine down / legacy) closes the indicator", async () => {
    useDownloadStore.setState({
      botBreaker: { open: true, consecutive_failures: 3, cooldown_seconds: 100, observedAt: 1 },
      cookieState: { configured: true, source: "file" },
    });
    captured.status = { cookies: null, bot_breaker: null };
    await setup();

    await waitFor(() => {
      expect(useDownloadStore.getState().botBreaker).toBeNull();
    });
    expect(useDownloadStore.getState().cookieState).toBeNull();
  });

  it("keeps last known state when the status endpoint is unreachable", async () => {
    useDownloadStore.setState({
      botBreaker: { open: true, consecutive_failures: 2, cooldown_seconds: 50, observedAt: 1 },
    });
    captured.invokeError = true;
    await setup();

    // Let the initial refresh attempt fail without clobbering the store.
    await new Promise((r) => setTimeout(r, 20));
    expect(useDownloadStore.getState().botBreaker?.open).toBe(true);
  });

  it("an older server omitting the fields leaves state untouched", async () => {
    useDownloadStore.setState({
      cookieState: { configured: false, source: "none" },
    });
    captured.status = { engineReady: true }; // no cookies / bot_breaker keys
    await setup();

    await new Promise((r) => setTimeout(r, 20));
    expect(useDownloadStore.getState().cookieState).toEqual({
      configured: false,
      source: "none",
    });
    expect(useDownloadStore.getState().botBreaker).toBeNull();
  });

  it("engine_crashed clears the breaker cooldown (its state dies with the engine)", async () => {
    await setup();
    useDownloadStore.setState({
      botBreaker: { open: true, consecutive_failures: 3, cooldown_seconds: 300, observedAt: Date.now() },
    });

    // The breaker is module-global state INSIDE the Python process — a crash
    // wipes it. The header must stop advertising a cooldown that no longer
    // exists without waiting for the next status poll.
    emit("engine_crashed", { type: "engine_crashed", exit_code: 1 });
    expect(useDownloadStore.getState().botBreaker).toBeNull();
  });

  it("coerces malformed bot_breaker numerics to 0 (no NaN in the countdown)", async () => {
    captured.status = {
      bot_breaker: { open: true, consecutive_failures: "many", cooldown_seconds: "soon" },
    };
    await setup();

    await waitFor(() => {
      const bb = useDownloadStore.getState().botBreaker;
      expect(bb?.open).toBe(true);
      expect(bb?.consecutive_failures).toBe(0);
      expect(bb?.cooldown_seconds).toBe(0);
      expect(Number.isFinite(bb?.cooldown_seconds)).toBe(true);
    });
  });

  it("re-polls immediately when the tab becomes visible again", async () => {
    captured.status = { bot_breaker: { open: false } };
    await setup();
    await waitFor(() => expect(useDownloadStore.getState().botBreaker?.open).toBe(false));

    // Breaker tripped while the tab was hidden — background-tab timer
    // throttling would delay the next interval tick, so the visibilitychange
    // listener must refresh without waiting 15 s.
    captured.status = { bot_breaker: { open: true, consecutive_failures: 3, cooldown_seconds: 240 } };
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(useDownloadStore.getState().botBreaker?.cooldown_seconds).toBe(240));
  });
});

describe("useEngineEvents — WS connection-state indicator", () => {
  beforeEach(() => {
    captured.handler = null;
    captured.connectionHandler = null;
    useDownloadStore.setState({ wsConnected: false });
  });

  it("mirrors transport connection state into the store flag", async () => {
    await setup();
    expect(captured.connectionHandler).not.toBeNull();

    captured.connectionHandler?.("connected");
    expect(useDownloadStore.getState().wsConnected).toBe(true);

    captured.connectionHandler?.("disconnected");
    expect(useDownloadStore.getState().wsConnected).toBe(false);
  });
});
