"""Real installed-extension web-video smoke in a disposable Chrome profile.

No production source or manifest is altered. A loopback provider supplies
deterministic text; public-site smoke is observational, not a translation claim.
"""
import argparse
import base64
import functools
import json
import subprocess
import sys
import tempfile
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import run_harness as h

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--extension', type=Path, default=ROOT)
    parser.add_argument('--output', type=Path, default=ROOT / '.audit/3.7.5/web-video-e2e')
    parser.add_argument('--skip-public', action='store_true')
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    checks, observations, provider_requests = [], [], []

    def check(name, ok, detail=None):
        checks.append({'name': name, 'ok': bool(ok), 'detail': detail})
        print(('PASS ' if ok else 'FAIL ') + name, flush=True)

    class Handler(SimpleHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_OPTIONS(self):
            self.send_response(204)
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Access-Control-Allow-Headers', '*')
            self.end_headers()

        def do_POST(self):
            data = json.loads(self.rfile.read(int(self.headers.get('Content-Length') or 0)))
            provider_requests.append({'path': self.path, 'model': data.get('model')})
            # The generic subtitle provider sends indexed items plus context.
            user = next((m.get('content', '') for m in reversed(data.get('messages', [])) if m.get('role') == 'user'), '[]')
            try:
                entries = json.loads(user)
                count = len(entries) if isinstance(entries, list) else len(entries.get('items', []))
            except (ValueError, TypeError):
                count = 2
            payload = {'choices': [{'message': {'content': json.dumps({'t': [f'{i}⟫ترجمهٔ واقعی مسیر افزونه' for i in range(count)]}, ensure_ascii=False)}}]}
            body = json.dumps(payload).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Handler, directory=str(ROOT)))
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    origin = f'http://127.0.0.1:{server.server_port}'
    ws = None
    with tempfile.TemporaryDirectory(prefix='gxt-web-video-e2e-') as temp:
        debug = h.free_port()
        proc = subprocess.Popen([str(h.find_chrome()), f'--user-data-dir={temp}', f'--remote-debugging-port={debug}',
            '--enable-unsafe-extension-debugging', '--headless=new', '--no-first-run', '--no-default-browser-check',
            '--disable-background-networking', '--disable-sync', '--autoplay-policy=no-user-gesture-required',
            '--window-size=1200,900', 'about:blank'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            until = time.monotonic() + 20
            while time.monotonic() < until:
                try:
                    ws = h.cdp.WS(h.cdp.browser_ws(debug))
                    break
                except OSError:
                    time.sleep(.15)
            if not ws:
                raise RuntimeError('Chrome CDP did not start')
            ext_id = ws.call('Extensions.loadUnpacked', {'path': str(args.extension.resolve())})['id']

            def evaluate(session, expression, context=None, gesture=False):
                params = {'expression': expression, 'awaitPromise': True, 'returnByValue': True, 'userGesture': gesture}
                if context is not None:
                    params['contextId'] = context
                result = ws.call('Runtime.evaluate', params, session=session)
                if result.get('exceptionDetails'):
                    raise RuntimeError(result['exceptionDetails'].get('exception', {}).get('description') or result['exceptionDetails'].get('text'))
                return result.get('result', {}).get('value')

            def page(url):
                target = ws.call('Target.createTarget', {'url': 'about:blank'})['targetId']
                session = ws.call('Target.attachToTarget', {'targetId': target, 'flatten': True})['sessionId']
                ws.call('Runtime.enable', session=session)
                ws.call('Page.enable', session=session)
                nav = ws.call('Page.navigate', {'url': url}, session=session)
                return target, session, nav

            def wait_for(session, expression, seconds=8, context=None):
                until = time.monotonic() + seconds
                while time.monotonic() < until:
                    try:
                        value = evaluate(session, expression, context)
                        if value:
                            return value
                    except RuntimeError:
                        pass
                    time.sleep(.15)
                return None

            _, extension_page, _ = page(f'chrome-extension://{ext_id}/pages/subtitles.html')
            check('real extension settings page mounts', wait_for(extension_page, '!!globalThis.GXT?.getSettings'))
            permission = evaluate(extension_page, "(async()=>{const origins=['http://*/*','https://*/*'];if(await chrome.permissions.contains({origins}))return {granted:true,already:true};return await Promise.race([chrome.permissions.request({origins}).then(granted=>({granted})).catch(e=>({granted:false,error:e.message})),new Promise(r=>setTimeout(()=>r({granted:false,pending:true}),2500))]);})()", gesture=True)
            observations.append({'permission': permission})
            if not permission.get('granted'):
                # The Chrome settings page's own host-access API, in its real
                # privileged UI context. Only this disposable test profile is
                # changed; extension manifest and security policy are untouched.
                _, manager, _ = page('chrome://extensions/')
                if wait_for(manager, '!!chrome.developerPrivate?.addHostPermission'):
                    granted_by_settings = evaluate(manager, f"(async()=>{{for(const host of ['http://*/*','https://*/*'])await chrome.developerPrivate.addHostPermission({json.dumps(ext_id)},host);return true;}})()", gesture=True)
                    permission = {'granted': evaluate(extension_page, "chrome.permissions.request({origins:['http://*/*','https://*/*']})", gesture=True), 'method': 'Chrome extension-management host access API then optional request', 'settingsCall': granted_by_settings, 'nativePromptVerified': False}
                    observations.append({'permissionSetup': permission})
            check('browser grants requested optional HTTP(S) origins', permission.get('granted'), permission)
            if not permission.get('granted'):
                raise RuntimeError('Optional host permission prompt could not be completed headlessly; no manifest bypass applied')

            configuration = {'uiLanguage':'fa', 'webVideoEnabled': True, 'webVideoDisplay': 'auto', 'webVideoSiteMode': 'all', 'webVideoBlockedSites': [],
                'provider': 'openai', 'openaiBaseUrl': origin + '/v1', 'openaiModel': 'web-fixture', 'qualityMode': False}
            evaluate(extension_page, f'(async()=>{{await GXT.setOpenaiKey("TEST_ONLY_LOCAL_PROVIDER");await GXT.setSettings({json.dumps(configuration)});return true;}})()')
            check('dynamic script registration follows saved opt-in', wait_for(extension_page, "chrome.scripting.getRegisteredContentScripts().then(s=>s.some(x=>x.id==='gxt-web-video'))"))
            target, session, _ = page(origin + '/dev/web-video-fixtures.html')
            check('actual content script injects into local page', wait_for(session, "!!document.querySelector('[data-gxt-web-video]')"))

            def isolated(session):
                contexts = [e['params']['context'] for e in ws.events if e.get('sessionId') == session and e.get('method') == 'Runtime.executionContextCreated']
                for ctx in reversed(contexts):
                    if ctx.get('auxData', {}).get('isDefault'):
                        continue
                    try:
                        if evaluate(session, 'globalThis.chrome?.runtime?.id', ctx['id']) == ext_id:
                            return ctx['id']
                    except RuntimeError:
                        continue
                return None

            context = isolated(session)
            check('injection runs in the genuine extension isolated world', context is not None)
            if context is None:
                raise RuntimeError('No extension isolated world')
            evaluate(session, "document.querySelector('#native-video').pause();document.querySelector('#native-video').currentTime=1;document.querySelector('[data-gxt-web-video]').shadowRoot.querySelector('.feature').click();true", context, True)
            translated = wait_for(session, "GXT.webVideo._test.get(document.querySelector('#native-video'))?.cues.some(c=>c.translation)", 12, context)
            check('native VTT to content script to worker to loopback translation', translated and bool(provider_requests), provider_requests)
            customized=evaluate(session,"(()=>{const r=GXT.webVideo._test.get(document.querySelector('#native-video')),gen=r.generation;r.scaleInput.value='1.5';r.scaleInput.dispatchEvent(new Event('input'));r.positionXInput.value='20';r.positionXInput.dispatchEvent(new Event('input'));r.positionYInput.value='25';r.positionYInput.dispatchEvent(new Event('input'));r.bilingualInput.checked=true;r.bilingualInput.dispatchEvent(new Event('change'));return {sameGeneration:gen===r.generation,scale:r.visual.scale,manual:r.visual.manual,bilingual:r.visual.bilingual};})()",context)
            check('installed per-player caption customization preserves translation generation',customized.get('sameGeneration') and customized.get('scale')==1.5 and customized.get('manual') and customized.get('bilingual'),customized)
            before_locale=evaluate(session,"(()=>{const r=GXT.webVideo._test.get(document.querySelector('#native-video'));return {generation:r.generation,text:r.cues.map(c=>c.translation).join('|'),x:r.visual.x,y:r.visual.y};})()",context)
            evaluate(extension_page,"GXT.setSettings({uiLanguage:'en'}).then(()=>true)")
            switched=wait_for(session,"GXT.i18n.language()==='en'",context=context)
            after_locale=evaluate(session,"(()=>{const r=GXT.webVideo._test.get(document.querySelector('#native-video'));return {generation:r.generation,text:r.cues.map(c=>c.translation).join('|'),x:r.visual.x,y:r.visual.y,hasFile:!!r.panel.querySelector('input[type=file]'),hasSource:r.select.isConnected,aria:r.menuButton.ariaLabel,title:r.menuButton.title,dir:getComputedStyle(r.toolbar).direction};})()",context)
            check('installed English switch preserves captions geometry generation and controls',switched and all(after_locale.get(k)==v for k,v in before_locale.items()) and after_locale.get('hasFile') and after_locale.get('hasSource') and after_locale.get('aria')=='Video settings and site controls' and 'Settings and site controls' in after_locale.get('title','') and after_locale.get('dir')=='ltr',after_locale)
            evaluate(extension_page,"GXT.setSettings({uiLanguage:'fa'}).then(()=>true)")
            check('installed Persian switch restores RTL toolbar',wait_for(session,"getComputedStyle(GXT.webVideo._test.get(document.querySelector('#native-video')).toolbar).direction==='rtl'",context=context))
            for theme in ['paper','graphite']:
                evaluate(extension_page, 'GXT.setSettings({uiTheme:'+json.dumps(theme)+'}).then(()=>true)')
                theme_applied=wait_for(session,"GXT.webVideo._test.get(document.querySelector('#native-video')).host.style.getPropertyValue('--gxt-bg').trim()==="+json.dumps('#fbf6ec' if theme=='paper' else '#0e1014'),2,context)
                visual=evaluate(session,"(()=>{const r=GXT.webVideo._test.get(document.querySelector('#native-video'));if(r.panel.hidden)r.openPanel();const style=document.createElement('style');style.textContent='[data-gxt-web-video]{border:4px solid white!important;padding:6px!important;transform:translate(50vw,50vh)!important;background:white!important}';document.head.append(style);const b=r.host.getBoundingClientRect(),c=getComputedStyle(r.menuButton);const lum=s=>s.match(/[\\d.]+/g).slice(0,3).map(Number).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4}).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0),f=lum(c.color),g=lum(c.backgroundColor);const result={ratio:(Math.max(f,g)+.05)/(Math.min(f,g)+.05),host:{x:b.x,y:b.y,width:b.width,height:b.height}};style.remove();return result;})()",context)
                check('installed '+theme+' controls retain readable color and no page-CSS center marker',theme_applied and visual.get('ratio',0)>=4.5 and visual.get('host')=={'x':0,'y':0,'width':0,'height':0},visual)
                screenshot=ws.call('Page.captureScreenshot',{'format':'png'},session=session)
                (args.output/('controls-'+theme+'.png')).write_bytes(base64.b64decode(screenshot['data']))
            evaluate(session,"(()=>{const r=GXT.webVideo._test.get(document.querySelector('#native-video'));if(!r.panel.hidden)r.openPanel();return true;})()",context)
            evaluate(session, "document.querySelector('#resize').click();true")
            check('real ResizeObserver changes layout', wait_for(session, "GXT.webVideo._test.get(document.querySelector('#native-video'))?.layout?.mode==='icon'", context=context))
            evaluate(session, "document.querySelector('#resize').click();true")
            evaluate(session, "document.querySelector('#native').requestFullscreen().then(()=>true)", gesture=True)
            full = wait_for(session, "(()=>{const v=document.querySelector('#native-video'),r=GXT.webVideo._test.get(v);if(!r||document.fullscreenElement!==v.parentElement)return false;const a=r.toolbar.getBoundingClientRect(),b=v.getBoundingClientRect();const inside=r.host.parentElement===document.fullscreenElement,bounded=a.left>=b.left&&a.right<=b.right&&a.top>=b.top&&a.bottom<=b.bottom;return inside&&bounded&&a.width>=120?{full:true,inside,bounded,mode:r.layout.mode,width:a.width}:false;})()", context=context)
            check('native fullscreen event reparents controls within player bounds', full and full.get('inside') and full.get('bounded'), full)
            evaluate(session,"document.querySelector('#native-video').play().then(()=>true)",gesture=True)
            check('native fullscreen controller hides during playback idle',wait_for(session,"GXT.webVideo._test.get(document.querySelector('#native-video')).toolbar.hidden",5,context))
            evaluate(session,"document.querySelector('#native-video').dispatchEvent(new PointerEvent('pointermove',{bubbles:true}));true",context)
            check('native fullscreen controller wakes with pointer interaction',wait_for(session,"!GXT.webVideo._test.get(document.querySelector('#native-video')).toolbar.hidden",context=context))
            screenshot = ws.call('Page.captureScreenshot', {'format': 'png'}, session=session)
            (args.output / 'fullscreen.png').write_bytes(base64.b64decode(screenshot['data']))
            evaluate(session, 'document.exitFullscreen().then(()=>true)', gesture=True)
            old_id = evaluate(session, "GXT.webVideo._test.get(document.querySelector('#native-video')).id", context)
            evaluate(session, "document.querySelector('#replace').click();true")
            check('real video replacement removes retired host and gets fresh identity', wait_for(session, f"(()=>{{const r=GXT.webVideo._test.get(document.querySelector('#native-video'));return r&&r.id!=={json.dumps(old_id)}&&!document.querySelector('[data-player-id={old_id}]');}})()", context=context))
            evaluate(session, "document.querySelector('#vertical video').scrollIntoView();true")
            check('captionless video displays honest unavailable reason', wait_for(session, "(()=>{const r=GXT.webVideo._test.get(document.querySelector('#vertical video'));return r&&r.sources.length===0&&r.subButton.disabled&&r.status.textContent.includes('زیرنویس');})()", context=context))
            evaluate(session,"(()=>{const v=document.querySelector('#vertical video');window.__liveCtx=new AudioContext();const dest=__liveCtx.createMediaStreamDestination();window.__liveOsc=__liveCtx.createOscillator();__liveOsc.connect(dest);__liveOsc.start();v.srcObject=new MediaStream([...v.srcObject.getVideoTracks(),...dest.stream.getAudioTracks()]);v.muted=false;v.volume=.6;return v.play().then(()=>true);})()",gesture=True)
            wait_for(session,"document.querySelector('#vertical video').readyState>=2")
            evaluate(session,"(async()=>{await chrome.storage.local.set({modelList:[{id:'gemini-3.5-live-translate-preview',methods:['bidiGenerateContent']}]});await GXT.webVideo._test.get(document.querySelector('#vertical video')).refreshModels(false);return true;})()",context)
            evaluate(session,"(()=>{globalThis.__webStart=[];const original=chrome.runtime.connect.bind(chrome.runtime);chrome.runtime.connect=info=>{const port=original(info),send=port.postMessage.bind(port);port.postMessage=message=>{if(message.t==='start')__webStart.push(message);return send(message)};return port};const r=GXT.webVideo._test.get(document.querySelector('#vertical video'));r.engineSelect.value='live';r.engineSelect.dispatchEvent(new Event('change'));r.liveModelInput.value='gemini-3.5-live-translate-preview';r.liveModelInput.dispatchEvent(new Event('change'));r.sourceLanguageSelect.value='';r.sourceLanguageSelect.dispatchEvent(new Event('change'));r.dubButton.click();return true;})()",context,True)
            live_failure=wait_for(session,"(()=>{const r=GXT.webVideo._test.get(document.querySelector('#vertical video'));return !r.dubbing&&__webStart.length?{message:r.status.textContent,volume:r.video.volume,start:__webStart[0]}:false;})()",8,context)
            check('captionless automatic-language Live reaches real worker and reports missing credentials without ducking',live_failure and live_failure.get('volume')==.6 and live_failure.get('start',{}).get('model')=='gemini-3.5-live-translate-preview',live_failure)
            ws.call('Page.bringToFront',session=session)
            pip_supported=evaluate(session,"!!window.documentPictureInPicture")
            if pip_supported:
                evaluate(session,"(async()=>{const v=document.querySelector('#vertical video');const pip=await documentPictureInPicture.requestWindow({width:620,height:420});pip.document.body.style.margin='0';pip.document.body.append(v);v.style.width='600px';v.style.height='360px';pip.addEventListener('pagehide',()=>{document.querySelector('#vertical').append(v)});return true;})()",gesture=True)
                pip_state=wait_for(session,"(()=>{const pip=documentPictureInPicture.window,v=pip?.document.querySelector('video'),r=v&&GXT.webVideo._test.get(v);return r?{local:r.host.ownerDocument===pip.document,managers:GXT.webVideo._test.managerCount(),sources:r.sources.length}:false;})()",8,context)
                check('actual native Document PiP gets its own same-origin controls',pip_state and pip_state.get('local') and pip_state.get('managers')==2,pip_state)
                evaluate(session,"documentPictureInPicture.window.close();true",gesture=True)
                check('native Document PiP close releases manager and restores player',wait_for(session,"GXT.webVideo._test.managerCount()===1&&!!GXT.webVideo._test.get(document.querySelector('#vertical video'))",8,context))
            else:
                observations.append({'documentPiP':'unsupported by this Chrome; not verified'})
            evaluate(session,"window.__liveOsc?.stop();window.__liveCtx?.close();true")
            evaluate(extension_page, 'GXT.setWebVideoSiteBlocked("127.0.0.1",true).then(()=>true)')
            check('site disable removes existing controls via real worker storage', wait_for(session, "!document.querySelector('[data-gxt-web-video]')"))
            evaluate(extension_page, 'GXT.setWebVideoSiteBlocked("127.0.0.1",false).then(()=>true)')
            check('site reenable restores visible player controls', wait_for(session, "!!document.querySelector('[data-gxt-web-video]')"))
            evaluate(extension_page, 'GXT.setSettings({webVideoEnabled:false}).then(()=>true)')
            check('global disable unregisters and cleans current page', wait_for(extension_page, "chrome.scripting.getRegisteredContentScripts().then(s=>!s.some(x=>x.id==='gxt-web-video'))") and wait_for(session, "!document.querySelector('[data-gxt-web-video]')"))
            evaluate(extension_page, 'GXT.setSettings({webVideoEnabled:true}).then(()=>true)')
            check('global reenable injects into already open page', wait_for(session, "!!document.querySelector('[data-gxt-web-video]')"))
            ws.call('Target.closeTarget', {'targetId': target})

            if not args.skip_public:
                sites = [('mediaelement', 'https://www.mediaelementjs.com/'), ('videojs', 'https://videojs.com/'),
                         ('mdn', 'https://developer.mozilla.org/en-US/docs/Web/HTML/Element/video')]
                for name, url in sites:
                    target, session, nav = page(url)
                    wait_for(session, "document.readyState==='complete'", 10)
                    evaluate(session, "document.querySelector('video')?.scrollIntoView();true")
                    time.sleep(2)
                    value = evaluate(session, "({url:location.href,title:document.title,videos:[...document.querySelectorAll('video')].map(v=>({width:Math.round(v.getBoundingClientRect().width),height:Math.round(v.getBoundingClientRect().height),tracks:v.textTracks.length,ready:v.readyState})),hosts:document.querySelectorAll('[data-gxt-web-video]').length})")
                    value.update({'name': name, 'navigationError': nav.get('errorText'), 'scope': 'discovery/UI only; external translation and TTS unverified'})
                    observations.append(value)
                    print('PUBLIC ' + json.dumps(value, ensure_ascii=False), flush=True)
                    try:
                        screenshot = ws.call('Page.captureScreenshot', {'format': 'png'}, session=session)
                        (args.output / f'{name}.png').write_bytes(base64.b64decode(screenshot['data']))
                    except RuntimeError:
                        pass
                    ws.call('Target.closeTarget', {'targetId': target})
        except Exception as error:
            observations.append({'error': str(error)})
            print('ERROR ' + str(error), flush=True)
        finally:
            if ws:
                try:
                    ws.call('Browser.close')
                except (OSError, RuntimeError):
                    pass
                ws.close()
            try:
                proc.wait(timeout=8)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=5)
            server.shutdown()
    result = {'passed': sum(c['ok'] for c in checks), 'total': len(checks), 'checks': checks, 'observations': observations,
              'extension': str(args.extension.resolve()), 'manifestAltered': False, 'provider': 'loopback deterministic fixture; not external service quality'}
    (args.output / 'results.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    print(f"TOTAL {result['passed']}/{result['total']}", flush=True)
    return 0 if checks and all(c['ok'] for c in checks) and not any('error' in o for o in observations) else 1


if __name__ == '__main__':
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(encoding='utf-8', errors='replace')
    raise SystemExit(main())
