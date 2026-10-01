# Tarjoman 3.7.8 verification report

Prepared on 2026-09-23 from the 3.7.7 workspace, using the supplied eleven-item bug report, two screenshots and the public X reproduction profile. See the [detailed Persian report](release-3.7.8.fa.md) for the item-by-item findings.

## Changes

- Gemini separates daily/minute and request/token quota failures, invalid credentials, model permission denial, invalid requests, temporary server failures and network failures. Retry-After and cancellation are respected. A bounded retry budget is shared across keys; eligible later keys remain reachable after network errors. Diagnostics report inspected/tried/skipped/unvisited key counts without exposing credentials to the page.
- X immediately restores compatible page-cache hits, preserves translated cards moved by React, saves valid detached responses for remounts, and prevents older requests from overwriting newer cache results. Persistent cache hits are checked for translation invariants.
- Full-page translation owns cancellable ports. Stop, restore and navigation retire queued work, active fetches, retries and optional review. A shared producer is aborted only when its last subscriber leaves. Queues are cancellable for Gemini, OpenAI-compatible and MT providers.
- Generic translation uses structured `{i,t}` rows instead of embedding identifiers inside translated prose. Duplicate/out-of-range IDs are rejected. Screenshot-like protocol/rate artifacts absent from the source are rejected without deleting genuine numbers or symbols. Legacy custom string-format responses remain readable when unambiguous.
- Thinking controls and outgoing settings follow reviewed model capabilities. Unknown models use service defaults; unsupported stored values and stale asynchronous UI loads cannot leak into another model.
- Quota displays local usage for the active model. No default 1500 cap, multiplication by API-key count, inferred cap from local exhaustion counts, or propagation of one key's cap to another project. Unknown limits stay unknown. Old unverified caps are ignored while usage counters survive.

## X disappearance finding

Direct loading of [sakugaone](https://x.com/sakugaone) showed the pinned post and recent posts `2102395953433178508` and `2102395958181192058`. Internal navigation away and back removed the recent conversation modules from the DOM while retaining older standalone posts. The successful `UserOriginalsTimeline` response still contained the missing posts inside `TimelineTimelineModule`. The user independently reproduced the problem with Tarjoman disabled.

This remains independent of Tarjoman's enabled state; the evidence does not distinguish an X client defect from other browser modifications. It is not reported as an extension fix. Reloading the page restored the posts in this inspection. No automatic reload or fabricated timeline restoration is shipped.

## Validation

- Browser harness: **949/949**, including 169 core selftests, 44 X lifecycle checks, 9 page lifecycle checks and 4 popup lifecycle checks.
- All **18 Node/Python suites** passed, including **29/29** targeted 3.7.8 regressions.
- Actual installed MV3 extension: **39/39** checks across Persian/English UI, real port-to-fetch cancellation, restart and same-path upgrade from 3.7.7.
- Upgrade preserved extension identity, settings, a synthetic key, translation memory and a stored IndexedDB project with locked manual edits.
- Paired locale catalogs, syntax, runtime dependencies, exact allowlists, ZIP integrity, byte equality and SHA-256 checks are verified by the release tools.

Existing suites remain present. Assertions that encoded fabricated summed quotas or accepted duplicate IDs were updated to enforce the corrected contract. Provider responses in automated tests are synthetic; no live billing/quality benchmark is implied.

## Limits and references

Cancellation stops local work but cannot undo requests already accepted or charged by a remote service. Local counters are not authoritative project usage. The selection screenshot is consistent with leakage of the former inline-ID protocol. The raw provider response for the rate artifact was unavailable, so its exact origin is not established; the new invariant prevents this class of inconsistent output but does not guarantee semantic correctness of every model response.

Capabilities and error handling were checked against Google's [thinking guide](https://ai.google.dev/gemini-api/docs/thinking), [rate limits](https://ai.google.dev/gemini-api/docs/rate-limits) and [troubleshooting guide](https://ai.google.dev/gemini-api/docs/troubleshooting).

For a manual upgrade, replace files in the same installed directory, reload Tarjoman in Chrome's Extensions page, and refresh existing website tabs. Do not uninstall the old extension to upgrade. Archives are local deliverables; no store or repository publication was performed. User documents, screenshots, credentials and private audit logs are excluded from the packages.
