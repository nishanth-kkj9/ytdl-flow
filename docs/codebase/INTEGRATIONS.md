# INTEGRATIONS

Evidence: `python-engine/engine.py`, `python-engine/ipc_main.py`, `web/routes/*`, `web/middleware/security.mjs`, `web/config.mjs`, `.env.example`, `src/api/transport.ts`.

| Integration | Direction | Notes |
|---|---|---|
| yt-dlp (`==2026.8.19`) | Engine → YouTube | Probe/extract/download; multi-client (iOS/Android/web) + pacing (`sleep_interval` 5 s) vs bot-check |
| FFmpeg / ffprobe | Engine → local binary | Transcode/trim/verify; PATH or `FFMPEG_PATH`/`FFMPEG_HOME`; readiness flags to UI; N-06 gap: `verify_format` misses ffprobe in `FFMPEG_PATH`-only setups |
| mutagen (`==1.48.1`) | Engine → file tags | ID3 (MP3), Vorbis (Opus), `covr` (M4A/MP4), WAV fallback via ffprobe |
| Deno (optional) | Engine → local binary | yt-dlp JS runtime for age-restricted; auto-detected, feature-detect only |
| YouTube CDN thumbnails | Engine/UI → `*.ytimg.com`, `*.googleusercontent.com`, `*.googlevideo.com`, `*.youtube.com` | SSRF-allowlisted server + client |
| WebSocket `ws` | Server → browser one-way | Loopback origin policy; no inbound commands |
| GitHub Actions | CI + Release | SHA-pinned actions; `npm/pip audit … \|\| true` non-blocking (deliberate) |
| Dependabot | npm + pip PRs | Weekly, no auto-merge |

## Credentials / config

Zero-dep `.env` loader (`web/config.mjs` reads `web/.env` then root `.env`; `process.env` always wins). Keys: `PORT`, `HOST` (default `127.0.0.1`), `YTDL_DATA_DIR`, `PYTHON`, `ENGINE_MAX_PENDING`, `FFMPEG_PATH`/`FFMPEG_HOME`, `DENO_PATH`, `YTDL_COOKIES_FILE`/`YTDL_COOKIES_BROWSER` (throwaway-account cookies for bot-check), `YTDL_SMOKE_ALLOW_CLEAR`, `YTDL_INTEGRATION`, `YTDL_TEST_URL`. Strict `envInt()` rejects garbage PORT/pending values with loud fallback. No secrets manager (single-user localhost).

## Databases

None. History = `web/data/history.json` (100-record cap, atomic temp+rename, corrupt-file backup `history.json.corrupt-<ts>`). No query engine, no multi-user writes.

## Gateway / proxy

None. Vite dev proxy (`/api`, `/downloads`, `/ws` → backend, PORT-aware) is dev-only. No service mesh, API gateway, versioning.

## Observability

No APM/Prometheus. Rotating file logs + live WS `engine_log` panel + `GET /api/status` (tools/jobs/versions/uptime) + `GET /api/health` (`{ok, engineReady}`).

## Queues / buses

No external MQ. In-process only: Python `ThreadPoolExecutor`, Node bounded pool + capped pending backlog, internal `EventBus` pub/sub.

## Known limitation → [ASK USER]

Localhost-only by design. LAN/cloud exposure needs deliberate `allowedHostsFor`/`allowedOriginsFor` work and is not supported. Confirm before any remote-access feature.
