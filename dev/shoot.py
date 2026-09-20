#!/usr/bin/env python3
"""Screenshot the popup (and any harness page) headlessly, for design review.

The embedded browser pane in this project's tooling cannot capture a local
extension page, which meant every visual decision in earlier releases was made
from DOM assertions and computed styles alone. CDP's Page.captureScreenshot has
no such limitation, so a redesign can finally be LOOKED at.

Run:  python dev/shoot.py                       # the popup, every theme
      python dev/shoot.py --page dev/uicheck.html
      python dev/shoot.py --out .audit/shots
"""
from __future__ import annotations

import argparse
import base64
import functools
import http.server
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE / "e2e"))
import cdp  # noqa: E402

sys.path.insert(0, str(HERE))
from run_harness import find_chrome, free_port  # noqa: E402


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def handle_one_request(self):
        try:
            super().handle_one_request()
        except ConnectionResetError:
            self.close_connection = True


def shoot(ws, url, out: Path, width: int, height: int, settle: float, script: str = "") -> None:
    target = ws.call("Target.createTarget", {"url": "about:blank"})["targetId"]
    session = ws.call("Target.attachToTarget", {"targetId": target, "flatten": True})["sessionId"]
    ws.call("Emulation.setDeviceMetricsOverride",
            {"width": width, "height": height, "deviceScaleFactor": 2, "mobile": False},
            session=session)
    ws.call("Page.enable", {}, session=session)
    ws.call("Page.navigate", {"url": url}, session=session)
    time.sleep(settle)
    if script:
        ws.call("Runtime.evaluate", {"expression": script, "awaitPromise": True}, session=session)
        time.sleep(0.5)
    # The preview harness centres the popup on a wide neutral backdrop; the
    # capture must be the popup itself, so the viewport IS the popup width and
    # nothing is captured beyond it.
    shot = ws.call("Page.captureScreenshot", {"format": "png"}, session=session)
    out.write_bytes(base64.b64decode(shot["data"]))
    print(f"  {out.name}  ({out.stat().st_size // 1024} KB)")
    ws.call("Target.closeTarget", {"targetId": target})


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--page", default="dev/popup-preview.html")
    ap.add_argument("--out", default=None)
    ap.add_argument("--width", type=int, default=400)
    ap.add_argument("--height", type=int, default=640)
    ap.add_argument("--settle", type=float, default=2.0)
    ap.add_argument("--themes", default="graphite,daylight,paper,midnight")
    args = ap.parse_args()

    out_dir = Path(args.out) if args.out else (ROOT / "dev" / "_shots")
    out_dir.mkdir(parents=True, exist_ok=True)

    chrome = find_chrome()
    if not chrome:
        print("Chrome not found")
        return 2

    port = free_port()
    handler = functools.partial(QuietHandler, directory=str(ROOT))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()

    profile = Path(tempfile.mkdtemp(prefix="gxt-shot-"))
    debug_port = free_port()
    proc = subprocess.Popen(
        [str(chrome), f"--user-data-dir={profile}", f"--remote-debugging-port={debug_port}",
         "--headless=new", "--no-first-run", "--no-default-browser-check",
         "--disable-background-networking", "--force-device-scale-factor=2",
         "--hide-scrollbars", "about:blank"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    ws = None
    deadline = time.time() + 30
    while time.time() < deadline and ws is None:
        try:
            ws = cdp.WS(cdp.browser_ws(debug_port))
        except Exception:  # noqa: BLE001
            time.sleep(0.4)
    if ws is None:
        print("no DevTools endpoint")
        proc.terminate()
        return 1

    base = f"http://127.0.0.1:{port}/{args.page}"
    try:
        if "popup-preview" in args.page:
            for theme in args.themes.split(","):
                shoot(ws, f"{base}?t={int(time.time()*1000)}", out_dir / f"popup-{theme}.png",
                      args.width, args.height, args.settle,
                      script=f"GXT.theme.apply(document.documentElement, "
                             f"{{uiTheme:'{theme}',uiAccent:'sky',uiDensity:'comfortable'}})")
            # The two states that are not the default: a destination, and the
            # appearance sheet.
            shoot(ws, f"{base}?t={int(time.time()*1000)}", out_dir / "popup-section.png",
                  args.width, args.height, args.settle,
                  script="document.querySelector('.nav-row[data-goto=\"youtube\"]').click()")
            shoot(ws, f"{base}?t={int(time.time()*1000)}", out_dir / "popup-sheet.png",
                  args.width, args.height, args.settle,
                  script="document.getElementById('appearanceBtn').click()")
            shoot(ws, f"{base}?t={int(time.time()*1000)}", out_dir / "popup-search.png",
                  args.width, args.height, args.settle,
                  script="const s=document.getElementById('search');s.value='دوزبانه';"
                         "s.dispatchEvent(new Event('input',{bubbles:true}))")
            shoot(ws, f"{base}?t={int(time.time()*1000)}", out_dir / "popup-large.png",
                  440, args.height, args.settle,
                  script="GXT.theme.apply(document.documentElement,{uiTheme:'graphite',uiDensity:'large'})")
        else:
            shoot(ws, base, out_dir / (Path(args.page).stem + ".png"),
                  args.width, args.height, args.settle)
    finally:
        ws.close()
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
        server.shutdown()
        shutil.rmtree(profile, ignore_errors=True)
    print(f"saved to {out_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
