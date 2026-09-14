<div align="center">

<img src="references/branding/ytdl-flow-logo.svg" alt="YTDL Flow logo" width="340" />

# YTDL Flow

**A modern, locally-hosted YouTube audio/video downloader with a beautiful web UI.** Built with React, Node.js, Express, and yt-dlp.

[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-blue?logo=typescript)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React-19-blue?logo=react)](https://react.dev/)
[![Node.js](https://img.shields.io/badge/Node.js-18+-green?logo=node.js)](https://nodejs.org/)
[![Python](https://img.shields.io/badge/Python-3.9+-blue?logo=python)](https://www.python.org/)
[![License](https://img.shields.io/badge/License-MIT-green)](LICENSE)
[![GitHub Issues](https://img.shields.io/github/issues/nishanth-kkj9/ytdl-flow)](https://github.com/nishanth-kkj9/ytdl-flow/issues)

*Media discovery → format selection → queue → download → processing → verification → history/status*

</div>

---

## Table of Contents

- [Quick Overview](#quick-overview)
- [Features](#features)
- [Technology Stack](#technology-stack)
- [System Architecture](#system-architecture)
- [Installation](#installation)
- [Getting Started](#getting-started)
- [API Reference](#api-reference)
- [Project Structure](#project-structure)
- [Security Considerations](#security-considerations)
- [Deployment & CI/CD](#deployment--cicd)
- [Troubleshooting](#troubleshooting)
- [Documentation](#documentation)
- [Contributing](#contributing)
- [License](#license)

---

## Quick Overview

YTDL Flow is a **localhost-only** YouTube downloader that runs entirely on your machine. It provides:

- **Web UI** at `http://127.0.0.1:3000` for probing, downloading, and managing history
- **REST API** for programmatic access
- **WebSocket** for real-time progress and status updates
- **Concurrent downloads** (up to 5 workers) with full queue management
- **Automatic metadata embedding** (title, artist, cover art, etc.)
- **Format verification** to ensure output codec matches your selection
- **Multi-client bot detection bypass** using iOS, Android, and web YouTube clients

### Key Design Principles

- **Security-first:** Binds to localhost only; enforces Host header validation and URL allowlisting
- **Modular architecture:** Frontend (React), backend (Express), and engine (Python) communicate over well-defined contracts (REST, WebSocket, NDJSON)
- **Production-grade:** Comprehensive test coverage, CI/CD via GitHub Actions, type-safe code (TypeScript + Python type hints)
- **Operator-friendly:** Detailed logging, status API, live engine diagnostics panel

---

## Features

### Audio Downloads
- **Formats:** MP3, Opus, M4A/AAC, WAV
- **Quality presets:** Maximum, High, Medium, Low
- **Metadata:** Embeds title, artist, album, release date, genre, and cover art

### Video Downloads
- **Formats:** MP4, WebM, MKV
- **Resolutions:** 4K (2160p), 1080p, 720p, 480p, 360p, plus quality presets (Maximum, Best, High, Medium, Low)
- **Metadata:** Embeds title and description

### Advanced Features
- **Probe:** Fetch metadata (title, uploader, duration, thumbnail, available formats) before downloading
- **Trim:** Optional start/end trim (seconds or `HH:MM:SS` / `MM:SS` format) via FFmpeg
- **Format verification:** Post-download readback confirms codec and stream info
- **Cover art:** Fetches and embeds highest-resolution YouTube thumbnail automatically
- **Download queue:** Multiple concurrent downloads with cancel and retry capabilities
- **Live progress:** Real-time speed, ETA, animated waveform visualizations
- **Download history:** Persistent log (capped at 100 records) with file open/reveal
- **Bot detection bypass:** Uses multiple YouTube player clients for reliable extraction
- **Engine diagnostics:** Live event panel showing real-time debug logs and warnings

---

## Technology Stack

| Layer | Technology |
|-------|------------|
| **Frontend** | React 19, TypeScript 5.6, Zustand, Tailwind CSS v4, Vite 6 |
| **Backend** | Node.js 18+, Express 5.2, WebSocket (`ws` library) |
| **Engine** | Python 3.9+, yt-dlp, mutagen, FFmpeg |
| **Optional** | Deno (JS runtime for yt-dlp's age-restricted video extraction) |
| **Testing** | Vitest (frontend), node:test (backend), pytest (Python engine) |
| **CI/CD** | GitHub Actions (lint, type-check, test, smoke tests, release builds) |

---

## System Architecture

```
┌─────────────────┐
│   Browser UI    │ (React 19 + Zustand + Tailwind)
│   localhost:3000│
└────────┬────────┘
         │ HTTP + WebSocket
         ▼
┌─────────────────────────────────────────┐
│      Node.js / Express (port 3000)      │
├─────────────────────────────────────────┤
│  • URL validation & sanitization        │
│  • REST routes (probe, download, etc.)  │
│  • WebSocket event broadcast            │
│  • EngineManager (process orchestration)│
├─────────────────────────────────────────┤
│  NDJSON stdin/stdout IPC                │
└────────────┬────────────────────────────┘
             │
             ▼
┌──────────────────────────────────────────┐
│  Python Engine (ipc_main.py)             │
├──────────────────────────────────────────┤
│  • ThreadPoolExecutor (5 download workers)
│  • AudioDownloadEngine (engine.py)       │
│    - yt-dlp for format extraction       │
│    - mutagen for metadata embedding     │
│    - FFmpeg for audio/video processing  │
│  • Retry logic & error handling         │
│  • File logging with rotation           │
└──────────────────────────────────────────┘
```

**Data Flow:**
1. User submits URL via web UI
2. REST POST to `/api/probe` returns a request ID
3. Engine processes asynchronously; WebSocket broadcasts metadata and progress events
4. Frontend updates UI in real-time using Zustand store
5. History persisted to JSON file on successful completion

---

## Installation

### Prerequisites

- **Node.js** 18+ ([install](https://nodejs.org/))
- **Python** 3.9+ ([install](https://www.python.org/))
- **FFmpeg** — must be on your `PATH`, or set `FFMPEG_PATH` / `FFMPEG_HOME` environment variable
  - macOS: `brew install ffmpeg`
  - Ubuntu/Debian: `sudo apt-get install ffmpeg`
  - Windows: Download from [ffmpeg.org](https://ffmpeg.org/download.html) or `choco install ffmpeg`
- **Deno** (optional) — for yt-dlp's JS runtime, used for age-restricted videos
  - Install from [deno.land](https://deno.land/)

### Step 1: Clone the Repository

```bash
git clone https://github.com/nishanth-kkj9/ytdl-flow.git
cd ytdl-flow
```

### Step 2: Install Frontend Dependencies

```bash
npm install
```

### Step 3: Install Backend Dependencies

```bash
cd web && npm install && cd ..
```

### Step 4: Install Python Engine Dependencies

**Recommended:** Use a virtual environment to keep dependencies isolated:

```bash
python -m venv venv
# On Windows: venv\Scripts\activate
# On macOS/Linux: source venv/bin/activate
pip install -r python-engine/requirements.lock
```

Or install from unpinned ranges (allows patch updates):

```bash
pip install -r python-engine/requirements.txt
```

### Step 5: (Optional) Copy Environment Config

```bash
cp .env.example .env
```

See `.env.example` for available configuration options (e.g., custom port, data directory, log level).

---

## Getting Started

### Production Mode

```bash
# Build frontend + start server
npm run build && npm run server
```

Visit **http://127.0.0.1:3000** in your browser.

### Development Mode

**Terminal 1 — Backend with auto-restart:**
```bash
cd web && npm run dev
```

**Terminal 2 — Frontend with hot module replacement:**
```bash
npm run dev
```

Then visit **http://127.0.0.1:5173** (Vite dev server).

The Vite dev server automatically proxies `/api`, `/downloads`, and `/ws` to the backend on port 3000.

### Running Tests

```bash
# Frontend (Vitest)
npm test

# Frontend with watch mode
npm run test:watch

# Frontend lint + type-check
npm run lint
npx tsc --noEmit

# Backend (node:test)
cd web && npm test

# Python engine (pytest)
cd python-engine && python -m pytest tests -v

# Integration smoke tests (server must be running)
npm run test:smoke
```

---

## API Reference

All endpoints are **localhost-only** (`127.0.0.1:3000`).

### Health & Status

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/health` | Server liveness check; returns `{ "ok": true }` |
| `GET` | `/api/status` | Engine readiness, tool availability, active jobs, versions, uptime |

### Probe

**Fetch video metadata before downloading.**

```bash
curl -X POST http://127.0.0.1:3000/api/probe \
  -H "Content-Type: application/json" \
  -d '{"url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"}'
```

**Response:** `{ "id": "uuid-string" }`

Actual result arrives asynchronously over WebSocket as `probe_result` event.

### Download

**Start a download job.**

```bash
curl -X POST http://127.0.0.1:3000/api/download \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "mode": "audio",
    "format": "mp3",
    "quality": "high"
  }'
```

**Response:** `{ "id": "download-id", ... }`

Progress and result events arrive over WebSocket.

#### Parameters

| Field | Required | Default | Options |
|-------|----------|---------|---------|
| `url` | Yes | — | Any YouTube URL (see Accepted URLs below) |
| `mode` | No | `"audio"` | `"audio"`, `"video"` |
| `format` | No | `"mp3"` | Audio: `mp3`, `opus`, `m4a`, `aac`, `wav` · Video: `mp4`, `webm`, `mkv` |
| `quality` | No | `"high"` | Audio: `maximum`, `high`, `medium`, `low` · Video: `2160p`, `1080p`, `720p`, `480p`, `360p`, `high`, `medium`, `low` |
| `id` | No | auto | Client-side tracking ID |
| `trim_start` / `trim_end` | No | — | Trim window in seconds or `HH:MM:SS` / `MM:SS`; requires FFmpeg |

#### Optional Metadata Fields

You can pass additional metadata to override YouTube's data:

```json
{
  "url": "...",
  "title": "Custom Title",
  "uploader": "Custom Artist",
  "thumbnail": "https://...",
  "duration": 180,
  "webpage_url": "..."
}
```

#### Accepted URLs

- `youtube.com/watch?v=...`
- `youtu.be/...`
- `youtube.com/shorts/...`
- `youtube.com/embed/...`
- `youtube.com/v/...`
- `youtube.com/live/...`
- `music.youtube.com/watch?v=...`
- `m.youtube.com/...` (mobile subdomain)

### Cancel Download

```bash
curl -X POST http://127.0.0.1:3000/api/download/cancel \
  -H "Content-Type: application/json" \
  -d '{"id": "download-id"}'
```

### History

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/history?limit=100&offset=0` | List download history (max 200 per page) |
| `POST` | `/api/history` | Save a history record (auto-called on success) |
| `DELETE` | `/api/history` | Clear all history records |

### WebSocket Events

Connect to `ws://127.0.0.1:3000/ws` for real-time server-to-client events.

| Event | Payload | Description |
|-------|---------|-------------|
| `engine_ready` | `{ protocol_version, ffmpeg, ffprobe, deno, yt_dlp, mutagen }` | Engine started; tool availability |
| `probe_result` | `{ id, success, info }` | Probe completed with metadata |
| `download_started` | `{ id, url, fmt, quality }` | Download acknowledged |
| `progress` | `{ id, status, downloaded, total, speed, eta }` | Real-time progress |
| `result` | `{ id, success, title, filepath, warnings }` | Download completed or failed |
| `cancelled` | `{ id }` | Download cancelled by user |
| `error` | `{ id, error_type, error }` | Per-request error |
| `fatal_error` | `{ error }` | Engine crashed (non-recoverable) |
| `engine_crashed` | `{ exit_code, signal }` | Engine process exited unexpectedly |
| `engine_log` | `{ message }` | Raw engine output (debug level) |

---

## Project Structure

```
ytdl-flow/
├── src/                           # React frontend (TypeScript + Tailwind)
│   ├── components/                # Reusable UI components
│   ├── api/
│   │   └── transport.ts           # WebSocket + REST client
│   ├── hooks/
│   │   └── useEngineEvents.ts     # WebSocket event routing hook
│   ├── stores/
│   │   └── downloadStore.ts       # Zustand state management
│   ├── test/
│   │   └── setup.ts               # Vitest configuration
│   ├── App.tsx                    # Root component
│   ├── main.tsx                   # Entry point
│   ├── types.ts                   # Shared TypeScript types
│   ├── utils.ts                   # Helper functions
│   ├── styles.css                 # Tailwind global styles
│   └── *.test.ts                  # Unit tests
│
├── web/                           # Node.js / Express backend
│   ├── middleware/                # Express middleware (auth, logging, CORS, etc.)
│   ├── routes/                    # REST endpoint handlers
│   ├── services/
│   │   ├── EngineManager.mjs      # Manages Python engine lifecycle
│   │   ├── HistoryService.mjs     # Persists/loads download history
│   │   └── ...
│   ├── eventBus.mjs               # Internal event emitter
│   ├── server.mjs                 # Express + WebSocket bootstrap
│   ├── config.mjs                 # Environment & config loader
│   ├── validate.mjs               # Request validation schemas
│   ├── tests/
│   │   └── *.test.mjs             # Unit & integration tests
│   └── package.json
│
├── python-engine/                 # Python download engine
│   ├── engine.py                  # AudioDownloadEngine class (~1500 LOC)
│   │                              # - Handles probe, download, metadata, FFmpeg
│   ├── ipc_main.py                # NDJSON IPC command dispatcher
│   ├── logger.py                  # File logging with rotation
│   ├── helpers.py                 # Sanitization, format utilities
│   ├── tests/
│   │   └── test_*.py              # pytest test suite
│   ├── requirements.lock          # Pinned + hash-locked deps (production)
│   ├── requirements.txt           # Unpinned ranges (development)
│   └── requirements-dev.txt       # Dev extras (pytest, etc.)
│
├── .github/
│   └── workflows/
│       ├── ci.yml                 # Lint, type-check, test, smoke tests
│       └── release.yml            # Build & publish release archives
│
├── scripts/
│   ├── dev-all.mjs                # Orchestrate frontend + backend together
│   └── ...
│
├── test-smoke.mjs                 # Integration smoke tests
├── eslint.config.js               # ESLint configuration
├── tsconfig.json                  # TypeScript configuration
├── vite.config.ts                 # Vite build configuration
├── postcss.config.js              # PostCSS (Tailwind) config
├── tailwind.config.js             # Tailwind configuration
├── package.json                   # Root package (frontend)
├── .env.example                   # Environment template
├── README.md                       # This file
├── CONTRIBUTING.md                # Contribution guidelines
└── LICENSE                        # MIT License
```

---

## Security Considerations

YTDL Flow implements **defense-in-depth** security controls:

| Control | Implementation | Rationale |
|---------|---------------|-----------|
| **Localhost binding** | Binds to `127.0.0.1` only (not `0.0.0.0`) | Prevents LAN/Internet exposure |
| **Host header validation** | Rejects requests with invalid `Host` header | Blocks DNS rebinding attacks |
| **URL allowlist** | Only `youtube.com` and `youtu.be` domains | Prevents arbitrary URL downloads |
| **Path containment** | Resolves symlinks; verifies output path stays within `downloads/` | Prevents directory traversal |
| **SSRF protection** | Restricts thumbnail and video URLs to YouTube CDN | Prevents SSRF attacks |
| **TLS verification** | Certificate verification never disabled | Prevents man-in-the-middle attacks |
| **Bounded concurrency** | Max 5 simultaneous downloads | Prevents resource exhaustion |
| **Input validation** | Title (500 chars), uploader (256), URL (500) limits enforced | Prevents buffer overflows |
| **JSON body limit** | Express request body capped at 1 MB | Prevents DoS attacks |
| **Filename sanitization** | Removes Windows reserved names (CON, PRN, AUX, etc.) | Prevents Windows filesystem issues |

---

## Deployment & CI/CD

### GitHub Actions Workflows

#### `ci.yml` (Runs on push/PR to main)

1. **Frontend** — Install → Type-check (`tsc --noEmit`) → Production build
2. **Backend** — Install → Syntax check all `.mjs` files
3. **Python Engine** — Install from lock file → Compile check → Import verification → pytest
4. **Smoke Tests** — Start server → Run integration tests (health, probe, download, history, DNS rebinding)

#### `release.yml` (Runs on `v*` tags)

1. Build frontend to `dist/`
2. Create release archives (tar.gz + zip)
3. Publish GitHub Release with attachments

### Environment Variables

See `.env.example` for all available options:

```bash
# Port (default: 3000)
PORT=3000

# Data directory (default: ./downloads)
YTDL_DATA_DIR=./downloads

# Log level (default: info)
LOG_LEVEL=info

# FFmpeg paths (optional; auto-detected if on PATH)
FFMPEG_PATH=/path/to/ffmpeg
FFMPEG_HOME=/path/to/ffmpeg/home
```

---

## Troubleshooting

### FFmpeg Not Found

**Symptom:** Engine shows `ffmpeg=no` in status; format verification fails.

**Solution:**
1. Ensure FFmpeg is installed and on your `PATH`: `ffmpeg -version`
2. Set `FFMPEG_PATH` or `FFMPEG_HOME` in `.env` if not on PATH
3. Restart the server

### Engine Crashes on Startup

**Symptom:** Server logs show immediate crash.

**Solution:**
1. Check `logs/ytdl_pro_*.log` (Python file logger with daily rotation)
2. Check the `web` server console output
3. Use the "Restart engine" button in the live log panel (advanced diagnostics)

### Python Dependency Conflicts

**Symptom:** `ImportError` or version mismatches in engine logs.

**Solution:**
1. Create a fresh virtual environment:
   ```bash
   rm -rf venv
   python -m venv venv
   source venv/bin/activate  # or: venv\Scripts\activate on Windows
   ```
2. Install from the pinned lock file:
   ```bash
   pip install -r python-engine/requirements.lock
   ```
3. Restart the server

### Port 3000 Already in Use

**Symptom:** `EADDRINUSE: address already in use :::3000`

**Solution:**
```bash
# Set PORT before starting
export PORT=3100  # or: $env:PORT=3100 on Windows
npm run server
```

Then visit `http://127.0.0.1:3100`.

### Stale UI After Rebuild

**Symptom:** Changes not reflected in the browser.

**Solution:**
1. Run `npm run build` to rebuild the frontend
2. Restart the server: `npm run server`
3. Hard-refresh your browser: `Ctrl+Shift+R` (or `Cmd+Shift+R` on macOS)

### Download Fails with Format Error

**Symptom:** Download succeeds but format verification fails.

**Solution:**
1. Check engine logs in the live log panel
2. Verify FFmpeg is installed and working: `ffprobe -version`
3. Try a different quality/format preset
4. Open an issue with the download URL and format selected

---

## Documentation

Beyond this README, the repository ships a documentation set maintained for
humans and coding agents alike:

| Document | Contents |
|----------|----------|
| [AGENTS.md](AGENTS.md) | Binding rules for coding agents (branding policy, reference hierarchy, verification gates) |
| [docs/product.md](docs/product.md) | What YTDL Flow is, target users, core media workflow, CURRENT/PLANNED/FUTURE direction |
| [docs/architecture.md](docs/architecture.md) | Canonical three-tier architecture overview with end-to-end flow diagrams |
| [docs/design-system.md](docs/design-system.md) | Verified design tokens (colors, typography, radii, motion) from `src/styles.css` |
| [docs/branding.md](docs/branding.md) | Official visual identity, logo rules and usage policy |
| [docs/roadmap.md](docs/roadmap.md) | Completed / In Progress / Planned / Ideas — evidence-based roadmap |
| [docs/decisions.md](docs/decisions.md) | ADR-style decision log (nine verifiable decisions) |
| [docs/codebase/](docs/codebase) | Deep technical reference: architecture, stack, structure, conventions, testing, integrations, concerns |
| [plans/](plans/README.md) | Numbered implementation plans (001–006) with execution records |
| [references/branding/](references/branding/README.md) | **The authoritative YTDL Flow logo** (vector SVG, source of truth) |

---

## Contributing

Thank you for your interest in contributing! Please read [CONTRIBUTING.md](CONTRIBUTING.md) for:

- Setup instructions
- Development workflow
- Testing guidelines
- Code style conventions
- Pull request process

**Quick start:**

```bash
git clone https://github.com/nishanth-kkj9/ytdl-flow.git
cd ytdl-flow
npm install && cd web && npm install && cd ..
python -m venv venv && source venv/bin/activate
pip install -r python-engine/requirements.lock
node scripts/dev-all.mjs  # Run everything together
```

---

## License

MIT License — see [LICENSE](LICENSE) for details.

By contributing, you agree that your contributions will be licensed under the same terms.

---

## Acknowledgments

- **yt-dlp** — Robust YouTube extraction with multi-client support
- **React 19** — Modern UI framework with concurrent rendering
- **Express 5** — Lightweight, modular web framework
- **FFmpeg** — Powerful audio/video processing
- **Tailwind CSS** — Utility-first styling
- **Zustand** — Minimalist state management

---

**Questions?** Open an [issue](https://github.com/nishanth-kkj9/ytdl-flow/issues) or [discussion](https://github.com/nishanth-kkj9/ytdl-flow/discussions).
