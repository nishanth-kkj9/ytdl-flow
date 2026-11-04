# CONCERNS

Evidence: file inventory + line counts, `docs/codebase/.codebase-scan.txt` (churn/TODO), git log (91fc51e…20a2b25), `docs/roadmap.md`, `plans/`, live test runs 2026-10-11.

## Tech debt (verified)

1. **`python-engine/engine.py` ~1943-line monolith** (was 1508 at last doc — grown). Tested (79 pytest) and working; split deferred by design. Revisit only when a feature touches it anyway.
2. **High-churn trio** (90-day): `web/server.mjs` (21), `python-engine/engine.py` (17), `src/stores/downloadStore.ts` (15), plus `src/components/UrlInput.tsx`, `src/hooks/useEngineEvents.ts`, `web/services/engineManager.mjs` (14 each). Future defects likely here.
3. **No Docker/APM/versioned API** — deliberate (localhost single-user), not gaps. See INTEGRATIONS.
4. **`downloads/` + `logs/` + `web/data/` gitignored runtime state** present locally (25 opus/mp3/wav files, 6 log files) — bloats scan metrics (109k LOC scan is ~media files, not code). No action; do not commit.

## TODOs / FIXMEs in prod

~0. Scan TODO hits are all `graphify-out/` cache artefacts referencing a deleted `web/TODO.md`, not live code. No `TODO/FIXME/HACK` in `src/`, `web/`, `python-engine/` production sources at scan time.

## Open gaps (roadmap Planned — all LOW/LOW-MED, assessed)

- **N-04** mount-time `requestJobs` 500 ms race → re-run `restoreActiveJobs()` on first `engine_ready` after mount. (Downloads die with engine, so only the timeout race remains.)
- **N-06** `verify_format` misses ffprobe in `FFMPEG_PATH`-only setups (F-17 PATH-prepend removal side effect).
- **N-07** client result guard covers only `cancelled`; late `completed↔failed` flip has no known engine path.
- **N-09** probe watchdog (60 s) vs engine deadline race — self-heals (late result replaces timeout error).
- **N-11** server-persisted history lacks `thumbnail` (engine `result` carries only `thumbnail_ok`; needs protocol change).
- Ideas (not committed): transient-DNS auto-retry, README CI badge, build-time raster favicon export, UX polish.

## Security posture

Strong for threat model: localhost bind, Host 421 + origin 403 + WS `verifyClient`, YouTube-only URL allowlist (client/server parity-tested, incl. `music.` + `/live/`), 1 MB JSON cap, per-endpoint rate limits (probe 10/10s, download 5/10s, cancel 21/10s), strict CSP (bracketed-IPv6 sources removed per N-14; `'self'` covers loopback WS), path containment (realpath), thumbnail SSRF guard, length caps, history sanitization, pinned+audited deps. Residual: localhost-only assumption — any LAN exposure reopens Host/origin/CSP surface ([ASK USER] before building it).

## Performance

Fine at single-user scale: bounded pools (5+5), capped backlog (100), probe timeouts tight (15 s socket / 60 s deadline), atomic JSON writes (100-record cap). No N+1 (no DB), no shared in-memory cache across instances (single process). No perf test harness — none needed at this scale.

## Fragile surfaces for next work

`engineManager.mjs` restart/backlog logic, `useEngineEvents.ts` guards, `downloadStore.ts` optimistic state, `validate.mjs` ⇄ `urlRegex.ts` parity pair (change both + fixtures), CSP string in `server.mjs` (smoke-asserted — keep assertion green).
