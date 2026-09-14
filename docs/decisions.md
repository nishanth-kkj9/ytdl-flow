# YTDL Flow — Decision Log

ADR-style log. Entries are numbered chronologically and cite their evidence in
the repository (code, `docs/codebase/*`, plans, or CI). No speculative or
unverifiable entries.

---

## ADR-001 — Three-tier architecture: React SPA → Node/Express → Python engine

### Context
The project must drive `yt-dlp`/FFmpeg (Python/CLI ecosystem) while presenting
a modern web UI, with a single security boundary.

### Decision
Strict three tiers: React SPA (presentation + optimistic state), Node/Express
(authority: validation, security, queue, history, engine lifecycle), Python
engine (all media work). Browser never talks to Python or YouTube directly.

### Reason
Isolates security-critical validation in one tier; isolates dependency churn
(yt-dlp updates) in the engine; lets each tier use its native tooling.

### Consequences
Two process boundaries (HTTP/WS, NDJSON stdio) that must stay versioned and
tested; slightly more moving parts in exchange for clean ownership.

*Evidence:* repo structure (`src/`, `web/`, `python-engine/`),
`docs/codebase/ARCHITECTURE.md`.

---

## ADR-002 — Backend in plain ESM JavaScript (`.mjs`), no TypeScript

### Context
Backend surface is small, glue-heavy, and dominated by one protocol (NDJSON);
the frontend already carries type safety.

### Decision
Backend stays plain ESM `.mjs` on Express 5; no backend TypeScript.

### Reason
Deliberate convention (documented in `docs/codebase/STACK.md`): lower build
friction where the main risk is protocol correctness, which is covered by
node:test suites.

### Consequences
Less compile-time safety in `web/`; mitigated by tests and strict validation
(`web/validate.mjs`).

---

## ADR-003 — JSON file storage for history (no database)

### Context
History is append-mostly, local, and must survive restarts without asking users
to run or back up a database.

### Decision
Persist history to `web/data/history.json` with atomic temp-file + rename
writes (`web/services/historyService.mjs`, `historyPersistence.mjs`).

### Reason
Zero-dependency, inspectable, trivially backed up; sufficient for single-user
localhost scale.

### Consequences
No concurrent multi-user writes; no query engine. Schema additions (e.g.
thumbnails — N-11) must remain backward-compatible with existing files.

---

## ADR-004 — One-way WebSocket broadcasts; REST stays authoritative

### Context
Progress, logs, and status must be live, but the server remains the authority
for job state (client keeps optimistic state only).

### Decision
WebSocket (`ws`) is server → client broadcast only; state mutations and
queries go through REST; client reconciles via status/history snapshots
(reconnect reconciliation — `plans/006`).

### Reason
Simpler and safer than a two-way channel; no new RPC attack surface on the WS.

### Consequences
Client must handle reconnect reconciliation itself (implemented and planned in
plans/006).

---

## ADR-005 — Dark-only UI theme with CSS-first Tailwind v4 tokens

### Context
The product targets a premium dark aesthetic; maintaining two themes doubles
QA surface for a single-user tool.

### Decision
Single dark theme defined by `@theme` tokens in `src/styles.css` (Sora +
JetBrains Mono self-hosted via `@fontsource`); no light mode.

### Reason
Consistent identity with the logo's dark foundation; fewer visual states to
verify.

### Consequences
No `prefers-color-scheme` support; documented in `docs/design-system.md`.

---

## ADR-006 — Pinned, hash-locked Python dependencies; pytest stays `<9.0`

### Context
CI must be reproducible and immune to breaking releases of fast-moving deps
(yt-dlp) and test tooling.

### Decision
`python-engine/requirements.lock` pins exact versions with hashes; pytest is
deliberately pinned `<9.0`.

### Reason
Hash-locked installs make CI auditable; a pytest 9 migration is a deliberate
future change, not an accidental one (the Dependabot PR proposing >=9 is
expected to be declined).

### Consequences
Periodic manual upgrade work; documented exception to "keep dependencies
latest".

---

## ADR-007 — Honest failure reporting (warnings on the wire, verification)

### Context
Audits found features that existed only in code but were never carried on the
wire (warnings, yt-dlp skip markers) — unit tests passed while the feature was
dead in practice.

### Decision
The engine carries `warnings` and verification results end-to-end
(NDJSON → WS → UI), and the server treats honest failure (missing FFmpeg,
codec mismatch, duplicate-title collision) as a first-class outcome.

### Reason
Trust requires the UI to show exactly what the engine decided; silent success
is a correctness bug (duplicate-title data loss was fixed with an id-suffix
filename retry).

### Consequences
Every engine result field added later must be verified **on the wire** (live
test), not just in unit tests.

---

## ADR-008 — Product identity: "YTDL Modern" → "YTDL Flow"; internal names unchanged

### Context
The repository was re-published as `nishanth-kkj9/ytdl-flow`; user-facing
branding and internal identifiers had diverged.

### Decision
Rename all user-facing branding (README, UI header, page title, placeholder
page, server banner, package descriptions) to YTDL Flow; keep internal
identifiers (`ytdl_modern`) unchanged.

### Reason
Branding is user-facing; renaming internal packages would touch imports, CI
paths, and history for zero functional gain.

### Consequences
Docs must explain the historical mapping (done in `AGENTS.md`,
`docs/product.md`); future migrations require an explicit decision here.

### Audit follow-up (2026-09-13)
A full-tree audit (all extensions) found three user-facing surfaces the
original `*.md/*.json/*.mjs/*.py` sweep had missed, all renamed here:
`/api/status` payload id (`ytdl-modern-web` → `ytdl-flow-web`, test updated in
lockstep), the engine's metadata fallback comment written into downloaded
files (`"Downloaded with ytdl_modern"` → `"Downloaded with ytdl flow"`), and
`release.yml` (archive names + release body `ytdl-modern-*` → `ytdl-flow-*`).
Internal package names and module docstrings intentionally unchanged.

---

## ADR-009 — Logo reference is an immutable raster original

### Context
The supplied YTDL Flow logo is a raster PNG with baked-in background and
wordmark; small-size UI uses need variants the original cannot provide
directly.

### Decision
Keep the original untouched at `references/branding/ytdl-flow-logo.png` as the
single source of truth; allow only clearly separated square derivatives under
`public/branding/`, created only when technically necessary.

### Reason
Preserves brand integrity and provenance; avoids an unmaintainable set of
recreated vector "lookalikes".

### Consequences
Small-size uses (favicon, header badge) stayed on an inline placeholder until
the derivative was actually needed — see ADR-010 for the sanctioned creation
and `docs/branding.md` for the production-asset provenance.

> **Superseded (2026-09-14):** ADR-011 replaced the raster original with the
> owner-supplied vector logo; this decision is retained for history.

---

## ADR-010 — Brand icon derivative + lucide-react icon set

### Context
The app previously used a hand-drawn inline-SVG play glyph in the header
badge, empty state, and favicon — a generic lookalike rather than the real
brand emblem. UI icons were ad-hoc inline SVGs and text glyphs ("✓", "✕") in
toasts. The user requested an improved in-app logo and proper icons.

### Decision
1. Create a production derivative: `public/branding/ytdl-flow-icon.png`
   (512×512) — a programmatic square crop of the purple tile emblem from the
   authoritative reference `references/branding/ytdl-flow-logo.png` (original
   untouched). Wire it into the header badge, empty-state badge, favicon, and
   `apple-touch-icon` (served at `/branding/ytdl-flow-icon.png`).
2. Add `lucide-react` as the standard UI icon library (toasts, drawer trigger)
   at the existing small icon sizes; CSP `img-src 'self'` already admits the
   self-hosted asset.

### Reason
AGENTS.md forbids recreating the logo as SVG or substituting generic icons;
only a derivative of the original is policy-compliant for small UI slots.
`lucide-react` is tree-shakeable, matches the stroke-based inline-SVG style
already in use, and removes the text-glyph iconography.

### Consequences
One new runtime dependency (frontend-only, tree-shaken); the derivative must
be regenerated from the original if the reference ever changes; docs
(`docs/branding.md`, `docs/design-system.md`, `docs/roadmap.md`) updated in
the same change.

### Follow-up (2026-09-13): icon generation v2
The original derivative was a tight opaque crop (0–3px margins, tile bleeding
to the canvas edge). Regenerated the master with:
- **Clear space** — tile optically centered with padding on all sides.
- **Transparent corners** — alpha follows a squircle-like rounded-rect
  silhouette of the tile; corners are 0-alpha instead of opaque dark slate.
- **Hole-free emblem** — the alpha covers the full tile (purple fill +
  metallic rim + play/music glyphs; internal shadow gaps are inside the
  shape, not holes).
- Added `public/branding/ytdl-flow-favicon.png` (64×64, ~7 KB) for the
  browser-tab `rel="icon"`; `apple-touch-icon` keeps the 512 master.
Colors/geometry of the emblem are preserved exactly (validated: only framing
and alpha changed; same tile center pixel). The original reference file was
not modified.

---

## ADR-011 — Logo replaced by the owner-supplied animated vector SVG

### Context
The brand reference was a raster PNG (ADR-009/ADR-010). The product owner then
supplied a new, animated vector logo (violet app tile + chrome play button +
rose-gold note + silver wordmark) and instructed that **all raster logos be
removed** and this SVG become the single brand asset. Per the REFERENCE
HIERARCHY, an explicit user instruction is the highest-priority source.

### Decision
- Store the supplied SVG verbatim at `references/branding/ytdl-flow-logo.svg`
  as the authoritative, immutable reference.
- Remove all raster logo assets: `references/branding/ytdl-flow-logo.png`,
  `public/branding/ytdl-flow-icon.png`, `public/branding/ytdl-flow-favicon.png`.
- Add one derivative, `public/branding/ytdl-flow-icon.svg` (tile-only crop,
  transparent background, gradients/filters/animations reused verbatim), and
  wire it into the favicon, `apple-touch-icon`, app header badge, and
  empty-state badge (`index.html`, `src/App.tsx`,
  `src/components/EmptyState.tsx`).
- Update the binding rules in `AGENTS.md` and `docs/branding.md`: the logo is
  now vector, so "never recreate as SVG" becomes "never redraw inline / no
  hand-drawn lookalikes"; the derivative policy (under `public/branding/`,
  only when technically necessary) is unchanged.

### Reason
The owner explicitly replaced the reference asset (highest-priority source).
A vector source scales losslessly to every UI size and removes ~1.7 MB of
raster payload from the repository and the shipped bundle.

### Consequences
Supersedes ADR-009 (raster-original rule) and the PNG production assets of
ADR-010. SVG favicons are not supported by some legacy browsers, and
Safari/iOS touch-icon support is limited; if parity is ever required,
generate raster exports from the SVG at build time (tracked in
`docs/roadmap.md` Ideas).

