# Tarjoman 3.8.2 design system

The interface is organized around reading and translating. Teal is the action color; neutral graphite and daylight surfaces carry long content. The mark is a geometric Persian ت, authored as a local SVG and rasterized for Chrome's extension icons. Existing theme IDs and user overrides remain valid.

## Surface map

| Surface | Structure and behavior |
| --- | --- |
| Popup | Page translation, summary, screen text and reading; active engine; shortcuts to workspaces; searchable settings directory. |
| Full settings | The same settings controller and storage, opened through `options_ui`; persistent rail on wide screens and a compact layout below 740px. |
| Subtitle workshop | Import/project library, file facts, project options, editable review table, export/audio. The library compacts when a project opens. |
| X | Compact translation metadata and action rows; quiet separators, readable original/translated text, explicit retry and loading states. |
| Page, selection, image, manga | Shared shadow-root card, title and action rows, scoped controls, readable error details, progress and cancellation. |
| YouTube | A compact video dock, caption/dub/appearance tabs, status summary and themed form fields. Caption position and native-control placement retain their existing geometry. |
| Other web video | Matching dock, source and engine selection, progressive audio/display disclosures, subtitle import and existing actions. |
| Screen selection | The shared palette and typography, bounded directional instructions, clearly outlined selection. |

## Implementation contracts

- `shared/theme.js` owns semantic colors, contrast calculations, typography, spacing, shape, motion and player tokens. `tools/build_ui.cjs` generates `shared/ui-tokens.css` for a consistent first paint. `shared/ui.css` supplies low-specificity primitives for extension pages.
- The default reading surface is solid, accent emerald `#0f766e`, graphite background `#101716`, daylight background `#f3f5f3`, base corner radius 10px and shadow strength 0.55. Presets, custom colors, density, scale, shape, opacity and motion settings remain independent.
- `uiVideoStyle` selects `glass`, `solid` or `inherit` for both the video dock and its menu. Neutral glass uses white glyphs on a 66% dark scrim and a more opaque menu for reading. Explicit glass is independent of reading-card opacity and system transparency reduction; `inherit` honors both. The video safety setting forbids backdrop reads by default. A switch in the video appearance pane enables blur; it also explains the tradeoff with hardware video enhancement.
- YouTube sends initial and changed settings to the shared theme host in production, so choosing a style repaints the actual controls immediately. Open settings stay visible during native autohide, while overlapping YouTube menus still take precedence.
- Injected self-themed styles use Dark Reader's stylesheet exemption (`stylus`) to preserve the user's Tarjoman palette. This does not disable Dark Reader or change the surrounding site's theme. See [Dark Reader's stylesheet selection](https://github.com/darkreader/darkreader/blob/main/src/inject/dynamic-theme/style-manager.ts).
- Interface direction and translation direction are independent. Logical layout, isolated Latin fields and direction-aware switch travel support Persian and English. The subtitle font, position, scale and target retain their existing settings.
- Native buttons, selects, ranges, inputs and details provide keyboard behavior. Dialog focus returns to its opener; YouTube tabs support Home/End and directional arrows. Forced colors preserve outlines and vector glyphs. Reduced motion is honored.
- `popup/workspace.js` owns the settings shell; `pages/workshop-shell.js` observes existing project state and owns workflow navigation. Translation and persistence stay with their existing controllers.
- No new dependency or permission is required. Fonts, icons, styles and scripts are bundled locally. CSS is scoped to extension pages or the existing content isolation boundaries.

## Decisions and references

A full settings tab gives model, glossary and backup tasks enough space without adding a browser permission or a second settings implementation. The [Chrome side panel API](https://developer.chrome.com/docs/extensions/reference/api/sidePanel) was reviewed; this release uses the existing options-page mechanism instead.

Control size and visible keyboard focus were assessed against [WCAG target size](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum) and [focus not obscured](https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum). Automated contrast and keyboard checks support this implementation; they are not a formal accessibility certification.

## Maintaining the UI

Edit the source catalog in `locales/fa.json` and `locales/en.json`, then run `python tools/build_i18n.py`. Edit visual tokens in `shared/theme.js`, then run `node tools/build_ui.cjs`. CI rejects stale generated outputs. The release allowlist validates nested CSS imports and bundled font/image references.

Run the focused browser suites while changing a component. `dev/ui-redesign-382.py` audits installed extension pages; `dev/ui-surfaces-382.py` audits injected production UI on synthetic fixtures. Both save actual Chromium screenshots for visual inspection under `.audit/3.8.2/`.
