# Tarjoman 3.7.7

[فارسی](README.fa.md) · [User guide](docs/guide.md) · [Privacy](PRIVACY.md)

Tarjoman is a Chrome Manifest V3 extension for translating posts, pages, images and subtitles. Its interface is available in Persian and English. Choose the interface language, translation language and regional formats separately.

## Features

- X/Twitter translations with persistent caching, shared requests and protection against stale responses.
- Page and selection translation, summaries, image text translation and read aloud.
- YouTube subtitles and dubbing; opt-in caption and audio tools for other web players.
- Subtitle workshop with file import, editable translations, locked rows, local projects and export.
- Manga tools through an optional local companion and a separately installed translator.
- Gemini, OpenAI-compatible endpoints, Google Translate and Bing; configurable appearance and translation memory.

Capabilities depend on the chosen service, permissions, available captions and optional local tools. This project does not include accounts, API keys, voice models or external manga software. Provider quotas and availability vary.

## Install

1. Extract `Tarjoman-3.7.7-Chrome.zip` to a permanent folder.
2. Open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select the folder containing `manifest.json`.
3. Open Tarjoman. In the translation-engine settings, select a service and enter your own key if required. Grant optional website access only for features you use.
4. Under **Language and region**, select **Automatic**, **Persian** or **English**. The default translation target remains Persian.

Chrome 116 or later is declared in the manifest; release testing uses current desktop Chrome. Browser-internal pages and restricted store pages cannot be translated. Unpacked installation is for desktop Chromium browsers; store publication is a separate step.

For an existing unpacked installation, replace files in its **existing folder** and press **Reload** on its extension card. Loading from a new path can create another extension identity and separate storage. Export a backup first, keep it private, and do not uninstall the existing extension to upgrade. See the [guide](docs/guide.md#upgrade-and-backup).

## Languages and regions

Fresh installations follow a supported browser language, falling back to English. Older settings retain Persian, the Persian calendar, Persian digits and Tehran time until changed. UI language does not alter translation caches or saved content. Source language is detected automatically. Choose a destination from the language suggestions or enter a language tag such as `fr`, `ja`, `ar`, `hi` or `pt-BR`. X, composer, page/selection, image, summary, web video, files and manga have independent target controls; `inherit` follows the general target. YouTube and workshop projects also have target controls. Changing a destination starts a separate translation cache. Availability and quality depend on the selected translation, OCR and speech service; this is not a promise that every provider supports every language.

## Develop

Requires Python 3.10+ and Node.js 20+; Chrome for browser tests. No JavaScript framework or runtime package installation is required to load the extension.

```sh
npm ci
python tools/build_i18n.py --check
node tools/check_i18n.cjs
python tools/test_all.py
python tools/test_all.py --browser
python tools/build_release.py
python tools/verify_release.py
```

The build uses an explicit file list, fixed ZIP metadata and SHA-256 checksums. [Development and testing](CONTRIBUTING.md), [architecture](docs/architecture.md), [release notes](CHANGELOG.md), [verification report](docs/release-3.7.7.md).

## Privacy, support and license

Content goes directly to the selected provider or local companion. Settings, keys, translations and projects can be stored on this computer. There is no developer-operated telemetry endpoint in this release. Read [Privacy](PRIVACY.md) before sending sensitive content, and [Security](SECURITY.md) for vulnerability reports.

Report reproducible issues using the repository's issue template after it is published. No public repository or support address is assumed by this source distribution.

Project code is [MIT licensed](LICENSE). Bundled fonts retain their own licenses; see [third-party notices](THIRD_PARTY_NOTICES.md).
