"""Render the production popup in throwaway Chrome for visual appearance QA."""
import base64
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import run_harness as H

out = H.ROOT / '.audit' / '3.7.5'
out.mkdir(parents=True, exist_ok=True)
with H.serve() as (port, ws, proc):
    target = ws.call('Target.createTarget', {'url':'about:blank'})['targetId']
    session = ws.call('Target.attachToTarget', {'targetId':target, 'flatten':True})['sessionId']
    def call(method, params=None):
        return ws.call(method, params or {}, session=session)
    def evaluate(expression):
        result=call('Runtime.evaluate', {'expression':expression,'returnByValue':True,'awaitPromise':True})
        if result.get('exceptionDetails'):
            raise RuntimeError(result['exceptionDetails'])
        return result.get('result',{}).get('value')
    call('Runtime.enable')
    call('Page.enable')
    call('Emulation.setDeviceMetricsOverride',{'width':480,'height':680,'deviceScaleFactor':1,'mobile':False})
    call('Page.navigate',{'url':f'http://127.0.0.1:{port}/dev/popup-preview.html?audit=1'})
    ready=False
    for attempt in range(80):
        if evaluate('!!globalThis.__popupReady'):
            ready=True
            break
        time.sleep(.1)
    if not ready:
        raise RuntimeError('popup did not mount')
    results=[]
    for preset in ['system','glass','oled','minimal','soft','future','contrast']:
        expression='''(async()=>{
          const p=GXT.theme.presetSettings(PRESET);
          await GXT.setSettings(p);
          await document.fonts.ready;
          await new Promise(r=>setTimeout(r,300));
          const body=document.body.getBoundingClientRect();
          return {preset:PRESET,width:body.width,height:body.height,overflow:document.documentElement.scrollWidth>innerWidth,
            clip:{x:body.left,y:body.top,width:body.width,height:body.height,scale:1}};
        })()'''.replace('PRESET',json.dumps(preset))
        result=evaluate(expression)
        shot=call('Page.captureScreenshot',{'format':'png','clip':result['clip']})
        (out/f'theme-{preset}.png').write_bytes(base64.b64decode(shot['data']))
        results.append(result)
    evaluate("document.getElementById('appearanceBtn').click()")
    time.sleep(.3)
    shot=call('Page.captureScreenshot',{'format':'png'})
    (out/'theme-preset-gallery.png').write_bytes(base64.b64decode(shot['data']))
    evaluate("document.querySelector('.appearance-details').open=true;document.getElementById('appearanceControls').scrollIntoView({block:'start'})")
    time.sleep(.3)
    shot=call('Page.captureScreenshot',{'format':'png'})
    (out/'theme-advanced-controls.png').write_bytes(base64.b64decode(shot['data']))
    (out/'theme-visual.json').write_text(json.dumps(results,indent=2),encoding='utf-8')
    print(json.dumps(results,indent=2))
