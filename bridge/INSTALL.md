# Optional local companion

[فارسی](INSTALL.fa.md) · [Privacy](../PRIVACY.md)

The extension works without this companion. The bridge uses the Python standard library (Python 3.10+). Run `python bridge.py` in this directory, or double-click `bridge.cmd` on Windows. It listens only on `127.0.0.1:8765`; see `python bridge.py --help` for options. Pair the printed token in Tarjoman's local-bridge settings and grant requested loopback access. The token is stored in `token.txt`; do not share it. Stop with Ctrl+C.

Install dependencies only for features you need, in the Python environment that runs the bridge:

| Feature | Optional package/tool | Network behavior |
| --- | --- | --- |
| Screen OCR | `rapidocr-onnxruntime` | Local recognition; extracted text goes to the selected translator. |
| Edge speech | `edge-tts` | Online Microsoft service; requires internet. |
| Transcription | `faster-whisper`, FFmpeg where needed | Models download on first use; inference is local. |
| Manga | Separate compatible MangaTranslator installation | Depends on its engine/configuration. |
| Video upscaling launcher | Separate compatible AnimeStudio installation | Depends on that application. |

Example: `python -m pip install edge-tts`. Review upstream package and model licenses before installation. Optional tools are not bundled or pinned by the Node lockfile. GPU acceleration depends on your hardware/runtime; the bridge itself requires no particular GPU. Some experimental voice adapters may be discoverable without a complete installed engine; confirm actual availability in diagnostics.

Personal machine paths have been removed. Set `TARJOMAN_MANGA_DIR` and/or `TARJOMAN_ANIME_DIR` before launch, or use `bridge/integrations/MangaTranslator` and `bridge/integrations/AnimeStudio`:

```powershell
$env:TARJOMAN_MANGA_DIR = Read-Host 'Path to your MangaTranslator installation'
python bridge.py
```

MangaTranslator must provide `manga_translator` and a compatible virtual environment. AnimeStudio must provide `gui/app.pyw`. Choose the manga destination in Tarjoman. The companion passes it to an isolated adapter process for non-Persian output; Persian retains the original integration path. The adapter changes translation and typesetting only in that child process, without saving the external app configuration or learning into its Persian glossary. External provider credentials remain managed by MangaTranslator. Set `TARJOMAN_MANGA_FONT` to a compatible installed font file if the configured font lacks target glyphs. Complex scripts may require a Pillow build with Raqm in the integration environment; missing glyph/layout support reports an error instead of silently drawing unusable text. Adapter contracts were tested with deterministic fixtures; full OCR, model and page rendering against external installations were not exercised.

Refresh discovery after installation. Messages follow the extension's `X-Tarjoman-Language` header; standalone messages default to Persian (`TARJOMAN_UI_LANGUAGE=en` selects English). Jobs and model caches are local user data, not removed when the browser extension is uninstalled. Health discovery exposes capability/installation hints without a token; work routes require it. Never expose the bridge port publicly.
