# YTDL Flow — Roadmap

> Status definitions: **Completed** = shipped and verified. **In Progress** =
> actively being worked on. **Planned** = committed next work (documented,
> evidence-based). **Ideas** = raised but not committed — no obligation to build.

## Completed

- Three-tier architecture: React 19 SPA · Node/Express server · Python yt-dlp
  engine over NDJSON IPC.
- Audio (MP3, Opus, M4A/AAC, WAV) and video (MP4, WebM, MKV) downloads with
  quality presets and metadata/cover-art embedding.
- Queue with bounded worker pool (5), cancel/retry, live WebSocket progress and
  logs, engine diagnostics panel.
- Format verification (`verify_format`, Matroska-aware) with honest `warnings`
  carried on the NDJSON wire.
- Defense-in-depth localhost security: host validation, WS origin checks, URL
  allowlisting, rate limiting, strict CSP, IPv6 loopback coverage.
- Server-persisted download history (atomic JSON writes) surviving restarts;
  job restore on UI mount.
- Duplicate-title collision retry (id-suffixed filename) preventing silent
  data loss.
- Trim support (`trim_start`/`trim_end`) wired end-to-end through validation →
  server → engine.
- Four audit rounds of P0/P1/P2 fixes with regression tests (see
  `docs/codebase/CONCERNS.md`); CI with 4 green jobs (frontend, backend,
  Python engine, smoke).
- Brand icon integration: authoritative **animated vector SVG logo**
  (`references/branding/ytdl-flow-logo.svg`, ADR-011) with a tile-only
  derivative under `public/branding/` wired into the app header badge,
  empty-state badge, favicon, and `apple-touch-icon`; UI iconography
  standardized on `lucide-react` (ADR-010).
- Planning/execution of `plans/001`–`plans/006` (CI frontend tests,
  non-destructive smoke tests, URL-regex parity, release archive excludes,
  ESLint, WS reconnect reconciliation).
- Product identity rename to **YTDL Flow** on user-facing surfaces
  (README, UI header, placeholder page, server banner, page title); logo
  reference established under `references/branding/`.

## In Progress

- Nothing currently active.

## Planned

All items below are documented, evidence-based gaps from
`docs/codebase/CONCERNS.md` (Round 3/4 sections) — small, low-severity:

- **N-04** — re-run `restoreActiveJobs()` on the first `engine_ready` after
  mount (closes the mount-time `requestJobs` race).
- **N-06** — ffprobe discovery via `FFMPEG_PATH` in `verify_format` for
  `FFMPEG_PATH`-only setups.
- **N-07** — extend the client result guard beyond `cancelled`.
- **N-08** — reject `trim_start` without `trim_end` with a 400 instead of
  silently ignoring it.
- **N-09** — probe watchdog/deadline race polish.
- **N-10** — automated CSP header test in CI.
- **N-11** — include `thumbnail` in server-persisted history records.

## Ideas (not committed)

- One automatic retry on transient `NetworkError: getaddrinfo` in the engine
  probe (observed once in live testing; UI Retry already covers it manually).
- CI status badge in README.
- Raster (PNG) favicon/touch-icon exports generated from the SVG at build
  time, for browsers that lack SVG favicon support (see `docs/branding.md`).
- Broader UX polish surfaced by future audits.

## Maintenance rules

- Move items between sections as reality changes; cite evidence
  (commit, plan, or `docs/codebase/CONCERNS.md` finding).
- Never promote an Idea to Planned without an explicit commitment.
