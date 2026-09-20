# User guide

[فارسی](guide.fa.md) · [Home](../README.md)

## Translation services

Open translation-engine settings in the popup. Gemini uses your Google AI Studio key. OpenAI-compatible mode accepts a base URL, model ID and optional key, including a local server. Model IDs and URLs are technical values and stay left-to-right in both interfaces. Choose a model available to your account; refresh discovery if it is unavailable. This release preserves existing model choices and does not silently select a cheaper model.

Google Translate and Bing offer keyless requests through their web endpoints. Their availability, limits and terms are controlled by those services. Retries and fallback choices can make additional requests. Optional context caching sends instructions to Gemini for provider-side reuse; disable it in settings if unsuitable. Custom prompts, glossary terms, context and translation-memory hints may accompany source text.

## X, pages and images

X can translate automatically or expose a manual translate control. Reopening identical content can reuse a cached result; explicit retranslation requests fresh content. Use the popup or context menu for a page, selection or summary. Page options include original-plus-translation, dynamic content and per-site preferences. Cross-origin images and other websites can require additional host permission. OCR and image translation are different: local screen OCR extracts text on your computer; an AI image translation can send the image to the selected provider.

## Subtitles and dubbing

On YouTube, use the player controls to translate available captions and select the YouTube-specific target/provider. Other web players require enabling web-video tools and granting site access. Native tracks, network restrictions and DRM can limit availability. Drag captions to reposition them; stored coordinates describe player geometry, so changing UI language does not mirror their position.

Dubbing starts from a user action and manages original audio while synthesized audio plays. Caption-based dubbing needs suitable captions and a configured speech service. Gemini Live audio dubbing sends captured audio to Gemini. Seek, pause and stop controls retire stale work; a natural ending allows queued speech to drain. Some services incur usage charges or quotas. Voice/model choice is independent of the UI language.

## Subtitle workshop

Open the workshop from the popup and choose a subtitle or supported text file. The editor retains source text and stable row IDs. Translate, edit individual rows, lock manual edits, save a project and export. Project provider/model/temperature/prompt and target overrides do not overwrite global choices. The general backup does not include the workshop IndexedDB database: export important projects/files separately before removing the extension or clearing its data.

## Translation destinations

Source language is detected automatically. Choose a destination from the language suggestions or enter a language tag such as `fr`, `ja`, `ar`, `hi` or `pt-BR`. X, composer, page/selection, image, summary, web video, files and manga have independent target controls; `inherit` follows the general target. YouTube and workshop projects also have target controls. Changing a destination starts a separate translation cache. Availability and quality depend on the selected translation, OCR and speech service; this is not a promise that every provider supports every language.

## Language and regional formats

**Interface language** controls labels and layout. **Translation language** controls new content requests (any valid language tag supported by your service). **Regional formats** control displayed numbers, calendar, time, digits, first weekday and timezone. You can combine an English interface with Persian translation and Iranian date display. The weekday preference is available to locale-aware views; this release has no week-grid calendar to rearrange.

The separate **Dates in translated content** preference preserves the existing Iran-aware date guidance by default. Choosing source dates changes content instructions and the associated cache identity; changing display formats does neither. Technical timestamps in SRT/VTT, logs, identifiers and stored epoch values remain machine-readable. Native Chrome extension names and command descriptions follow Chrome's locale, independently of the in-extension language selector.

## Local bridge and manga

See [bridge installation](../bridge/INSTALL.md). The companion is optional and listens on loopback. Pair its token in local-bridge settings. Screen OCR, transcription and optional external tools require their respective installations. Edge speech still uses Microsoft's online service. Choose the manga destination in Tarjoman. The companion passes it to an isolated adapter process for non-Persian output; Persian retains the original integration path. The adapter changes translation and typesetting only in that child process, without saving the external app configuration or learning into its Persian glossary. External provider credentials remain managed by MangaTranslator. Set `TARJOMAN_MANGA_FONT` to a compatible installed font file if the configured font lacks target glyphs. Complex scripts may require a Pillow build with Raqm in the integration environment; missing glyph/layout support reports an error instead of silently drawing unusable text. Adapter contracts were tested with deterministic fixtures; full OCR, model and page rendering against external installations were not exercised. No external tool or model is silently installed.

## Upgrade and backup

Export settings first. Keys are excluded unless you opt in; translation memory and custom configuration may still be sensitive. Keep backups private. Close active translation jobs, replace the files in the same unpacked-extension folder, then use Chrome's extension-card Reload. Existing settings lacking a locale schema are migrated to Persian/IR defaults while preserving other data. Removing and reinstalling can remove extension storage. Loading another folder may produce another identity.

## Troubleshooting

- No translation: check provider/model/key, quota, network, site permission and the master switch. Browser-internal pages are restricted.
- No voice/model: refresh discovery, start the companion if selected, and verify the dependency in the same Python environment.
- Bridge not paired: verify port, fresh token and extension permission for loopback. Do not expose the port to the network.
- Unexpected language: check interface, general target, YouTube target and project override separately.
- Report a bug with version, browser, locale, reproduction and redacted logs. Never attach a profile, full backup or key.
