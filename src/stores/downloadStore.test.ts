import { describe, it, expect, beforeEach, vi } from "vitest";

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
    invoke.mockResolvedValue({});
    // Reset store to a clean initial state between tests.
    useDownloadStore.setState({
      queue: [],
      history: [],
      probeInfo: null,
      probeError: null,
      engineStatus: "starting",
      cookieState: null,
      botBreaker: null,
      statusMessage: "",
      logs: [],
      metadataResult: null,
      _logSeq: 0,
    });
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

  it("probeUrl sets probeInFlight and the 60s watchdog clears it (F-11)", async () => {
    vi.useFakeTimers();
    invoke.mockResolvedValueOnce({});
    const p = useDownloadStore.getState().probeUrl("https://youtu.be/aaaa");
    await p;
    expect(useDownloadStore.getState().probeInFlight).toBe(true);
    vi.advanceTimersByTime(61_000);
    expect(useDownloadStore.getState().probeInFlight).toBe(false);
    expect(useDownloadStore.getState().probeError).toContain("timed out");
    vi.useRealTimers();
  });

  it("probeUrl clears probeInFlight on REST failure (F-11)", async () => {
    invoke.mockRejectedValueOnce(new Error("down"));
    await useDownloadStore.getState().probeUrl("https://youtu.be/aaaa");
    expect(useDownloadStore.getState().probeInFlight).toBe(false);
  });
});