"""Installed Chrome 3.7.5 smoke: upgrade data, runtime witness, themes and workshop.

Uses throwaway profiles, synthetic files/keys and a loopback OpenAI endpoint.
The endpoint verifies transport and stable-ID reconstruction, not model quality.
python dev/release_smoke_375.py --extension PATH --upgrade-from PATH --output PATH
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
parser.add_argument('--expected-version', default='3.7.5')
args = parser.parse_args()
args.output.mkdir(parents=True, exist_ok=True)
checks, requests, observations = [], [], {}
for stream in (__import__('sys').stdout, __import__('sys').stderr):
    if hasattr(stream, 'reconfigure'):
        stream.reconfigure(encoding='utf-8', errors='replace')


def check(name, actual):
    checks.append({'name': name, 'ok': bool(actual)})
    print(('PASS ' if actual else 'FAIL ') + name, flush=True)


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
        payload = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0'))))
        try:
            user = next(m['content'] for m in reversed(payload.get('messages', [])) if m.get('role') == 'user')
            cues = json.loads(user)['cues']
            entries = [{'id': cue['id'], 'text': 'ترجمهٔ آزمایشی فایل'} for cue in cues]
            requests.append({'path': self.path, 'model': payload.get('model'), 'temperature':payload.get('temperature'), 'projectPrompt':any('Workshop fixture instruction' in str(m.get('content','')) for m in payload.get('messages',[]) if m.get('role')=='system'), 'ids': [cue['id'] for cue in cues], 'stableIds': all(isinstance(cue.get('id'), str) and cue['id'] for cue in cues)})
            response = {'choices': [{'message': {'content': json.dumps({'entries': entries}, ensure_ascii=False)}}]}
            status = 200
        except (KeyError, StopIteration, TypeError, ValueError) as error:
            requests.append({'path': self.path, 'invalidContract': type(error).__name__})
            response, status = {'error': {'message': 'Expected workshop cues with stable IDs'}}, 400
        body = json.dumps(response, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
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
        raise RuntimeError(json.dumps(result['exceptionDetails'], ensure_ascii=False))
    return result.get('result', {}).get('value')


def eventually(ws, session, expression, attempts=180):
    return evaluate(ws, session, f"(async()=>{{for(let i=0;i<{attempts};i++){{if(await ({expression}))return true;await new Promise(r=>setTimeout(r,50));}}return false;}})()")


def page(ws, ext_id, path):
    target = ws.call('Target.createTarget', {'url': 'about:blank'})['targetId']
    session = ws.call('Target.attachToTarget', {'targetId': target, 'flatten': True})['sessionId']
    ws.call('Runtime.enable', session=session)
    ws.call('Page.enable', session=session)
    ws.call('Page.navigate', {'url': f'chrome-extension://{ext_id}/{path}'}, session=session)
    deadline = time.monotonic() + 12
    while time.monotonic() < deadline:
        if evaluate(ws, session, "document.readyState==='complete' && !!globalThis.GXT?.getSettings"):
            return session
        time.sleep(.1)
    raise RuntimeError('Extension page did not mount: ' + json.dumps(evaluate(ws, session, "({url:location.href,ready:document.readyState,text:document.body?.innerText?.slice(0,180)})")))


def runtime_witness(ws, ext_id):
    for attempt in range(50):
        target = next((t for t in ws.call('Target.getTargets')['targetInfos'] if t['type'] == 'service_worker' and ext_id in t['url']), None)
        if target:
            session = ws.call('Target.attachToTarget', {'targetId': target['targetId'], 'flatten': True})['sessionId']
            return evaluate(ws, session, "({version:chrome.runtime.getManifest().version,workshop:typeof translateWorkshop==='function',siteMutation:typeof GXTBG.setWebVideoSiteBlocked==='function',youtubeSettings:typeof GXTBG.youtubeSettings==='function',promptVersion:GXTBG.subtitlePrompts?.VERSION||null})")
        time.sleep(.1)
    return {'missingWorker': True}


def screenshot(ws, session, name):
    image = ws.call('Page.captureScreenshot', {'format': 'png'}, session=session)
    (args.output / name).write_bytes(base64.b64decode(image['data']))


server = ThreadingHTTPServer(('127.0.0.1', 0), LocalProvider)
server.daemon_threads = True
threading.Thread(target=server.serve_forever, daemon=True).start()
try:
    expected = json.loads((args.extension / 'manifest.json').read_text(encoding='utf-8'))['version']
    check('input artifact has the requested release version', expected == args.expected_version)
    with tempfile.TemporaryDirectory(prefix='gxt-375-release-smoke-') as temp_name:
        temp = Path(temp_name)
        stage, profile = temp / 'extension', temp / 'upgrade-profile'
        copy_runtime(args.upgrade_from, stage)
        with browser(profile, stage) as (ws, old_id):
            session = page(ws, old_id, 'pages/subtitles.html')
            seeded = evaluate(ws, session, """(async()=>{
              await GXT.setSettings({uiTheme:'paper',uiAccent:'rose',uiDensity:'compact',ttsRate:1.35,pageBilingual:true,customPrompt:'upgrade fixture'});
              await GXT.setApiKeys(['TEST_ONLY_UPGRADE_KEY']);
              await chrome.storage.local.set({transMemory:{terms:{nasa:{s:'NASA',t:'ناسا',n:3,pinned:true}},count:1}});
              return chrome.runtime.getManifest().version==='3.7.0' && (await GXT.getSettings()).pageBilingual;
            })()""")
            check('3.7.0 runtime seeds synthetic settings and memory', seeded)
        copy_runtime(args.extension, stage)
        with browser(profile, stage) as (ws, new_id):
            session = page(ws, new_id, 'pages/subtitles.html')
            state = evaluate(ws, session, """(async()=>{const s=await GXT.getSettings();const m=await GXT.getMemory();await chrome.runtime.sendMessage({type:'GET_STATS'});return {version:chrome.runtime.getManifest().version,theme:s.uiTheme,accent:s.uiAccent,density:s.uiDensity,rate:s.ttsRate,bilingual:s.pageBilingual,prompt:s.customPrompt,key:(await GXT.getApiKeys())[0],term:m.terms.nasa?.t};})()""")
            check('same-path upgrade preserves extension identity', old_id == new_id)
            check('upgrade preserves legacy appearance and synthetic data', state.get('theme') == 'paper' and state.get('accent') == 'rose' and state.get('density') == 'compact' and state.get('rate') == 1.35 and state.get('bilingual') is True and state.get('prompt') == 'upgrade fixture' and state.get('key') == 'TEST_ONLY_UPGRADE_KEY' and state.get('term') == 'ناسا')
            witness = runtime_witness(ws, new_id)
            activated = witness.get('version') == expected and all(witness.get(k) for k in ['workshop','siteMutation','youtubeSettings','promptVersion'])
            observations['upgradeBeforeReload'] = {'activated': activated, 'witness': witness}
            if not activated:
                try:
                    evaluate(ws, session, "(()=>{setTimeout(()=>chrome.runtime.reload(),50);return true;})()")
                    time.sleep(1)
                    # CDP-loaded unpacked extensions may unload on reload.
                    reloaded_id = ws.call('Extensions.loadUnpacked', {'path': str(stage.resolve())})['id']
                    session = page(ws, reloaded_id, 'pages/subtitles.html')
                    evaluate(ws, session, "chrome.runtime.sendMessage({type:'GET_STATS'})")
                    witness = runtime_witness(ws, reloaded_id)
                    activated = reloaded_id == new_id and witness.get('version') == expected and all(witness.get(k) for k in ['workshop','siteMutation','youtubeSettings','promptVersion'])
                except (OSError, RuntimeError) as error:
                    # This is an explicit failed observation, not a passed
                    # upgrade check. Continue the independent fresh-install
                    # tests, which must never mask this limitation.
                    observations['upgradeReloadError'] = type(error).__name__ + ': ' + str(error)
            observations['upgradeActivation'] = {'status': 'verified' if activated else 'unverified', 'witness': witness, 'pageVersion': state.get('version'), 'method': 'Browser closed, files replaced at same path, restarted with same profile, Extensions.loadUnpacked called; explicit runtime.reload and reloading path also attempted if old worker retained.', 'limitation': None if activated else 'New worker activation could not be verified. CDP-loaded extension reload may produce ERR_BLOCKED_BY_CLIENT. Preserved data alone is not treated as new runtime activation; this does not verify the native extension-card Reload button.'}
            print('UPGRADE-ACTIVATION ' + observations['upgradeActivation']['status'], flush=True)
        clean_profile = temp / 'clean-profile'
        with browser(clean_profile, stage) as (ws, ext_id):
            popup = page(ws, ext_id, 'popup/popup.html')
            ws.call('Emulation.setDeviceMetricsOverride', {'width':400,'height':598,'deviceScaleFactor':1,'mobile':False}, session=popup)
            check('installed popup finishes building all fourteen presets', eventually(ws, popup, "document.querySelectorAll('#presetGrid button').length===14"))
            evaluate(ws, popup, "GXT.setSettings({uiTheme:'paper'}).then(()=>true)")
            witness = runtime_witness(ws, ext_id)
            observations['freshRuntime'] = witness
            check('fresh worker executes new 3.7.5 functions, beyond manifest metadata', witness.get('version') == expected and all(witness.get(k) for k in ['workshop','siteMutation','youtubeSettings','promptVersion']))
            evaluate(ws, popup, "document.querySelector('#appearanceBtn').click();document.querySelectorAll('#presetGrid button')[GXT.theme.PRESETS.findIndex(p=>p.id==='future')].click()")
            check('installed popup saves and renders a preset via real worker storage', eventually(ws, popup, "GXT.getSettings().then(s=>s.uiPreset==='future'&&document.documentElement.style.getPropertyValue('--gxt-radius-md').trim()==='2px')"))
            screenshot(ws, popup, 'packaged-preset.png')
            evaluate(ws, popup, "document.querySelector('#resetAppearance').click()")
            check('installed appearance reset clears nullable overrides through worker validation', eventually(ws, popup, "GXT.getSettings().then(s=>s.uiPreset==='custom'&&s.uiRadius===null&&s.uiTheme==='auto'&&document.documentElement.style.getPropertyValue('--gxt-radius-md').trim()==='13px')"))
            evaluate(ws, popup, "document.querySelector('#sheetClose').click()")
            check('installed popup displays runtime version', evaluate(ws, popup, "document.querySelector('#versionTag').textContent.includes(chrome.runtime.getManifest().version)"))
            evaluate(ws, popup, "GXT.setSettings({webVideoBlockedSites:[]}).then(()=>Promise.all([GXT.setWebVideoSiteBlocked('one.example',true),GXT.setWebVideoSiteBlocked('two.example',true)]))")
            check('real worker serializes two independent site toggles', evaluate(ws, popup, "GXT.getSettings().then(s=>s.webVideoBlockedSites.sort().join(',')==='one.example,two.example')"))
            session = page(ws, ext_id, 'pages/subtitles.html')
            ws.call('Emulation.setDeviceMetricsOverride', {'width':1100,'height':850,'deviceScaleFactor':1,'mobile':False}, session=session)
            port = server.server_address[1]
            check('installed workshop configures isolated loopback provider', evaluate(ws, session, f"GXT.setSettings({{provider:'openai',openaiBaseUrl:'http://127.0.0.1:{port}/v1',openaiModel:'audit-stable-ids',qualityMode:false,customPrompt:'',ytProvider:'google',uiTheme:'paper',pageBilingual:true}}).then(()=>true)"))
            fixture = temp / 'actual-input.srt'
            fixture.write_text('1\n00:00:01,000 --> 00:00:03,000\nHello from the release test.\n\n2\n00:00:04,000 --> 00:00:06,000\nAnother source sentence.\n', encoding='utf-8')
            node = ws.call('DOM.querySelector', {'nodeId': ws.call('DOM.getDocument', session=session)['root']['nodeId'], 'selector': '#picker'}, session=session)['nodeId']
            ws.call('DOM.setFileInputFiles', {'nodeId': node, 'files': [str(fixture)]}, session=session)
            check('installed workshop reads real disk SRT into two editor rows', eventually(ws, session, "document.querySelector('#fileName').textContent==='actual-input.srt'&&document.querySelectorAll('#editorRows [data-action=edit]').length===2"))
            global_model = evaluate(ws, session, "GXT.getSettings().then(s=>s.openaiModel)")
            evaluate(ws, session, "(()=>{for(const [id,value] of [['workshopModel','workshop-exact-version'],['workshopTemperature','0.65'],['workshopCustomPrompt','Workshop fixture instruction']]){const el=document.getElementById(id);el.value=value;el.dispatchEvent(new Event('change',{bubbles:true}));}})()")
            evaluate(ws, session, "document.querySelector('#translateBtn').click()")
            translated = eventually(ws, session, "!document.querySelector('#translateBtn').disabled&&[...document.querySelectorAll('#editorRows [data-action=edit]')].length===2&&[...document.querySelectorAll('#editorRows [data-action=edit]')].every(e=>e.value==='ترجمهٔ آزمایشی فایل')")
            check('real file UI to MV3 worker to stable-ID loopback entries to editor', translated and any(r.get('stableIds') and r['path'] == '/v1/chat/completions' for r in requests))
            check('installed project model temperature and prompt reach provider without global writes', translated and any(r.get('model')=='workshop-exact-version' and r.get('temperature')==0.65 and r.get('projectPrompt') for r in requests) and evaluate(ws, session, "GXT.getSettings().then(s=>s.openaiModel)") == global_model)
            ids = evaluate(ws, session, "[...document.querySelectorAll('#editorRows .editor-row')].map(e=>e.dataset.id)")
            evaluate(ws, session, "(()=>{const edit=document.querySelector('#editorRows [data-action=edit]');edit.value='ویرایش دستی محفوظ';edit.dispatchEvent(new Event('input',{bubbles:true}));edit.blur();document.querySelector('#translateBtn').click();})()")
            locked = eventually(ws, session, "!document.querySelector('#translateBtn').disabled&&document.querySelector('#editorRows [data-action=edit]').value==='ویرایش دستی محفوظ'&&document.querySelector('#editorRows [data-action=lock]').checked")
            check('full retranslation preserves manual lock and sends only unlocked ID', locked and bool(ids) and any(r.get('ids') == ids[1:] for r in requests[1:]))
            check('edited project is safely autosaved to real IndexedDB', eventually(ws, session, "document.querySelector('#saveStatus').textContent.startsWith('ذخیره شد')"))
            details = evaluate(ws, session, "({error:document.querySelector('#errorNote').textContent,result:document.querySelector('#resultPreview').textContent,rows:[...document.querySelectorAll('#editorRows .editor-row')].map(e=>({id:e.dataset.id,text:e.querySelector('textarea').value,locked:e.querySelector('[data-action=lock]').checked})),saveStatus:document.querySelector('#saveStatus').textContent})")
            (args.output/'file-execution.json').write_text(json.dumps(details, ensure_ascii=False, indent=2), encoding='utf-8')
            evaluate(ws, session, "document.querySelector('#editorRows').scrollIntoView({block:'center'})")
            screenshot(ws, session, 'packaged-workshop.png')
            ws.call('HeapProfiler.collectGarbage', session=popup)
            before = ws.call('Memory.getDOMCounters', session=popup)
            evaluate(ws, popup, "(()=>{for(let i=0;i<100;i++){document.querySelector('#appearanceBtn').click();document.querySelector('#sheetClose').click();}})()")
            ws.call('HeapProfiler.collectGarbage', session=popup)
            after = ws.call('Memory.getDOMCounters', session=popup)
            observations['popupCycles'] = {'cycles':100,'before':before,'after':after}
            check('100 installed popup dialog cycles keep DOM and listeners bounded', after['documents'] <= before['documents'] and after['nodes'] <= before['nodes'] + 10 and after['jsEventListeners'] <= before['jsEventListeners'] + 10)
        with browser(clean_profile, stage) as (ws, restarted_id):
            session = page(ws, restarted_id, 'pages/subtitles.html')
            check('browser restart preserves final settings and extension identity', restarted_id == ext_id and evaluate(ws, session, "GXT.getSettings().then(s=>s.provider==='openai'&&s.uiTheme==='paper'&&s.pageBilingual)"))
            ready = eventually(ws, session, "document.querySelector('#savedProjects').options.length>1")
            if ready:
                evaluate(ws, session, "(()=>{const list=document.querySelector('#savedProjects');list.selectedIndex=1;list.dispatchEvent(new Event('change'));document.querySelector('#restoreProjectBtn').click();})()")
            check('actual saved project restores manual translation and lock after restart', ready and eventually(ws, session, "document.querySelector('#editorRows [data-action=edit]')?.value==='ویرایش دستی محفوظ'&&document.querySelector('#editorRows [data-action=lock]')?.checked"))
            check('installed project generation options survive browser restart', ready and evaluate(ws, session, "document.querySelector('#workshopModel').value==='workshop-exact-version'&&document.querySelector('#workshopTemperature').value==='0.65'&&document.querySelector('#workshopCustomPrompt').value==='Workshop fixture instruction'"))
except Exception as error:
    check('release smoke completed without infrastructure exception', False)
    observations['exception'] = type(error).__name__ + ': ' + str(error)
    print(observations['exception'], flush=True)
finally:
    server.shutdown()
    server.server_close()
    (args.output/'results.json').write_text(json.dumps({'checks':checks,'requests':requests,'observations':observations}, indent=2, ensure_ascii=False), encoding='utf-8')
passed = sum(c['ok'] for c in checks)
print(f'RELEASE-SMOKE-375 SUMMARY {passed}/{len(checks)}', flush=True)
raise SystemExit(0 if checks and passed == len(checks) else 1)
