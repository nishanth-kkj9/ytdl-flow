# references/branding — Authoritative Brand Assets

## What belongs here

- The **canonical YTDL Flow logo** and other brand source material supplied by
  the product owner.
- Files in this directory are the **source of truth** for visual identity.

## Current contents

| File | Role |
|------|------|
| `ytdl-flow-logo.svg` | **The authoritative YTDL Flow logo** — animated vector SVG (1024×1024: violet app tile, chrome play button, rose-gold music note, silver "YTDL FLOW" wordmark). See `docs/branding.md` for documented characteristics and usage rules. |

## What does NOT belong here

- Derivatives, crops, or app production assets — those belong under
  `public/branding/` (created only when technically necessary).
- UI screenshots or mockups (those belong in `references/ui/`).
- Anything that is not original reference material.

## How coding agents must use this material

1. Treat `ytdl-flow-logo.svg` as **immutable** — never edit, re-export,
   minify, or replace it.
2. Never redraw the logo inline or generate a substitute; small-UI needs are
   met by the documented derivative under `public/branding/`.
3. Before any branding-related change, read `docs/branding.md` and inspect the
   reference file itself.
4. Reference the canonical path (`references/branding/ytdl-flow-logo.svg`) in
   documentation; do not duplicate the file elsewhere.

Historical note: an earlier raster original (`ytdl-flow-logo.png`, SHA-256
`811EE563…ADE5`) was the reference until 2026-09-14, when the owner supplied
this vector logo and the raster assets were removed (see `docs/decisions.md`
ADR-011).
