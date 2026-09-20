"""Public-site smoke check in a temporary Chrome profile, without user accounts."""
import base64
import json
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'dev'))
import run_harness as h

for stream in (sys.stdout, sys.stderr):
    stream.reconfigure(encoding='utf-8', errors='replace')
out = ROOT / '.audit' / '3.7.5' / 'live-smoke'
out.mkdir(exist_ok=True)
results = {}
with tempfile.TemporaryDirectory(prefix='gxt-live-') as profile:
    port = h.free_port()
    proc = subprocess.Popen([str(h.find_chrome()), f'--user-data-dir={profile}',
        f'--remote-debugging-port={port}', '--enable-unsafe-extension-debugging',
        '--headless=new', '--no-first-run', '--no-default-browser-check',
        '--disable-background-networking', '--disable-sync', 'about:blank'],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    ws = None
    try:
        for _ in range(60):
            try:
                ws = h.cdp.WS(h.cdp.browser_ws(port))
                break
            except Exception:
                time.sleep(.2)
        if not ws:
            raise RuntimeError('Chrome unavailable')
        ext_id = ws.call('Extensions.loadUnpacked', {'path': str(ROOT)})['id']
        sites = [('youtube', 'https://www.youtube.com/watch?v=jNQXAC9IVRw'), ('x', 'https://x.com/')]
        if len(sys.argv) > 1:
            sites = [(name, url) for name, url in sites if name in sys.argv[1:]]
        for name, url in sites:
            target = ws.call('Target.createTarget', {'url':'about:blank'})['targetId']
            session = ws.call('Target.attachToTarget', {'targetId':target,'flatten':True})['sessionId']
            ws.call('Page.enable', session=session)
            ws.call('Runtime.enable', session=session)
            ws.call('Network.enable', session=session)
            nav = ws.call('Page.navigate', {'url':url}, session=session)
            time.sleep(8)
            if name == 'youtube':
                consent = ws.call('Runtime.evaluate', {'returnByValue':True, 'expression': """(()=>{
                  const buttons=[...document.querySelectorAll('button')];
                  const reject=buttons.find(b=>b.textContent.trim()==='Reject all');
                  const labels=buttons.filter(b=>/Reject all|Accept all/.test(b.textContent)).map(b=>b.textContent.trim());
                  reject?.click();return {rejected:!!reject,labels};
                })()"""}, session=session)
                print('consent', json.dumps(consent.get('result',{}).get('value',{})), flush=True)
                time.sleep(3)
                for _ in range(14):
                    ready = ws.call('Runtime.evaluate', {'returnByValue':True, 'expression':
                        "!!document.querySelector('[data-gxt-ui=yt]')"}, session=session)
                    if ready.get('result',{}).get('value'):
                        break
                    time.sleep(2)
            probe = ws.call('Runtime.evaluate', {'returnByValue': True, 'expression': """(()=>{
              const player=document.querySelector('#movie_player');
              let pr;try{pr=player?.getPlayerResponse?.()}catch{}
              return {url:location.href,title:document.title,ready:document.readyState,
                player:!!player,video:!!document.querySelector('video'),
                playability:pr?.playabilityStatus?.status,
                nativeCaptionTracks:pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks?.length||0,
                extensionSurface:!!document.querySelector('[data-gxt-surface], [data-gxt-ui]'),
                extensionButtons:[...(document.querySelector('[data-gxt-ui=yt]')?.shadowRoot?.querySelectorAll('button')||[])].map(b=>({id:b.id,label:b.getAttribute('aria-label'),disabled:b.disabled})),
                visibleText:document.body?.innerText?.slice(0,180)};
            })()"""}, session=session)
            value = probe.get('result',{}).get('value',{})
            value['navigationError'] = nav.get('errorText')
            if name == 'youtube' and value.get('extensionSurface'):
                tree = ws.call('Page.getFrameTree', session=session)['frameTree']
                frames = [tree]
                for item in frames:
                    frames.extend(item.get('childFrames', []))
                for item in frames:
                    if 'consent.' not in item['frame']['url']:
                        continue
                    context = ws.call('Page.createIsolatedWorld', {'frameId':item['frame']['id'], 'worldName':'audit-consent'}, session=session)['executionContextId']
                    decision = ws.call('Runtime.evaluate', {'contextId':context, 'returnByValue':True, 'expression': """(()=>{
                      const choices=[...document.querySelectorAll('button,input[type=submit]')];
                      const reject=choices.find(b=>/Reject all/i.test(b.textContent+' '+b.getAttribute('aria-label')+' '+b.value));
                      const labels=choices.map(b=>(b.textContent||b.getAttribute('aria-label')||b.value||'').trim()).filter(Boolean);
                      reject?.click();return {rejected:!!reject,labels};
                    })()"""}, session=session)
                    print('consent-frame', json.dumps(decision.get('result',{}).get('value',{})), flush=True)
                    time.sleep(3)
                # Native auto-translation, then the extension button. This
                # profile has no API keys, so translation cannot incur charges.
                trial = ws.call('Runtime.evaluate', {'returnByValue':True,'awaitPromise':True,'expression': """(async()=>{
                  const player=document.querySelector('#movie_player');
                  const video=player?.querySelector('video');if(video){video.muted=true;try{await Promise.race([video.play(),new Promise(r=>setTimeout(r,1000))])}catch{}}
                  const cc=player?.querySelector('.ytp-subtitles-button');
                  if(cc?.getAttribute('aria-pressed')!=='true')cc?.click();
                  await new Promise(r=>setTimeout(r,700));
                  const list=player?.getOption?.('captions','tracklist')||[];
                  const original=list.find(t=>t.languageCode==='en')||list[0];
                  if(original)player.setOption('captions','track',{...original,translationLanguage:{languageCode:'fa',languageName:'Persian'}});
                  await new Promise(r=>setTimeout(r,600));
                  const root=document.querySelector('[data-gxt-ui=yt]')?.shadowRoot;
                  const button=root?.querySelector('#gxt-yt-pill');const start=performance.now();button?.click();
                  await new Promise(r=>setTimeout(r,9500));
                  const selected=player?.getOption?.('captions','track');
                  return {nativeTrackAvailable:!!original,
                    nativeTargetAfterProbe:selected?.translationLanguage?.languageCode||null,
                    buttonText:button?.textContent,buttonTitle:button?.title,
                    buttonPressed:button?.getAttribute('aria-pressed'),
                    extensionText:root?.textContent?.replace(/^[\\s\\S]*?\\*\\//,'').slice(-700),
                    elapsedMs:Math.round(performance.now()-start),
                    playhead:video?.currentTime,
                    captionFetches:performance.getEntriesByType('resource').filter(e=>e.name.includes('/timedtext')).map(e=>{
                      const u=new URL(e.name);return {lang:u.searchParams.get('lang'),target:u.searchParams.get('tlang'),format:u.searchParams.get('fmt'),durationMs:Math.round(e.duration)};
                    })};
                })()"""}, session=session)
                value['captionTrial'] = trial.get('result',{}).get('value',trial.get('exceptionDetails'))
                responses = [e['params'] for e in ws.events if e.get('sessionId') == session and
                    e.get('method') == 'Network.responseReceived' and '/api/timedtext' in e['params']['response']['url']]
                network = []
                for response in responses:
                    from urllib.parse import urlparse, parse_qs
                    params = parse_qs(urlparse(response['response']['url']).query)
                    entry = {'status': response['response']['status'], 'lang':params.get('lang'),
                             'target':params.get('tlang'), 'pot':bool(params.get('pot'))}
                    try:
                        body = ws.call('Network.getResponseBody', {'requestId':response['requestId']}, session=session)
                        raw = base64.b64decode(body['body']) if body.get('base64Encoded') else body['body'].encode()
                        entry['bytes'] = len(raw)
                        if raw:
                            parsed = json.loads(raw)
                            entry['events'] = len(parsed.get('events', []))
                    except Exception as error:
                        entry['bodyError'] = type(error).__name__
                    network.append(entry)
                value['captionResponses'] = network
            results[name] = value
            print(name, json.dumps(value, ensure_ascii=False), flush=True)
            png = ws.call('Page.captureScreenshot', {'format':'png'}, session=session)
            (out / f'{name}.png').write_bytes(base64.b64decode(png['data']))
            ws.call('Target.closeTarget', {'targetId':target})
    finally:
        if ws:
            ws.close()
        proc.terminate()
        try:
            proc.wait(timeout=8)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=5)
(out / 'results.json').write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding='utf-8')
