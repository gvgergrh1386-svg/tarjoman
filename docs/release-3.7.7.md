# 3.7.7 verification report

Completed locally on **2026-09-21**, on Windows with Node 24, Python 3.11 and desktop Chrome. Work was completed in a separate directory; the original runtime was preserved. Nothing was published to a repository or store.

## Delivered behavior

Persian/English interfaces and companion messages, browser-language selection, independent regional formats and legacy migration are ready. Source detection is automatic; destinations are selectable for X, composer, page/selection, image, summary, web video, files, manga, YouTube and workshop projects. Suggestions are not a closed allowlist: users can enter language tags supported by their service. UI language, content direction, media coordinates and target-specific caches remain separate. Persian memory is not applied to other languages.

The optional manga adapter operates only in its child process, without saving external configuration or learning into the Persian glossary. Model, OCR and font support remain external dependencies. MIT licensing, third-party notices/licenses, bilingual guides, privacy/security/contributor documentation, CI and reproducible packaging are included.

## Recorded validation

| Check | Original 3.7.6 | Final 3.7.7 |
| --- | ---: | ---: |
| Complete browser harness | 943/943 | **944/944** |
| Node regressions | 188/188 | **209/209** |
| Harness Python self-tests | 15/15 | **15/15** |
| Bridge request/security audit | 20/20 | **22/22** |
| Bridge self-test | 22/22 | **22/22** |
| Manga adapter contracts | — | **5/5** |
| Installed package: locale, targets, restart, upgrade | — | **33/33** |
| Installed workshop: file, provider, edit, lock, save, restart | — | **20/20** |
| Installed web video: captions, fullscreen, PiP, locales, cleanup | — | **24/24** |

Installed tests loaded the extracted Chrome ZIP as real MV3 code in disposable profiles. They verified actual new worker activation, same-path identity retention, and real IndexedDB project restoration with locked manual edits. Provider responses used deterministic loopback fixtures. Locale tests used CDP navigator-language emulation on real extension pages. Popup screenshots and horizontal overflow were checked.

Original minimum test counts were not lowered. A target-change lifecycle test increased one suite from 7 to 8. Intentional expectation changes reflect the new requirements: Arabic-script page prose reaches automatic source detection, translated content receives its destination language, and speech preserves the supplied language instead of forcing Persian delivery. Synthetic credentials were reconstructed from synthetic fragments, dependency loaders updated, and embedded preview summaries isolated from their parent harness.

Static checks passed: **1,458 paired UI messages**, **44 paired bridge messages**, **30 reviewed literal exceptions**, **129 JavaScript sources/inline scripts parsed**, and the legacy audit of **38 runtime scripts / 55 local references**. Exceptions cover model instructions, normalization, technical values and CSS; no whole-file exemptions.

## Distribution review

The original-tree review scanned **925 plaintext files**, including development/audit material, without retaining secret values. Findings included private paths, synthetic key-shaped fixtures and a local pairing-token file; these were excluded or corrected in public exports. No Git history existed to scan. Binary/media files were outside the plaintext scan; pattern scans cannot prove absence of every secret format.

Chrome contains **87 explicitly approved files**; the source ZIP and clean export contain **195**. Audits, installed dependencies, tokens, personal paths, jobs, backups, profiles and local caches are excluded. Verification checks exact sets, ZIP integrity, manifest/HTML dependencies, source byte equality, license hashes and SHA-256. Rebuilding the final source reproduces both archive hashes. Exact delivered hashes accompany the ZIPs in `.zip.sha256` files and `release-manifest.json`.

## Evidence limits

No real keys, paid calls or live model-quality evaluations were used. These checks do not certify every language pair, unofficial Google/Bing endpoint, real X/YouTube account state, DRM player, OS/browser version or voice. Choose services and voices supporting the destination; custom prompts can override it.

Manga tests cover destination propagation, IDs, repair merging, retained untranslated source and explicit font failure. **Full external manga OCR/model/typesetting and AnimeStudio processing were not run.** Non-Persian manga may need `TARJOMAN_MANGA_FONT`; complex scripts may require Pillow with Raqm. See the bridge installation guide.

CI is included and equivalent commands passed locally; remote GitHub CI/store review have not run. Chrome 116 is the declared minimum, not a separately tested version. Settings backups exclude the workshop database: export important projects separately. Public preparation is complete within these stated checks; no external publication occurred.
