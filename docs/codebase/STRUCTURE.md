# STRUCTURE

Evidence: repo root listing, `src/`, `web/`, `python-engine/` listings, `package.json` scripts, `web/package.json` main, `vite.config.ts`, scan tree.

## Layout

```
ytdl-flow/
├─ src/                      # React 19 + TS SPA
│  ├─ api/transport.ts       # sole REST+WS client (invoke/listen/onReconnect)
│  ├─ components/            # UrlInput, ProbeCard, MetadataPanel, WaveformProgress,
│  │                         # DrawerPanel, LogPanel, ToastContainer, ConfirmDialog,
│  │                         # Layout, ModeToggle, SidebarItem, EmptyState, ErrorBoundary, urlRegex
│  ├─ hooks/useEngineEvents.ts  # WS event → store routing (+ terminal-result guard)
│  ├─ stores/downloadStore.ts   # Zustand queue/history/probe/logs
│  ├─ types.ts / utils.ts / styles.css / main.tsx / App.tsx
│  └─ *.test.{ts,tsx}        # colocated Vitest suites (11 files, 73 tests)
├─ web/                      # Node/Express backend, plain ESM .mjs
│  ├─ server.mjs             # entry: express + WS + engine spawn + CSP/Host guards
│  ├─ config.mjs             # .env loader, envInt(), allowedHostsFor/OriginsFor
│  ├─ validate.mjs           # YouTube URL allowlist + record sanitization
│  ├─ eventBus.mjs           # internal pub/sub
│  ├─ routes/                # probe, download (+cancel), history, status, restart
│  ├─ middleware/            # security (origin/rate-limit/wsVerify), static, requestLog
│  ├─ services/              # engineManager (child+NDJSON bridge), historyService,
│  │                         # historyPersistence (server-side save on result)
│  ├─ data/history.json      # gitignored runtime state
│  └─ tests/*.test.mjs       # 14 node:test suites
├─ python-engine/            # download engine
│  ├─ engine.py              # AudioDownloadEngine (~1943 lines)
│  ├─ ipc_main.py            # NDJSON stdio dispatch (probe/download/cancel/jobs)
│  ├─ helpers.py / logger.py # sanitize/format + rotating file log
│  └─ tests/                 # 6 pytest files, 79 tests collected
├─ scripts/dev-all.mjs       # Vite + backend orchestrator w/ port pre-flight
├─ test-smoke.mjs            # integration smoke (needs running server)
├─ docs/ / plans/ / references/ / public/branding/ / downloads/ / logs/ / dist/
```

## Entry points

- Frontend: `src/main.tsx` → `src/App.tsx` (Vite dev `:5173`, prod served from `dist/` by backend `:3000`).
- Backend: `web/server.mjs` (`main: server.mjs`; `npm run server` from root, `npm run dev` inside `web/`).
- Engine: `python-engine/ipc_main.py` (spawned by `EngineManager`, never run directly by users).

## Directory purposes

`src/components/` presentational + small behavior; `src/api/` transport only; `src/hooks/` WS subscription; `src/stores/` shared state; `web/routes/` one router factory per resource; `web/middleware/` cross-cutting HTTP/WS guards; `web/services/` process + persistence ownership; `python-engine/` all media work (extract/process/tag/verify).

## Non-obvious / hidden dirs

- `.github/workflows/` (ci.yml, release.yml), `.github/dependabot.yml`.
- `graphify-out/` knowledge-graph artefacts (gitignored, never source).
- `plans/001–006 + README.md` implementation records + conventions.
- `references/branding|architecture|ui|prompts/` design source-of-truth (SVG logo lives here).
- No `.vscode/`, `.husky/`; no `packages/`/`apps/` monorepo signals.

## Naming

kebab-case dirs (`python-engine/`); camelCase TS/JS files (`downloadStore.ts`, `engineManager.mjs`); PascalCase React components (`UrlInput.tsx`); snake_case Python (`ipc_main.py`, `test_round3_pins.py`); router factory files per resource (`probe.mjs`, `download.mjs`).
