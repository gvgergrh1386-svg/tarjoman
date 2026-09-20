#!/usr/bin/env python3
"""Self-test for bridge.py — the half of this extension that runs programs.

WHY THIS EXISTS
───────────────
Everything else in this project is covered by dev/selftest.html and the mock
pages. The bridge was not covered by anything, and it is the one component that
launches local processes, writes to the disk, and listens on a socket. Its
failure modes are therefore the expensive kind: a leaked handle fills a disk, a
missing auth check runs a program for a web page.

It drives the REAL functions. The only thing stubbed is the child process
itself — a chapter translation needs a GPU and a language model, and neither is
a dependency a test should have. Everything the child would do (the event
stream, the output files) the stub does for real, on the real filesystem, so
the job engine, the file plumbing and the pruning are exercised exactly as they
run in production.

Run:  python bridge/selftest_bridge.py
"""
from __future__ import annotations

import base64
import http.client
import importlib.util
import json
import shutil
import sys
import tempfile
import threading
import time
from pathlib import Path
from unittest.mock import patch

HERE = Path(__file__).resolve().parent

# --------------------------------------------------------------- harness


results: list[tuple[str, bool, str]] = []


def check(name: str, fn) -> None:
    try:
        fn()
        results.append((name, True, ""))
    except AssertionError as exc:
        results.append((name, False, str(exc) or "assertion failed"))
    except Exception as exc:  # noqa: BLE001 - a crash is a failed test
        results.append((name, False, f"{type(exc).__name__}: {exc}"))


def load_bridge():
    """Import bridge.py without running main()."""
    spec = importlib.util.spec_from_file_location("tarjoman_bridge", HERE / "bridge.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# A 1×1 PNG: small, real, and a valid image for anything downstream.
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)


class StubChild:
    """Stands in for `python -m manga_translator --batch-runner`.

    Emits the same newline-delimited JSON event stream the real batch runner
    emits, and writes the same output files, so _reader_thread, _output_file,
    manga_status, manga_page and manga_archive all run for real.
    """

    def __init__(self, events, out_dir: Path, make_files=(), delay=0.0):
        self._events = events
        self._out_dir = out_dir
        self._make_files = make_files
        self._delay = delay
        self._done = threading.Event()
        self.returncode = None
        self.stdout = self._emit()
        self.terminated = False

    def _emit(self):
        for path in self._make_files:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(PNG)
        for event in self._events:
            if self._delay:
                time.sleep(self._delay)
            # Interleaved noise: ONNX runtime shares this pipe in production.
            yield "2026-07-29 warning: CUDA provider not available\n"
            yield json.dumps(event) + "\n"
        self._done.set()

    def wait(self):
        self._done.wait(timeout=5)
        self.returncode = 0
        return 0

    def poll(self):
        return 0 if self._done.is_set() else None

    def terminate(self):
        self.terminated = True
        self._done.set()


def run_job(bridge, tmp: Path, pages=2, group=2, fail_all=False, delay=0.0):
    """Start a real job whose child is the stub. Returns (job_id, child)."""
    created: dict = {}

    def fake_popen(argv, **kwargs):
        # The spec the real child would read tells us where output belongs.
        spec = json.loads(Path(argv[-1]).read_text(encoding="utf-8"))
        out = Path(spec["dst"])
        events = []
        files = []
        for folder in spec["sources"]:
            name = Path(folder).name
            group_out = out / f"{name}_fa"
            if fail_all:
                events.append({"type": "job_failed", "name": name, "msg": "no text found"})
            else:
                for src in sorted(Path(folder).glob("*.png")):
                    files.append(group_out / f"{src.stem}.png")
                events.append({"type": "job_done", "name": name, "out": str(group_out),
                               "failed_pages": 0})
        events.insert(0, {"type": "plan", "jobs": len(spec["sources"])})
        events.append({"type": "finished"})
        child = StubChild(events, out, files, delay)
        created["child"] = child
        return child

    bridge.subprocess.Popen = fake_popen
    payload = {
        "pages": [{"image": base64.b64encode(PNG).decode(), "name": f"{i}.png"}
                  for i in range(pages)],
        "concurrency": group,
    }
    started = bridge.manga_start(payload)
    assert started["ok"], started
    return started["job"], created["child"]


def wait_done(bridge, job_id, timeout=5.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        status = bridge.manga_status({"job": job_id})
        if status["done"]:
            return status
        time.sleep(0.02)
    raise AssertionError("job never finished")


# ----------------------------------------------------------------- tests


def main() -> int:
    # Same reason bridge.py does it: a Windows console at its legacy code page
    # cannot print the Persian in these test names.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, OSError):
            pass

    bridge = load_bridge()
    real_popen = bridge.subprocess.Popen
    tmp = Path(tempfile.mkdtemp(prefix="bridge-selftest-"))
    bridge.JOBS_DIR = tmp / "jobs"
    bridge.TOKEN = "test-token-value"

    # A venv path is required by manga_start; point it at this interpreter.
    bridge._venv_python = lambda project: Path(sys.executable)  # noqa: SLF001

    # -------------------------------------------------- job engine

    def t_job_lifecycle():
        job_id, child = run_job(bridge, tmp, pages=4, group=2)
        status = wait_done(bridge, job_id)
        assert status["total"] == 4, status
        assert status["ready"] == [0, 1, 2, 3], status["ready"]
        assert status["failedPages"] == 0, status
        page = bridge.manga_page({"job": job_id, "index": 2})
        assert page["ok"] and page["data"], page
        assert page["mime"] == "image/png", page
        assert base64.b64decode(page["data"]) == PNG, "wrong bytes came back"

    def t_pages_land_on_the_right_index():
        # The bug this pins is the one v2.5.8 already fixed once: output is
        # matched by STEM, so a page is never confused with its neighbour.
        job_id, _ = run_job(bridge, tmp, pages=3, group=3)
        wait_done(bridge, job_id)
        job = bridge._MANGA_JOBS[job_id]  # noqa: SLF001
        for index in range(3):
            path = bridge._output_file(job, index)  # noqa: SLF001
            assert path is not None, f"page {index} has no output"
            assert path.stem == f"{index:04d}", f"page {index} resolved to {path.name}"

    def t_archive_is_a_real_zip():
        import zipfile
        job_id, _ = run_job(bridge, tmp, pages=3, group=2)
        wait_done(bridge, job_id)
        archive = bridge.manga_archive({"job": job_id})
        assert archive["ok"] and archive["data"], archive
        blob = base64.b64decode(archive["data"])
        with zipfile.ZipFile(bridge._MANGA_JOBS[job_id]["root"] / "chapter_fa.cbz") as z:  # noqa: SLF001
            names = z.namelist()
        assert names == ["0000.png", "0001.png", "0002.png"], names
        assert blob[:2] == b"PK", "not a zip"

    def t_failure_gets_a_reason():
        job_id, _ = run_job(bridge, tmp, pages=2, group=2, fail_all=True)
        status = wait_done(bridge, job_id)
        assert not status["ready"], status
        assert status.get("error"), "a run that produced nothing must say why"

    # ------------------------------------- v2.7.0: handles and pruning

    def t_stderr_handle_is_closed_when_the_child_exits():
        job_id, _ = run_job(bridge, tmp, pages=1, group=1)
        wait_done(bridge, job_id)
        job = bridge._MANGA_JOBS[job_id]  # noqa: SLF001
        assert job["stderrHandle"] is None, "the log handle is still open"

    def t_finished_job_folders_are_actually_deleted():
        # The v2.5.8 bug: `shutil.rmtree(..., ignore_errors=True)` cannot remove
        # a folder that still holds an open handle, and ignore_errors hides the
        # failure — so nothing was EVER pruned on Windows.
        roots = []
        for _ in range(bridge.KEEP_JOBS + 4):
            job_id, _ = run_job(bridge, tmp, pages=1, group=1)
            wait_done(bridge, job_id)
            roots.append(bridge._MANGA_JOBS[job_id]["root"])  # noqa: SLF001
        bridge._prune_jobs()  # noqa: SLF001
        alive = [r for r in roots if r.exists()]
        assert len(alive) <= bridge.KEEP_JOBS, (
            f"{len(alive)} folders survived a prune, ceiling is {bridge.KEEP_JOBS}"
        )
        assert not roots[0].exists(), "the OLDEST job folder was not removed"

    def t_job_records_do_not_grow_without_bound():
        before = len(bridge._MANGA_JOBS)  # noqa: SLF001
        for _ in range(6):
            job_id, _ = run_job(bridge, tmp, pages=1, group=1)
            wait_done(bridge, job_id)
        bridge._prune_jobs()  # noqa: SLF001
        after = len(bridge._MANGA_JOBS)  # noqa: SLF001
        assert after <= bridge.KEEP_JOBS, f"{after} job records retained"
        assert after <= max(before, bridge.KEEP_JOBS), "records only grew"

    def t_a_running_job_is_never_pruned():
        # Pruning is by folder mtime, which says nothing about whether a child
        # is still writing into it. A long chapter started after a dozen short
        # ones must not be deleted out from under its own process.
        slow_id, slow_child = run_job(bridge, tmp, pages=2, group=1, delay=0.4)
        slow_root = bridge._MANGA_JOBS[slow_id]["root"]  # noqa: SLF001
        for _ in range(bridge.KEEP_JOBS + 3):
            job_id, _ = run_job(bridge, tmp, pages=1, group=1)
            wait_done(bridge, job_id)
        bridge._prune_jobs()  # noqa: SLF001
        assert slow_root.exists(), "a RUNNING job's folder was deleted"
        wait_done(bridge, slow_id)

    def t_oversized_chapter_is_refused_and_leaves_nothing_behind():
        before = set(bridge.JOBS_DIR.glob("manga-*")) if bridge.JOBS_DIR.exists() else set()
        limit = bridge.MAX_JOB_BYTES
        bridge.MAX_JOB_BYTES = 1024          # a ceiling this payload must cross
        try:
            big = base64.b64encode(b"\x00" * 4096).decode()
            try:
                bridge.manga_start({"pages": [{"image": big, "name": "a.png"}] * 3})
                raise AssertionError("an oversized chapter was accepted")
            except ValueError as exc:
                assert "حجم" in str(exc), str(exc)
        finally:
            bridge.MAX_JOB_BYTES = limit
        # Subset, not equality: manga_start prunes on entry, so folders may
        # legitimately DISAPPEAR here. The property under test is that nothing
        # NEW survives — the refused chapter's own staging is cleaned up.
        after = set(bridge.JOBS_DIR.glob("manga-*"))
        assert not (after - before), f"a refused chapter left staging behind: {after - before}"

    def t_page_count_ceiling():
        try:
            bridge.manga_start({"pages": [{"image": "", "name": "x.png"}]
                                * (bridge.MAX_PAGES_PER_JOB + 1)})
            raise AssertionError("accepted more pages than the ceiling")
        except ValueError as exc:
            assert str(bridge.MAX_PAGES_PER_JOB) in str(exc), str(exc)

    def t_the_logger_can_never_fail_a_request():
        # `send_response` calls log_message on its way to writing the status
        # line, so anything that throws there aborts the RESPONSE. This used to
        # print a `→`, which a Windows console at its legacy code page cannot
        # encode — and _use_utf8_console is best-effort, so any launch where
        # stdout cannot be reconfigured turned every request into a
        # UnicodeEncodeError inside the handler.
        import io as _io

        class Handle(bridge.Handler):
            def __init__(self):           # noqa: D107 - no socket, just the method
                self.command = "POST"
                self.path = "/manga/start?token=secret"

        legacy = _io.TextIOWrapper(_io.BytesIO(), encoding="cp1252", errors="strict")
        real_stdout = sys.stdout
        sys.stdout = legacy
        try:
            Handle().log_message('"%s" %s %s', "POST /x HTTP/1.1", "200", "-")
        except Exception as exc:  # noqa: BLE001
            raise AssertionError(f"the logger raised and would abort the response: {exc}")
        finally:
            sys.stdout = real_stdout
        legacy.flush()
        written = legacy.buffer.getvalue().decode("cp1252")
        assert "->" in written, f"expected an ASCII arrow, got {written!r}"
        # And the query string — which can carry the token — never reaches a log.
        assert "secret" not in written, f"the token was logged: {written!r}"

    def t_page_names_cannot_escape_the_jobs_folder():
        # The name comes from a URL on an untrusted page.
        for hostile in ("../../evil.png", "..\\..\\evil.png", "a/b/c.png", "x.exe", ""):
            data, suffix = bridge._decode_page({"image": base64.b64encode(PNG).decode(),  # noqa: SLF001
                                                "name": hostile}, 0)
            assert data == PNG
            assert suffix in bridge.IMAGE_SUFFIXES, f"{hostile!r} -> {suffix!r}"
            assert "/" not in suffix and "\\" not in suffix and ".." not in suffix

    for name, fn in [
        ("job lifecycle: start → status → page, real files on disk", t_job_lifecycle),
        ("a finished page resolves to its OWN index, matched by stem", t_pages_land_on_the_right_index),
        ("the chapter archive is a real, correctly-ordered CBZ", t_archive_is_a_real_zip),
        ("a run that produced nothing reports a reason", t_failure_gets_a_reason),
        ("v2.7.0: the child's stderr handle is closed when it exits", t_stderr_handle_is_closed_when_the_child_exits),
        ("v2.7.0: finished job folders are ACTUALLY deleted", t_finished_job_folders_are_actually_deleted),
        ("v2.7.0: job records do not grow without bound", t_job_records_do_not_grow_without_bound),
        ("v2.7.0: a RUNNING job is never pruned", t_a_running_job_is_never_pruned),
        ("v2.7.0: an oversized chapter is refused, staging cleaned up", t_oversized_chapter_is_refused_and_leaves_nothing_behind),
        ("the page-count ceiling holds", t_page_count_ceiling),
        ("v2.7.0: the logger can never fail a request (legacy code page)", t_the_logger_can_never_fail_a_request),
        ("a hostile page name cannot escape the jobs folder", t_page_names_cannot_escape_the_jobs_folder),
    ]:
        check(name, fn)

    bridge.subprocess.Popen = real_popen

    # ------------------------------------------------------ live HTTP

    server = bridge.ThreadingHTTPServer(("127.0.0.1", 0), bridge.Handler)
    server.daemon_threads = True
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()

    def request(method, path, body=None, headers=None, raw_length=None):
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
        payload = json.dumps(body).encode() if body is not None else None
        head = {"Content-Type": "application/json"}
        head.update(headers or {})
        if raw_length is not None:
            head["Content-Length"] = str(raw_length)
            conn.putrequest(method, path, skip_accept_encoding=True)
            for k, v in head.items():
                conn.putheader(k, v)
            conn.endheaders()
            conn.send(b"{}")
            response = conn.getresponse()
        else:
            conn.request(method, path, payload, head)
            response = conn.getresponse()
        data = response.read()
        status = response.status
        hdrs = dict(response.getheaders())
        conn.close()
        try:
            return status, json.loads(data or b"{}"), hdrs
        except json.JSONDecodeError:
            return status, {"_raw": data[:200]}, hdrs

    EXT = {"Origin": "chrome-extension://abcdefghijklmnopabcdefghijklmnop"}
    TOK = {"X-Bridge-Token": bridge.TOKEN}

    def t_health_is_open_and_identifies_itself():
        status, body, _ = request("GET", "/health")
        assert status == 200, status
        assert body["name"] == "tarjoman-bridge", body
        assert body["version"] == bridge.VERSION, body
        assert "capabilities" in body and body["needsToken"] is True, body

    def t_a_web_page_origin_is_refused():
        status, body, _ = request("POST", "/tts", {"text": "سلام"},
                                  {"Origin": "https://evil.example", **TOK})
        assert status == 403, status
        assert body["code"] == "BAD_ORIGIN", body

    def t_a_missing_or_wrong_token_is_refused():
        for headers in ({**EXT}, {**EXT, "X-Bridge-Token": "wrong"}):
            status, body, _ = request("POST", "/tts", {"text": "سلام"}, headers)
            assert status == 401, (headers, status)
            assert body["code"] == "BAD_TOKEN", body

    def t_v270_an_oversized_body_is_refused_before_it_is_read():
        status, body, _ = request("POST", "/manga/start", None, {**EXT, **TOK},
                                  raw_length=bridge.MAX_BODY_BYTES + 1)
        assert status == 413, status
        assert body["code"] == "TOO_LARGE", body

    def t_cors_only_answers_an_extension():
        _, _, headers = request("OPTIONS", "/tts", None, EXT)
        assert headers.get("Access-Control-Allow-Origin") == EXT["Origin"], headers
        assert headers.get("Access-Control-Allow-Private-Network") == "true", headers
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        conn.request("OPTIONS", "/tts", None, {"Origin": "https://evil.example"})
        r = conn.getresponse()
        r.read()
        allow = dict(r.getheaders()).get("Access-Control-Allow-Origin")
        conn.close()
        assert allow is None, f"a web origin was granted CORS: {allow}"

    def t_unknown_routes_are_404_not_500():
        status, body, _ = request("POST", "/../../etc/passwd", {}, {**EXT, **TOK})
        assert status == 404, status
        status, _, _ = request("GET", "/nope")
        assert status == 404, status

    def t_malformed_json_is_a_400():
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        conn.request("POST", "/tts", b"{not json", {**EXT, **TOK,
                                                    "Content-Type": "application/json"})
        r = conn.getresponse()
        body = json.loads(r.read())
        conn.close()
        assert r.status == 400 and body["code"] == "BAD_JSON", body

    def t_a_missing_dependency_is_reported_as_installable():
        # /asr with faster-whisper absent must be a 503 NOT_INSTALLED carrying
        # the install command — not a 500 stack trace.
        # This branch must run even on a developer machine where Whisper is
        # installed. Accepting any status silently skipped the assertion.
        missing = ModuleNotFoundError("injected missing optional dependency", name="faster_whisper")
        with patch.object(bridge, "do_asr", side_effect=missing):
            status, body, _ = request("POST", "/asr", {"audio": "", "model": "small"},
                                      {**EXT, **TOK})
        assert status == 503, status
        assert body["code"] == "NOT_INSTALLED" and body.get("hint"), body

    def t_json_must_be_an_object():
        for payload in ([], "text", 42):
            status, body, _ = request("POST", "/tts", payload, {**EXT, **TOK})
            assert status == 400 and body["code"] == "BAD_JSON", (status, body)

    def t_rejected_upload_closes_the_unread_connection():
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        conn.request("POST", "/tts", b'{"text":"hello"}', EXT)
        response = conn.getresponse()
        assert response.status == 401
        response.read()
        # Bytes from the rejected JSON body must not be parsed as another HTTP
        # request on a keep-alive socket (the old handler emitted a second 400).
        sock = conn.sock
        assert sock is not None and sock.recv(1) == b"", "unread request body kept the socket alive"
        conn.close()

    for name, fn in [
        ("live: /health is open, and identifies this bridge", t_health_is_open_and_identifies_itself),
        ("live: a web-page Origin is refused outright", t_a_web_page_origin_is_refused),
        ("live: a missing or wrong token is refused", t_a_missing_or_wrong_token_is_refused),
        ("live v2.7.0: an oversized body is refused before allocation", t_v270_an_oversized_body_is_refused_before_it_is_read),
        ("live: CORS is granted to an extension and to nobody else", t_cors_only_answers_an_extension),
        ("live: unknown routes are 404, never 500", t_unknown_routes_are_404_not_500),
        ("live: malformed JSON is a clean 400", t_malformed_json_is_a_400),
        ("live: non-object JSON is a clean 400", t_json_must_be_an_object),
        ("live: rejected uploads close their unread connection", t_rejected_upload_closes_the_unread_connection),
        ("live: a missing dependency is installable, not broken", t_a_missing_dependency_is_reported_as_installable),
    ]:
        check(name, fn)

    server.shutdown()
    server.server_close()
    shutil.rmtree(tmp, ignore_errors=True)

    # ------------------------------------------------------- report

    passed = sum(1 for _, ok, _ in results if ok)
    for name, ok, msg in results:
        mark = "PASS" if ok else "FAIL"
        print(f"{mark} {name}" + (f" — {msg}" if msg else ""))
    print(f"\nBRIDGE-SELFTEST SUMMARY {passed}/{len(results)}")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
