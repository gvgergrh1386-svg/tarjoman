"""A minimal CDP client over a hand-rolled WebSocket. Stdlib only.

Branded Google Chrome (137+) refuses `--load-extension` outright:

    WARNING: --load-extension is not allowed in Google Chrome, ignoring.

The supported replacement is the DevTools command `Extensions.loadUnpacked`,
which needs a WebSocket. Rather than take a dependency for one call, this is
the ~90 lines of RFC 6455 that a client actually needs: an HTTP Upgrade, masked
text frames out, unmasked frames in.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import socket
import struct
import time
import urllib.request


class WS:
    def __init__(self, url: str, timeout: float = 30.0):
        assert url.startswith("ws://"), url
        rest = url[5:]
        hostport, _, path = rest.partition("/")
        host, _, port = hostport.partition(":")
        self.sock = socket.create_connection((host, int(port or 80)), timeout=timeout)
        self.sock.settimeout(timeout)
        key = base64.b64encode(os.urandom(16)).decode()
        req = (
            f"GET /{path} HTTP/1.1\r\n"
            f"Host: {hostport}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n\r\n"
        )
        try:
            self.sock.sendall(req.encode())
            buf = b""
            while b"\r\n\r\n" not in buf:
                chunk = self.sock.recv(4096)
                if not chunk:
                    raise ConnectionError("handshake closed")
                buf += chunk
                if len(buf) > 65536:
                    raise ConnectionError("oversized WebSocket handshake")
            head = buf.split(b"\r\n\r\n", 1)[0].decode("ascii")
            status, *header_lines = head.split("\r\n")
            headers = dict((name.strip().lower(), value.strip())
                           for name, value in (line.split(":", 1) for line in header_lines))
            accept = base64.b64encode(hashlib.sha1(
                (key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
            if (len(status.split()) < 2 or status.split()[1] != "101"
                    or headers.get("upgrade", "").lower() != "websocket"
                    or "upgrade" not in [v.strip().lower() for v in headers.get("connection", "").split(",")]
                    or headers.get("sec-websocket-accept") != accept):
                raise ConnectionError("invalid WebSocket handshake")
        except Exception:
            self.sock.close()
            raise
        self._rest = buf.split(b"\r\n\r\n", 1)[1]
        self._id = 0
        self.events = []
        self._fragments = bytearray()
        self._fragment_opcode = None

    # -- framing -----------------------------------------------------------
    def _recv_exact(self, n: int) -> bytes:
        self._ensure(n)
        out, self._rest = self._rest[:n], self._rest[n:]
        return out

    def _ensure(self, n: int) -> None:
        # Keep every byte until a COMPLETE frame can be consumed. A socket
        # timeout may occur after its header or halfway through its payload.
        while len(self._rest) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise ConnectionError("closed mid-frame")
            self._rest += chunk

    def send(self, text: str) -> None:
        self._send_frame(0x1, text.encode("utf-8"))

    def _send_frame(self, opcode: int, payload: bytes) -> None:
        header = bytearray([0x80 | opcode])
        length = len(payload)
        if length < 126:
            header.append(0x80 | length)
        elif length < 65536:
            header.append(0x80 | 126)
            header += struct.pack(">H", length)
        else:
            header.append(0x80 | 127)
            header += struct.pack(">Q", length)
        mask = os.urandom(4)
        header += mask
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        self.sock.sendall(bytes(header) + masked)

    def recv(self) -> str:
        while True:
            self._ensure(2)
            b0, b1 = self._rest[:2]
            opcode = b0 & 0x0F
            final = bool(b0 & 0x80)
            if b0 & 0x70 or b1 & 0x80:
                raise ConnectionError("unsupported WebSocket frame flags")
            length = b1 & 0x7F
            offset = 2
            if length == 126:
                self._ensure(4)
                length = struct.unpack(">H", self._rest[2:4])[0]
                offset = 4
            elif length == 127:
                self._ensure(10)
                length = struct.unpack(">Q", self._rest[2:10])[0]
                offset = 10
            if length > 64 * 1024 * 1024:
                raise ConnectionError("WebSocket frame exceeds 64 MiB")
            if opcode >= 8 and (not final or length > 125):
                raise ConnectionError("invalid control frame")
            self._ensure(offset + length)
            data = self._rest[offset:offset + length]
            self._rest = self._rest[offset + length:]
            if opcode == 0x8:                            # close
                raise ConnectionError("server closed")
            if opcode == 0x9:                            # ping -> pong
                self._send_frame(0xA, data)
                continue
            if opcode == 0xA:
                continue
            active = getattr(self, "_fragment_opcode", None)
            if opcode in (0x1, 0x2) and active is None:
                self._fragment_opcode = opcode
                self._fragments = bytearray()
            elif opcode != 0 or active is None:
                raise ConnectionError("unexpected fragmented message")
            self._fragments.extend(data)
            if len(self._fragments) > 64 * 1024 * 1024:
                raise ConnectionError("WebSocket message exceeds 64 MiB")
            if final:
                data = bytes(self._fragments)
                self._fragments.clear()
                self._fragment_opcode = None
                return data.decode("utf-8", "strict")

    # -- CDP ---------------------------------------------------------------
    def call(self, method: str, params: dict | None = None, session: str | None = None,
             timeout_calls: int = 200) -> dict:
        self._id += 1
        msg = {"id": self._id, "method": method, "params": params or {}}
        if session:
            msg["sessionId"] = session
        self.send(json.dumps(msg))
        # Busy real pages can emit thousands of Network events before a
        # command's response. Event count is not a timeout.
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            reply = json.loads(self.recv())
            if "method" in reply:
                self.events.append(reply)
                if len(self.events) > 100000:
                    raise RuntimeError("CDP event queue overflow; refusing to drop evidence")
            if reply.get("id") == self._id:
                if "error" in reply:
                    raise RuntimeError(f"{method}: {reply['error']}")
                return reply.get("result", {})
        raise TimeoutError(method)

    def close(self) -> None:
        try:
            self.sock.close()
        except OSError:
            pass


def browser_ws(port: int) -> str:
    with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/version", timeout=10) as r:
        return json.loads(r.read())["webSocketDebuggerUrl"]
