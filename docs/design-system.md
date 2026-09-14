# YTDL Flow — Design System

**Source of truth:** `src/styles.css` (Tailwind CSS v4, CSS-first `@theme`).
All values below were verified against that file; line numbers refer to it.

## Color tokens (`@theme`, `src/styles.css` L14–32)

| Token | Value | Role |
|-------|-------|------|
| `--color-bg` | `#08080D` | App background |
| `--color-surface` | `#111118` | Cards/panels |
| `--color-raised` | `#1A1A24` | Raised elements (hover fills, chip bg) |
| `--color-elevated` | `#22222E` | Highest-elevation surfaces |
| `--color-accent-video` | `#00B8D4` | Cyan — video format accent |
| `--color-accent-audio` | `#F59E0B` | Amber — audio format accent |
| `--color-recording` | `#FF2D55` | Live/recording indicator |
| `--color-text` | `#E2E8F0` | Primary text |
| `--color-text-secondary` | `#A6B5CC` | Secondary text |
| `--color-text-muted` | `#8B9CB8` | Muted text |
| `--color-success` | `#22C55E` | Success states |
| `--color-error` | `#EF4444` | Error states |
| `--color-warning` | `#F59E0B` | Warnings (shares audio accent value) |

The brand logo palette (purple/rose metallic — `docs/branding.md`) is a
separate brand layer and is **not** part of these UI tokens.

## Typography

- **Display/UI font:** `Sora` (400/500/600/700) — token `--font-display`
  (L33–34), body default (L40).
- **Monospace:** `JetBrains Mono` (400/500/600) — token `--font-mono`, used for
  logs, technical values, progress readouts (L354, L453).
- Fonts are **self-hosted** via `@fontsource/sora` and
  `@fontsource/jetbrains-mono` npm packages imported at the top of
  `styles.css` (L4–10). No CDN font loading.

## Spacing, radius, shadows, motion (verified in `styles.css`)

- **Border radii:** small chips `3px` (L94); buttons/inputs `8px`/`12px`
  (L105, L129, L252…); cards `16px` (L113); pills/bars `999px` (L203, L296).
- **Shadows:** subtle black elevation — card `0 1px 3px rgba(0,0,0,0.4)`
  (L114), hover `0 2px 8px rgba(0,0,0,0.3)` (L120); accent glows — focus ring
  `0 0 0 3px rgba(0,184,212,0.06)` (L266, L290), recording pulse glow
  `0 0 8px rgba(255,45,85,0.7)` (L390).
- **Transitions:** short and consistent — `150ms ease` for border/background/
  shadow/transform (L115, L133), `200ms` for panel border (L365), `300ms
  ease-out` for progress-bar width (L304).
- **Animations:** `rec-pulse` (1.5s infinite, recording dot) and
  `waveform-bar` (1.2s infinite, log activity) — L391, L406.

## Light/dark behavior

- **Dark-only.** Background and text are fixed (`#08080D` / `#E2E8F0`, L74–75);
  there is no light theme and no `prefers-color-scheme` switch.

## Reduced motion

- `@media (prefers-reduced-motion: reduce)` disables the pulse/waveform
  animations (L410–412). Any new animation must honor this.

## Responsive behavior

- Layout is responsive via Tailwind v4 responsive utility classes in the TSX
  (e.g. `sm:`, `md:` prefixes) rather than bespoke breakpoints in CSS; verify
  per-component when working on layout.

## Component conventions

- **Two-layer styling:** bespoke component classes in `src/styles.css`
  (component-specific rules: buttons, inputs, cards, log rows) combined with
  Tailwind utilities used inline in TSX (`className="rounded-lg …"`).
- **Zustand store** (`src/stores/downloadStore.ts`) owns UI state; components
  stay presentational.
- **Terminal-result guard:** components consuming engine events must not
  overwrite a terminal state (`cancelled`/`done`) with late messages —
  enforced in `src/hooks/useEngineEvents.ts`.
- Icons: standardized on `lucide-react` (ADR-010) at the established small
  sizes (`h-3.5 w-3.5` / `h-4 w-4`); brand emblem slots use the
  `public/branding/ytdl-flow-icon.svg` tile derivative of the authoritative
  vector logo, never a hand-drawn lookalike (see `docs/branding.md`). The
  logo is never redrawn inline.

## Adding/changing tokens

Any new token or component must be added to `src/styles.css` first and reflect
existing scale choices (radii from the set above, 150–300ms transitions,
reduced-motion guard). Do not introduce a parallel styling system.
