# Tarjoman 3.7.9 verification report

Prepared on 2026-09-24 and revised on 2026-09-26 following the intermittent X cache report. The release number remains 3.7.9. This release preserves the selected model and keeps recoverable failures in the background.

## Gemini recovery

Network failures, local and service timeouts, HTTP 429 and temporary server failures no longer exhaust a small retry budget. A logical operation owns one retry loop, per-key/model leases, increasing waits, positive jitter and the service's Retry-After/RetryInfo deadlines. When all eligible keys are cooling down, the operation waits for the nearest deadline. Daily quota waits respect the Pacific reset. Cooldowns survive service-worker restart. Invalid keys are parked; model permissions and explicitly unavailable project quota are checked across the remaining keys before a terminal failure.

Cancellation releases queues, timers, leases and owned requests. A shared translation continues while another subscriber still needs it. Transient HTTP-body or stream corruption can recover repeatedly; a valid envelope containing consistently unusable model output instead ends with a format diagnosis after at most four attempts. Credentials, invalid arguments, missing models, content blocks and caller cancellation do not enter an endless retry cycle.

The initial deadline is 120 seconds (90 for Lite). Successful latency samples and local timeouts adapt it per model up to 240 seconds. Streams use an idle deadline. These are engineering defaults, not a measured performance claim for Gemini 3.8: this audit used synthetic provider responses, without personal keys or paid requests. Model renaming and overload never silently select another model, including speech.

Safety failures retain promptFeedback, finishReason, safetyRatings and the service's explanatory message. Safety, recitation, restricted content, account policy restrictions and malformed output are separated from transport and quota failures. An explicit popup setting controls the four common configurable harm categories, using the provider default unless the user chooses otherwise. Unsupported thresholds fail visibly; mandatory protections remain the service's responsibility and are never silently bypassed.

## X root causes and fixes

The new reproduction initially failed two checks on the original code: a warm pinned post was sent again when its replacement card temporarily lacked its permalink, and a recycled card could keep its loading state after only a sibling permalink changed. DOM reconstruction, rather than a changed pinned source, was being interpreted as a changed identity.

The identity lookup now remembers only exact, unambiguous source/author/link fingerprints that were previously associated with a real status ID. A cold card with an unfinished timestamp link waits for hydration. It never takes an adjacent post's identity. Changes to article metadata are observed, extension-owned link clones are excluded, and detached results remain useful for compatible remounts. New neighboring posts and card order are absent from the cache identity.

Page and worker sharing now cover duplicate cards, remounts and multiple tabs, including waits longer than the old two-minute expiry. Each subscriber can cancel independently. A brief remount grace period prevents React virtualization from repeatedly restarting valid work. Port heartbeats and bounded reconnect waits recover after a worker connection is lost. The worker checks persistent cache before sending content to a provider.

Compatibility includes the source and its real links, selected provider/model, X destination, prompts, glossary, tuning, safety and manual memory corrections. Appearance changes, unrelated destination changes and automatically learned memory do not invalidate an unchanged pinned post. Existing pinned memory is fingerprinted on upgrade; legacy entries without an equivalent output-policy identity can require one fresh translation. Cache clearing or eviction also requires translation when no valid entry remains.

Composer and image actions cancel on close, replacement, source changes and shutdown. X read-aloud now cancels Gemini synthesis and its queue; removal of a speaking card stops that card's own session. Manual stop is kept separate from a service failure.

## September 26 X cache follow-up

The original 3.7.9 tests counted provider requests but did not require a cached item to become visible before an unrelated new item finished. A mixed batch could therefore keep an old, valid translation behind a slow Gemini request while the content script displayed a translating indicator. This was a real presentation and delivery bug even when the old post was not sent to the provider again.

The revised port delivers each completed item separately. The worker checks both current and compatible legacy caches before announcing actual translation work. Cached posts are displayed without a loading skeleton; completed provider groups and shared results also arrive independently. Only unfinished items are sent after a reconnect, and late messages from a closed connection are ignored. Existing clients without progressive delivery still receive the complete final batch.

A second reproduction removed the entire author/timestamp header in a separate DOM update. The unchanged source lost its resolved ID and could be submitted again. A source element now retains its resolved identity through temporary header absence only while its source, links and author remain compatible. Recycled content waits for its new identity. A real permalink always takes precedence.

Translation boxes or controls displaced by React are reattached intact instead of being removed and reconstructed. Request ownership, cancellation and local display state survive the repair. A copied DOM signature is not accepted as proof that a newly cloned element already has a translation.

The follow-up added seven browser cases and four worker cases. The installed-extension test also loads the production DOM layer, renderer and controller into an isolated synthetic document using the host's native Chrome API. With a cached post and a deliberately blocked new provider request, it verifies immediate cached text, zero loading calls for the cached post, exactly one new provider request, retention of the same box during header/sibling reconstruction, and cancellation of only unfinished work. No personal account or paid provider request is used by these tests. Live X was inspected, but the intermittent live event itself was not captured; the fixes are supported by deterministic reproductions and the integrated extension test.

## Validation

- Browser harness: **968/968 passed**, including 63 X lifecycle cases and 32 other X cases.
- **20/20 Node/Python suites passed**, including **47/47** dedicated 3.7.9 resilience regressions and **4/4** X cache-delivery regressions. Coverage includes 120 consecutive synthetic 503 failures, all-key waits, cancellation, stream errors, safety reasons and 50 new posts after a worker restart.
- Installed Chrome: **81/81 checks passed** across the packaged MV3 runtime, Persian/English UI, production X rendering with real extension ports and durable cache, synthetic provider responses and same-path upgrade from 3.7.8. This includes 79 installation/integration/upgrade checks and two worker-lifetime checks.
- A real local-network response delayed for 36 seconds completed with **one request**, after detaching the worker debugger before the request began. Debugger activity therefore did not mask idle termination in this check.
- Upgrade retained extension identity, settings, a synthetic key, memory and an IndexedDB subtitle project with locked manual edits. Complete settings snapshots remain writable without exposing the derived memory identity as a preference.
- Release tools verified 1,478 paired locale entries, syntax, exact file lists, runtime dependencies, archive bytes and SHA-256.

Automated scenarios cover the reported lifecycle and recovery failures. This is not a claim that every future X layout or every live provider response is verified. The separate X-side conversation-module disappearance described in the 3.7.8 report is not attributed to this extension or claimed as fixed here.

## Sources and upgrade

Google's [troubleshooting guide](https://ai.google.dev/gemini-api/docs/troubleshooting) distinguishes service failures from invalid requests and permissions. Its [rate-limit documentation](https://ai.google.dev/gemini-api/docs/rate-limits) establishes project-based quotas; adding keys does not multiply a project's capacity. Response reasons and configurable thresholds were checked against the [generateContent reference](https://ai.google.dev/api/generate-content) and [safety guide](https://ai.google.dev/gemini-api/docs/safety-settings). Chrome's [worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle) requires recovery after termination; active-work heartbeats stop when work ends.

To upgrade, extract the Chrome archive over the same installed extension directory, reload Tarjoman in Chrome's Extensions page, and refresh open X tabs. Keep the extension installed to retain its identity and local data. The delivered archives are local release artifacts; no store or repository publication was performed.
