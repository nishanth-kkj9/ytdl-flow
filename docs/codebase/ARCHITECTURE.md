# ARCHITECTURE

Evidence: `web/server.mjs`, `web/services/engineManager.mjs`, `web/eventBus.mjs`, `web/routes/*.mjs`, `python-engine/ipc_main.py`, `python-engine/engine.py`, `src/api/transport.ts`, `src/hooks/useEngineEvents.ts`, `src/stores/downloadStore.ts`, `docs/architecture.md`.

## Organization: layered three-tier

Strict layers, not feature folders. Browser never touches Python or YouTube; Node owns authority (validation/security/queue/history/lifecycle); Python owns media work.

```
Browser SPA → REST /api/* + one-way WS /ws → Express → NDJSON stdio → Python → yt-dlp/FFmpeg/mutagen
```

## Primary data flows

Probe: `UrlInput → store (register client id) → POST /api/probe → validate → EngineManager.sendCommand → NDJSON → ipc_main (60 s absolute deadline from acceptance) → engine.probe (15s socket, 3 retries, capped by deadline) → probe_result → EventBus → WS → useEngineEvents (id match required; stale events ignored) → store.probeInFlight=false + MetadataPanel`. The browser watchdog (75 s, armed only after the REST ack) is owned by the request id, so a late result cannot overwrite a visible timeout. WinUI correlates the same id with a 90 s timeout.

Download: `POST /api/download (format/quality/trim) → route 400s (incl. half-open trim reject) → bounded pool (max 5) → NDJSON → ThreadPoolExecutor → yt-dlp fetch + FFmpeg + mutagen tag + verify_format → progress/download_retry/result+warnings → EventBus → WS → store queue/history; historyPersistence saves server-side (dedupe by id)`.

Reconnect/mount: `transport.onReconnect → GET /api/status (activeJobs) → restoreActiveJobs()` rebuilds queue; idempotent, cancelled-guarded.

## Singletons / init order

`server.mjs main()`: `historyService.init()` → `EventBus` → `EngineManager(bus)` → `attachHistoryPersistence` → express app + WS + routes. Single shared `bus`, `engine`, `historyService` per process. Frontend single `ws` connection + single Zustand store. No DI container; router factories take deps (`probeRouter(engine)`).

## Workers / queues / events

- Python: `ThreadPoolExecutor` (5 download, 2 probe workers); in-memory job map; NDJSON events (`engine_ready, probe_result, download_started, progress, download_retry, result+warnings, cancelled, error, fatal_error, engine_log`).
- Node: bounded worker pool (max 5 concurrent), pending-command backlog cap (`ENGINE_MAX_PENDING`, default 100), bounded auto-restart (`engineMaxRestarts=3`), `recover()` emits terminal `EngineRestarted` errors for discarded pendings.
- WS `ws` server broadcast only; every new event needs one `eventTypes` allowlist entry in `server.mjs`.

## Repeated patterns

Router factory (`export function xxxRouter(dep)`); EventBus pub/sub decoupling; command/job model (REST mutates, WS notifies); supervision (exit funnel clears `readyTools`, `windowsHide: true`); honest-result (warnings/verification carried end-to-end, ADR-007); reconciliation on reconnect/mount; atomic JSON writes (temp+rename) for history.
