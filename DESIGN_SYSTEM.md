# 3Drive Scanner — Design System Reference

## Context and Goals

3Drive Scanner is a real-time crypto pattern-detection dashboard (harmonic 3-Drive patterns, RSI divergence, BB squeeze, FVG, S/R confluence) used by a single authenticated trader across desktop and mobile. Tonight's session grew the surface area significantly — Journal, Hit Rate tracker, Weekly Balance, Month Calendar, position-size calculator, market-wide volume trend — faster than the visual system was revisited. This document is the spec to redesign against: it extracts the tokens and patterns **already in production**, flags where they've drifted or gone inconsistent, and defines the rules to hold the line going forward.

**Design intent, in one sentence:** a dense, legible, dark-first trading terminal where every interactive element is instantly recognizable by its existing pattern family (toggle group, filter pill, modal, badge) rather than a new one-off shape.

---

## Design Tokens and Foundations

All tokens below are **already implemented** as CSS custom properties in `index.html` (dark is default, light is a full parallel set under `[data-theme="light"]`). Treat this table as the single source of truth — component specs below reference these names, never raw hex values.

### Typography
| Token | Value |
|---|---|
| `font.family.display` | `'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace` — used for prices, data, timestamps, anything numeric |
| `font.family.ui` | `'Inter', -apple-system, BlinkMacSystemFont, sans-serif` — used for labels, buttons, prose |

No formal type scale exists yet (font sizes are set ad hoc per component, ranging roughly 0.5rem–1rem). **Gap to fix**: define `font.size.xs/sm/md/lg/xl` explicitly and migrate components onto them.

### Color — Dark (default)
| Token | Hex / value | Use |
|---|---|---|
| `color.bg.base` | `#07080e` | page background |
| `color.bg.surface` | `#0d0f1c` | cards, panels, modals |
| `color.bg.surface-alt` | `#050609` | table header, recessed areas |
| `color.bg.hover` | `#13162a` | row/element hover |
| `color.border.default` | `#1c2038` | standard borders |
| `color.border.subtle` | `#10132a` | dividers |
| `color.text.primary` | `#dce8f8` | headings, primary values |
| `color.text.secondary` | `#8898b8` | body, labels |
| `color.text.tertiary` | `#3a4560` | placeholders, disabled, muted |
| `color.accent.primary` | `#06e5d0` (electric teal) | active states, primary actions, links |
| `color.accent.primary-dim` | `rgba(6,229,208,0.07)` | active-state fill |
| `color.signal.bullish` | `#00e5a0` | wins, bullish, positive |
| `color.signal.bearish` | `#ff3d68` | losses, bearish, negative, destructive |
| `color.signal.warning` | `#ffaa00` | caution, trend-conflict, be-careful states |
| `color.signal.info` | `#a060ff` | squeeze, secondary accent |

Each signal color has a matching `-dim` variant (≈8% opacity) for fills behind text of the same hue — this is the established pattern for badges and status pills. **Rule: every new status color must ship both the solid and `-dim` variant.**

### Color — Light mode
Full parallel token set exists (`#f2f4fa` base → `#0c1420` text, teal shifts to `#0080c8`, etc.) — same names, same roles, different values. Any new component must be verified in both themes before shipping; do not hardcode dark-only values.

### Spacing
4px base scale, already defined and should be the **only** spacing source:
`sp.1=4px · sp.2=8px · sp.3=12px · sp.4=16px · sp.5=20px · sp.6=24px · sp.8=32px · sp.10=40px · sp.12=48px`

**Anti-pattern found in current code**: several components use inline `style="padding:14px"` or `gap:6px` instead of the scale (e.g. weekly balance panel, month calendar cells). These are off-scale values (14px, 6px aren't on the 4px grid) — migrate to `sp-*` tokens during the redesign pass.

### Radius, Shadow, Motion
| Token | Value |
|---|---|
| `radius.sm / md / lg / xl` | 4px / 8px / 12px / 16px |
| `shadow.sm / md / lg` | soft, layered dark shadows (values differ per theme) |
| `shadow.glow` | `0 0 24px rgba(6,229,208,0.18)` — reserved for the primary accent only |
| `motion.fast / normal / slow` | 120ms / 220ms / 380ms |
| `motion.easing.out` | `cubic-bezier(0.16, 1, 0.3, 1)` — default for all transitions |

---

## Component-Level Rules

### Toggle Group (segmented control)
**Established pattern** — used for Timeframe (4H/1H/30M) and now Data Market (PERP/SPOT).
- Anatomy: `.tf-group` (flex, `gap: sp-1`) containing 2+ `.tf-btn` children.
- States: **default** (transparent bg, `border-default`, `text-tertiary`) · **hover** (`border-default`→`text-secondary`) · **active** (`accent-primary-dim` bg, `accent-primary` border + text) · **focus-visible** (must show a visible ring — currently missing, see Accessibility) · **disabled** (not yet specified — add 40% opacity, no pointer events).
- Rule: **whenever a control represents mutually exclusive options (2–4 choices the user picks between), use this pattern.** Do not invent a single self-relabeling button — this was the exact bug fixed in the Perp/Spot control tonight.
- Keyboard: arrow-key navigation between segments should be added (currently each button is an independent tab-stop with no roving tabindex — acceptable but not ideal).

### Filter Pill
Near-identical to Toggle Group visually but semantically different: filter pills are **independent, not mutually exclusive as a set** (though the current `SHOW:` row does behave as single-select via `activeFilter`).
- Same states as Toggle Group.
- Rule: if a filter row is genuinely single-select (only one can be active, as today), it **is** a Toggle Group and should carry `role="group"` + `aria-pressed`, matching the fix already applied to Perp/Spot. Audit the `SHOW:` row and RSI/Volume dropdowns during redesign — the dropdowns are a different pattern (see below) and shouldn't be visually confused with pills.

### Dropdown / Select
- Current: native `<select class="ctrl">`, styled to match dark theme (`bg2` background, `border-default`).
- Use for: **3+ options where showing all of them as pills would create clutter** (this is why RSI Zone was removed as a pill-adjacent filter and Volume Status remains a dropdown — Volume Status has only 4 options and reads fine as a dropdown near Sort).
- Rule: don't mix — a filter dimension either lives as a pill row (few, frequently-toggled options) or a dropdown (more options, less frequently changed). Never both for the same dimension.

### Badge / Status Pill
- Anatomy: small `<span>`, uppercase, `font.family.ui`, ~0.5–0.55rem, color-coded via the signal tokens above, no border, no background by default (text-only for zone/status badges like RSI Zone, Volume Status) or `-dim` background for signal badges (bullish/bearish pattern badges).
- **Inconsistency found**: pattern-signal badges (`bull`/`bear`) use a filled `-dim` background; RSI Zone and Volume Status badges are text-only, no background. This is actually a reasonable **intentional** hierarchy (badges with an action/alert-worthy meaning get a fill; passive descriptive badges stay text-only) — document this rule explicitly rather than let it read as an accident: **fills are reserved for actionable/signal badges; descriptive/contextual badges stay text-only.**

### Modal / Overlay
Established pattern (`.journal-overlay` + `.journal-panel`), used for Journal, Alerts, Hit Rate, Month Calendar, Economic Calendar.
- Backdrop: `rgba(0,0,0,0.75)` + `backdrop-filter: blur(6px)`.
- Panel: `bg2` surface, `shadow-lg`, `radius-lg`.
- Behavior already correct and should be the template for any future modal: Escape-to-close, focus trap, click-outside-to-close, focus returns to trigger element on close, `role="dialog"` + `aria-modal`.
- **Rule: no new modal pattern should be invented.** Every future overlay (e.g. a future settings panel) reuses `.journal-overlay`/`.journal-panel`.

### Form Input
- `.form-input, .form-select`: dark surface, `border-default`, `border-radius: r-md`, focus state = border color shifts to `accent-primary`.
- **Accessibility gap found**: `outline: none` is set with no `box-shadow` or ring replacement, and the border-color change happens on `:focus` rather than `:focus-visible`. A subtle 1px border-color shift is a weak focus indicator by WCAG 2.2 standards (contrast and area requirements). **Required fix**: add a visible focus ring (`box-shadow: 0 0 0 2px var(--accent-primary-dim), 0 0 0 1px var(--accent-primary)` or similar) on `:focus-visible` specifically, across all three locations currently setting `outline: none` (form inputs, `select.ctrl`/`input.ctrl`, and one other — grep `outline: none` to find all three during implementation).

### Buttons (`.btn`, `.journal-btn`, `.trade-action-btn`)
Three near-identical button families exist with slightly different padding/font-size conventions. **Consolidate during redesign** into a single `.btn` with `size` modifiers (`sm`/`md`) rather than three separately-maintained classes — reduces future drift.

---

## Accessibility Requirements

Target: WCAG 2.2 AA, consistent with what's already been built tonight (keyboard shortcuts on modals, `aria-live` regions on price/status updates, `aria-label`s on icon-only buttons).

**Testable acceptance criteria for the redesign pass:**
1. Every interactive element must show a visible focus indicator on `:focus-visible` with ≥3:1 contrast against its background and a minimum 2px outline/ring — **currently fails** on form inputs and two other locations (see above). Fix is a hard requirement, not a nice-to-have.
2. Every custom control acting as a toggle/pill group must expose `role="group"` and `aria-pressed`/`aria-current` on its segments — done for Perp/Spot and Timeframe; **audit `SHOW:` filter row**, which currently relies on visual `.active` class only with no ARIA state.
3. Color must never be the only signal — bullish/bearish already pair color with text (`BULL`/`BEAR`) and directional badges; maintain this for any new status.
4. All modals must trap focus and restore it on close — already correct, keep as the template.
5. Every icon-only button must carry `aria-label` — already largely done; re-audit new additions (Month Calendar nav arrows, Weekly Balance settings gear) during the pass, since these were added late in the session and may have been missed.

---

## Content and Tone Standards

- Labels are short, lowercase, mono-spaced for data (`24H %`, `RSI (4H)`), sentence-case for UI copy elsewhere.
- Warnings/errors state the mechanism, not just the alarm: e.g. *"Your fixed risk ($300) exceeds your current balance ($100)"* rather than *"Risk too high."* Keep this standard — it's already the house style in the position calculator and weekly-balance warnings.
- Heuristic/estimated figures (liquidation price, volume-mismatch flag) must say so inline (*"est."*, *"heuristic, not confirmed"*) rather than presenting a guess as fact. Already the standard; do not let new features regress this.

---

## Anti-Patterns and Prohibited Implementations

- **Do not** introduce a new button/pill/badge visual style when an existing family (Toggle Group, Filter Pill, Badge) already covers the use case — this was the root cause of the Perp/Spot confusion.
- **Do not** use inline `style="padding:Npx"` with values off the 4px spacing scale. Several recent additions (Weekly Balance, Month Calendar) did this under time pressure — clean up during the pass.
- **Do not** set `outline: none` without a `:focus-visible` replacement ring.
- **Do not** hardcode a color value where a semantic token exists — audit for any raw hex slipped into recent inline styles (Month Calendar cell backgrounds use `var(--green-dim)`/`var(--red-dim)` correctly; confirm nothing regressed to raw hex).
- **Do not** add a modal without reusing `.journal-overlay`/`.journal-panel`.

---

## QA Checklist (run before shipping the redesign pass)

- [ ] Every color reference in new/touched CSS is a token, not a raw hex
- [ ] Every spacing value is on the 4px scale (or a documented exception is added to this file)
- [ ] Every interactive element has a visible `:focus-visible` state (verify on form inputs specifically — known current gap)
- [ ] Every toggle/pill group has `role="group"` + `aria-pressed` or `aria-current`
- [ ] Dark and light themes both checked for every new/changed component
- [ ] Mobile width (390px) checked for overflow/crowding on every changed screen
- [ ] No new button/badge/modal shape introduced without updating this document
- [ ] Icon-only controls added since the last audit (Month Calendar, Weekly Balance ⚙) carry `aria-label`
