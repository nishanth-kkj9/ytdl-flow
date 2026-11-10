import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the transport so App's useEngineEvents subscription and the store's
// REST calls never touch a real server (mirrors useEngineEvents.test.ts).
vi.mock("./api/transport", () => ({
  listen: vi.fn(async () => () => {}),
  onReconnect: vi.fn(() => () => {}),
  onConnectionChange: vi.fn(() => () => {}),
  getConnectionState: vi.fn(() => "connected"),
  openPath: vi.fn(async () => {}),
  invoke: vi.fn(async (command: string) => {
    if (command === "get_download_dir") return "D:/proj/downloads";
    if (command === "get_active_jobs") return [];
    if (command === "load_history") return [];
    if (command === "get_status") return {}; // legacy server: no stability keys
    return {};
  }),
}));

import App from "./App";
import { useDownloadStore } from "./stores/downloadStore";

describe("App — bot-check countdown anchor", () => {
  beforeEach(() => {
    // Fake Date too: the countdown mixes the frozen mount-time `now` state
    // with the poll's observedAt (Date.now at receipt).
    vi.useFakeTimers({
      toFake: ["Date", "setInterval", "clearInterval", "setTimeout", "clearTimeout"],
    });
    useDownloadStore.setState({
      engineStatus: "ready",
      wsConnected: true,
      cookieState: null,
      botBreaker: null,
      queue: [],
      history: [],
      logs: [],
      _logSeq: 0,
      toasts: [],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    delete window.ytdlDesktop;
  });

  it("re-anchors the local clock when the breaker opens after a long idle period", async () => {
    await act(async () => {
      render(<App />);
    });

    // Page stays open 10 minutes with the breaker closed — the `now` tick
    // state is frozen at mount because the interval only runs while open.
    await act(async () => {
      vi.advanceTimersByTime(10 * 60 * 1000);
    });

    // Breaker trips; observedAt is stamped at receipt (now = mount + 10 min).
    await act(async () => {
      useDownloadStore.setState({
        botBreaker: {
          open: true,
          consecutive_failures: 3,
          cooldown_seconds: 300,
          observedAt: Date.now(),
        },
      });
    });

    // Without the effect's setNow(Date.now()) re-anchor, the frozen clock
    // computes elapsed = -600 s and renders an inflated "Bot-check 900s".
    expect(screen.getByRole("status", { name: /cooldown/i })).toHaveTextContent("300s");
  });

  it("ticks the countdown down between status polls", async () => {
    await act(async () => {
      render(<App />);
    });
    await act(async () => {
      useDownloadStore.setState({
        botBreaker: {
          open: true,
          consecutive_failures: 3,
          cooldown_seconds: 300,
          observedAt: Date.now(),
        },
      });
    });
    expect(screen.getByRole("status", { name: /cooldown/i })).toHaveTextContent("300s");

    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.getByRole("status", { name: /cooldown/i })).toHaveTextContent("295s");
  });

  it("hides the countdown tag once the breaker closes", async () => {
    await act(async () => {
      render(<App />);
    });
    await act(async () => {
      useDownloadStore.setState({
        botBreaker: {
          open: true,
          consecutive_failures: 3,
          cooldown_seconds: 300,
          observedAt: Date.now(),
        },
      });
    });
    expect(screen.getByRole("status", { name: /cooldown/i })).toBeInTheDocument();

    await act(async () => {
      useDownloadStore.getState().setBotBreaker(null);
    });
    expect(screen.queryByRole("status", { name: /cooldown/i })).toBeNull();
  });

  it("uses the native desktop dialog to change the download folder", async () => {
    const chooseDownloadDirectory = vi.fn(async () => ({
      status: "updated" as const,
      path: "D:/YTDL Flow",
    }));
    Object.defineProperty(window, "ytdlDesktop", {
      configurable: true,
      value: { chooseDownloadDirectory },
    });

    await act(async () => {
      render(<App />);
    });
    const button = screen.getByRole("button", { name: "Choose download folder" });
    await act(async () => {
      fireEvent.click(button);
    });

    expect(chooseDownloadDirectory).toHaveBeenCalledOnce();
    expect(button).toHaveAttribute("title", "Download folder: D:/YTDL Flow");
  });

  it("announces when the backend blocks a folder change during active jobs", async () => {
    Object.defineProperty(window, "ytdlDesktop", {
      configurable: true,
      value: {
        chooseDownloadDirectory: vi.fn(async () => ({
          status: "blocked" as const,
          message: "Finish or cancel active downloads before changing the download folder.",
        })),
      },
    });

    await act(async () => {
      render(<App />);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Choose download folder" }));
    });

    expect(
      screen.getByText("Finish or cancel active downloads before changing the download folder."),
    ).toBeInTheDocument();
  });
});