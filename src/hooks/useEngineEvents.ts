import { useEffect, useRef } from "react";
import { listen, invoke, onReconnect, onConnectionChange, type UnlistenFn } from "../api/transport";
import { useDownloadStore } from "../stores/downloadStore";
import { FormatInfo } from "../types";

export function useEngineEvents() {
  const updateQueueItem = useDownloadStore((state) => state.updateQueueItem);
  const addHistoryItem = useDownloadStore((state) => state.addHistoryItem);
  const setProbeInfo = useDownloadStore((state) => state.setProbeInfo);
  const addLog = useDownloadStore((state) => state.addLog);
  const setEngineStatus = useDownloadStore((state) => state.setEngineStatus);
  const setWsConnected = useDownloadStore((state) => state.setWsConnected);
  const setMetadataResult = useDownloadStore((state) => state.setMetadataResult);
  const setStatusMessage = useDownloadStore((state) => state.setStatusMessage);
  const addToast = useDownloadStore((state) => state.addToast);
  const setCookieState = useDownloadStore((state) => state.setCookieState);
  const setBotBreaker = useDownloadStore((state) => state.setBotBreaker);

  const downloadBaseRef = useRef<string | null>(null);
  // P2-23: prevents overlapping reconcile passes when onReconnect fires
  // twice in quick succession — each pass invokes get_active_jobs, and a
  // later pass could mark items the earlier pass had just decided about.
  const reconcileInFlight = useRef(false);

  function parseFormats(raw: unknown): FormatInfo[] {
    if (!Array.isArray(raw)) return [];
    return raw.map((f: unknown) => {
      const fmt = f as Record<string, unknown>;
      return {
        format_id: String(fmt.format_id ?? ""),
        ext: String(fmt.ext ?? ""),
        resolution: fmt.resolution != null ? String(fmt.resolution) : undefined,
        filesize: fmt.filesize != null ? Number(fmt.filesize) : undefined,
        fps: fmt.fps != null ? Number(fmt.fps) : undefined,
        vcodec: fmt.vcodec && String(fmt.vcodec) !== "none" ? String(fmt.vcodec) : undefined,
        acodec: fmt.acodec && String(fmt.acodec) !== "none" ? String(fmt.acodec) : undefined,
        abr: fmt.abr != null ? Number(fmt.abr) : undefined,
        vbr: fmt.vbr != null ? Number(fmt.vbr) : undefined,
        tbr: fmt.tbr != null ? Number(fmt.tbr) : undefined,
        channels: fmt.channels != null ? Number(fmt.channels) : undefined,
        audio_sample_rate: fmt.audio_sample_rate != null ? Number(fmt.audio_sample_rate) : undefined,
      };
    });
  }

  useEffect(() => {
    // P1-9: StrictMode mounts → cleanup → mounts again. The subscriptions are
    // created inside an async IIFE AFTER an await, so the first mount's
    // cleanup used to run while every unlisten ref was still null — the first
    // mount's listeners were never removed and every event was processed
    // twice in dev. The cancelled flag closes that gap.
    let cancelled = false;
    let unlistenEngine: UnlistenFn | null = null;
    let unlistenReconnect: UnlistenFn | null = null;
    let unlistenConnection: UnlistenFn | null = null;
    // N-04: mount-time requestJobs can lose its 500ms race against a ready
    // engine. Re-run the restore once on the first engine_ready after mount
    // (restores are idempotent; later readies from restarts find an empty
    // job map, so once-only is correct and cannot loop).
    let restoredOnReady = false;

    (async () => {
      try {
        const dir = await invoke<string>("get_download_dir");
        let base = dir.replace(/\\/g, "/");
        if (base.endsWith("/downloads")) {
          base = base.slice(0, -10);
        }
        downloadBaseRef.current = base;
      } catch {
        // download base unavailable — filepath resolution skipped
      }

      // ── WS connection-state indicator ────────────────────────────────────
      // The header badge reflects the ENGINE; this reflects the WebSocket
      // itself, so a dead/backlogged server is visible in the UI.
      const unlistenConnectionLocal = onConnectionChange((state) => {
        setWsConnected(state === "connected");
      });
      if (cancelled) {
        unlistenConnectionLocal();
        return;
      }
      unlistenConnection = unlistenConnectionLocal;

      const unlistenEngineLocal = await listen("engine-event", (event) => {
        const payload = event.payload as Record<string, unknown>;
        // Any engine_ready flips the status to ready. This covers both the
        // server's on-connect snapshot and real bus events — no "seen once"
        // gate here, otherwise the badge stays on "starting" forever after an
        // engine restart (restartEngine() sets "starting", and the follow-up
        // engine_ready was previously ignored).
        if (payload.type === "engine_ready") {
          setEngineStatus("ready");
          if (!restoredOnReady) {
            restoredOnReady = true;
            void useDownloadStore.getState().restoreActiveJobs();
          }
          // Cookie-auth state rides engine_ready (shape only — configured/
          // source, never contents). Legacy engines omit it: keep the last
          // known state instead of clobbering with garbage.
          const cookies = payload.cookies;
          if (cookies && typeof cookies === "object") {
            setCookieState({
              configured: Boolean((cookies as Record<string, unknown>).configured),
              source: String((cookies as Record<string, unknown>).source ?? "none"),
            });
          }
        }
        if (payload.type === "fatal_error") {
          setEngineStatus("error");
        }
        if (payload.type === "engine_crashed") {
          // EngineManager auto-restarts with bounded attempts — reflect the
          // transient downtime instead of silently keeping a stale "ready".
          for (const item of useDownloadStore.getState().queue) {
            if (item.status === "downloading") {
              updateQueueItem(item.id, {
                status: "failed",
                message: "Engine crashed — download interrupted",
              });
            }
          }
          setEngineStatus("starting");
          // The bot-check breaker is module-global state INSIDE the engine
          // process — a crash wipes it (a fresh engine starts closed). Close
          // the header countdown immediately instead of advertising a
          // cooldown that no longer exists until the next status poll (≤15 s)
          // reports null/closed. Mirrors the backend clearing readyCookies
          // on child exit.
          setBotBreaker(null);
        }
        const id = String(payload.id ?? "");

        switch (payload.type) {
          case "probe_result": {
            // N-09: only the request currently being awaited may update probe
            // UI. A late result from a replaced/timed-out probe is stale.
            const currentProbeId = useDownloadStore.getState().probeRequestId;
            if (!currentProbeId || id !== currentProbeId) {
              addLog(
                `Ignored stale probe result for ${id || "unknown id"}`,
                "warn"
              );
              return;
            }
            const info = payload.info as Record<string, unknown>;
            if (!info) {
              useDownloadStore.getState().clearProbeTimeout(id);
              useDownloadStore.setState({
                probeInFlight: false,
                probeRequestId: null,
                probeError: "Probe returned no metadata.",
                statusMessage: "Probe failed.",
              });
              return;
            }
            useDownloadStore.getState().clearProbeTimeout(id);
            setProbeInfo({
              id,
              title: String(info.title ?? "Unknown title"),
              uploader: String(info.uploader ?? "Unknown uploader"),
              duration:
                info.duration != null && Number.isFinite(Number(info.duration))
                  ? Number(info.duration)
                  : undefined,
              thumbnail: String(info.thumbnail ?? ""),
              url: String(info.webpage_url ?? ""),
              description: String(info.description ?? ""),
              formats: parseFormats(info.formats),
            });
            addLog(`Probe success: ${String(info.title ?? "unknown")}`);
            setStatusMessage("Probe complete.");
            // F-11: the spinner is bound to the real probe lifecycle.
            useDownloadStore.setState({
              probeInFlight: false,
              probeRequestId: null,
            });
            return;
          }
          case "download_started": {
            updateQueueItem(id, { status: "downloading", message: "Starting" });
            setMetadataResult(null);
            return;
          }
          case "progress": {
            // P1-13: a trailing progress event (in-flight when the user hit
            // cancel, or racing the terminal event) must not resurrect an
            // already-terminal item back to "downloading".
            const current = useDownloadStore
              .getState()
              .queue.find((qi) => qi.id === id);
            if (
              current &&
              (current.status === "cancelled" ||
                current.status === "completed" ||
                current.status === "failed")
            ) {
              return;
            }
            const downloaded = Number(payload.downloaded ?? 0);
            const total = Number(payload.total ?? 0);
            const progress = total > 0 ? downloaded / total : 0;
            const speed = Number(payload.speed ?? 0);
            updateQueueItem(id, {
              status: "downloading",
              downloaded,
              total,
              progress,
              speed,
              message: String(payload.status ?? "downloading"),
            });
            return;
          }
          case "download_retry": {
            // Automatic engine retry in progress — surface the attempt and how
            // long the user will wait so the download doesn't look frozen.
            const attempt = Number(payload.attempt ?? 0);
            const delay = Number(payload.delay_seconds ?? 0);
            updateQueueItem(id, { message: `Retrying (attempt ${attempt})…` });
            addLog(
              `Download retrying (attempt ${attempt}) in ${delay}s — ${String(payload.error ?? "")}`,
              "warn"
            );
            return;
          }
          case "result": {
            const success = Boolean(payload.success ?? false);
            const fmt = String(payload.fmt ?? "");
            const resolvedType = ["mp4", "webm", "mkv"].includes(fmt.toLowerCase()) ? "video" : "audio";
            let filepath = String(payload.filepath ?? "");
            // Detect absolute paths generically (Windows drive letter or POSIX
            // leading slash) so we don't double-prefix the project root.
            const isAbsolute = /^[A-Za-z]:[\\/]/.test(filepath) || filepath.startsWith("/");
            if (filepath && !isAbsolute && downloadBaseRef.current) {
              filepath = downloadBaseRef.current + "/" + filepath.replace(/\\/g, "/");
            }
            // F-03: mirror the P1-13 progress guard. A cancel that landed
            // during ffmpeg post-processing (no progress hooks fire there) is
            // acked by the engine, but the engine may still finish and emit a
            // late result. Respect the user's terminal decision: keep
            // "cancelled", log the file outcome, and record the path so the
            // file is still reachable from the row.
            const current = useDownloadStore.getState().queue.find((qi) => qi.id === id);
            if (current && current.status === "cancelled") {
              addLog(
                `Download ${success ? "completed" : "failed"} after cancel: ${id}` +
                  (success ? " — file kept on disk" : ""),
                "warn"
              );
              if (success && filepath) {
                updateQueueItem(id, {
                  filepath,
                  ...(payload.title ? { title: String(payload.title) } : {}),
                });
              }
              return;
            }
            // S-1: terminal rows are final. A late/duplicate result must
            // never flip completed<->failed (no engine path emits that, but
            // the store previously accepted any terminal overwrite blindly).
            if (current && (current.status === "completed" || current.status === "failed")) {
              addLog(`Duplicate result ignored for ${current.status} download: ${id}`, "warn");
              return;
            }
            updateQueueItem(id, {
              status: success ? ("completed" as const) : ("failed" as const),
              filepath,
              // IMP-07/11: engine-attached honesty notes (duplicate-title
              // skip, no-FFmpeg progressive fallback) ride the result event.
              message: success
                ? `Completed${payload.warnings ? ` — ${String(payload.warnings)}` : ""}`
                : String(payload.error ?? "Failed"),
              progress: success ? 1 : 0,
              // P1-10: only spread `title` when the payload carries one — an
              // explicit `title: undefined` key overwrote the existing title
              // with undefined ({...item, ...patch}), blanking it back to the
              // raw URL for failure payloads that omit title.
              ...(payload.title ? { title: String(payload.title) } : {}),
            });
            addLog(`Download ${success ? "finished" : "failed"}: ${id}`);
            setStatusMessage(success ? "Download completed." : "Download failed.");
            if (success) {
              addToast(`Download complete: ${String(payload.title ?? "audio")}`, "success");
              const queueItem = useDownloadStore.getState().queue.find((qi) => qi.id === id);
              addHistoryItem({
                id,
                title: String(payload.title ?? "Unknown title"),
                fmt,
                size: String(payload.file_size ?? "0"),
                duration: String(payload.duration ?? "0"),
                url: String(payload.url ?? ""),
                downloaded_at: new Date().toISOString(),
                filepath,
                type: resolvedType,
                status: "completed",
                thumbnail: queueItem?.thumbnail,
              });
              const rawFields = payload.metadata_fields as Record<string, string> | undefined;
              const rawVerify = payload.metadata_verify as Record<string, boolean> | undefined;
              // Only show the metadata panel when something was actually
              // embedded or verified. An empty {} (metadata embedding failed
              // entirely) must NOT render the panel — it would display
              // "Metadata Embedded" with every check marked failed.
              const hasFields = !!rawFields && Object.keys(rawFields).length > 0;
              const hasVerify = !!rawVerify && Object.keys(rawVerify).length > 0;
              if (hasFields || hasVerify) {
                setMetadataResult({
                  fields: rawFields ?? {},
                  verify: rawVerify ?? {},
                  engine: String(payload.metadata_engine ?? ""),
                  container: String(payload.metadata_container ?? ""),
                  cover_art: Boolean(payload.metadata_cover_art ?? false),
                });
              }
            }
            return;
          }
          case "cancelled": {
            updateQueueItem(id, { status: "cancelled", message: "Cancelled" });
            addLog(`Cancelled: ${id}`);
            setStatusMessage("Download cancelled.");
            return;
          }
          case "error": {
            const errMsg = String(payload.error ?? "Error");
            // Probe failures arrive as `error` events carrying a probe id that
            // is never added to the download queue. Label them correctly —
            // otherwise every failed probe flashes "Download failed.".
            const isDownloadItem = useDownloadStore
              .getState()
              .queue.some((qi) => qi.id === id);
            addLog(`Engine error: ${String(payload.error_type ?? "")}: ${errMsg}`);
            if (isDownloadItem) {
              updateQueueItem(id, { status: "failed", message: errMsg });
              setStatusMessage("Download failed.");
            } else if (
              id &&
              useDownloadStore.getState().probeRequestId === id
            ) {
              // P2-24: WS-path probe failures previously only touched the
              // small grey status strip — the red "Probe failed" alert with
              // its Retry button existed solely on the REST path. Surface
              // them identically so both paths behave the same.
              // F-11/N-09: release only the owning request's spinner; a stale
              // error for a replaced/timed-out probe must not touch the UI.
              useDownloadStore.getState().clearProbeTimeout(id);
              useDownloadStore.setState({
                probeError: errMsg,
                probeInFlight: false,
                probeRequestId: null,
              });
              addToast(`Probe failed: ${errMsg}`, "error");
              setStatusMessage("Probe failed.");
            } else if (id) {
              // No queue item and no matching probe request — stale event.
              addLog(`Ignored stale engine error for ${id}`, "warn");
            } else {
              // P2-24: background engine failures (no id) get a toast too —
              // the grey strip alone is far too easy to miss.
              addToast(`Engine error: ${errMsg}`, "error");
              setStatusMessage("Engine error.");
            }
            return;
          }
          case "engine_crashed": {
            addLog("Engine crashed — waiting for automatic restart…", "warn");
            return;
          }
          case "engine_ready": {
            // The synthetic on-connect snapshot carries only `ready`; the real
            // bus event carries tool availability. Only log when tools exist.
            if (
              payload.ffmpeg !== undefined ||
              payload.ffprobe !== undefined ||
              payload.deno !== undefined ||
              payload.yt_dlp !== undefined ||
              payload.mutagen !== undefined
            ) {
              const ff = payload.ffmpeg ? "yes" : "no";
              const fp = payload.ffprobe ? "yes" : "no";
              const dn = payload.deno ? "yes" : "no";
              const yd = payload.yt_dlp ? "yes" : "no";
              const mt = payload.mutagen ? "yes" : "no";
              addLog(`Engine ready — ffmpeg=${ff} ffprobe=${fp} deno=${dn} yt-dlp=${yd} mutagen=${mt}`);
            }
            return;
          }
          case "engine_log": {
            addLog(`Engine: ${String(payload.message ?? "")}`);
            return;
          }
          case "fatal_error": {
            addLog(`Fatal engine error: ${String(payload.error ?? "")}`);
            return;
          }
          default: {
            addLog(`Engine event: ${String(payload.type ?? "unknown")}`);
          }
        }
      });

      if (cancelled) {
        unlistenEngineLocal();
        return;
      }
      unlistenEngine = unlistenEngineLocal;

      // ── WS reconnect reconciliation ────────────────────────────────────────
      // A dropped WebSocket can swallow a download's terminal event
      // (result/error/cancelled), leaving the item stuck "downloading" with a
      // dead progress bar forever. On reconnect, ask the server which jobs are
      // still active; any local "downloading" item not in that list is marked
      // failed with an honest "status unknown" message — we never guess
      // "completed", since the file may or may not exist.
      const unlistenReconnectLocal = onReconnect(async () => {
        if (reconcileInFlight.current) return;
        const stale = useDownloadStore
          .getState()
          .queue.filter((qi) => qi.status === "downloading");
        if (stale.length === 0) return;

        reconcileInFlight.current = true;
        try {
          let activeIds: string[] | null = null;
          try {
            const jobs = await invoke<{ id: string; status: string }[]>(
              "get_active_jobs"
            );
            activeIds = (jobs ?? []).map((j) => String(j.id));
          } catch {
            // P2-23: the endpoint itself failed transiently — leave the
            // in-flight items ALONE and rely on the next progress event or a
            // later reconnect. The old code fell through with an empty list,
            // false-failing every downloading item on a server blip.
            return;
          }

          for (const item of stale) {
            if (!activeIds.includes(item.id)) {
              updateQueueItem(item.id, {
                status: "failed",
                message: "Connection lost — download status unknown",
              });
              addLog(
                `Connection lost during download: ${item.id} — status unknown. Check history or retry.`,
                "warn"
              );
            }
          }
        } finally {
          reconcileInFlight.current = false;
        }
      });
      if (cancelled) {
        unlistenReconnectLocal();
        return;
      }
      unlistenReconnect = unlistenReconnectLocal;
    })();

    return () => {
      cancelled = true;
      unlistenEngine?.();
      unlistenReconnect?.();
      unlistenConnection?.();
    };
  }, [addHistoryItem, addLog, addToast, setBotBreaker, setCookieState, setEngineStatus, setMetadataResult, setProbeInfo, setStatusMessage, setWsConnected, updateQueueItem]);

  // ── Stability polling: cookie-auth + bot-check breaker ─────────────────────
  // engine_ready carries cookie state, but the circuit breaker only ever
  // appears in jobs replies (surfaced by /api/status) — there is no WS event
  // for it. Poll lightly so the header can show a live cooldown countdown and
  // the "no cookies configured" warning without inventing a new engine event.
  // Failures are silent: the last known state stays on screen.
  useEffect(() => {
    let cancelled = false;
    let inFlight = false;

    async function refresh() {
      // Never stack polls — a slow server must not build a fetch backlog.
      if (inFlight) return;
      inFlight = true;
      try {
        const status = await invoke<Record<string, unknown>>("get_status");
        if (cancelled || !status || typeof status !== "object") return;

        // Cookie state: present-but-null means "engine down/legacy" → clear;
        // absent means an older server that predates the field → keep last.
        if ("cookies" in status) {
          const cookies = status.cookies as Record<string, unknown> | null;
          setCookieState(
            cookies && typeof cookies === "object"
              ? {
                  configured: Boolean(cookies.configured),
                  source: String(cookies.source ?? "none"),
                }
              : null
          );
        }

        // Circuit breaker: explicit null (legacy/down) closes the indicator;
        // a fresh object updates the countdown anchor via setBotBreaker.
        // Numeric fields are guarded with Number.isFinite — a malformed
        // payload would otherwise inject NaN into the header countdown
        // (Math.max(0, NaN) === NaN renders as "Bot-check NaNs").
        if ("bot_breaker" in status) {
          const bb = status.bot_breaker as Record<string, unknown> | null;
          const failures = Number(bb?.consecutive_failures ?? 0);
          const cooldown = Number(bb?.cooldown_seconds ?? 0);
          setBotBreaker(
            bb && typeof bb === "object"
              ? {
                  open: Boolean(bb.open),
                  consecutive_failures: Number.isFinite(failures) ? failures : 0,
                  cooldown_seconds: Number.isFinite(cooldown) ? cooldown : 0,
                }
              : null
          );
        }
      } catch {
        // Status unreachable (server restarting / network blip) — keep the
        // last known state; the next tick retries.
      } finally {
        inFlight = false;
      }
    }

    void refresh();
    const iv = setInterval(() => void refresh(), 15_000);
    // Browsers throttle timers in background tabs (Chrome clamps to ~1/min
    // after 5 min hidden), so the breaker anchor goes stale while the tab is
    // in the background and the countdown would read 0 / wrong on return.
    // Re-poll the moment the tab becomes visible again.
    const onVisibility = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      clearInterval(iv);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [setCookieState, setBotBreaker]);
}
