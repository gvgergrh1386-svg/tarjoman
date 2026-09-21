#!/usr/bin/env python3
"""Run every browser harness page headlessly and report one combined result.

WHY THIS EXISTS
───────────────
The suites in dev/*.html are the real regression net for this extension, and
until now each one had to be opened by hand in a browser pane that cannot take
screenshots, cannot read files, and caches aggressively. That made "are all the
suites still green?" a ten-minute manual chore — so it was skipped, which is
exactly when a regression ships.

This drives all of them in one command: a throwaway headless Chrome, one target
per page, console output collected over CDP, and a single non-zero exit code if
anything failed. It reuses dev/e2e/cdp.py (the stdlib WebSocket/CDP client
written for the extension-loading test) rather than adding a dependency.

Every harness prints machine-readable lines already:

    GXT-SELFTEST PASS <name>            (dev/selftest.html)
    GXT-MOCK PASS <name>                (the mock-* pages)
    GXT-POPUP PASS mounted              (dev/popup-preview.html)
    GXT-UI PASS <name>                  (dev/uicheck.html)
    GXT-FC PASS <name>                  (dev/fccheck.html, v2.9.5)

and end with a `… SUMMARY n/m` line, which is what this waits for.

Run:  python dev/run_harness.py
      python dev/run_harness.py uicheck selftest      (subset, by page stem)
"""
from __future__ import annotations

import contextlib
import functools
import http.server
import json
import os
import re
import shutil
import socket
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

# Order matters only for readability of the report.
PAGES = [
    "background-browser.html",
    "selftest.html",
    "uicheck.html",
    "fccheck.html",
    # v3.0.0 — the quality evaluator's own scorers. The evaluator needs an API
    # key to measure a model, but its SCORING is pure and must be trustworthy
    # before any number it prints means anything, so that half runs here.
    "eval/eval.html?selftest=1",
    "popup-preview.html",
    "mock-popup-lifecycle.html",
    "mock-x.html",
    "mock-x-lifecycle.html",
    "mock-page.html",
    "mock-page-lifecycle.html",
    "mock-yt.html",
    "mock-yt-captions.html",
    "mock-yt-autotranslate.html",
    "mock-yt-settings-lifecycle.html",
    "mock-yt-instant.html",
    "mock-yt-native-response.html",
    "mock-web-video.html",
    "mock-web-video-followup.html",
    "mock-web-video-visual.html",
    "mock-workshop.html",
    "mock-theme-live.html",
    "mock-yt-nocaptions.html",
    # v3.3.0 - content/yt-main.js, the MAIN-world track discovery, which every
    # other YouTube mock bypasses by hand-feeding messages to the receiver.
    "mock-yt-main.html",
    # v3.2.1 - the UI must survive its optional modules being absent, which
    # is what a browser still running the PREVIOUS content-script list sees.
    "mock-yt-nodeps.html?drop=ui",
    "mock-yt-nodeps.html?drop=css",
    "mock-yt-nodeps.html?drop=theme",
    "mock-subs.html",
    "mock-dub.html",
    "mock-dub-audio.html",
    "mock-stability-376.html",
    "mock-manga.html",
    "mock-media-lifecycle.html",
    "mock-vsr.html",
]

SUMMARY_RE = re.compile(r"^GXT-([A-Z-]+) SUMMARY (\d+)/(\d+)$")
LINE_RE = re.compile(r"^GXT-[A-Z-]+ (PASS|FAIL) (.*)$", re.DOTALL)

# Media features a page needs emulated before it loads (v2.9.5).
#
# `forced-colors` is the one condition in this product that CANNOT be reached
# from inside a page: no CSS or script turns it on, and it changes how every
# author colour is painted. It has to come from the browser, so the harness
# sets it per target — which keeps "one command runs every suite" true instead
# of leaving the High Contrast checks to a second tool nobody remembers to run.
EMULATE = {
    "fccheck.html": [{"name": "forced-colors", "value": "active"}],
}


# Modules whose whole stylesheet is ONE template literal (v3.2.5).
#
# WHY THIS PRE-FLIGHT EXISTS
# ──────────────────────────
# A backtick anywhere inside such a literal — including inside a CSS comment —
# ends the string and turns the module into a SyntaxError. The failure mode is as
# bad as it gets: the module simply never defines anything, so `GXT.ui` or
# `GXT.playerCss` is undefined, every in-page surface in the product silently
# ceases to exist, and nothing is logged anywhere.
#
# The suites do catch it, and it has still happened FOUR times in this codebase,
# because writing prose about CSS is exactly when a hand reaches for a backtick.
# Catching it in the browser costs a ninety-second run and a confusing wall of
# "cannot read properties of undefined"; catching it here costs a millisecond and
# names the line. Both nets stay.
LITERAL_SHEETS = {
    "content/ui.js": "const STYLE = `",
    "content/player.css.js": "globalThis.GXT.playerCss = `",
}


def check_literal_sheets() -> list[str]:
    """Fail on a stray backtick inside a stylesheet template literal."""
    problems = []
    for rel, opener in LITERAL_SHEETS.items():
        path = ROOT / rel
        try:
            text = path.read_text(encoding="utf-8")
        except OSError:
            problems.append(f"{rel}: missing")
            continue
        at = text.find(opener)
        if at < 0:
            problems.append(f"{rel}: cannot find the sheet literal ({opener!r})")
            continue
        start = at + len(opener)
        end = text.find("`", start)
        if end < 0:
            problems.append(f"{rel}: the sheet literal is never closed")
            continue
        # The literal should end at the module's closing backtick. If any content
        # after it still looks like CSS, the string ended early.
        tail = text[end + 1:end + 400]
        if "{" in tail and (":" in tail and ";" in tail):
            line = text.count("\n", 0, end) + 1
            problems.append(
                f"{rel}:{line}: a backtick ends the stylesheet literal early "
                "(use 'single quotes' in CSS prose)"
            )
    return problems


def find_chrome() -> Path | None:
    if os.environ.get('CHROME'):
        configured = Path(os.environ['CHROME'])
        if not configured.is_file():
            raise FileNotFoundError('CHROME does not point to an executable file')
        return configured
    candidates = [
        Path(os.environ.get("LOCALAPPDATA", "")) / "Google/Chrome/Application/chrome.exe",
        Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe"),
        Path(r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"),
        Path("/usr/bin/google-chrome"),
        Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
    ]
    for c in candidates:
        if c and c.exists():
            return c
    which = shutil.which("chrome") or shutil.which("google-chrome") or shutil.which("chromium")
    return Path(which) if which else None


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *_args):  # noqa: D102 - the server must stay silent
        pass

    def handle_one_request(self):
        # Closing a target mid-request is normal here and is not a failure;
        # without this the run ends with a stack trace that looks like one.
        try:
            super().handle_one_request()
        except ConnectionResetError:
            self.close_connection = True


def collect(
    ws: cdp.WS, url: str, budget: float, emulate: list[dict] | None = None
) -> tuple[list[str], str | None]:
    """Open `url` in a fresh target, return its GXT-* console lines.

    Ends as soon as a SUMMARY line arrives, or when the budget expires — a
    harness that hangs must not hang the whole run.

    `emulate` is a CDP media-feature list applied BEFORE navigation, so the
    page's first layout already sees it (see EMULATE).
    """
    target = ws.call("Target.createTarget", {"url": "about:blank"})["targetId"]
    session = ws.call("Target.attachToTarget", {"targetId": target, "flatten": True})["sessionId"]
    ws.call("Runtime.enable", {}, session=session)
    ws.call("Page.enable", {}, session=session)
    language = os.environ.get("TARJOMAN_TEST_LANGUAGE", "fa-IR")
    ws.call("Page.addScriptToEvaluateOnNewDocument", {"source":
        "Object.defineProperty(navigator,'languages',{get:()=>["+json.dumps(language)+"]});"
        + "Object.defineProperty(navigator,'language',{get:()=>"+json.dumps(language)+"});"}, session=session)
    if emulate:
        ws.call("Emulation.setEmulatedMedia", {"features": emulate}, session=session)
    ws.call("Page.navigate", {"url": url}, session=session)

    lines: list[str] = []
    summary: str | None = None
    deadline = time.monotonic() + budget
    # call() may receive exceptions and console events before the navigation
    # response. Those events are already buffered and are part of this run.
    pending, ws.events = ws.events, []
    ws.sock.settimeout(1.0)
    while pending or time.monotonic() < deadline:
        try:
            msg = pending.pop(0) if pending else json.loads(ws.recv())
        except TimeoutError:
            continue
        except OSError as exc:
            lines.append(f"GXT-RUNTIME FAIL connection lost: {exc}")
            break
        except ValueError:
            lines.append("GXT-RUNTIME FAIL malformed CDP event")
            continue
        if msg.get("sessionId") != session:
            continue
        method = msg.get("method")

        # UNCAUGHT EXCEPTIONS ARE FAILURES — v3.2.5.
        #
        # This loop used to read `Runtime.consoleAPICalled` and nothing else, so
        # a page that threw was invisible: the runner only noticed if the throw
        # also happened to stop the SUMMARY line from printing. Measured while
        # rewriting the in-player test seam — two assertions silently STOPPED
        # EXISTING because the helper they called had been renamed, and the run
        # reported 55/55 OK. A suite that can lose checks without saying so is
        # not a regression net. Anything thrown now becomes a FAIL line, which
        # both prints and sets the exit code.
        if method == "Runtime.exceptionThrown":
            details = msg["params"].get("exceptionDetails", {})
            text = (
                details.get("exception", {}).get("description")
                or details.get("text")
                or "uncaught exception"
            )
            # The top frame, because "a TypeError happened somewhere" is not
            # something anyone can act on. The stack is usually on the exception
            # description already, but not for a rejected promise.
            frames = (details.get("stackTrace") or {}).get("callFrames") or []
            where = ""
            for frame in frames:
                url = (frame.get("url") or "").rsplit("/", 1)[-1]
                if url:
                    where = f"  @ {url}:{frame.get('lineNumber', 0) + 1}"
                    break
            lines.append(f"GXT-RUNTIME FAIL uncaught: {text.splitlines()[0]}{where}")
            continue

        if method != "Runtime.consoleAPICalled":
            continue
        # console.error/warning is how a page reports a problem it survived.
        if msg["params"].get("type") == "error":
            for arg in msg["params"].get("args", []):
                text = arg.get("value") or arg.get("description")
                if isinstance(text, str) and not text.startswith("GXT-"):
                    lines.append(f"GXT-RUNTIME FAIL console.error: {text.splitlines()[0]}")
        for arg in msg["params"].get("args", []):
            text = arg.get("value")
            if not isinstance(text, str) or not text.startswith("GXT-"):
                continue
            lines.append(text)
            if SUMMARY_RE.match(text):
                if summary is not None:
                    lines.append("GXT-RUNTIME FAIL duplicate completion SUMMARY")
                else:
                    summary = text
                    # Catch immediate rejected promises/uncaught errors after
                    # the final assertion, before destroying the target.
                    deadline = min(deadline, time.monotonic() + 0.15)
                    ws.sock.settimeout(0.15)
    ws.sock.settimeout(30.0)
    try:
        ws.call("Target.closeTarget", {"targetId": target})
    except Exception:  # noqa: BLE001 - the target may already be gone
        pass
    return lines, summary


# How many checks each page is EXPECTED to run (v3.2.5).
#
# WHY A BASELINE FILE EXISTS
# ──────────────────────────
# A green run means "every check that ran, passed". It says nothing about
# whether the checks that were supposed to run did. Measured for real while
# rewriting the in-player test seam: two assertions called a helper that had
# just been renamed, the exception aborted the block that contained them, and
# the page reported 55/55 OK — two fewer than the day before, and nothing said
# so. Under-counting is the failure mode a pass/fail tally cannot see.
#
# So the count itself is an assertion. A DROP is a failure; a rise is expected
# whenever checks are added, and the runner prints the new numbers to paste in.
BASELINE = HERE / "harness-baseline.json"


def evaluate_results(lines: list[str], summary: str | None) -> dict:
    """Validate completion against actual observations, shared by all runners.

    Returns passed, total (including runtime errors), checks (suite assertions
    only), and problems. A result passes only when problems is empty.
    """
    checks = [LINE_RE.match(line) for line in lines
              if LINE_RE.match(line) and not line.startswith("GXT-RUNTIME ")]
    passed = sum(match.group(1) == "PASS" for match in checks)
    failed = [line for line in lines
              if LINE_RE.match(line) and LINE_RE.match(line).group(1) == "FAIL"]
    runtime = sum(line.startswith("GXT-RUNTIME ") for line in failed)
    problems = list(failed)
    match = SUMMARY_RE.fullmatch(summary) if summary else None
    if not match:
        problems.append("missing or malformed completion SUMMARY")
    elif (int(match.group(2)), int(match.group(3))) != (passed, len(checks)):
        problems.append(f"SUMMARY {match.group(2)}/{match.group(3)} disagrees with "
                        f"observed checks {passed}/{len(checks)}")
    if not checks:
        problems.append("no test checks ran")
    return {"passed": passed, "total": len(checks) + runtime,
            "checks": len(checks), "problems": problems}


def check_counts(counts: dict[str, int], only: bool) -> list[str]:
    """Fail on any page that ran FEWER checks than its recorded baseline."""
    try:
        expected = json.loads(BASELINE.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        return [f"cannot read harness baseline: {exc}"]
    if (not isinstance(expected, dict) or not expected
            or any(not isinstance(page, str) or type(count) is not int or count < 1
                   for page, count in expected.items())):
        return ["invalid harness baseline: expected page names and positive integer counts"]
    problems: list[str] = []
    grown: dict[str, int] = {}
    for page, ran in counts.items():
        want = expected.get(page)
        if want is None:
            grown[page] = ran
        elif ran < want:
            line = f"{page}: only {ran} checks ran, {want} expected — did some stop existing?"
            print(f"LOST {line}")
            problems.append(line)
        elif ran > want:
            grown[page] = ran
    if not only:
        problems.extend(f"{page}: recorded suite did not run" for page in expected if page not in counts)
    if grown:
        # Running tests never rewrites its own acceptance criteria. In
        # particular, growth in one suite must not hide a drop in another.
        for page, ran in sorted(grown.items()):
            print(f"NEW  {page:<30} observed {ran} (review baseline update)")
    return problems


@contextlib.contextmanager
def serve():
    """A static server, a throwaway headless Chrome and a CDP socket.

    Extracted in v3.2.5 so dev/dump_harness.py can drive one page verbosely
    through exactly the same plumbing this runner uses — a diagnostic tool that
    sets the browser up differently is a diagnostic tool that lies.

    Yields `(port, ws, proc)`; everything is torn down on exit.
    """
    chrome = find_chrome()
    if not chrome:
        raise RuntimeError("Chrome not found — install it or extend find_chrome().")

    port = free_port()
    handler = functools.partial(QuietHandler, directory=str(ROOT))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()

    profile = Path(tempfile.mkdtemp(prefix="gxt-harness-"))
    debug_port = free_port()
    proc = subprocess.Popen(
        [str(chrome), f"--user-data-dir={profile}",
         f"--remote-debugging-port={debug_port}",
         "--headless=new", "--no-first-run", "--no-default-browser-check",
         "--disable-background-networking", "--disable-sync",
         "--autoplay-policy=no-user-gesture-required", "about:blank"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    ws = None
    deadline = time.time() + 30
    while time.time() < deadline and ws is None:
        try:
            ws = cdp.WS(cdp.browser_ws(debug_port))
        except Exception:  # noqa: BLE001 - Chrome is still starting
            time.sleep(0.4)
    if ws is None:
        proc.terminate()
        server.shutdown()
        shutil.rmtree(profile, ignore_errors=True)
        raise RuntimeError("no DevTools endpoint")

    try:
        yield port, ws, proc
    finally:
        ws.close()
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
        server.shutdown()
        shutil.rmtree(profile, ignore_errors=True)


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, OSError):
            pass

    wanted = [a.lower() for a in sys.argv[1:]]
    pages = [p for p in PAGES if not wanted or any(w in p.lower() for w in wanted)]
    missing = [p for p in pages if not (HERE / p.split("?")[0]).exists()]
    if missing:
        print("missing harness pages: " + ", ".join(missing))
        return 2
    if not pages:
        print("no harness pages matched")
        return 2

    # Cheap static checks first: no point starting a browser to be told that a
    # module could not parse.
    broken = check_literal_sheets()
    for problem in broken:
        print(f"SYNTAX {problem}")
    if broken:
        print("-" * 46)
        print(f"{len(broken)} problem(s) — fix these before running the suites")
        return 1

    total_pass = total_all = 0
    failures: list[str] = []
    counts: dict[str, int] = {}
    try:
        with serve() as (port, ws, _proc):
            for page in pages:
                join = "&" if "?" in page else "?"
                url = f"http://127.0.0.1:{port}/dev/{page}{join}h={int(time.time()*1000)}"
                lines, summary = collect(ws, url, budget=90.0, emulate=EMULATE.get(page))
                result = evaluate_results(lines, summary)
                good, all_ = result["passed"], result["total"]
                total_pass += good
                total_all += all_
                counts[page] = result["checks"]
                mark = "FAIL" if result["problems"] else "OK  "
                label = page.replace(".html", "").replace("?", " ")
                print(f"{mark} {label:<30} {good}/{all_}", flush=True)
                if result["problems"]:
                    for line in lines:
                        if " detail " in line:
                            print(f"       {line}")
                for problem in result["problems"]:
                    print(f"       {problem}")
                    failures.append(f"{page}: {problem}")

    except (RuntimeError, OSError, TimeoutError, KeyError, ValueError) as exc:
        print(f"runner failed: {exc}")
        return 2

    failures += check_counts(counts, only=bool(wanted))

    print("-" * 46)
    print(f"TOTAL {total_pass}/{total_all}")
    if failures:
        print(f"{len(failures)} problem(s)")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
