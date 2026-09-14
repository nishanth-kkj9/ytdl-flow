import { useEffect, useRef, useState } from "react";
import { PanelRight } from "lucide-react";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Layout } from "./components/Layout";
import { DrawerPanel } from "./components/DrawerPanel";
import { UrlInput } from "./components/UrlInput";
import { ProbeCard } from "./components/ProbeCard";
import { EmptyState } from "./components/EmptyState";
import { WaveformProgress } from "./components/WaveformProgress";
import { MetadataPanel } from "./components/MetadataPanel";
import { LogPanel } from "./components/LogPanel";
import { ToastContainer } from "./components/ToastContainer";
import { useEngineEvents } from "./hooks/useEngineEvents";
import { useDownloadStore } from "./stores/downloadStore";

function App() {
  useEngineEvents();
  const loadHistory = useDownloadStore((state) => state.loadHistory);
  const restoreActiveJobs = useDownloadStore((state) => state.restoreActiveJobs);
  const queue = useDownloadStore((state) => state.queue);
  const probeInfo = useDownloadStore((state) => state.probeInfo);
  const selectedMode = useDownloadStore((state) => state.selectedMode);
  const engineStatus = useDownloadStore((state) => state.engineStatus);
  const wsConnected = useDownloadStore((state) => state.wsConnected);

  // P2-18: badge counts only genuinely active items — counting every queue
  // row (incl. failed/cancelled) made "3 in queue" linger after everything
  // finished or failed. Failed rows remain in the queue for retry (P1-8) but
  // shouldn't advertise themselves as queued work.
  const totalQueued = queue.filter(
    (i) => i.status === "queued" || i.status === "downloading",
  ).length;

  const [drawerTab, setDrawerTab] = useState<"downloads" | "history">("downloads");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawerTriggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    loadHistory();
    // F-02: a refresh must not orphan in-flight downloads — rebuild the
    // queue from the server's active-jobs snapshot.
    restoreActiveJobs();
  }, [loadHistory, restoreActiveJobs]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "b") {
        e.preventDefault();
        setDrawerOpen((prev) => !prev);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  const engineLabel =
    engineStatus === "ready" ? "Engine ready" :
    engineStatus === "starting" ? "Engine starting" : "Engine error";
  const engineDot =
    engineStatus === "ready" ? "bg-success" :
    engineStatus === "starting" ? "bg-warning animate-pulse" : "bg-error";

  return (
    <>
      <Layout
        main={
          <ErrorBoundary>
            <div className="flex h-screen flex-col text-text">
              <header className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3 sm:px-6 sm:py-3.5">
                <div className="flex items-center gap-3.5">
                  <div className="badge-play" aria-hidden="true">
                    <img src="/branding/ytdl-flow-icon.svg" alt="" width={22} height={22} />
                  </div>
                  <div>
                    <h1 className="text-base font-semibold tracking-tight text-text">
                      YTDL Flow
                    </h1>
                    <p className="text-xs font-medium tracking-wide text-text-muted">
                      YouTube audio & video downloader
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2.5">
                  {!wsConnected && (
                    <span
                      className="tag tag-downloading"
                      role="status"
                      aria-label="Connection to server lost — reconnecting"
                      title="Connection to the server was lost. Live updates paused; retrying automatically."
                    >
                      Reconnecting…
                    </span>
                  )}
                  <span className="flex items-center gap-1.5 text-xs text-text-muted" aria-label={engineLabel}>
                    <span className={`inline-block h-1.5 w-1.5 rounded-full ${engineDot}`} aria-hidden="true" />
                    {engineLabel}
                  </span>
                  {totalQueued > 0 && (
                    <span className="tag tag-downloading">{totalQueued} in queue</span>
                  )}
                  <span className={`tag ${selectedMode === "audio" ? "tag-audio" : "tag-video"}`}>
                    {selectedMode === "audio" ? "Audio" : "Video"}
                  </span>
                  <button
                    type="button"
                    ref={drawerTriggerRef}
                    aria-label="Open queue and history"
                    aria-expanded={drawerOpen}
                    aria-controls="queue-history-drawer"
                    onClick={() => setDrawerOpen(true)}
                    className="flex h-8 w-8 items-center justify-center rounded-lg text-text-muted transition hover:bg-raised hover:text-text-secondary"
                  >
                    <PanelRight className="h-4 w-4" aria-hidden="true" />
                  </button>
                </div>
              </header>

              <div className="flex-1 overflow-y-auto animate-fade-in">
                <div className="mx-auto w-full max-w-5xl space-y-5 px-4 py-5 sm:px-6 lg:px-8">
                  <UrlInput />
                  <div key={probeInfo?.id ?? "empty"} className="animate-fade-in">
                    {probeInfo ? <ProbeCard info={probeInfo} /> : <EmptyState />}
                  </div>
                  <WaveformProgress />
                  <MetadataPanel />
                  <LogPanel />
                </div>
              </div>
            </div>
          </ErrorBoundary>
        }
      />
      <DrawerPanel
        open={drawerOpen}
        tab={drawerTab}
        onTabChange={setDrawerTab}
        onClose={() => setDrawerOpen(false)}
        triggerRef={drawerTriggerRef}
      />
      <ToastContainer />
    </>
  );
}

export default App;
