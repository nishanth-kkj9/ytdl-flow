# YTDL Flow — Product Overview

## What YTDL Flow is

YTDL Flow is a **localhost-only application** for downloading YouTube audio
and video. It runs entirely on the user's machine: a React UI, a Node.js
(Express) server, and a Python engine driven by `yt-dlp`. It can be used as a
web app or hosted by a native Windows WinUI 3 desktop shell. Existing Electron
sources and packaging scripts are retained as a separate desktop path. No data
leaves the machine except requests to YouTube itself.

- **Repository:** `nishanth-kkj9/ytdl-flow`
- **Historical name:** previously published as "YTDL Modern"; internal
  identifiers (`ytdl_modern`) are technical names, not branding.

## Purpose

Give users precise control over what they download and how it is produced:
exact format/codec/quality selection, honest verification of the resulting
file, live progress, and persistent history — with security defaults safe
enough to run unattended on a laptop.

## Target users

- Individuals downloading audio/video for personal, offline use.
- Users who care about **exact output format** (codec, container, quality) and
  want the app to *prove* the result matches the request, not just claim it.
- Power users who drive the REST API programmatically alongside the web UI.

## Core media workflow

```
Media discovery
  → format selection
  → queue
  → download
  → processing
  → verification
  → history / status
```

1. **Media discovery (probe):** paste a YouTube URL; the app fetches metadata
   (title, duration, thumbnail, available streams) and guards the request with
   URL allowlisting and a probe watchdog.
2. **Format selection:** audio (MP3, Opus, M4A/AAC, WAV) or video (MP4, WebM,
   MKV) with quality presets; optional trim points (`trim_start`/`trim_end`).
3. **Queue:** jobs queue with a bounded worker pool (5 concurrent downloads),
   cancel/retry support, and live state transitions.
4. **Download:** yt-dlp fetches media using multi-client strategies
   (iOS/Android/web clients) for resilience against bot detection.
5. **Processing:** FFmpeg post-processing (extraction/transcode, trimming),
   metadata + cover-art embedding (title, artist, album, genre, thumbnail).
6. **Verification:** the engine verifies the output codec/container matches the
   selection (Matroska-aware `verify_format`) and reports honest `warnings` on
   the wire; failures produce actionable errors, including a documented
   "no FFmpeg found" state.
7. **History / status:** completed jobs land in persistent history (JSON file
   storage, atomic writes); live progress streams over WebSocket; the REST
   status API exposes the same state for programmatic consumers.

## Major capabilities (as implemented)

- Web UI at `http://127.0.0.1:3000`: probe → confirm → download → live logs →
  history drawer, plus an engine diagnostics panel.
- Native Windows desktop shell built with C# + WinUI 3 uses a native XAML
  presentation over the same backend contracts; it provides a native folder
  picker and persists desktop settings in the user's local app data. The
  desktop shell supervises the shared backend and keeps the backend
  authoritative for queueing, history, and Python engine coordination;
  FFmpeg/ffprobe remain external prerequisites.
- The WinUI shell starts the backend on a dynamic loopback endpoint, verifies
  health before use, displays distinct backend/engine/WebSocket states, and
  gracefully stops its owned backend process on exit. Probe metadata arrives
  asynchronously through the correlated `probe_result` WebSocket event.
- Native Download, Queue, and History pages use the existing REST and
  WebSocket contracts for format/quality/trim submission, live progress,
  cancellation, retry, reconnect recovery, and backend-persisted history.
  Cancellation is confirmed by an event rather than the REST acknowledgment;
  late results cannot change a cancelled row. Safe open/reveal actions are
  limited to existing files inside the configured download directory.
- Electron sources and packaging workflows remain in the repository and are
  not removed by the WinUI runtime work.
- REST API (`/api/*`) mirroring the UI's capabilities.
- WebSocket one-way broadcast for progress/log/status events.
- Server-persisted download history surviving restarts; job restoration on UI
  mount.
- Format verification with honest warnings; duplicate-title collision retry
  (id-suffixed filename) preventing silent data loss.
- Defense-in-depth localhost security: localhost binding, Host header
  validation, WebSocket origin checks, URL allowlisting, rate limiting, CSP.
- CI: frontend (Vitest/ESLint/tsc), backend (node:test), Python engine
  (pytest/pip-audit), smoke tests.

## Frontend / backend / engine relationship

The **React SPA** owns presentation and local optimistic state. The **Node
server** owns all authority: validation, security, queue, history, and the
engine process lifecycle. The **Python engine** owns media work: yt-dlp
extraction, FFmpeg processing, tagging, verification. Node and Python
communicate over a versioned NDJSON protocol on stdio; the browser talks to
Node only — never to Python or YouTube directly.

## Product direction

- **CURRENT:** everything listed above as implemented.
- **PLANNED:** small documented gaps tracked in `docs/codebase/CONCERNS.md`
  (mount-time job-restore race, ffprobe discovery under `FFMPEG_PATH`-only
  setups, automated CSP header test, server-persisted history thumbnails,
  trim-start-without-trim-end validation, probe watchdog race, remaining low-
  severity polish). See `docs/roadmap.md`.
- **FUTURE:** ideas raised but not committed (engine probe DNS retry,
  README CI badge, further UX polish) — non-binding, listed in
  `docs/roadmap.md` under Ideas.

The native workflow is implemented, but a packaged installer and clean-machine
install have not yet been verified locally. Only features actually implemented
are described as current; anything else in this file is explicitly labeled
planned or future.
