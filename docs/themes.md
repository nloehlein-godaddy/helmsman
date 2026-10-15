# Personal theme

Helmsman has one browser-local custom theme. Open **Config → UI customization** to edit it.
Changes preview live across the interface; **Save theme** persists the recipe and palette,
**Discard** restores the saved appearance, and **Reset theme** previews the defaults.
The loading screen uses the saved palette too.

## Generate a palette

Choose hue, saturation and brightness with the wheel or sliders. White is at the wheel's
center and black at its rim. The sun/moon control switches light and dark appearance.
The generator derives backgrounds, panels, navigation, accents and text using OKLCH.
Available harmonies are analogous, complementary, split complementary, triadic,
tetradic, square, monochromatic and shades.

Five-color presets—Ember Tide, Olive & Copper, Festival, Spring Tide and Daydream—provide
starting palettes. Their colors are assigned to UI roles rather than applied in the
order supplied. The default generator uses hue 165°, saturation 35%, brightness 45%,
analogous harmony and dark appearance.

**Advanced color overrides** adjusts individual non-status roles, including the input
background. Overrides survive changes to the generator; **Reset overrides** clears them.
Error remains red, success green, review blue and queued yellow.

## Readability and persistence

Surfaces, body text, action labels, controls and semantic states have separate roles.
The theme derives readable foregrounds instead of using a chosen accent directly as
text on every surface. Editable fields use an independent `--control-bg`, contrast-aware
input text and placeholders, and an opaque `--control-border`. Focus uses the readable
accent text color.

The saved version-3 recipe and five-color source, when present, live under
`cmux.theme.custom` in browser local storage. Saving one theme replaces the previous
personal theme; it does not create a separate theme catalog or server-wide preference.
Pirate mode is a separate preference and does not alter user content or technical text.

`src/data/themes.test.ts` and `src/data/themeGenerator.test.ts` check generated palettes,
text contrast, action labels, control outlines and saved recipes. Browser contrast checks
cover rendered surfaces, including composite notice backgrounds. Token checks alone do
not certify every UI state.
