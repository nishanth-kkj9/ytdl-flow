# AGENTS.md — Instructions for Coding Agents (YTDL Flow)

This file is binding for any coding agent (human or AI) working in this repository.

---

## PRODUCT IDENTITY

- **Product:** YTDL Flow
- **Repository:** `ytdl-flow`
- **GitHub:** `nishanth-kkj9/ytdl-flow`
- **Meaning:** *YTDL* = YouTube Downloader. *Flow* = the controlled flow from media
  discovery through downloading, processing, verification, and status/history.

Historical note: this codebase was previously published as "YTDL Modern"
(`ytdl_modern`). Internal identifiers still using `ytdl_modern` are technical
names, not branding. Do not rename them unless a migration is explicitly requested.

---

## CORE RULE

Before making changes:

1. **Inspect** — read the actual code; never assume structure or behavior.
2. **Understand** the relevant architecture (see `docs/architecture.md` and
   `docs/codebase/`).
3. **Make the smallest correct change.**
4. **Verify** the result (build, lint, tests, type checks as applicable).
5. **Do not modify unrelated functionality.**

---

## BRANDING RULE

The authoritative YTDL Flow logo is the supplied vector source:

```
references/branding/ytdl-flow-logo.svg
```

It is an **animated SVG** (violet app tile with a chrome play button, a
rose-gold music note, and the silver "YTDL FLOW" wordmark; honors
`prefers-reduced-motion`). The supplied original is the source of truth.

NEVER:

- redesign the logo
- recreate the logo as inline code or a hand-drawn lookalike
- replace it with a generic icon
- invent another logo
- change the logo geometry, proportions, or colors
- substitute an icon-library logo
- generate a replacement logo unless explicitly instructed

If a production asset is needed (e.g. the tile-only emblem for the favicon or
small UI slots), it must be a **separate derivative** placed under
`public/branding/` (currently `ytdl-flow-icon.svg`) — never a modification of
the original reference file. Derivatives must reuse the original's geometry,
gradients, and animations exactly. Create derivatives only when technically
necessary. See `docs/branding.md` for the full usage policy.

---

## REFERENCE RULE

When implementing UI or branding changes, inspect the relevant files under
`references/` and `docs/` **before** making design decisions.

Reference images are design/source-of-truth material. Do not treat them as
optional inspiration when the task explicitly refers to them.

---

## REFERENCE HIERARCHY

When sources conflict, follow the highest-priority source. **Do not silently
guess** — if the conflict is not resolvable, ask the user.

1. Explicit user instruction
2. This repository `AGENTS.md`
3. Approved project documentation (`docs/`, `plans/`)
4. Authoritative reference assets (`references/`)
5. Existing implementation (the code as it stands)
6. General conventions

---

## DOCUMENTATION RULE

- Keep documentation synchronized with **significant** architectural or product
  changes.
- Do not create unnecessary documentation for trivial changes.
- `docs/architecture.md`, `docs/product.md`, and `docs/decisions.md` must reflect
  reality; update them when the architecture or a decision changes.

---

## ENGINEERING RULES

Preserve:

- existing architecture (three-tier: React SPA → Node/Express → Python engine)
- API contracts (REST routes, WebSocket events, NDJSON engine protocol)
- backend behavior (Node server, security middleware, rate limits)
- Python engine behavior (yt-dlp/FFmpeg pipeline, verification, IPC)
- frontend behavior
- tests
- security controls (localhost binding, origin checks, URL allowlisting, CSP)

Do not perform unrelated cleanup. Do not introduce new frameworks or
configuration without an approved decision (record it in `docs/decisions.md`).

---

## VERIFICATION

After meaningful changes, run the appropriate project gates:

- `npm run build` (frontend)
- `npm run lint` and `npm run typecheck` (frontend)
- `npm test` (frontend, Vitest) and `npm test` in `web/` (node:test)
- `pytest` in `python-engine/`

Fix problems **caused by your changes**. Pre-existing failures unrelated to your
change should be reported, not silently ignored.

---

## FUTURE TASK WORKFLOW

Match the workflow to the task size:

| Size | Workflow |
|------|----------|
| **TRIVIAL** | inspect → edit → verify |
| **NORMAL** | explore → diagnose → edit → verify |
| **COMPLEX** | explore → understand architecture → identify affected systems → plan → implement → test → review → verify |
| **LARGE** | analyze → create/update documentation → plan → implement incrementally → test each stage → final review → verify |

---

## GIT

- Do not create commits unless explicitly requested.
- Never change Git identity automatically.
- Follow the user's existing global Git identity policy.
