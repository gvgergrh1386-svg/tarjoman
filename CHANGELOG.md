# Changelog

## 3.8.2 — unified interface and visual identity

- A new teal mark, shared typography, spacing, surfaces, controls and state treatments connect the popup, settings, subtitle workshop, X, translation cards, screen selection, manga and video tools. Light/dark themes, existing presets and individual appearance overrides remain available.
- The popup puts page actions and the active engine first. A searchable settings directory also opens as a full browser tab with persistent navigation, using the same controller and storage. Denied engine access preserves the previous choice and explains the outcome in both views.
- The subtitle workshop separates file intake, project settings, review and export, while preserving import formats, manual edits, row locks, saved projects and audio workflows.
- YouTube and web video docks offer neutral glass, solid dark and app-theme modes. Monochrome YouTube icons, themed language/model fields, clearer tabs and grouped audio/display settings fit the player. Video-safe rendering, reduced transparency, high contrast and keyboard focus are respected.
- Version, companion, package and installation documentation are aligned at 3.8.2. No additional permissions, remote executable code, UI framework or translation-engine replacement was introduced.

See [verification report](docs/release-3.8.2.md), [گزارش فارسی](docs/release-3.8.2.fa.md) and [design system](docs/design-system-3.8.2.md).

## 3.8.0 — lifecycle, screen translation and data integrity

- Screen translation now uses the shared card API correctly and displays successful, empty, partial and failed results. Each operation owns cancellable capture, selection, OCR and translation work; closing or replacing it releases its port, heartbeat and media resources.
- Page and selection translations retire stale results when output settings or manual memory corrections change. Image and manga context-menu responses carry request identities; recycled host images are not overwritten or restored to an unrelated source.
- Popup diagnostics and cache, memory and statistics actions report actual failures instead of false success. Known browser-restricted pages disable unavailable page actions with an explanation.
- OpenAI output stopped by token limits or content filtering is rejected even when partial text is present and is not stored as a successful result.
- Subtitle text detection includes Unicode letters beyond the previous script ranges. Older projects retain edits while gaining newly recognized rows; current project snapshots reject missing rows. Subtitle and audio filenames use the project's actual target language.
- Backups omit derived memory identity from editable preferences. Manifest, package, companion and installation documentation are aligned at 3.8.0.
- Expanded regression coverage includes negative replies, out-of-order responses, cancellation, durable worker restart, multilingual files, real popup navigation and same-path upgrades.

See [verification report](docs/release-3.8.0.md) and [گزارش فارسی](docs/release-3.8.0.fa.md).

## 3.7.9 — Gemini recovery and X lifecycle

- Temporary Gemini network, timeout, quota and server failures recover until success or cancellation, using backoff, jitter, service retry deadlines, key rotation and persisted cooldowns. Exhausted keys wait for their next eligible time.
- Selected Gemini text and speech models remain unchanged. Invalid requests, credentials, permissions, unavailable quota and content blocks have distinct actionable outcomes.
- Adaptive per-model request deadlines and explicit, optional Gemini safety thresholds; raw block reasons remain available in diagnostics.
- Stable pinned-post cache restoration across new posts, staged permalink hydration, reordered and recycled cards, navigation and worker restart. Output settings and manual memory corrections determine compatibility.
- Shared X requests survive card remounts and cancel only when their last subscriber leaves. Composer, image translation and read-aloud own cancellable requests; stream and port failures recover without duplicate work.
- Expanded X regression coverage includes hydration, remount races, equal-text posts, source edits, controls, cancellation, speech ownership and destination changes.
- September 26 cache follow-up: cached X posts are delivered independently of slow new posts, without a translating indicator. Reconnects resend only unfinished posts. Rebuilding an unchanged card's header or translation sibling preserves its identity and existing UI; cloned source markers cannot suppress cache restoration.

See [verification report](docs/release-3.7.9.md) and [گزارش فارسی](docs/release-3.7.9.fa.md).

## 3.7.8 — translation reliability

- Cancellable full-page requests, queues, retry waits and review; shared work remains alive for other subscribers.
- Structured generic output IDs, source-aware artifact validation and rejection of ambiguous identities, including persisted X cache entries.
- Immediate X page-cache restoration, moved-card preservation and guarded detached-result caching.
- Capability-specific Gemini thinking controls and stale-value protection across model changes.
- Project-aware quota reporting without guessed 1500 limits, multiplied key capacity or inferred/propagated caps.
- Bounded Gemini retries, Retry-After, key rotation after network failure, distinct permission errors and complete key-attempt summaries.

The reported missing X conversation modules also reproduce with Tarjoman disabled; this is documented separately rather than claimed as fixed. See [verification report](docs/release-3.7.8.md) and [گزارش فارسی](docs/release-3.7.8.fa.md).

## 3.7.7 — public-source preparation

- Persian/English UI and companion catalogs, plus Chrome metadata localization.
- Independent interface, content-target and region preferences, preserving Persian calendar/digits and explicit Iran content dates.
- Legacy migration keeps the Persian experience and existing data; fresh installations follow browser language.
- Direction-aware UI and regional formats preserve media coordinates, internal times and default Persian cache identities.
- Automatic source detection and arbitrary destination language tags across all translation sections, independent section/project overrides and target-specific caches.
- Isolated manga target adapter with external OCR/model/font requirements; no external configuration changes.
- Original Persian translation instructions and model choices retained; speech preserves the supplied language.
- Explicit public allowlist, deterministic archives, SHA-256 verification and secret/private-path checks.
- MIT license, third-party notices, bilingual guides and CI; configurable companion paths and accurate online/local privacy descriptions.

3.7.6 stable X cache identity, shared requests, stale-result protection, dubbing/audio fixes, web captions, workshop options and Gemini cache controls remain regression requirements. No repository/store publication is implied. See `docs/release-3.7.7.md` for validation and limitations.
