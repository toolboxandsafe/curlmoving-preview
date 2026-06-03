# Handoff: Stacked Stencil Logo (TS-01)

## Overview
Primary logo lockup for **Toolbox & Safe** — a maker of safes and tool boxes. The mark is **text-only** (no icon, no illustration): a two-line stenciled wordmark with a rust ampersand, set above a mono tagline flanked by two rust rules.

Selected from a set of text-only candidates (`logo-options.html`). Identified internally as **TS-01 — "Stacked Stencil."**

## About the Design Files
The HTML file in this bundle is a **design reference**, not production code. It is a self-contained mockup showing the logo in its light and dark contexts. Recreate it in the target codebase (React component, Vue SFC, native asset, etc.) using whatever framework and patterns the project already uses. If the project has no framework yet, choose the most appropriate one and implement the logo as a reusable component there. Don't ship the HTML directly.

## Fidelity
**High fidelity.** The mockup is exact: precise colors, fonts, weights, sizes, letter-spacing, and layout. Reproduce so it renders identically.

## The Logo

### Structure (top to bottom)
1. **Wordmark** — two lines:
   - Line 1: `TOOLBOX`
   - Line 2: `&` (rust) + ` SAFE`
   - Font: **Big Shoulders Stencil Display**, weight **900**, uppercase, `font-size: 58px`, `line-height: 0.82`, `letter-spacing: 0.005em`.
2. **Tagline** — `SAFES & TOOL BOXES`
   - Font: **JetBrains Mono**, weight **700**, uppercase, `font-size: 10px`, `letter-spacing: 0.34em`.
   - Rendered as a flex row with a `2px` rust rule on each side (`flex: 1` lines via `::before` / `::after`), `gap: 10px`, `margin-top: 28px`.

### Variants

| Element | Light variant (bg `--c-bone`) | Dark variant (bg `--c-coal`) |
|---|---|---|
| Wordmark text | `--c-coal` (#131416) | `--c-bone` (#efe9dd) |
| Ampersand `&` | `--c-rust` (#c8501f) | `--c-rust` (#c8501f) |
| Tagline text | `--c-coal` | `--c-bone` |
| Tagline rules | `--c-rust` | `--c-rust` |

The ampersand and the two tagline rules are **always rust**, in both variants.

### Typography / fonts to load
- **Big Shoulders Stencil Display** — weights 700/800/900. Used at 900 for the wordmark. Fallback: `'Oswald', sans-serif`.
- **JetBrains Mono** — weights 500/700. Used at 700 for the tagline. Fallback: `ui-monospace, monospace`.
- **Oswald** — weights 500/600/700. Display fallback / used elsewhere in the system.

Google Fonts import used in the reference:
```
https://fonts.googleapis.com/css2?family=Oswald:wght@500;600;700&family=JetBrains+Mono:wght@500;700&family=Big+Shoulders+Stencil+Display:wght@700;800;900&display=swap
```

### Accessibility
- This is a text logo. Prefer real text over an image so it's selectable and screen-reader friendly. If rendered as an image/SVG, give it an accessible name of "Toolbox & Safe".
- The tagline rules are decorative (`::before`/`::after`) and need no markup.

## Design Tokens

```css
--c-bone:    #efe9dd;  /* warm off-white background */
--c-paper:   #e3dccb;  /* slightly deeper paper tone */
--c-steel:   #6b6e72;  /* mid grey, secondary text */
--c-iron:    #2a2c2f;  /* near-black body text */
--c-coal:    #131416;  /* dark base / wordmark on light bg */
--c-rust:    #c8501f;  /* primary accent — ampersand + rules */
--c-rust-dk: #9a3d17;  /* darker rust, used elsewhere */
--c-amber:   #e8a44a;  /* warm accent, used elsewhere */
```

Only **bone**, **coal**, and **rust** are required for this logo. The full palette is included so the mark sits correctly inside the broader Toolbox & Safe system.

## Recommended component API
A React example — adapt to your framework:

```tsx
type Variant = 'light' | 'dark';

interface StackedStencilLogoProps {
  variant?: Variant;          // default: 'light'
  tagline?: boolean;          // default: true — show "SAFES & TOOL BOXES" + rules
  className?: string;
}
```

Render the wordmark as real text in the stencil face, with the ampersand wrapped in a rust-colored span. The tagline is a flex row; the two rules are `flex:1` pseudo-elements (or two `<span>`s) in rust.

## Files in this bundle
- `README.md` — this document
- `logo-ts-01-stacked-stencil.html` — isolated, self-contained mockup of the logo in both variants

## Source
Original options sheet: `logo-options.html` (project "moving website"). This is the article tagged `<!-- 01 STACKED STENCIL -->`, id **TS-01**.
