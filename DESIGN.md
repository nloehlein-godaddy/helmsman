---
name: "Helmsman — Field Guide"
description: "Scientific field-guide classification for supervising coding-agent work."
colors:
  nav-bg: "#0a1714"
  nav-text: "#f2f6f3"
  nav-muted: "#a9c4b4"
  nav-active: "#26463b"
  bg: "#0e1b19"
  gutter: "#0a1412"
  panel: "#172a25"
  panel-2: "#1c322c"
  panel-hi: "#244238"
  control-bg: "#080f0d"
  control-border: "#8a9c91"
  line: "rgba(168, 190, 177, 0.32)"
  line-strong: "rgba(168, 190, 177, 0.72)"
  line-faint: "rgba(168, 190, 177, 0.18)"
  secondary: "#96cad3"
  on-accent: "#08090c"
  on-good: "#08090c"
  accent: "#82cbbb"
  accent-bright: "#95d3c5"
  accent-dim: "rgba(130, 203, 187, 0.55)"
  accent-plate: "#82cbbb"
  text: "#e5efe8"
  text-dim: "#a8beb1"
  text-faint: "#9aafa3"
  bad: "#ff9b88"
  good: "#91d2ad"
  review: "#a0c9ed"
  queued: "#e4c17e"
typography:
  page-title:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, \"Segoe UI\", sans-serif"
    fontSize: "26px"
    fontWeight: 650
    lineHeight: 1.25
    letterSpacing: "-0.02em"
  headline:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, \"Segoe UI\", sans-serif"
    fontSize: "20px"
    lineHeight: 1.3
    letterSpacing: "-0.02em"
  subheading:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, \"Segoe UI\", sans-serif"
    fontSize: "18px"
    lineHeight: 1.3
    letterSpacing: "-0.02em"
  panel-title:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, \"Segoe UI\", sans-serif"
    fontSize: "17px"
    fontWeight: 650
    lineHeight: 1.5
  work-title:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, \"Segoe UI\", sans-serif"
    fontSize: "17px"
    fontWeight: 600
    lineHeight: 1.45
  body:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, \"Segoe UI\", sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.5
  control:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, \"Segoe UI\", sans-serif"
    fontSize: "16px"
    lineHeight: 1.4
  navigation:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, \"Segoe UI\", sans-serif"
    fontSize: "15px"
    fontWeight: 500
    lineHeight: 1.4
  evidence:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, \"Segoe UI\", sans-serif"
    fontSize: "14px"
    lineHeight: 1.5
  identifier:
    fontFamily: "\"JetBrains Mono\", ui-monospace, \"SFMono-Regular\", Menlo, Consolas, monospace"
    fontSize: "14px"
  log:
    fontFamily: "\"JetBrains Mono\", ui-monospace, \"SFMono-Regular\", Menlo, Consolas, monospace"
    fontSize: "14px"
    lineHeight: 1.6
rounded:
  control: "6px"
  panel: "12px"
  compact: "4px"
spacing:
  tight: "4px"
  small: "8px"
  compact: "12px"
  panel: "16px"
  section: "20px"
  shell: "24px"
  workspace: "28px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    padding: "6px 12px"
  button-primary-hover:
    backgroundColor: "{colors.accent-bright}"
    textColor: "{colors.on-accent}"
  button-secondary:
    backgroundColor: "{colors.panel-hi}"
    textColor: "{colors.text}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    padding: "6px 12px"
  button-launch:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    rounded: "{rounded.control}"
    padding: "7px 16px"
  input:
    backgroundColor: "{colors.control-bg}"
    textColor: "{colors.text}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    padding: "6px 12px"
  page-tab:
    textColor: "{colors.nav-muted}"
    typography: "{typography.navigation}"
    rounded: "{rounded.control}"
    padding: "10px 14px"
  page-tab-active:
    backgroundColor: "{colors.nav-active}"
    textColor: "{colors.nav-text}"
  panel:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.text}"
    rounded: "{rounded.panel}"
  run-status:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.accent}"
    rounded: "{rounded.control}"
    padding: "2px 8px"
  run-log:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.text}"
    typography: "{typography.log}"
    rounded: "{rounded.control}"
    padding: "12px"
---

# Design System: Helmsman — Field Guide

## Overview

**Creative North Star: "Field Guide"**

Field Guide uses scientific field-guide classification to make work identifiable at a glance: task titles, compact labeled states and subordinate evidence. Evergreen navigation frames dark green-neutral work surfaces; restrained teal marks selection and action. Controls and text use system sans, with JetBrains Mono reserved for identifiers and logs.

Standard web controls and the plugin composition model remain intact. Panels share an index-like rhythm of identity, state and aligned evidence; tab selection and collapse occupy one header row. The dark default palette applies to fresh installs, while existing user-selected palettes retain their colors. Motion provides bounded state feedback with reduced-motion support.

**Key Characteristics:**

- Evergreen navigation, dark green-neutral work surfaces and restrained teal selection.
- Task identity first, labeled state alongside it, supporting evidence below.
- System sans for controls and text; JetBrains Mono for identifiers and logs.
- Twelve-pixel panels and six-pixel controls, with native affordances.
- Customizable panels, logs within reach and a single-column small-screen reading order.

## Colors

Evergreen navigation, dark green-neutral work surfaces and restrained teal selection follow the selected Field Guide contract. Frontmatter records the resolved default palette from `src/data/themes.ts`; selecting a theme replaces the same semantic properties at runtime.

### Primary

- **Teal selection** (`accent`, `accent-plate`): primary actions, selected panel tabs, links and focus outlines. `accent-bright` supplies primary-action hover; `accent-dim` supplies subordinate accents.
- **Evergreen navigation** (`nav-bg`, `nav-active`): navigation rail and selected destination; `nav-text` and `nav-muted` distinguish active and inactive destination text.

### Secondary

- **Secondary teal** (`secondary`): supplementary links, including the terminology reference.
- **Semantic states** (`good`, `bad`, `review`, `queued`): success, failure, review and waiting, accompanied by readable state text or explicit control meaning. `on-good` and `on-accent` are foregrounds for filled treatments.

### Neutral

- **Dark green-neutral work ground** (`bg`, `gutter`): work area and outer ground.
- **Work surfaces** (`panel`, `panel-2`, `panel-hi`): panels, subordinate areas and raised-tone controls or hover feedback.
- **Text** (`text`, `text-dim`, `text-faint`): task identity, supporting text and quiet metadata.
- **Field ground and boundary** (`control-bg`, `control-border`): native inputs, selects and textareas.
- **Dividers** (`line`, `line-strong`, `line-faint`): panel boundaries, control boundaries and quiet row separation. Preserve source RGBA values.

**The Theme Continuity Rule.** Use semantic CSS properties for surfaces, text, selection and state. Dark Field Guide is the fresh-install default; a saved theme keeps its palette.

## Typography

**Text and controls:** the system sans stack in frontmatter. **Identifiers and logs:** self-hosted JetBrains Mono with platform monospace fallbacks. Functional page headings support this operating interface; no decorative display-type role is established.

### Hierarchy

- **Page title:** shell introductions; authored plugin page headings use the same size with their local heading line height.
- **Headline / subheading:** authored plugin heading hierarchy, with inherited heading weights.
- **Panel title:** local standalone panel heading; composed tabs use the smaller navigation/control rhythm.
- **Work title:** linked task identity in running/recent work and PR rows.
- **Body:** general plugin content. Prose typically caps at (75ch); shell introductions cap at (72ch).
- **Control / navigation:** sentence-case labels. Global shell controls use (15px); authored plugin controls use the frontmatter control role.
- **Evidence:** subordinate repository, elapsed-time and outcome text.
- **Identifier / log:** technical identities and selectable log text; tabular numerals are used where present.

**The Identity First Rule.** Give the task title priority, keep identifiers and evidence subordinate, and write the state as a label rather than relying on color alone.

**The Named Panel Rule.** Within a named panel tab, visually hide a repeated local heading while keeping it available to assistive technology. Preserve the heading when the plugin is rendered standalone.

## Layout

A full-width header carries identity, repository scope, readouts and notifications. A (200px) desktop navigation column sits beside the flexible work area; logs and the compact footer sit below that area. Desktop content padding is (28px), with (24px) shell gaps. At (1200px), readouts move to a second header row. At (840px), navigation becomes a horizontally scrolling row and content padding becomes (20px 16px).

Authored Helm uses the saved column count, a (16px) grid gap and (16px) panel-body padding. At (760px), panel bodies use (12px) padding and saved columns interleave into one real DOM reading order: first stack from each column, then second stack from each column. Widening restores the columns without remounting panels or saving a layout change. The older rack has a separate (1080px) single-column breakpoint.

Running-work identity and state occupy two columns, with evidence below. At (480px), state follows title and identifier in one column. Theme-preview groups stack at (900px); at (560px), settings controls stack and palette swatches use three columns. The footer keeps recovery and About access compact; About opens a bounded disclosure above it. The docked log-viewer host caps at (40dvh).

## Elevation & Depth

Work panels are flat, separated by tone and thin borders. The notification popover uses a soft shadow (`0 12px 32px #0003`); its standalone communication-page rendering removes that shadow. Focus outlines communicate keyboard position rather than elevation. The default log is a neutral bordered surface.

**The Flat Work Surface Rule.** Separate work panels with neutral surface tone, spacing and thin borders. Reserve floating depth for the notification popover.

## Shapes

Use panel and control radii for their corresponding surfaces. Compact preview badges, swatches and the alpha label use the smaller compact radius. These are role-specific sizes, not a one-radius system. Panel headers and list rows use thin dividers. Native select, checkbox, radio, details and summary affordances remain recognizable.

## Components

### Buttons

Primary authored-plugin actions use teal fill, contrasting foreground and medium-bold text; hover uses the brighter accent. Authored-plugin controls use (36px) minimum height; Helm and its task panels use (34px). Launch has (7px 16px) padding and a mixed accent/text hover. Secondary controls use raised neutral ground. The shell default uses panel ground and (8px 12px) padding. Disabled controls reduce opacity to (0.5). Focus is a (2px) accent outline, offset (1px) on shell buttons or (2px) in authored plugins.

Global buttons transition background and color over (150ms); authored plugins use (160ms) state transitions. Reduced-motion rules remove them. Question-tab attention changes a boundary over (1.8s) and stops under reduced motion.

### Inputs / Fields

Inputs, selects and textareas share field ground, field boundary and control corners. Authored-plugin fields use (6px 12px) padding; launch uses (7px 9px), and global fields use (6px 9px). Keep labels visible, preserve native behavior, and use accent borders plus the visible focus outline. Launch textareas have a (110px) minimum height and resize vertically. Errors retain explicit alert text.

### Navigation

Desktop destinations form a vertical evergreen rail. Hover and selection use the active navigation surface; selection adds a boundary and stronger weight. Small-screen destinations form an overflowing horizontal row. Panel tabs share a header with collapse: selected tabs fill with the accent when multiple tabs exist; a single tab stays neutral. The collapse icon rotates over (160ms), with reduced-motion support.

### Cards / Containers

Authored Helm stacks use panel ground, a thin semantic line and panel corners. Header padding is (8px 12px); body padding follows the responsive layout above. Repeated local plugin headings are visually hidden only under a named composed tabpanel. Standalone headings remain visible.

### State labels and work rows

Running/recent work uses a prominent linked title, technical identifier, compact outlined state and aligned evidence. State labels use (2px 8px) padding and control corners. Row separation uses the semantic line; the last row removes it. Titles wrap as needed, evidence wraps independently, and narrow-screen order keeps identity ahead of state and actions. Theme-preview status chips use sentence-case sans with compact corners.

### Startup scope

The startup repository selector uses the semantic panel background directly, including outside the application shell. It shares panel corners, (24px) padding and a bounded width of `min(100% - 32px, 540px)`. Boot HTML uses the default dark work ground and text colors as fallbacks before runtime theme application; the selected theme then controls these properties.

### Logs and disclosures

Run logs use the mono log role, (12px) padding, control corners, neutral panel ground and a thin boundary. Their own viewport spans (100px) minimum to (420px) maximum height; the dock adds its host bound. Advanced launch settings, log docking and footer About use native disclosures with visible summary focus.

## Do's and Don'ts

### Do:

- Do use semantic theme properties so existing palettes continue to work.
- Do present task titles, labeled states and subordinate evidence in the shared index-like rhythm.
- Do preserve the accessible heading when suppressing a repeated visible panel heading.
- Do keep tab selection and collapse together, and preserve saved panel order when adapting to a narrow screen.
- Do use visible focus outlines and honor reduced-motion preferences.

### Don't:

- Don't restore brushed-metal panels, seven-segment counts or the oscilloscope treatment as the default visual language.
- Don't use monospace as the general control or prose face.
- Don't use a status hue as the only way to identify state.
- Don't turn a viewport change into a saved layout edit.

Source evidence: `index.html`, `src/style.css`, `src/themePreview.css`, `src/data/themes.ts`, `src/render.ts`, `src/plugins/helm/styles.ts`, `src/plugins/helm/page.ts`, `src/plugins/running/panel.ts`, `src/plugins/recent/panel.ts`, `src/plugins/repoprs/panel.ts`, `src/plugins/newrun/panel.ts`, `src/plugins/run-viewer/styles.ts`, `src/plugins/run-history/styles.ts`, and `src/plugins/communication/styles.ts`. Direction: `.impeccable/surfaces/src-main-ts.md`.

Not canonized or repaired: retained legacy lamp glow, uppercase mono status rules and hard-coded amber tints in `src/style.css`, plus glyph icons in compatibility/notification markup, fall outside the selected Field Guide language. Loaded DSEG7 assets do not establish a current type role. PRODUCT.md still describes the previous visual world; it is outside this documentation write boundary.
