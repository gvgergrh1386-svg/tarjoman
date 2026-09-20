#!/usr/bin/env python3
"""End-to-end verification in a REAL Chrome, with the extension really loaded.

WHY THIS EXISTS
───────────────
dev/selftest.html and the mock pages are excellent at what they cover, and
there are two things they structurally cannot reach:

  1. THE ISOLATED WORLD. A harness page runs the content scripts in the page's
     own world. Every question of the form "does this work from a content
     script?" is therefore unanswerable there — and one such question was a
     real shipped bug: `history.pushState` was monkey-patched from a content
     script, which never fires, so SPA route detection was dead for years.

  2. THE MV3 SERVICE WORKER. It is loaded with importScripts and cannot be
     pulled into a test page, so `errorDetail` — the single function that keeps
     API keys out of a web page's renderer process — had no runtime coverage.

This closes both, by loading the extension into a throwaway Chrome profile and
measuring. The user's own Chrome profile and any running session are untouched.

NOTE ON LOADING: branded Google Chrome (137+) refuses `--load-extension`
("not allowed in Google Chrome, ignoring"). The supported path is the DevTools
command `Extensions.loadUnpacked`, which is why this speaks CDP.

Run:  python dev/e2e/run_e2e.py
"""
from __future__ import annotations

import json
import base64
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import cdp  # noqa: E402

HERE = Path(__file__).resolve().parent
EXT = HERE.parent.parent                 # the extension root
PROBE = HERE / "probe-ext"

# Construct synthetic key-shaped values for redaction tests. No live key.
FAKE_KEY = "AIza" + "SyD-1234567890abcdefghijklmnopqrstuv"
FAKE_KEY_2 = "AIza" + "SyD-zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz999"

results: list[tuple[str, bool, str]] = []


def check(label: str, ok: bool, detail: str = "") -> None:
    results.append((label, bool(ok), detail))


def find_chrome() -> Path | None:
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


# ------------------------------------------------------- report collector

PAGE = """<!doctype html>
<meta charset="utf-8"><title>SPA route test</title><h1>route A</h1>
<script>
// The PAGE navigates, in the page's own world — exactly as a React or Next
// router would. The content script only observes.
window.addEventListener('message', (e) => {
  if (e.source !== window || e.data?.gxtProbe !== 'pushState') return;
  history.pushState({ n: 1 }, '', e.data.to);
  document.querySelector('h1').textContent = 'route ' + e.data.to;
});
</script>
"""

received: list[dict] = []
got = threading.Event()


class Collector(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def handle_one_request(self):
        try:
            super().handle_one_request()
        except ConnectionResetError:
            self.close_connection = True

    def _send(self, code, body: bytes, mime: str):
        self.send_response(code)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self._send(200, PAGE.encode("utf-8"), "text/html; charset=utf-8")

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        try:
            received.append(json.loads(self.rfile.read(n) or b"{}"))
        except json.JSONDecodeError:
            received.append({})
        self._send(200, b'{"ok":true}', "application/json")
        got.set()


# --------------------------------------------- what runs in the SW

WORKER_PROBE = r"""
(() => {
  const out = { present: {} };
  out.present.errorDetail = typeof errorDetail;
  out.present.maskKey = typeof GXTBG?.maskKey;
  out.present.scrubSecrets = typeof GXTBG?.scrubSecrets;
  out.manifestVersion = chrome.runtime.getManifest().version;
  const err = new Error('API key not valid: __K1__');
  err.code = 'BAD_KEY'; err.http = 400; err.apiStatus = 'INVALID_ARGUMENT';
  err.raw = 'API key not valid. Received: __K1__';
  err.attempts = [
    { key: '__K1__', code: 'BAD_KEY', http: 400, apiStatus: 'INVALID_ARGUMENT',
      raw: 'API key not valid. Received: __K1__' },
    { key: '__K2__', code: 'COOLING', coolUntil: Date.now() + 5000 },
  ];
  const detail = errorDetail(err, { provider: 'gemini', model: 'gemini-3.6-flash' });
  const blob = JSON.stringify(detail);
  out.detail = detail;
  out.leaks = blob.includes('__K1__') || blob.includes('__K2__');
  out.identifiable = blob.includes('AIzaSy');
  out.distinguishable = detail.attempts[0].key !== detail.attempts[1].key;
  out.intact = blob.includes('BAD_KEY') && blob.includes('400')
            && blob.includes('INVALID_ARGUMENT');
  return JSON.stringify(out);
})()
""".replace("__K1__", FAKE_KEY).replace("__K2__", FAKE_KEY_2)


def probe_real_senders(ws, ext_id):
    """Use Chrome-created sender identities, with an intercepted X document.

    No X account or API key is involved. Chrome still injects the real manifest
    content scripts, so this verifies the isolation boundary the mock cannot.
    """
    targets = []
    try:
        target = ws.call("Target.createTarget", {"url": "about:blank"})["targetId"]
        targets.append(target)
        session = ws.call("Target.attachToTarget", {"targetId": target, "flatten": True})["sessionId"]
        ws.call("Runtime.enable", {}, session=session)
        ws.call("Page.enable", {}, session=session)
        ws.call("Fetch.enable", {"patterns": [{"urlPattern": "https://x.com/*", "resourceType": "Document"}]}, session=session)
        ws._id += 1
        ws.send(json.dumps({"id": ws._id, "method": "Page.navigate",
                            "params": {"url": "https://x.com/audit-fixture"}, "sessionId": session}))
        deadline = time.time() + 15
        fulfilled = False
        while time.time() < deadline and not fulfilled:
            event = json.loads(ws.recv())
            if "method" in event:
                ws.events.append(event)
            if event.get("sessionId") == session and event.get("method") == "Fetch.requestPaused":
                html = '<!doctype html><meta charset="utf-8"><title>Audit fixture</title><link rel="icon" href="data:,"><body><p>Local fixture</p>'
                ws.call("Fetch.fulfillRequest", {
                    "requestId": event["params"]["requestId"], "responseCode": 200,
                    "responseHeaders": [{"name": "Content-Type", "value": "text/html; charset=utf-8"}],
                    "body": base64.b64encode(html.encode()).decode(),
                }, session=session)
                fulfilled = True
        if not fulfilled:
            raise RuntimeError("X fixture navigation was not intercepted")
        ws.call("Fetch.disable", {}, session=session)
        ws.call("Runtime.evaluate", {
            "expression": "new Promise(r=>setTimeout(r,900))", "awaitPromise": True,
        }, session=session)
        contexts = [e["params"]["context"] for e in ws.events
                    if e.get("sessionId") == session and e.get("method") == "Runtime.executionContextCreated"]
        own_context = None
        for context in contexts:
            if context.get("auxData", {}).get("isDefault"):
                continue
            response = ws.call("Runtime.evaluate", {
                "expression": "globalThis.chrome?.runtime?.id || ''", "contextId": context["id"],
                "returnByValue": True,
            }, session=session)
            if response.get("result", {}).get("value") == ext_id:
                own_context = context["id"]
                break
        check("the real X content script runs in its extension isolated world", own_context is not None)
        if own_context is None:
            raise RuntimeError("No extension isolated context found")
        expression = """(async()=>{
          const stats=await chrome.runtime.sendMessage({type:'GET_STATS'});
          const backup=await chrome.runtime.sendMessage({type:'EXPORT_BACKUP',includeKeys:false});
          const translate=await chrome.runtime.sendMessage({type:'TRANSLATE_TEXTS',texts:[],kind:'page'});
          return {statsDenied:stats?.code==='FORBIDDEN',backupDenied:backup?.code==='FORBIDDEN',
            translationAllowed:typeof translate?.ok==='boolean'&&translate.code!=='FORBIDDEN'};
        })()"""
        result = ws.call("Runtime.evaluate", {"expression": expression, "contextId": own_context,
                         "awaitPromise": True, "returnByValue": True}, session=session)
        content = result.get("result", {}).get("value", {})
        check("SECURITY: actual content sender cannot export credentials or read privileged stats",
              content.get("statsDenied") and content.get("backupDenied"), str(content))
        check("ordinary translation messaging remains available to actual content scripts",
              content.get("translationAllowed"))

        target = ws.call("Target.createTarget", {"url": f"chrome-extension://{ext_id}/pages/subtitles.html"})["targetId"]
        targets.append(target)
        page_session = ws.call("Target.attachToTarget", {"targetId": target, "flatten": True})["sessionId"]
        deadline = time.time() + 8
        while time.time() < deadline:
            ready = ws.call("Runtime.evaluate", {"expression": "globalThis.chrome?.runtime?.id || ''",
                                                "returnByValue": True}, session=page_session)
            if ready.get("result", {}).get("value") == ext_id:
                break
            time.sleep(0.1)
        result = ws.call("Runtime.evaluate", {"expression": """(async()=>{
          const stats=await chrome.runtime.sendMessage({type:'GET_STATS'});
          const backup=await chrome.runtime.sendMessage({type:'EXPORT_BACKUP',includeKeys:false});
          return {statsAllowed:stats?.ok===true,backupAllowed:backup?.ok===true};
        })()""", "awaitPromise": True, "returnByValue": True}, session=page_session)
        page = result.get("result", {}).get("value", {})
        check("extension pages retain access to backup and statistics", page.get("statsAllowed") and page.get("backupAllowed"), str(page or result.get('exceptionDetails', {})))

        # Both contexts submit concurrently to the same MV3 worker. Independent
        # read/modify/write cycles used to lose one of these unrelated choices.
        ws._id += 1
        content_id = ws._id
        ws.send(json.dumps({"id":content_id,"method":"Runtime.evaluate","sessionId":session,"params":{
            "contextId":own_context,"awaitPromise":True,"returnByValue":True,
            "expression":"GXT.setSettings({ytAuto:true}).then(()=>true)"}}))
        ws._id += 1
        popup_id = ws._id
        ws.send(json.dumps({"id":popup_id,"method":"Runtime.evaluate","sessionId":page_session,"params":{
            "awaitPromise":True,"returnByValue":True,
            "expression":"GXT.setSettings({pageBilingual:true}).then(()=>true)"}}))
        waiting = {content_id,popup_id}
        deadline = time.time() + 10
        while waiting and time.time() < deadline:
            reply = json.loads(ws.recv())
            if reply.get('id') in waiting:
                waiting.remove(reply['id'])
                if reply.get('error') or reply.get('result',{}).get('exceptionDetails'):
                    raise RuntimeError('A real settings mutation failed')
        result = ws.call('Runtime.evaluate', {'expression':
            "GXT.getSettings().then(s=>({ytAuto:s.ytAuto,pageBilingual:s.pageBilingual}))",
            'awaitPromise':True,'returnByValue':True}, session=page_session)
        settings = result.get('result',{}).get('value',{})
        check('concurrent settings changes from content and extension page both survive',
              not waiting and settings.get('ytAuto') is True and settings.get('pageBilingual') is True, str(settings))
    except Exception as exc:
        check("real sender isolation probe completes", False, str(exc))
    finally:
        for target in targets:
            try:
                ws.call("Target.closeTarget", {"targetId": target})
            except Exception:
                pass


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, OSError):
            pass

    chrome = find_chrome()
    if not chrome:
        print("Chrome not found — set it in find_chrome() or install Chrome.")
        return 2
    print(f"chrome     : {chrome}")
    print(f"extension  : {EXT}")

    port = free_port()
    server = ThreadingHTTPServer(("127.0.0.1", port), Collector)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()

    profile = Path(tempfile.mkdtemp(prefix="gxt-e2e-"))
    debug_port = free_port()
    proc = subprocess.Popen(
        [str(chrome), f"--user-data-dir={profile}",
         "--enable-unsafe-extension-debugging", f"--remote-debugging-port={debug_port}",
         "--headless=new", "--no-first-run", "--no-default-browser-check",
         "--disable-background-networking", "--disable-sync", "about:blank"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        encoding="utf-8", errors="replace")

    ws = None
    deadline = time.time() + 30
    while time.time() < deadline and ws is None:
        try:
            ws = cdp.WS(cdp.browser_ws(debug_port))
        except Exception:
            time.sleep(0.4)
    if ws is None:
        print("no DevTools endpoint")
        proc.terminate()
        return 1

    ext_id = None
    try:
        ws.call("Extensions.loadUnpacked", {"path": str(PROBE)})
        ext_id = ws.call("Extensions.loadUnpacked", {"path": str(EXT)}).get("id")
    except Exception as exc:
        print("loadUnpacked failed:", exc)
    check("the extension loads unpacked into a real Chrome", bool(ext_id), str(ext_id))
    print(f"extension id: {ext_id}")

    # ---------------------------------------------- phase 1: isolated world
    try:
        ws.call("Target.createTarget", {"url": f"http://127.0.0.1:{port}/route-a?extension={ext_id}"})
    except Exception as exc:
        print("createTarget failed:", exc)
    got.wait(timeout=45)
    r = received[0] if received else {}

    check("Navigation API is exposed to a content script's isolated world",
          r.get("navigationExists") == "object" and r.get("navigationHasAddEventListener"),
          f"typeof navigation = {r.get('navigationExists')}")
    check("navigatesuccess observes a PAGE-initiated pushState",
          r.get("navigateSuccessFired"),
          f"{r.get('msToNavigateSuccess')} ms, href={r.get('hrefAtNavigateSuccess')}")
    check("REGRESSION: an isolated-world history.pushState patch NEVER fires",
          r.get("patchInstalled") and not r.get("historyPatchFired"),
          f"installed={r.get('patchInstalled')} fired={r.get('historyPatchFired')}")
    check("popstate does NOT fire for pushState (so it was no fallback either)",
          not r.get("popstateFired"), str(r.get("popstateFired")))
    check("the 1-second href poll observes the change (the safety net)",
          r.get("pollObserved"), f"{r.get('msToPoll')} ms")
    ext = r.get("realExtension") or {}
    check("web_accessible_resources serves the bundled font to a real page",
          ext.get("ok") and ext.get("woff2"), f"{ext.get('bytes')} bytes, id={ext.get('id')}")
    check("no uncaught errors on the page during the run",
          not r.get("errors"), str(r.get("errors")))

    # ------------------------------------------- phase 2: service worker
    sw = None
    deadline = time.time() + 25
    while time.time() < deadline and sw is None:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{debug_port}/json/list",
                                        timeout=10) as resp:
                for t in json.loads(resp.read()):
                    if t.get("type") in ("service_worker", "worker") and \
                            str(ext_id) in t.get("url", ""):
                        sw = t
                        break
        except Exception:
            pass
        if sw is None:
            time.sleep(0.5)

    worker = {}
    if sw:
        session = ws.call("Target.attachToTarget",
                          {"targetId": sw["id"], "flatten": True})["sessionId"]
        res = ws.call("Runtime.evaluate",
                      {"expression": WORKER_PROBE, "returnByValue": True}, session=session)
        if not res.get("exceptionDetails"):
            worker = json.loads(res["result"]["value"])

    check("the MV3 service worker starts and is reachable", bool(worker), str(bool(sw)))
    check("the running worker reports the shipped manifest version",
          worker.get("manifestVersion") == json.loads(
              (EXT / "manifest.json").read_text(encoding="utf-8"))["version"],
          str(worker.get("manifestVersion")))
    check("SECURITY: errorDetail leaks no API key to a content script",
          worker and not worker.get("leaks"),
          json.dumps(worker.get("detail", {}), ensure_ascii=False)[:160])
    check("SECURITY: keys stay identifiable and distinguishable",
          worker.get("identifiable") and worker.get("distinguishable"), "")
    check("SECURITY: the diagnostics themselves survive masking",
          worker.get("intact"), "")

    if ext_id:
        probe_real_senders(ws, ext_id)

    proc.terminate()
    try:
        proc.communicate(timeout=8)
    except subprocess.TimeoutExpired:
        proc.kill()
    server.shutdown()
    shutil.rmtree(profile, ignore_errors=True)

    print()
    if worker.get("detail"):
        print("errorDetail() as the running worker produced it:")
        print(json.dumps(worker["detail"], indent=2, ensure_ascii=False))
        print()
    passed = 0
    for label, ok, detail in results:
        print(f"{'PASS' if ok else 'FAIL'} {label}" + (f" — {detail}" if detail else ""))
        passed += ok
    print(f"\nCHROME-E2E SUMMARY {passed}/{len(results)}")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
