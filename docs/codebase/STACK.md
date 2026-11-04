# STACK

Evidence: `package.json`, `web/package.json`, `python-engine/requirements.txt`, `python-engine/requirements.lock`, `python-engine/requirements-dev.txt`, `tsconfig.json`, `vite.config.ts`, `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `.nvmrc` [absent — no nvm pin]

## Primary languages

Polyglot three-tier, no single primary. Frontend TypeScript, backend JavaScript (ESM), engine Python.

| Tier | Language | Version |
|---|---|---|
| Frontend (`src/`) | TypeScript | `~5.6.2`, `strict: true` (`tsconfig.json`) |
| Backend (`web/`) | JavaScript ESM (`.mjs`, no TypeScript — deliberate, ADR-002) | Node `>=18` (`engines`); CI runs Node 24 |
| Engine (`python-engine/`) | Python | `>=3.9` declared; CI pins `3.11`; local env observed `3.14` |

## Package managers

- Frontend: `npm` (`package-lock.json`, lockfileVersion 3).
- Backend: `npm` separate module (`web/package-lock.json`).
- Engine: `pip` + `pip-compile --generate-hashes` (`requirements.txt` ranges → `requirements.lock` pinned+hashed).

## Core runtime frameworks

- Frontend: React `^19.2.8` + `react-dom`, Zustand `^5.0.14` (store), Tailwind CSS `^4.3.2` via `@tailwindcss/postcss` (CSS-first `@theme` in `src/styles.css`), Vite `^6.0.3` + `@vitejs/plugin-react`, fonts `@fontsource/sora` + `@fontsource/jetbrains-mono`, icons `lucide-react` `^1.45.0`.
- Backend: Express `^5.2.1`, `ws` `^8.18.0` (one-way server→client broadcast only).
- Engine: `yt-dlp==2026.8.19`, `mutagen==1.48.1` (both hash-pinned in `requirements.lock`); FFmpeg/ffprobe external binaries (PATH or `FFMPEG_PATH`/`FFMPEG_HOME`); Deno optional JS runtime (auto-detected, feature-detect only).

## dependencies vs devDependencies

Frontend (`package.json`): prod `dependencies` = react, react-dom, zustand, 2× fontsource, lucide-react. Everything else (vite, vitest, jsdom, testing-library, eslint, typescript, tailwind/postcss/autoprefixer) is `devDependencies`.
Backend (`web/package.json`): only prod deps are `express`, `ws`. No devDeps — tests use built-in `node:test` + `node:assert`.
Engine: runtime = `requirements.txt` (`yt-dlp`, `mutagen` ranges); test-only = `requirements-dev.txt` (`-r requirements.txt` + `pytest>=8.0,<9.0` deliberate `<9.0` pin per ADR-006).

## Docker

None. No `Dockerfile`, `compose`, K8s, Vagrant detected (scan confirms). Localhost-only runs directly on host.

## Key scripts

| File | Script | Command |
|---|---|---|
| root `package.json` | `dev` / `dev:all` | `vite` / `node scripts/dev-all.mjs` |
| root | `build` | `tsc && vite build` |
| root | `server` | `cd web && node server.mjs` |
| root | `lint` / `test` / `test:smoke` | `eslint src` / `vitest run` / `node test-smoke.mjs` |
| `web/package.json` | `start` / `dev` / `test` | `node server.mjs` / `node --watch server.mjs` / `node --test tests/*.test.mjs` |
| engine | tests | `python -m pytest tests -v` (from `python-engine/`) |
