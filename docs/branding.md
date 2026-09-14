# YTDL Flow — Branding

## Identity

- **Product name:** YTDL Flow
- **Meaning:** *YTDL* = YouTube Downloader. *Flow* = the controlled flow from
  media discovery through downloading, processing, verification, and
  status/history.
- **Status:** current. The product was previously published as "YTDL Modern";
  user-facing surfaces have been renamed to YTDL Flow. Internal identifiers
  (`ytdl_modern`) are technical names and are **not** branding.

## The authoritative logo

| Property | Value |
|----------|-------|
| Canonical file | `references/branding/ytdl-flow-logo.svg` |
| Format | **Animated SVG** (vector source; CSS animations inline) |
| Canvas | 1024 × 1024 (viewBox `0 0 1024 1024`) |
| Animation | bloom pulse, tile float, symbol pulse, note bob, glass-sheen sweep, wordmark glint — all disabled under `prefers-reduced-motion: reduce` |

### Documented characteristics (from the supplied original)

The logo is a full-bleed composition on a deep graphite/slate radial-gradient
background with soft lighting and a faint grain texture. It consists of:

1. **App tile** — a floating, rounded-square (squircle-like, rx≈77–80) badge
   with a violet/indigo gradient face (`#72539a → #160a25`), a lighter outer
   rim, a subtle violet bottom glow, a soft drop shadow, and a diagonal glass
   sheen that periodically sweeps across the face.
2. **Emblem** — an interlocking composition of a **right-pointing play
   triangle** (chrome/lilac metallic, outlined, with a darker inset) woven
   with a **beamed double eighth note** in brushed **rose-gold metallic**,
   including glint highlights. The play outline passes over and behind the
   note (layered depth); the note gently bobs.
3. **Wordmark** — **"YTDL FLOW"** in brushed silver gradient capitals
   (heavy geometric sans-serif) with a soft drop shadow and a moving glint,
   set below the tile, with a faint floor reflection.

### Visual identity notes

- The logo's brand palette is **dark slate + violet/indigo + rose-gold +
  silver** — this is the *brand* identity and is distinct from the product's
  *UI accent* palette (cyan for video, amber for audio — see
  `docs/design-system.md`). Both share the premium dark foundation
  (`#08080D`), but **the logo colors are not UI token colors** and must not be
  remapped to them.
- The relationship between the play symbol and the music note (interlocking,
  note in front, layered metallic depth) is part of the identity, as are the
  animations (float/bob/sheen) — do not strip them from the reference or
  derivatives.

## Logo rules (binding)

- Preserve geometry, proportions, gradients/colors, animations, and the
  play/music relationship.
- Do not redesign, recreate as inline code or a hand-drawn lookalike, replace
  with a generic or icon-library icon, simplify, or recolor the logo.
- The reference file is immutable. Any production asset must be a **separate
  derivative** under `public/branding/` — never an edit of the reference file.
- Do not create derivatives unless technically necessary.

## Usage

| Surface | Guidance |
|---------|----------|
| Application header | Uses the tile-emblem derivative (`public/branding/ytdl-flow-icon.svg`) in the header badge so the compact slot carries the real brand emblem, not a generic play glyph. |
| Navigation / drawer | Prefer the tile-emblem derivative at small sizes; keep clear space around it. |
| Landing / no-build placeholder page | Full logo or emblem; must sit on a dark background consistent with `#08080D`. |
| Favicon | `public/branding/ytdl-flow-icon.svg` (tile emblem, transparent background) wired as `<link rel="icon" type="image/svg+xml">` and `apple-touch-icon` in `index.html`. |
| Documentation | Reference the canonical path `references/branding/ytdl-flow-logo.svg`; do not duplicate the file. |
| README | Embeds the logo at the top directly from `references/branding/ytdl-flow-logo.svg`; never move the original. |

### Small UI locations

For favicons, avatars, or compact header slots, a **tile-only derivative**
(`public/branding/ytdl-flow-icon.svg`: viewBox cropped to the floating tile,
transparent background, wordmark and scene removed, all tile gradients,
filters, and animations reused verbatim) is used. The reference file is never
modified or replaced by the derivative.

Note: raster exports (PNG/ICO) are intentionally not maintained. Safari/iOS
support for SVG touch icons is limited; if touch-icon parity is ever needed,
generate a PNG from the SVG at build time (tracked in `docs/roadmap.md` Ideas).

## Production assets (current)

| Asset | Path | Provenance |
|-------|------|------------|
| Tile-emblem icon (SVG) | `public/branding/ytdl-flow-icon.svg` | Tile-only crop of the authoritative logo (viewBox `270 200 504 504`): the floating tile + play/music emblem verbatim, on a transparent background; wordmark/scene removed; gradients, filters, and animations reused exactly. Used by: favicon, `apple-touch-icon`, app header badge, empty-state badge. Served by both Vite (`public/`) and Express (`dist/branding/…`). |

The original reference file is immutable; the icon is a standalone derivative
that can be rebuilt from the original at any time.
