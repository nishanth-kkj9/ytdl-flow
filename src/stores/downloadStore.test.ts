import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const invoke = vi.fn();

vi.mock("../api/transport", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
  listen: vi.fn(async () => () => {}),
  openPath: vi.fn(async () => {}),
}));

import { useDownloadStore } from "./downloadStore";

describe("downloadStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The probe contract requires the ack to echo the submitted id exactly;
    // default to a compliant server so unrelated tests stay focused.
    invoke.mockImplementation(async (command: string, payload?: unknown) =>
      command === "probe_url"
        ? { id: (payload as { id?: string } | undefined)?.id }
        : {},
    );
    // Reset store to a clean initial state between tests.
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

  afterEach(() => {
    vi.useRealTimers();
  });

  it("enqueueDownload adds a queued item and starts it", async () => {
    await useDownloadStore.getState().enqueueDownload(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "mp3",
      "high",
      "audio"
    );
    const s = useDownloadStore.getState();
    expect(s.queue.length).toBe(1);
    expect(s.queue[0]!.status).toBe("downloading");
    expect(s.queue[0]!.title).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(invoke).toHaveBeenCalledWith("start_download", expect.anything());
  });

  it("cancelDownload marks the item cancelled", async () => {
    useDownloadStore.setState({
      queue: [
        {
          id: "d1",
          url: "https://example.com",
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
    await useDownloadStore.getState().cancelDownload("d1");
    expect(useDownloadStore.getState().queue[0]!.status).toBe("cancelled");
    expect(invoke).toHaveBeenCalledWith("cancel_download", { id: "d1" });
  });

  it("addHistoryItem dedupes by id and caps history at 100", () => {
    const add = useDownloadStore.getState().addHistoryItem;
    add({ id: "h1", title: "A", fmt: "mp3", size: "1", duration: "1", url: "", downloaded_at: "", filepath: "", type: "audio" });
    add({ id: "h1", title: "A", fmt: "mp3", size: "1", duration: "1", url: "", downloaded_at: "", filepath: "", type: "audio" });
    expect(useDownloadStore.getState().history.length).toBe(1);

    for (let i = 0; i < 120; i++) {
      useDownloadStore.getState().addHistoryItem({
        id: `h-${i}`,
        title: `T${i}`,
        fmt: "mp3",
        size: "1",
        duration: "1",
        url: "",
        downloaded_at: "",
        filepath: "",
        type: "audio",
      });
    }
    expect(useDownloadStore.getState().history.length).toBe(100);
  });

  it("cancelDownload surfaces a failed cancel in statusMessage", async () => {
    invoke.mockRejectedValueOnce(new Error("engine down"));
    useDownloadStore.setState({
      queue: [
        {
          id: "d2",
          url: "https://example.com",
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
    await useDownloadStore.getState().cancelDownload("d2");
    const s = useDownloadStore.getState();
    expect(s.statusMessage).toBe("Failed to cancel download.");
    expect(s.logs[0]?.level).toBe("error");
  });

  it("restartEngine invokes the restart command", async () => {
    await useDownloadStore.getState().restartEngine();
    expect(invoke).toHaveBeenCalledWith("restart_engine");
    expect(useDownloadStore.getState().engineStatus).toBe("starting");
  });

  it("setBotBreaker stamps observedAt for the local countdown; null clears", () => {
    const before = Date.now();
    useDownloadStore.getState().setBotBreaker({
      open: true,
      consecutive_failures: 3,
      cooldown_seconds: 300,
    });
    const bb = useDownloadStore.getState().botBreaker!;
    expect(bb.open).toBe(true);
    expect(bb.cooldown_seconds).toBe(300);
    expect(bb.observedAt).toBeGreaterThanOrEqual(before);
    expect(bb.observedAt).toBeLessThanOrEqual(Date.now());

    useDownloadStore.getState().setBotBreaker(null);
    expect(useDownloadStore.getState().botBreaker).toBeNull();
  });

  it("setCookieState stores the source-only shape", () => {
    useDownloadStore.getState().setCookieState({ configured: false, source: "none" });
    expect(useDownloadStore.getState().cookieState).toEqual({
      configured: false,
      source: "none",
    });
    useDownloadStore.getState().setCookieState(null);
    expect(useDownloadStore.getState().cookieState).toBeNull();
  });

  it("restoreActiveJobs rebuilds the queue from active jobs (F-02)", async () => {
    invoke.mockResolvedValueOnce([
      { id: "rj1", status: "downloading", url: "https://youtu.be/aaaa", fmt: "opus", quality: "high", mode: "audio" },
      { id: "rj2", status: "queued", url: "https://youtu.be/bbbb", fmt: "mp4", quality: "1080p", mode: "video" },
    ]);
    await useDownloadStore.getState().restoreActiveJobs();
    const s = useDownloadStore.getState();
    expect(s.queue.length).toBe(2);
    expect(s.queue[0]!.id).toBe("rj1");
    expect(s.queue[0]!.status).toBe("downloading");
    expect(s.queue[0]!.format).toBe("opus");
    expect(s.queue[0]!.type).toBe("audio");
    expect(s.queue[1]!.status).toBe("queued");
    expect(s.queue[1]!.type).toBe("video");
  });

  it("restoreActiveJobs is idempotent — never duplicates existing ids (F-02)", async () => {
    useDownloadStore.setState({
      queue: [{ id: "rj1", url: "u", title: "t", format: "mp3", quality: "high", status: "downloading", progress: 0, downloaded: 0, total: 0, speed: 0, type: "audio" }],
    });
    invoke.mockResolvedValueOnce([{ id: "rj1", status: "downloading", url: "u", fmt: "mp3", quality: "high", mode: "audio" }]);
    await useDownloadStore.getState().restoreActiveJobs();
    expect(useDownloadStore.getState().queue.length).toBe(1);
  });

  it("probeUrl sets probeInFlight and the 75s watchdog clears it (F-11/N-09)", async () => {
    vi.useFakeTimers();
    invoke.mockImplementationOnce(async (_command: string, payload: { id: string }) => ({ id: payload.id }));
    const p = useDownloadStore.getState().probeUrl("https://youtu.be/aaaa");
    await p;
    expect(useDownloadStore.getState().probeInFlight).toBe(true);
    vi.advanceTimersByTime(74_000);
    expect(useDownloadStore.getState().probeInFlight).toBe(true);
    vi.advanceTimersByTime(1_000);
    expect(useDownloadStore.getState().probeInFlight).toBe(false);
    expect(useDownloadStore.getState().probeError).toContain("timed out");
    vi.useRealTimers();
  });

  it("registers the probe id before the REST call resolves (N-09)", async () => {
    let resolveAck!: (value: unknown) => void;
    invoke.mockReturnValueOnce(new Promise((resolve) => {
      resolveAck = resolve;
    }));

    const p = useDownloadStore.getState().probeUrl("https://youtu.be/aaaa");
    const pendingId = useDownloadStore.getState().probeRequestId;

    expect(pendingId).toBeTruthy();
    expect(useDownloadStore.getState().probeInFlight).toBe(true);
    expect(invoke).toHaveBeenCalledWith(
      "probe_url",
      expect.objectContaining({ url: "https://youtu.be/aaaa", id: pendingId }),
    );

    resolveAck({ id: pendingId });
    await p;
    expect(useDownloadStore.getState().probeRequestId).toBe(pendingId);
  });

  it("never arms a watchdog when the result lands before the ack (N-09)", async () => {
    vi.useFakeTimers();
    let resolveAck!: (value: unknown) => void;
    invoke.mockReturnValueOnce(new Promise((resolve) => {
      resolveAck = resolve;
    }));

    const p = useDownloadStore.getState().probeUrl("https://youtu.be/aaaa");
    const pendingId = useDownloadStore.getState().probeRequestId!;

    // The WS result arrived first: the hook clears the watchdog and finishes
    // the request while the REST ack is still in flight.
    useDownloadStore.getState().clearProbeTimeout(pendingId);
    useDownloadStore.setState({ probeInFlight: false, probeRequestId: null });

    resolveAck({ id: pendingId });
    await p;

    const s = useDownloadStore.getState();
    expect(s.probeInFlight).toBe(false);
    expect(s.probeRequestId).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    // A completed request is not a "stale" anomaly — no warn-level noise.
    expect(
      s.logs.some((l) => l.level === "warn" && l.message.includes("stale probe_url ack")),
    ).toBe(false);
    vi.useRealTimers();
  });

  it("arms the watchdog only after the REST ack (N-09)", async () => {
    vi.useFakeTimers();
    let resolveAck!: (value: unknown) => void;
    invoke.mockReturnValueOnce(new Promise((resolve) => {
      resolveAck = resolve;
    }));

    const p = useDownloadStore.getState().probeUrl("https://youtu.be/aaaa");
    expect(vi.getTimerCount()).toBe(0);

    const pendingId = useDownloadStore.getState().probeRequestId;
    resolveAck({ id: pendingId });
    await p;
    expect(vi.getTimerCount()).toBe(1);
    vi.useRealTimers();
  });

  it("rejects a mismatched ack id instead of adopting it (N-09)", async () => {
    vi.useFakeTimers();
    invoke.mockResolvedValueOnce({ id: "server-probe-1" });

    await useDownloadStore.getState().probeUrl("https://youtu.be/aaaa");

    const s = useDownloadStore.getState();
    expect(s.probeRequestId).toBeNull();
    expect(s.probeInFlight).toBe(false);
    expect(s.probeError).toContain("acknowledged");
    expect(s.statusMessage).toBe("Probe failed.");
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it.each([
    ["missing", {}],
    ["empty", { id: "" }],
    ["non-string", { id: 42 }],
    ["malformed", { id: "bad id!" }],
    ["primitive", "not-an-object"],
  ])("rejects a %s ack id as a protocol error (N-09)", async (_label, ack) => {
    vi.useFakeTimers();
    invoke.mockResolvedValueOnce(ack);

    await useDownloadStore.getState().probeUrl("https://youtu.be/aaaa");

    const s = useDownloadStore.getState();
    expect(s.probeRequestId).toBeNull();
    expect(s.probeInFlight).toBe(false);
    expect(s.probeError).toContain("acknowledged");
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it("probeUrl clears stale watchdog timers when a probe finishes or is replaced", async () => {
    vi.useFakeTimers();
    invoke.mockImplementation(async (_command: string, payload: { id: string }) => ({ id: payload.id }));

    await useDownloadStore.getState().probeUrl("https://youtu.be/one");
    expect(vi.getTimerCount()).toBe(1);

    useDownloadStore.getState().clearProbeTimeout();
    expect(vi.getTimerCount()).toBe(0);

    await useDownloadStore.getState().probeUrl("https://youtu.be/two");
    expect(vi.getTimerCount()).toBe(1);

    useDownloadStore.getState().clearProbeTimeout();
    expect(vi.getTimerCount()).toBe(0);

    vi.useRealTimers();
  });

  it("ignores a clear for an id that does not own the watchdog (N-09)", async () => {
    vi.useFakeTimers();

    await useDownloadStore.getState().probeUrl("https://youtu.be/one");
    const currentId = useDownloadStore.getState().probeRequestId;
    useDownloadStore.getState().clearProbeTimeout("old-request");

    expect(vi.getTimerCount()).toBe(1);
    expect(useDownloadStore.getState().probeRequestId).toBe(currentId);
    expect(useDownloadStore.getState().probeInFlight).toBe(true);
    vi.useRealTimers();
  });

  it("replacing a probe owns the single watchdog (N-09)", async () => {
    vi.useFakeTimers();
    invoke.mockImplementation(async (_command: string, payload: { id: string }) => ({ id: payload.id }));

    await useDownloadStore.getState().probeUrl("https://youtu.be/one");
    const firstId = useDownloadStore.getState().probeRequestId;
    await useDownloadStore.getState().probeUrl("https://youtu.be/two");
    const secondId = useDownloadStore.getState().probeRequestId;

    expect(secondId).not.toBe(firstId);
    expect(vi.getTimerCount()).toBe(1);

    // The first request's late result must not clear the second watchdog.
    useDownloadStore.getState().clearProbeTimeout(firstId!);
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(75_000);
    expect(useDownloadStore.getState().probeRequestId).toBeNull();
    expect(useDownloadStore.getState().probeError).toContain("timed out");
    vi.useRealTimers();
  });

  it("probeUrl clears probeInFlight on REST failure (F-11)", async () => {
    invoke.mockRejectedValueOnce(new Error("down"));
    await useDownloadStore.getState().probeUrl("https://youtu.be/aaaa");
    expect(useDownloadStore.getState().probeInFlight).toBe(false);
    expect(useDownloadStore.getState().probeRequestId).toBeNull();
  });

  it("ignores a REST failure for a probe that was replaced (N-09)", async () => {
    let rejectOld!: (error: Error) => void;
    invoke.mockReturnValueOnce(new Promise((_resolve, reject) => {
      rejectOld = reject;
    }));
    const oldProbe = useDownloadStore.getState().probeUrl("https://youtu.be/old");

    invoke.mockImplementationOnce(async (_command: string, payload: { id: string }) => ({ id: payload.id }));
    await useDownloadStore.getState().probeUrl("https://youtu.be/new");
    const currentId = useDownloadStore.getState().probeRequestId;

    rejectOld(new Error("down"));
    await oldProbe;

    const s = useDownloadStore.getState();
    expect(s.probeRequestId).toBe(currentId);
    expect(s.probeInFlight).toBe(true);
    expect(s.probeError).toBeNull();
    expect(s.statusMessage).not.toBe("Probe failed.");
    useDownloadStore.getState().clearProbeTimeout();
  });

  it("ignores a stale ack that resolves after a newer probe started (N-09)", async () => {
    vi.useFakeTimers();
    let resolveOld!: (value: unknown) => void;
    invoke.mockReturnValueOnce(new Promise((resolve) => {
      resolveOld = resolve;
    }));
    const oldProbe = useDownloadStore.getState().probeUrl("https://youtu.be/old");
    const oldId = useDownloadStore.getState().probeRequestId;

    await useDownloadStore.getState().probeUrl("https://youtu.be/new");
    const newId = useDownloadStore.getState().probeRequestId;
    expect(newId).not.toBe(oldId);

    resolveOld({ id: oldId });
    await oldProbe;

    const s = useDownloadStore.getState();
    expect(s.probeRequestId).toBe(newId);
    expect(s.probeInFlight).toBe(true);
    expect(vi.getTimerCount()).toBe(1);
    vi.useRealTimers();
  });
});
