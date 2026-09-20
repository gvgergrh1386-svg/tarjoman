# Locale and release architecture

The MV3 worker remains the authority for serialized settings mutations. Documents and isolated content scripts load `shared/settings.js`, a reproducible bundle of catalogs, `i18n.js` and `settings-core.js`. Chrome metadata uses `_locales`. UI translation uses no remote service.

| Category | Owner/policy |
| --- | --- |
| Labels, errors, help, examples, empty states | fa/en catalogs, explicit bindings and HTML data attributes |
| Model names, URLs, shortcuts, identifiers | Technical values, isolated left-to-right where needed |
| UI direction | i18n and theme tokens on extension-owned roots |
| Content direction | Explicit content target, separate from toolbars |
| Caption geometry | Existing coordinates/media timeline, never mirrored |
| Numbers/calendar/clock/timezone/relative time | Intl and independent region preferences |
| Stored dates/cache timestamps/subtitle timing | Existing epoch/ISO/media numbers, never locale sorting |
| Persian quality/register/terminology | Existing prompts and Persian translation memory |
| Iranian content dates | Explicit `translationRegion`, preserved Iran default |
| API quota day | Existing Pacific rollover independent of displayed timezone |
| Manga target | Selected in Tarjoman; isolated child adapter and external model/OCR/font dependencies |

Fresh settings use UI/region auto and content target fa. Supported browser languages resolve in order, otherwise English. A pre-schema settings object resolves to fa/fa-IR/Persian calendar/arabext/h23/Tehran/Saturday. `onInstalled(update)` serializes migration for profiles without a settings record too. Reads never write. Backups always carry `localeVersion:1`; migration is idempotent.

UI/display region never enter content-cache namespaces. Default Persian namespaces remain; explicit non-Persian target/source-date behavior has its own suffix. Persian memory is neither injected nor learned for non-Persian targets. YouTube/project overrides remain scoped. Model selection, stable cue IDs, coalescing and dubbing state machines remain separate.

`t` supports named placeholders and Intl plurals; `html` escapes output. Trusted markup templates retain caller escaping and are compared in parity tests. UI bindings re-render only unchanged owned values and retire detached elements. They do not translate host-page text. Popup language changes rebuild that popup's navigation, never the browser. Open workshop/floating labels update through storage listeners without changing edits.

`tools/public-files.json` holds exact source/extension lists. Builds scan public text for secret/private-path patterns, reject unsafe paths, validate syntax/locales and produce archives with fixed metadata and hashes. Verification checks exact sets, checksums, byte equality and manifest dependencies. `release/source` is a clean allowlisted export; audits, dependencies, credentials, bridge jobs and profiles are excluded.

Static checks reduce accidental hardcoded strings; they cannot prove translation quality or absence of every secret. See the release report for actual evidence and live-service limitations.
