# CONVENTIONS

Evidence: `eslint.config.js`, `tsconfig.json`, `plans/README.md` conventions, `src/components/*`, `web/routes/download.mjs`, `web/server.mjs`, `python-engine/engine.py`, `python-engine/ipc_main.py`, `python-engine/logger.py`.

## File naming

PascalCase React components (`UrlInput.tsx`, `ProbeCard.tsx`); camelCase TS/JS modules (`downloadStore.ts`, `useEngineEvents.ts`, `engineManager.mjs`, `historyService.mjs`); colocated `*.test.{ts,tsx}` / `*.test.mjs`; snake_case Python (`ipc_main.py`, `test_round3_pins.py`). Verified across 10+ files per area.

## Function / variable naming

TS/JS camelCase (`restoreActiveJobs`, `allowedHostsFor`); Python snake_case (`verify_format`, `_download_once`, `classify_error_type`); Python privates `_`-prefixed (`_YdlLogCollector`, `_write_result`); no `#` fields; React components PascalCase, hooks `use*`.

## Lint / format

ESLint flat config (`eslint.config.js`): `js recommended` + `typescript-eslint recommended` + `react-hooks recommended`; `no-explicit-any: off` (wire payloads dynamic), `no-console: off`. No Prettier config — formatting by existing style. Backend has no linter; `node --check` in CI.

## TypeScript strictness

`strict: true` + `noUnusedLocals` + `noUnusedParameters` + `noFallthroughCasesInSwitch` + `noUncheckedIndexedAccess` + `noImplicitOverride` (`tsconfig.json`, `include: ["src"]`).

## Error handling per layer

- Routes: validation → `res.status(N).json({ error })`; unexpected → `next(err)` to central handler (never leak 5xx `err.message`).
- Engine: `error_type` classification (`classify_error_type`: BotDetection/Network/etc.), honest `warnings` on result, actionable cookie/pacing hints.
- Frontend: `useEngineEvents` queue-membership + terminal-result guards (cancelled never resurrected); toasts for probe/cancel failures.

## Logging

Python `logger.py` rotating file (`logs/ytdl_pro_YYYYMMDD.log`, 5 MB × 3); stdout reserved for NDJSON only. Backend `middleware/requestLog.mjs` compact per-request line for `/api/*`; CSP/security rationale in verbose why-comments. Frontend `console.*` allowed.

## Imports

Relative imports only; no path aliases (`@/...` absent — verified in `tsconfig.json`); no barrel files; backend plain ESM `import … from "./x.mjs"` with explicit `.mjs` extensions.
