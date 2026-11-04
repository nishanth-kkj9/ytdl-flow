# TESTING

Evidence: `package.json` scripts, `web/package.json`, `vite.config.ts` test block, `src/test/setup.ts`, `.github/workflows/ci.yml`, `test-smoke.mjs`, `web/tests/` (14 files), `python-engine/tests/` (6 files).

## Layers & commands (all verified 2026-10-11)

| Layer | Command | Framework | Location | Count |
|---|---|---|---|---|
| Frontend unit | `npm test` (root) | Vitest 3 + jsdom + Testing Library | `src/**/*.test.{ts,tsx}` | 11 files, 73 tests passed |
| Backend unit | `node --test tests/*.test.mjs` (in `web/`) | `node:test` + `node:assert`, real Express + `http.request` | `web/tests/` | 14 suites |
| Python unit | `python -m pytest tests -v` (in `python-engine/`) | pytest 8.x (`<9.0` pin) | `python-engine/tests/` | 79 collected |
| Smoke/integration | `node test-smoke.mjs` (server running) | `node:assert` + fetch + WS listener | repo root | health/status/history/probe-400/Host-421/CSP + optional live probe |
| Lint/types/build | `npm run lint`, `npx tsc --noEmit`, `npm run build` | ESLint 10 / tsc strict / Vite 6 | — | CI-gated |

## Mocking strategy

- Frontend: `vi.mock` on `src/api/transport`; capture WS `engine-event` handler, emit synthetic messages (`downloadStore.test.ts`, `useEngineEvents.test.ts`); `src/test/setup.ts` stubs `matchMedia`, `crypto.randomUUID`, `fetch`.
- Backend: inline fakes (`makeEngine()` with `sent` array for routes; temp-dir reconstructions for `historyService`); real HTTP against ephemeral ports.
- Python: `unittest.mock.patch("yt_dlp.YoutubeDL")` / `monkeypatch` on instance methods; NDJSON wire assertions (e.g. `test_write_result_carries_warnings_on_the_wire`).

## Smoke test

Health, status/tools, history load, probe validation 400, Host-rebinding 421, CSP header (no bracketed IPv6, loopback ws sources), optional history-clear. Destructive clear only with `YTDL_DATA_DIR` isolation or `YTDL_SMOKE_ALLOW_CLEAR=1`. Live YouTube probe/download only with `YTDL_INTEGRATION=1` (+ `YTDL_TEST_URL` override).

## CI wiring (`ci.yml`)

frontend: `npm ci → test → lint → tsc → audit(||true) → build → upload dist`. backend: `npm ci → node --check` (server/config/eventBus/validate/routes/services/middleware) → `node --test tests/*.test.mjs` (glob, auto-picks new files) → audit. python: lock install → dev+pip-audit install → audit → `py_compile` → import check → pytest. smoke: scratch `YTDL_DATA_DIR`, backend install, download dist, start server + health-poll loop, `test-smoke.mjs`. Node 24, Python 3.11, `PYTHON=python3` on runners.

## Coverage

No enforced threshold (no `coverageThresholds`, no `.nycrc`). Gaps: backend has no automated `server.mjs` e2e error-middleware test beyond live smoke (static/history routes covered); frontend suite broad (store/hook/transport/urlRegex/utils/6 component files incl. LogPanel).
