"""Adversarial tests for the test infrastructure; no external services."""
import argparse
import importlib.util
import json
from pathlib import Path
import socket
import struct
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


def load_harness():
    sys.modules.pop("cdp", None)
    spec = importlib.util.spec_from_file_location("audit_harness", ROOT / "dev/run_harness.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class RunnerAudit(unittest.TestCase):
    def setUp(self): self.h = load_harness()

    def test_failed_count_does_not_lower_baseline(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.h.BASELINE = Path(tmp) / "baseline.json"
            self.h.BASELINE.write_text('{"a":10,"b":10}')
            before = self.h.BASELINE.read_bytes()
            self.assertTrue(self.h.check_counts({"a": 8, "b": 11}, False))
            self.assertEqual(self.h.BASELINE.read_bytes(), before)

    def test_missing_baseline_is_failure(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.h.BASELINE = Path(tmp) / "absent.json"
            self.assertTrue(self.h.check_counts({"a": 1}, False))

    def test_invalid_baseline_is_failure(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.h.BASELINE = Path(tmp) / "baseline.json"
            self.h.BASELINE.write_text('{"a":true}')
            self.assertTrue(self.h.check_counts({"a": 1}, False))

    def test_navigation_events_are_not_lost(self):
        class Sock:
            def settimeout(self, value): pass
        class WS:
            sock = Sock()
            events = []
            def call(self, method, *args, **kwargs):
                if method == "Target.createTarget": return {"targetId": "target"}
                if method == "Target.attachToTarget": return {"sessionId": "session"}
                if method == "Page.navigate":
                    self.events = [
                        {"sessionId": "session", "method": "Runtime.exceptionThrown",
                         "params": {"exceptionDetails": {"text": "injected early failure"}}},
                        {"sessionId": "session", "method": "Runtime.consoleAPICalled",
                         "params": {"type": "log", "args": [{"value": "GXT-TEST SUMMARY 0/0"}]}}]
                return {}
            def recv(self): raise TimeoutError()
        lines, summary = self.h.collect(WS(), "http://test", .01)
        self.assertIsNotNone(summary)
        self.assertTrue(any("injected early failure" in line for line in lines))

    def main_with(self, lines, summary):
        import contextlib
        @contextlib.contextmanager
        def serve(): yield 80, None, None
        with patch.object(self.h, "PAGES", ["selftest.html"]), \
             patch.object(self.h, "check_literal_sheets", return_value=[]), \
             patch.object(self.h, "serve", serve), \
             patch.object(self.h, "collect", return_value=(lines, summary)), \
             patch.object(self.h, "check_counts", return_value=[]), \
             patch.object(sys, "argv", ["run_harness.py"]):
            return self.h.main()

    def test_summary_cannot_invent_checks(self):
        summary = "GXT-TEST SUMMARY 2/2"
        self.assertNotEqual(self.main_with(["GXT-TEST PASS actual", summary], summary), 0)

    def test_multiline_check_name_counts_once(self):
        summary = "GXT-TEST SUMMARY 1/1"
        self.assertEqual(self.main_with(["GXT-TEST PASS line one\nline two", summary], summary), 0)

    def test_missing_summary_fails(self):
        self.assertNotEqual(self.main_with(["GXT-TEST PASS partial"], None), 0)

    def test_runtime_error_fails_even_with_passing_summary(self):
        summary = "GXT-TEST SUMMARY 1/1"
        self.assertNotEqual(self.main_with(["GXT-TEST PASS actual", summary,
                                            "GXT-RUNTIME FAIL injected"], summary), 0)

    def test_zero_checks_fails(self):
        summary = "GXT-TEST SUMMARY 0/0"
        self.assertNotEqual(self.main_with([summary], summary), 0)

    def test_summary_cannot_hide_failure(self):
        summary = "GXT-TEST SUMMARY 1/1"
        self.assertNotEqual(self.main_with(["GXT-TEST FAIL actual", summary], summary), 0)

    def test_browser_start_failure_is_clean_exit(self):
        import contextlib
        @contextlib.contextmanager
        def fail():
            raise RuntimeError("injected browser failure")
            yield
        with patch.object(self.h, "serve", fail), \
             patch.object(self.h, "check_literal_sheets", return_value=[]), \
             patch.object(sys, "argv", ["run_harness.py", "selftest"]):
            self.assertEqual(self.h.main(), 2)

    def socket_client(self, chunks):
        class Sock:
            def __init__(self): self.chunks = iter(chunks); self.sent = []
            def recv(self, n):
                chunk = next(self.chunks, b"")
                if isinstance(chunk, Exception): raise chunk
                return chunk
            def sendall(self, data): self.sent.append(data)
        ws = self.h.cdp.WS.__new__(self.h.cdp.WS)
        ws.sock = Sock()
        ws._rest = b""
        return ws

    def test_fragmented_message_is_reassembled(self):
        ws = self.socket_client([b"\x01\x03hel\x80\x02lo"])
        self.assertEqual(ws.recv(), "hello")

    def test_ping_pong_echoes_payload(self):
        ws = self.socket_client([b"\x89\x03abc\x81\x02ok"])
        self.assertEqual(ws.recv(), "ok")
        frame = ws.sock.sent[0]
        self.assertEqual(frame[1] & 127, 3)
        mask = frame[2:6]
        self.assertEqual(bytes(v ^ mask[i % 4] for i, v in enumerate(frame[6:])), b"abc")

    def test_timeout_mid_frame_preserves_bytes(self):
        ws = self.socket_client([b"\x81\x05he", TimeoutError(), b"llo"])
        with self.assertRaises(TimeoutError): ws.recv()
        self.assertEqual(ws.recv(), "hello")

    def test_invalid_handshake_is_rejected_and_socket_closed(self):
        class Sock:
            closed = False
            def settimeout(self, value): pass
            def sendall(self, data): pass
            def recv(self, size):
                return b"HTTP/1.1 200 text101\r\nContent-Length: 0\r\n\r\n"
            def close(self): self.closed = True
        sock = Sock()
        with patch.object(self.h.cdp.socket, "create_connection", return_value=sock):
            with self.assertRaises(ConnectionError):
                self.h.cdp.WS("ws://127.0.0.1:1/test")
        self.assertTrue(sock.closed)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=ROOT)
    args, rest = parser.parse_known_args()
    ROOT = args.root.resolve()
    unittest.main(argv=[sys.argv[0], *rest], verbosity=2)
