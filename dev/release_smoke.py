"""Real extension install/restart/upgrade and file-to-local-provider smoke test.

Uses only temporary Chrome profiles, synthetic data, and a loopback API.
python dev/release_smoke.py --extension PATH --upgrade-from PATH --output PATH
"""
import argparse
import base64
import contextlib
import json
import shutil
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import run_harness as h

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--extension', type=Path, required=True)
parser.add_argument('--upgrade-from', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
args.output.mkdir(parents=True, exist_ok=True)
checks = []
requests = []


def check(name, actual):
    ok = bool(actual)
    checks.append({'name': name, 'ok': ok})
    print(('PASS ' if ok else 'FAIL ') + name, flush=True)


class LocalProvider(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, OPTIONS')
        self.end_headers()

    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get('Content-Length', '0')))
        payload = json.loads(raw)
        requests.append({'path': self.path, 'model': payload.get('model')})
        body = json.dumps({'choices': [{'message': {'content': json.dumps({'t': ['ترجمه آزمایشی فایل']}, ensure_ascii=False)}}]}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def copy_runtime(source, destination):
    destination.mkdir(exist_ok=True)
    for name in ['background', 'content', 'shared', 'pages', 'popup', 'fonts', 'icons']:
        shutil.copytree(source / name, destination / name, dirs_exist_ok=True)
    shutil.copy2(source / 'manifest.json', destination / 'manifest.json')


@contextlib.contextmanager
def browser(profile, extension):
    port = h.free_port()
    proc = subprocess.Popen([str(h.find_chrome()), f'--user-data-dir={profile}',
        f'--remote-debugging-port={port}', '--enable-unsafe-extension-debugging',
        '--headless=new', '--no-first-run', '--no-default-browser-check',
        '--disable-background-networking', '--disable-sync', 'about:blank'],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    ws = None
    try:
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            try:
                ws = h.cdp.WS(h.cdp.browser_ws(port))
                break
            except OSError:
                time.sleep(.15)
        if ws is None:
            raise RuntimeError('Chrome did not start')
        ext_id = ws.call('Extensions.loadUnpacked', {'path': str(extension.resolve())})['id']
        yield ws, ext_id
    finally:
        if ws:
            try:
                ws.call('Browser.close')
            except (OSError, RuntimeError):
                pass
            ws.close()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=5)


def evaluate(ws, session, expression):
    result = ws.call('Runtime.evaluate', {'expression': expression, 'awaitPromise': True, 'returnByValue': True}, session=session)
    if result.get('exceptionDetails'):
        raise RuntimeError(result['exceptionDetails'].get('text', 'JavaScript failed'))
    return result.get('result', {}).get('value')


def page(ws, ext_id, path):
    target = ws.call('Target.createTarget', {'url': 'about:blank'})['targetId']
    session = ws.call('Target.attachToTarget', {'targetId': target, 'flatten': True})['sessionId']
    ws.call('Runtime.enable', session=session)
    ws.call('Page.enable', session=session)
    ws.call('Page.navigate', {'url': f'chrome-extension://{ext_id}/{path}'}, session=session)
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        if evaluate(ws, session, "document.readyState==='complete' && !!globalThis.GXT?.getSettings"):
            return session
        time.sleep(.1)
    details = evaluate(ws, session, "({url:location.href,ready:document.readyState,title:document.title,gxt:typeof globalThis.GXT,text:document.body?.innerText?.slice(0,180)})")
    raise RuntimeError('Extension page did not mount: ' + json.dumps(details))


server = ThreadingHTTPServer(('127.0.0.1', 0), LocalProvider)
server.daemon_threads = True
threading.Thread(target=server.serve_forever, daemon=True).start()
try:
    with tempfile.TemporaryDirectory(prefix='gxt-release-smoke-') as temp:
        temp = Path(temp)
        stage, profile = temp / 'extension', temp / 'profile'
        copy_runtime(args.upgrade_from, stage)
        with browser(profile, stage) as (ws, old_id):
            session = page(ws, old_id, 'pages/subtitles.html')
            seeded = evaluate(ws, session, """(async()=>{
              await GXT.setSettings({uiTheme:'paper',ttsRate:1.35,pageBilingual:true,customPrompt:'upgrade fixture'});
              await GXT.setApiKeys(['TEST_ONLY_UPGRADE_KEY']);
              await chrome.storage.local.set({transMemory:{terms:{nasa:{s:'NASA',t:'ناسا',n:3,pinned:true}},count:1}});
              return (await GXT.getSettings()).pageBilingual;
            })()""")
            check('old version really runs and persists fixture settings', seeded)
        copy_runtime(args.extension, stage)
        expected = json.loads((stage / 'manifest.json').read_text(encoding='utf-8'))['version']
        with browser(profile, stage) as (ws, new_id):
            session = page(ws, new_id, 'pages/subtitles.html')
            state = evaluate(ws, session, """(async()=>{const s=await GXT.getSettings();const m=await GXT.getMemory();return {version:chrome.runtime.getManifest().version,theme:s.uiTheme,rate:s.ttsRate,bilingual:s.pageBilingual,prompt:s.customPrompt,key:(await GXT.getApiKeys())[0],term:m.terms.nasa?.t};})()""")
            check('replacement keeps identity and reports the delivered manifest version', old_id == new_id and state.get('version') == expected)
            check('upgrade preserves settings, credentials and pinned translation memory', state.get('theme') == 'paper' and state.get('rate') == 1.35 and state.get('bilingual') is True and state.get('prompt') == 'upgrade fixture' and state.get('key') == 'TEST_ONLY_UPGRADE_KEY' and state.get('term') == 'ناسا')
            worker_target=next((t for t in ws.call('Target.getTargets')['targetInfos'] if t['type']=='service_worker' and new_id in t['url']),None)
            upgraded_code=False
            if worker_target:
                worker_session=ws.call('Target.attachToTarget',{'targetId':worker_target['targetId'],'flatten':True})['sessionId']
                upgraded_code=evaluate(ws,worker_session,"handleTranslateTexts.toString().includes(\"source !== 'file'\")")
        # The host Chrome blocks Reload of this temporary upgraded extension.
        # Keep the preserved-data check distinct from fresh-runtime execution.
        activation={'status':'verified' if upgraded_code else 'unverified','newWorkerObserved':bool(upgraded_code),'reloadAttemptOnThisRun':False,'earlierHostObservation':'Reload via runtime API and actual extensions UI produced ERR_BLOCKED_BY_CLIENT.'}
        (args.output / 'upgrade-activation.json').write_text(json.dumps(activation), encoding='utf-8')
        print('UPGRADE-ACTIVATION '+activation['status'],flush=True)
        clean_profile = temp / 'clean-profile'
        with browser(clean_profile, stage) as (ws, new_id):
            session = page(ws, new_id, 'pages/subtitles.html')
            worker_target = next((t for t in ws.call('Target.getTargets')['targetInfos'] if t['type']=='service_worker' and new_id in t['url']), None)
            if worker_target:
                worker_session=ws.call('Target.attachToTarget',{'targetId':worker_target['targetId'],'flatten':True})['sessionId']
                code_state=evaluate(ws,worker_session,"({version:chrome.runtime.getManifest().version,fileRouting:handleTranslateTexts.toString().includes(\"source !== 'file'\")})")
                (args.output/'worker-version.json').write_text(json.dumps(code_state),encoding='utf-8')
                check('fresh installed worker executes the delivered file routing',code_state.get('fileRouting') and code_state.get('version')==expected)
            else:
                check('fresh installed worker executes the delivered file routing',False)
            port = server.server_address[1]
            configured = evaluate(ws, session, f"GXT.setSettings({{provider:'openai',openaiBaseUrl:'http://127.0.0.1:{port}/v1',openaiModel:'audit-model',qualityMode:false,customPrompt:'',ytProvider:'google',uiTheme:'paper',pageBilingual:true}}).then(()=>true)")
            check('fresh installed worker accepts provider settings', configured)
            fixture = temp / 'actual-input.srt'
            fixture.write_text('1\n00:00:01,000 --> 00:00:03,000\nHello from the release test.\n', encoding='utf-8')
            doc = ws.call('DOM.getDocument', session=session)['root']['nodeId']
            node = ws.call('DOM.querySelector', {'nodeId': doc, 'selector': '#picker'}, session=session)['nodeId']
            ws.call('DOM.setFileInputFiles', {'nodeId': node, 'files': [str(fixture)]}, session=session)
            result = evaluate(ws, session, """(async()=>{for(let i=0;i<100;i++){if(document.querySelector('#fileName').textContent==='actual-input.srt')return true;await new Promise(r=>setTimeout(r,40));}return false;})()""")
            check('packaged extension reads an actual disk subtitle file', result)
            evaluate(ws, session, """(()=>{globalThis.__releaseMessages=[];const send=chrome.runtime.sendMessage.bind(chrome.runtime);chrome.runtime.sendMessage=(message)=>{const entry={type:message.type,source:message.source};__releaseMessages.push(entry);return send(message).then(response=>{entry.ok=response?.ok;entry.code=response?.code;entry.error=response?.error;return response;});};})()""")
            result = evaluate(ws, session, """(async()=>{document.querySelector('#translateBtn').click();for(let i=0;i<200;i++){if(!document.querySelector('#resultCard').classList.contains('hidden'))return document.querySelector('#resultPreview').textContent.includes('ترجمه آزمایشی فایل');await new Promise(r=>setTimeout(r,50));}return false;})()""")
            check('file UI to MV3 worker to loopback provider to rendered result', result and any(r['path'] == '/v1/chat/completions' for r in requests))
            details = evaluate(ws, session, """({messages:__releaseMessages,error:document.querySelector('#errorNote').textContent,result:document.querySelector('#resultPreview').textContent,progress:document.querySelector('#progressText').textContent})""")
            (args.output / 'file-execution.json').write_text(json.dumps(details, ensure_ascii=False, indent=2), encoding='utf-8')
            image = ws.call('Page.captureScreenshot', {'format': 'png'}, session=session)
            (args.output / 'packaged-subtitles.png').write_bytes(base64.b64decode(image['data']))
            popup = page(ws, new_id, 'popup/popup.html')
            evaluate(ws, popup, "new Promise(r=>setTimeout(r,500))")
            check('packaged popup displays its runtime version', evaluate(ws, popup, "document.querySelector('#versionTag').textContent.includes(chrome.runtime.getManifest().version)"))
            ws.call('HeapProfiler.collectGarbage', session=popup)
            before = ws.call('Memory.getDOMCounters', session=popup)
            evaluate(ws, popup, """(()=>{for(let i=0;i<100;i++){document.querySelector('#appearanceBtn').click();document.querySelector('#sheetClose').click();}return true;})()""")
            ws.call('HeapProfiler.collectGarbage', session=popup)
            after = ws.call('Memory.getDOMCounters', session=popup)
            (args.output / 'popup-resources.json').write_text(json.dumps({'cycles': 100, 'before': before, 'after': after}, indent=2), encoding='utf-8')
            check('100 actual popup dialog cycles leave DOM and listeners bounded', after['documents'] <= before['documents'] and after['nodes'] <= before['nodes'] + 10 and after['jsEventListeners'] <= before['jsEventListeners'] + 10)
            image = ws.call('Page.captureScreenshot', {'format': 'png'}, session=popup)
            (args.output / 'packaged-popup.png').write_bytes(base64.b64decode(image['data']))
        with browser(clean_profile, stage) as (ws, ext_id):
            session = page(ws, ext_id, 'pages/subtitles.html')
            check('second browser restart retains fresh 3.7.0 settings', evaluate(ws, session, "GXT.getSettings().then(s=>s.provider==='openai' && s.uiTheme==='paper' && s.pageBilingual)") and ext_id == new_id)
except Exception as error:
    check('release smoke completed without infrastructure exception', False)
    print(type(error).__name__ + ': ' + str(error), flush=True)
finally:
    server.shutdown()
    server.server_close()
    (args.output / 'results.json').write_text(json.dumps({'checks': checks, 'requests': requests}, indent=2, ensure_ascii=False), encoding='utf-8')
passed = sum(c['ok'] for c in checks)
print(f'RELEASE-SMOKE SUMMARY {passed}/{len(checks)}')
raise SystemExit(0 if checks and passed == len(checks) else 1)
