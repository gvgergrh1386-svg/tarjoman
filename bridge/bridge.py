#!/usr/bin/env python3
"""
ترجمان Bridge — the local companion service (v3.7.0).

A small HTTP server on the loopback interface that lets the browser extension
reach things a browser fundamentally cannot: software installed on this
machine, the GPU, and the user's own two applications.

Why this exists at all
──────────────────────
The extension is excellent at everything a page can do and helpless at
everything it cannot. Four gaps, in the order they actually matter:

  /tts      Microsoft's neural Persian voices still work perfectly from
            Python — it is only the BROWSER path that Microsoft closed in
            December 2025. So the extension's default voice engine has exactly
            one point of failure, and this removes it. Piper additionally gives
            fully offline speech, with no network at all.

  /asr      The one thing the extension can never do alone: a video with no
            subtitles is a video it cannot translate. Whisper turns the sound
            into text and hands it back to the pipeline that already exists.

  /manga    The extension translates images with a vision model. MangaTranslator
            does OCR, inpainting and typesetting locally, and the result is not
            comparable. Right-click an image, get the good one.

  /upscale  Queue a video for Anime Studio's TensorRT upscaler.

Design rules
────────────
* STANDARD LIBRARY ONLY for the server itself. Every optional dependency is
  imported lazily, inside the handler that needs it, so a missing package
  disables ONE endpoint instead of preventing the bridge from starting.

* CAPABILITIES ARE NEGOTIATED, never assumed. /health reports what this
  machine can actually do right now, and the extension offers only that. A
  feature that is not installed is shown as installable, not as broken.

* LOOPBACK ONLY, and a token for anything with side effects. Binding to
  127.0.0.1 keeps other machines out; the token keeps other WEB PAGES out,
  because a page can fire a no-cors POST at localhost even though it cannot
  read the reply. /health is the only unauthenticated route, and it reveals
  nothing but a list of feature names.

Run it:  bridge.cmd   (or:  python bridge.py)
"""

from __future__ import annotations

import base64
import importlib.util
import json
import os
import re
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

VERSION = "3.7.7"
DEFAULT_PORT = 8765
HERE = Path(__file__).resolve().parent

# UI messages use the request language; translation text and model IDs never do.
from contextvars import ContextVar
UI_LANGUAGE = ContextVar("bridge_ui_language", default=os.environ.get("TARJOMAN_UI_LANGUAGE", "fa"))
MESSAGES = json.loads((HERE / "messages.json").read_text(encoding="utf-8"))
def tr(key, values=None):
    message = MESSAGES[key].get(UI_LANGUAGE.get(), MESSAGES[key]["fa"])
    return re.sub(r"\{(v\d+)\}", lambda m: str((values or {}).get(m[1], m[0])), message)

def localize_metadata(value, field=""):
    if isinstance(value, dict):
        return {k:localize_metadata(v,k) for k,v in value.items()}
    if isinstance(value, list):
        return [localize_metadata(v,field) for v in value]
    if isinstance(value, str) and field in {"error","hint","description","label","why","title"}:
        for key, messages in MESSAGES.items():
            names = re.findall(r"\{(v\d+)\}", messages["fa"])
            pattern = re.escape(messages["fa"])
            for name in names:pattern = pattern.replace(re.escape("{"+name+"}"), "(.*?)", 1)
            match = re.fullmatch(pattern,value,re.DOTALL)
            if match:return tr(key,dict(zip(names,match.groups())))
    return value

TOKEN_FILE = HERE / "token.txt"
JOBS_DIR = HERE / "jobs"

# The two sibling projects this bridge exists to reach. Located rather than
# hard-required: the bridge is useful with neither of them installed.
MANGA_DIR = Path(os.environ.get("TARJOMAN_MANGA_DIR", str(HERE / "integrations" / "MangaTranslator"))).expanduser()
ANIME_DIR = Path(os.environ.get("TARJOMAN_ANIME_DIR", str(HERE / "integrations" / "AnimeStudio"))).expanduser()

# A request from anywhere but an extension is refused outright. A browser
# cannot be persuaded to forge this header, which makes it a real boundary
# rather than a decorative one.
ALLOWED_ORIGIN_PREFIXES = ("chrome-extension://", "moz-extension://")
# Hard ceiling on a single request body. Generous, because a chapter upload is
# genuinely tens of megabytes — but present, because `rfile.read(n)` allocates
# whatever Content-Length claims.
MAX_BODY_BYTES = 768 * 1024 * 1024
REQUEST_TIMEOUT_S = 30.0

# A page can take a while on a cold model; long enough to finish, short enough
# that a wedged child is eventually reported rather than held open forever.
MANGA_TIMEOUT_S = 600

# Never flash a console window when a child process starts — the bridge is
# already a visible window and a second one blinking mid-read is startling.
_NO_WINDOW = 0x08000000 if os.name == "nt" else 0


# --------------------------------------------------------------- utilities


def _safe_stem(name: str, fallback: str = "page") -> str:
    """A filesystem-safe folder name taken from a URL's last path segment.

    That segment is attacker-influenced (it is whatever the site chose to call
    the image), so anything that could climb out of the jobs directory or upset
    Windows is dropped rather than escaped.
    """
    cleaned = "".join(c for c in str(name) if c.isalnum() or c in " _-.()[]").strip(" .")
    cleaned = cleaned.replace("..", "_")
    return cleaned[:60] or fallback


def _has(module: str) -> bool:
    """Is an optional dependency importable, without importing it?"""
    try:
        return importlib.util.find_spec(module) is not None
    except (ImportError, ValueError):
        return False


def _venv_python(project: Path) -> Path | None:
    """A project's own interpreter, so its dependencies are the ones used."""
    candidate = project / ".venv" / "Scripts" / "python.exe"
    if candidate.exists():
        return candidate
    candidate = project / ".venv" / "bin" / "python"
    return candidate if candidate.exists() else None


REEXEC_FLAG = "TARJOMAN_BRIDGE_REEXEC"


def _maybe_reexec() -> None:
    """Restart under MangaTranslator's interpreter when that one can do more.

    The launcher used to choose the interpreter itself, which meant hard-coding
    `D:\\<persian>\\MangaTranslator\\...` into a .cmd file — and a batch file
    cannot hold a non-ASCII path: written as UTF-8 and read back under the
    console's legacy code page it becomes a directory that does not exist. So
    the choice moved here, where a path is just a string.

    Only worth doing for a REASON: this venv already has `edge_tts`, so moving
    into it turns the local voice engine on. If the interpreter running now can
    already import it, nothing happens. The environment flag makes a re-exec
    loop impossible even if the target somehow cannot import it either.
    """
    if os.environ.get(REEXEC_FLAG) or _has("edge_tts"):
        return
    target = _venv_python(MANGA_DIR)
    if not target or Path(sys.executable).resolve() == target.resolve():
        return
    env = dict(os.environ, **{REEXEC_FLAG: "1", "PYTHONIOENCODING": "utf-8"})
    try:
        completed = subprocess.run([str(target), str(Path(__file__).resolve()), *sys.argv[1:]],
                                   env=env)
    except OSError:
        return          # that interpreter is unusable; carry on with this one
    raise SystemExit(completed.returncode)


def _ffmpeg() -> str | None:
    on_path = shutil.which("ffmpeg")
    for candidate in (
        ANIME_DIR.parent / "_tools" / "ffmpeg" / "ffmpeg.exe",
        Path(on_path) if on_path else None,
    ):
        if candidate and candidate.is_file():
            return str(candidate)
    return None


def load_token() -> str:
    """Read the shared token, creating one on first run.

    Written to a file rather than regenerated per launch so the extension is
    paired once and keeps working across restarts.
    """
    if TOKEN_FILE.exists():
        existing = TOKEN_FILE.read_text(encoding="utf-8").strip()
        if existing:
            return existing
    token = secrets.token_urlsafe(18)
    TOKEN_FILE.write_text(token, encoding="utf-8")
    return token


TOKEN = ""  # set in main()


# ------------------------------------------------------------ capabilities


def capabilities() -> dict:
    """What this machine can do RIGHT NOW.

    Each entry says whether it is available and, when it is not, exactly what
    would make it available — so the extension can show an install line
    instead of a dead switch.
    """
    manga_python = _venv_python(MANGA_DIR)
    caps: dict[str, dict] = {}

    caps["tts"] = {
        "available": _has("edge_tts"),
        "engines": [e for e, ok in (("edge", _has("edge_tts")), ("piper", _has("piper")))
                    if ok],
        "hint": "pip install edge-tts",
        "why": tr('ttsDescription'),
    }
    caps["ocr"] = {
        "available": _has("rapidocr_onnxruntime"),
        "hint": "pip install rapidocr-onnxruntime",
        "why": tr('ocrDescription'),
    }
    caps["asr"] = {
        "available": _has("faster_whisper"),
        "hint": "pip install faster-whisper",
        "why": tr('asrDescription'),
    }
    caps["manga"] = {
        "available": bool(manga_python and (MANGA_DIR / "manga_translator").is_dir()),
        "hint": tr('mangaPath', {'v0': MANGA_DIR}),
        "why": tr('mangaDescription'),
    }
    caps["upscale"] = {
        "available": (ANIME_DIR / "gui" / "app.pyw").exists(),
        "hint": tr('animePath', {'v0': ANIME_DIR}),
        "why": tr('animeDescription'),
    }
    return caps


# --------------------------------------------------------------- endpoints


def do_tts(payload: dict) -> tuple[bytes, str]:
    """Synthesize Persian speech locally.

    Deliberately mirrors the extension's own TTS contract (text / voice /
    rate), so this is a drop-in fourth engine rather than a special case the
    caller has to reason about.
    """
    import asyncio

    import edge_tts

    text = (payload.get("text") or "").strip()
    if not text:
        raise ValueError(tr('noText'))
    voice = payload.get("voice") or "fa-IR-DilaraNeural"
    rate = payload.get("rate")
    # The extension speaks in multipliers (1.25 = a quarter faster); edge-tts
    # wants a signed percentage.
    if isinstance(rate, (int, float)) and rate and abs(float(rate) - 1.0) > 0.01:
        percent = int(round((float(rate) - 1.0) * 100))
        rate_str = f"{percent:+d}%"
    else:
        rate_str = "+0%"

    async def run() -> bytes:
        chunks: list[bytes] = []
        communicate = edge_tts.Communicate(text, voice, rate=rate_str)
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                chunks.append(chunk["data"])
        return b"".join(chunks)

    audio = asyncio.run(run())
    if not audio:
        raise RuntimeError(tr('emptySpeech'))
    return audio, "audio/mpeg"


# Whisper's published sizes, largest last. A size the user has already pulled
# is detected below rather than listed here, so a model released after this
# file was written still shows up.
WHISPER_SIZES = ("tiny", "base", "small", "medium", "large-v3", "large-v3-turbo")


def _cached_whisper_models() -> list[str]:
    """Whisper models already downloaded on this machine.

    faster-whisper pulls from the Hugging Face cache, whose directory names
    encode the repo id. Reading them means a model the user fetched by hand —
    including one that did not exist when this bridge was written — is offered
    without anybody editing a list.
    """
    found: list[str] = []
    roots = [Path(os.environ.get("HF_HOME", "")) / "hub" if os.environ.get("HF_HOME") else None,
             Path.home() / ".cache" / "huggingface" / "hub"]
    for root in roots:
        if not root or not root.is_dir():
            continue
        for entry in root.iterdir():
            name = entry.name
            if not entry.is_dir() or not name.startswith("models--"):
                continue
            repo = name[len("models--"):].replace("--", "/")
            if "whisper" in repo.lower():
                found.append(repo)
    return sorted(set(found))


def do_voices(_payload: dict) -> dict:
    """The catalogue this machine can actually speak and hear with.

    Persian is the point, so fa-* voices come first and the multilingual ones
    after; everything else is left out rather than burying two useful entries
    under six hundred. Failing to enumerate is not an error — it just means the
    extension keeps the list it already had.
    """
    voices: list[dict] = []
    error = ""
    try:
        import asyncio

        import edge_tts

        catalogue = asyncio.run(edge_tts.list_voices())
        for voice in catalogue:
            short = voice.get("ShortName") or ""
            locale = voice.get("Locale") or ""
            multilingual = "Multilingual" in short
            if not (locale.startswith("fa") or multilingual):
                continue
            voices.append({
                "id": short,
                "locale": locale,
                "gender": voice.get("Gender") or "",
                "label": (voice.get("FriendlyName") or short)
                .replace("Microsoft ", "").replace(" Online (Natural)", ""),
                "multilingual": multilingual,
            })
        voices.sort(key=lambda v: (not v["locale"].startswith("fa"), v["id"]))
    except ModuleNotFoundError:
        error = tr('missingEdge')
    except Exception as exc:  # noqa: BLE001 — a catalogue we cannot read is not fatal
        error = str(exc)

    return {
        "ok": True,
        "voices": voices,
        "voicesError": error,
        "asrModels": list(WHISPER_SIZES),
        "asrCached": _cached_whisper_models(),
    }


def do_asr(payload: dict) -> dict:
    """Transcribe audio to timed segments.

    Returns the same shape the subtitle pipeline already consumes — start/end
    in milliseconds plus text — so a transcript is indistinguishable from a
    caption track downstream.
    """
    from faster_whisper import WhisperModel

    raw = base64.b64decode(payload.get("audio") or "")
    if not raw:
        raise ValueError(tr('noAudio'))
    language = payload.get("language") or None
    model_size = payload.get("model") or "small"
    offset_ms = int(payload.get("offsetMs") or 0)

    model = _asr_model(model_size)
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as handle:
        handle.write(raw)
        path = handle.name
    try:
        segments, info = model.transcribe(
            path,
            language=language,
            vad_filter=True,        # skip silence rather than hallucinate over it
            beam_size=1,            # latency matters more than the last % here
            condition_on_previous_text=False,
        )
        cues = [
            {
                "start": int(segment.start * 1000) + offset_ms,
                "end": int(segment.end * 1000) + offset_ms,
                "text": segment.text.strip(),
            }
            for segment in segments
            if segment.text.strip()
        ]
        return {"ok": True, "cues": cues, "language": getattr(info, "language", "") or ""}
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass


_ASR_CACHE: dict[str, object] = {}
_ASR_LOCK = threading.Lock()


def _asr_model(size: str):
    """Load a Whisper model once and keep it.

    Loading costs seconds and hundreds of megabytes; doing it per request would
    make streaming transcription useless.
    """
    with _ASR_LOCK:
        if size not in _ASR_CACHE:
            from faster_whisper import WhisperModel

            device = "cuda" if _has("torch") else "auto"
            try:
                _ASR_CACHE[size] = WhisperModel(size, device=device, compute_type="auto")
            except Exception:
                # A machine without CUDA must still work, just slower.
                _ASR_CACHE[size] = WhisperModel(size, device="cpu", compute_type="int8")
        return _ASR_CACHE[size]


IMAGE_SUFFIXES = {"png", "jpg", "jpeg", "webp", "bmp", "gif", "tif", "tiff", "avif"}
# Sent back inside the JSON reply so the page can show the translated page
# immediately. Above this the image is left on disk and only its path reported:
# a 30 MB data URL helps nobody.
INLINE_LIMIT_BYTES = 12 * 1024 * 1024
MIME_BY_SUFFIX = {
    "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg",
    "webp": "image/webp", "bmp": "image/bmp", "gif": "image/gif",
    "tif": "image/tiff", "tiff": "image/tiff", "avif": "image/avif",
}


KEEP_JOBS = 12


def _live_job_roots() -> set[Path]:
    """Job folders that a running (or still-referenced) job owns.

    Pruning is by folder mtime, and mtime says nothing about whether a child
    process is still writing into that folder. A user who translated a dozen
    short chapters and then started a long one could have the LONG one deleted
    out from under its child.
    """
    with _MANGA_LOCK:
        return {job["root"] for job in _MANGA_JOBS.values()}


def _forget_finished_jobs() -> None:
    """Drop the records of jobs that are over.

    `_MANGA_JOBS` was append-only: every chapter left behind a Popen object, a
    dict of results, and — the one that actually hurt — an OPEN handle on the
    child's stderr log. On Windows an open handle blocks deletion of the file,
    so `shutil.rmtree(..., ignore_errors=True)` silently failed on every job
    folder it was asked to remove, and the disk-space guard below did nothing
    at all. Closing the handle is what makes pruning work.
    """
    with _MANGA_LOCK:
        finished = [
            (job_id, job) for job_id, job in _MANGA_JOBS.items()
            if job["finished"] and job["proc"].poll() is not None
        ]
        # Newest first; keep the recent ones so `/manga/page` and
        # `/manga/archive` still work for a chapter the user just read.
        finished.sort(key=lambda pair: pair[1]["endedAt"] or pair[1]["startedAt"], reverse=True)
        for job_id, job in finished[KEEP_JOBS:]:
            handle = job.get("stderrHandle")
            if handle is not None:
                try:
                    handle.close()
                except (OSError, ValueError):
                    pass
                job["stderrHandle"] = None
            _MANGA_JOBS.pop(job_id, None)


def _prune_jobs() -> None:
    """Keep the newest few job folders and delete the rest.

    Every hand-off leaves a source page plus a translated one — several
    megabytes each — inside the extension's own directory. Unbounded, a month
    of reading manga quietly fills a disk, so the newest handful stay
    (the user may still want to open yesterday's output) and older ones go.
    """
    _forget_finished_jobs()
    live = _live_job_roots()
    try:
        jobs = sorted((p for p in JOBS_DIR.glob("manga-*") if p.is_dir()),
                      key=lambda p: p.stat().st_mtime, reverse=True)
    except OSError:
        return
    # The ceiling applies to ALL job folders — that is what bounds the disk.
    # Filtering the live ones out FIRST and then slicing would compound the two
    # limits (KEEP_JOBS records plus KEEP_JOBS more folders on top) and prune
    # essentially nothing. The live check belongs inside the loop: it protects
    # a folder a child is still writing to, it does not raise the ceiling.
    for stale in jobs[KEEP_JOBS:]:
        if stale in live:
            continue
        shutil.rmtree(stale, ignore_errors=True)


def _child_events(stdout: str) -> list[dict]:
    """The batch worker's newline-delimited JSON progress stream.

    Its log lines and ONNX runtime's warnings share the same pipe, so anything
    that is not a JSON object is skipped rather than treated as corruption.
    """
    events = []
    for line in stdout.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            pass
    return events


def _manga_failure(events: list[dict], stderr: str) -> str:
    """Turn a run that produced no page into a sentence worth reading.

    The pipeline reports precisely why it gave up — a failed job, a failed
    page, or a plan with nothing in it. Falling straight through to a tail of
    raw stdout (what this used to do) showed the user a line of JSON and told
    them nothing.
    """
    for event in reversed(events):
        if event.get("type") == "job_failed" and event.get("msg"):
            return str(event["msg"])
        if event.get("type") == "page_failed" and event.get("reason"):
            return str(event["reason"])
    plan = next((e for e in events if e.get("type") == "plan"), None)
    if plan is not None and not plan.get("jobs"):
        # Not expected any more — the image is staged in a folder precisely so
        # the planner accepts it — but if it ever recurs, say what it means.
        return tr('mangaRejected')
    tail = [l for l in (stderr or "").strip().splitlines() if l.strip()][-3:]
    return tr('emptyTranslation') + (": " + " / ".join(tail) if tail else "")


# ------------------------------------------------------ manga jobs (v2.5.8)
#
# A CHAPTER, not an image.
#
# v2.5.1 could translate one right-clicked page: stage it, run the pipeline,
# wait, hand it back. Correct, and hopeless as a way to read manga — twenty
# pages meant twenty right-clicks and, far worse, twenty cold starts. Loading
# the OCR, segmentation and inpainting models costs ~12 seconds; translating a
# page that is already loaded costs ~5. Nineteen of those twenty waits were
# the same models being loaded again.
#
# So a job is now a LIST of pages inside ONE child process, and the shape of it
# is dictated by how MangaTranslator's own batch loop works:
#
#   * ONE FOLDER PER PAGE, all folders handed to a single run. The obvious
#     alternative — one folder holding every page — finishes the whole chapter
#     before writing anything, because `execute_batch` assembles output only
#     after a job's last page. One page per job means a `job_done` event, and
#     therefore a readable file, every few seconds. The reader fills in as you
#     watch instead of staring at a spinner for two minutes.
#   * Nothing is lost by splitting: `resolve_concurrency` returns 1 on a GPU
#     anyway (the inference locks serialise the work regardless), so pages
#     were never going to run in parallel on this machine.
#   * CANCELLATION IS FREE. The batch runner already polls a `cancel_flag`
#     file between pages; the spec simply names one.
#
# The HTTP surface is deliberately a job, not a request: start returns
# immediately, status is polled, finished pages are fetched one at a time.
# A single request that blocks for two minutes cannot report progress, cannot
# be cancelled, and dies to any timeout in between.

_MANGA_JOBS: dict[str, dict] = {}
_MANGA_LOCK = threading.Lock()
MAX_PAGES_PER_JOB = 400
# The extension caps its own chapter payload well below this (MAX_CHAPTER_BYTES
# in the service worker); this is the server's independent floor, because a
# server must not depend on its client for its own safety.
MAX_JOB_BYTES = 512 * 1024 * 1024
# Measured on this machine, three identical pages, same models already warm:
#   one page per job (strictly serial) ... 51s
#   three pages in one job, concurrency 3 ... 24s
# The reason is in the per-page timings: OCR 2.2s, inpaint 0.5s, render 0.1s —
# and TRANSLATE 14s, which is a network wait on the language model. Overlapping
# pages overlaps the waiting. The GPU stages stay serialised by the
# application's own inference locks, so this costs no correctness.
DEFAULT_GROUP = 3
MAX_GROUP = 4          # MangaTranslator's own MAX_CONCURRENCY


def _decode_page(entry: dict, index: int) -> tuple[bytes, str]:
    """One queued page → (bytes, suffix)."""
    if not isinstance(entry, dict):
        raise ValueError(tr('pageObject', {'v0': index + 1}))
    data = base64.b64decode(entry.get("image") or "", validate=True)
    if not data:
        raise ValueError(tr('pageEmpty', {'v0': index + 1}))
    raw_name = (entry.get("name") or f"page{index:04d}.png").strip().split("?")[0].split("#")[0]
    suffix = raw_name.rsplit(".", 1)[-1].lower() if "." in raw_name else ""
    if suffix not in IMAGE_SUFFIXES:
        suffix = "png"
    return data, suffix


def _reader_thread(job_id: str, proc: subprocess.Popen) -> None:
    """Consume the child's event stream and keep the job record current.

    Runs on its own thread so `status` is a dictionary lookup rather than a
    read of a pipe that may block for the length of a page.
    """
    try:
        for line in proc.stdout:            # blocking, but only this thread
            line = line.strip()
            if not line.startswith("{"):
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            with _MANGA_LOCK:
                job = _MANGA_JOBS.get(job_id)
                if not job:
                    return
                kind = event.get("type")
                if kind == "plan":
                    job["planned"] = _event_count(event.get("jobs"))
                elif kind == "job_done":
                    # `name` is the source folder — a GROUP of pages — and its
                    # digits identify which. Every page in that group becomes
                    # readable at the same moment, because the batch loop
                    # assembles a job's output only once the job is complete.
                    for index in job["groups"].get(_group_of(event.get("name", "")), []):
                        job["ready"][index] = event.get("out", "")
                        if _output_file(job, index) is None:
                            job["ready"].pop(index, None)
                            job["failed"][index] = tr('pageNoOutput')
                    job["failedPages"] += _event_count(event.get("failed_pages"))
                elif kind == "job_failed":
                    for index in job["groups"].get(_group_of(event.get("name", "")), []):
                        job["failed"][index] = event.get("msg", "")
                elif kind == "page_failed":
                    job["notes"].append(event.get("reason", ""))
                elif kind == "finished":
                    # Completion belongs to process exit, when pipes and log
                    # handles have been released, not to an early child event.
                    pass
    except (OSError, ValueError):
        pass
    finally:
        code = proc.wait()
        if proc.stdout is not None:
            proc.stdout.close()
        with _MANGA_LOCK:
            job = _MANGA_JOBS.get(job_id)
            if job:
                job["finished"] = True
                job["returncode"] = code
                job["endedAt"] = time.time()
                timer = job.pop("cancelTimer", None)
                if timer is not None:
                    timer.cancel()
                # The child is gone, so nothing more will be written. Flush and
                # release the handle: `manga_status` reads the log by PATH, and
                # holding the handle open is what stopped Windows from ever
                # deleting a finished job folder (see _forget_finished_jobs).
                handle = job.get("stderrHandle")
                if handle is not None:
                    try:
                        handle.flush()
                        handle.close()
                    except (OSError, ValueError):
                        pass
                    job["stderrHandle"] = None


def _group_of(folder_name: str) -> str:
    """The group folder's own name, with any `_fa` output suffix removed."""
    name = str(folder_name)
    return name[:-3] if name.endswith("_fa") else name


def _event_count(value) -> int:
    """A malformed optional progress field must not abandon a live pipe."""
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError, OverflowError):
        return 0


def manga_start(payload: dict) -> dict:
    """Queue a chapter. Returns at once with a job id.

    Pages are staged in GROUPS, and the group size is the whole performance
    story (see DEFAULT_GROUP): within a group the batch loop runs pages in
    parallel, which overlaps their language-model waits, and each group's
    output lands as a unit, which is what makes results stream instead of all
    arriving at the end.
    """
    python = _venv_python(MANGA_DIR)
    if not python:
        raise RuntimeError(tr('mangaMissing', {'v0': MANGA_DIR}))
    pages = payload.get("pages")
    if not isinstance(pages, list) or not pages:
        raise ValueError(tr('noPages'))
    if len(pages) > MAX_PAGES_PER_JOB:
        raise ValueError(tr('pageLimit', {'v0': MAX_PAGES_PER_JOB}))

    target_lang = str(payload.get('targetLang') or 'fa')
    if not re.fullmatch(r'[a-z]{2,3}(?:-[a-zA-Z0-9]{2,8})*', target_lang) or len(target_lang)>35:
        raise ValueError(tr('invalidTarget'))
    group_size = max(1, min(MAX_GROUP, int(payload.get("concurrency") or DEFAULT_GROUP)))

    JOBS_DIR.mkdir(parents=True, exist_ok=True)
    _prune_jobs()
    job_id = uuid.uuid4().hex[:10]
    root = JOBS_DIR / f"manga-{job_id}"
    out_dir = root / "out"
    out_dir.mkdir(parents=True)

    stderr_handle = None
    try:
        sources = []
        groups: dict[str, list[int]] = {}
        written = 0
        for start in range(0, len(pages), group_size):
            folder = f"g{start:04d}"
            src_dir = root / folder
            src_dir.mkdir(parents=True, exist_ok=True)
            indices = []
            for index in range(start, min(start + group_size, len(pages))):
                data, suffix = _decode_page(pages[index], index)
                written += len(data)
                if written > MAX_JOB_BYTES:
                    shutil.rmtree(root, ignore_errors=True)
                    raise ValueError(
                        tr('chapterLimit', {'v0': MAX_JOB_BYTES // (1024 * 1024)}))
                # The FILE NAME is the page's global index, zero-padded. That is
                # the only identity that survives the trip through another program:
                # the batch loop keeps a page's stem for its output file, so the
                # translated page comes back still knowing which page it is.
                (src_dir / f"{index:04d}.{suffix}").write_bytes(data)
                indices.append(index)
            sources.append(str(src_dir))
            groups[folder] = indices

        cancel_flag = root / "cancel"
        spec = root / "spec.json"
        spec.write_text(json.dumps({
            "sources": sources,
            "dst": str(out_dir),
            "concurrency": group_size,
            "cancel_flag": str(cancel_flag),
            "targetLang": target_lang,
            "targetName": str(payload.get("targetName") or target_lang)[:100],
            "direction": "rtl" if payload.get("direction") == "rtl" else "ltr",
        }), encoding="utf-8")

        env = dict(os.environ)
        env["PYTHONIOENCODING"] = "utf-8"
        env["PYTHONUNBUFFERED"] = "1"
        stderr_path = root / "child.stderr.log"
        stderr_handle = stderr_path.open("w", encoding="utf-8", errors="replace")
        proc = subprocess.Popen(
            ([str(python), "-m", "manga_translator", "--batch-runner", str(spec)] if target_lang == "fa"
             else [str(python), str(Path(__file__).with_name("manga_target_runner.py")), str(spec)]),
            cwd=str(MANGA_DIR),
            stdout=subprocess.PIPE,
            stderr=stderr_handle,
            env=env,
            creationflags=_NO_WINDOW,
            text=True, encoding="utf-8", errors="replace", bufsize=1,
        )

    except Exception:
        if stderr_handle is not None:
            stderr_handle.close()
        # root is freshly created beneath JOBS_DIR and contains only staging.
        if root.resolve().is_relative_to(JOBS_DIR.resolve()):
            shutil.rmtree(root, ignore_errors=True)
        raise

    with _MANGA_LOCK:
        _MANGA_JOBS[job_id] = {
            "id": job_id,
            "proc": proc,
            "root": root,
            "out": out_dir,
            "cancelFlag": cancel_flag,
            "stderr": stderr_path,
            "stderrHandle": stderr_handle,
            "groups": groups,
            "groupSize": group_size,
            "total": len(pages),
            "planned": 0,
            "ready": {},          # index -> output folder
            "failed": {},         # index -> message
            "notes": [],
            "failedPages": 0,
            "finished": False,
            "cancelled": False,
            "returncode": None,
            "startedAt": time.time(),
            "endedAt": 0.0,
            "archiveLock": threading.Lock(),
        }
    threading.Thread(target=_reader_thread, args=(job_id, proc), daemon=True).start()
    return {"ok": True, "job": job_id, "total": len(pages), "groupSize": group_size}


def _job_or_raise(payload: dict) -> dict:
    job = _MANGA_JOBS.get(str(payload.get("job") or ""))
    if not job:
        raise ValueError(tr('jobMissing'))
    return job


def _output_file(job: dict, index: int) -> Path | None:
    """The translated file for a GLOBAL page index.

    Matched by stem, not by position: a group holds several pages, and if one
    of them failed the surviving files would shift and every page after it
    would come back as the wrong picture. The stem is the index, so it cannot.
    """
    folder = job["ready"].get(index)
    if not folder:
        return None
    # Child progress is an input boundary too. Never expose another job's
    # files, a sibling folder, or a symlink leading out of this job.
    owned = job["out"].resolve()
    try:
        folder_path = Path(folder).resolve()
    except (TypeError, ValueError, OSError):
        return None
    if not folder_path.is_relative_to(owned):
        return None
    stem = f"{index:04d}"
    for path in sorted(folder_path.rglob("*")):
        if (path.is_file() and path.stem == stem
                and path.resolve().is_relative_to(owned)
                and path.suffix.lower().lstrip(".") in IMAGE_SUFFIXES):
            return path
    return None


def manga_status(payload: dict) -> dict:
    """Where the chapter has got to. Cheap enough to poll every second."""
    job = _job_or_raise(payload)
    with _MANGA_LOCK:
        ready = sorted(job["ready"].keys())
        failed = {str(k): v for k, v in job["failed"].items()}
        done = job["finished"]
        result = {
            "ok": True,
            "job": job["id"],
            "total": job["total"],
            "ready": ready,
            "failed": failed,
            "done": done,
            "cancelled": job["cancelled"],
            "failedPages": job["failedPages"],
            "notes": job["notes"][-3:],
            "elapsed": round((job["endedAt"] or time.time()) - job["startedAt"], 1),
        }
        # A run that ended having produced nothing needs a reason, and the
        # child's stderr is where it is. Read only at the end: this is polled.
        if done and not ready and not job["cancelled"]:
            handle = job.get("stderrHandle")
            if handle is not None:
                try:
                    handle.flush()
                except (OSError, ValueError):
                    pass
            tail = ""
            try:
                tail = job["stderr"].read_text(encoding="utf-8", errors="replace")
            except OSError:
                pass
            result["error"] = _manga_failure([], tail)
    return result


def manga_page(payload: dict) -> dict:
    """One finished page, as bytes the extension can show."""
    job = _job_or_raise(payload)
    index = int(payload.get("index") or 0)
    path = _output_file(job, index)
    if not path:
        raise ValueError(tr('pagePending', {'v0': index + 1}))
    size = path.stat().st_size
    if size > INLINE_LIMIT_BYTES:
        return {"ok": True, "index": index, "file": str(path), "tooLarge": True, "bytes": size}
    return {
        "ok": True,
        "index": index,
        "file": str(path),
        "bytes": size,
        "mime": MIME_BY_SUFFIX.get(path.suffix.lower().lstrip("."), "image/png"),
        "data": base64.b64encode(path.read_bytes()).decode("ascii"),
    }


def manga_cancel(payload: dict) -> dict:
    """Stop after the page in flight.

    Touching the flag file is the batch runner's OWN cancellation protocol, so
    the child stops cleanly between pages and still writes what it finished —
    which is why the pages already on screen stay there.
    """
    job = _job_or_raise(payload)
    with _MANGA_LOCK:
        if job["cancelled"] or job["finished"]:
            return {"ok": True, "job": job["id"]}
        job["cancelled"] = True
    try:
        job["cancelFlag"].write_text("1", encoding="utf-8")
    except OSError:
        pass
    # A child that ignores the flag (wedged inside a single page) is given a
    # few seconds and then ended; a background GPU job nobody is waiting for
    # is worse than an abrupt stop.
    def _reap():
        proc = job["proc"]
        if proc.poll() is None:
            try:
                proc.terminate()
            except OSError:
                pass
    with _MANGA_LOCK:
        if not job["finished"]:
            timer = threading.Timer(8.0, _reap)
            timer.daemon = True
            job["cancelTimer"] = timer
            timer.start()
    return {"ok": True, "job": job["id"]}


def manga_archive(payload: dict) -> dict:
    """Every finished page of a chapter, as a CBZ.

    A translated chapter is worth keeping, and a folder of numbered files deep
    inside the extension's directory is not something anyone will find twice.
    CBZ because that is what every manga reader on the machine already opens.
    """
    import zipfile

    job = _job_or_raise(payload)
    with job["archiveLock"]:
        archive = job["root"] / "chapter_fa.cbz"
        with zipfile.ZipFile(archive, "w", zipfile.ZIP_STORED) as bundle:
            for index in sorted(job["ready"].keys()):
                path = _output_file(job, index)
                if path:
                    # Re-numbered on the way in, so the archive reads in order even
                    # if a page in the middle failed and is missing.
                    bundle.write(path, f"{index:04d}{path.suffix.lower()}")
        size = archive.stat().st_size
        if size > INLINE_LIMIT_BYTES * 4:
            return {"ok": True, "file": str(archive), "tooLarge": True, "bytes": size}
        return {
            "ok": True,
            "file": str(archive),
            "bytes": size,
            "mime": "application/vnd.comicbook+zip",
            "data": base64.b64encode(archive.read_bytes()).decode("ascii"),
        }


# ------------------------------------------------------- updates (v3.0.0)


#: Packages the bridge's optional features are built on, with the feature each
#: one unlocks. The «به‌روزرسانی» control in the extension reports these, so a
#: user who never opens a terminal can still see that the thing making their
#: Persian voice is three versions behind.
TRACKED_PACKAGES = (
    ("edge-tts", "edge_tts", tr('speechLabel')),
    ("faster-whisper", "faster_whisper", tr('asrLabel')),
    ("rapidocr-onnxruntime", "rapidocr_onnxruntime", tr('ocrLabel')),
    ("onnxruntime", "onnxruntime", tr('modelLabel')),
    ("piper-tts", "piper", tr('offlineSpeech')),
)


def _installed_version(module: str) -> str:
    """Version of an installed package, or '' when it is not installed.

    importlib.metadata is used rather than importing the module: importing
    faster-whisper pulls a large dependency tree and can take seconds, and this
    endpoint has to answer a button press.
    """
    try:
        from importlib.metadata import PackageNotFoundError, version

        for name in (module, module.replace("_", "-")):
            try:
                return version(name)
            except PackageNotFoundError:
                continue
    except Exception:  # noqa: BLE001 - metadata is best-effort
        pass
    return ""


def _latest_version(dist: str, timeout: float = 4.0) -> str:
    """The newest version on PyPI, or '' if it cannot be reached.

    Deliberately short-timeout and failure-tolerant: this is a nicety, and a
    user offline (or behind a filter, which is common for this audience) must
    still get the installed-version half of the answer instantly.
    """
    try:
        import urllib.request

        url = f"https://pypi.org/pypi/{dist}/json"
        with urllib.request.urlopen(url, timeout=timeout) as response:  # noqa: S310
            data = json.loads(response.read().decode("utf-8", "replace"))
        return str(data.get("info", {}).get("version") or "")
    except Exception:  # noqa: BLE001 - offline is a normal state here
        return ""


def do_updates(payload: dict) -> dict:
    """What is installed, what is available, and the exact command to close the gap.

    The command is returned READY TO RUN and never executed here. Installing
    packages is a decision with disk, network and trust implications, and a
    web page — even this one's own extension — must not be able to make it on
    the user's behalf. So the bridge tells the truth and hands over the line to
    paste.
    """
    check_network = bool(payload.get("online", True))
    packages = []
    for dist, module, why in TRACKED_PACKAGES:
        installed = _installed_version(module)
        latest = _latest_version(dist) if check_network else ""
        packages.append({
            "name": dist,
            "why": why,
            "installed": installed,
            "latest": latest,
            "missing": not installed,
            # A plain string comparison is deliberately NOT called "outdated":
            # version ordering is subtle and a false "you are behind" is worse
            # than silence. Different-and-known is all this claims.
            "differs": bool(installed and latest and installed != latest),
            "install": f"{sys.executable} -m pip install -U {dist}",
        })
    return {
        "ok": True,
        "version": VERSION,
        "python": sys.version.split()[0],
        "executable": sys.executable,
        "packages": packages,
        "upgradeAll": f"{sys.executable} -m pip install -U "
                      + " ".join(p["name"] for p in packages if p["installed"]),
    }


# ------------------------------------------------------------ OCR (v3.0.0)


_OCR_ENGINE: object | None = None
_OCR_TRIED = False
_OCR_LOCK = threading.Lock()


def _ocr_engine():
    """A general-purpose OCR reader, loaded once.

    RapidOCR is chosen over the alternatives for three reasons that matter
    here: it is ONNX (so it runs on the CPU without a CUDA build), it is
    multilingual out of the box (Latin + CJK, which is what a screen region
    actually contains), and its models are small enough to ship with the wheel
    — no separate download step for the user to get wrong.

    MangaTranslator's own OCR is deliberately NOT reused: it is tuned for
    speech bubbles in comics and performs poorly on UI text, subtitles burned
    into video, and game dialogue, which is exactly what this path is for.
    """
    global _OCR_ENGINE, _OCR_TRIED  # noqa: PLW0603 - module-level singleton
    with _OCR_LOCK:
        if _OCR_TRIED:
            return _OCR_ENGINE
        _OCR_TRIED = True
        try:
            from rapidocr_onnxruntime import RapidOCR

            _OCR_ENGINE = RapidOCR()
        except Exception as exc:  # noqa: BLE001
            try:
                print(f"  ocr unavailable: {exc}")
            except Exception:  # noqa: BLE001
                pass
            _OCR_ENGINE = None
        return _OCR_ENGINE


def do_ocr(payload: dict) -> dict:
    """Read the text out of one image.

    THIS IS THE ENDPOINT THAT LETS THE PRODUCT LEAVE THE BROWSER. A browser
    extension can only translate what the DOM exposes; a screen region can
    contain a video game, a native application, a PDF in another viewer, or
    DRM-protected video — none of which any content script can reach. The
    extension captures pixels, this reads them, and the ordinary translation
    pipeline does the rest.

    Returns boxes as well as text so the caller can lay the Persian back over
    the original in roughly the right places.
    """
    data = payload.get("image") or ""
    if not data:
        return {"ok": False, "code": "EMPTY_INPUT", "error": tr('noImage')}
    engine = _ocr_engine()
    if engine is None:
        return {
            "ok": False,
            "code": "NO_OCR",
            "error": tr('ocrMissing'),
            "hint": f"{sys.executable} -m pip install rapidocr-onnxruntime",
        }
    try:
        raw = base64.b64decode(data.split(",", 1)[-1], validate=False)
    except Exception:  # noqa: BLE001
        return {"ok": False, "code": "BAD_IMAGE", "error": tr('imageUnreadable')}

    tmp = JOBS_DIR / f"ocr-{uuid.uuid4().hex}.png"
    try:
        tmp.parent.mkdir(parents=True, exist_ok=True)
        tmp.write_bytes(raw)
        result, _elapsed = engine(str(tmp))
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "code": "OCR_FAILED", "error": str(exc)}
    finally:
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass

    boxes = []
    for entry in result or []:
        try:
            quad, text, score = entry[0], entry[1], entry[2]
        except (IndexError, TypeError):
            continue
        text = str(text or "").strip()
        if not text:
            continue
        xs = [float(p[0]) for p in quad]
        ys = [float(p[1]) for p in quad]
        boxes.append({
            "text": text,
            "score": round(float(score or 0), 3),
            "x": round(min(xs)), "y": round(min(ys)),
            "w": round(max(xs) - min(xs)), "h": round(max(ys) - min(ys)),
        })
    # Reading order: top to bottom, then start-of-line. Without this the text
    # arrives in the detector's confidence order, which reads as nonsense and
    # gives the translator no sentence structure to work with.
    boxes.sort(key=lambda b: (b["y"] // max(8, b["h"] // 2 or 8), b["x"]))
    return {"ok": True, "boxes": boxes, "text": "\n".join(b["text"] for b in boxes)}


def do_manga(payload: dict) -> dict:
    """One page, start to finish, in a single call.

    Kept because a single right-clicked image is still a perfectly good thing
    to want, and because it is the compatibility surface for older builds. It
    is now expressed in terms of the job engine rather than duplicating it.
    """
    started = manga_start({"pages": [{
        "image": payload.get("image"),
        "name": payload.get("name") or "page.png",
    }], **{k: payload[k] for k in ("targetLang", "targetName", "direction") if k in payload}})
    job_id = started["job"]
    deadline = time.time() + MANGA_TIMEOUT_S
    while time.time() < deadline:
        status = manga_status({"job": job_id})
        if status["ready"]:
            page = manga_page({"job": job_id, "index": status["ready"][0]})
            job = _MANGA_JOBS[job_id]
            return {
                "ok": True,
                "outputs": [page.get("file", "")],
                "dir": str(job["out"]),
                "file": page.get("file", ""),
                "failedPages": status["failedPages"],
                "note": (status["notes"] or [""])[0],
                **({"data": page["data"], "mime": page["mime"]} if page.get("data") else {}),
            }
        if status["done"]:
            raise RuntimeError(status.get("error") or tr('emptyTranslation'))
        time.sleep(0.4)
    manga_cancel({"job": job_id})
    raise RuntimeError(tr('mangaTimeout', {'v0': MANGA_TIMEOUT_S // 60}))


def do_upscale(payload: dict) -> dict:
    """Queue a video for Anime Studio.

    HONEST LIMIT: Anime Studio keeps its queue in the running window, with no
    external drop point, so this cannot inject a job into a live session. What
    it does instead is durable and visible — the job is appended to a file the
    application's folder owns, and the application is launched if it is not
    already up, so the user finishes the hand-off in one click rather than by
    copying a URL by hand.
    """
    url = (payload.get("url") or "").strip()
    if not url:
        raise ValueError(tr('noVideoUrl'))
    JOBS_DIR.mkdir(parents=True, exist_ok=True)
    queue = JOBS_DIR / "anime-studio-queue.jsonl"
    with queue.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps({
            "url": url,
            "title": payload.get("title") or "",
            "page": payload.get("page") or "",
            "at": time.strftime("%Y-%m-%d %H:%M:%S"),
        }, ensure_ascii=False) + "\n")

    launched = False
    launcher = ANIME_DIR / "Anime Studio.cmd"
    if payload.get("launch") and launcher.exists():
        try:
            subprocess.Popen(["cmd", "/c", "start", "", str(launcher)],
                             cwd=str(ANIME_DIR), shell=False)
            launched = True
        except OSError:
            launched = False
    return {"ok": True, "queue": str(queue), "launched": launched}


# ----------------------------------------------------------------- server


class Handler(BaseHTTPRequestHandler):
    server_version = f"TarjomanBridge/{VERSION}"
    protocol_version = "HTTP/1.1"

    def setup(self):
        super().setup()
        self.connection.settimeout(REQUEST_TIMEOUT_S)

    # -- plumbing ----------------------------------------------------------

    def log_message(self, fmt, *args):  # noqa: A003 - stdlib signature
        """One readable line per request; the default logs are noise.

        NOTHING here may raise. `send_response` calls this on its way to
        writing the status line, so an exception in the logger aborts the
        RESPONSE — the caller gets a truncated connection and the window fills
        with tracebacks, for a debug line nobody asked for.

        That was not hypothetical: this line used to print a `→`, and a Windows
        console at its legacy code page cannot encode one. `_use_utf8_console`
        normally fixes that, but it is best-effort by design (it swallows
        AttributeError/OSError), so any launch where stdout cannot be
        reconfigured — piped, redirected, embedded — turned EVERY request into
        a UnicodeEncodeError inside the handler. ASCII, and a belt-and-braces
        `except`, so the logger can never be the thing that fails a request.
        """
        try:
            print(f"  {self.command} {self.path.split('?')[0]} -> "
                  f"{args[1] if len(args) > 1 else ''}")
        except Exception:  # noqa: BLE001 - logging must never break serving
            pass

    def _origin_ok(self) -> bool:
        origin = self.headers.get("Origin", "")
        # No Origin at all = a local tool such as curl, which loopback binding
        # already limits to this machine.
        return not origin or origin.startswith(ALLOWED_ORIGIN_PREFIXES)

    def _cors(self):
        origin = self.headers.get("Origin", "")
        if origin.startswith(ALLOWED_ORIGIN_PREFIXES):
            self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Bridge-Token, X-Tarjoman-Language")
        # Chrome 142+ gates public→loopback requests behind Local Network
        # Access. Without this header the preflight fails and every call looks
        # like an unexplained network error.
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Access-Control-Max-Age", "86400")

    def _send(self, code: int, body: bytes, mime: str):
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, code: int, obj: dict):
        obj = localize_metadata(obj)
        self._send(code, json.dumps(obj, ensure_ascii=False).encode("utf-8"),
                   "application/json; charset=utf-8")

    def _authed(self) -> bool:
        if not TOKEN or len(self.headers.get_all("X-Bridge-Token", [])) > 1:
            return False
        supplied = self.headers.get("X-Bridge-Token", "")
        if not supplied:
            supplied = parse_qs(urlparse(self.path).query).get("token", [""])[0]
        return secrets.compare_digest(supplied.encode("utf-8"), TOKEN.encode("utf-8"))

    # -- routes ------------------------------------------------------------

    def do_OPTIONS(self):  # noqa: N802 - stdlib signature
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):  # noqa: N802
        UI_LANGUAGE.set("en" if self.headers.get("X-Tarjoman-Language") == "en" else "fa")
        route = urlparse(self.path).path.rstrip("/") or "/"
        if route == "/health":
            # Unauthenticated ON PURPOSE: the extension has to be able to find
            # out the bridge is here before it can be paired with it, and this
            # reveals nothing but a list of feature names.
            self._json(200, {
                "ok": True,
                "name": "tarjoman-bridge",
                "version": VERSION,
                "capabilities": capabilities(),
                "ffmpeg": bool(_ffmpeg()),
                "needsToken": True,
            })
            return
        self._json(404, {"ok": False, "error": "unknown route"})

    def do_POST(self):  # noqa: N802
        UI_LANGUAGE.set("en" if self.headers.get("X-Tarjoman-Language") == "en" else "fa")
        route = urlparse(self.path).path.rstrip("/") or "/"
        if not self._origin_ok():
            self.close_connection = True
            self._json(403, {"ok": False, "code": "BAD_ORIGIN",
                             "error": tr('originDenied')})
            return
        if not self._authed():
            self.close_connection = True
            self._json(401, {"ok": False, "code": "BAD_TOKEN",
                             "error": tr('tokenDenied')})
            return
        try:
            lengths = self.headers.get_all("Content-Length", [])
            if (self.headers.get("Transfer-Encoding") is not None or len(lengths) > 1
                    or (lengths and not re.fullmatch(r"[0-9]+", lengths[0]))):
                raise ValueError("ambiguous request framing")
            length = int(lengths[0]) if lengths else 0
        except ValueError:
            self.close_connection = True
            self._json(400, {"ok": False, "code": "BAD_JSON", "error": tr('invalidBody')})
            return
        # A chapter upload is legitimately large, so the ceiling is generous —
        # but it IS a ceiling. `rfile.read(length)` allocates whatever the
        # header claims, so without one a single request could ask this process
        # to allocate gigabytes and take it down.
        if length < 0 or length > MAX_BODY_BYTES:
            self.close_connection = True
            self._json(413, {"ok": False, "code": "TOO_LARGE",
                             "error": tr('bodyLimit', {'v0': MAX_BODY_BYTES // (1024 * 1024)})})
            return
        try:
            raw = self.rfile.read(length) if length else b""
            if len(raw) != length:
                self.close_connection = True
                raise ValueError("incomplete request body")
            payload = json.loads(raw) if length else {}
        except (TimeoutError, socket.timeout):
            self.close_connection = True
            self._json(408, {"ok": False, "code": "REQUEST_TIMEOUT", "error": "request body timed out"})
            return
        except (ValueError, json.JSONDecodeError):
            self._json(400, {"ok": False, "code": "BAD_JSON", "error": tr('invalidBody')})
            return

        if not isinstance(payload, dict):
            self._json(400, {"ok": False, "code": "BAD_JSON", "error": tr('bodyObject')})
            return

        try:
            if route == "/tts":
                audio, mime = do_tts(payload)
                self._send(200, audio, mime)
                return
            if route == "/voices":
                self._json(200, do_voices(payload))
                return
            # v3.0.0 - what is installed locally, and the command to update it.
            if route == "/updates":
                self._json(200, do_updates(payload))
                return
            # v3.0.0 - read text out of any image, including a captured
            # screen region. This is what lets the product translate things
            # no content script can reach: games, native apps, DRM video.
            if route == "/ocr":
                self._json(200, do_ocr(payload))
                return
            if route == "/asr":
                self._json(200, do_asr(payload))
                return
            if route == "/manga":
                self._json(200, do_manga(payload))
                return
            # v2.5.8 — a chapter is a JOB: start returns at once, progress is
            # polled, finished pages are collected one at a time. A single
            # request that blocks for two minutes can report nothing and be
            # cancelled by nobody.
            if route == "/manga/start":
                self._json(200, manga_start(payload))
                return
            if route == "/manga/status":
                self._json(200, manga_status(payload))
                return
            if route == "/manga/page":
                self._json(200, manga_page(payload))
                return
            if route == "/manga/cancel":
                self._json(200, manga_cancel(payload))
                return
            if route == "/manga/archive":
                self._json(200, manga_archive(payload))
                return
            if route == "/upscale":
                self._json(200, do_upscale(payload))
                return
        except ModuleNotFoundError as exc:
            # The single most likely failure, and the one where a precise
            # message saves the user a search.
            self._json(503, {"ok": False, "code": "NOT_INSTALLED",
                             "error": tr('packageMissing', {'v0': exc.name}),
                             "hint": capabilities().get(route.strip('/'), {}).get("hint", "")})
            return
        except (ValueError, TypeError) as exc:
            self._json(400, {"ok": False, "code": "BAD_INPUT", "error": str(exc)})
            return
        except Exception as exc:  # noqa: BLE001 - the boundary reports everything
            self._json(500, {"ok": False, "code": "FAILED", "error": str(exc)})
            return
        self._json(404, {"ok": False, "error": "unknown route"})


def _port_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            probe.bind(("127.0.0.1", port))
            return True
        except OSError:
            return False


def _use_utf8_console() -> None:
    """Make the console able to print Persian.

    A Windows console still defaults to a legacy codepage (cp1252 here), and
    the very first banner line killed the process with a UnicodeEncodeError
    before the server ever started. `errors="replace"` on top, so that even a
    console that cannot render a glyph degrades to a question mark rather than
    taking the bridge down with it.
    """
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, OSError):
            pass


def main() -> int:
    global TOKEN
    _use_utf8_console()
    _maybe_reexec()
    TOKEN = load_token()
    port = DEFAULT_PORT
    if len(sys.argv) > 1 and sys.argv[1].isdigit():
        port = int(sys.argv[1])
    while not _port_free(port) and port < DEFAULT_PORT + 10:
        port += 1

    caps = capabilities()
    print("=" * 64)
    print(tr('banner', {'v0': VERSION}))
    print(f"  http://127.0.0.1:{port}")
    print("=" * 64)
    print(tr('tokenLabel'))
    print()
    print(f"      {TOKEN}")
    print()
    print(tr('capabilitiesLabel'))
    for name, cap in caps.items():
        mark = "✓" if cap["available"] else "✗"
        note = "" if cap["available"] else f"  ← {cap['hint']}"
        print(f"    {mark} {name}{note}")
    print()
    print(tr('keepOpen'))
    print("=" * 64)

    # Loopback only. Not a policy that can be relaxed by configuration: a
    # bridge that can run local programs has no business listening to a network.
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    server.daemon_threads = True
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print(tr('goodbye'))
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
