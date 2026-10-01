# Tarjoman 3.8.0 verification report

Prepared on 2026-09-27. This release follows an engineering audit of the existing 3.7.9 source. Reproductions, fixes and checks used synthetic content, temporary Chrome profiles and local services. No public deployment or real-account changes were performed.

## Corrected behavior

Screen translation called methods that the shared card component does not provide, so even a successful OCR response could leave an empty card. It now renders through the component's actual body and error API. Successful, empty, failed and partially translated responses have distinct visible outcomes. Empty OCR boxes cannot shift translations onto the wrong source box, and a completely failed translation cannot masquerade as successful source text.

Each screen operation owns its capture, region picker, card and cancellable worker port. Closing, replacing or disabling it retires outstanding work; output-affecting settings changes do the same. Media tracks, listeners, heartbeat timers and bridge requests are released when their owner finishes. A browser-owned capture chooser cannot be closed programmatically; a stream returned after retirement is immediately stopped.

Page and selection output is invalidated when its effective translation policy changes, including provider, glossary and manual memory corrections. Appearance-only changes preserve compatible work. Image and manga menu requests now carry unique identities so an earlier response cannot overwrite a later operation. Manga source tracking also respects host changes to src, srcset, sizes and picture sources; original image state uses weak references.

Popup diagnostics reject missing, failed or malformed replies. Clearing cache or memory and resetting statistics show success only after an affirmative response; failure keeps the last confirmed memory display and restores controls. Known restricted browser and store pages disable unavailable page actions with an explanation.

OpenAI completions terminated by length or content filtering are failures even when partial text exists. Such text is not cached as a successful translation or summary. A later complete response can recover normally.

Subtitle detection now recognizes Unicode letters including Hangul, Indic scripts, Thai, Armenian and supplementary CJK. Legacy project restoration preserves manual edits and locks while adding newly recognized rows. New snapshots identify their Unicode coverage, so a missing current row is rejected instead of being silently treated as legacy data. Subtitle and audio download names use the project's actual destination. Backup settings omit derived memory identity, which is not an editable preference.

## Executed verification

Environment: Windows, Chrome 154.0.8037.58, Node 24.18.0, npm 11.16.0 and Python 3.11.9. Manifest, npm metadata and local companion report 3.8.0.

| Check | Result and scope |
| --- | --- |
| Node/Python suites | 20/20 passed; provider contracts, queues, cache, settings, subtitles, workshop, runner integrity and local bridge tests |
| Browser harness | 998/998 passed, compared with 968/968 before this audit |
| Installed Chrome runtime | 121/121 passed, including Persian/English UI, all 13 popup destinations, keyboard focus, native messaging, storage, worker restart and same-path 3.7.9-to-3.8.0 upgrade |
| Isolated-world integration | 18/18 passed, including real content-sender authorization, credential masking, SPA navigation and concurrent settings writes |
| Repeated affected flows | Two reversed-order runs passed 146/146 combined checks for popup, page/screen lifecycle and workshop |
| Supplemental subtitle fuzzing | Seed 20260927: 5,000 SRT/VTT round trips and 18,156 invalid-token fallback checks passed |
| Static and release validation | 1,479 paired locale entries, generated bundle consistency, 132 JavaScript/inline syntax checks, Python/JSON parsing, explicit archive lists, runtime assets, license hashes and public-file secret-pattern checks |
| Dependency audit | npm reported zero known vulnerabilities for the one installed development dependency; optional external Python/model stacks were outside that result |

Reproductions were also run against the preserved original source: new popup checks exposed seven failures; page/screen lifecycle checks exposed twelve; the expanded worker/provider suite exposed thirteen. These counts overlap behavioral groups and are not a count of distinct defects. After correction, the corresponding suites passed. A further adversarial review caught overly permissive restoration of new Unicode projects; its regression now rejects missing rows.

The worker restart test detaches its debugger, deliberately stops the worker, wakes a different worker target and retrieves an existing translation with provider access prevented. The separate lifetime test completes a real local-network response delayed for 36 seconds with one request and no worker debugger attached. Upgrade retains extension identity, settings, synthetic credentials, memory and locked IndexedDB project edits. These checks follow the risks described by Chrome's [service-worker lifecycle documentation](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle).

## Evidence limits

Browser fixtures execute production controllers and rendering with controlled provider, media or host-page inputs. Installed tests use actual Chrome storage, ports and extension permissions. Neither proves live AI translation quality, every future X/YouTube layout or every provider response. Paid APIs, logged-in accounts, native screen-picker interaction, external OCR/manga model execution, GPU dependencies, DRM capture, multi-hour memory profiling and all supported browser/OS combinations were not verified. Screen-reader and full WCAG conformance are not claimed.

Security review covered relevant access-control, input, secret-handling, cancellation, dependency and integrity boundaries using [OWASP ASVS 5](https://github.com/OWASP/ASVS) and [OWASP Top 10:2025](https://top10.owasp.org/2025/0x00_2025-Introduction/) as references. Passing the included checks is not an ASVS certification or a guarantee that no vulnerability remains.

## Reproduction and installation

The existing tools remain the entry points:

```text
python tools/test_all.py
python tools/test_all.py --browser
python dev/e2e/run_e2e.py
python tools/build_release.py
python tools/verify_release.py
```

The existing `dev/release_smoke_379.py` now reads source and destination versions from their manifests. Use its `--extension`, `--upgrade-from` and `--output` options for installed upgrade verification; `--audit-only` runs the focused controls/restart checks and supplied upgrade.

For an existing unpacked installation, export a private backup, extract `Tarjoman-3.8.0-Chrome.zip` into the same installed extension folder, reload the extension and refresh affected tabs. Retaining the folder retains the extension identity. The source archive and SHA-256 sidecars accompany the local Chrome package; store publication is separate.
