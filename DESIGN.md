---
name: "Helmsman — Field Guide"
description: "Scientific field-guide classification for supervising coding-agent work."
colors:
  nav-bg: "#030705"
  nav-text: "#eaf0ed"
  nav-muted: "#babfbc"
  nav-active: "#1a211e"
  bg: "#050a07"
  gutter: "#030705"
  panel: "#0d1410"
  panel-2: "#131a17"
  panel-hi: "#1a211e"
  control-bg: "#070d0a"
  input-text: "#eaf0ed"
  input-placeholder: "#babfbc"
  input-accent: "#79b198"
  control-border: "#999d9a"
  line: "rgba(186, 191, 188, 0.32)"
  line-strong: "rgba(186, 191, 188, 0.72)"
  line-faint: "rgba(186, 191, 188, 0.18)"
  secondary: "#79aeb1"
  secondary-text: "#79aeb1"
  on-accent: "#08090c"
  on-good: "#08090c"
  accent: "#79b198"
  accent-text: "#79b198"
  accent-text-hover: "#8dbda7"
  accent-bright: "#8dbda7"
  accent-dim: "rgba(121, 177, 152, 0.55)"
  accent-plate: "#79b198"
  text: "#eaf0ed"
  text-dim: "#babfbc"
  text-faint: "#949a97"
  bad: "#ed8b83"
  good: "#77be7a"
  review: "#74adf5"
  queued: "#c2a946"
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
    textColor: "{colors.input-text}"
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
  section-nav:
    backgroundColor: "var(--section-nav-bg)"
  section-link:
    textColor: "var(--section-nav-text)"
    typography: "{typography.navigation}"
    rounded: "{rounded.control}"
    padding: "8px 12px"
  section-link-hover:
    backgroundColor: "var(--section-nav-hover)"
  section-link-active:
    backgroundColor: "var(--section-nav-selected)"
    textColor: "var(--section-nav-ink)"
  panel:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.text}"
    rounded: "{rounded.panel}"
  run-status:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.accent-text}"
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

Field Guide uses scientific field-guide classification to make work identifiable at a glance: task titles, compact labeled states and subordinate evidence. A generated personal palette frames work surfaces; restrained accents mark selection and action. Controls and text use system sans, with JetBrains Mono reserved for identifiers and logs.

Standard web controls and the plugin composition model remain intact. Panels share an index-like rhythm of identity, state and aligned evidence; tab selection and collapse occupy one header row. One generated personal theme applies throughout the app. Hue, saturation, brightness, appearance and color harmony derive the palette; previous preset and saved palettes are discarded. Motion provides bounded state feedback with reduced-motion support.

**Key Characteristics:**

- Theme-derived navigation and work surfaces with restrained selection accents.
- Task identity first, labeled state alongside it, supporting evidence below.
- System sans for controls and text; JetBrains Mono for identifiers and logs.
- Twelve-pixel panels and six-pixel controls, with native affordances.
- Customizable panels, logs within reach and a single-column small-screen reading order.

## Colors

The Field Guide layout uses one generated personal palette. Frontmatter records the resolved dark default from `generateThemePalette(DEFAULT_THEME_GENERATOR_SETTINGS, 'dark')` and `customThemeFromPalette` in `src/data/themeGenerator.ts` and `src/data/themes.ts`. Hue (165°), saturation (35%), brightness (45%) and analogous harmony establish the default. Runtime changes replace the same semantic properties.

### Primary

- **Selection accent** (`accent`, `accent-plate`): primary-action fills and selected panel tabs. `accent-text` supplies readable keyboard-focus outlines. `accent-bright` supplies primary-action hover; `accent-dim` supplies subordinate accents. `accent-text` and `accent-text-hover` supply links, outlined action labels and inline commands.
- **Primary navigation** (`nav-bg`, `nav-active`): navigation rail and selected destination; `nav-text` and `nav-muted` distinguish active and inactive destination text.

### Secondary

- **Companion accent** (`secondary`): supplementary fills and decoration. `secondary-text` supplies supplementary links, including the terminology reference.
- **Section navigation**: the Config and Runs navigation band uses the theme's Companion or Accent color, choosing the stronger minimum contrast against the header, primary navigation, page and panel surfaces. Companion wins ties. Text uses whichever of black or white reads more clearly; selected links invert that pair. Hover strengthens text contrast. Generated palettes derive these roles before first paint and during live changes.
- **Semantic states** (`good`, `bad`, `review`, `queued`): success green, failure red, review blue and waiting yellow, with locked semantic hue families and theme-derived saturation and lightness, accompanied by readable state text or explicit control meaning. `on-good` and `on-accent` are foregrounds for filled treatments.

### Neutral

- **Work ground** (`bg`, `gutter`): work area and outer ground.
- **Work surfaces** (`panel`, `panel-2`, `panel-hi`): panels, subordinate areas and raised-tone controls or hover feedback.
- **Text** (`text`, `text-dim`, `text-faint`): task identity, supporting text and quiet metadata.
- **Field ground and boundary** (`control-bg`, `control-border`): native inputs, selects and textareas. Advanced overrides expose Input background separately from panel ground; `input-text` and `input-placeholder` derive readable input values and placeholder text against that ground. `input-accent` supplies contrast-derived native range control color.
- **Dividers** (`line`, `line-strong`, `line-faint`): panel boundaries, control boundaries and quiet row separation. Preserve source RGBA values.

**The Generated Theme Rule.** Use semantic CSS properties for surfaces, text, selection and state. A single browser-local recipe generates the personal palette in OKLCH, with gamut-mapped sRGB output. Analogous harmony offsets the companion hue by 35°; complementary uses 180°; triadic uses 120° for the companion and 240° for lightly tinted surfaces. Tetradic distributes four hues at 0°, 60°, 180° and 240°; Square uses 0°, 90°, 180° and 270°. Split complementary uses 0°, 150° and 210°. Monochromatic varies lightness and chroma at one hue; Shades darkens the companion at the base hue while retaining its chroma before gamut mapping. Error, success, review and queued stay in their red, green, blue and yellow families. Previous presets and saved palettes are removed; only the current generated theme is saved.

**The Custom Contrast Rule.** Generated palettes and advanced overrides preserve raw fills. Derive shared text foregrounds toward 4.5:1 contrast on the background, navigation and panels when those surfaces permit a shared foreground. Derive input values and placeholders independently to at least 4.5:1 against the selected Input background; changing that ground does not change page text. Native range controls derive input-accent against that ground; shared keyboard-focus outlines use accent-text. Filled-action ink follows the actual fill brightness independently of theme mode. A shared foreground cannot guarantee contrast across arbitrary mixed light and dark surfaces.

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

Config and Runs keep a horizontal secondary navigation row above the independently scrolling work area on their parent and child pages. Its theme-derived band has a selected-color bottom divider, a (4px) gap and (8px 28px) padding. At (840px), it sits below the primary navigation with (8px 12px) padding. Secondary links stay on one line and scroll horizontally when needed; navigation and resize reveal the current destination within that row. Unrelated pages hide the row.

Authored Helm uses the saved column count, a (16px) grid gap and (16px) panel-body padding. At (760px), panel bodies use (12px) padding and saved columns interleave into one real DOM reading order: first stack from each column, then second stack from each column. Widening restores the columns without remounting panels or saving a layout change. The older rack has a separate (1080px) single-column breakpoint.

Running-work identity and state occupy two columns, with evidence below. At (480px), state follows title and identifier in one column. Theme-preview groups stack at (900px); at (560px), settings controls stack and palette swatches use three columns. The footer keeps recovery and About access compact; About opens a bounded disclosure above it. The docked log-viewer host caps at (40dvh).

Theme-preview swatch labels and values wrap within their grid cells, including when text is enlarged.

## Elevation & Depth

Work panels are flat, separated by tone and thin borders. The notification popover uses a soft shadow (`0 12px 32px #0003`); its standalone communication-page rendering removes that shadow. Focus outlines communicate keyboard position rather than elevation. The default log is a neutral bordered surface.

**The Flat Work Surface Rule.** Separate work panels with neutral surface tone, spacing and thin borders. Reserve floating depth for the notification popover.

## Shapes

Use panel and control radii for their corresponding surfaces. Compact preview badges, swatches and the alpha label use the smaller compact radius. These are role-specific sizes, not a one-radius system. Panel headers and list rows use thin dividers. Native select, checkbox, radio, details and summary affordances remain recognizable.

## Components

### Buttons

Primary authored-plugin actions use accent fill, contrasting foreground and medium-bold text; hover uses the brighter accent. Authored-plugin controls use (36px) minimum height; Helm and its task panels use (34px). Launch has (7px 16px) padding and a mixed accent/text hover. New Run places an (18px) Phosphor Fill icon before its launch label with an (8px) gap: anchor for Weigh anchor in Pirate mode, play for Start run otherwise. Icons inherit the button foreground and remain hidden from assistive technology; the label and focus identity remain stable. Secondary controls use raised neutral ground. The shell default uses panel ground and (8px 12px) padding. Disabled controls reduce opacity to (0.5). Focus is a (2px) contrast-derived `accent-text` outline, offset (1px) on shell buttons or (2px) in authored plugins.

Settings panels keep Refresh settings above the fields and place the accent-filled Save GitHub settings or Update Jira token action below them. Secondary Discard changes or Clear entered token appears only while there is a draft to remove. Revision conflicts reveal Keep my changes or Keep entered token beside the conflict text; choosing it uses the latest revision and still requires the primary action. GitHub edits save locally as a draft while typing, with Retry saving draft shown only after a storage error. Communication settings uses an accent-filled Save communication settings action, contextual Discard changes or Use saved settings, and Retry saving draft only after a storage error. Source settings likewise save drafts automatically, then use accent-filled Apply source configuration and Save automatic source selection actions at the ends of their respective sections. Execution settings uses a primary Save execution settings action, or Retry saved change for a pending request.

Global buttons transition background and color over (150ms); authored plugins use (160ms) state transitions. Reduced-motion rules remove them. Question-tab attention changes a boundary over (1.8s) and stops under reduced motion.

When any pointer is coarse, shell buttons, disclosures, selects and non-checkbox/radio inputs have a minimum target of (44px) in both dimensions. Primary, secondary, installed-page and recovery navigation links have a minimum height of (44px). Helm controls follow the same target size; its collapse button and run-viewer icon controls use (44px) squares. Fine-pointer-only layouts retain their compact sizes.

### Personal theme editor

Config exposes one always-visible theme editor. A code-rendered OKLCH color wheel chooses hue by angle (0° right, 90° top, 180° left, 270° bottom) and brightness by radius (white center to black rim); Saturation adjusts its coloration. A white-and-black selection ring stays visible across the wheel; its keyboard-focus outline uses the derived neutral text color outside the rainbow field. Mouse and touch drags capture the pointer and clamp at the rim; cancel, removal and destruction release it. The focusable labeled wheel accepts Left/Right for hue and Up/Down for brightness, with Shift for ten-unit steps; native sliders provide precise accessible alternatives. The wheel and sliders update together without replacing controls, and preserve palette sources and advanced overrides. Desktop places the wheel beside the sliders; small screens stack them. Canvas painting coalesces saturation/resize changes, caps its internal raster at 256 pixels, and uses the same gamut mapper as theme generation; hue/brightness updates move the marker without repainting. Native Hue (0–360°), Saturation (0–100%) and Brightness (0–100%) sliders preview the generated palette immediately without remounting controls or losing keyboard focus. Native slider tracks and thumbs use `input-accent`, derived from the accent to at least 4.5:1 against the independently adjustable input ground. A native icon button after the Color harmony selector toggles appearance: moon for Dark, sun for Light. Its Dark appearance label and pressed state expose the current mode to assistive technology; Color harmony selects Analogous, Complementary, Triadic, Tetradic, Square, Monochromatic, Shades or Split complementary. The default is dark with analogous harmony. Available user-supplied five-color presets are Ember Tide, Olive & Copper, Festival, Spring Tide and Daydream. Five-color presets preserve their original hue relationships through Palette colors harmony. Seed lightness assigns background and text roles; the middle colors supply primary accent, companion and panel seeds, ranked by chroma. Controls derive bounded, contrast-adjusted role colors from those seeds; explicit overrides still apply last. Preset definitions accept a name and exactly five six-digit hex colors; the source colors remain stored with the recipe. The Terminology reference disclosure occupies its own full-width row below the Pirate mode setting.

Advanced color overrides use a closed native disclosure with individual non-status color inputs, including Input background. Explicit overrides survive generator changes. Reset overrides clears them; Reset theme previews dark default settings with no overrides. Save theme writes palette and recipe atomically to the browser; Discard changes restores the saved recipe and appearance. Storage errors keep the preview and expose retry guidance. Status hues are never editable.

### Inputs / Fields

Inputs, selects and textareas share field ground, field boundary and control corners. Authored-plugin fields use (6px 12px) padding; launch uses (7px 9px), and global fields use (6px 9px). Keep labels visible, preserve native behavior, and use accent borders plus the visible contrast-derived focus outline. Launch textareas have a (110px) minimum height and resize vertically. Errors retain explicit alert text.

### Navigation

Desktop destinations form a vertical theme-derived rail. Hover and selection use the active navigation surface; selection adds a boundary and stronger weight. Small-screen destinations form an overflowing horizontal row. Panel tabs share a header with collapse: selected tabs fill with the accent when multiple tabs exist; a single tab stays neutral. The collapse icon rotates over (160ms), with reduced-motion support.

Config and Runs remain selected in primary navigation throughout their child pages. Their secondary navigation starts with Overview, followed by sibling destination links. Overview is current on the parent page; a child page marks its exact destination with `aria-current="page"` while its primary parent remains selected. Config includes Task sources, Execution, Product feedback, Jira, GitHub, Notifications and Local Git; Runs includes History and run details. Config Overview uses this row as the single location for those destinations. Destination labels follow terminology settings and selected replacement pages. Links preserve the header scope; a directly opened alternative page receives its own current link when it differs from the selected destination.

Jira and GitHub links in Config include (16px) status icons in the navigation foreground. Distinct check, warning, slash, question and clock shapes identify verified, unavailable, not configured, unknown and checking states; hover text and accessible descriptions explain each result while preserving the link name. Jira verifies account authentication; GitHub also verifies pull request access for the header galleon when selected. Checks refresh on Config navigation, scope changes, explicit refresh and successful credential updates, with a bounded cache and no background polling.

Secondary links use the navigation type role and control corners. Hover increases the contrast of the band’s text; the current destination uses an inverted fill and ink with stronger weight (650). Keyboard focus uses a (2px) band-text outline inset by (2px), switching to selected ink on the current destination. These are native links in a named navigation region, with the current destination revealed by horizontal scrolling without moving page content.

Campaign panels use “Use top selection” to restore the galleon selection made at the top of Helmsman. The PR page inherits that selection without a permanent reset control. Inspection leads the page, with selected detail and diff immediately below it. Close inspection appears for a selected PR and remains available if closing fails, so restoring the top selection can be retried without changing it. The composed page owns one Refresh action; a standalone PR panel retains its own. PR lists use independent-height desktop columns and document flow on mobile, without inner list scrollbars. Full-width title-first selection controls lead each row; PR number, state, date and known meaningful counts are subordinate. Compact notices distinguish confirmed empty lists from incomplete reads, retain readable results, and offer a scoped full-list action. Recent PR runs sit after the lists in a collapsed native disclosure that preserves its open state during refresh.

### Cards / Containers

Authored Helm stacks use panel ground, a thin semantic line and panel corners. Header padding is (8px 12px); body padding follows the responsive layout above. Repeated local plugin headings are visually hidden only under a named composed tabpanel. Standalone headings remain visible.

### State labels and work rows

Running/recent work uses a prominent linked title, technical identifier, compact outlined state and aligned evidence. State labels use (2px 8px) padding and control corners. Row separation uses the semantic line; the last row removes it. Titles wrap as needed, evidence wraps independently, and narrow-screen order keeps identity ahead of state and actions. Theme-preview status chips use sentence-case sans with compact corners.

Recent run icons use locally hosted Phosphor Regular, including worker states, inspection metadata, Retry and Refresh. Pending source settlement uses an hourglass to distinguish it from the start-time clock. Recent runs lead with the PR/task link and a compact worker-state icon; galleon scope appears only in unfiltered lists. Review recommendations use labeled semantic color above the explanation; repeated verdict prefixes are omitted. A subordinate evidence row groups a clock, attempt icon and count, observed spend when available, source settlement, and a linked 12-character run digest. Icon details appear on hover, keyboard focus or tap and dismiss with Escape or a second tap; accessible descriptions retain the complete state and timestamp. Operator-required settlement keeps a visible Needs action label. Internal `slack-` and `created-` prefixes stay out of visible identifiers; links retain full run IDs and header scope. Retry and Refresh use compact labeled icon buttons, and a semantic divider closes the list above pagination evidence and footer navigation. Recent rows use (20px) vertical separation and adapt to their panel width; touch inspection targets span at least (44px).

Underway follows Recent’s title-first index rhythm with 18px task titles, 20px row spacing and subordinate 13px identifiers. Phosphor state icons use semantic ready/done, active, review and blocked colors. Priority flags show P-prefixed values, with urgent priorities in warning/error colors; unknown priority shows a question mark. A lock replaces repeated launch-readiness prose. State, priority and readiness details remain accessible on hover, focus and tap, with Escape dismissal. Refresh and recorded-run links use labeled icons; pull-request links keep their number and Launch keeps its label. Icons and their license ship inside the standalone panel package. Coarse-pointer targets span at least 44px.

Activity uses compact per-source seven-day count strips, with known nonzero counts in success color and unknown counts shown as labeled question marks. Scope labels appear only when they differ from the header selection. Native warning disclosures retain history quality and missing-evidence explanations without dominating the timeline. Events lead with the original task or pull-request title, followed by labeled Phosphor event states and a subordinate technical identifier, source and readable UTC time; full timestamps remain on time elements. Opened PRs use review color and merged/completed events use success color. Refresh is a labeled icon button. The standalone Activity package includes its Phosphor font and license.

The degraded-state banner uses a (6%) accent tint mixed into panel ground, a strong semantic boundary and bright accent text. Its tint follows the selected theme.

PR inspection uses the stronger panel-hi ground and an accent-filled Load action, with paired accent ink. Lists retain neutral panel ground; recent history recedes to canvas ground. Local Phosphor Regular icons identify sections, review actions and labeled states. Red marks failures and requested changes, green marks success, blue marks review, and yellow marks pending checks. Status labels stay readable independently of color; icons and their license ship with the standalone plugin.

Triage has one composed Refresh and page heading, with a standalone fallback. A contrasting panel-2 filter band groups labeled source, priority, update window and page-size controls. Backlog, To do and My open work columns use panel-hi headers over panel ground; source context is subordinate and the header galleon is not repeated. Same-label sources retain distinguishing instance identifiers. Task titles use readable body ink, with ticket identifiers, readable UTC dates, labeled states and priority flags below. Local Phosphor icons identify task states, priority and launch. Description toggles and contextual assignment, launch and related-run actions stay compact; columns flow vertically on small screens, with 44px coarse-pointer controls. Saved selection, filters, descriptions, collapse state, paging and command recovery remain intact; unsupported saved selection still permits choosing a source.

Terminal is a global view of the connected terminal app, explicitly independent of galleon scope. It selects All through the public panel scope service before reads, including for old saved scoped panels, and fails closed with Refresh guidance if scope restoration fails. The header galleon selector is hidden on Terminal routes while its selection stays mounted and returns unchanged on other pages. The composed page owns the single heading and Refresh; standalone panels retain their own. A contrasting connection band and compact tab rail lead into the dominant plaintext screen preview. Connected with no open tabs and unavailable connection have distinct compact empty states. Phosphor icons accompany connection and control labels; fonts and licenses ship inside the plugin. Polling preserves screen scroll, input focus and per-target drafts. Keyboard capture remains explicit, and every control and saved receipt retains its original target and request identity. Tab previews show the latest user prompt when the native provider can bind it to the active agent transcript, with a three-line plain-text preview and full supplied text in a tooltip. Unsupported or unreadable prompts use an explicit unavailable state. Prompt changes preserve the focused tab button and never alter control identities.

### Loading and focus continuity

Deferred page loading presents readable status text with `role="status"` and marks its host busy. Hidden, unmounted panels wait until visible to load. Existing error recovery remains available when loading fails.

Campaign and New Run redraws preserve the focused action or disclosure by identity, including when labels or request order change. If that control disappears or becomes disabled, focus falls back to Refresh or the panel container without scrolling. Campaign stop and finish confirmations focus the cancellation action first; dismissing returns focus to the originating action. Retained text fields keep their selection.

### Startup scope

The startup repository selector uses the semantic panel background directly, including outside the application shell. It shares panel corners, (24px) padding and a bounded width of `min(100% - 32px, 540px)`. Boot HTML uses the default dark work ground and text colors as fallbacks before runtime theme application; the generated personal theme then controls these properties.

### Logs, disclosures and page editing

Run logs use the mono log role, (12px) padding, control corners, neutral panel ground and a thin boundary. Their own viewport spans (100px) minimum to (420px) maximum height; the dock adds its host bound. Advanced launch settings, log docking and footer About use native disclosures with visible summary focus.

The 16 generic composition pages and both Helm implementations keep compact Refresh and Edit icon buttons in the page header. Edit changes to Done while active and reveals a region named Page customization. Add panel and per-panel Hide/Show and Remove controls appear only in edit mode; ordinary stacked tabs remain usable in either mode. Removing a panel updates the saved layout and disposes only that panel, without stopping its underlying work. Edit state and the focused action survive page redraws.

**The Bugs Hierarchy Rule.** Bugs has one composed heading and Refresh, with a standalone fallback. A contrasting panel-2 band contains a visibly labeled Source selector; header galleon scope remains the default, and duplicate source labels retain distinguishing instance identifiers. Source reports use panel-hi headers over panel ground. Four aligned counts lead the report, with oldest-open and resolution-time evidence below. Exact zero, approximate counts, unavailable values, partial coverage and capped samples remain distinct. Observation and due dates use readable UTC formatting while retaining raw values. Bug titles lead each row, followed by ticket keys and compact description controls; mobile rows keep labeled priority, severity and due metadata in document flow. Local Phosphor icons identify counts and controls, with fonts and licenses packaged inside Bugs. Description expansion and focus survive refresh; stale same-scope reports remain readable with explicit notices, while scope, source selection or source revision changes clear old results.

**The Voyages Hierarchy Rule.** Voyages preserves the saved PR and history composition and panel scope. A distinct history section uses a labeled status filter and one composed Refresh action, with a standalone fallback. Rows lead with the supplied task title, compact worker status and a separate review recommendation; feedback state remains distinct from worker completion. Operator-required source settlement keeps a visible Needs action indicator. Native Details holds full run identity, attempt, exact timestamps, full verdict and settlement evidence, preserving supplied text. Readable UTC dates and quiet spend metadata keep the list scannable. Details and focus survive redraws; same-scope failed refreshes retain the last observed page with explicit notice, while successful new observations reset paging. Local Phosphor icons identify history, status and timing; fonts and licenses ship in the independent history package. Shared PR lists use compact status labels, readable UTC creation dates with exact tooltips and meaningful count icons.

## Do's and Don'ts

### Do:

- Do use semantic theme properties so generated colors and advanced overrides apply consistently.
- Do present task titles, labeled states and subordinate evidence in the shared index-like rhythm.
- Do preserve the accessible heading when suppressing a repeated visible panel heading.
- Do keep tab selection and collapse together, and preserve saved panel order when adapting to a narrow screen.
- Do use visible focus outlines and honor reduced-motion preferences.
- Do provide coarse-pointer targets of at least (44px) without increasing fine-pointer-only density.
- Do preserve keyboard focus through redraws and expose loading with readable status text.

### Don't:

- Don't restore brushed-metal panels, seven-segment counts or the oscilloscope treatment as the default visual language.
- Don't use monospace as the general control or prose face.
- Don't use a status hue as the only way to identify state.
- Don't turn a viewport change into a saved layout edit.

Source evidence: `index.html`, `src/style.css`, `src/themePreview.css`, `src/data/themes.ts`, `src/data/themeGenerator.ts`, `src/renderCustomThemeEditor.ts`, `src/render.ts`, `src/logic/navigation.ts`, `src/main.ts`, `src/plugins/helm/styles.ts`, `src/plugins/helm/page.ts`, `src/plugins/running/panel.ts`, `src/plugins/recent/panel.ts`, `src/plugins/repoprs/panel.ts`, `src/plugins/newrun/panel.ts`, `src/plugins/campaigns/panel.ts`, `src/plugins/lazy-modules.ts`, `src/plugins/page-host.ts`, `src/plugins/panel-host.ts`, `src/plugins/composition-host.ts`, `src/plugins/run-viewer/styles.ts`, `src/plugins/run-history/styles.ts`, and `src/plugins/communication/styles.ts`. Direction: `.impeccable/surfaces/src-main-ts.md`.

Task sources uses content-sized action buttons and wrapping action rows; text inputs, selectors and textareas use the available form width up to 40rem. Persistent field labels and linked helper text explain source-wide availability, allowed galleons, saved source selection and automatic starts for the current server session separately. Saves apply drafts; selecting sources does not launch work, and turning off automatic starts keeps existing runs going. Technical source/request identities and connector artifact hashes remain available in native disclosures. Replacement controls start collapsed and retain their open state across redraws. Provider fields explain JSON list/map formats, show default/custom state and update reset actions immediately after edits; resetting a field returns focus to its input. Compact controls retain 44px targets on touch devices.

Settings evidence: `src/plugins/github-settings/page.ts`, `src/plugins/github-settings/panel.ts`, `src/plugins/jira-settings/page.ts`, `src/plugins/jira-settings/panel.ts`, `src/plugins/communication/page.ts`, `src/plugins/communication/settings.ts`, `src/plugins/execution-settings/page.ts`, `src/plugins/execution-settings/panel.ts`, and `src/plugins/source-settings/panel.ts`.

Not canonized or repaired: retained legacy lamp glow, uppercase mono status rules and hard-coded amber tints in `src/style.css`, plus glyph icons in compatibility/notification markup, fall outside the selected Field Guide language. Loaded DSEG7 assets do not establish a current type role. PRODUCT.md still describes the previous visual world; it is outside this documentation write boundary.
