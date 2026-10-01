# Tarjoman 3.8.2 verification

This release implements the [shared visual system](design-system-3.8.2.md) across extension pages and injected tools. The popup adds immediate page actions and an engine selector; its settings directory also opens in a full options tab. The workshop separates import, project options, review and output. YouTube and web video docks share glass, solid and inherited appearance choices. Existing provider and persistence contracts remain in place.

## Reproduce

```text
python tools/build_i18n.py --check
node tools/build_ui.cjs --check
node tools/check_i18n.cjs
node tools/check_syntax.cjs
python tools/test_all.py
python tools/test_all.py --browser
python dev/ui-redesign-382.py
python dev/ui-surfaces-382.py
python dev/release_smoke_379.py --extension . --upgrade-from <3.8.0-runtime> --output .audit/3.8.2/installed-upgrade
python tools/build_release.py
python tools/verify_release.py --extract .audit/3.8.2/packaged-extension
```

The unchanged historical filename `release_smoke_379.py` reads versions from the supplied manifests. Chrome's disposable profiles use synthetic keys and provider responses; private user profiles are not accessed. Runtime loading uses the actual unpacked Manifest V3 extension.

## Evidence

| Check | Scope |
| --- | --- |
| 20 non-browser suites | Provider output, caches, cancellation, audio ownership, subtitle parsing, project persistence, i18n, theme contracts, local bridge. |
| 34 browser harnesses / 1,006 checks | X, YouTube, native caption handling, general video, page/selection/image/screen/manga, dub lifecycle, forced colors, semantic contrast and keyboard interaction. |
| 72 installed UI checks | Persian/English, daylight/graphite, every settings destination, focus/inert/Escape, full settings, 375px layouts, large text, real SRT import, mixed/long text, manual edit and lock persistence. |
| 35 injected visual checks | Production video controls and fields, actual repaint after saved choices, opt-in blur, focus after repaint, tab semantics, narrow player, reduced transparency, forced colors and shared card accessibility. |
| 121 installed/upgrade checks | Real worker termination and cache restoration, port cancellation, delayed requests, X cache hydration, settings persistence, same-path 3.8.0 upgrade and restored manual project edits. |
| Release validation | Generated catalog/token freshness, script syntax, allowlisted assets, manifest and CSS dependencies, ZIP integrity, exact source bytes and SHA-256. |

Reports and actual screenshots are under `.audit/3.8.2/`. The upgrade preserves extension identity, synthetic credentials, manual memory, theme/accent overrides, caption positions, project state and locked translations. The 36-second worker request is checked after detaching its debugger so the debugger cannot conceal an idle-lifecycle failure.

The build adds no dependency, broad permission or remote executable content. CSP remains unchanged. Fonts and the vector-derived icons are bundled; model and translation calls retain the existing implementations.

## External-site limits

The initial unauthenticated test session returned empty HTTP 200 caption bodies and unsuccessful fallbacks, also reproduced with untouched 3.8.0. On 2026-10-01, the user's own Chrome successfully displayed Persian Bing subtitles on the public video `jNQXAC9IVRw`. It reproduced the reported opaque UI with system reduced transparency and Dark Reader active. The corrected production player UI was then exercised in the same browser on the local preview: glass, solid and inherited modes produced distinct computed backgrounds; the glass switch enabled a 16px blur on both dock and menu and restored a white switch thumb. No theme extension or OS preference was disabled. The browser tool blocks internal extension-management pages, so refreshing the installed extension requires the user's Reload action before the final updated YouTube check.

Paid provider calls, the user's speech voices, local OCR/manga tools, and physical RTX/HDR behavior were not tested with the user's accounts or hardware. Automated validation and screenshot review are evidence for the exercised paths, not a guarantee against every site or service change.

For an existing manual installation, replace files at the same path and Reload the extension, then refresh open host pages. Removing and re-adding an unpacked extension at a different path may create a different identity and storage area.
