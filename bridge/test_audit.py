"""Offline 3.7.0 regressions. Use --root PATH to test an unchanged baseline."""
import argparse
import base64
import concurrent.futures
import http.client
import importlib.util
import io
import json
from pathlib import Path
import socket
import sys
import tempfile
import threading
import time
import types
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


class BridgeAudit(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location("audit_bridge", ROOT / "bridge/bridge.py")
        self.b = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.b)
        self.tmp = tempfile.TemporaryDirectory(prefix="bridge-audit-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.b.JOBS_DIR = self.root / "jobs"
        self.b.ANIME_DIR = self.root / "absent"
        self.b.MANGA_DIR = self.root / "manga"
        self.b.TOKEN = "audit-only-ephemeral-token"
        self.b._venv_python = lambda _: Path(sys.executable)

    def payload(self):
        return {"pages": [{"image": "aGVsbG8=", "name": "x.png"}]}

    def test_language_context_is_request_local(self):
        def render(lang):
            self.b.UI_LANGUAGE.set(lang)
            return self.b.tr('noText')
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
            values=list(executor.map(render,['fa','en']))
        self.assertNotEqual(values[0],values[1])
        self.assertEqual(values[1],self.b.MESSAGES['noText']['en'])

    def test_localization_preserves_user_and_technical_payload(self):
        self.b.UI_LANGUAGE.set('en')
        original=self.b.MESSAGES['noText']['fa']
        result=self.b.localize_metadata({'error':original,'text':original,'job':'synthetic-id','number':17})
        self.assertEqual(result['error'],self.b.MESSAGES['noText']['en'])
        self.assertEqual(result['text'],original)
        self.assertEqual(result['job'],'synthetic-id')
        self.assertEqual(result['number'],17)

    def test_missing_ffmpeg_is_unavailable(self):
        with patch.object(self.b.shutil, "which", return_value=None):
            self.assertIsNone(self.b._ffmpeg())

    def test_invalid_page_rolls_back_staging(self):
        payload = self.payload()
        payload["pages"].append({"image": "", "name": "bad.png"})
        with self.assertRaises(ValueError):
            self.b.manga_start(payload)
        self.assertEqual(list(self.b.JOBS_DIR.glob("manga-*")), [])

    def test_launch_failure_closes_handle_and_rolls_back_staging(self):
        handles = []
        def launch(*args, **kwargs):
            handles.append(kwargs["stderr"])
            raise OSError("injected spawn failure")
        with patch.object(self.b.subprocess, "Popen", side_effect=launch):
            with self.assertRaises(OSError):
                self.b.manga_start(self.payload())
        try:
            self.assertTrue(handles and handles[0].closed, "child stderr leaked")
            self.assertEqual(list(self.b.JOBS_DIR.glob("manga-*")), [])
        finally:
            for handle in handles:
                handle.close()

    def test_output_must_remain_in_owned_directory(self):
        outside = self.root / "outside"
        outside.mkdir()
        (outside / "0000.png").write_bytes(b"private-image")
        job = {"ready": {0: str(outside)}, "out": self.root / "owned" / "out"}
        self.assertIsNone(self.b._output_file(job, 0))

    def test_cancel_is_idempotent_and_timer_is_daemon(self):
        class Proc:
            def poll(self): return None
        timers = []
        class Timer:
            daemon = False
            def __init__(self, *args, **kwargs): timers.append(self)
            def start(self): pass
        job = {"id": "a", "proc": Proc(), "cancelFlag": self.root / "cancel",
               "cancelled": False, "finished": False}
        self.b._MANGA_JOBS["a"] = job
        with patch.object(self.b.threading, "Timer", Timer):
            for _ in range(20): self.b.manga_cancel({"job": "a"})
        self.assertEqual(len(timers), 1)
        self.assertTrue(timers[0].daemon)
        self.assertEqual(job["cancelFlag"].read_text(), "1")

    def test_finished_event_waits_for_process_exit_and_closes_stdout(self):
        entered, release = threading.Event(), threading.Event()
        class Proc:
            stdout = io.StringIO('{"type":"finished"}\n')
            def wait(self):
                entered.set()
                release.wait(2)
                return 0
        proc = Proc()
        job = {"finished": False, "stderrHandle": None}
        self.b._MANGA_JOBS["a"] = job
        thread = threading.Thread(target=self.b._reader_thread, args=("a", proc))
        thread.start()
        try:
            self.assertTrue(entered.wait(1))
            self.assertFalse(job["finished"], "reported completion while child still alive")
        finally:
            release.set()
            thread.join(3)
        self.assertTrue(job["finished"])
        self.assertTrue(proc.stdout.closed, "stdout pipe leaked")

    def test_ocr_concurrent_requests_have_unique_files(self):
        barrier = threading.Barrier(2)
        seen = []
        def engine(path):
            seen.append(Path(path))
            barrier.wait(timeout=2)
            actual = Path(path).read_bytes()
            return [([[0, 0], [8, 0], [8, 8], [0, 8]], actual.decode(), 1)], None
        with patch.object(self.b, "_ocr_engine", return_value=engine), \
             patch.object(self.b.time, "time", return_value=1234.5):
            with concurrent.futures.ThreadPoolExecutor(2) as pool:
                responses = list(pool.map(lambda data: self.b.do_ocr({
                    "image": base64.b64encode(data).decode()}), [b"alpha", b"beta"]))
        self.assertEqual(len(set(seen)), 2, "two OCR requests shared a staging file")
        self.assertEqual([r.get("text") for r in responses], ["alpha", "beta"])
        self.assertFalse(any(p.exists() for p in seen))

    def test_ocr_initialization_is_shared_by_concurrent_requests(self):
        entered, release = threading.Event(), threading.Event()
        engine = object()
        constructed = []
        def create():
            constructed.append(True)
            entered.set()
            release.wait(2)
            return engine
        dependency = types.SimpleNamespace(RapidOCR=create)
        with patch.dict(sys.modules, {"rapidocr_onnxruntime": dependency}):
            with concurrent.futures.ThreadPoolExecutor(2) as pool:
                first = pool.submit(self.b._ocr_engine)
                self.assertTrue(entered.wait(1))
                second = pool.submit(self.b._ocr_engine)
                time.sleep(.03)
                release.set()
                self.assertIs(first.result(2), engine)
                self.assertIs(second.result(2), engine)
        self.assertEqual(len(constructed), 1)

    def test_http_bad_input_is_400(self):
        port = self.start_server()
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=1)
        self.addCleanup(connection.close)
        connection.request("POST", "/manga/start", b'{"pages":[]}',
                           {"X-Bridge-Token": self.b.TOKEN})
        response = connection.getresponse()
        self.assertEqual(response.status, 400)
        self.assertEqual(json.loads(response.read())["code"], "BAD_INPUT")

    def test_concurrent_archives_do_not_write_the_same_file_at_once(self):
        import zipfile
        root = self.root / "job"
        out = root / "out"
        out.mkdir(parents=True)
        (out / "0000.png").write_bytes(b"image-data")
        job = {"id": "a", "root": root, "out": out, "ready": {0: str(out)},
               "archiveLock": threading.Lock()}
        self.b._MANGA_JOBS["a"] = job
        first_entered, release = threading.Event(), threading.Event()
        counts = {"active": 0, "peak": 0}
        lock = threading.Lock()
        real_zip = zipfile.ZipFile
        class ObservedZip(real_zip):
            def __init__(self, *args, **kwargs):
                with lock:
                    counts["active"] += 1
                    counts["peak"] = max(counts["peak"], counts["active"])
                first_entered.set()
                release.wait(2)
                super().__init__(*args, **kwargs)
            def __exit__(self, *args):
                try: return super().__exit__(*args)
                finally:
                    with lock: counts["active"] -= 1
        with patch.object(zipfile, "ZipFile", ObservedZip):
            with concurrent.futures.ThreadPoolExecutor(2) as pool:
                one = pool.submit(self.b.manga_archive, {"job": "a"})
                self.assertTrue(first_entered.wait(1))
                two = pool.submit(self.b.manga_archive, {"job": "a"})
                time.sleep(.05)
                release.set()
                responses = [one.result(3), two.result(3)]
        self.assertEqual(counts["peak"], 1, "concurrent requests truncated the shared archive")
        for response in responses:
            with real_zip(io.BytesIO(base64.b64decode(response["data"]))) as archive:
                self.assertEqual(archive.read("0000.png"), b"image-data")

    def test_malformed_child_counter_does_not_drop_later_output(self):
        out = self.root / "out"
        out.mkdir()
        (out / "0000.png").write_bytes(b"page")
        job = {"groups": {"g0000": [0]}, "ready": {}, "failed": {}, "notes": [],
               "failedPages": 0, "finished": False, "stderrHandle": None,
               "out": out}
        self.b._MANGA_JOBS["a"] = job
        class Proc:
            stdout = io.StringIO(json.dumps({"type": "plan", "jobs": "broken"}) + "\n" +
                                 json.dumps({"type": "job_done", "name": "g0000", "out": str(out)}) + "\n")
            def wait(self): return 0
        self.b._reader_thread("a", Proc())
        self.assertEqual(list(job["ready"]), [0])

    def test_partial_group_only_advertises_existing_pages(self):
        out = self.root / "out"
        out.mkdir()
        (out / "0000.png").write_bytes(b"page")
        job = {"groups": {"g0000": [0, 1]}, "ready": {}, "failed": {}, "notes": [],
               "failedPages": 0, "finished": False, "stderrHandle": None,
               "out": out}
        self.b._MANGA_JOBS["a"] = job
        class Proc:
            stdout = io.StringIO(json.dumps({"type": "job_done", "name": "g0000", "out": str(out),
                                             "failed_pages": 1}) + "\n")
            def wait(self): return 0
        self.b._reader_thread("a", Proc())
        self.assertEqual(list(job["ready"]), [0])
        self.assertIn(1, job["failed"])

    def test_real_child_cancel_restart_and_cleanup(self):
        self.b.MANGA_DIR.mkdir()
        (self.b.MANGA_DIR / "manga_translator.py").write_text('''import json, pathlib, sys, time
spec=json.loads(pathlib.Path(sys.argv[-1]).read_text())
print(json.dumps({"type":"plan","jobs":len(spec["sources"])}),flush=True)
deadline=time.monotonic()+4
while not pathlib.Path(spec["cancel_flag"]).exists() and time.monotonic()<deadline: time.sleep(.01)
print(json.dumps({"type":"finished"}),flush=True)
''', encoding="utf-8")
        for _ in range(3):
            started = self.b.manga_start(self.payload())
            job = self.b._MANGA_JOBS[started["job"]]
            self.addCleanup(lambda proc=job["proc"]: proc.kill() if proc.poll() is None else None)
            self.b.manga_cancel({"job": started["job"]})
            deadline = time.monotonic() + 3
            while not self.b.manga_status({"job": started["job"]})["done"] and time.monotonic() < deadline:
                time.sleep(.01)
            self.assertIsNotNone(job["proc"].poll(), "cancel did not finish real child")
            self.assertTrue(job["cancelled"])
            self.assertIsNone(job["stderrHandle"])
            self.assertTrue(job["proc"].stdout.closed)
            timer = job.get("cancelTimer")
            self.assertTrue(timer is None or timer.finished.is_set(), "cancellation timer survived completion")

    def start_server(self):
        self.b.REQUEST_TIMEOUT_S = 0.15
        class Quiet(self.b.Handler):
            def log_message(self, *_): pass
        server = self.b.ThreadingHTTPServer(("127.0.0.1", 0), Quiet)
        server.daemon_threads = True
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        return server.server_address[1]

    def raw(self, headers, body=b"", shutdown=False):
        port = self.start_server()
        sock = socket.create_connection(("127.0.0.1", port), timeout=1)
        self.addCleanup(sock.close)
        request = ("POST /unknown HTTP/1.1\r\nHost: 127.0.0.1\r\n"
                   f"X-Bridge-Token: {self.b.TOKEN}\r\n" + headers + "\r\n").encode()
        sock.sendall(request + body)
        if shutdown: sock.shutdown(socket.SHUT_WR)
        response = http.client.HTTPResponse(sock)
        response.begin()
        response.read()
        return response.status

    def test_transfer_encoding_is_rejected(self):
        self.assertEqual(self.raw("Transfer-Encoding: chunked\r\n", b"0\r\n\r\n"), 400)

    def test_duplicate_content_length_is_rejected(self):
        self.assertEqual(self.raw("Content-Length: 2\r\nContent-Length: 8\r\n", b"{}"), 400)

    def test_signed_content_length_is_rejected(self):
        self.assertEqual(self.raw("Content-Length: +2\r\n", b"{}"), 400)

    def test_partial_body_is_rejected(self):
        self.assertEqual(self.raw("Content-Length: 20\r\n", b"{}", shutdown=True), 400)

    def test_stalled_body_times_out(self):
        self.assertEqual(self.raw("Content-Length: 20\r\n", b"{"), 408)

    def test_non_ascii_token_is_rejected_without_disconnect(self):
        port = self.start_server()
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=1)
        self.addCleanup(connection.close)
        connection.request("POST", "/unknown?token=%D8%B3%D9%84%D8%A7%D9%85", b"{}")
        response = connection.getresponse()
        self.assertEqual(response.status, 401)
        response.read()

    def test_empty_configured_token_fails_closed(self):
        self.b.TOKEN = ""
        self.assertEqual(self.raw("Content-Length: 2\r\n", b"{}"), 401)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=ROOT)
    args, rest = parser.parse_known_args()
    ROOT = args.root.resolve()
    unittest.main(argv=[sys.argv[0], *rest], verbosity=2)
