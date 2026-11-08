# YTDL Flow — Implementation Plan Index

This directory contains archived implementation plans and their execution
records. The status table is an index, not a current health report; use
[`docs/roadmap.md`](../docs/roadmap.md) and
[`docs/codebase/CONCERNS.md`](../docs/codebase/CONCERNS.md) for current project
direction and known gaps.

## Completed plans

| # | Plan | Priority | Effort | Status |
|---|------|----------|--------|--------|
| 001 | [Run frontend tests in CI](001-ci-run-frontend-tests.md) | P1 | ~15 min | DONE |
| 002 | [Non-destructive smoke tests](002-nondestructive-smoke-tests.md) | P1 | ~30 min | DONE |
| 003 | [Frontend URL regex parity](003-frontend-url-regex-parity.md) | P1 | ~30 min | DONE |
| 004 | [Exclude `node_modules` from release archive](004-release-archive-excludes-node-modules.md) | P2 | ~15 min | DONE |
| 005 | [Add ESLint](005-add-eslint.md) | P2 | ~1 hr | DONE |
| 006 | [WebSocket reconnect reconciliation](006-ws-reconnect-reconciliation.md) | P3 | ~2–3 hrs | DONE |
| R3 | Round 3 evidence-based sweep | P2 | ~1 day | DONE — see [`docs/codebase/CONCERNS.md`](../docs/codebase/CONCERNS.md) |

## Historical notes

The detailed plan files retain their original scope, rationale, and
verification notes. Some verification counts and repository observations in
those historical records may have changed since completion; do not treat them
as current results.
