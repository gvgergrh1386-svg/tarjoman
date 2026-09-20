# Contributing

[فارسی](docs/contributing.fa.md)

Use Python 3.10+, Node 20+ and desktop Chrome. Run `npm ci`, then load the repository directory with Chrome's Load unpacked. Runtime JavaScript is plain classic-script JavaScript; Acorn is a development-only parser. Regression tests need no API key.

| Directory | Purpose |
| --- | --- |
| `background/` | Worker, providers, cache, prompts and bridge client |
| `content/` | Site/player UI, rendering, caption/audio lifecycles |
| `popup/`, `pages/` | Settings and subtitle workshop |
| `shared/` | Settings, i18n, theme and shared contracts |
| `locales/`, `_locales/` | Application messages and Chrome metadata |
| `bridge/`, `dev/`, `tools/` | Companion, regression fixtures, build/check tooling |

Edit `shared/settings-core.js`, `shared/i18n.js` and `locales/fa.json` / `en.json`, then run `python tools/build_i18n.py`. Do not edit generated `shared/settings.js` directly. The bundle is committed so users can load a source checkout without building.

## Localization

Use stable semantic keys and `GXT.i18n.t(key, {namedValue})`; never derive keys from translated text. All languages must have identical keys/placeholders. Use textContent or escaped output for untrusted values. Legacy markup catalog entries are trusted application templates: retain tag/attribute structure and escape dynamic values at the call site. Provider output is not trusted HTML. Bind only UI labels for live language updates, never translated content or user-edited fields.

For a third language, add a catalog, native `_locales/<code>/messages.json` and bridge variants. Register language/direction in i18n and settings choices, add the selector and tests, and approve files in `tools/public-files.json`. This changes configuration/message data, not cache/provider/lifecycle logic. Check font coverage and layout with a fluent reader. Content targets remain separate from UI languages.

`node tools/check_i18n.cjs` checks catalog calls and precise reviewed literal exceptions. Do not expand whole-file exemptions. `locales/inventory.json` records extraction locations; [architecture](docs/architecture.md) explains classification. Model instructions, technical identifiers, comments and user content are not UI messages.

## Validation

```sh
npm ci
python tools/build_i18n.py --check
node tools/check_i18n.cjs
python tools/test_all.py
python tools/test_all.py --browser
python tools/build_release.py
python tools/verify_release.py
```

The default browser harness sets Persian navigator locale to preserve existing Persian assertions. Separate installed-extension smoke tests exercise fresh fa/en, switching and upgrade; see `python dev/release_smoke_377.py --help`. Tests use temporary profiles and synthetic content, not real provider quality measurements. Logs stay in excluded `.audit/`. Set `CHROME` if discovery fails.

Keep existing assertions/failure exits. Test lifecycle changes with delay, cancellation, seek and teardown. Do not couple UI locale to request identity or reduce prompt/model quality for cost. New files enter releases only after approval in the exact public list; gitignore alone is not a release boundary. PRs should explain the problem/result and relevant checks using synthetic fixtures. Never submit private accounts, profiles, prompts or keys. Use [Security](SECURITY.md) for private reports.
